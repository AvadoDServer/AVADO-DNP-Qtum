// Read a legacy (Berkeley DB) Qtum wallet from the record dump of the Qtum
// v29.1 wallet tool (`qtum-wallet dump`), and describe the same keys as
// descriptors for a new descriptor wallet.
//
// This is the fallback when Qtum's own `migratewallet` keeps failing: the
// monitor reads every key itself, imports them into a new descriptor wallet
// and checks the result before the new wallet is used.
//
// Record formats (Qtum Core v29.1 = Bitcoin Core 29 walletdb, see the report
// of the change that added this file for file and line references):
//   key       "key" + CPubKey            -> CPrivKey (DER) [+ sha256d(pubkey || DER)]
//   ckey      "ckey" + CPubKey           -> encrypted secret [+ sha256d(encrypted secret)]
//   mkey      "mkey" + uint32 id         -> CMasterKey
//   hdchain   "hdchain"                  -> CHDChain (version, external counter, seed id, internal counter)
//   keymeta   "keymeta" + CPubKey        -> CKeyMetadata
//   name      "name" + address           -> label
//   purpose   "purpose" + address        -> "receive" | "send"
// Qtum's legacy HD keys are labelled m/88'/c'/i' but derived at m/0'/c'/i'
// (LegacyScriptPubKeyMan::DeriveNewChildKey).
//
// Pure functions (parseDumpFile reads one file), Node built-ins only, Node 12
// compatible. Nothing here logs: the results hold private keys.

const crypto = require("crypto");
const fs = require("fs");
const readline = require("readline");
const qtumkeys = require("./qtumkeys");
const bdbfile = require("./bdbfile");

const HARDENED = 0x80000000;
const DUMP_MAGIC = "BITCOIN_CORE_WALLET_DUMP";
// Earliest rescan time: Qtum mainnet started in September 2017.
const MIN_TIMESTAMP = 1500000000;
// Extra keys past the last used one in each HD chain.
const RANGE_MARGIN = 1000;

// Base58 prefixes (Qtum src/kernel/chainparams.cpp)
const NETWORKS = {
    main: { pubkeyHash: 0x3a, wif: 0x80, xprv: 0x0488ade4 },
    test: { pubkeyHash: 0x78, wif: 0xef, xprv: 0x04358394 },
};
const network = (name) => (name === "main" ? NETWORKS.main : NETWORKS.test);

class LegacyWalletError extends Error {
    // code: needs-passphrase | wrong-passphrase | no-keys | corrupt | bad-dump | too-damaged
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const hash256 = (b) => sha256(sha256(b));
const hash160 = (b) => crypto.createHash("ripemd160").update(sha256(b)).digest();

const corrupt = (what) => new LegacyWalletError(`The old wallet could not be read (${what}).`, "corrupt");

// ---------------------------------------------------------------------------
// Bitcoin serialisation
// ---------------------------------------------------------------------------

class Reader {
    constructor(buf, what) {
        this.buf = buf;
        this.pos = 0;
        this.what = what;
    }

    need(n) {
        if (this.pos + n > this.buf.length) throw corrupt(`truncated ${this.what} record`);
    }

    bytes(n) {
        this.need(n);
        const out = this.buf.slice(this.pos, this.pos + n);
        this.pos += n;
        return out;
    }

    u8() { return this.bytes(1)[0]; }
    u32() { return this.bytes(4).readUInt32LE(0); }
    i32() { return this.bytes(4).readInt32LE(0); }
    i64() {
        const b = this.bytes(8);
        return b.readUInt32LE(0) + b.readInt32LE(4) * 0x100000000;
    }

    compactSize() {
        const first = this.u8();
        if (first < 253) return first;
        if (first === 253) return this.bytes(2).readUInt16LE(0);
        if (first === 254) return this.u32();
        const b = this.bytes(8);
        if (b.readUInt32LE(4) !== 0) throw corrupt(`oversized ${this.what} record`);
        return b.readUInt32LE(0);
    }

