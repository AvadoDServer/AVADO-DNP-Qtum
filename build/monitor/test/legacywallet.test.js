// Unit tests for legacywallet.js against real legacy wallets made by Qtum
// Core v22.1 on regtest (fixtures/generate.sh). Run with `npm test` (Node 18+).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const lw = require("../legacywallet");
const qtumkeys = require("../qtumkeys");

const FIXTURES = path.join(__dirname, "fixtures");
const NAMES = ["hd-plain", "hd-encrypted", "hd-imported", "nonhd"];
const read = (name, ext) => fs.readFileSync(path.join(FIXTURES, `${name}.${ext}`), "utf8");
const truth = (name) => JSON.parse(read(name, "truth.json"));
const dump = (name) => read(name, "dump");
const load = (name) => {
    const parsed = lw.parseDump(dump(name));
    return lw.readLegacyWallet(parsed.records, truth(name).passphrase, parsed.counts);
};
const wifs = (wallet) => wallet.keys.map((k) => qtumkeys.encodeWif(k.secret, 0xef, k.compressed)).sort();
const stripOrigin = (desc) => desc.split("#")[0].replace(/\[[0-9a-f]{8}[^\]]*\]/g, "");

test("parseDump keeps only the records the rebuild reads, and counts all", () => {
    const parsed = lw.parseDump(dump("hd-plain"));
    assert.ok(parsed.counts.tx > 0);
    assert.ok(!parsed.records.has("tx"));
    assert.ok(parsed.records.has("key") && parsed.records.has("keymeta") && parsed.records.has("hdchain"));
});

test("parseDumpFile gives the same result as parseDump", async () => {
    for (const name of NAMES) {
        const fromFile = await lw.parseDumpFile(path.join(FIXTURES, `${name}.dump`));
        const fromText = lw.parseDump(dump(name));
        assert.deepStrictEqual(fromFile.counts, fromText.counts);
        assert.deepStrictEqual(fromFile.records, fromText.records);
    }
    const tmp = path.join(require("os").tmpdir(), `qtum-dump-test-${process.pid}`);
    fs.writeFileSync(tmp, dump("hd-plain").replace(/checksum,[0-9a-f]+/, "checksum,00"));
    await assert.rejects(lw.parseDumpFile(tmp), (e) => e.code === "bad-dump");
    fs.writeFileSync(tmp, dump("hd-plain").split("\n").slice(0, 20).join("\n"));
    await assert.rejects(lw.parseDumpFile(tmp), (e) => e.code === "bad-dump");
    fs.unlinkSync(tmp);
    await assert.rejects(lw.parseDumpFile(tmp), (e) => e.code === "bad-dump");
});

test("parseDump reads every record and checks the checksum", () => {
    NAMES.forEach((name) => {
        const parsed = lw.parseDump(dump(name));
        assert.strictEqual(parsed.format, "bdb");
        const lines = dump(name).trim().split("\n").length;
        const records = Object.keys(parsed.counts).reduce((n, t) => n + parsed.counts[t], 0);
        assert.strictEqual(records, lines - 3, `${name}: header, format and checksum lines`);
    });
});

test("parseDump refuses a changed, cut or foreign dump", () => {
    const text = dump("hd-plain");
    const lines = text.trim().split("\n");
    const changed = lines.slice();
    changed[5] = changed[5].replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    assert.throws(() => lw.parseDump(`${changed.join("\n")}\n`), (e) => e.code === "bad-dump" && /checksum/.test(e.message));
    assert.throws(() => lw.parseDump(`${lines.slice(0, -1).join("\n")}\n`), (e) => e.code === "bad-dump");
    assert.throws(() => lw.parseDump(`${lines.slice(0, 10).join("\n")}\n`), (e) => e.code === "bad-dump");
    assert.throws(() => lw.parseDump(text.replace("BITCOIN_CORE_WALLET_DUMP,1", "SOMETHING,1")), (e) => e.code === "bad-dump");
});

test("every key matches the old wallet's dumpwallet (count, WIF, address)", () => {
    NAMES.forEach((name) => {
        const t = truth(name);
        const wallet = load(name);
        assert.strictEqual(wallet.keys.length, t.keys.length, `${name}: key count`);
        assert.deepStrictEqual(wifs(wallet), t.keys.map((k) => k.wif).sort(), `${name}: WIFs`);
        assert.deepStrictEqual(lw.expectedAddresses(wallet, "regtest"), t.keys.map((k) => k.addresses[0]).sort(), `${name}: addresses`);
    });
});

