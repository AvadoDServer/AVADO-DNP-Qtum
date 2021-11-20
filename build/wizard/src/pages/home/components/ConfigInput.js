import React from "react";
import monitor from "../../../util/monitor";

const Comp = ({ name, envName }) => {
    const [envValue, setEnvValue] = React.useState(undefined);

    const fetchCurrentValue = async () => {
        const response = await monitor.getEnv();
        setEnvValue(response.data[envName]);
    }

    const updateValue = async () => {
        await monitor.setEnv({
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
                <input style={{ marginLeft: 10 }} type="number" min="0" value={envValue} onChange={(e) => setEnvValue(e.target.value)} />
                <button onClick={updateValue}>Update</button>
            </div>
        </>
    );

}

export default Comp;