    vector() { return this.bytes(this.compactSize()); }
    string() { return this.vector().toString("utf8"); }
    remaining() { return this.buf.length - this.pos; }
    eof() { return this.pos >= this.buf.length; }
}

// ---------------------------------------------------------------------------
// Dump file (wallet/dump.cpp: DumpWallet)
// ---------------------------------------------------------------------------

// The record types the rebuild reads. Every other record (transactions above
// all: a staking wallet has tens of thousands) is only counted, so that a dump
// of hundreds of MB can be read with little memory.
const KEPT_TYPES = ["key", "ckey", "mkey", "hdchain", "keymeta", "name", "purpose", "defaultkey"];

const badDump = (why) => new LegacyWalletError(`The old wallet could not be read (${why}).`, "bad-dump");

// Reads the dump line by line; the checksum is computed as the lines come.
class DumpParser {
    constructor() {
        this.hasher = crypto.createHash("sha256");
        this.lineNo = 0;
        this.format = null;
        this.checksum = null;
        this.records = new Map();
        this.counts = {};
    }

    line(line) {
        if (this.checksum !== null) {
            if (line === "") return;
            throw badDump("data after the checksum");
        }
        const i = this.lineNo++;
        if (i === 0) {
            if (line !== `${DUMP_MAGIC},1`) throw badDump("unknown dump format");
            this.hasher.update(`${line}\n`, "utf8");
            return;
        }
        const comma = line.indexOf(",");
        if (comma < 0) throw badDump("malformed line");
        const k = line.slice(0, comma);
        const v = line.slice(comma + 1);
        if (k === "checksum") {
            this.checksum = v;
            return;
        }
        this.hasher.update(`${line}\n`, "utf8");
        if (i === 1) {
            if (k !== "format") throw badDump("missing format line");
            this.format = v;
            return;
        }
        if (!/^([0-9a-f]{2})+$/.test(k) || !/^([0-9a-f]{2})*$/.test(v)) throw badDump("malformed record");
        // record key = CompactSize length + type name + type-specific data
        const typeLength = parseInt(k.slice(0, 2), 16);
        if (typeLength >= 253 || k.length < 2 + 2 * typeLength) throw badDump("malformed record key");
        const type = Buffer.from(k.slice(2, 2 + 2 * typeLength), "hex").toString("latin1");
        this.counts[type] = (this.counts[type] || 0) + 1;
        if (KEPT_TYPES.indexOf(type) < 0) return;
        if (!this.records.has(type)) this.records.set(type, []);
        this.records.get(type).push({ key: Buffer.from(k, "hex"), value: Buffer.from(v, "hex") });
    }

    finish() {
        if (this.checksum === null) throw badDump("the dump is incomplete");
        const computed = sha256(this.hasher.digest()).toString("hex");
        if (computed !== this.checksum) throw badDump("checksum mismatch");
        if (this.format !== "bdb") throw badDump(`unexpected wallet format ${this.format}`);
        return { format: this.format, records: this.records, counts: this.counts };
    }
}

/**
 * Parse the output of `qtum-wallet dump` held in a string (small dumps, tests).
 * @param {string} text
 * @returns {{format: string, records: Map<string, Array<{key: Buffer, value: Buffer}>>, counts: Object}}
 *   records: only the types the rebuild reads; counts: every type
 */
function parseDump(text) {
    const parser = new DumpParser();
    const lines = String(text).split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.forEach((line) => parser.line(line));
    return parser.finish();
}

/**
 * Parse a dump file line by line (any size, little memory).
 * @param {string} file
 * @returns {Promise} same result as parseDump
 */
function parseDumpFile(file) {
    return new Promise((resolve, reject) => {
        const parser = new DumpParser();
        const input = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 1024 * 1024 });
        const rl = readline.createInterface({ input, crlfDelay: Infinity });
        let failed = false;
        const fail = (err) => {
            if (failed) return;
            failed = true;
            rl.close();
            input.destroy();
            reject(err);
        };
        // newer Node versions pass the stream's error on to the interface
        input.on("error", () => fail(badDump("the dump could not be read")));
        rl.on("error", () => fail(badDump("the dump could not be read")));
        rl.on("line", (line) => {
            if (failed) return;
            try {
                parser.line(line);
            } catch (err) {
                fail(err);
            }
        });
        rl.on("close", () => {
            if (failed) return;
            try {
                resolve(parser.finish());
            } catch (err) {
                failed = true;
                reject(err);
            }
        });
    });
}