test("HD keys are derived at m/0'/c'/i' from the seed (Qtum labels them m/88'/c'/i')", () => {
    ["hd-plain", "hd-encrypted", "hd-imported"].forEach((name) => {
        const t = truth(name);
        const wallet = load(name);
        const byWif = new Map(wallet.keys.map((k) => [qtumkeys.encodeWif(k.secret, 0xef, k.compressed), k]));
        let hdKeys = 0;
        t.keys.forEach((tk) => {
            const k = byWif.get(tk.wif);
            const m = /^m\/88'\/([01])'\/(\d+)'$/.exec(tk.hdkeypath || "");
            if (m) {
                hdKeys++;
                assert.ok(k.derivedFromSeed, `${name}: ${tk.hdkeypath} derived`);
                assert.strictEqual(k.hdPath, `m/0'/${m[1]}'/${m[2]}'`);
            } else {
                assert.ok(!k.derivedFromSeed, `${name}: a key without HD path is imported on its own`);
            }
        });
        assert.ok(hdKeys > 10, `${name}: has HD keys`);
        assert.strictEqual(wallet.derivedMissing, 0, `${name}: every derived key is in the wallet`);
        assert.ok(wallet.hd, `${name}: HD`);
        // getwalletinfo shows the seed id (a uint160) in reversed byte order
        assert.strictEqual(Buffer.from(wallet.hd.seedId, "hex").reverse().toString("hex"), t.hdseedid, `${name}: active seed`);
    });
    // the encrypted wallet changed its seed when it was encrypted: both chains are found
    const enc = load("hd-encrypted");
    assert.strictEqual(enc.seeds.length, 2);
    assert.strictEqual(enc.seeds.filter((s) => s.active).length, 1);
});

test("the master key of the active seed equals dumpwallet's extended private masterkey", () => {
    ["hd-plain", "hd-encrypted", "hd-imported"].forEach((name) => {
        const wallet = load(name);
        const active = wallet.seeds.find((s) => s.active);
        assert.strictEqual(lw.encodeExtendedPrivateKey(active.master, 0x04358394), truth(name).masterKey);
    });
});

