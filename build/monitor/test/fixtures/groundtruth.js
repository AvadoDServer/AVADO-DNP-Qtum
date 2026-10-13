// Turns the `dumpwallet` output of the old Qtum (and make-wallets.sh's
// <name>.info.json) into <name>.truth.json for the tests. Regtest keys only.
//
//   node groundtruth.js <name>.dumpwallet <name>.info.json [passphrase file]
const fs = require("fs");

const [dumpFile, infoFile, passphraseFile] = process.argv.slice(2);
const keys = [];
// "script=1" lines: scripts Qtum derives from the keys (P2SH-P2WPKH), not keys
const scripts = [];
let masterKey = null;
fs.readFileSync(dumpFile, "utf8").split("\n").forEach((line) => {
    const master = /^# extended private masterkey: (\S+)/.exec(line);
    if (master) masterKey = master[1];
    if (!line || line[0] === "#") return;
    const [data, comment = ""] = line.split(" # ");
    const parts = data.split(" ");
    const entry = { wif: parts[0], created: parts[1], flags: {} };
    parts.slice(2).forEach((p) => {
        const eq = p.indexOf("=");
        if (eq < 0) return;
        entry.flags[p.slice(0, eq)] = decodeURIComponent(p.slice(eq + 1));
    });
    const addr = /addr=([^ ]+)/.exec(comment);
    if (addr) entry.addresses = addr[1].split(",");
    const path = /hdkeypath=([^ ]+)/.exec(comment);
    entry.hdkeypath = path ? path[1] : null;
    if (!entry.addresses) return;
    if (entry.flags.script !== undefined) scripts.push({ script: entry.wif, addresses: entry.addresses });
    else keys.push(entry);
});

const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
const labels = {};
Object.keys(info.labels).forEach((label) => {
    Object.keys(info.labels[label]).forEach((address) => {
        labels[address] = { label, purpose: info.labels[label][address].purpose };
    });
});

const truth = {
    note: "Regtest keys made by generate.sh; they hold no real coins.",
    passphrase: passphraseFile ? fs.readFileSync(passphraseFile, "utf8") : null,
    masterKey,
    hdseedid: info.walletinfo.hdseedid || null,
    keypoolsize: info.walletinfo.keypoolsize,
    balances: info.balances.mine,
    labels,
    keys: keys.sort((a, b) => (a.addresses[0] < b.addresses[0] ? -1 : 1)),
    scripts: scripts.length,
};
process.stdout.write(`${JSON.stringify(truth, null, 2)}\n`);
