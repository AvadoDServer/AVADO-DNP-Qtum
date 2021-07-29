import React from "react";
import { saveAs } from "file-saver";

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

const Comp = ({ rpcClient, session }) => {
    async function downloadFile() {
        const walletBackupPath = '/tmp/wallet.backup';

        try {
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

            await rpcClient.request({ method: 'backupwallet', params: [walletBackupPath] })

            const copyFileFromResponse = JSON.parse(await session.call("copyFileFrom.dappmanager.dnp.dappnode.eth", [],
                {
                    id: "qtum.avado.dnp.dappnode.eth",
                    fromPath: walletBackupPath
                }
            ));

            if (copyFileFromResponse.success !== true) {
                return;
            }

            const dataUri = copyFileFromResponse.result;
            // const dataUri = await api.copyFileFrom(
            //     { id, fromPath },
            //     { toastMessage: `Copying file from ${shortName(id)} ${fromPath}...` }
            // );


            if (!dataUri) {
                return;
            }

            const blob = dataUriToBlob(dataUri);
            const fileName = 'qtum-wallet.backup';

            saveAs(blob, fileName);
        } catch (e) {
            console.error(`Error on downloading backup ${walletBackupPath}: ${e.stack}`);
        }
    }


    return (
        <button className="button" onClick={downloadFile}>Download Wallet backup</button>
    );

}


export default Comp;