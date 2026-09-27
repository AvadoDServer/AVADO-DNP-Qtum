// A small JSON key/value file (same file format as simple-json-db).
//
// Writes are atomic: the new content goes to a temporary file that is flushed
// to disk and then renamed over the old file, so a power cut or a killed
// container never leaves a half-written file behind. A file that cannot be
// read anyway (e.g. written by an older version) is moved aside and the store
// starts empty, instead of stopping the monitor at every start.

const fs = require("fs");
const path = require("path");

function fsyncPath(p) {
    let fd;
    try {
        fd = fs.openSync(p, "r");
        fs.fsyncSync(fd);
    } catch (e) {
        // best effort (directories cannot be fsynced everywhere)
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

class JsonStore {
    constructor(file, log = console.log) {
        this.file = file;
        this.data = {};
        let text = null;
        try {
            text = fs.readFileSync(file, "utf8");
        } catch (err) {
            if (err.code !== "ENOENT") throw err;
        }
        if (text !== null && text.trim() !== "") {
            try {
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) this.data = parsed;
                else throw new Error("not a JSON object");
            } catch (err) {
                const aside = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
                fs.renameSync(file, aside);
                log(`${file} could not be read (${err.message}); moved it to ${aside} and started with defaults`);
            }
        }
    }

    get(key) {
        return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : undefined;
    }

    set(key, value) {
        this.data[key] = value;
        this.save();
    }

    // a copy of everything
    JSON() {
        return JSON.parse(JSON.stringify(this.data));
    }

    save() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        const fd = fs.openSync(tmp, "w");
        try {
            fs.writeSync(fd, JSON.stringify(this.data, null, 4));
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, this.file);
        fsyncPath(path.dirname(this.file));
    }
}

module.exports = JsonStore;
