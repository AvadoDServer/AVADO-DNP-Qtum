import React from "react";
import "./QtumInfo.css";
import spinner from "../../../assets/spinner.svg";
import checkmark from "../../../assets/green-checkmark-line.svg";
import { RequestManager, HTTPTransport, Client } from "@open-rpc/client-js";


const Comp = ({ rpcClient, onNodeReady, onNodeIdAvailable }) => {

    const [address, setAddress] = React.useState(undefined);
    const [balance, setBalance] = React.useState(undefined);
    const [isStaking, setIsStaking] = React.useState(undefined);
    const [nodePeers, setNodePeers] = React.useState();
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
        const createAddress = async () => {
            return await rpcClient.request({ method: 'getnewaddress', params: ['', 'legacy'] });
        }

        const fetchAddress = async () => {
            try {
                const addresses = await rpcClient.request({ method: 'getaddressesbylabel', params: ['']});
                setAddress(Object.keys(addresses)[0]);
            } catch (err) {
                console.log(err);
                if(err.message.includes('No addresses with label')) {
                    setAddress(await createAddress());
                }
            }
        }

        const fetchWalletInfo = async () => {
            const walletInfo = await rpcClient.request({ method: 'getwalletinfo' });
            console.log(walletInfo);
            setBalance(walletInfo.balance);
        }

        const fetchStakingInfo = async () => {
            const stakingInfo = await rpcClient.request({ method: 'getstakinginfo' });
            console.log(stakingInfo);
            setIsStaking(stakingInfo.staking);
            setExpectedRewardTime(stakingInfo.expectedtime);
            setStakeWeight(stakingInfo.weight);
        }

        const fetchBlockchainInfo = async () => {
            const blockchainInfo = await rpcClient.request({ method: 'getblockchaininfo' });
            setIsSycned(blockchainInfo.blocks == blockchainInfo.headers);
        }

        const fetchPeers = async () => {
            const peers = await rpcClient.request({ method: 'getconnectioncount' });
            setNodePeers(peers);
        }

        fetchAddress();
        fetchWalletInfo();
        fetchStakingInfo();
        fetchBlockchainInfo();
        fetchPeers();
    }, [clockTick]);


    React.useEffect(() => {
        if (isSynced && nodePeers >= 2) {
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
                            <td>address</td>
                            <td>{isStaking === undefined ? "..loading" : address}</td>
                        </tr>
                        <tr>
                            <td>balance</td>
                            <td>{balance === undefined ? "..loading" : !isSynced ? 'node not synced..' : balance}</td>
                        </tr>
                        <tr>
                            <td>staking</td>
                            <td>{isStaking === undefined ? "..loading" : !isSynced ? 'node not synced..' : isStaking === false ? "no" : "yes"}</td>
                        </tr>
                        <tr>
                            <td>stake weight</td>
                            <td>{stakeWeight === undefined ? "..loading" : !isSynced ? 'node not synced..' : stakeWeight}</td>
                        </tr>
                        <tr>
                            <td>expected reward time</td>
                            <td>{expectedRewardTime === undefined ? "..loading" : !isSynced ? 'node not synced..' : expectedRewardTime === 0 ? "never" : expectedRewardTime}</td>
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