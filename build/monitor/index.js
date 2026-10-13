const restify = require("restify");
const corsMiddleware = require("restify-cors-middleware");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { URL } = require("url");
const execFile = require("child_process").execFile;
const supervisord = require('supervisord');
const supervisordclient = supervisord.connect('http://localhost:9001');
const ini = require('ini');

const JsonStore = require("./jsonstore");
const qtumkeys = require("./qtumkeys");
const walletfiles = require("./walletfiles");
const legacywallet = require("./legacywallet");
const logtail = require("./logtail");
const stakingsummary = require("./stakingsummary");

const log = (...args) => console.log("[monitor]", ...args);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

// Settings (shown by /getenv, changed by /setenv)
const dbFile = '/package/data/config.json';
const db = new JsonStore(dbFile, log);
// Internal wallet state (upgrade, restore). Never exposed through /getenv or /setenv.
const walletState = new JsonStore('/package/data/wallet-state.json', log);

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
// Rebuild of a wallet from the copy of the legacy wallet (when the upgrade
// fails): temporary copies and record dumps (removed after every rebuild,
// they hold the keys), and rebuilt wallets that did not pass the checks.
const REBUILD_TMP_DIR = '/package/data/wallet-rebuild-tmp';
const REBUILD_FAILED_DIR = '/package/data/wallet-rebuild-failed';
// The legacy wallet that a rebuilt wallet replaced is kept next to it.
const REPLACED_PREFIX = "legacy-wallet-replaced-";
const REBUILT_PREFIX = "rebuilt-";

// Test-only switches, honoured on regtest only (test/rebuild-e2e.sh):
//   fail-migration  migratewallet fails, as it does for the wallets the rebuild is for
//   drop-one-key    the rebuild leaves one key out, so its checks must fail
//   slow-rebuild    the rebuild waits 60 s after creating the new wallet (to interrupt it)
//   unload-fails    closing the new wallet fails, so it must be parked
//   crash-during-swap  the monitor exits between moving the old wallet aside and
//                   moving the new one in (as on a power cut); the next start must finish
//   crash-during-swap-partial  the same, after moving only the old wallet.dat (not its log files)
const TEST_HOOKS = String(process.env.QTUM_MONITOR_TEST_HOOKS || "").split(",").map((s) => s.trim()).filter(Boolean);

// wallet-state.json keys
const MIGRATION_KEY = "migration";
const NEW_BACKUP_KEY = "newBackupRequired";
const RESTORE_KEY = "restore";
const REBUILD_KEY = "rebuild";
const WALLET_CREATED_KEY = "walletCreatedAt";

// Settings the wizard may change, and their allowed values. The first two end
// up in qtum.conf; changing them restarts Qtum.
const QTUM_CONFIG_KEYS = ["DELEGATION_FEE_PERCENT", "MIN_DELEGATION_AMOUNT"];
const SETTINGS = {
    DELEGATION_FEE_PERCENT: {
        valid: (v) => Number.isInteger(v) && v >= 0 && v <= 100,
        error: "The delegation fee must be a whole number from 0 to 100.",
    },
    MIN_DELEGATION_AMOUNT: {
        valid: (v) => typeof v === "number" && isFinite(v) && v >= 0,
        error: "The minimum delegation amount must be a number of 0 or more.",
    },
    // wizards of package 0.0.13 and older record a downloaded backup this way
    BACKUP_REQUIRED: {
        valid: (v) => v === false,
        error: "This setting cannot be changed here.",
    },
};

console.log("Monitor starting...");

// defaults
const defaults =
{
    "DELEGATION_FEE_PERCENT": 10,
    "MIN_DELEGATION_AMOUNT": 100,
    "BACKUP_REQUIRED": true,
};

class UserError extends Error {
    constructor(message, httpCode = 400) {
        super(message);
        this.httpCode = httpCode;
    }
}

// A wallet problem the wizard explains in its own words (problem = a short code)
class WalletProblem extends Error {
    constructor(message, problem) {
        super(message);
        this.problem = problem;
    }
}

// ---------------------------------------------------------------------------
// Wallet status shown in the wizard
// ---------------------------------------------------------------------------

// state: starting | restarting | migrating | rebuilding | restoring | ready | needs-passphrase | failed | stopped
// problem: wallet-missing | null
let walletStatus = { state: "starting", message: "", problem: null };
let importStatus = null;   // { state: running | done | failed, message }
let restoreResult = null;  // { state: failed, message, at } of the last restore
let rebuildProgress = null; // { step, progress } while a rebuild runs
let busy = null;           // name of the wallet task that is running
let restartRequested = false;

const importRunning = () => !!(importStatus && importStatus.state === "running");

// One fixed line per wallet state that support can search the logs for,
// repeated every hour while the wallet needs attention (it does not stake then).
const NEEDS_ATTENTION = ["failed", "needs-passphrase"];
const logWalletState = () => {
    const problem = walletStatus.problem ? ` problem=${walletStatus.problem}` : "";
    const reason = walletStatus.message ? ` reason=${JSON.stringify(walletStatus.message)}` : "";
    console.log(`QTUM_WALLET_STATE=${walletStatus.state}${problem}${reason}`);
};
setInterval(() => {
    if (NEEDS_ATTENTION.includes(walletStatus.state)) logWalletState();
}, 60 * 60 * 1000);

const setStatus = (state, message = "", problem = null) => {
    walletStatus = { state, message, problem };
    log(`wallet status: ${state}${message ? ` (${message})` : ""}`);
    if (["ready", "stopped"].concat(NEEDS_ATTENTION).includes(state)) logWalletState();
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
            setStatus("failed", err.message, err.problem || null);
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

// An error answer from qtumd (as opposed to a lost or refused connection)
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
// walletName: "name" -> the endpoint of that wallet, /wallet/name
// timeout: 0 -> wait as long as it takes (upgrade, rescan)
const rpc = (method, params = [], opts = {}) => {
    const walletPath = typeof opts.walletName === "string"
        ? `/wallet/${encodeURIComponent(opts.walletName)}`
        : (opts.wallet ? "/wallet/" : "/");
    const timeout = opts.timeout === undefined ? 60000 : opts.timeout;
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: "1.0", id: "monitor", method, params });
        const req = http.request({
            host: "127.0.0.1",
            port: RPC_PORT,
            path: walletPath,
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
            res.on("aborted", () => reject(new Error(`RPC ${method}: the connection was lost`)));
            res.on("error", reject);
        });
        if (timeout > 0) req.setTimeout(timeout, () => req.destroy(new Error(`RPC ${method} timed out`)));
        req.on("error", reject);
        req.end(body);
    });
};

// The chain qtumd runs: "main", "test", "regtest", ...
const chainName = async () => (await rpc("getblockchaininfo", [], { timeout: 15000 })).chain;

// Is a test-only switch on? Only ever on regtest.
const testHook = async (name) => {
    if (TEST_HOOKS.indexOf(name) < 0) return false;
    try {
        return (await chainName()) === "regtest";
    } catch (err) {
        return false;
    }
};

