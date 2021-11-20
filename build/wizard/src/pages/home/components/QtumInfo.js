import React from "react";
import "./QtumInfo.css";
import DisplayPrivateKeyModal from "./DisplayPrivateKeyModal";
import ConfigInput from "./ConfigInput";
import spinner from "../../../assets/spinner.svg";
import checkmark from "../../../assets/green-checkmark-line.svg";
import humanizeDuration from "humanize-duration";

const Comp = ({ rpcClient }) => {

    const [addresses, setAddresses] = React.useState(undefined);
    const [balance, setBalance] = React.useState(undefined);
    const [isStaking, setIsStaking] = React.useState(undefined);
    const [nodePeers, setNodePeers] = React.useState();
    const [expectedRewardTime, setExpectedRewardTime] = React.useState(undefined);
    const [isSynced, setIsSycned] = React.useState(undefined);
    const [clockTick, setClockTick] = React.useState(0);
    const [isPrivateKeyModalVisible, setIsPrivateKeyModalVisible] = React.useState(false);
    const [privateKeyAddress, setPrivateKeyAddress] = React.useState(undefined);
    const [privateKey, setPrivateKey] = React.useState(undefined);

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

        const fetchAddresses = async () => {
            let labels;
            try {
                labels = await rpcClient.request({ method: 'listlabels', params: [''] });
            } catch (err) {
                console.log(`Error while getting labels. Err: ${err.message}`);
                return;
            }

            let addresses = [];

            try {
                for (const label of labels) {
                    const result = await rpcClient.request({ method: 'getaddressesbylabel', params: [label] });
                    addresses.push(...Object.keys(result));
                }
            } catch (err) {
                console.log(`Error while getting addresses by label. Err: ${err.message}`);
                return;
            }

            if (addresses.length == 0) {
                addresses.push(await createAddress());
            }

            setAddresses(addresses);
        }

        const fetchWalletInfo = async () => {
            const walletInfo = await rpcClient.request({ method: 'getwalletinfo' });
            setBalance(walletInfo.balance);
        }

        const fetchStakingInfo = async () => {
            const stakingInfo = await rpcClient.request({ method: 'getstakinginfo' });
            setIsStaking(stakingInfo.staking);
            setExpectedRewardTime(stakingInfo.expectedtime * 1000); // seconds -> milliseconds
        }

        const fetchBlockchainInfo = async () => {
            const blockchainInfo = await rpcClient.request({ method: 'getblockchaininfo' });
            setIsSycned(blockchainInfo.blocks == blockchainInfo.headers);
        }

        const fetchPeers = async () => {
            const peers = await rpcClient.request({ method: 'getconnectioncount' });
            setNodePeers(peers);
        }

        fetchAddresses();
        fetchWalletInfo();
        fetchStakingInfo();
        fetchBlockchainInfo();
        fetchPeers();
    }, [clockTick]);

    const fetchPrivateKey = async (address) => {
        const privateKey = await rpcClient.request({ method: 'dumpprivkey', params: [address] });

        setPrivateKeyAddress(address);
        setPrivateKey(privateKey);
        setIsPrivateKeyModalVisible(true);
    }

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
                            <td>balance</td>
                            <td>{balance === undefined ? "loading.." : !isSynced ? 'node not synced..' : balance}</td>
                        </tr>
                        <tr>
                            <td>staking</td>
                            <td>{isStaking === undefined ? "loading.." : !isSynced ? 'node not synced..' : isStaking === false ? "no" : "yes"}</td>
                        </tr>
                        <tr>
                            <td>expected reward time</td>
                            <td>{expectedRewardTime === undefined ? "loading.." : !isSynced ? 'node not synced..' : expectedRewardTime === 0 ? "never" : humanizeDuration(expectedRewardTime, { round: true, units: ['d', 'h', 'm'] })}</td>
                        </tr>
                        <tr>
                            <td>connected peers</td>
                            <td>{nodePeers || "loading.."}</td>
                        </tr>
                        <tr>
                            <td>is synced</td>
                            <td>{isSynced === undefined ? "loading.." : isSynced === false ? "no" : "yes"}</td>
                        </tr>
                    </tbody></table>


                <ConfigInput name="Minimum Delegation Fee(%)" envName="DELEGATION_FEE_PERCENT" />
                <ConfigInput name="Minimum Delegation Amount" envName="MIN_DELEGATION_AMOUNT" />

                {!isSynced ? (
                    <div style={{ marginTop: 10 }} className="level">
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

                <div style={{ marginTop: 15 }}>
                    <p className="has-text-white has-text-weight-bold">Addresses in wallet: </p>
                    <ul id="addresses">
                        {addresses === undefined ? 'loading..' : addresses.map(address => {
                            return <>
                                <li key={address}>
                                    <span>{address}</span>
                                    <button style={{ marginLeft: 5 }} onClick={(_) => fetchPrivateKey(address)}>Show WIF</button>
                                </li>
                            </>
                        })}
                    </ul>
                </div>

                {isPrivateKeyModalVisible && <DisplayPrivateKeyModal address={privateKeyAddress} privateKey={privateKey} onClose={() => { setIsPrivateKeyModalVisible(false) }} />}

            </section>
        </>);

};

export default Comp;