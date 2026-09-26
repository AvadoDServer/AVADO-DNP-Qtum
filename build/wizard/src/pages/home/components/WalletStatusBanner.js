import React from "react";
import monitor from "../../../util/monitor";
import DownloadBackup from "./DownloadBackup";

// Shows what the package is doing with the wallet (upgrade to the Qtum v30
// wallet format, restore) and asks for a fresh backup after an upgrade.
const Comp = ({ rpcClient, session }) => {
    const [status, setStatus] = React.useState(undefined);
    const [passphrase, setPassphrase] = React.useState("");
    const [actionMessage, setActionMessage] = React.useState(undefined);
    const [showDetails, setShowDetails] = React.useState(false);

    const refresh = React.useCallback(async () => {
        try {
            const response = await monitor.getWalletStatus();
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

    if (!status) return null;

    const box = (className, children) => (
        <div className={`notification ${className}`} style={{ marginTop: 20 }}>{children}</div>
    );

    if (status.state === "migrating") {
        return box("is-info", (
            <p><b>Upgrading your wallet to the new Qtum wallet format.</b> This happens once and takes a few minutes.
                A copy of your old wallet was saved first, so your coins are safe. Staking starts again by itself when the upgrade is done.</p>
        ));
    }

    if (status.state === "restoring") {
        return box("is-info", (
            <p><b>Restoring your wallet backup.</b> This takes a few minutes. Your previous wallet was saved on your AVADO first.</p>
        ));
    }

    if (status.state === "needs-passphrase") {
        return box("is-warning", (
            <>
                <p><b>Your wallet is protected with a password.</b> Enter it once to finish the upgrade to the new Qtum wallet format.
                    Staking is paused until then. Your coins are safe.</p>
                <div style={{ marginTop: 10 }}>
                    <input type="password" placeholder="Wallet password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
                    <button className="button is-small" style={{ marginLeft: 10 }} disabled={!passphrase} onClick={() => retryUpgrade(true)}>Finish upgrade</button>
                </div>
                {actionMessage && <p style={{ marginTop: 10 }}>{actionMessage}</p>}
            </>
        ));
    }

    if (status.state === "failed") {
        const upgradeFailed = status.migration && status.migration.state === "failed";
        return box("is-danger", (
            <>
                {upgradeFailed ? (
                    <p><b>Your wallet could not be upgraded to the new Qtum wallet format.</b> Your coins are safe: a copy of your
                        old wallet is kept on your AVADO. Staking is paused until the upgrade works.</p>
                ) : (
                    <p><b>There is a problem with your Qtum wallet.</b> Your coins are safe. Please try again, or restart the Qtum package.</p>
                )}
                <div style={{ marginTop: 10 }}>
                    {upgradeFailed && <button className="button is-small" onClick={() => retryUpgrade(false)}>Try again</button>}
                    <button className="button is-small is-text" style={{ marginLeft: 10 }} onClick={() => setShowDetails(!showDetails)}>{showDetails ? "Hide details" : "Details"}</button>
                </div>
                {showDetails && <p className="is-size-7" style={{ marginTop: 10 }}>{status.message}</p>}
                {actionMessage && <p style={{ marginTop: 10 }}>{actionMessage}</p>}
                <p className="is-size-7" style={{ marginTop: 10 }}>If this keeps happening, please contact AVADO support.</p>
            </>
        ));
    }

    if (status.state === "ready" && status.newBackupRequired) {
        return box("is-warning", (
            <>
                <p><b>Your wallet was upgraded to the new Qtum wallet format.</b> Please download a fresh backup now and keep it
                    somewhere safe. Backups made before the upgrade do not include the new wallet format.</p>
                <div style={{ marginTop: 10 }}>
                    <DownloadBackup rpcClient={rpcClient} session={session} onSuccess={refresh} />
                </div>
            </>
        ));
    }

    return null;
};

export default Comp;
