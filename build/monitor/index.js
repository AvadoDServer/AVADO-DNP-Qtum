const restify = require("restify");
const corsMiddleware = require("restify-cors-middleware");
const fs = require("fs");
const path = require("path");
const http = require("http");
const execFile = require("child_process").execFile;
const supervisord = require('supervisord');
const supervisordclient = supervisord.connect('http://localhost:9001');
const ini = require('ini');

const JSONdb = require('simple-json-db');
const dbFile = '/package/data/config.json';
const db = new JSONdb(dbFile);

const qtumkeys = require("./qtumkeys");
const walletfiles = require("./walletfiles");

const QTUM_CONF_PATH = process.env.QTUM_CONF_PATH || '/package/data/qtum.conf';
const QTUM_DATA_PATH = process.env.QTUM_DATA_PATH || '/package/data/qtum';
const RPC_PORT = parseInt(process.env.QTUM_RPC_PORT || "3889", 10);

// Copies of wallets taken before they are upgraded or replaced.
// Kept on the package volume, outside the Qtum data directory.
const BACKUP_DIR = '/package/data/wallet-backups';
// Wallet backups uploaded from the wizard land here before they are restored.
const RESTORE_DIR = '/package/data/restore';
// Qtum v29.1 wallet tool, only used to flush a legacy (Berkeley DB) wallet
// that was not closed cleanly, so that Qtum v30 can migrate it.
const LEGACY_WALLET_TOOL = '/usr/local/lib/qtum-legacy/qtum-wallet';

// config.json keys
const MIGRATION_KEY = "WALLET_MIGRATION";
const NEW_BACKUP_KEY = "NEW_BACKUP_REQUIRED";
// keys that end up in qtum.conf; changing them restarts Qtum
const QTUM_CONFIG_KEYS = ["DELEGATION_FEE_PERCENT", "MIN_DELEGATION_AMOUNT"];

console.log("Monitor starting...");

// defaults
const defaults =
{
    "DELEGATION_FEE_PERCENT": 10,
    "MIN_DELEGATION_AMOUNT": 100,
    "BACKUP_REQUIRED": true,
};

const log = (...args) => console.log("[monitor]", ...args);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

class UserError extends Error {
    constructor(message, httpCode = 400) {
        super(message);
        this.httpCode = httpCode;
    }
}

// ---------------------------------------------------------------------------
// Wallet status shown in the wizard
// ---------------------------------------------------------------------------

// state: starting | restarting | migrating | restoring | ready | needs-passphrase | failed | stopped
let walletStatus = { state: "starting", message: "" };
let importStatus = null;   // { state: running | done | failed, message }
let busy = null;           // name of the wallet task that is running
let restartRequested = false;

const importRunning = () => !!(importStatus && importStatus.state === "running");

const setStatus = (state, message = "") => {
    walletStatus = { state, message };
    log(`wallet status: ${state}${message ? ` (${message})` : ""}`);
};

const BUSY_MESSAGE = "Your Qtum wallet is busy right now. Please try again in a few minutes.";

// One wallet task at a time (start, restart, upgrade, restore), never during
// a key import. Throws synchronously when the wallet is busy.
const runTask = (name, fn) => {
    if (busy || importRunning()) throw new UserError(BUSY_MESSAGE, 409);
    busy = name;
    return (async () => {
        try {
            return await fn();
        } catch (err) {
            log(`task ${name} failed:`, err.message);
            setStatus("failed", err.message);
        } finally {
            busy = null;
            runRequestedRestart();
        }
    })();
};

const requestRestart = () => {
    if (busy || importRunning()) {
        restartRequested = true;
        return;
    }
    runTask("restarting", restartTask);
};

const runRequestedRestart = () => {
    if (restartRequested && !busy && !importRunning()) {
        restartRequested = false;
        requestRestart();
    }
};

// ---------------------------------------------------------------------------
// Qtum JSON-RPC
// ---------------------------------------------------------------------------

class RpcError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

const rpcCredentials = () => {
    const conf = ini.parse(fs.readFileSync(QTUM_CONF_PATH, 'utf-8'));
    return `${conf.rpcuser}:${conf.rpcpassword}`;
};

