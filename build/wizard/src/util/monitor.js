import axios from "axios";

const baseUrl = "http://qtum.avadopackage.com/monitor"

const getEnv = () => {
    return axios.get(`${baseUrl}/getenv`);
}

const setEnv = (payload) => {
    return axios.post(`${baseUrl}/setenv`, payload);
}

const restartQtum = () => {
    return axios.post(`${baseUrl}/restartQtum`);
}

export default {
    getEnv,
    setEnv,
    restartQtum,
}
