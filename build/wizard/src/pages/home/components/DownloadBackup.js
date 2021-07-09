import React from "react";
import { saveAs } from "file-saver";

const packageName = "avalanchego.avado.dnp.dappnode.eth";

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


const Comp = ({ session, fileprefix }) => {

    const [fromPath, setFromPath] = React.useState("/root/.avalanchego/staking");

    function parseFileName(path, mimeType) {
        if (!path || typeof path !== "string") return path;
        const subPaths = path.split("/");
        let fileName = fileprefix || subPaths[subPaths.length - 1] || "";

        // Add extension in case it is a compressed directory
        if (
            (mimeType === "application/gzip" && !fileName.endsWith(".gzip")) ||
            !fileName.endsWith(".gz") ||
            !fileName.endsWith(".tar.gz")
        )
            fileName = `${fileName}.tar.gz`;

        return fileName;
    }

    async function downloadFile() {
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

            const res = JSON.parse(await session.call("copyFileFrom.dappmanager.dnp.dappnode.eth", [],
                {
                    id: packageName,
                    fromPath: fromPath
                }
            ));

            if (res.success !== true) return;
            const dataUri = res.result;
            // const dataUri = await api.copyFileFrom(
            //     { id, fromPath },
            //     { toastMessage: `Copying file from ${shortName(id)} ${fromPath}...` }
            // );


            if (!dataUri) return;

            const blob = dataUriToBlob(dataUri);
            const fileName = parseFileName(fromPath, blob.type);

            saveAs(blob, fileName);
        } catch (e) {
            console.error(`Error on copyFileFrom ${fromPath}: ${e.stack}`);
        }
    }


    return (
        <button className="button" onClick={downloadFile}>Download Node Keys backup</button>
    );

}


export default Comp;