// wallet: true -> the default wallet ("") endpoint /wallet/
// timeout: 0 -> wait as long as it takes (upgrade, rescan)
const rpc = (method, params = [], opts = {}) => {
    const wallet = !!opts.wallet;
    const timeout = opts.timeout === undefined ? 60000 : opts.timeout;
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: "1.0", id: "monitor", method, params });
        const req = http.request({
            host: "127.0.0.1",
            port: RPC_PORT,
            path: wallet ? "/wallet/" : "/",
            method: "POST",
            auth: rpcCredentials(),
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        }, (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => {
                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch (e) {
                    reject(new RpcError(`HTTP ${res.statusCode} ${data.slice(0, 200)}`, res.statusCode));
                    return;
                }
                if (parsed.error) reject(new RpcError(parsed.error.message, parsed.error.code));
                else resolve(parsed.result);
            });
        });
        if (timeout > 0) req.setTimeout(timeout, () => req.destroy(new Error(`RPC ${method} timed out`)));
        req.on("error", reject);
        req.end(body);
    });
};

// ---------------------------------------------------------------------------
// qtumd process (supervisord)
// ---------------------------------------------------------------------------

const supervisor = (method, ...args) => new Promise((resolve, reject) => {
    supervisordclient[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
});

const faultText = (err) => String((err && (err.faultString || err.message)) || err);

const qtumProcessState = async () => {
    try {
        const info = await supervisor("getProcessInfo", "qtum");
        return info.statename;
    } catch (err) {
        return "UNKNOWN";
    }
};

const stopQtum = async () => {
    try {
        await supervisor("stopProcess", "qtum");
        log("qtum stopped");
    } catch (err) {
        if (!/NOT_RUNNING/.test(faultText(err))) throw new Error(`could not stop Qtum: ${faultText(err)}`);
    }
};

const startQtum = async () => {
    syncQtumConf();
    try {
        await supervisor("startProcess", "qtum");
        log("qtum started");
    } catch (err) {
        if (!/ALREADY_STARTED/.test(faultText(err))) throw new Error(`could not start Qtum: ${faultText(err)}`);
    }
};

// Wait until qtumd answers RPC calls (after start-up, including wallet loading).
const waitForRpc = async () => {
    for (;;) {
        try {
            await rpc("getblockchaininfo", [], { timeout: 15000 });
            return;
        } catch (err) {
            // -28 = still starting (loading blocks, verifying, loading wallets)
        }
        const state = await qtumProcessState();
        if (["STOPPED", "EXITED", "FATAL"].includes(state)) {
            throw new Error(`the Qtum node is not running (${state})`);
        }
        await sleep(3000);
    }
};

const syncQtumConf = () => {
    const qtumConfigPath = QTUM_CONF_PATH;
    const config = ini.parse(fs.readFileSync(qtumConfigPath, 'utf-8'));
    const envVariablesToQtumConfigVariables = {
        "DELEGATION_FEE_PERCENT": "stakingminfee",
        "MIN_DELEGATION_AMOUNT": "stakingminutxovalue",
    };

    for (const [envVarName, qtumConfigVarName] of Object.entries(envVariablesToQtumConfigVariables)) {
        config[qtumConfigVarName] = db.get(envVarName);
    }

    fs.writeFileSync(qtumConfigPath, ini.stringify(config));
}

// ---------------------------------------------------------------------------
// Default wallet: legacy -> descriptor upgrade (Qtum v30 no longer loads
// legacy Berkeley DB wallets), create, load, restore
// ---------------------------------------------------------------------------

const walletFile = () => walletfiles.defaultWalletFile(QTUM_DATA_PATH);
const walletSideFiles = (file) => [file, `${file}-journal`, `${file}-wal`, `${file}-shm`];

// Is the copy in `migration.backupDir` a copy of the wallet file as it is now?
const backupMatches = (migration, file) => {
    if (!migration || !migration.backupDir || !migration.sha256) return false;
    const copy = path.join(migration.backupDir, "wallet.dat");
    return walletfiles.exists(copy)
        && walletfiles.sha256File(copy) === migration.sha256
        && walletfiles.sha256File(file) === migration.sha256;
};

// Copy the legacy wallet (and its Berkeley DB log files) before anything touches it.
const backupLegacyWallet = (file) => {
    const dir = path.join(BACKUP_DIR, `${walletfiles.timestamp()}-legacy-wallet-before-upgrade`);
    walletfiles.copyFileDurable(file, path.join(dir, "wallet.dat"));
    const wdir = path.dirname(file);
    if (walletfiles.exists(path.join(wdir, "database"))) {
        walletfiles.copyDirDurable(path.join(wdir, "database"), path.join(dir, "database"));
    }
    if (walletfiles.exists(path.join(wdir, "db.log"))) {
        walletfiles.copyFileDurable(path.join(wdir, "db.log"), path.join(dir, "db.log"));
    }
    const sha256 = walletfiles.sha256File(file);
    if (walletfiles.sha256File(path.join(dir, "wallet.dat")) !== sha256) {
        throw new Error("the copy of the wallet does not match the original");
    }
    fs.writeFileSync(path.join(dir, "README.txt"),
        "Copy of the Qtum wallet (legacy Berkeley DB format) taken before it was upgraded to\n" +
        "the descriptor wallet format required by Qtum v30. It can be opened with Qtum Core v29 or\n" +
        "older, or restored in the AVADO Qtum wizard (it is upgraded again automatically).\n");
    log(`legacy wallet copied to ${dir}`);
    return { dir, sha256 };
};

// Runs before qtumd starts (and before a retry). Never deletes a wallet file.
const prepareWalletFiles = () => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.mkdirSync(RESTORE_DIR, { recursive: true });
    const file = walletFile();
    let migration = db.get(MIGRATION_KEY) || null;

    // An upgrade was interrupted (container stopped while migrating):
    // put the legacy wallet back from our copy and upgrade again.
    if (migration && migration.state === "migrating") {
        const copy = migration.backupDir ? path.join(migration.backupDir, "wallet.dat") : null;
        if (copy && walletfiles.walletFileKind(copy) === "bdb") {
            const aside = path.join(BACKUP_DIR, `${walletfiles.timestamp()}-interrupted-upgrade`);
            walletSideFiles(file).forEach((f) => walletfiles.moveInto(f, aside));
            walletfiles.copyFileDurable(copy, file);
            log(`previous wallet upgrade was interrupted; restored the legacy wallet from ${copy}`);
            migration = Object.assign({}, migration, { state: "pending" });
            db.set(MIGRATION_KEY, migration);
        } else {
            migration = Object.assign({}, migration, { state: "failed", error: "the previous wallet upgrade was interrupted and no copy of the old wallet was found" });
            db.set(MIGRATION_KEY, migration);
        }
    }

    const kind = walletfiles.exists(file) ? walletfiles.walletFileKind(file) : null;
    if (kind === "bdb") {
        if (backupMatches(migration, file)) {
            if (migration.state !== "needs-passphrase") {
                migration = Object.assign({}, migration, { state: "pending" });
            }
        } else {
            const backup = backupLegacyWallet(file);
            migration = { state: "pending", backupDir: backup.dir, sha256: backup.sha256, detectedAt: now() };
        }
        db.set(MIGRATION_KEY, migration);
    } else if (migration && ["pending", "failed", "needs-passphrase"].includes(migration.state)) {
        // the legacy wallet was replaced (e.g. a restore) - nothing left to upgrade
        db.set(MIGRATION_KEY, Object.assign({}, migration, { state: "superseded" }));
    }
};

