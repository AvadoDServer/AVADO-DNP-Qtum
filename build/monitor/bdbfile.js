// Read the records of a legacy Qtum wallet (a Berkeley DB btree file)
// directly from its pages, without Berkeley DB.
//
// This is the fallback for a damaged wallet file that the Qtum v29.1 wallet
// tool cannot dump (e.g. a file cut short: pages that the tree links to are
// missing, so Berkeley DB refuses the whole file). Every page that is present
// is read on its own; the records on missing or damaged pages are lost, the
// others are found.
//
// Page layout (Berkeley DB 4.8, dbinc/db_page.h, the version Qtum Core links):
//   metadata page 0 (DBMETA): magic 0x00053162 at 12, pagesize at 20,
//     metaflags at 26 (0x01 = page checksums), last_pgno at 32; btree root at 88
//   every page (PAGE, SIZEOF_PAGE = 26): lsn 0-7, pgno 8-11, prev_pgno 12-15,
//     next_pgno 16-19, entries 20-21, hf_offset 22-23, level 24, type 25;
//     with page checksums 6 more bytes (PG_CHKSUM) before the index array
//   btree leaf (P_LBTREE = 5): `entries` u16 item offsets after the header;
//     items alternate key, data; an item is BKEYDATA {len u16, type u8, data}
//     or BOVERFLOW {unused u16, type u8, unused u8, pgno u32, tlen u32};
//     B_KEYDATA = 1, B_DUPLICATE = 2, B_OVERFLOW = 3, B_DELETE flag 0x80
//   overflow page (P_OVERFLOW = 7): OV_LEN = hf_offset bytes of data after the
//     header, chained by next_pgno
// A wallet file holds a master database whose root (page 1 in Qtum wallets,
// the root of metadata page 0) only names the "main" database: its records
// are not wallet records and are left out.
//
// Node built-ins only, Node 12 compatible. Nothing here logs: the records
// hold private keys.

const fs = require("fs");

const BTREE_MAGIC = 0x00053162;
const SIZEOF_PAGE = 26;
const P_LBTREE = 5;
const P_OVERFLOW = 7;
const B_KEYDATA = 1;
const B_OVERFLOW = 3;
const B_DELETE = 0x80;
const DBMETA_CHKSUM = 0x01;

class BdbFileError extends Error {}

// Read pages of the file on demand (the file can be large).
class PageFile {
    constructor(file) {
        this.fd = fs.openSync(file, "r");
        try {
            this.init();
        } catch (err) {
            fs.closeSync(this.fd);
            throw err;
        }
    }

    init() {
        this.size = fs.fstatSync(this.fd).size;
        const head = Buffer.alloc(512);
        const n = fs.readSync(this.fd, head, 0, head.length, 0);
        if (n < 100) throw new BdbFileError("the file is too short");
        if (head.readUInt32LE(12) === BTREE_MAGIC) this.le = true;
        else if (head.readUInt32BE(12) === BTREE_MAGIC) this.le = false;
        else throw new BdbFileError("not a Berkeley DB btree file");
        this.pageSize = this.u32(head, 20);
        if (this.pageSize < 512 || this.pageSize > 65536 || (this.pageSize & (this.pageSize - 1))) {
            throw new BdbFileError("unknown page size");
        }
        this.metaflags = head[26];
        if (head[24] !== 0) throw new BdbFileError("encrypted Berkeley DB files are not supported");
        this.lastPgno = this.u32(head, 32);
        this.root = this.u32(head, 88);
        this.indexOffset = SIZEOF_PAGE + (this.metaflags & DBMETA_CHKSUM ? 6 : 0);
        this.pagesInFile = Math.floor(this.size / this.pageSize);
    }

    u16(buf, o) { return this.le ? buf.readUInt16LE(o) : buf.readUInt16BE(o); }
    u32(buf, o) { return this.le ? buf.readUInt32LE(o) : buf.readUInt32BE(o); }

    // The page, or null when it is not in the file
    page(pgno) {
        if (pgno >= this.pagesInFile) return null;
        const buf = Buffer.alloc(this.pageSize);
        const n = fs.readSync(this.fd, buf, 0, this.pageSize, pgno * this.pageSize);
        return n === this.pageSize ? buf : null;
    }

