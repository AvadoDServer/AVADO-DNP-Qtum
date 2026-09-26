import React from "react";
import monitor from "../../../util/monitor";

const packageName = "qtum.avado.dnp.dappnode.eth";
// The backup is uploaded here; the monitor then puts it in place (and
// upgrades it automatically when it is an older, legacy wallet backup).
const uploadDir = "/package/data/restore";
const uploadName = "wallet-upload.dat";

const Comp = ({ session }) => {

    const [uploadResult, setUploadResult] = React.useState();
    const [working, setWorking] = React.useState(false);
    const inputRef = React.useRef();

    function fileToDataUri(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = e => {
                // fileContent is a base64 URI = data:application/zip;base64,UEsDBBQAAAg...
                const fileContent = e.target.result;
                resolve(fileContent);
            };
            reader.onerror = () => reject(new Error("could not read the file"));
        });
    }

    async function uploadFile(file) {
        const dataUri = await fileToDataUri(file);
        const response = JSON.parse(
            await session.call(
                "copyFileTo.dappmanager.dnp.dappnode.eth",
                [],
                {
                    id: packageName,
                    dataUri: dataUri,
                    filename: uploadName,
                    toPath: uploadDir
                }
            )
        );
        if (response && response.success === false) {
            throw new Error(response.message || "upload failed");
        }
    }

    async function restoreWallet(file) {
        if (!file) return;
        const ok = window.confirm(
            "Restore this wallet backup?\n\n" +
            "The wallet on your AVADO will be replaced by the backup. Your current wallet is saved on your AVADO first, so nothing is lost."
        );
        if (!ok) {
            if (inputRef.current) inputRef.current.value = "";
            return;
        }
        setWorking(true);
        setUploadResult("Uploading your backup...");
        try {
            if (!session) throw new Error("not connected to your AVADO yet");
            await uploadFile(file);
            await monitor.restoreWallet(uploadName);
            setUploadResult("Your backup is being restored. This takes a few minutes; the status is shown at the top of this page.");
        } catch (err) {
            setUploadResult(monitor.errorMessage(err, "The wallet could not be restored. Please try again."));
            console.error(`Error on restoring wallet backup: ${err.message}`);
        }
        setWorking(false);
        if (inputRef.current) inputRef.current.value = "";
    }

    return (
        <>
            <div>
                <input
                    ref={inputRef}
                    type="file"
                    disabled={working}
                    onChange={e => restoreWallet(e.target.files[0])}
                />
                {uploadResult && (<div className="is-size-7">{uploadResult}</div>)}
            </div>
        </>
    );
}


export default Comp;