/**
 * Read the records of a legacy wallet file directly from its pages, for a
 * damaged file the wallet tool cannot dump (bdbfile.js). Same result as
 * parseDump, plus what was found damaged or missing. The file is only read.
 * @param {string} file wallet.dat
 * @returns {{format, records, counts, source: "raw-pages", pages: Object}}
 */
function readWalletFile(file) {
    const records = new Map();
    const counts = {};
    const seen = new Set();
    let unreadable = 0;
    let pages;
    try {
        pages = bdbfile.scanRecords(file, (key, value) => {
            let type;
            try {
                type = new Reader(key, "record").string();
            } catch (e) {
                unreadable++;
                return;
            }
            // the same record twice (an old copy of a page) is kept once
            const id = `${key.toString("hex")},${value.toString("hex")}`;
            if (KEPT_TYPES.indexOf(type) >= 0) {
                if (seen.has(id)) return;
                seen.add(id);
                if (!records.has(type)) records.set(type, []);
                records.get(type).push({ key, value });
            }
            counts[type] = (counts[type] || 0) + 1;
        });
    } catch (err) {
        if (err instanceof bdbfile.BdbFileError) throw new LegacyWalletError(TOO_DAMAGED, "too-damaged");
        throw err;
    }
    const n = (type) => (records.get(type) || []).length;
    if (!n("hdchain") && !n("key") && !n("ckey")) throw new LegacyWalletError(TOO_DAMAGED, "too-damaged");
    pages.damagedItems += unreadable;
    return { format: "bdb", records, counts, source: "raw-pages", pages };
}

const TOO_DAMAGED = "The old wallet file is too damaged to read. Contact AVADO support.";

// ---------------------------------------------------------------------------
// Keys and encryption
// ---------------------------------------------------------------------------

// The 32-byte secret inside a CPrivKey (key.cpp: ec_seckey_import_der)
function secretFromDer(der) {
    let p = 0;
    const need = (n) => { if (p + n > der.length) throw corrupt("private key"); };
    need(2);
    if (der[p++] !== 0x30 || !(der[p] & 0x80)) throw corrupt("private key");
    const lenb = der[p++] & 0x7f;
    if (lenb < 1 || lenb > 2) throw corrupt("private key");
    need(lenb);
    p += lenb;
    need(3);
    if (der[p] !== 0x02 || der[p + 1] !== 0x01 || der[p + 2] !== 0x01) throw corrupt("private key");
    p += 3;
    need(2);
    if (der[p] !== 0x04) throw corrupt("private key");
    const oslen = der[p + 1];
    p += 2;
    if (oslen > 32) throw corrupt("private key");
    need(oslen);
    return Buffer.concat([Buffer.alloc(32 - oslen), der.slice(p, p + oslen)]);
}

function readPubkey(reader) {
    const pubkey = reader.vector();
    const ok = (pubkey.length === 33 && (pubkey[0] === 2 || pubkey[0] === 3))
        || (pubkey.length === 65 && pubkey[0] === 4);
    if (!ok) throw corrupt("public key");
    return pubkey;
}

// The secret must give exactly the public key the wallet stored with it.
function checkSecret(secret, pubkey) {
    let derived;
    try {
        derived = qtumkeys.publicKeyFromPrivate(secret, pubkey.length === 33);
    } catch (e) {
        return false;
    }
    return derived.equals(pubkey);
}

function aesDecrypt(key, iv, data) {
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
}

// CCrypter::SetKeyFromPassphrase, derivation method 0 (EVP_BytesToKey, SHA512)
function keyFromPassphrase(passphrase, salt, rounds) {
    let d = crypto.createHash("sha512").update(Buffer.from(passphrase, "utf8")).update(salt).digest();
    for (let i = 1; i < rounds; i++) d = crypto.createHash("sha512").update(d).digest();
    return { key: d.slice(0, 32), iv: d.slice(32, 48) };
}

function parseMasterKey(value) {
    const r = new Reader(value, "mkey");
    return {
        crypted: r.vector(),
        salt: r.vector(),
        method: r.u32(),
        rounds: r.u32(),
        other: r.vector(),
    };
}

