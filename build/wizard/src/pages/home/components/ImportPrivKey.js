import React from "react";

const Comp = ({ rpcClient }) => {
    const [privKey, setPrivKey] = React.useState(undefined);
    const [importSuccessful, setImportSuccessful] = React.useState(undefined);

    const importPrivKey = async () => {
        await rpcClient.request({ method: "importprivkey", params: [privKey] });
        setImportSuccessful(true);
    }

    return (
        <div>
            <input type="text" placeholder="Type the private key.." onChange={(e) => setPrivKey(e.target.value)} />
            <button onClick={importPrivKey}>Import</button>
            {importSuccessful && (<p>Successully imported..</p>)}
        </div>
    );

}


export default Comp;