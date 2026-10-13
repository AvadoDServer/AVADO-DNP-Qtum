// Cuts a legacy wallet file short, like the damaged wallet the raw page
// reader is for, for test/rebuild-e2e.sh. Regtest keys only.
//
//   node truncate.js <wallet.dat> <name.truth.json> <out wallet.dat>
//
// Keeps the smallest number of pages (at least 60 %) that still holds the HD
// chain record and the seed key, so that every address of the old wallet can
// be restored. Prints { cut, pages, recoverable, all }: the addresses the
// rebuilt wallet must own, and whether that is every address of the old wallet.
const fs = require("fs");
const lw = require("../../legacywallet");
const qtumkeys = require("../../qtumkeys");

const [file, truthFile, out] = process.argv.slice(2);
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
    const all = truth.keys.every((k) => recoverable.has(k.addresses[0]));
    console.log(JSON.stringify({ cut, pages, keysRead: wallet.keys.length, recoverable: Array.from(recoverable).sort(), all }));
    process.exit(0);
}
console.error("no cut keeps the HD chain and the seed key");
process.exit(1);