// DecryptKey: AES-256-CBC with the master key, IV = first 16 bytes of sha256d(pubkey)
function decryptSecret(masterKey, crypted, pubkey) {
    let secret;
    try {
        secret = aesDecrypt(masterKey, hash256(pubkey).slice(0, 16), crypted);
    } catch (e) {
        return null;
    }
    if (secret.length !== 32 || !checkSecret(secret, pubkey)) return null;
    return secret;
}

function parseKeyMeta(value) {
    const r = new Reader(value, "keymeta");
    const meta = { version: r.i32(), createTime: r.i64(), hdKeypath: null, hdSeedId: null };
    if (meta.version >= 10) {
        meta.hdKeypath = r.string();
        meta.hdSeedId = r.bytes(20);
    }
    // version >= 12: key origin (fingerprint + path) and has_key_origin - not needed
    return meta;
}

function parseHdChain(value) {
    const r = new Reader(value, "hdchain");
    const chain = { version: r.i32(), externalCount: r.u32(), seedId: r.bytes(20), internalCount: 0 };
    if (chain.version >= 2) chain.internalCount = r.u32();
    return chain;
}

// "m/88'/0'/5'" -> { chain: 0, index: 5 } (the path Qtum writes into keymeta)
function legacyPathPosition(hdKeypath) {
    const m = /^m\/(\d+)'\/([01])'\/(\d+)'$/.exec(hdKeypath || "");
    return m ? { chain: parseInt(m[2], 10), index: parseInt(m[3], 10) } : null;
}

const NULL_ID = Buffer.alloc(20).toString("hex");

/**
 * Read every key of a legacy wallet.
 * @param {Map} records from parseDump
 * @param {string|null} passphrase for an encrypted wallet
 * @param {Object} [allCounts] counts of every record type, from parseDump
 * @returns {{encrypted, hd, seeds, keys, labels, unsupported, counts, derivedMissing}}
 */
