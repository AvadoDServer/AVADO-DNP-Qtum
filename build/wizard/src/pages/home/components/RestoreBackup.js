import React from "react";

const packageName = "qtum.avado.dnp.dappnode.eth";

const Comp = ({ rpcClient, session }) => {

    const [uploadResult, setUploadResult] = React.useState();
    const [restartResult, setRestartResult] = React.useState();

    const restart = async () => {
        const res = JSON.parse(await session.call("restartPackage.dappmanager.dnp.dappnode.eth", [],
            {
                id: packageName,
            }));
        if (res.success === true) {
            setRestartResult("restarting package - wait a few minutes and reload this page");
        }
    }


    function fileToDataUri(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = e => {
                // fileContent is a base64 URI = data:application/zip;base64,UEsDBBQAAAg...
                const fileContent = e.target.result;
                resolve(fileContent);
            };
        });
    }

    async function uploadFile(file, path, filename) {
        const dataUri = await fileToDataUri(file);
        JSON.parse(
            await session.call(
                "copyFileTo.dappmanager.dnp.dappnode.eth",
                [],
                {
                    id: packageName,
                    dataUri: dataUri,
                    filename: filename,
                    toPath: path
                }
            )
        );
    }

    async function restoreWallet(file) {
        const path = "/root";
        const filename = "wallet.backup";
        try {
            await uploadFile(file, path, filename);
            await rpcClient.require({ method: 'loadwallet', params: [`${path}/${filename}`] });
        } catch (err) {
            console.error(`Error on uploading wallet backup ${packageName} ${path}/${filename}: ${err.stack}`);
        }
    }

    return (
        <>
            <div>
                <input
                    type="file"
                    onChange={e => uploadFile(e.target.files[0], "/root", "wallet.backup", setUploadResult)}
                />
                {uploadResult && (<div className="is-size-7">{uploadResult}</div>)}
            </div>

            {uploadResult && (
                <>
                    <button className="button" onClick={restart}>restart node</button>
                    {restartResult && (<div className="is-size-7">{restartResult}</div>)}
                </>
            )}
        </>
    );
}


export default Comp;