// Make sure the legacy wallet file is in place after a failed migration
// (Qtum restores it itself; this is a second safety net).
const ensureLegacyWalletInPlace = (migration) => {
    const file = walletFile();
    const copy = migration && migration.backupDir ? path.join(migration.backupDir, "wallet.dat") : null;
    if (walletfiles.walletFileKind(file) === "bdb" || !copy || !walletfiles.exists(copy)) return;
    const aside = path.join(BACKUP_DIR, `${walletfiles.timestamp()}-failed-upgrade`);
    walletSideFiles(file).forEach((f) => walletfiles.moveInto(f, aside));
    walletfiles.copyFileDurable(copy, file);
    log(`legacy wallet put back from ${copy}`);
};

// Let the Qtum v29 wallet tool open and close the legacy wallet once. This
// writes everything still in the Berkeley DB log into wallet.dat.
const flushLegacyWallet = () => new Promise((resolve) => {
    if (!walletfiles.exists(LEGACY_WALLET_TOOL)) {
        resolve(false);
        return;
    }
    log("flushing the legacy wallet with the Qtum v29 wallet tool");
    execFile(LEGACY_WALLET_TOOL, [`-datadir=${QTUM_DATA_PATH}`, "-wallet=", "info"], { timeout: 15 * 60 * 1000 }, (err, stdout, stderr) => {
        if (err) log("legacy wallet tool failed:", err.message, String(stderr).slice(0, 500));
        else log("legacy wallet tool finished");
        resolve(!err);
    });
});

