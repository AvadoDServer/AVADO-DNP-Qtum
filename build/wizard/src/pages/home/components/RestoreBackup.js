import React from "react";
import monitor from "../../../util/monitor";

const packageName = "qtum.avado.dnp.dappnode.eth";

const Comp = ({ session }) => {

    const [uploadResult, setUploadResult] = React.useState();

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
        const path = "/package/data/qtum";
        const filename = `wallet.dat`;
        try {
            await uploadFile(file, path, filename);
            await monitor.restartQtum();
            setUploadResult("Wallet restored successfully. Changes will be effective shortly..");
        } catch (err) {
            setUploadResult("Wallet could not be restored.");
            console.error(`Error on restoring wallet backup ${filename}: ${err.message}`);
        }
    }

    return (
        <>
            <div>
                <input
                    type="file"
                    onChange={e => restoreWallet(e.target.files[0])}
                />
                {uploadResult && (<div className="is-size-7">{uploadResult}</div>)}
            </div>
        </>
    );
}


export default Comp;