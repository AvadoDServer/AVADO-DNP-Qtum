import React from "react";
import { saveAs } from "file-saver";

const packageName = "avalanchego.avado.dnp.dappnode.eth";

const Comp = ({ session, fileprefix }) => {

    const [stakerkeyresult, setStakerkeyresult] = React.useState();
    const [stakercrtresult, setStakercrtresult] = React.useState();
    const [restartresult, setRestartresult] = React.useState();

    const restart = async () => {
        const res = JSON.parse(await session.call("restartPackage.dappmanager.dnp.dappnode.eth", [],
            {
                id: packageName,
            }));
        if (res.success === true) {
            setRestartresult("restarting package - wait a few minutes and reload this page");
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

    async function uploadFile(file, path, name, setMsg) {
        try {
            const dataUri = await fileToDataUri(file);
            const res = JSON.parse(await session.call("copyFileTo.dappmanager.dnp.dappnode.eth", [],
                {
                    id: packageName,
                    dataUri: dataUri,
                    filename: name,
                    toPath: path
                }));
            setMsg(res.message);
        } catch (e) {
            console.error(`Error on copyFileTo ${packageName} ${path}/${name}: ${e.stack}`);
        }
    }

    return (
        <>
            <div>
                staker.key &nbsp;
            <input
                    type="file"
                    onChange={e => uploadFile(e.target.files[0], "/root/.avalanchego/staking", "staker.key", setStakerkeyresult)}
                />
                {stakerkeyresult && (<div className="is-size-7">{stakerkeyresult}</div>)}
            </div>
            <div>
                staker.crt &nbsp;
            <input
                    type="file"
                    onChange={e => uploadFile(e.target.files[0], "/root/.avalanchego/staking", "staker.crt", setStakercrtresult)}
                />
                {stakercrtresult && (<div className="is-size-7">{stakercrtresult}</div>)}
            </div>

            {stakerkeyresult && stakercrtresult && (
                <>
                    <button className="button" onClick={restart}>restart node</button>
                    {restartresult && (<div className="is-size-7">{restartresult}</div>)}
                </>
            )}
        </>
    );

}


export default Comp;