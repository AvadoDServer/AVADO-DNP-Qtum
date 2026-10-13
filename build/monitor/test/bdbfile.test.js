// Tests of the direct (raw page) reader of legacy wallet files, for damaged
// wallets the Qtum wallet tool cannot dump. Fixtures: fixtures/generate.sh.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const bdbfile = require("../bdbfile");
const lw = require("../legacywallet");
const qtumkeys = require("../qtumkeys");

const FIXTURES = path.join(__dirname, "fixtures");
const NAMES = ["hd-plain", "hd-encrypted", "hd-imported", "nonhd"];
const PAGE = 4096;
const walletFile = (name) => path.join(FIXTURES, `${name}.wallet.dat`);
const truth = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.truth.json`), "utf8"));
const dumpText = (name) => fs.readFileSync(path.join(FIXTURES, `${name}.dump`), "utf8");

// every record of the dump, as "hexkey,hexvalue"
const dumpRecords = (name) => dumpText(name).trim().split("\n").slice(2, -1).sort();

const scan = (file) => {
    const records = [];
    const stats = bdbfile.scanRecords(file, (k, v, pgno) => records.push({ id: `${k.toString("hex")},${v.toString("hex")}`, pgno }));
    return { records, stats };
};

let tmpCount = 0;
const tmpCopy = (buf) => {
    const file = path.join(os.tmpdir(), `qtum-bdb-test-${process.pid}-${tmpCount++}.dat`);
    fs.writeFileSync(file, buf);
    return file;
};

const keptSet = (records) => {
    const out = [];
    records.forEach((list) => list.forEach((r) => out.push(`${r.key.toString("hex")},${r.value.toString("hex")}`)));
    return out.sort();
};

// The P2PKH addresses the descriptors of buildDescriptors cover for HD keys:
// derive m/0'/c'/i' from each combo(tprv/0h/ch/*h) within its range
function hdAddressesCovered(descriptors, wantedPaths) {
    const covered = new Set();
    descriptors.forEach((d) => {
        const m = /^combo\((tprv[1-9A-HJ-NP-Za-km-z]+)\/0h\/([01])h\/\*h\)/.exec(d.desc);
        if (!m) return;
        const ext = qtumkeys.decodeExtendedPrivateKey(m[1]);
        const node = qtumkeys.deriveChild(qtumkeys.deriveChild({ key: ext.key, chainCode: ext.chainCode }, 0x80000000), 0x80000000 + Number(m[2]));
        wantedPaths.filter((p) => p.chain === Number(m[2]) && p.index <= d.range[1]).forEach((p) => {
            const child = qtumkeys.deriveChild(node, 0x80000000 + p.index);
            covered.add(lw.p2pkhAddress(qtumkeys.publicKeyFromPrivate(child.key, true), "regtest"));
        });
    });
    return covered;
}

const hdTruth = (name) => truth(name).keys
    .map((k) => ({ address: k.addresses[0], m: /^m\/88'\/([01])'\/(\d+)'$/.exec(k.hdkeypath || "") }))
    .filter((k) => k.m)
    .map((k) => ({ address: k.address, chain: Number(k.m[1]), index: Number(k.m[2]) }));

test("the raw reader finds exactly the records of the wallet tool's dump", () => {
    NAMES.forEach((name) => {
        const { records, stats } = scan(walletFile(name));
        assert.deepStrictEqual(records.map((r) => r.id).sort(), dumpRecords(name), name);
        assert.strictEqual(stats.damagedPages, 0);
        assert.strictEqual(stats.damagedItems, 0);
        assert.strictEqual(stats.pagesMissing, 0);
        // and readWalletFile gives the same as parseDump
        const raw = lw.readWalletFile(walletFile(name));
        const parsed = lw.parseDump(dumpText(name));
        assert.deepStrictEqual(keptSet(raw.records), keptSet(parsed.records), name);
        assert.deepStrictEqual(raw.counts, parsed.counts, name);
        assert.strictEqual(raw.source, "raw-pages");
    });
});

test("records on overflow pages are read; a chain that runs into a missing page is skipped", () => {
    const buf = fs.readFileSync(walletFile("hd-imported"));
    const overflowPages = [];
    for (let p = 1; p < buf.length / PAGE; p++) if (buf[p * PAGE + 25] === 7) overflowPages.push(p);
    assert.ok(overflowPages.length >= 2, "the long label is on overflow pages");
    const longLabel = Object.keys(truth("hd-imported").labels).find((a) => truth("hd-imported").labels[a].label.length > 4000);
    const wallet = lw.readLegacyWallet(lw.readWalletFile(walletFile("hd-imported")).records, null, null, { damaged: true });
    assert.ok(wallet.labels.get(longLabel).length > 4000);

    // the first overflow page now links to a page that is not in the file
    const broken = Buffer.from(buf);
    broken.writeUInt32LE(9999, overflowPages[0] * PAGE + 16);
    const { records, stats } = scan(tmpCopy(broken));
    assert.strictEqual(stats.damagedItems, 1);
    const all = dumpRecords("hd-imported");
    assert.strictEqual(records.length, all.length - 1);
    records.forEach((r) => assert.ok(all.includes(r.id)));
    const damaged = lw.readLegacyWallet(lw.readWalletFile(tmpCopy(broken)).records, null, null, { damaged: true });
    assert.strictEqual(damaged.labels.has(longLabel), false);
    assert.strictEqual(damaged.keys.length, truth("hd-imported").keys.length);
});

test("a page with a garbage header is skipped and counted; the other pages are read", () => {
    const buf = Buffer.from(fs.readFileSync(walletFile("hd-plain")));
    const leaves = [];
    for (let p = 2; p < buf.length / PAGE; p++) if (buf[p * PAGE + 25] === 5) leaves.push(p);
    const victim = leaves[2];
    const before = scan(walletFile("hd-plain")).records.filter((r) => r.pgno !== victim).map((r) => r.id).sort();
    buf.writeUInt32LE(0xdeadbeef, victim * PAGE + 8); // pgno does not match the position
    buf.writeUInt16LE(0xffff, victim * PAGE + 20); // and an impossible number of entries
    const { records, stats } = scan(tmpCopy(buf));
    assert.strictEqual(stats.damagedPages, 1);
    assert.deepStrictEqual(records.map((r) => r.id).sort(), before);
    // a page full of noise is no leaf page: ignored
    const noise = Buffer.from(fs.readFileSync(walletFile("hd-plain")));
    for (let i = 0; i < PAGE; i++) noise[leaves[3] * PAGE + i] = (i * 151 + 7) & 0xff;
    noise[leaves[3] * PAGE + 25] = 0xab;
    const second = scan(tmpCopy(noise));
    assert.strictEqual(second.records.length, scan(walletFile("hd-plain")).records.filter((r) => r.pgno !== leaves[3]).length);
});

test("a file that is not a wallet, or has no keys left, is too damaged", () => {
    assert.throws(() => lw.readWalletFile(tmpCopy(Buffer.alloc(PAGE * 3))), (e) => e.code === "too-damaged");
    // only the metadata pages survive
    const buf = fs.readFileSync(walletFile("hd-plain")).slice(0, 3 * PAGE);
    assert.throws(() => lw.readWalletFile(tmpCopy(buf)), (e) => e.code === "too-damaged" && /too damaged/.test(e.message));
});

// hd-plain cut short like the customer's wallet: the tree links to pages that
// are not in the file any more
for (const name of ["hd-plain", "hd-encrypted"]) {
    test(`${name} cut short: every record on the pages left is read, and every HD address is restored`, () => {
        const full = fs.readFileSync(walletFile(name));
        const pages = full.length / PAGE;
        const t = truth(name);
        const fullScan = scan(walletFile(name)).records;
        const seedWif = t.keys.find((k) => k.flags.hdseed !== undefined).wif;

        // cut to 60 %: exactly the records of the pages left, and every key on them
        const cut60 = Math.ceil(pages * 0.6);
        const scan60 = scan(tmpCopy(full.slice(0, cut60 * PAGE)));
        const left60 = fullScan.filter((r) => r.pgno < cut60).map((r) => r.id);
        assert.deepStrictEqual(scan60.records.map((r) => r.id).sort(), left60.sort());
        const raw60 = lw.readWalletFile(tmpCopy(full.slice(0, cut60 * PAGE)));
        const wallet60 = lw.readLegacyWallet(raw60.records, t.passphrase, raw60.counts, { damaged: true });
        assert.strictEqual(wallet60.keys.length, left60.filter((id) => /^036b6579|^04636b6579/.test(id)).length);
        assert.ok(wallet60.keys.length < t.keys.length && wallet60.keys.length > 0);

        // the smallest cut of at least 60 % that still holds the hdchain and the seed key
        let cut = Math.ceil(pages * 0.6);
        let raw;
        for (; cut < pages; cut++) {
            raw = lw.readWalletFile(tmpCopy(full.slice(0, cut * PAGE)));
            const w = lw.readLegacyWallet(raw.records, t.passphrase, raw.counts, { damaged: true });
            const wifs = w.keys.map((k) => qtumkeys.encodeWif(k.secret, 0xef, k.compressed));
            if (raw.records.has("hdchain") && wifs.includes(seedWif)) break;
        }
        assert.ok(cut < pages, "a cut that loses pages but keeps the hdchain and the seed");
        const truncated = full.slice(0, cut * PAGE);

        // the pages left: exactly their records
        const { records, stats } = scan(tmpCopy(truncated));
        assert.deepStrictEqual(records.map((r) => r.id).sort(), fullScan.filter((r) => r.pgno < cut).map((r) => r.id).sort());
        assert.strictEqual(stats.pagesMissing, pages - cut);
        assert.strictEqual(raw.pages.pagesMissing, pages - cut);
        assert.ok(fullScan.some((r) => r.pgno >= cut), "some records were on the lost pages");
        if (name === "hd-plain") assert.ok(fullScan.some((r) => r.pgno >= cut && /^036b6579/.test(r.id)), "some keys were on the lost pages");

        const wallet = lw.readLegacyWallet(raw.records, t.passphrase, raw.counts, { damaged: true });
        assert.ok(wallet.hd, "HD wallet");
        const descriptors = lw.buildDescriptors(wallet, "regtest");
        // every key record on the pages left is in the wallet
        const truthByAddress = new Map(t.keys.map((k) => [k.addresses[0], k]));
        lw.expectedAddresses(wallet, "regtest").forEach((a) => assert.ok(truthByAddress.has(a)));
        // every HD address of the old wallet is derived by the descriptors
        const hd = hdTruth(name);
        const covered = hdAddressesCovered(descriptors, hd);
        // (the encrypted wallet's keys from before its seed change are only
        // restored when their key records survive)
        const activeSeedAddresses = hd.filter((k) => {
            const tk = truthByAddress.get(k.address);
            return tk.flags.inactivehdseed === undefined;
        });
        activeSeedAddresses.forEach((k) => assert.ok(covered.has(k.address), `${name}: ${k.address} m/88'/${k.chain}'/${k.index}' is restored`));
    });
}

