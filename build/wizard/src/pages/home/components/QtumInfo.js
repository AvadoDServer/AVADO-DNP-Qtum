import React from "react";
import "./QtumInfo.css";
import spinner from "../../../assets/spinner.svg";
import checkmark from "../../../assets/green-checkmark-line.svg";
import { RequestManager, HTTPTransport, Client } from "@open-rpc/client-js";


const Comp = ({ onNodeReady, onNodeIdAvailable }) => {

    const [nodePeers, setNodePeers] = React.useState();
    const [stakingEnabled, setStakingEnabled] = React.useState(undefined);
    const [stakeWeight, setStakeWeight] = React.useState(undefined);
    const [expectedRewardTime, setExpectedRewardTime] = React.useState(undefined);
    const [isSynced, setIsSycned] = React.useState(undefined);
    const [clockTick, setClockTick] = React.useState(0);
    const [walletReady, setWalletReady] = React.useState(false);

    React.useEffect(() => {
        const timer = setInterval(() => {
            setClockTick(c => c + 1);
        }, 1000 * 15);
        return (() => {
            console.log("Clean up timer");
            clearInterval(timer);
        });
    }, []);

    React.useEffect(() => {
        const rpc = new Client(new RequestManager([new HTTPTransport("http://localhost/rpc")]));
        const fetchInfo = async () => {
            const walletInfo = await rpc.request({ method: 'getwalletinfo' });
            const blockchainInfo = await rpc.request({ method: 'getblockchaininfo' });
            const stakingInfo = await rpc.request({ method: 'getstakinginfo' });
            const peers = await rpc.request({ method: 'getconnectioncount' });

            console.log(walletInfo);
            console.log(stakingInfo);
            setStakingEnabled(stakingInfo.staking);
            setExpectedRewardTime(stakingInfo.expectedtime);
            setStakeWeight(stakingInfo.weight);
            setNodePeers(peers);
            setIsSycned(blockchainInfo.blocks == blockchainInfo.headers);
        }
        fetchInfo();

        // let myNetworkID = 1; //default is 3, we want to override that for our local network
        // let myBlockchainID = "X"; // The X-Chain blockchainID on this network
        // let ava = new Avalanche(endpoint.host, endpoint.port, endpoint.protocol, myNetworkID, myBlockchainID);

        // let info = ava.Info();
        // info.getNodeID().then((res) => {
        //     setNodeID(res);
        //     onNodeIdAvailable && onNodeIdAvailable(res);
        // }).catch((e) => {
        //     setNodeID(`Unknown:` + e.message);
        // })
        // info.isBootstrapped(myBlockchainID).then((res) => {
        //     // debugger;
        //     setIsBootstrapped(res);
        // })
        // info.peers().then((res) => {
        //     // debugger;
        //     setNodePeers(res.length);
        // })

    }, [clockTick]);


    React.useEffect(() => {
        if (isSynced && nodePeers >= 10) {
            setWalletReady(true);
            onNodeReady && onNodeReady(true);
        } else {
            setWalletReady(false);
        }
    }, [isSynced, nodePeers])

    // if (!node) {
    //     return (<div>Loading...</div>);
    // }

    return (
        <>
            <h3 className="is-size-3 has-text-white">Node status</h3>

            <section className="is-medium has-text-white">

                <table className="table-profile">
                    <tbody><tr>
                        <th colSpan="1"></th>
                        <th colSpan="2"></th>
                    </tr>
                        <tr>
                            <td>staking enabled</td>
                            <td>{stakingEnabled === undefined ? "..loading" : stakingEnabled === false ? "no" : "yes"}</td>
                        </tr>
                        <tr>
                            <td>stake weight</td>
                            <td>{stakeWeight || "..loading"}</td>
                        </tr>
                        <tr>
                            <td>expected reward time</td>
                            <td>{stakingEnabled === undefined ? "..loading" : expectedRewardTime === 0 ? "never" : expectedRewardTime}</td>
                        </tr>
                        <tr>
                            <td>connected peers</td>
                            <td>{nodePeers || "..loading"}</td>
                        </tr>
                        <tr>
                            <td>is synced</td>
                            <td>{isSynced === undefined ? "..loading" : isSynced === false ? "no" : "yes"}</td>
                        </tr>
                    </tbody></table>

                {!walletReady ? (
                    <div className="level">
                        <div className="level-left">
                            <span class="icon is-medium ">
                                <img alt="spinner" src={spinner} />
                            </span>
                            <p className="has-text-white is-size-5 has-text-weight-bold">Waiting for Qtum node to finish bootstrapping & syncing</p>
                        </div>
                    </div>
                ) : (
                    <div className="level">
                        <div className="level-left">
                            <img className="icon is-medium" alt="checkmark" src={checkmark} />
                            <p className="has-text-white is-size-5 has-text-weight-bold">Qtum node is ready</p>
                        </div>
                    </div>
                )
                }
            </section>
        </>);

};

export default Comp;