// Prints the `importdescriptors` request (JSON) that the rebuild makes for a
// fixture dump. Used by generate.sh. Regtest keys only.
//
//   node descriptors.js <name>.dump [passphrase file]
const fs = require("fs");
const lw = require("../../legacywallet");

const [dumpFile, passphraseFile] = process.argv.slice(2);
const passphrase = passphraseFile ? fs.readFileSync(passphraseFile, "utf8") : null;
const parsed = lw.parseDump(fs.readFileSync(dumpFile, "utf8"));
const wallet = lw.readLegacyWallet(parsed.records, passphrase, parsed.counts);
process.stdout.write(JSON.stringify(lw.buildDescriptors(wallet, "regtest")));