test("without hdchain and key metadata the seed is found by derivation", () => {
    const parsed = lw.parseDump(dumpText("hd-plain"));
    const records = new Map(parsed.records);
    records.delete("hdchain");
    records.delete("keymeta");
    const wallet = lw.readLegacyWallet(records, null, null, { damaged: true });
    assert.ok(wallet.seedFoundByDerivation);
    assert.ok(wallet.hd);
    const hd = hdTruth("hd-plain");
    const covered = hdAddressesCovered(lw.buildDescriptors(wallet, "regtest"), hd);
    hd.forEach((k) => assert.ok(covered.has(k.address), k.address));
    // a healthy dump without them is still refused as before (no guessing)
    assert.strictEqual(lw.readLegacyWallet(records, null).hd, null);
});

test("a damaged key record is skipped in a damaged file, refused in a healthy one", () => {
    const parsed = lw.parseDump(dumpText("hd-plain"));
    const keys = parsed.records.get("key");
    const value = Buffer.from(keys[1].value);
    value[12] ^= 0x01;
    const records = new Map(parsed.records);
    records.set("key", [keys[0], { key: keys[1].key, value }].concat(keys.slice(2)));
    assert.throws(() => lw.readLegacyWallet(records, null), (e) => e.code === "corrupt");
    const wallet = lw.readLegacyWallet(records, null, null, { damaged: true });
    assert.strictEqual(wallet.badRecords, 1);
    assert.strictEqual(wallet.keys.length, keys.length - 1);
});

