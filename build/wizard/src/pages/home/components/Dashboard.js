import React from "react";
import QtumInfo from "./QtumInfo";
import autobahn from "autobahn-browser";
import DownloadBackup from "./DownloadBackup";
import RestoreBackup from "./RestoreBackup";
import "./Dashboard.css";

const url = "ws://my.wamp.dnp.dappnode.eth:8080/ws";
const realm = "dappnode_admin";


const Comp = () => {
    const [walletEnabled, setWalletEnabled] = React.useState(false);
    const [wampSession, setWampSession] = React.useState();
    const [nodeId, setNodeId] = React.useState();
    const [tab, setTab] = React.useState("backup");

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
            <div className="setting">
                <QtumInfo
                    onNodeIdAvailable={setNodeId}
                    onNodeReady={(isReady) => {
                        setWalletEnabled(isReady);
                    }} />
                <a href="http://my.avado/#/Packages/qtum.avado.dnp.dappnode.eth/detail" target="_blank">show node logs</a>
                <br />
                <br />
                <a disabled={!walletEnabled} href="https://qtum.avadopackage.com/" className="button" target="_blank">Open Wallet UI</a>
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
                                </p>
                                <div class="panel-block">

                                    {tab === "backup" && (
                                        <section className="is-medium has-text-white">
                                            <p className="">You can download your node identity keys. this is very important when you stake AVAX since the nodeID is part of your stake.</p>
                                            <DownloadBackup fileprefix={nodeId} session={wampSession} />
                                        </section>
                                    )}
                                    {tab === "restore" && (
                                        <section className="is-medium has-text-white">
                                            <p className="">Here you can upload your node identity keys. If you want to restore your node ID from a previous installation.</p>
                                            <RestoreBackup session={wampSession} />
                                        </section>
                                    )}
                                </div>
                            </nav>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    )


    return null;
};

export default Comp;