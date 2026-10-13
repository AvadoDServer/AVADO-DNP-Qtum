import React from "react";
import ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import monitor from "../../../util/monitor";
import WalletStatusBanner from "./WalletStatusBanner";

jest.mock("../../../util/monitor", () => ({
    getWalletStatus: jest.fn(),
    retryWalletUpgrade: jest.fn(() => Promise.resolve({ data: { started: true } })),
    rebuildWallet: jest.fn(() => Promise.resolve({ data: { started: true } })),
    errorMessage: (err, fallback) => fallback,
}));

const failedUpgrade = {
    state: "failed",
    message: "the upgrade was refused",
    problem: null,
    migration: { state: "failed", method: "upgrade", encrypted: false, canRebuild: true },
    rebuild: null,
    newBackupRequired: false,
    restore: null,
};

let container;

const render = async (status) => {
    monitor.getWalletStatus.mockResolvedValue({ data: status });
    await act(async () => {
        ReactDOM.render(<WalletStatusBanner />, container);
    });
};

const button = (text) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text);

const click = async (text) => {
    const b = button(text);
    expect(b).toBeDefined();
    await act(async () => {
        b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
};

beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
});

afterEach(() => {
    ReactDOM.unmountComponentAtNode(container);
    container.remove();
});

it("offers the rebuild next to Try again when the upgrade failed, and asks first", async () => {
    await render(failedUpgrade);
    expect(button("Try again")).toBeDefined();
    expect(container.textContent).not.toContain("reads every key");

    await click("Rebuild the wallet from the old copy");
    expect(container.textContent).toContain("reads every key from the copy of your old wallet");
    expect(container.textContent).toContain("Your old wallet stays on the AVADO");
    expect(container.textContent).toContain("can take a few hours");
    expect(container.textContent).not.toContain("up to an hour");
    expect(monitor.rebuildWallet).not.toHaveBeenCalled();

    await click("Cancel");
    expect(container.textContent).not.toContain("reads every key");

    await click("Rebuild the wallet from the old copy");
    await click("Rebuild");
    expect(monitor.rebuildWallet).toHaveBeenCalledWith(undefined);
    expect(container.textContent).toContain("Rebuilding your wallet...");
});

it("does not promise staking by itself for a wallet with a password", async () => {
    await render(Object.assign({}, failedUpgrade, { migration: Object.assign({}, failedUpgrade.migration, { encrypted: true }) }));
    await click("Rebuild the wallet from the old copy");
    expect(container.textContent).not.toContain("staking starts again by itself");
    expect(container.textContent).toContain("you are asked for it before the keys are read");
    expect(container.textContent).toContain("stays locked and does not stake");
});

it("does not offer the rebuild for other wallet problems", async () => {
    await render(Object.assign({}, failedUpgrade, { migration: null }));
    expect(button("Rebuild the wallet from the old copy")).toBeUndefined();
    expect(button("Try again")).toBeUndefined();
});

it("shows the step and the progress while rebuilding", async () => {
    await render(Object.assign({}, failedUpgrade, {
        state: "rebuilding",
        message: "Scanning the blockchain: 37 %",
        rebuild: { state: "running", step: "Scanning the blockchain", progress: 37, error: null, notCarriedOver: "" },
    }));
    expect(container.textContent).toContain("Rebuilding your wallet from the copy of your old wallet.");
    expect(container.textContent).toContain("Scanning the blockchain: 37 %");
    expect(button("Rebuild the wallet from the old copy")).toBeUndefined();
});

it("sends the password to the rebuild when the rebuild asked for it", async () => {
    await render(Object.assign({}, failedUpgrade, {
        state: "needs-passphrase",
        migration: Object.assign({}, failedUpgrade.migration, { state: "needs-passphrase", encrypted: true }),
        rebuild: { state: "needs-passphrase", step: null, progress: null, error: null, notCarriedOver: "" },
    }));
    const input = container.querySelector("input[type=password]");
    await act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setValue.call(input, "secret words");
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Rebuild wallet");
    expect(monitor.rebuildWallet).toHaveBeenCalledWith("secret words");
    expect(monitor.retryWalletUpgrade).not.toHaveBeenCalled();
});

it("tells when the rebuild failed, and what was not carried over after a rebuild", async () => {
    await render(Object.assign({}, failedUpgrade, {
        message: "1 address of the old wallet is missing in the new wallet. Your old wallet was not changed.",
        rebuild: { state: "failed", step: null, progress: null, error: "x", notCarriedOver: "" },
    }));
    expect(container.textContent).toContain("Your wallet could not be rebuilt.");
    expect(button("Rebuild the wallet from the old copy")).toBeDefined();

    ReactDOM.unmountComponentAtNode(container);
    await render(Object.assign({}, failedUpgrade, {
        state: "ready",
        newBackupRequired: true,
        migration: { state: "done", method: "rebuild", encrypted: false, canRebuild: false },
        rebuild: { state: "done", step: null, progress: null, error: null, notCarriedOver: "Not carried over to the new wallet: 1 watch-only address. The old wallet still has them." },
    }));
    expect(container.textContent).toContain("Your wallet was rebuilt in the new Qtum wallet format.");
    expect(container.textContent).toContain("1 watch-only address");
    expect(container.textContent).not.toContain("damaged");
});

it("says so when the old wallet file was damaged and read directly", async () => {
    const rebuilt = Object.assign({}, failedUpgrade, {
        state: "ready",
        newBackupRequired: true,
        migration: { state: "done", method: "rebuild", encrypted: false, canRebuild: false },
        rebuild: { state: "done", step: null, progress: null, error: null, notCarriedOver: "", source: "raw-pages", seedRestored: true },
    });
    await render(rebuilt);
    expect(container.textContent).toContain("The old wallet file was damaged; the keys that could be read were carried over and all addresses from its seed were restored.");

    ReactDOM.unmountComponentAtNode(container);
    await render(Object.assign({}, rebuilt, { rebuild: Object.assign({}, rebuilt.rebuild, { seedRestored: false }) }));
    expect(container.textContent).toContain("The old wallet file was damaged; the keys that could be read were carried over.");
    expect(container.textContent).not.toContain("from its seed");
});