// Upgrade the legacy default wallet to a descriptor wallet (qtumd must be running).
const migrateDefaultWallet = async (passphrase) => {
    let migration = db.get(MIGRATION_KEY) || {};
    setStatus("migrating");
    db.set(MIGRATION_KEY, Object.assign({}, migration, { state: "migrating", startedAt: now() }));
    let flushed = false;
    for (;;) {
        try {
            const result = await rpc("migratewallet", passphrase ? ["", passphrase] : [""], { timeout: 0 });
            migration = Object.assign({}, db.get(MIGRATION_KEY), {
                state: "done",
                migratedAt: now(),
                error: null,
                qtumBackup: result.backup_path || null,
                watchonlyWallet: result.watchonly_name || null,
                solvablesWallet: result.solvables_name || null,
            });
            db.set(MIGRATION_KEY, migration);
            db.set(NEW_BACKUP_KEY, true);
            log(`wallet upgraded to a descriptor wallet (Qtum's own copy of the old wallet: ${result.backup_path})`);
            return true;
        } catch (err) {
            const message = String(err.message);
            log("wallet upgrade failed:", message);
            ensureLegacyWalletInPlace(migration);
            if (!flushed && /LSNs are not reset|not completely flushed/i.test(message)) {
                flushed = true;
                if (await flushLegacyWallet()) continue;
            }
            const needsPassphrase = /passphrase/i.test(message);
            db.set(MIGRATION_KEY, Object.assign({}, db.get(MIGRATION_KEY), {
                state: needsPassphrase ? "needs-passphrase" : "failed",
                error: message,
                failedAt: now(),
            }));
            setStatus(needsPassphrase ? "needs-passphrase" : "failed", message);
            return false;
        }
    }
};

// Load (or on a fresh install create) the default wallet.
const ensureDefaultWalletLoaded = async () => {
    const loaded = await rpc("listwallets");
    if (loaded.includes("")) {
        setStatus("ready");
        return;
    }
    const file = walletFile();
    const kind = walletfiles.exists(file) ? walletfiles.walletFileKind(file) : "missing";
    if (kind === "missing") {
        log("no wallet yet - creating the default wallet");
        await rpc("createwallet", [""], { timeout: 0 });
    } else if (kind === "sqlite") {
        log("loading the default wallet");
        await rpc("loadwallet", [""], { timeout: 0 });
    } else {
        // never create a new wallet over a file we cannot read
        throw new Error(`the wallet file ${file} could not be loaded (format: ${kind || "unknown"})`);
    }
    setStatus("ready");
};

const finishWalletSetup = async () => {
    let migration = db.get(MIGRATION_KEY);
    if (migration && migration.state === "pending") {
        await migrateDefaultWallet(null);
        migration = db.get(MIGRATION_KEY);
    }
    if (migration && ["failed", "needs-passphrase"].includes(migration.state)) {
        setStatus(migration.state, migration.error || "");
        return;
    }
    await ensureDefaultWalletLoaded();
};

const prepareWalletFilesSafely = () => {
    try {
        prepareWalletFiles();
    } catch (err) {
        // e.g. no copy of the legacy wallet could be written: do not upgrade it
        log("could not prepare the wallet:", err.message);
        db.set(MIGRATION_KEY, Object.assign({}, db.get(MIGRATION_KEY), { state: "failed", error: `could not save a copy of the wallet: ${err.message}`, failedAt: now() }));
    }
};

const startupTask = async () => {
    setStatus("starting");
    prepareWalletFilesSafely();
    await stopQtum();
    await startQtum();
    await waitForRpc();
    await finishWalletSetup();
};

const restartTask = async () => {
    setStatus("restarting");
    await stopQtum();
    prepareWalletFilesSafely();
    await startQtum();
    await waitForRpc();
    await finishWalletSetup();
};

// Replace the default wallet with an uploaded backup. The current wallet is
// moved to BACKUP_DIR first; a legacy backup is upgraded automatically.
const restoreTask = async (upload) => {
    setStatus("restoring");
    const file = walletFile();
    const saveDir = path.join(BACKUP_DIR, `${walletfiles.timestamp()}-before-restore`);
    await stopQtum();
    walletSideFiles(file).forEach((f) => walletfiles.moveInto(f, saveDir));
    walletfiles.copyFileDurable(upload, file);
    fs.unlinkSync(upload);
    log(`wallet backup restored; the previous wallet was moved to ${saveDir}`);
    prepareWalletFilesSafely();
    await startQtum();
    await waitForRpc();
    await finishWalletSetup();
};