// The words shown to the owner for an error from qtumd or the monitor
const plainMessage = (err) => {
    const message = String((err && err.message) || err);
    const code = err && err.code;
    if (/not loaded|does not exist/i.test(message)) return "Your wallet is not loaded yet. Please wait a moment and try again.";
    if (/walletpassphrase|unlock/i.test(message)) return "Your wallet is locked with a password, so this cannot be done here. Please contact AVADO support.";
    if (/ECONNREFUSED|ECONNRESET|socket hang up|-28|Loading|Verifying|Rescanning/i.test(`${code} ${message}`)) return "The Qtum node is still starting. Please try again in a few minutes.";
    return message;
};

// ---------------------------------------------------------------------------
// qtumd process (supervisord)
// ---------------------------------------------------------------------------

const supervisor = (method, ...args) => new Promise((resolve, reject) => {
    supervisordclient[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
});

const faultText = (err) => String((err && (err.faultString || err.message)) || err);

const qtumProcessInfo = async () => {
    try {
        return await supervisor("getProcessInfo", "qtum");
    } catch (err) {
        return { statename: "UNKNOWN", pid: 0 };
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
        const state = (await qtumProcessInfo()).statename;
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

// The data directory of the chain qtumd runs: the data directory itself on
// mainnet (the package default), its regtest/ sub directory when EXTRA_OPTS
// has -regtest (the tests).
const chainDataDir = () => (/(^|\s)-regtest(=1)?(\s|$)/.test(process.env.EXTRA_OPTS || "")
    ? path.join(QTUM_DATA_PATH, "regtest")
    : QTUM_DATA_PATH);
const walletFile = () => walletfiles.defaultWalletFile(chainDataDir());
const walletSideFiles = (file) => [file, `${file}-journal`, `${file}-wal`, `${file}-shm`];
// Next to the default wallet: the Berkeley DB log files of the legacy wallet,
// and the extra wallets an upgrade creates for watch-only and solvable
// scripts. An upgrade that starts over must be able to create those again.
const upgradeFiles = (dir) => ["database", "db.log", "default_wallet_watchonly", "default_wallet_solvables"].map((name) => path.join(dir, name));

const getMigration = () => walletState.get(MIGRATION_KEY) || null;
const updateMigration = (changes) => {
    const migration = Object.assign({}, getMigration(), changes);
    walletState.set(MIGRATION_KEY, migration);
    return migration;
};

// Is the copy in `migration.backupDir` a copy of the wallet file as it is now?
const backupMatches = (migration, file) => {
    if (!migration || !migration.backupDir || !migration.sha256) return false;
    const copy = path.join(migration.backupDir, "wallet.dat");
    return walletfiles.exists(copy)
        && walletfiles.sha256File(copy) === migration.sha256
        && walletfiles.sha256File(file) === migration.sha256;
};

// Copy the legacy wallet (and its Berkeley DB log files) before anything touches it.
const backupLegacyWallet = (file, label = "legacy-wallet-before-upgrade") => {
    const dir = path.join(BACKUP_DIR, `${walletfiles.timestamp()}-${label}`);
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

// Put the legacy wallet back exactly as it was copied: wallet.dat plus its
// Berkeley DB log files. Whatever is there now is moved aside first (never
// deleted). qtumd must be stopped.
const putLegacyWalletBack = (backupDir, reason) => {
    const file = walletFile();
    const dir = path.dirname(file);
    const aside = path.join(BACKUP_DIR, `${walletfiles.timestamp()}-${reason}`);
    walletSideFiles(file).concat(upgradeFiles(dir)).forEach((f) => walletfiles.moveInto(f, aside));
    walletfiles.copyFileDurable(path.join(backupDir, "wallet.dat"), file);
    if (walletfiles.exists(path.join(backupDir, "database"))) {
        walletfiles.copyDirDurable(path.join(backupDir, "database"), path.join(dir, "database"));
    }
    if (walletfiles.exists(path.join(backupDir, "db.log"))) {
        walletfiles.copyFileDurable(path.join(backupDir, "db.log"), path.join(dir, "db.log"));
    }
    log(`legacy wallet put back from ${backupDir}; what was there before is in ${aside}`);
};

// Put the wallet files that a restore moved to `saveDir` back in place.
const undoRestore = (saveDir) => {
    const file = walletFile();
    const dir = path.dirname(file);
    walletfiles.removeQuietly(`${file}.partial`);
    if (walletfiles.exists(file)) walletfiles.moveInto(file, path.join(BACKUP_DIR, `${walletfiles.timestamp()}-incomplete-restore`));
    walletfiles.listDir(saveDir).forEach((name) => fs.renameSync(path.join(saveDir, name), path.join(dir, name)));
    log(`restore undone; the previous wallet is back in place (from ${saveDir})`);
};

// A restore was interrupted (container stopped while the backup was copied):
// keep the backup when it was copied completely, otherwise put the previous
// wallet back.
const finishInterruptedRestore = () => {
    const restore = walletState.get(RESTORE_KEY);
    if (!restore || restore.state !== "running") return;
    if (walletfiles.walletFileKind(walletFile())) {
        walletState.set(RESTORE_KEY, Object.assign({}, restore, { state: "done", finishedAt: now() }));
        log("the interrupted restore had already put the backup in place");
    } else {
        undoRestore(restore.saveDir);
        walletState.set(RESTORE_KEY, Object.assign({}, restore, { state: "failed", error: "interrupted", finishedAt: now() }));
        restoreResult = { state: "failed", message: "The restore was interrupted.", at: now() };
    }
};

const getRebuild = () => walletState.get(REBUILD_KEY) || null;
const updateRebuild = (changes) => {
    const rebuild = Object.assign({}, getRebuild(), changes);
    walletState.set(REBUILD_KEY, rebuild);
    return rebuild;
};

const REBUILD_INTERRUPTED = "The wallet rebuild was interrupted. The old wallet is untouched; press Rebuild again.";

// Wallet directories a rebuild created and did not finish (qtumd stopped)
const leftoverRebuiltWallets = () => {
    const dir = path.dirname(walletFile());
    return walletfiles.listDir(dir).filter((name) => name.indexOf(REBUILT_PREFIX) === 0).map((name) => path.join(dir, name));
};

// A rebuild was interrupted (container stopped). It is not resumed: the old
// wallet must be in place and the half-made wallet is kept for support. If it
// was interrupted after the new wallet was already in place, it is finished.
// Runs while qtumd is stopped. Returns true when the owner must be told.
const finishInterruptedRebuild = () => {
    // temporary copies of the old wallet and record dumps: ours, they hold keys
    walletfiles.removeTree(REBUILD_TMP_DIR);
    const rebuild = getRebuild();
    if (!rebuild || rebuild.state !== "running") return false;
    const file = walletFile();
    if (rebuild.step === "replacing" && rebuild.result) {
        // Interrupted while the checked new wallet was being put in place:
        // finish the swap when every piece is where it should be.
        const kind = walletfiles.walletFileKind(file);
        const rebuiltReady = !!rebuild.walletName
            && walletfiles.walletFileKind(path.join(path.dirname(file), rebuild.walletName, "wallet.dat")) === "sqlite";
        const keep = rebuild.keepDir;
        let finished = false;
        try {
            if (kind === "sqlite") {
                finished = true; // the new wallet was already in place
            } else if (keep && rebuiltReady && !walletfiles.exists(file)
                && walletfiles.walletFileKind(path.join(keep, "wallet.dat")) === "bdb") {
                // the old wallet was moved aside, maybe without its log files:
                // move whatever is left of it too (moves only what is there)
                moveLegacyAside(keep);
                moveRebuiltIn(rebuild.walletName, keep);
                finished = true;
            } else if (keep && rebuiltReady && kind === "bdb" && walletfiles.sha256File(file) === rebuild.sourceSha256) {
                moveLegacyAside(keep); // nothing was moved yet
                moveRebuiltIn(rebuild.walletName, keep);
                finished = true;
            }
        } catch (err) {
            log("the interrupted wallet rebuild could not be finished:", err.message);
        }
        if (finished) {
            recordRebuildDone(rebuild.result);
            leftoverRebuiltWallets().forEach((d) => walletfiles.moveInto(d, path.join(REBUILD_FAILED_DIR, walletfiles.timestamp())));
            log("the interrupted wallet rebuild was finished: the new wallet is in place");
            return false;
        }
    }
    const migration = getMigration();
    if (walletfiles.walletFileKind(file) !== "bdb" && migration && migration.backupDir
        && walletfiles.walletFileKind(path.join(migration.backupDir, "wallet.dat")) === "bdb") {
        putLegacyWalletBack(migration.backupDir, "interrupted-rebuild");
    }
    leftoverRebuiltWallets().forEach((d) => walletfiles.moveInto(d, path.join(REBUILD_FAILED_DIR, walletfiles.timestamp())));
    updateRebuild({ state: "interrupted", error: REBUILD_INTERRUPTED, finishedAt: now() });
    updateMigration({ state: "failed", error: REBUILD_INTERRUPTED, failedAt: now() });
    log("the previous wallet rebuild was interrupted; the old wallet is in place");
    return true;
};

// Runs while qtumd is stopped (before it starts). Never deletes a wallet file.
const prepareWalletFiles = () => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.mkdirSync(RESTORE_DIR, { recursive: true });
    finishInterruptedRestore();
    const rebuildInterrupted = finishInterruptedRebuild();
    const file = walletFile();
    let migration = getMigration();

    // An upgrade was interrupted (container stopped while migrating):
    // put the legacy wallet back from our copy and upgrade again.
    if (migration && migration.state === "migrating") {
        const copy = migration.backupDir ? path.join(migration.backupDir, "wallet.dat") : null;
        if (copy && walletfiles.walletFileKind(copy) === "bdb") {
            putLegacyWalletBack(migration.backupDir, "interrupted-upgrade");
            log("the previous wallet upgrade was interrupted; it starts again from the saved copy");
            migration = updateMigration({ state: "pending" });
        } else {
            migration = updateMigration({ state: "failed", error: "the previous wallet upgrade was interrupted and no copy of the old wallet was found" });
        }
    }

    const kind = walletfiles.exists(file) ? walletfiles.walletFileKind(file) : null;
    if (kind === "bdb") {
        if (backupMatches(migration, file)) {
            // after an interrupted rebuild, show that (the upgrade is tried again at the next start)
            if (migration.state !== "needs-passphrase" && !rebuildInterrupted) {
                migration = Object.assign({}, migration, { state: "pending" });
            }
        } else {
            const backup = backupLegacyWallet(file);
            migration = { state: "pending", backupDir: backup.dir, sha256: backup.sha256, detectedAt: now() };
        }
        walletState.set(MIGRATION_KEY, migration);
    } else if (migration && ["pending", "failed", "needs-passphrase"].includes(migration.state)) {
        // the legacy wallet was replaced (e.g. a restore) - nothing left to upgrade
        updateMigration({ state: "superseded" });
    }
};

// Is the default wallet loaded, and is it a descriptor (upgraded) wallet?
const descriptorWalletLoaded = async () => {
    try {
        if (!(await rpc("listwallets", [], { timeout: 15000 })).includes("")) return false;
        return (await rpc("getwalletinfo", [], { wallet: true, timeout: 15000 })).descriptors === true;
    } catch (err) {
        return false;
    }
};

// After a failed upgrade the legacy wallet must be in place again (Qtum puts
// it back itself; this is a second safety net). Files are only moved while
// qtumd is stopped.
const ensureLegacyWalletInPlace = async () => {
    const migration = getMigration();
    if (walletfiles.walletFileKind(walletFile()) === "bdb") return;
    if (!migration || !migration.backupDir) return;
    if (walletfiles.walletFileKind(path.join(migration.backupDir, "wallet.dat")) !== "bdb") return;
    await stopQtum();
    putLegacyWalletBack(migration.backupDir, "failed-upgrade");
    await startQtum();
    await waitForRpc();
};

// migratewallet did not answer: the connection to qtumd was lost. Find out
// whether qtumd was stopped or restarted in the middle ("interrupted"),
// finished the upgrade ("done") or reported a failure we did not receive
// ("failed"), before any wallet file is touched.
const afterLostConnection = async (pidBefore) => {
    for (;;) {
        const info = await qtumProcessInfo();
        if (info.pid !== pidBefore) return "interrupted";
        let upgrading = null;
        try {
            const rpcInfo = await rpc("getrpcinfo", [], { timeout: 15000 });
            upgrading = rpcInfo.active_commands.some((c) => c.method === "migratewallet");
        } catch (err) {
            // no answer (yet)
        }
        if (upgrading === false) return (await descriptorWalletLoaded()) ? "done" : "failed";
        await sleep(5000);
    }
};

const recordMigrationDone = (result) => {
    updateMigration({
        state: "done",
        migratedAt: now(),
        error: null,
        qtumBackup: (result && result.backup_path) || null,
        watchonlyWallet: (result && result.watchonly_name) || null,
        solvablesWallet: (result && result.solvables_name) || null,
    });
    walletState.set(NEW_BACKUP_KEY, true);
    log(`wallet upgraded to a descriptor wallet (Qtum's own copy of the old wallet: ${(result && result.backup_path) || "see the wallet directory"})`);
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
    setStatus("migrating");
    updateMigration(Object.assign({ state: "migrating", startedAt: now() }, passphrase ? { encrypted: true } : {}));
    let flushed = false;
    let startedOver = false;
    for (;;) {
        const pidBefore = (await qtumProcessInfo()).pid;
        try {
            if (await testHook("fail-migration")) throw new RpcError("test hook fail-migration: the upgrade was refused", -4);
            const result = await rpc("migratewallet", passphrase ? ["", passphrase] : [""], { timeout: 0 });
            recordMigrationDone(result);
            return true;
        } catch (err) {
            let message = String(err.message);
            log("wallet upgrade failed:", message);
            if (!(err instanceof RpcError)) {
                const outcome = await afterLostConnection(pidBefore);
                log(`connection to Qtum lost during the wallet upgrade; outcome: ${outcome}`);
                if (outcome === "done") {
                    recordMigrationDone(null);
                    return true;
                }
                if (outcome === "interrupted" && !startedOver) {
                    // qtumd was stopped or restarted in the middle of the upgrade
                    startedOver = true;
                    await stopQtum();
                    putLegacyWalletBack(getMigration().backupDir, "interrupted-upgrade");
                    await startQtum();
                    await waitForRpc();
                    continue;
                }
                message = `the connection to the Qtum node was lost during the upgrade (${message})`;
            } else if (await descriptorWalletLoaded()) {
                // never move an upgraded wallet that Qtum has loaded
                recordMigrationDone(null);
                return true;
            }
            await ensureLegacyWalletInPlace();
            if (!flushed && /LSNs are not reset|not completely flushed/i.test(message)) {
                flushed = true;
                if (await flushLegacyWallet()) {
                    // The flushed wallet.dat no longer needs the log files (the
                    // tool removed them). Copy it, so an upgrade interrupted from
                    // now on starts over from this copy.
                    try {
                        const before = getMigration();
                        const backup = backupLegacyWallet(walletFile(), "legacy-wallet-flushed");
                        updateMigration({ backupDir: backup.dir, sha256: backup.sha256, originalBackupDir: before.originalBackupDir || before.backupDir });
                        continue;
                    } catch (copyErr) {
                        message = `could not save a copy of the wallet: ${copyErr.message}`;
                    }
                }
            }
            const needsPassphrase = /passphrase/i.test(message);
            updateMigration(Object.assign({
                state: needsPassphrase ? "needs-passphrase" : "failed",
                error: message,
                failedAt: now(),
            }, needsPassphrase ? { encrypted: true } : {}));
            setStatus(needsPassphrase ? "needs-passphrase" : "failed", message);
            return false;
        }
    }
};

// Why a missing wallet file must not be replaced by a new, empty wallet
// (null on a fresh install).
const notAFreshInstall = () => {
    if (walletState.get(WALLET_CREATED_KEY)) return "a wallet was created on this AVADO before";
    if (getMigration()) return "a wallet was upgraded on this AVADO before";
    if (walletState.get(RESTORE_KEY)) return "a wallet backup was restored on this AVADO before";
    if (db.get("BACKUP_REQUIRED") === false) return "a wallet backup was downloaded before";
    if (walletfiles.listDir(BACKUP_DIR).length > 0) return `copies of a wallet are in ${BACKUP_DIR}`;
    const dir = walletfiles.walletDir(chainDataDir());
    if (walletfiles.listDir(dir).some((name) => /\.legacy\.bak$/.test(name))) return `a copy of an upgraded wallet is in ${dir}`;
    if (walletfiles.listDir(dir).some((name) => name.indexOf(REPLACED_PREFIX) === 0)) return `a copy of a rebuilt wallet's old wallet is in ${dir}`;
    if (walletState.get(REBUILD_KEY)) return "a wallet was rebuilt on this AVADO before";
    return null;
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
        const reason = notAFreshInstall();
        if (reason) {
            // never replace a lost wallet by an empty one without telling anyone
            throw new WalletProblem(`the wallet file ${file} is missing (${reason})`, "wallet-missing");
        }
        log("no wallet yet - creating the default wallet");
        await rpc("createwallet", [""], { timeout: 0 });
        walletState.set(WALLET_CREATED_KEY, now());
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
    let migration = getMigration();
    if (migration && migration.state === "pending") {
        await migrateDefaultWallet(null);
        migration = getMigration();
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
        updateMigration({ state: "failed", error: `could not save a copy of the wallet: ${err.message}`, failedAt: now() });
    }
};

const startupTask = async () => {
    setStatus("starting");
    await stopQtum();
    prepareWalletFilesSafely();
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
// moved to BACKUP_DIR first; a legacy backup is upgraded automatically. If the
// backup cannot be put in place, the current wallet goes back.
const restoreTask = async (upload) => {
    setStatus("restoring");
    restoreResult = null;
    const file = walletFile();
    const saveDir = path.join(BACKUP_DIR, `${walletfiles.timestamp()}-before-restore`);
    await stopQtum();
    let moving = false;
    try {
        walletState.set(RESTORE_KEY, { state: "running", saveDir, startedAt: now() });
        moving = true;
        walletSideFiles(file).forEach((f) => walletfiles.moveInto(f, saveDir));
        walletfiles.copyFileDurable(upload, file);
    } catch (err) {
        log(`the backup could not be put in place: ${err.message}`);
        if (moving) undoRestore(saveDir);
        walletfiles.removeQuietly(upload);
        try {
            walletState.set(RESTORE_KEY, { state: "failed", saveDir, error: err.message, finishedAt: now() });
        } catch (stateErr) {
            log(`could not record the failed restore: ${stateErr.message}`);
        }
        restoreResult = {
            state: "failed",
            message: err.code === "ENOSPC" ? "There is not enough free disk space on your AVADO." : "The backup file could not be copied.",
            at: now(),
        };
        await startQtum();
        await waitForRpc();
        await finishWalletSetup();
        return;
    }
    walletState.set(RESTORE_KEY, { state: "done", saveDir, finishedAt: now() });
    walletfiles.removeQuietly(upload);
    log(`wallet backup restored; the previous wallet was moved to ${saveDir}`);
    prepareWalletFilesSafely();
    await startQtum();
    await waitForRpc();
    await finishWalletSetup();
};

const retryMigrationTask = async (passphrase) => {
    prepareWalletFilesSafely();
    await waitForRpc();
    const migration = getMigration();
    if (migration && ["pending", "failed", "needs-passphrase"].includes(migration.state)) {
        if (!(await migrateDefaultWallet(passphrase))) return;
    }
    await ensureDefaultWalletLoaded();
};

// ---------------------------------------------------------------------------
// Rebuild the wallet from the copy of the legacy wallet, when the upgrade
// (migratewallet) keeps failing: read every key from the copy with the Qtum
// v29.1 wallet tool, create a new descriptor wallet with the same keys, check
// that nothing is missing, and only then put it in place of the legacy wallet
// (which is kept). Nothing is deleted except our temporary copies.
// ---------------------------------------------------------------------------

// A rebuild problem, in words for the owner (never with key material)
class RebuildError extends Error {}

const REBUILD_STATES = ["failed", "needs-passphrase"];

// A rebuild needs a failed upgrade and a legacy wallet in place: it copies
// that wallet first when the saved copy is missing or is not the same file.
const rebuildPossible = (migration) => !!migration && REBUILD_STATES.indexOf(migration.state) >= 0
    && walletfiles.walletFileKind(walletFile()) === "bdb";

// Long base58 or hex strings in an error message could be keys: hide them.
const scrub = logtail.scrub;

const setRebuildStep = (step, progress = null) => {
    const changed = !rebuildProgress || rebuildProgress.step !== step;
    rebuildProgress = { step, progress };
    walletStatus = { state: "rebuilding", message: progress === null ? step : `${step}: ${progress} %`, problem: null };
    if (changed) {
        updateRebuild({ step });
        log(`wallet rebuild: ${step}`);
    }
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What the rebuilt wallet does not have, in words for the owner ("" if nothing)
const notCarriedOver = (unsupported) => {
    const parts = [];
    if (unsupported.watchOnly) parts.push(plural(unsupported.watchOnly, "watch-only address", "watch-only addresses"));
    if (unsupported.scripts) parts.push(plural(unsupported.scripts, "multisig or script address", "multisig or script addresses"));
    if (unsupported.tokens) parts.push(plural(unsupported.tokens, "token", "tokens"));
    if (unsupported.delegations) parts.push(plural(unsupported.delegations, "staking delegation entry", "staking delegation entries"));
    if (unsupported.superStakers) parts.push(plural(unsupported.superStakers, "super staker setting", "super staker settings"));
    return parts.length ? `Not carried over to the new wallet: ${parts.join(", ")}. The old wallet still has them.` : "";
};

// Dump every record of the legacy wallet copy with the Qtum v29.1 wallet
// tool, in a temporary data directory (the tool never sees the real files).
// Resolves to the dump file (inside tmpDir, which only we can read).
const dumpLegacyWallet = (backupDir, tmpDir) => new Promise((resolve, reject) => {
    if (!walletfiles.exists(LEGACY_WALLET_TOOL)) {
        reject(new RebuildError("The tool that reads the old wallet is missing from this package."));
        return;
    }
    fs.mkdirSync(path.join(tmpDir, "wallets"), { recursive: true, mode: 0o700 });
    fs.chmodSync(tmpDir, 0o700);
    walletfiles.copyFileDurable(path.join(backupDir, "wallet.dat"), path.join(tmpDir, "wallets", "wallet.dat"));
    if (walletfiles.exists(path.join(backupDir, "database"))) {
        walletfiles.copyDirDurable(path.join(backupDir, "database"), path.join(tmpDir, "wallets", "database"));
    }
    if (walletfiles.exists(path.join(backupDir, "db.log"))) {
        walletfiles.copyFileDurable(path.join(backupDir, "db.log"), path.join(tmpDir, "wallets", "db.log"));
    }
    const dumpFile = path.join(tmpDir, "wallet.dump");
    execFile(LEGACY_WALLET_TOOL, [`-datadir=${tmpDir}`, "-wallet=", `-dumpfile=${dumpFile}`, "dump"],
        { timeout: 15 * 60 * 1000 }, (err, stdout, stderr) => {
            if (err) {
                log("legacy wallet tool (dump) failed:", scrub(err.message), scrub(String(stderr).slice(0, 500)));
                reject(new RebuildError("The copy of the old wallet could not be read."));
                return;
            }
            try {
                fs.chmodSync(dumpFile, 0o600);
                resolve(dumpFile);
            } catch (readErr) {
                reject(new RebuildError("The copy of the old wallet could not be read."));
            }
        });
});

// Run importdescriptors on the new wallet and show the rescan progress.
const importWithProgress = async (walletName, descriptors) => {
    let finished = false;
    const importing = rpc("importdescriptors", [descriptors], { walletName, timeout: 0 })
        .then((result) => { finished = true; return result; }, (err) => { finished = true; throw err; });
    while (!finished) {
        await Promise.race([importing.catch(() => null), sleep(5000)]);
        if (finished) break;
        try {
            const scanning = (await rpc("getwalletinfo", [], { walletName, timeout: 15000 })).scanning;
            if (scanning && typeof scanning.progress === "number") {
                setRebuildStep("Scanning the blockchain", Math.floor(scanning.progress * 100));
            }
        } catch (err) {
            // busy - try again in 5 seconds
        }
    }
    let result;
    try {
        result = await importing;
    } catch (err) {
        throw new RebuildError(`The keys could not be added to the new wallet (${scrub(plainMessage(err))}).`);
    }
    const failed = (result || []).filter((r) => !r || !r.success);
    if (failed.length || !result || result.length !== descriptors.length) {
        const first = failed[0] && failed[0].error ? scrub(failed[0].error.message) : "no answer";
        throw new RebuildError(`${plural(failed.length || descriptors.length, "key", "keys")} could not be added to the new wallet (${first}).`);
    }
};

// Every check must pass before the new wallet may replace the old one.
const checkRebuiltWallet = async (walletName, wallet, chain, imported, descriptorsBefore, report) => {
    const expected = legacywallet.expectedAddresses(wallet, chain);
    let missing = 0;
    for (const address of expected) {
        const info = await rpc("getaddressinfo", [address], { walletName, timeout: 15000 });
        if (!info.ismine) missing++;
    }
    if (missing) throw new RebuildError(`${plural(missing, "address", "addresses")} of the old wallet ${missing === 1 ? "is" : "are"} missing in the new wallet.`);
    // a damaged file: the keys it names without a usable key record must be
    // there too (HD keys come back from the seed)
    const named = legacywallet.namedOnlyAddresses(wallet, chain);
    let unrecovered = 0;
    for (const address of named) {
        const info = await rpc("getaddressinfo", [address], { walletName, timeout: 15000 });
        if (!info.ismine) unrecovered++;
    }
    report.unrecoveredKeys = unrecovered;
    if (unrecovered) {
        updateRebuild({ result: { report } });
        log(`wallet rebuild: ${unrecovered} of ${named.length} keys named in the damaged wallet are not in the new wallet`);
        throw new RebuildError(`${unrecovered} ${unrecovered === 1 ? "key" : "keys"} of the damaged wallet could not be recovered. Contact AVADO support.`);
    }
    const listed = (await rpc("listdescriptors", [], { walletName, timeout: 15000 })).descriptors.length;
    if (listed !== descriptorsBefore + imported) {
        throw new RebuildError(`The new wallet has ${listed - descriptorsBefore} key sets instead of ${imported}.`);
    }
    const first = legacywallet.firstReceiveAddress(wallet, chain);
    if (wallet.hd) {
        const info = first ? await rpc("getaddressinfo", [first], { walletName, timeout: 15000 }) : {};
        if (!/^m\/0['h]\/0['h]\//.test(info.hdkeypath || "")) throw new RebuildError("The new wallet does not derive the old wallet's addresses.");
    }
    const info = await rpc("getwalletinfo", [], { walletName, timeout: 15000 });
    if (info.descriptors !== true || !(info.keypoolsize >= 1)) throw new RebuildError("The new wallet cannot make new addresses.");
    return expected.length + named.length;
};

// Copy the old wallet's labels (and payee address book) to the new wallet.
const copyLabels = async (walletName, wallet) => {
    let skipped = 0;
    for (const entry of Array.from(wallet.labels.entries())) {
        try {
            await rpc("setlabel", [entry[0], entry[1]], { walletName, timeout: 15000 });
        } catch (err) {
            skipped++;
        }
    }
    if (skipped) log(`wallet rebuild: ${skipped} of ${wallet.labels.size} labels could not be copied`);
    return wallet.labels.size - skipped;
};

// Close the new wallet in qtumd. Tried twice (a wallet that just finished a
// long rescan can be slow to close). True when it is closed.
const unloadRebuiltWallet = async (walletName, simulateFailure) => {
    if (simulateFailure) return false;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            await rpc("unloadwallet", [walletName], { timeout: 60000 });
            return true;
        } catch (err) {
            // -18: not loaded (any more)
            if (err instanceof RpcError && err.code === -18) return true;
            log(`wallet rebuild: closing the new wallet failed (attempt ${attempt}): ${scrub(err.message)}`);
        }
    }
    return false;
};

// The new wallet is not used: close it and keep it for support, out of the
// way. If qtumd does not close it, qtumd is stopped before its files move.
const parkRebuiltWallet = async (walletName, walletDir, simulateUnloadFailure) => {
    const unloaded = await unloadRebuiltWallet(walletName, simulateUnloadFailure);
    const dir = path.join(walletDir, walletName);
    if (!walletfiles.exists(dir)) return;
    if (!unloaded) await stopQtum();
    const parked = walletfiles.moveInto(dir, path.join(REBUILD_FAILED_DIR, walletfiles.timestamp()));
    log(`the rebuilt wallet that was not used is in ${parked}`);
    if (!unloaded) {
        await startQtum();
        await waitForRpc();
    }
};

const REPLACED_README =
    "The Qtum wallet (legacy Berkeley DB format) that was replaced by a wallet rebuilt from the\n" +
    "same keys, because the automatic upgrade to the Qtum v30 wallet format failed.\n" +
    "It can be opened with Qtum Core v29 or older.\n";

// Swap, part 1: move the legacy wallet into the kept directory. qtumd must be stopped.
const moveLegacyAside = (keep) => {
    const file = walletFile();
    const dir = path.dirname(file);
    [file, path.join(dir, "database"), path.join(dir, "db.log"), path.join(dir, ".walletlock")]
        .forEach((f) => walletfiles.moveInto(f, keep));
    fs.writeFileSync(path.join(keep, "README.txt"), REPLACED_README);
    walletfiles.fsyncDir(dir);
};

// Swap, part 2: move the rebuilt wallet to the default wallet's place. qtumd must be stopped.
const moveRebuiltIn = (walletName, keep) => {
    const file = walletFile();
    const dir = path.dirname(file);
    const rebuiltDir = path.join(dir, walletName);
    ["wallet.dat", "wallet.dat-journal"].forEach((name) => {
        const src = path.join(rebuiltDir, name);
        if (!walletfiles.exists(src)) return;
        const dst = path.join(dir, name);
        try {
            fs.renameSync(src, dst);
        } catch (err) {
            walletfiles.copyFileDurable(src, dst);
        }
    });
    walletfiles.fsyncDir(dir);
    if (walletfiles.walletFileKind(file) !== "sqlite") throw new Error("the rebuilt wallet could not be put in place");
    // whatever else is left of the new wallet's directory goes with the old wallet
    if (walletfiles.listDir(rebuiltDir).length) walletfiles.moveInto(rebuiltDir, keep);
    else fs.rmdirSync(rebuiltDir);
    log(`rebuilt wallet put in place; the old wallet is kept in ${keep}`);
};

const recordRebuildDone = (result) => {
    updateMigration(Object.assign({ state: "done", method: "rebuild", error: null }, result));
    updateRebuild({ state: "done", finishedAt: now() });
    walletState.set(NEW_BACKUP_KEY, true);
};

const rebuildWalletTask = async (passphrase) => {
    rebuildProgress = null;
    walletStatus = { state: "rebuilding", message: "Getting ready", problem: null };
    const migration = getMigration();
    if (!rebuildPossible(migration)) {
        throw new RebuildError("There is no failed wallet upgrade to rebuild from.");
    }
    await waitForRpc();
    if (await descriptorWalletLoaded()) {
        log("wallet rebuild: the wallet is already upgraded");
        updateMigration({ state: "done", error: null });
        await ensureDefaultWalletLoaded();
        return;
    }
    if (walletfiles.walletFileKind(walletFile()) !== "bdb") {
        throw new RebuildError("The wallet in use is not the old wallet, so there is nothing to rebuild.");
    }
    // The rebuilt wallet replaces the wallet in place, so it must be made from
    // a copy of exactly that file. When the saved copy is not (e.g. Qtum put
    // the wallet back after a failed upgrade, or another backup was restored),
    // copy the wallet in place now and rebuild from that copy.
    let backupDir = migration.backupDir;
    if (!backupMatches(migration, walletFile())) {
        let backup;
        try {
            backup = backupLegacyWallet(walletFile(), "legacy-wallet-before-rebuild");
        } catch (err) {
            log("wallet rebuild: the wallet in place could not be copied:", err.message);
            throw new RebuildError(err.code === "ENOSPC"
                ? "There is not enough free disk space on your AVADO to copy the wallet."
                : "The wallet in use could not be copied.");
        }
        updateMigration({ backupDir: backup.dir, sha256: backup.sha256, originalBackupDir: migration.originalBackupDir || migration.backupDir || null });
        backupDir = backup.dir;
        log("wallet rebuild: the saved copy is not the wallet in place; the wallet in place was copied and is rebuilt from that copy");
    }
    const sourceSha256 = getMigration().sha256;

    const stamp = walletfiles.timestamp();
    const walletName = `${REBUILT_PREFIX}${stamp}`;
    const walletDir = path.dirname(walletFile());
    const tmpDir = path.join(REBUILD_TMP_DIR, stamp);
    updateRebuild({ state: "running", startedAt: now(), backupDir, walletName, error: null, result: null });

    // 1. read every key of the copy
    setRebuildStep("Reading the old wallet");
    let wallet;
    let parsed;
    try {
        try {
            parsed = await legacywallet.parseDumpFile(await dumpLegacyWallet(backupDir, tmpDir));
        } catch (err) {
            // A damaged file (e.g. cut short) that Berkeley DB refuses: read the
            // pages that are there directly, from the saved copy (read only).
            const toolFailed = err instanceof RebuildError
                || (err instanceof legacywallet.LegacyWalletError && err.code === "bad-dump");
            if (!toolFailed) throw err;
            log("the wallet tool cannot read the old wallet, reading it directly");
            parsed = legacywallet.readWalletFile(path.join(backupDir, "wallet.dat"));
            log(`wallet rebuild: read directly: ${parsed.pages.pagesPresent} pages present, ${parsed.pages.pagesMissing} missing, ${parsed.pages.damagedPages} damaged pages, ${parsed.pages.damagedItems} damaged records`);
        }
        wallet = legacywallet.readLegacyWallet(parsed.records, passphrase, parsed.counts, { damaged: parsed.source === "raw-pages" });
    } catch (err) {
        if (err instanceof legacywallet.LegacyWalletError && err.code === "needs-passphrase") {
            updateRebuild({ state: "needs-passphrase", finishedAt: now() });
            updateMigration({ state: "needs-passphrase", encrypted: true });
            setStatus("needs-passphrase", "Your wallet is protected with a password. Enter it to rebuild the wallet.");
            return;
        }
        if (err instanceof legacywallet.LegacyWalletError) throw new RebuildError(err.message);
        throw err;
    } finally {
        walletfiles.removeTree(tmpDir);
    }
    const chain = await chainName();
    const descriptors = legacywallet.buildDescriptors(wallet, chain);
    const report = legacywallet.summary(wallet, descriptors, parsed);
    log(`wallet rebuild: read from ${report.source}; the old wallet has ${report.keys} keys (${report.hdKeys} from ${report.seeds} HD seeds, ${report.individualKeys} on their own), ${report.labels} labels; record counts ${JSON.stringify(report.counts)}`);
    if (await testHook("drop-one-key")) {
        const i = descriptors.map((d) => !d.range && !d.active).lastIndexOf(true);
        descriptors.splice(i >= 0 ? i : descriptors.length - 1, 1);
        log("wallet rebuild: test hook drop-one-key left one key out");
    }

    // 2. a new wallet under its own name, never the default wallet
    setRebuildStep("Creating the new wallet");
    const secret = wallet.encrypted ? passphrase : "";
    try {
        // blank for an HD wallet (its descriptors come from the old seed); a
        // non-HD wallet gets descriptors from a new seed, like migratewallet does
        await rpc("createwallet", [walletName, false, !!wallet.hd, secret, false, true, false], { timeout: 60000 });
        const descriptorsBefore = (await rpc("listdescriptors", [], { walletName, timeout: 15000 })).descriptors.length;
        if (await testHook("slow-rebuild")) await sleep(60000);
        if (wallet.encrypted) await rpc("walletpassphrase", [secret, 600], { walletName, timeout: 15000 });
        try {
            setRebuildStep(`Importing ${plural(wallet.keys.length, "key", "keys")}`);
            await importWithProgress(walletName, descriptors);
        } finally {
            if (wallet.encrypted) {
                try {
                    await rpc("walletlock", [], { walletName, timeout: 15000 });
                } catch (err) {
                    log("wallet rebuild: could not lock the new wallet:", scrub(err.message));
                }
            }
        }

        // 3. the checks
        setRebuildStep("Checking the result");
        const addresses = await checkRebuiltWallet(walletName, wallet, chain, descriptors.length, descriptorsBefore, report);
        report.labelsCopied = await copyLabels(walletName, wallet);
        report.addressesChecked = addresses;
        log(`wallet rebuild: all ${addresses} addresses of the old wallet are in the new wallet`);
    } catch (err) {
        await parkRebuiltWallet(walletName, walletDir);
        if (err instanceof RebuildError) throw err;
        throw new RebuildError(`The new wallet could not be made (${scrub(plainMessage(err))}).`);
    }

    // 4. put it in place while qtumd is stopped
    setRebuildStep("Putting the new wallet in place");
    // test switches are read now: qtumd does not answer while it is stopped
    const unloadFails = await testHook("unload-fails");
    const crashInSwap = await testHook("crash-during-swap");
    const crashInSwapPartial = await testHook("crash-during-swap-partial");
    if (!(await unloadRebuiltWallet(walletName, unloadFails))) {
        await parkRebuiltWallet(walletName, walletDir, unloadFails);
        throw new RebuildError("The new wallet could not be closed, so it was not used.");
    }
    if (walletfiles.sha256File(walletFile()) !== sourceSha256) {
        await parkRebuiltWallet(walletName, walletDir);
        throw new RebuildError("The wallet in use changed during the rebuild, so the new wallet was not used.");
    }
    const missing = notCarriedOver(wallet.unsupported);
    const result = {
        rebuiltAt: now(),
        keys: wallet.keys.length,
        descriptors: descriptors.length,
        encrypted: wallet.encrypted || !!migration.encrypted,
        report,
        notCarriedOver: missing,
    };
    const keep = path.join(walletDir, `${REPLACED_PREFIX}${stamp}`);
    try {
        await stopQtum();
    } catch (err) {
        await parkRebuiltWallet(walletName, walletDir);
        throw err;
    }
    // from here on a restart finishes the swap (finishInterruptedRebuild)
    updateRebuild({ step: "replacing", result, keepDir: keep, sourceSha256 });
    if (crashInSwapPartial) {
        // only wallet.dat was moved aside, its log files were not
        walletfiles.moveInto(walletFile(), keep);
        log("wallet rebuild: test hook crash-during-swap-partial stops the monitor now");
        process.exit(1);
    }
    moveLegacyAside(keep);
    if (crashInSwap) {
        log("wallet rebuild: test hook crash-during-swap stops the monitor now");
        process.exit(1);
    }
    moveRebuiltIn(walletName, keep);
    recordRebuildDone(result);
    rebuildProgress = null;
    await startQtum();
    await waitForRpc();
    await ensureDefaultWalletLoaded();
    if (missing) log(`wallet rebuild: ${missing}`);
    log("wallet rebuilt from the copy of the old wallet");
};

// A rebuild that failed: the old wallet stays in place; say why.
const runRebuild = async (passphrase) => {
    try {
        await rebuildWalletTask(passphrase);
    } catch (err) {
        rebuildProgress = null;
        const rebuild = getRebuild();
        if (rebuild && rebuild.state === "done") {
            // the new wallet is in place already; only starting Qtum with it failed
            log("Qtum could not be started with the rebuilt wallet:", scrub(err.message));
            setStatus("failed", `Your wallet was rebuilt, but the Qtum node did not start with it (${scrub(plainMessage(err))}). Please restart the Qtum package.`);
            return;
        }
        const message = err instanceof RebuildError
            ? `${err.message} Your old wallet was not changed.`
            : `The wallet could not be rebuilt (${scrub(err.message)}). Your old wallet was not changed.`;
        log(`wallet rebuild failed: ${message}`);
        updateRebuild({ state: "failed", error: message, finishedAt: now() });
        const migration = getMigration();
        if (migration && REBUILD_STATES.indexOf(migration.state) >= 0) updateMigration({ state: "failed", failedAt: now() });
        // qtumd may have been stopped in the last step: make sure it runs and the old wallet is in place
        const info = await qtumProcessInfo();
        if (info.statename !== "RUNNING") {
            try {
                if (walletfiles.walletFileKind(walletFile()) !== "bdb") putLegacyWalletBack(getMigration().backupDir, "failed-rebuild");
                leftoverRebuiltWallets().forEach((d) => walletfiles.moveInto(d, path.join(REBUILD_FAILED_DIR, walletfiles.timestamp())));
                await startQtum();
                await waitForRpc();
            } catch (startErr) {
                log("could not start Qtum after the failed rebuild:", startErr.message);
            }
        }
        setStatus("failed", message);
    }
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
    res.send(500, { error: plainMessage(err) });
};

server.get("/getenv", (req, res) => {
    res.send(200, db.JSON());
});

// Change settings. Only the settings in SETTINGS, with valid values.
server.post("/setenv", async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        res.send(400, { error: "No settings were sent." });
        return;
    }
    for (const key of Object.keys(body)) {
        const setting = SETTINGS[key];
        if (!setting) {
            res.send(400, { error: `${key} cannot be changed.` });
            return;
        }
        if (!setting.valid(body[key])) {
            res.send(400, { error: setting.error });
            return;
        }
    }

    let restartNeeded = false;
    Object.keys(body).forEach((key) => {
        console.log(`${key}=>${body[key]}`);
        if (QTUM_CONFIG_KEYS.includes(key) && db.get(key) !== body[key]) restartNeeded = true;
        db.set(key, body[key]);
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
    const migration = getMigration();
    const rebuild = getRebuild();
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
        problem: walletStatus.problem,
        busy,
        migration: migration ? {
            state: migration.state,
            method: migration.method || "upgrade",
            migratedAt: migration.migratedAt || migration.rebuiltAt || null,
            failedAt: migration.failedAt || null,
            error: migration.error || null,
            encrypted: !!migration.encrypted,
            canRebuild: rebuildPossible(migration),
        } : null,
        rebuild: rebuild ? {
            state: rebuild.state,
            step: rebuildProgress ? rebuildProgress.step : (rebuild.step || null),
            progress: rebuildProgress ? rebuildProgress.progress : null,
            error: rebuild.error || null,
            notCarriedOver: (rebuild.result && rebuild.result.notCarriedOver) || "",
            // "raw-pages": the old wallet file was damaged and read directly
            source: (rebuild.result && rebuild.result.report && rebuild.result.report.source) || null,
            seedRestored: !!(rebuild.result && rebuild.result.report && rebuild.result.report.hd),
        } : null,
        newBackupRequired: walletState.get(NEW_BACKUP_KEY) === true,
        import: importStatus,
        restore: restoreResult,
        scanning,
    });
});

// The user downloaded a wallet backup
server.post("/backupdone", wizardOnly, async (req, res) => {
    walletState.set(NEW_BACKUP_KEY, false);
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
        if (walletStatus.state !== "ready") throw new UserError("Your wallet is not ready yet, so no key can be imported now. Please try again when the message at the top of this page is gone.", 409);
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
                else importStatus = { state: "failed", message: r && r.error ? plainMessage(r.error) : "The key could not be imported." };
            })
            .catch((err) => {
                const message = err instanceof RpcError
                    ? plainMessage(err)
                    : "The import stopped because the Qtum node restarted. Please import the key again.";
                importStatus = { state: "failed", message };
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
        const migration = getMigration();
        if (!migration || !["pending", "failed", "needs-passphrase"].includes(migration.state)) {
            throw new UserError("There is no wallet upgrade to retry.");
        }
        const passphrase = req.body && req.body.passphrase ? String(req.body.passphrase) : null;
        runTask("migrating", () => retryMigrationTask(passphrase));
        // the banner then speaks about the upgrade again, not about a rebuild
        const rebuild = getRebuild();
        if (rebuild && ["needs-passphrase", "failed", "interrupted"].indexOf(rebuild.state) >= 0) updateRebuild({ state: "superseded" });
        res.send(202, { started: true });
    } catch (err) {
        sendError(res, err);
    }
});

// Rebuild the wallet from the copy of the old wallet (when the upgrade keeps
// failing), optionally with the wallet password
server.post("/rebuild", wizardOnly, async (req, res) => {
    try {
        const migration = getMigration();
        if (!rebuildPossible(migration)) {
            throw new UserError("There is no failed wallet upgrade to rebuild from.");
        }
        const passphrase = req.body && req.body.passphrase ? String(req.body.passphrase) : null;
        runTask("rebuilding", () => runRebuild(passphrase));
        res.send(202, { started: true });
    } catch (err) {
        sendError(res, err);
    }
});

// Staking rewards (read only): totals from the wallet's transactions,
// computed at most once a minute. Only for the wizard's own page: the
// amounts are the owner's business.
const stakingSummary = stakingsummary.createStakingSummary({ rpc });
server.get("/staking-summary", wizardOnly, async (req, res) => {
    try {
        res.send(200, await stakingSummary());
    } catch (err) {
        sendError(res, err);
    }
});

// The last lines of the Qtum node's log (read only), with anything that could
// be a key hidden. ?lines=N, 1 to 2000 (default 200).
server.get("/logs", wizardOnly, async (req, res) => {
    try {
        const lines = logtail.readLog(path.join(chainDataDir(), "debug.log"), new URL(req.url, "http://monitor").searchParams.get("lines"));
        res.send(200, { lines });
    } catch (err) {
        sendError(res, err);
    }
});

// Download a backup of the wallet. Same file the wizard used to fetch over
// WAMP: `backupwallet` writes it, it is sent as it is (the wallet file, no
// zip), and the copy is removed at once. The wizard then calls /backupdone,
// as before.
const BACKUP_DOWNLOAD_NAME = () => `qtum-wallet-${new Date().toISOString().slice(0, 10)}.dat`;
server.post("/backup", wizardOnly, async (req, res) => {
    let dir = null;
    try {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "qtum-wallet-download-"));
        const file = path.join(dir, "wallet.backup");
        await rpc("backupwallet", [file], { wallet: true, timeout: 120000 });
        const data = fs.readFileSync(file);
        if (!data.length) throw new Error("the wallet backup is empty");
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${BACKUP_DOWNLOAD_NAME()}"`);
        res.setHeader("Cache-Control", "no-store");
        res.sendRaw(200, data);
        log("wallet backup downloaded");
    } catch (err) {
        log("wallet backup download failed:", scrub(err.message));
        sendError(res, err instanceof RpcError || err instanceof UserError ? err : new Error("The backup could not be made. If the Qtum node is still starting, please try again in a few minutes."));
    } finally {
        if (dir) {
            try {
                fs.readdirSync(dir).forEach((f) => fs.unlinkSync(path.join(dir, f)));
                fs.rmdirSync(dir);
            } catch (cleanupErr) {
                log("could not remove the downloaded backup copy:", cleanupErr.message);
            }
        }
    }
});

// Upload a wallet backup (the file itself, application/octet-stream) to the
// place the wizard used to copy it to over WAMP. /restore then restores it.
const UPLOAD_NAME = "wallet-upload.dat";
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
server.post("/uploadbackup", wizardOnly, async (req, res) => {
    try {
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) throw new UserError("No file was sent. Please choose your wallet backup file again.");
        if (body.length > MAX_UPLOAD_BYTES) throw new UserError("This file is too large to be a Qtum wallet backup.", 413);
        if (busy || importRunning()) throw new UserError(BUSY_MESSAGE, 409);
        fs.mkdirSync(RESTORE_DIR, { recursive: true });
        const target = path.join(RESTORE_DIR, UPLOAD_NAME);
        const tmp = `${target}.${crypto.randomBytes(6).toString("hex")}.part`;
        fs.writeFileSync(tmp, body, { mode: 0o600 });
        fs.renameSync(tmp, target);
        log(`wallet backup uploaded (${body.length} bytes)`);
        res.send(200, { file: UPLOAD_NAME });
    } catch (err) {
        sendError(res, err instanceof UserError ? err : new Error(err.code === "ENOSPC" ? "There is not enough free disk space on your AVADO." : "The file could not be uploaded. Please try again."));
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