function readLegacyWallet(records, passphrase, allCounts, options) {
    const get = (type) => records.get(type) || [];
    // damaged: the records were read from a damaged file (readWalletFile).
    // A record that cannot be read or checked is then left out (and counted)
    // instead of refusing the whole wallet; only the checked keys are used.
    const damaged = !!(options && options.damaged);
    let badRecords = 0;
    const each = (type, fn) => get(type).forEach((record) => {
        if (!damaged) {
            fn(record);
            return;
        }
        try {
            fn(record);
        } catch (err) {
            if (!(err instanceof LegacyWalletError) || err.code !== "corrupt") throw err;
            badRecords++;
        }
    });
    // counts of every record type (parseDump only keeps some of them)
    const counts = {};
    if (allCounts) Object.keys(allCounts).forEach((type) => { counts[type] = allCounts[type]; });
    else records.forEach((list, type) => { counts[type] = list.length; });

    // plain keys
    const keys = new Map(); // pubkey hex -> key
    each("key", ({ key, value }) => {
        const kr = new Reader(key, "key");
        kr.string();
        const pubkey = readPubkey(kr);
        const vr = new Reader(value, "key");
        const der = vr.vector();
        if (vr.remaining() >= 32) {
            const hash = vr.bytes(32);
            if (!hash.equals(Buffer.alloc(32)) && !hash256(Buffer.concat([pubkey, der])).equals(hash)) {
                throw corrupt("key checksum");
            }
        }
        const secret = secretFromDer(der);
        if (!checkSecret(secret, pubkey)) throw corrupt("a private key does not match its public key");
        keys.set(pubkey.toString("hex"), { pubkey, secret });
    });

    // encrypted keys
    const crypted = [];
    each("ckey", ({ key, value }) => {
        const kr = new Reader(key, "ckey");
        kr.string();
        const pubkey = readPubkey(kr);
        const vr = new Reader(value, "ckey");
        const data = vr.vector();
        if (vr.remaining() >= 32 && !hash256(data).equals(vr.bytes(32))) throw corrupt("encrypted key checksum");
        crypted.push({ pubkey, data });
    });
    const encrypted = crypted.length > 0;
    if (encrypted) {
        if (!passphrase) throw new LegacyWalletError("The wallet is protected with a password.", "needs-passphrase");
        const masterKeys = [];
        each("mkey", ({ value }) => masterKeys.push(parseMasterKey(value)));
        if (masterKeys.length === 0) throw corrupt("the encryption key is missing");
        // the master key must decrypt one of the first keys (in a damaged file
        // the first one may be damaged itself)
        const probes = crypted.slice(0, damaged ? 5 : 1);
        let master = null;
        for (const mk of masterKeys) {
            if (mk.method !== 0 || mk.rounds < 1) continue;
            const k = keyFromPassphrase(passphrase, mk.salt, mk.rounds);
            let candidate;
            try {
                candidate = aesDecrypt(k.key, k.iv, mk.crypted);
            } catch (e) {
                continue; // wrong passphrase: bad padding
            }
            if (candidate.length === 32 && probes.some((c) => decryptSecret(candidate, c.data, c.pubkey))) {
                master = candidate;
                break;
            }
        }
        if (!master) throw new LegacyWalletError("The wallet password is not correct.", "wrong-passphrase");
        crypted.forEach(({ pubkey, data }) => {
            const secret = decryptSecret(master, data, pubkey);
            if (!secret) {
                if (!damaged) throw corrupt("an encrypted private key does not match its public key");
                badRecords++;
                return;
            }
            keys.set(pubkey.toString("hex"), { pubkey, secret });
        });
    }
    if (keys.size === 0) {
        if (damaged) throw new LegacyWalletError(TOO_DAMAGED, "too-damaged");
        throw new LegacyWalletError("The old wallet contains no private keys.", "no-keys");
    }

    // metadata
    const meta = new Map();
    each("keymeta", ({ key, value }) => {
        const kr = new Reader(key, "keymeta");
        kr.string();
        meta.set(readPubkey(kr).toString("hex"), parseKeyMeta(value));
    });
    const byId = new Map(); // hash160(pubkey) hex -> key
    keys.forEach((k, hex) => {
        const m = meta.get(hex);
        k.createTime = m ? m.createTime : 0;
        k.keymetaPath = m ? m.hdKeypath : null;
        k.hdSeedId = m && m.hdSeedId && m.hdSeedId.toString("hex") !== NULL_ID ? m.hdSeedId.toString("hex") : null;
        k.hdPath = null;
        k.derivedFromSeed = false;
        k.compressed = k.pubkey.length === 33;
        byId.set(hash160(k.pubkey).toString("hex"), k);
    });

    // HD seeds: the active one (hdchain) and older ones that keys still name
    let hd = null;
    // one hdchain record; a damaged file may also hold an older copy of it on a
    // stale page: the one with the highest counters is the newest
    let activeChain = null;
    each("hdchain", ({ value }) => {
        const c = parseHdChain(value);
        if (!activeChain || c.externalCount + c.internalCount > activeChain.externalCount + activeChain.internalCount) activeChain = c;
    });
    const seedIds = new Map(); // seed id -> {externalCount, internalCount, active}
    if (activeChain && activeChain.seedId.toString("hex") !== NULL_ID) {
        seedIds.set(activeChain.seedId.toString("hex"), {
            externalCount: activeChain.externalCount,
            internalCount: activeChain.internalCount,
            active: true,
            version: activeChain.version,
        });
    }
    keys.forEach((k) => {
        const pos = legacyPathPosition(k.keymetaPath);
        if (!k.hdSeedId || !pos) return;
        if (!seedIds.has(k.hdSeedId)) seedIds.set(k.hdSeedId, { externalCount: 0, internalCount: 0, active: false });
        const s = seedIds.get(k.hdSeedId);
        if (pos.chain === 0) s.externalCount = Math.max(s.externalCount, pos.index + 1);
        else s.internalCount = Math.max(s.internalCount, pos.index + 1);
    });

    // A damaged file may have lost the hdchain record and the key metadata
    // that name the seed: then find it by derivation (a key whose first
    // derived keys are in the wallet is the seed).
    let seedFoundByDerivation = false;
    if (damaged && !Array.from(seedIds.keys()).some((id) => byId.has(id))) {
        const found = findSeedByDerivation(keys);
        if (found) {
            seedIds.set(found.seedId, { externalCount: found.externalCount, internalCount: found.internalCount, active: true, version: 2 });
            seedFoundByDerivation = true;
        }
    }
    if (damaged && !activeChain && seedIds.size && !Array.from(seedIds.values()).some((s) => s.active)) {
        // no hdchain record: the seed that the most keys name is the active one
        let best = null;
        seedIds.forEach((s, id) => {
            if (byId.has(id) && (!best || s.externalCount + s.internalCount > best.externalCount + best.internalCount)) best = s;
        });
        if (best) {
            best.active = true;
            best.version = 2;
        }
    }

    const seeds = [];
    let derivedMissing = 0;
    seedIds.forEach((s, seedId) => {
        const seedKey = byId.get(seedId);
        if (!seedKey) {
            if (s.active && !damaged) throw corrupt("the HD seed key is missing");
            return; // keys of an unknown seed are imported one by one
        }
        const I = crypto.createHmac("sha512", "Bitcoin seed").update(seedKey.secret).digest();
        const master = { key: I.slice(0, 32), chainCode: I.slice(32) };
        const account = qtumkeys.deriveChild(master, HARDENED);
        [s.externalCount, s.internalCount].forEach((count, chain) => {
            if (count === 0 && !damaged) return;
            const chainNode = qtumkeys.deriveChild(account, HARDENED + chain);
            // in a damaged file the counters and the key metadata may be lost
            // or stale: keep looking while keys turn up (gap of RANGE_MARGIN)
            let last = -1;
            for (let i = 0; i < count || (damaged && i <= last + RANGE_MARGIN); i++) {
                const child = qtumkeys.deriveChild(chainNode, HARDENED + i);
                const k = keys.get(qtumkeys.publicKeyFromPrivate(child.key, true).toString("hex"));
                if (!k || !k.secret.equals(child.key)) {
                    if (i < count) derivedMissing++;
                    continue;
                }
                last = i;
                k.derivedFromSeed = true;
                k.seedId = seedId;
                k.hdPath = `m/0'/${chain}'/${i}'`;
            }
            if (chain === 0) s.externalCount = Math.max(count, last + 1);
            else s.internalCount = Math.max(count, last + 1);
        });
        const entry = {
            seedId,
            seed: seedKey.secret,
            master,
            active: s.active,
            externalCount: s.externalCount,
            internalCount: s.internalCount,
        };
        seeds.push(entry);
        if (s.active) hd = { seed: seedKey.secret, seedId, externalCount: s.externalCount, internalCount: s.internalCount, version: s.version };
    });
    seeds.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));

    // address book
    const labels = new Map();
    const purposes = new Map();
    each("name", ({ key, value }) => {
        const kr = new Reader(key, "name");
        kr.string();
        labels.set(kr.string(), new Reader(value, "name").string());
    });
    each("purpose", ({ key, value }) => {
        const kr = new Reader(key, "purpose");
        kr.string();
        purposes.set(kr.string(), new Reader(value, "purpose").string());
    });

    const n = (type) => counts[type] || 0;
    return {
        encrypted,
        hd,
        seeds,
        keys: Array.from(keys.values()),
        labels,
        purposes,
        unsupported: {
            watchOnly: n("watchs"),
            scripts: n("cscript"),
            tokens: n("token"),
            delegations: n("delegation"),
            superStakers: n("superstaker"),
            contractData: n("contractdata"),
        },
        counts,
        derivedMissing,
        badRecords,
        seedFoundByDerivation,
    };
}