const retryMigrationTask = async (passphrase) => {
    prepareWalletFilesSafely();
    await waitForRpc();
    const migration = db.get(MIGRATION_KEY);
    if (migration && ["pending", "failed", "needs-passphrase"].includes(migration.state)) {
        if (!(await migrateDefaultWallet(passphrase))) return;
    }
    await ensureDefaultWalletLoaded();
};

// ---------------------------------------------------------------------------
// HTTP API (proxied by nginx at http://qtum.my.ava.do/monitor/)
// ---------------------------------------------------------------------------

const server = restify.createServer({
    name: "MONITOR",
    version: "1.0.0"
});

const cors = corsMiddleware({
    preflightMaxAge: 5, //Optional
    origins: [
        /^http:\/\/localhost(:[\d]+)?$/,
        "http://*.dappnode.eth:81",
    ]
});

server.pre(cors.preflight);
server.use(cors.actual);
server.use(restify.plugins.bodyParser());

// Endpoints that handle keys or replace the wallet only answer the wizard:
// other web sites cannot send this header (nginx does not allow it in
// cross-origin requests).
const wizardOnly = (req, res, next) => {
    if (req.header("x-qtum-wizard") !== "1") {
        res.send(403, { error: "forbidden" });
        return next(false);
    }
    return next();
};

const sendError = (res, err) => {
    if (err instanceof UserError) {
        res.send(err.httpCode, { error: err.message });
        return;
    }
    let message = err.message;
    if (/not loaded|does not exist/i.test(message)) message = "Your wallet is not loaded yet. Please wait a moment and try again.";
    else if (/walletpassphrase|unlock/i.test(message)) message = "Your wallet is locked with a password. Unlock it first.";
    else if (/ECONNREFUSED|-28|Loading|Verifying|Rescanning/i.test(`${err.code} ${message}`)) message = "The Qtum node is still starting. Please try again in a few minutes.";
    res.send(500, { error: message });
};

server.get("/getenv", (req, res) => {
    res.send(200, db.JSON());
});

server.post("/setenv", async (req, res) => {
    if (!req.body) {
        res.send(400);
        return;
    }

    let restartNeeded = false;
    Object.keys(req.body).forEach((key) => {
        const displayVal = (key.toString().includes("PRIVATE")) ? "(hidden)" : req.body[key]
        console.log(`${key}=>${displayVal}`);
        if (QTUM_CONFIG_KEYS.includes(key) && db.get(key) !== req.body[key]) restartNeeded = true;
        db.set(key, req.body[key]);
    });

    // only settings that go into qtum.conf need a Qtum restart
    if (restartNeeded) requestRestart();

    res.send(200, db.JSON());
});

server.post("/restartQtum", async (req, res) => {
    requestRestart();
    res.send(200);
});

server.get("/walletstatus", async (req, res) => {
    const migration = db.get(MIGRATION_KEY) || null;
    let scanning = false;
    if (importRunning()) {
        try {
            scanning = (await rpc("getwalletinfo", [], { wallet: true, timeout: 5000 })).scanning;
        } catch (err) {
            scanning = false;
        }
    }
    res.send(200, {
        state: walletStatus.state,
        message: walletStatus.message,
        busy,
        migration: migration ? { state: migration.state, migratedAt: migration.migratedAt || null, error: migration.error || null } : null,
        newBackupRequired: db.get(NEW_BACKUP_KEY) === true,
        import: importStatus,
        scanning,
    });
});

// The user downloaded a wallet backup
server.post("/backupdone", wizardOnly, async (req, res) => {
    db.set(NEW_BACKUP_KEY, false);
    db.set("BACKUP_REQUIRED", false);
    res.send(200, { ok: true });
});

// Show the private key (WIF) of one wallet address - replaces `dumpprivkey`
server.post("/privkey", wizardOnly, async (req, res) => {
    try {
        const address = String((req.body && req.body.address) || "").trim();
        if (!/^[a-zA-Z0-9]{20,100}$/.test(address)) throw new UserError("This is not a Qtum address.");
        const info = await rpc("getaddressinfo", [address], { wallet: true });
        if (!info.ismine) throw new UserError("This address is not part of your wallet.");
        const pubkey = info.pubkey || (info.embedded && info.embedded.pubkey);
        const chain = (await rpc("getblockchaininfo")).chain;
        const descriptors = (await rpc("listdescriptors", [true], { wallet: true })).descriptors;
        const privateKey = qtumkeys.findPrivateKey(descriptors, { pubkey, hdkeypath: info.hdkeypath }, chain);
        if (!privateKey) throw new UserError("The private key for this address could not be found in your wallet.", 404);
        res.send(200, { address, privateKey });
    } catch (err) {
        sendError(res, err);
    }
});

