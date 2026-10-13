import React from "react";
import monitor from "../../../util/monitor";
import DownloadBackup from "./DownloadBackup";

// Shows what the package is doing with the wallet (upgrade to the Qtum v30
// wallet format, rebuild from the old copy when the upgrade fails, restore)
// and asks for a fresh backup after an upgrade.
const Comp = ({ rpcClient, session }) => {
    const [status, setStatus] = React.useState(undefined);
    const [passphrase, setPassphrase] = React.useState("");
    const [actionMessage, setActionMessage] = React.useState(undefined);
    const [showDetails, setShowDetails] = React.useState(false);
    const [confirmRebuild, setConfirmRebuild] = React.useState(false);
    const [restoreDismissed, setRestoreDismissed] = React.useState(false);
    const lastRestoreAt = React.useRef(undefined);

    const refresh = React.useCallback(async () => {
        try {
            const response = await monitor.getWalletStatus();
            // show a new restore failure again, even after an earlier one was dismissed
            const restoreAt = response.data.restore && response.data.restore.at;
            if (restoreAt !== lastRestoreAt.current) {
                lastRestoreAt.current = restoreAt;
                setRestoreDismissed(false);
            }
            setStatus(response.data);
        } catch (err) {
            // monitor not reachable yet - keep the last status
        }
    }, []);

    React.useEffect(() => {
        refresh();
        const timer = setInterval(refresh, 5000);
        return () => clearInterval(timer);
    }, [refresh]);

    const retryUpgrade = async (withPassphrase) => {
        setActionMessage(undefined);
        try {
            await monitor.retryWalletUpgrade(withPassphrase ? passphrase : undefined);
            setPassphrase("");
            setActionMessage("Upgrading your wallet...");
            refresh();
        } catch (err) {
            setActionMessage(monitor.errorMessage(err, "The upgrade could not be started. Please try again."));
        }
    };

    const rebuild = async (withPassphrase) => {
        setActionMessage(undefined);
        setConfirmRebuild(false);
        try {
            await monitor.rebuildWallet(withPassphrase ? passphrase : undefined);
            setPassphrase("");
            setActionMessage("Rebuilding your wallet...");
            refresh();
        } catch (err) {
            setActionMessage(monitor.errorMessage(err, "The rebuild could not be started. Please try again."));
        }
    };

    if (!status) return null;

    const restoreFailed = status.restore && status.restore.state === "failed" && !restoreDismissed ? (
        <div className="notification is-warning" style={{ marginTop: 20 }}>
            <p><b>Your backup could not be restored.</b> {status.restore.message} Your wallet was not changed. Please try again.</p>
            <button className="button is-small" style={{ marginTop: 10 }} onClick={() => setRestoreDismissed(true)}>OK</button>
        </div>
    ) : null;

    // a notice, below a restore failure if there was one
    const box = (className, children) => (
        <>
            {restoreFailed}
            <div className={`notification ${className}`} style={{ marginTop: 20 }}>{children}</div>
        </>
    );

    const encrypted = !!(status.migration && status.migration.encrypted);
    // an upgraded wallet with a password stays locked, and a locked wallet does not stake
    const lockedNote = "Because your wallet has a password, it stays locked after the upgrade and does not stake. Please contact AVADO support if you want to stake with it.";

    if (status.state === "migrating") {
        return box("is-info", (
            <p><b>Upgrading your wallet to the new Qtum wallet format.</b> This happens once and takes a few minutes.
                A copy of your old wallet was saved first, so your coins are safe.
                {encrypted ? "" : " Staking starts again by itself when the upgrade is done."}</p>
        ));
    }

    if (status.state === "rebuilding") {
        const step = status.rebuild && status.rebuild.step;
        const progress = status.rebuild && typeof status.rebuild.progress === "number" ? `: ${status.rebuild.progress} %` : "";
        return box("is-info", (
            <>
                <p><b>Rebuilding your wallet from the copy of your old wallet.</b> This can take a few hours.
                    Your old wallet stays on your AVADO, so your coins are safe.
                    {encrypted ? "" : " Staking starts again by itself when it is done."}</p>
                {step && <p style={{ marginTop: 10 }}>{step}{progress}</p>}
            </>
        ));
    }

    if (status.state === "restoring") {
        return box("is-info", (
            <p><b>Restoring your wallet backup.</b> This takes a few minutes. Your previous wallet was saved on your AVADO first.</p>
        ));
    }

    if (status.state === "needs-passphrase") {
        // the password was asked for by a rebuild, not by the upgrade
        const forRebuild = !!(status.rebuild && status.rebuild.state === "needs-passphrase");
        return box("is-warning", (
            <>
                <p><b>Your wallet is protected with a password.</b> Enter it once to {forRebuild ? "rebuild your wallet in" : "finish the upgrade to"} the new Qtum wallet format.
                    Your coins are safe. {lockedNote}</p>
                <div style={{ marginTop: 10 }}>
                    <input type="password" placeholder="Wallet password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
                    <button className="button is-small" style={{ marginLeft: 10 }} disabled={!passphrase}
                        onClick={() => (forRebuild ? rebuild(true) : retryUpgrade(true))}>{forRebuild ? "Rebuild wallet" : "Finish upgrade"}</button>
                </div>
                {actionMessage && <p style={{ marginTop: 10 }}>{actionMessage}</p>}
            </>
        ));
    }

    if (status.state === "failed" && status.problem === "wallet-missing") {
        return box("is-danger", (
            <>
                <p><b>Your wallet file is missing.</b> Your coins are safe: copies of your wallet are kept on your AVADO, and no new,
                    empty wallet was made in its place. Staking is paused. Please contact AVADO support.</p>
                <div style={{ marginTop: 10 }}>
                    <button className="button is-small is-text" onClick={() => setShowDetails(!showDetails)}>{showDetails ? "Hide details" : "Details"}</button>
                </div>
                {showDetails && <p className="is-size-7" style={{ marginTop: 10 }}>{status.message}</p>}
            </>
        ));
    }

    if (status.state === "failed") {
        const upgradeFailed = status.migration && status.migration.state === "failed";
        const canRebuild = upgradeFailed && status.migration.canRebuild !== false;
        const rebuildFailed = upgradeFailed && status.rebuild && ["failed", "interrupted"].includes(status.rebuild.state);
        return box("is-danger", (
            <>
                {rebuildFailed ? (
                    <p><b>Your wallet could not be rebuilt.</b> Your coins are safe: your old wallet was not changed and a copy of it
                        is kept on your AVADO. Staking is paused until your wallet is in the new Qtum wallet format.</p>
                ) : upgradeFailed ? (
                    <p><b>Your wallet could not be upgraded to the new Qtum wallet format.</b> Your coins are safe: a copy of your
                        old wallet is kept on your AVADO. Staking is paused until the upgrade works.</p>
                ) : (
                    <p><b>There is a problem with your Qtum wallet.</b> Your coins are safe. Please try again, or restart the Qtum package.</p>
                )}
                <div style={{ marginTop: 10 }}>
                    {upgradeFailed && <button className="button is-small" onClick={() => retryUpgrade(false)}>Try again</button>}
                    {canRebuild && <button className="button is-small" style={{ marginLeft: 10 }} onClick={() => setConfirmRebuild(true)}>Rebuild the wallet from the old copy</button>}
                    <button className="button is-small is-text" style={{ marginLeft: 10 }} onClick={() => setShowDetails(!showDetails)}>{showDetails ? "Hide details" : "Details"}</button>
                </div>
                {canRebuild && confirmRebuild && (
                    <div className="box" style={{ marginTop: 10 }}>
                        <p>This reads every key from the copy of your old wallet, creates a new wallet in the new format with the same
                            keys, and checks that nothing is missing before it is used. Your old wallet stays on the AVADO. Scanning
                            the blockchain can take a few hours.{" "}
                            {encrypted
                                ? "Your wallet has a password: you are asked for it before the keys are read, and the new wallet stays locked and does not stake, as after the upgrade."
                                : "When it is done, staking starts again by itself. If your wallet has a password, you are asked for it first, and the new wallet then stays locked and does not stake, as after the upgrade."}</p>
                        <div style={{ marginTop: 10 }}>
                            <button className="button is-small is-danger" onClick={() => rebuild(false)}>Rebuild</button>
                            <button className="button is-small" style={{ marginLeft: 10 }} onClick={() => setConfirmRebuild(false)}>Cancel</button>
                        </div>
                    </div>
                )}
                {showDetails && <p className="is-size-7" style={{ marginTop: 10 }}>{status.message}</p>}
                {actionMessage && <p style={{ marginTop: 10 }}>{actionMessage}</p>}
                <p className="is-size-7" style={{ marginTop: 10 }}>If this keeps happening, please contact AVADO support.</p>
            </>
        ));
    }

    if (status.state === "ready" && status.newBackupRequired) {
        const rebuilt = !!(status.migration && status.migration.method === "rebuild");
        const notCarriedOver = rebuilt && status.rebuild && status.rebuild.notCarriedOver;
        return box("is-warning", (
            <>
                <p><b>Your wallet was {rebuilt ? "rebuilt in" : "upgraded to"} the new Qtum wallet format.</b> Please download a fresh backup now and keep it
                    somewhere safe. Backups made before the {rebuilt ? "rebuild" : "upgrade"} do not include the new wallet format.</p>
                {rebuilt && status.rebuild && status.rebuild.source === "raw-pages" && (
                    <p style={{ marginTop: 10 }}>{status.rebuild.seedRestored
                        ? "The old wallet file was damaged; the keys that could be read were carried over and all addresses from its seed were restored."
                        : "The old wallet file was damaged; the keys that could be read were carried over."}</p>
                )}
                {notCarriedOver && <p style={{ marginTop: 10 }}>{notCarriedOver}</p>}
                {encrypted && <p style={{ marginTop: 10 }}>{lockedNote}</p>}
                <div style={{ marginTop: 10 }}>
                    <DownloadBackup rpcClient={rpcClient} session={session} onSuccess={refresh} />
                </div>
            </>
        ));
    }

    return restoreFailed;
};

export default Comp;