// Look for the HD seed among the keys: a key is the seed when one of the
// first keys derived from it (m/0'/c'/i', i < 5) is in the wallet.
function findSeedByDerivation(keys) {
    const probe = 5;
    for (const k of keys.values()) {
        const I = crypto.createHmac("sha512", "Bitcoin seed").update(k.secret).digest();
        let account;
        try {
            account = qtumkeys.deriveChild({ key: I.slice(0, 32), chainCode: I.slice(32) }, HARDENED);
        } catch (e) {
            continue;
        }
        const counts = [0, 0];
        [0, 1].forEach((chain) => {
            const chainNode = qtumkeys.deriveChild(account, HARDENED + chain);
            for (let i = 0; i < probe; i++) {
                const child = qtumkeys.deriveChild(chainNode, HARDENED + i);
                if (keys.has(qtumkeys.publicKeyFromPrivate(child.key, true).toString("hex"))) counts[chain] = i + 1;
            }
        });
        if (counts[0] || counts[1]) {
            // readLegacyWallet then looks further along both chains
            return { seedId: hash160(k.pubkey).toString("hex"), externalCount: counts[0], internalCount: counts[1] };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

// script/descriptor.cpp: DescriptorChecksum
const INPUT_CHARSET = "0123456789()[],'/*abcdefgh@:$%{}" +
    "IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~" +
    "ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATORS = [0xf5dee51989, 0xa9fdca3312, 0x1bab10e32d, 0x3706b1677a, 0x644d626ffd].map((g) => BigInt(g));

function polyMod(c, val) {
    const c0 = c >> BigInt(35);
    c = ((c & BigInt(0x7ffffffff)) << BigInt(5)) ^ BigInt(val);
    for (let i = 0; i < 5; i++) {
        if ((c0 >> BigInt(i)) & BigInt(1)) c ^= GENERATORS[i];
    }
    return c;
}

function descriptorChecksum(desc) {
    let c = BigInt(1);
    let cls = 0;
    let clscount = 0;
    for (const ch of desc) {
        const pos = INPUT_CHARSET.indexOf(ch);
        if (pos < 0) return "";
        c = polyMod(c, pos & 31);
        cls = cls * 3 + (pos >> 5);
        if (++clscount === 3) {
            c = polyMod(c, cls);
            cls = 0;
            clscount = 0;
        }
    }
    if (clscount > 0) c = polyMod(c, cls);
    for (let j = 0; j < 8; j++) c = polyMod(c, 0);
    c ^= BigInt(1);
    let out = "";
    for (let j = 0; j < 8; j++) out += CHECKSUM_CHARSET[Number((c >> BigInt(5 * (7 - j))) & BigInt(31))];
    return out;
}

const withChecksum = (desc) => `${desc}#${descriptorChecksum(desc)}`;

// BIP32 serialisation of a master private key (depth 0)
function encodeExtendedPrivateKey(node, version) {
    const payload = Buffer.alloc(78);
    payload.writeUInt32BE(version >>> 0, 0);
    // depth 0, parent fingerprint 0, child number 0
    node.chainCode.copy(payload, 13);
    payload[45] = 0;
    node.key.copy(payload, 46);
    return qtumkeys.base58CheckEncode(payload);
}

// Rescan start: one day before the oldest key, never before Qtum existed. A
// key without a creation time (no metadata, or 1 = "unknown", as importprivkey
// writes) may have coins from any time: then the whole chain is scanned.
function rescanTimestamp(wallet) {
    const times = wallet.keys.map((k) => k.createTime);
    if (times.length === 0 || times.some((t) => !(t > 1))) return MIN_TIMESTAMP;
    return Math.max(MIN_TIMESTAMP, Math.min.apply(null, times) - 86400);
}

// The descriptors Qtum v30 makes for new addresses (wallet/walletutil.cpp:
// GenerateWalletDescriptor; coin type 88 on every network)
// The P2PK one cannot be made active through importdescriptors (it counts as
// "legacy" there and would replace pkh); Qtum only uses it for Ledger
// hardware wallets, so it is imported as an inactive descriptor.
const ACTIVE_TEMPLATES = [
    { active: true, make: (x, c) => `pkh(${x}/44h/88h/0h/${c}/*)` },
    { active: true, make: (x, c) => `sh(wpkh(${x}/49h/88h/0h/${c}/*))` },
    { active: true, make: (x, c) => `wpkh(${x}/84h/88h/0h/${c}/*)` },
    { active: true, make: (x, c) => `tr(${x}/86h/88h/0h/${c}/*)` },
    { active: false, make: (x, c) => `pk(${x}/44h/88h/0h/${c}/*)` },
];

/**
 * The `importdescriptors` request for a wallet read by readLegacyWallet.
 * Holds private keys: never log it.
 *
 * - every HD seed: combo(xprv/0h/0h/*h) and combo(xprv/0h/1h/*h), the keys
 *   Qtum's legacy wallet handed out (the same descriptors `migratewallet`
 *   makes); combo descriptors cannot be active
 * - the active seed: the descriptors Qtum v30 uses for new addresses
 *   (`migratewallet` sets up the same ones from the same seed)
 * - every other key: combo(WIF)
 */
function buildDescriptors(wallet, networkName) {
    const net = network(networkName);
    const timestamp = rescanTimestamp(wallet);
    const out = [];
    wallet.seeds.forEach((s) => {
        const xprv = encodeExtendedPrivateKey(s.master, net.xprv);
        const highest = { 0: -1, 1: -1 };
        wallet.keys.forEach((k) => {
            if (k.seedId !== s.seedId || !k.hdPath) return;
            const pos = legacyPathPosition(k.hdPath);
            if (pos) highest[pos.chain] = Math.max(highest[pos.chain], pos.index);
        });
        [0, 1].forEach((chain) => {
            const count = chain === 0 ? s.externalCount : s.internalCount;
            if (count === 0 && highest[chain] < 0) return;
            const end = Math.max(count, highest[chain] + 1) + RANGE_MARGIN;
            out.push({
                desc: withChecksum(`combo(${xprv}/0h/${chain}h/*h)`),
                timestamp,
                range: [0, end],
                active: false,
                internal: chain === 1,
            });
        });
        if (s.active) {
            [0, 1].forEach((chain) => {
                ACTIVE_TEMPLATES.forEach((t) => {
                    const entry = { desc: withChecksum(t.make(xprv, chain)), timestamp, active: t.active };
                    if (t.active) entry.internal = chain === 1;
                    out.push(entry);
                });
            });
        }
    });
    wallet.keys.forEach((k) => {
        if (k.derivedFromSeed) return;
        const wif = qtumkeys.encodeWif(k.secret, net.wif, k.compressed);
        out.push({ desc: withChecksum(`combo(${wif})`), timestamp, active: false, internal: false });
    });
    return out;
}

function p2pkhAddress(pubkey, networkName) {
    return qtumkeys.base58CheckEncode(Buffer.concat([Buffer.from([network(networkName).pubkeyHash]), hash160(pubkey)]));
}

/**
 * The P2PKH address of every key of the old wallet (HD keys included: they
 * are all in the wallet's records). The rebuilt wallet must own every one.
 */
function expectedAddresses(wallet, networkName) {
    const set = new Set();
    wallet.keys.forEach((k) => set.add(p2pkhAddress(k.pubkey, networkName)));
    return Array.from(set).sort();
}

// The first receive address of the active HD chain (m/0'/0'/0'), derived from
// the seed (its key record may be lost in a damaged file), or null
function firstReceiveAddress(wallet, networkName) {
    const active = wallet.seeds.find((s) => s.active);
    if (!active) return null;
    let node = active.master;
    [HARDENED, HARDENED, HARDENED].forEach((i) => { node = qtumkeys.deriveChild(node, i); });
    return p2pkhAddress(qtumkeys.publicKeyFromPrivate(node.key, true), networkName);
}

// What the old wallet contained, without any key material.
// parsed: the result of parseDumpFile or readWalletFile (where it was read from)
function summary(wallet, descriptors, parsed) {
    const pages = parsed && parsed.pages;
    return {
        source: (parsed && parsed.source) || "dump",
        damagedPages: pages ? pages.damagedPages : 0,
        damagedItems: pages ? pages.damagedItems : 0,
        pagesMissing: pages ? pages.pagesMissing : 0,
        badRecords: wallet.badRecords || 0,
        seedFoundByDerivation: !!wallet.seedFoundByDerivation,
        encrypted: wallet.encrypted,
        hd: !!wallet.hd,
        seeds: wallet.seeds.length,
        keys: wallet.keys.length,
        hdKeys: wallet.keys.filter((k) => k.derivedFromSeed).length,
        individualKeys: wallet.keys.filter((k) => !k.derivedFromSeed).length,
        externalCount: wallet.hd ? wallet.hd.externalCount : 0,
        internalCount: wallet.hd ? wallet.hd.internalCount : 0,
        derivedMissing: wallet.derivedMissing,
        labels: wallet.labels.size,
        descriptors: descriptors ? descriptors.length : undefined,
        unsupported: wallet.unsupported,
        counts: wallet.counts,
    };
}

module.exports = {
    LegacyWalletError,
    parseDump,
    parseDumpFile,
    readWalletFile,
    readLegacyWallet,
    buildDescriptors,
    expectedAddresses,
    firstReceiveAddress,
    p2pkhAddress,
    descriptorChecksum,
    encodeExtendedPrivateKey,
    rescanTimestamp,
    summary,
    RANGE_MARGIN,
};
