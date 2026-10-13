// The last lines of qtumd's debug.log, read from the end of the file (the
// log can be large), for the wizard's Advanced page. Read only.
// Plain Node 12 (no optional chaining, no ??).

const fs = require("fs");

const DEFAULT_LINES = 200;
const MAX_LINES = 2000;
const CHUNK = 64 * 1024;
// never read more than this from the end, however long the lines are
const MAX_BYTES = 4 * 1024 * 1024;

// Long base58 or hex strings could be keys (a WIF private key, an extended
// key, a raw private key): hide them. The monitor uses this for every error
// message and log line it passes on.
const scrub = (message) => String(message)
    .replace(/[1-9A-HJ-NP-Za-km-z]{50,}/g, "[key]")
    .replace(/[0-9a-fA-F]{64,}/g, "[key]");

// The number of lines asked for: a whole number from 1 to MAX_LINES, else the default
const lineCount = (value) => {
    const n = parseInt(String(value === undefined || value === null ? "" : value), 10);
    if (!isFinite(n) || n < 1) return DEFAULT_LINES;
    return Math.min(n, MAX_LINES);
};

// The last `n` lines of `file` ([] when it does not exist)
const tailLines = (file, n, maxBytes) => {
    const limit = maxBytes || MAX_BYTES;
    let fd;
    try {
        fd = fs.openSync(file, "r");
    } catch (err) {
        if (err.code === "ENOENT") return [];
        throw err;
    }
    try {
        const size = fs.fstatSync(fd).size;
        let pos = size;
        let text = "";
        let newlines = 0;
        while (pos > 0 && newlines <= n && size - pos < limit) {
            const len = Math.min(CHUNK, pos, limit - (size - pos));
            pos -= len;
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, pos);
            const chunk = buf.toString("utf8");
            text = chunk + text;
            for (let i = 0; i < chunk.length; i++) if (chunk.charCodeAt(i) === 10) newlines += 1;
        }
        const lines = text.split("\n");
        if (lines.length && lines[lines.length - 1] === "") lines.pop();
        // a line cut off at the start of what was read is left out
        if (pos > 0 && lines.length > 0) lines.shift();
        return lines.slice(-n);
    } finally {
        fs.closeSync(fd);
    }
};

// The last lines, each passed through `scrub` (hides anything that could be a key)
const readLog = (file, lines) => tailLines(file, lineCount(lines)).map((line) => scrub(line));

module.exports = { scrub, lineCount, tailLines, readLog, DEFAULT_LINES, MAX_LINES };
