// Cuts a legacy wallet file short, like the damaged wallet the raw page
// reader is for, for test/rebuild-e2e.sh. Regtest keys only.
//
//   node truncate.js <wallet.dat> <name.truth.json> <out wallet.dat> [--break-imported-key]
//
// Keeps the smallest number of pages (at least 60 %) that still holds the HD
// chain record and the seed key, so that every address of the old wallet can
// be restored. Prints { cut, pages, recoverable, all }: the addresses the
// rebuilt wallet must own, and whether that is every address of the old wallet.
const fs = require("fs");
const lw = require("../../legacywallet");
const qtumkeys = require("../../qtumkeys");

const [file, truthFile, out, option] = process.argv.slice(2);
const bdbfile = require("../../bdbfile");
const PAGE = 4096;
const full = fs.readFileSync(file);
const truth = JSON.parse(fs.readFileSync(truthFile, "utf8"));
const pages = full.length / PAGE;
const seedWif = truth.keys.find((k) => k.flags.hdseed !== undefined).wif;

for (let cut = Math.ceil(pages * 0.6); cut < pages; cut++) {
    fs.writeFileSync(out, full.slice(0, cut * PAGE));
    const raw = lw.readWalletFile(out);
    const wallet = lw.readLegacyWallet(raw.records, truth.passphrase, raw.counts, { damaged: true });
    const wifs = wallet.keys.map((k) => qtumkeys.encodeWif(k.secret, 0xef, k.compressed));
    if (!raw.records.has("hdchain") || wifs.indexOf(seedWif) < 0) continue;
    // keys read, plus every HD address derived from the seed within the ranges
    const recoverable = new Set(lw.expectedAddresses(wallet, "regtest"));
    const active = wallet.seeds.find((s) => s.active);
    const ranges = {};
    lw.buildDescriptors(wallet, "regtest").forEach((d) => {
        const m = /^combo\(tprv[^/]+\/0h\/([01])h\/\*h\)/.exec(d.desc);
        if (m && d.range) ranges[m[1]] = Math.max(ranges[m[1]] || 0, d.range[1]);
    });
    truth.keys.forEach((k) => {
        const m = /^m\/88'\/([01])'\/(\d+)'$/.exec(k.hdkeypath || "");
        if (!m || Number(m[2]) > ranges[m[1]]) return;
        let node = active.master;
        [0x80000000, 0x80000000 + Number(m[1]), 0x80000000 + Number(m[2])].forEach((i) => { node = qtumkeys.deriveChild(node, i); });
        const address = lw.p2pkhAddress(qtumkeys.publicKeyFromPrivate(node.key, true), "regtest");
        if (address === k.addresses[0]) recoverable.add(address);
    });
    let all = truth.keys.every((k) => recoverable.has(k.addresses[0]));
    if (option === "--break-imported-key") {
        // damage the key record of an imported key (not derivable from the
        // seed) on the pages left: the file still names that key, so the
        // rebuild must refuse
        const imported = truth.keys.filter((k) => !k.hdkeypath && k.flags.hdseed === undefined).map((k) => qtumkeys.decodeWif(k.wif));
        const pubkeys = imported.map((w) => qtumkeys.publicKeyFromPrivate(w.key, w.compressed).toString("hex"));
        const buf = fs.readFileSync(out);
        let target = null;
        bdbfile.scanRecords(out, (key, value) => {
            if (target || key.slice(1, 4).toString() !== "key" || key[0] !== 3) return;
            const i = pubkeys.indexOf(key.slice(5).toString("hex"));
            if (i < 0) return;
            target = { value: Buffer.from(value), wif: qtumkeys.encodeWif(imported[i].key, 0xef, imported[i].compressed) };
        });
        if (!target) {
            console.error("no imported key record on the pages left");
            process.exit(1);
        }
        // Damage every copy of the record's bytes: a stale copy of the same
        // record can sit in a page's free space before the live one, and
        // damaging only the first match left the live key intact.
        let copies = 0;
        for (let at = buf.indexOf(target.value); at >= 0; at = buf.indexOf(target.value, at + 1)) {
            buf[at + 20] ^= 0x01; // inside the private key
            copies += 1;
        }
        fs.writeFileSync(out, buf);
        // The damaged file must really have lost that key.
        const after = lw.readLegacyWallet(lw.readWalletFile(out).records, truth.passphrase, lw.readWalletFile(out).counts, { damaged: true });
        if (after.keys.some((k) => qtumkeys.encodeWif(k.secret, 0xef, k.compressed) === target.wif)) {
            console.error(`the imported key is still readable after damaging ${copies} copies of its record`);
            process.exit(1);
        }
        all = false;
    }
    console.log(JSON.stringify({ cut, pages, keysRead: wallet.keys.length, recoverable: Array.from(recoverable).sort(), all }));
    process.exit(0);
}
console.error("no cut keeps the HD chain and the seed key");
process.exit(1);