test("a non-HD wallet has no seed; all keys are imported one by one", () => {
    const wallet = load("nonhd");
    assert.strictEqual(wallet.hd, null);
    assert.strictEqual(wallet.seeds.length, 0);
    assert.ok(wallet.keys.some((k) => !k.compressed), "has an uncompressed key");
    const descriptors = lw.buildDescriptors(wallet, "regtest");
    assert.strictEqual(descriptors.length, wallet.keys.length);
    descriptors.forEach((d) => assert.match(d.desc, /^combo\([1-9A-HJ-NP-Za-km-z]+\)#[a-z0-9]{8}$/));
});

test("encrypted wallet: right password works, missing or wrong password fails cleanly", () => {
    const records = lw.parseDump(dump("hd-encrypted")).records;
    const t = truth("hd-encrypted");
    assert.ok(lw.readLegacyWallet(records, t.passphrase).encrypted);
    assert.throws(() => lw.readLegacyWallet(records, null), (e) => e instanceof lw.LegacyWalletError && e.code === "needs-passphrase");
    const secrets = t.keys.map((k) => k.wif);
    assert.throws(() => lw.readLegacyWallet(records, `${t.passphrase}x`), (e) => {
        assert.strictEqual(e.code, "wrong-passphrase");
        secrets.forEach((s) => assert.ok(!e.message.includes(s)));
        assert.ok(!e.message.includes(t.passphrase));
        return true;
    });
});

test("a damaged key is refused", () => {
    const records = lw.parseDump(dump("hd-plain")).records;
    const keys = records.get("key");
    const copy = new Map(records);
    const value = Buffer.from(keys[0].value);
    value[12] ^= 0x01; // inside the secret
    copy.set("key", [{ key: keys[0].key, value }].concat(keys.slice(1)));
    assert.throws(() => lw.readLegacyWallet(copy, null), (e) => e.code === "corrupt");
    const short = new Map(records);
    short.set("key", [{ key: keys[0].key, value: keys[0].value.slice(0, 40) }]);
    assert.throws(() => lw.readLegacyWallet(short, null), (e) => e.code === "corrupt");
});

test("a wallet without keys is refused", () => {
    const records = new Map(lw.parseDump(dump("nonhd")).records);
    records.delete("key");
    assert.throws(() => lw.readLegacyWallet(records, null), (e) => e.code === "no-keys");
});

test("descriptor checksums equal getdescriptorinfo of the Qtum v30.2 node", () => {
    NAMES.forEach((name) => {
        const info = JSON.parse(read(name, "descinfo.json"));
        const descriptors = lw.buildDescriptors(load(name), "regtest");
        assert.strictEqual(descriptors.length, info.length);
        descriptors.forEach((d, i) => assert.strictEqual(d.desc.split("#")[1], info[i].checksum, `${name} #${i}`));
    });
    assert.strictEqual(lw.descriptorChecksum("pkh(02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5)"), "8fhd9pwu");
});

test("the rebuilt wallet has exactly the descriptors Qtum's own migratewallet makes", () => {
    // fixtures/v30-check.sh imported buildDescriptors() into a new v30.2
    // wallet (rebuilt.json) and migrated the same legacy wallet (migrated.json)
    const key = (d) => `${d.desc} active=${d.active} internal=${d.internal}`;
    ["hd-plain", "hd-encrypted", "hd-imported"].forEach((name) => {
        const rebuilt = JSON.parse(read(name, "rebuilt.json"));
        const migrated = JSON.parse(read(name, "migrated.json"));
        // same descriptors (same keys, paths and checksums)
        assert.deepStrictEqual(rebuilt.map((d) => stripOrigin(d.desc)).sort(), migrated.map((d) => stripOrigin(d.desc)).sort(), name);
        // same active descriptors for new addresses and change, except P2PK
        // (Ledger only; see legacywallet.js)
        const active = (list) => list.filter((d) => d.active && !/^pk\(/.test(d.desc)).map(key).sort();
        assert.deepStrictEqual(active(rebuilt), active(migrated), `${name}: active`);
        assert.strictEqual(active(rebuilt).length, 8);
    });
    // non-HD: the same combo() per key; both get new descriptors from a new seed
    const combos = (list) => list.filter((d) => /^combo\(/.test(d.desc)).map((d) => stripOrigin(d.desc)).sort();
    assert.deepStrictEqual(combos(JSON.parse(read("nonhd", "rebuilt.json"))), combos(JSON.parse(read("nonhd", "migrated.json"))));
});

test("descriptor ranges cover every used key plus a margin; rescan starts a day before the oldest key", () => {
    const wallet = load("hd-plain");
    const descriptors = lw.buildDescriptors(wallet, "regtest");
    const combos = descriptors.filter((d) => /^combo\(tprv/.test(d.desc));
    assert.strictEqual(combos.length, 2);
    assert.deepStrictEqual(combos[0].range, [0, wallet.hd.externalCount + lw.RANGE_MARGIN]);
    assert.deepStrictEqual(combos[1].range, [0, wallet.hd.internalCount + lw.RANGE_MARGIN]);
    assert.strictEqual(combos[1].internal, true);
    const oldest = Math.min.apply(null, wallet.keys.map((k) => k.createTime));
    descriptors.forEach((d) => assert.strictEqual(d.timestamp, Math.max(1500000000, oldest - 86400)));
    assert.strictEqual(lw.rescanTimestamp({ keys: [{ createTime: 0 }] }), 1500000000);
    assert.strictEqual(lw.rescanTimestamp({ keys: [{ createTime: 1400000000 }] }), 1500000000);
});

test("a key without a creation time makes the rescan start at the beginning", () => {
    const wallet = load("hd-plain");
    const recent = Math.min.apply(null, wallet.keys.map((k) => k.createTime));
    assert.ok(recent > 1600000000);
    assert.strictEqual(lw.rescanTimestamp(wallet), recent - 86400);
    // no key metadata at all for one key (createTime 0), or importprivkey's "unknown" (1)
    [0, 1].forEach((unknown) => {
        const copy = { keys: wallet.keys.map((k, i) => Object.assign({}, k, { createTime: i === 3 ? unknown : k.createTime })) };
        assert.strictEqual(lw.rescanTimestamp(copy), 1500000000);
        lw.buildDescriptors(Object.assign({}, wallet, copy), "regtest").forEach((d) => assert.strictEqual(d.timestamp, 1500000000));
    });
    // a wallet whose keymeta records are gone entirely
    const parsed = lw.parseDump(dump("hd-plain"));
    const records = new Map(parsed.records);
    records.delete("keymeta");
    assert.strictEqual(lw.rescanTimestamp(lw.readLegacyWallet(records, null)), 1500000000);
});

test("mainnet: Q addresses, 0x80 WIF keys, xprv", () => {
    const wallet = load("hd-imported");
    lw.expectedAddresses(wallet, "main").forEach((a) => assert.match(a, /^Q/));
    const descriptors = lw.buildDescriptors(wallet, "main");
    assert.ok(descriptors.some((d) => /^combo\(xprv/.test(d.desc)));
    descriptors.filter((d) => /^combo\([^x]/.test(d.desc)).forEach((d) => {
        const wif = /^combo\(([^)]+)\)/.exec(d.desc)[1];
        assert.strictEqual(qtumkeys.decodeWif(wif).prefix, 0x80);
    });
});

test("labels and unsupported records are reported", () => {
    const t = truth("hd-plain");
    const wallet = load("hd-plain");
    Object.keys(t.labels).forEach((address) => assert.strictEqual(wallet.labels.get(address), t.labels[address].label));
    assert.strictEqual(wallet.purposes.get(Object.keys(t.labels).find((a) => t.labels[a].label === "Exchange")), "send");
    const imported = load("hd-imported");
    assert.strictEqual(imported.unsupported.watchOnly, 1);
    const summary = lw.summary(imported, lw.buildDescriptors(imported, "regtest"));
    assert.strictEqual(summary.keys, imported.keys.length);
    assert.ok(!JSON.stringify(summary).match(/[ck][1-9A-HJ-NP-Za-km-z]{50}/), "no keys in the summary");
});
