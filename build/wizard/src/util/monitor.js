import axios from "axios";

// Same address the wizard was opened at: nginx only accepts calls that change
// something from the wizard's own page
const baseUrl = "/monitor";

// Required by the monitor for calls that touch keys or replace the wallet
const wizardHeaders = { headers: { "X-Qtum-Wizard": "1" } };

const getEnv = () => {
    return axios.get(`${baseUrl}/getenv`);
}

const setEnv = (payload) => {
    return axios.post(`${baseUrl}/setenv`, payload);
}

const restartQtum = () => {
    return axios.post(`${baseUrl}/restartQtum`);
}

const getWalletStatus = () => {
    return axios.get(`${baseUrl}/walletstatus`);
}

const backupDone = () => {
    return axios.post(`${baseUrl}/backupdone`, {}, wizardHeaders);
}

const getPrivateKey = (address) => {
    return axios.post(`${baseUrl}/privkey`, { address }, wizardHeaders);
}

const importPrivateKey = (privateKey) => {
    return axios.post(`${baseUrl}/importkey`, { privateKey }, wizardHeaders);
}

const restoreWallet = (file) => {
    return axios.post(`${baseUrl}/restore`, { file }, wizardHeaders);
}

const retryWalletUpgrade = (passphrase) => {
    return axios.post(`${baseUrl}/migrate`, passphrase ? { passphrase } : {}, wizardHeaders);
}

// The plain-language message the monitor sent, or a fallback
const errorMessage = (err, fallback) => {
    return (err && err.response && err.response.data && err.response.data.error) || fallback;
}

export default {
    getEnv,
    setEnv,
    restartQtum,
    getWalletStatus,
    backupDone,
    getPrivateKey,
    importPrivateKey,
    restoreWallet,
    retryWalletUpgrade,
    errorMessage,
}