// Every P2PKH address the descriptors of buildDescriptors make the wallet own:
// the HD combo() ranges and the single keys
function coveredAddresses(descriptors) {
    const out = new Set();
    descriptors.forEach((d) => {
        const hd = /^combo\((tprv[1-9A-HJ-NP-Za-km-z]+)\/0h\/([01])h\/\*h\)/.exec(d.desc);
        if (hd) {
            const ext = qtumkeys.decodeExtendedPrivateKey(hd[1]);
            const node = qtumkeys.deriveChild(qtumkeys.deriveChild({ key: ext.key, chainCode: ext.chainCode }, 0x80000000), 0x80000000 + Number(hd[2]));
            for (let i = 0; i <= d.range[1]; i++) {
                out.add(lw.p2pkhAddress(qtumkeys.publicKeyFromPrivate(qtumkeys.deriveChild(node, 0x80000000 + i).key, true), "regtest"));
            }
            return;
        }
        const single = /^combo\(([1-9A-HJ-NP-Za-km-z]{51,52})\)/.exec(d.desc);
        if (single) {
            const w = qtumkeys.decodeWif(single[1]);
            out.add(lw.p2pkhAddress(qtumkeys.publicKeyFromPrivate(w.key, w.compressed), "regtest"));
        }
    });
    return out;
}