// Import a private key (WIF) - replaces `importprivkey`. The wallet then scans
// the blockchain for the key's coins, which can take a long time; the result
// is reported by /walletstatus.
server.post("/importkey", wizardOnly, async (req, res) => {
    try {
        const privateKey = String((req.body && req.body.privateKey) || "").trim();
        if (!qtumkeys.decodeWif(privateKey)) throw new UserError("This is not a valid Qtum private key. Please check that you copied all of it.");
        if (busy) throw new UserError(BUSY_MESSAGE, 409);
        if (importRunning()) throw new UserError("A private key is being imported already. Please wait until it is finished.", 409);
        let info;
        try {
            info = await rpc("getdescriptorinfo", [`combo(${privateKey})`]);
        } catch (err) {
            throw new UserError("This is not a valid Qtum private key. Please check that you copied all of it.");
        }
        const desc = `combo(${privateKey})#${info.checksum}`;
        importStatus = { state: "running", startedAt: now() };
        log("importing a private key");
        rpc("importdescriptors", [[{ desc, timestamp: 0, label: "" }]], { wallet: true, timeout: 0 })
            .then((result) => {
                const r = result && result[0];
                if (r && r.success) importStatus = { state: "done", finishedAt: now() };
                else importStatus = { state: "failed", message: (r && r.error && r.error.message) || "The key could not be imported." };
            })
            .catch((err) => {
                importStatus = { state: "failed", message: err.message };
            })
            .then(() => {
                log(`private key import ${importStatus.state}${importStatus.message ? `: ${importStatus.message}` : ""}`);
                runRequestedRestart();
            });
        res.send(202, { started: true });
    } catch (err) {
        sendError(res, err);
    }
});

// Restore a wallet backup that the wizard uploaded to RESTORE_DIR
server.post("/restore", wizardOnly, async (req, res) => {
    try {
        const name = path.basename(String((req.body && req.body.file) || ""));
        const upload = path.join(RESTORE_DIR, name);
        if (!name || !walletfiles.exists(upload)) throw new UserError("The uploaded file was not found. Please try again.");
        if (!walletfiles.walletFileKind(upload)) {
            fs.unlinkSync(upload);
            throw new UserError("This file is not a Qtum wallet backup.");
        }
        runTask("restoring", () => restoreTask(upload));
        res.send(202, { started: true });
    } catch (err) {
        sendError(res, err);
    }
});

// Retry the wallet upgrade, optionally with the wallet password
server.post("/migrate", wizardOnly, async (req, res) => {
    try {
        const migration = db.get(MIGRATION_KEY);
        if (!migration || !["pending", "failed", "needs-passphrase"].includes(migration.state)) {
            throw new UserError("There is no wallet upgrade to retry.");
        }
        const passphrase = req.body && req.body.passphrase ? String(req.body.passphrase) : null;
        runTask("migrating", () => retryMigrationTask(passphrase));
        res.send(202, { started: true });
    } catch (err) {
        sendError(res, err);
    }
});

server.get('/*', restify.plugins.serveStaticFiles(`${__dirname}/wizard`, {
    maxAge: 1, // this is in millisecs
    etag: false,
}));

const censor = (config) => {
    // remove sensitive info
    return Object.keys(config).map((key) => {
        let r = {};
        let val = (key === "PRIVATE_KEY" && config.key !== "") ? "***[censored]***" : config[key];
        r[key] = val;
        return (r);
    })
}

const main = async () => {
    // set default values
    Object.keys(defaults).map((key) => {
        const val = defaults[key];
        if (db.get(key) === undefined) {
            db.set(key, val);
        }
    });

    server.listen(3000, function () {
        console.log("%s listening at %s", server.name, server.url);
    });

    // on startup - check if the config is complete & start service if so
    const missingKeys = Object.keys(defaults).reduce((accum, key) => {
        if (db.get(key) === undefined || db.get(key) === "") {
            let r = {};
            r[key] = db.get(key);
            accum.push(r);
        }
        return accum;
    }, []);

    if (missingKeys.length > 0) {
        console.log(`Some keys are missing`);
        console.log(`missing:`);
        console.log(missingKeys);
        console.log(`current config:`);
        console.log(censor(db.JSON()));
        setStatus("stopped", "configuration incomplete");
        return;
    }

    console.log(`A config file exists - attemtping to start service`);
    console.log(censor(db.JSON()));
    runTask("starting", startupTask);
}

main();
