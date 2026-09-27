import React from "react";
import monitor from "../../../util/monitor";

const Comp = () => {
    const [privKey, setPrivKey] = React.useState("");
    const [message, setMessage] = React.useState(undefined);
    const [importing, setImporting] = React.useState(false);

    // follow a running import (the wallet scans the blockchain for the key's coins)
    React.useEffect(() => {
        if (!importing) return undefined;
        const timer = setInterval(async () => {
            try {
                const status = (await monitor.getWalletStatus()).data;
                const imp = status.import;
                if (!imp || imp.state === "running") {
                    const progress = status.scanning && status.scanning.progress !== undefined
                        ? ` (${Math.round(status.scanning.progress * 100)}% done)` : "";
                    setMessage(`Importing: your wallet is searching the Qtum blockchain for this key's coins${progress}. This can take a few hours. You can close this page; the import continues.`);
                    return;
                }
                setImporting(false);
                setMessage(imp.state === "done"
                    ? "The private key was imported. Please download a fresh wallet backup."
                    : `The private key could not be imported: ${imp.message}`);
            } catch (err) {
                // monitor not reachable - try again on the next tick
            }
        }, 5000);
        return () => clearInterval(timer);
    }, [importing]);

    const importPrivKey = async () => {
        setMessage(undefined);
        try {
            await monitor.importPrivateKey(privKey.trim());
            setPrivKey("");
            setImporting(true);
            setMessage("Importing: your wallet is searching the Qtum blockchain for this key's coins. This can take a few hours. You can close this page; the import continues.");
        } catch (err) {
            setMessage(monitor.errorMessage(err, "The private key could not be imported. Please try again."));
        }
    }

    return (
        <div>
            <input type="password" autoComplete="off" placeholder="Paste the private key.." value={privKey} disabled={importing} onChange={(e) => setPrivKey(e.target.value)} />
            <button onClick={importPrivKey} disabled={importing || !privKey.trim()}>Import</button>
            {message && (<p>{message}</p>)}
        </div>
    );

}


export default Comp;
