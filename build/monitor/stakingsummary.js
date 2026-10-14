// Staking rewards of the wallet, summed from `listtransactions` (read only).
//
// What Qtum v30.2 lists for a stake (checked on a regtest proof-of-stake run
// of the package image, test/fixtures/listtransactions.json):
// - A stake of the wallet's own coins: ONE entry, category "send", amount 0,
//   `generated: true`, and the reward as a positive `fee`. Its outputs are
//   pay-to-pubkey scripts, which v30 classes as change, so they are not
//   listed and the "condensed" generate/immature entry never appears.
// - A super staker's fee for staking delegated coins (and a proof-of-work
//   coinbase, only on regtest): "generate" (mature) or "immature" entries,
//   one per output to the wallet, whose amount is what the wallet got.
// - "orphan": a stake that did not make it into the chain, not a reward.
// One reward per transaction: the generate/immature amounts when there are
// any, else the fee of the generated "send". Confirmed ones only.
// Plain Node 12 (no optional chaining, no ??).

const REWARD_CATEGORIES = ["generate", "immature"];
const DAY_MS = 24 * 60 * 60 * 1000;
// listtransactions returns the newest entries first when it is cut off
const DEFAULT_CAP = 100000;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

const toSatoshi = (amount) => Math.round(Number(amount) * 1e8);
const fromSatoshi = (sat) => Math.round(sat) / 1e8;

// When a transaction was mined, in ms (blocktime, else time)
const entryTime = (entry) => {
    const seconds = typeof entry.blocktime === "number" ? entry.blocktime : entry.time;
    return typeof seconds === "number" && isFinite(seconds) ? seconds * 1000 : null;
};

const confirmed = (entry) => !!entry && typeof entry.txid === "string"
    && typeof entry.confirmations === "number" && entry.confirmations > 0 && entry.abandoned !== true;
const positive = (n) => typeof n === "number" && isFinite(n) && n > 0;
// an output of a stake (or coinbase) to the wallet
const isRewardOutput = (entry) => confirmed(entry) && REWARD_CATEGORIES.indexOf(entry.category) >= 0 && positive(entry.amount);
// a stake of the wallet's own coins: the reward is the fee
const isOwnStake = (entry) => confirmed(entry) && entry.category === "send" && entry.generated === true && positive(entry.fee);

// The rewards in `entries`, one per transaction: [{ txid, sat, at }]
const rewards = (entries) => {
    const byTx = {};
    const order = [];
    const tx = (entry) => {
        if (!byTx[entry.txid]) {
            byTx[entry.txid] = { txid: entry.txid, outputs: {}, outputSat: 0, feeSat: 0, at: entryTime(entry) };
            order.push(entry.txid);
        }
        return byTx[entry.txid];
    };
    entries.forEach((entry) => {
        if (isRewardOutput(entry)) {
            const t = tx(entry);
            const key = String(entry.vout);
            if (t.outputs[key]) return; // listed twice
            t.outputs[key] = true;
            t.outputSat += toSatoshi(entry.amount);
        } else if (isOwnStake(entry)) {
            const t = tx(entry);
            // the same fee is on every "send" entry of the transaction
            t.feeSat = toSatoshi(entry.fee);
        }
    });
    return order.map((txid) => {
        const t = byTx[txid];
        return { txid, sat: t.outputSat > 0 ? t.outputSat : t.feeSat, at: t.at };
    }).filter((r) => r.sat > 0);
};

// entries: the listtransactions answer. Returns the summary the page shows.
//   totalRewards  QTUM earned by staking (all rewards listed)
//   rewards30d    QTUM earned in the last 30 days
//   count         number of rewards in the last 30 days
//   countAll      number of rewards in total
//   lastRewardAt  when the last reward was mined (ISO), or null
//   truncated     true when the wallet has more transactions than were read
const summarize = (entries, nowMs, cap) => {
    const list = Array.isArray(entries) ? entries : [];
    const since = nowMs - 30 * DAY_MS;
    let total = 0;
    let recent = 0;
    let count = 0;
    let last = null;
    const found = rewards(list);
    found.forEach((r) => {
        total += r.sat;
        if (r.at !== null && r.at >= since) {
            recent += r.sat;
            count += 1;
        }
        if (r.at !== null && (last === null || r.at > last)) last = r.at;
    });
    return {
        totalRewards: fromSatoshi(total),
        rewards30d: fromSatoshi(recent),
        count,
        countAll: found.length,
        lastRewardAt: last === null ? null : new Date(last).toISOString(),
        computedAt: new Date(nowMs).toISOString(),
        truncated: list.length >= (cap || DEFAULT_CAP),
    };
};

// A cached reader. listtransactions over a long history is heavy (it holds
// the wallet lock), and rewards come days apart: the summary is computed again
// only when the wallet has a new transaction (getwalletinfo's txcount, cheap)
// or after `ttlMs` (10 minutes; the 30-day window moves). Callers that ask at
// the same time share one read. Failures are not cached.
//   rpc(method, params, opts) -> Promise (the monitor's rpc)
const createStakingSummary = (options) => {
    const rpc = options.rpc;
    const now = options.now || (() => Date.now());
    const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
    const cap = options.cap || DEFAULT_CAP;
    let cached = null;   // { at, txcount, value }
    let running = null;  // Promise while a read runs
    const compute = (txcount) => {
        if (running) return running;
        running = rpc("listtransactions", ["*", cap, 0, true], { wallet: true, timeout: 120000 })
            .then((entries) => {
                const value = summarize(entries, now(), cap);
                cached = { at: now(), txcount, value };
                running = null;
                return value;
            }, (err) => {
                running = null;
                throw err;
            });
        return running;
    };
    return () => rpc("getwalletinfo", [], { wallet: true, timeout: 15000 })
        .then((info) => (info && typeof info.txcount === "number" ? info.txcount : null), () => null)
        .then((txcount) => {
            if (cached && txcount !== null && cached.txcount === txcount && now() - cached.at < ttlMs) return cached.value;
            return compute(txcount);
        });
};

module.exports = { summarize, rewards, createStakingSummary, REWARD_CATEGORIES, DEFAULT_CAP, DEFAULT_TTL_MS };
