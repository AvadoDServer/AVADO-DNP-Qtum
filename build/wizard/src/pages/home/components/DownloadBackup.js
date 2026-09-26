import React from "react";
import { saveAs } from "file-saver";
import monitor from "../../../util/monitor";

function dataUriToBlob(dataURI) {
    if (!dataURI || typeof dataURI !== "string")
        throw Error("dataUri must be a string");

    // Credit: https://stackoverflow.com/questions/12168909/blob-from-dataurl
    // convert base64 to raw binary data held in a string
    // doesn't handle URLEncoded DataURIs - see SO answer #6850276 for code that does this
    const byteString = atob(dataURI.split(",")[1]);
    // separate out the mime component
    // dataURI = data:application/zip;base64,UEsDBBQAAAg...
    const mimeString = dataURI
        .split(",")[0]
        .split(":")[1]
        .split(";")[0];
    // write the bytes of the string to an ArrayBuffer
    const ab = new ArrayBuffer(byteString.length);
    // create a view into the buffer
    const ia = new Uint8Array(ab);
    // set the bytes of the buffer to the correct values
    for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
    }
    // write the ArrayBuffer to a blob, and you're done
    const blob = new Blob([ab], { type: mimeString });
    return blob;
}

const Comp = ({ rpcClient, session, onSuccess }) => {
    const [message, setMessage] = React.useState(undefined);

    async function downloadFile() {
        const walletBackupPath = '/tmp/wallet.backup';
        setMessage(undefined);

        try {
            await rpcClient.request({ method: 'backupwallet', params: [walletBackupPath] })

            /**
            * [copyFileFrom]
            * Copy file from a DNP and download it on the client
            *
            * @param {string} id DNP .eth name
            * @param {string} fromPath path to copy file from
            * - If path = path to a file: "/usr/src/app/config.json".
            *   Downloads and sends that file
            * - If path = path to a directory: "/usr/src/app".
            *   Downloads all directory contents, tar them and send as a .tar.gz
            * - If path = relative path: "config.json".
            *   Path becomes $WORKDIR/config.json, then downloads and sends that file
            *   Same for relative paths to directories.
            * @returns {string} dataUri = "data:application/zip;base64,UEsDBBQAAAg..."
            */
            const copyFileFromResponse = JSON.parse(await session.call("copyFileFrom.dappmanager.dnp.dappnode.eth", [],
                {
                    id: "qtum.avado.dnp.dappnode.eth",
                    fromPath: walletBackupPath
                }
            ));

            if (copyFileFromResponse.success !== true) {
                setMessage("The backup could not be downloaded. Please try again.");
                return;
            }

            const dataUri = copyFileFromResponse.result;
            // const dataUri = await api.copyFileFrom(
            //     { id, fromPath },
            //     { toastMessage: `Copying file from ${shortName(id)} ${fromPath}...` }
            // );


            if (!dataUri) {
                setMessage("The backup could not be downloaded. Please try again.");
                return;
            }

            const blob = dataUriToBlob(dataUri);
            const fileName = `qtum-wallet-${new Date().toISOString().slice(0, 10)}.dat`;

            saveAs(blob, fileName);
            try {
                await monitor.backupDone();
            } catch (e) {
                console.error(`Could not record the backup: ${e.message}`);
            }
            if (onSuccess) {
                await onSuccess();
            }
        } catch (e) {
            console.error(`Error on downloading backup ${walletBackupPath}: ${e.stack}`);
            setMessage("The backup could not be downloaded. If the Qtum node is still starting, please try again in a few minutes.");
        }
    }


    return (
        <>
            <button className="button" onClick={downloadFile}>Download Wallet backup</button>
            {message && (<p className="is-size-7" style={{ marginTop: 5 }}>{message}</p>)}
        </>
    );

}


export default Comp;