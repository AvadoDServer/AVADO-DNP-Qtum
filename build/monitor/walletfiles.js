// File helpers for the default Qtum wallet (wallet name "").
//
// Legacy wallets are Berkeley DB files, descriptor wallets are SQLite files.
// Both live at <walletdir>/wallet.dat for the default wallet.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Same rule as Qtum Core's GetWalletDir(): <datadir>/wallets if that
// directory exists, otherwise the data directory itself.
function walletDir(dataDir) {
    const sub = path.join(dataDir, "wallets");
    try {
        if (fs.statSync(sub).isDirectory()) return sub;
    } catch (e) {
        // no wallets/ sub directory
    }
    return dataDir;
}

function defaultWalletFile(dataDir) {
    return path.join(walletDir(dataDir), "wallet.dat");
}

// "sqlite" | "bdb" | null (missing, empty or unknown)
function walletFileKind(file) {
    let fd;
    try {
        fd = fs.openSync(file, "r");
        const header = Buffer.alloc(16);
        const read = fs.readSync(fd, header, 0, 16, 0);
        if (read >= 16 && header.toString("latin1", 0, 16) === "SQLite format 3\u0000") return "sqlite";
        // Berkeley DB btree magic 0x00053162 at offset 12, either byte order
        if (read >= 16) {
            const magic = header.slice(12, 16).toString("hex");
            if (magic === "62310500" || magic === "00053162") return "bdb";
        }
        return null;
    } catch (e) {
        return null;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function exists(p) {
    try {
        fs.statSync(p);
        return true;
    } catch (e) {
        return false;
    }
}

function sha256File(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

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

// Copy a file and make sure the bytes reached the disk.
function copyFileDurable(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const tmp = `${to}.partial`;
    fs.copyFileSync(from, tmp);
    fsyncPath(tmp);
    fs.renameSync(tmp, to);
    fsyncPath(path.dirname(to));
}

function copyDirDurable(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name);
        const dst = path.join(to, entry.name);
        if (entry.isDirectory()) copyDirDurable(src, dst);
        else if (entry.isFile()) copyFileDurable(src, dst);
    }
}

// Move a file or directory into a directory (same volume, so a rename).
function moveInto(file, dir) {
    if (!exists(file)) return null;
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, path.basename(file));
    fs.renameSync(file, dst);
    fsyncPath(dir);
    return dst;
}

// Names in a directory ([] when it does not exist).
function listDir(dir) {
    try {
        return fs.readdirSync(dir);
    } catch (e) {
        return [];
    }
}

function removeQuietly(file) {
    try {
        fs.unlinkSync(file);
    } catch (e) {
        // not there
    }
}

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

module.exports = {
    walletDir,
    defaultWalletFile,
    walletFileKind,
    exists,
    sha256File,
    copyFileDurable,
    copyDirDurable,
    moveInto,
    listDir,
    removeQuietly,
    timestamp,
};
