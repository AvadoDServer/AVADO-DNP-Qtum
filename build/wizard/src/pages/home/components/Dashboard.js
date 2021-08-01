import React from "react";
import QtumInfo from "./QtumInfo";
import autobahn from "autobahn-browser";
import DownloadBackup from "./DownloadBackup";
import RestoreBackup from "./RestoreBackup";
import ImportPrivKey from "./ImportPrivKey";
import { RequestManager, HTTPTransport, Client } from "@open-rpc/client-js";
import "./Dashboard.css";
import monitor from "../../../util/monitor";

const url = "ws://my.wamp.dnp.dappnode.eth:8080/ws";
const realm = "dappnode_admin";


const Comp = () => {
    const [wampSession, setWampSession] = React.useState();
    const [tab, setTab] = React.useState("backup");
    const [backupRequired, setBackupRequired] = React.useState(undefined);
    const [backupRequiredClockTick, setBackupRequiredClockTick] = React.useState(0);

    const rpcClient = new Client(new RequestManager([new HTTPTransport("http://qtum.avadopackage.com/rpc")]));

    React.useEffect(() => {
        const timer = setInterval(() => {
            setBackupRequiredClockTick(c => c + 1);
        }, 1000 * 10);
        return (() => {
            clearInterval(timer);
        });
    }, []);

    React.useEffect(() => {
        const connection = new autobahn.Connection({
            url,
            realm
        });

        connection.onopen = session => {
            console.log("CONNECTED to \nurl: " + url + " \nrealm: " + realm);

            setWampSession(session);

        };

        // connection closed, lost or unable to connect
        connection.onclose = (reason, details) => {
            this.setState({ connectedToDAppNode: false });
            console.error("CONNECTION_CLOSE", { reason, details });
        };

        connection.open();
    }, []);

    React.useEffect(() => {
        const checkIfBackupRequired = async () => {
            const response = await monitor.getEnv();
            const backupRequired = response.data.BACKUP_REQUIRED;
            // we need to create an address when BACKUP_REQUIRED true as it means package is recently installed
            if (backupRequired) {
                await rpcClient.request({ method: 'getnewaddress', params: ['', 'legacy'] });
            }
            setBackupRequired(response.data.BACKUP_REQUIRED);
        }

        // We dont need to fetch anything because wallet is already backupped..
        if (backupRequired === false) {
            return;
        }

        checkIfBackupRequired();
    }, [backupRequiredClockTick]);

    const renderBackup = () => {
        return (
            <>
                <p className="is-size-5 has-text-white">First, you need to backup your wallet..</p>
                <br />
                <DownloadBackup rpcClient={rpcClient} session={wampSession} onSuccess={async () => {
                    await monitor.setEnv({
                        BACKUP_REQUIRED: false,
                    });
                    setBackupRequired(false);
                }} />
            </>
        )
    }

    const renderInfo = () => {
        return (
            <>
                <div className="setting">
                    <QtumInfo rpcClient={rpcClient} />
                    <a href="http://my.avado/#/Packages/qtum.avado.dnp.dappnode.eth/detail" target="_blank">show node logs</a>
                    <br />
                    <br />
                    <a href="https://qtum.avadopackage.com/" className="button" target="_blank">Open Wallet UI</a>
                </div>

                <div className="setting">

                    <section className="is-medium has-text-white">

                        <div class="columns">
                            <div class="column is-half">

                                <nav class="panel is-half">
                                    <p class="panel-heading">Backup and Restore</p>

                                    <p class="panel-tabs">
                                        <a className={`${tab === "backup" ? "is-active  has-text-weight-bold" : ""} has-text-white`} onClick={() => { setTab("backup") }} >Backup</a>
                                        <a className={`${tab === "restore" ? "is-active has-text-weight-bold" : ""} has-text-white`} onClick={() => { setTab("restore") }} >Restore</a>
                                        <a className={`${tab === "import-privkey" ? "is-active has-text-weight-bold" : ""} has-text-white`} onClick={() => { setTab("import-privkey") }} >Import Private Key</a>
                                    </p>
                                    <div class="panel-block">

                                        {tab === "backup" && (
                                            <section className="is-medium has-text-white">
                                                <p className="">You can download your wallet backup. This is very important when you stake Qtum since wallet holds the private keys.</p>
                                                <DownloadBackup rpcClient={rpcClient} session={wampSession} />
                                            </section>
                                        )}
                                        {tab === "restore" && (
                                            <section className="is-medium has-text-white">
                                                <p className="">Here you can upload your wallet backup. If you want to restore your wallet from a previous installation.</p>
                                                <RestoreBackup session={wampSession} />
                                            </section>
                                        )}
                                        {tab === "import-privkey" && (
                                            <section className="is-medium has-text-white">
                                                <p className="">Here you can import a private key. Do not forget to backup your wallet after importing.</p>
                                                <ImportPrivKey rpcClient={rpcClient} />
                                            </section>
                                        )}
                                    </div>
                                </nav>
                            </div>
                        </div>
                    </section>
                </div>
            </>
        )
    }

    return (
        <div className="dashboard">
            <section className="is-medium has-text-white">
                <div className="columns is-mobile">
                    <div className="column is-8-desktop is-10">
                        <h1 className="title is-1 is-spaced has-text-white">Qtum node</h1>
                    </div>
                </div>
                <p className="">A node and wallet for interacting with the Qtum network</p>
            </section>
            <br />
            {backupRequired === undefined ? <p className="has-text-white">loading..</p> : backupRequired ? renderBackup() : renderInfo()}
        </div>
    )


    return null;
};

export default Comp;