    header(buf) {
        return {
            pgno: this.u32(buf, 8),
            nextPgno: this.u32(buf, 16),
            entries: this.u16(buf, 20),
            hfOffset: this.u16(buf, 22),
            level: buf[24],
            type: buf[25],
        };
    }

    close() {
        fs.closeSync(this.fd);
    }
}

// The data of an overflow item: follow the chain of overflow pages. null if
// the chain is broken (a page is missing or is not an overflow page).
function readOverflow(pf, firstPgno, totalLength) {
    const parts = [];
    let have = 0;
    let pgno = firstPgno;
    const seen = {};
    while (have < totalLength) {
        if (!pgno || seen[pgno]) return null;
        seen[pgno] = true;
        const buf = pf.page(pgno);
        if (!buf) return null;
        const h = pf.header(buf);
        if (h.type !== P_OVERFLOW || h.pgno !== pgno) return null;
        const len = h.hfOffset;
        if (pf.indexOffset + len > pf.pageSize || len === 0) return null;
        parts.push(buf.slice(pf.indexOffset, pf.indexOffset + len));
        have += len;
        pgno = h.nextPgno;
    }
    const data = Buffer.concat(parts);
    return data.length === totalLength ? data : null;
}

// One item of a leaf page: { data } or { deleted } or null when damaged
function readItem(pf, buf, offset) {
    if (offset < pf.indexOffset || offset + 3 > pf.pageSize) return null;
    const type = buf[offset + 2];
    const deleted = !!(type & B_DELETE);
    const kind = type & ~B_DELETE;
    if (kind === B_KEYDATA) {
        const len = pf.u16(buf, offset);
        if (offset + 3 + len > pf.pageSize) return null;
        return { data: Buffer.from(buf.slice(offset + 3, offset + 3 + len)), deleted };
    }
    if (kind === B_OVERFLOW) {
        if (offset + 12 > pf.pageSize) return null;
        const data = readOverflow(pf, pf.u32(buf, offset + 4), pf.u32(buf, offset + 8));
        return data ? { data, deleted } : null;
    }
    return null; // B_DUPLICATE (off-page duplicates, not used by wallets) or garbage
}

/**
 * Every key/value record on the leaf pages that are present and readable.
 * @param {string} file a Berkeley DB btree file (wallet.dat)
 * @param {function(Buffer, Buffer, number)} onRecord called for each record (key, value, page)
 * @returns {{pageSize, lastPgno, pagesInFile, pagesPresent, pagesMissing, damagedPages, damagedItems, leafPages}}
 */
function scanRecords(file, onRecord) {
    let pf;
    try {
        pf = new PageFile(file);
    } catch (err) {
        if (err instanceof BdbFileError) throw err;
        throw new BdbFileError("the file could not be read");
    }
    const stats = {
        pageSize: pf.pageSize,
        lastPgno: pf.lastPgno,
        pagesInFile: pf.pagesInFile,
        pagesPresent: 0,
        pagesMissing: 0,
        damagedPages: 0,
        damagedItems: 0,
        leafPages: 0,
    };
    try {
        for (let pgno = 1; pgno < pf.pagesInFile; pgno++) {
            const buf = pf.page(pgno);
            if (!buf) continue;
            stats.pagesPresent++;
            const h = pf.header(buf);
            if (h.type !== P_LBTREE) continue;
            // a page whose header does not describe itself is not trusted
            if (h.pgno !== pgno || h.level !== 1 || pf.indexOffset + 2 * h.entries > pf.pageSize) {
                stats.damagedPages++;
                continue;
            }
            if (pgno === pf.root) continue; // the master database ("main")
            stats.leafPages++;
            if (h.entries % 2) stats.damagedItems++;
            for (let i = 0; i + 1 < h.entries; i += 2) {
                const key = readItem(pf, buf, pf.u16(buf, pf.indexOffset + 2 * i));
                const value = readItem(pf, buf, pf.u16(buf, pf.indexOffset + 2 * (i + 1)));
                if (!key || !value) {
                    stats.damagedItems++;
                    continue;
                }
                if (key.deleted || value.deleted) continue;
                onRecord(key.data, value.data, pgno);
            }
        }
        stats.pagesPresent++; // page 0, the metadata page, was read above
        stats.pagesMissing = Math.max(0, pf.lastPgno + 1 - stats.pagesPresent);
    } finally {
        pf.close();
    }
    return stats;
}

module.exports = {
    BdbFileError,
    scanRecords,
};
