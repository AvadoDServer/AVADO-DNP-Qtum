import React from "react";
import axios from "axios";

const Comp = ({ name, envName }) => {
    const [envValue, setEnvValue] = React.useState(undefined);

    const fetchCurrentValue = async () => {
        const response = await axios.get("http://qtum.avadopackage.com/monitor/getenv");
        console.log(response.data[envName]);
        setEnvValue(response.data[envName]);
    }

    const updateValue = async () => {
        await axios.post("http://qtum.avadopackage.com/monitor/setenv", {
            [envName]: parseInt(envValue),
        });
    }

    React.useEffect(() => {
        fetchCurrentValue();
    }, []);

    return (
        <>
            <div>
                <span className="has-text-white has-text-weight-bold">{name}</span>
                <input type="number" value={envValue} onChange={(e) => setEnvValue(e.target.value)} />
                <button onClick={updateValue}>Update</button>
            </div>
        </>
    );

}

export default Comp;