test("keys a damaged file names without a key record must be recovered: HD keys come back from the seed", () => {
    const t = truth("hd-plain");
    const parsed = lw.parseDump(dumpText("hd-plain"));
    const full = lw.readLegacyWallet(parsed.records, null, parsed.counts);
    const pubkeyOf = new Map(full.keys.map((k) => [qtumkeys.encodeWif(k.secret, 0xef, k.compressed), k.pubkey.toString("hex")]));
    const recordPubkey = (r) => r.key.slice(1 + r.key[0] + 1).toString("hex");
    // three keypool keys and two used keys lose their key record; two of the
    // keypool keys also lose their key metadata (named by the keypool only)
    const reserve = t.keys.filter((k) => k.flags.reserve !== undefined).slice(0, 3).map((k) => pubkeyOf.get(k.wif));
    const used = t.keys.filter((k) => k.flags.label !== undefined && k.hdkeypath).slice(0, 2).map((k) => pubkeyOf.get(k.wif));
    const lost = new Set(reserve.concat(used));
    const records = new Map(parsed.records);
    records.set("key", parsed.records.get("key").filter((r) => !lost.has(recordPubkey(r))));
    records.set("keymeta", parsed.records.get("keymeta").filter((r) => reserve.slice(0, 2).indexOf(recordPubkey(r)) < 0));
    const wallet = lw.readLegacyWallet(records, null, parsed.counts, { damaged: true });
    assert.strictEqual(wallet.keys.length, full.keys.length - 5);
    assert.strictEqual(wallet.namedOnly.length, 5);
    const named = lw.namedOnlyAddresses(wallet, "regtest");
    const covered = coveredAddresses(lw.buildDescriptors(wallet, "regtest"));
    named.forEach((a) => assert.ok(covered.has(a), `${a} is recovered from the seed`));
    assert.strictEqual(lw.summary(wallet, null, { source: "raw-pages" }).namedOnlyKeys, 5);

    // a key the file names that the seed does not give: the gate must refuse
    const stranger = qtumkeys.publicKeyFromPrivate(require("crypto").randomBytes(32), true);
    const meta = parsed.records.get("keymeta")[0];
    const strangerMeta = { key: Buffer.concat([Buffer.from([7]), Buffer.from("keymeta"), Buffer.from([33]), stranger]), value: meta.value };
    records.set("keymeta", records.get("keymeta").concat([strangerMeta]));
    const refused = lw.readLegacyWallet(records, null, parsed.counts, { damaged: true });
    const missing = lw.namedOnlyAddresses(refused, "regtest").filter((a) => !coveredAddresses(lw.buildDescriptors(refused, "regtest")).has(a));
    assert.deepStrictEqual(missing, [lw.p2pkhAddress(stranger, "regtest")]);
    // a healthy dump is not checked this way
    assert.strictEqual(lw.readLegacyWallet(parsed.records, null, parsed.counts).namedOnly.length, 0);
});

test("the cut-short fixture: keys named on the pages left but not readable are all derivable from the seed", () => {
    const full = fs.readFileSync(walletFile("hd-plain"));
    const pages = full.length / PAGE;
    for (let cut = Math.ceil(pages * 0.6); cut < pages; cut++) {
        const raw = lw.readWalletFile(tmpCopy(full.slice(0, cut * PAGE)));
        const wallet = lw.readLegacyWallet(raw.records, null, raw.counts, { damaged: true });
        if (!wallet.hd) continue;
        const covered = coveredAddresses(lw.buildDescriptors(wallet, "regtest"));
        lw.namedOnlyAddresses(wallet, "regtest").forEach((a) => assert.ok(covered.has(a), `cut ${cut}: ${a}`));
        return;
    }
    assert.fail("no cut keeps the seed");
});

test.after(() => {
    for (let i = 0; i < tmpCount; i++) {
        try { fs.unlinkSync(path.join(os.tmpdir(), `qtum-bdb-test-${process.pid}-${i}.dat`)); } catch (e) { /* gone */ }
    }
});
