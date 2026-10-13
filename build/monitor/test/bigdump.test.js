// A wallet that staked for years has tens of thousands of transaction records:
// its dump can be hundreds of MB. parseDumpFile must read it with little
// memory (only the key records are kept) and find the same keys.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const FIXTURE = path.join(__dirname, "fixtures", "hd-plain.dump");
const TARGET_BYTES = 210 * 1024 * 1024;

// hd-plain's records plus filler "tx" records, with a valid checksum
function writeBigDump(file) {
    const lines = fs.readFileSync(FIXTURE, "utf8").trim().split("\n");
    const records = lines.slice(0, -1); // without the checksum line
    const hasher = crypto.createHash("sha256");
    const fd = fs.openSync(file, "w");
    let buffer = [];
    let buffered = 0;
    let written = 0;
    const put = (line) => {
        const text = `${line}\n`;
        hasher.update(text, "utf8");
        buffer.push(text);
        buffered += text.length;
        if (buffered >= 1024 * 1024) flush();
    };
    const flush = () => {
        fs.writeSync(fd, buffer.join(""));
        written += buffered;
        buffer = [];
        buffered = 0;
    };
    records.slice(0, 2).forEach(put); // header and format
    const value = crypto.randomBytes(2000).toString("hex");
    let filler = 0;
    records.slice(2).forEach((line, i) => {
        put(line);
        // spread the filler between the real records
        while (written + buffered < ((i + 1) / (records.length - 2)) * TARGET_BYTES) {
            put(`02${Buffer.from("tx").toString("hex")}${crypto.randomBytes(32).toString("hex")},${value}`);
            filler++;
        }
    });
    flush();
    fs.writeSync(fd, `checksum,${crypto.createHash("sha256").update(hasher.digest()).digest("hex")}\n`);
    fs.closeSync(fd);
    return filler;
}

// Runs in a child Node with a 256 MB heap; prints a summary of the keys.
const CHILD = `
const lw = require(${JSON.stringify(path.join(__dirname, "..", "legacywallet"))});
const q = require(${JSON.stringify(path.join(__dirname, "..", "qtumkeys"))});
let peak = 0;
const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 20);
lw.parseDumpFile(process.argv[1]).then((parsed) => {
    clearInterval(timer);
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    const wallet = lw.readLegacyWallet(parsed.records, null, parsed.counts);
    const wifs = wallet.keys.map((k) => q.encodeWif(k.secret, 0xef, k.compressed)).sort();
    const digest = require("crypto").createHash("sha256").update(wifs.join(",")).digest("hex");
    console.log(JSON.stringify({ keys: wallet.keys.length, digest, tx: parsed.counts.tx, peakMB: Math.round(peak / 1048576) }));
}, (err) => { console.error(err.code); process.exit(2); });
`;

module.exports = { writeBigDump, CHILD };

test("a dump of more than 200 MB is read within a 256 MB heap, with the same keys", () => {
    const file = path.join(os.tmpdir(), `qtum-bigdump-${process.pid}.dump`);
    try {
        const filler = writeBigDump(file);
        assert.ok(fs.statSync(file).size >= 200 * 1024 * 1024);
        const out = execFileSync(process.execPath, ["--max-old-space-size=256", "-e", CHILD, file], { encoding: "utf8" });
        const result = JSON.parse(out.trim().split("\n").pop());

        const lw = require("../legacywallet");
        const q = require("../qtumkeys");
        const small = lw.parseDump(fs.readFileSync(FIXTURE, "utf8"));
        const wallet = lw.readLegacyWallet(small.records, null, small.counts);
        const wifs = wallet.keys.map((k) => q.encodeWif(k.secret, 0xef, k.compressed)).sort();
        assert.strictEqual(result.keys, wallet.keys.length);
        assert.strictEqual(result.digest, crypto.createHash("sha256").update(wifs.join(",")).digest("hex"));
        assert.strictEqual(result.tx, small.counts.tx + filler);
        assert.ok(result.peakMB < 128, `peak heap ${result.peakMB} MB`);
        console.log(`# ${Math.round(fs.statSync(file).size / 1048576)} MB dump, ${filler} filler tx records, peak heap ${result.peakMB} MB`);
    } finally {
        try { fs.unlinkSync(file); } catch (e) { /* not there */ }
    }
});
