// Staking rewards of the wallet, summed from `listtransactions` (read only).
//
// Qtum v30 lists a coinstake the wallet made as ONE entry: category
// "immature" (fewer than 500 confirmations) or "generate" (mature), with
// `amount` = what the wallet got minus what it put in, so the reward alone
// (ListTransactions condenses the coinstake's inputs and outputs). A
// super staker's fee for staking delegated coins is listed the same way.
// "orphan" (a stake that did not make it into the chain) is not a reward.
// Plain Node 12 (no optional chaining, no ??).

const REWARD_CATEGORIES = ["generate", "immature"];
const DAY_MS = 24 * 60 * 60 * 1000;
// listtransactions returns the newest entries first when it is cut off
const DEFAULT_CAP = 100000;
const DEFAULT_TTL_MS = 60 * 1000;

const toSatoshi = (amount) => Math.round(Number(amount) * 1e8);
const fromSatoshi = (sat) => Math.round(sat) / 1e8;

// When a transaction was mined, in ms (blocktime, else time)
const entryTime = (entry) => {
    const seconds = typeof entry.blocktime === "number" ? entry.blocktime : entry.time;
    return typeof seconds === "number" && isFinite(seconds) ? seconds * 1000 : null;
};

const isReward = (entry) => !!entry
    && REWARD_CATEGORIES.indexOf(entry.category) >= 0
    && typeof entry.confirmations === "number" && entry.confirmations > 0
    && typeof entry.amount === "number" && isFinite(entry.amount) && entry.amount > 0
    && entry.abandoned !== true;

// entries: the listtransactions answer. Returns the summary the wizard shows.
//   totalRewards  QTUM earned by staking (all rewards listed)
//   rewards30d    QTUM earned in the last 30 days
//   count         number of rewards in the last 30 days
//   countAll      number of rewards in total
//   lastRewardAt  when the last reward was mined (ISO), or null
//   truncated     true when the wallet has more transactions than were read
const summarize = (entries, nowMs, cap) => {
    const list = Array.isArray(entries) ? entries : [];
    const since = nowMs - 30 * DAY_MS;
    // one reward per transaction (a coinstake has a single condensed entry,
    // but never count one twice)
    const seen = {};
    let total = 0;
    let recent = 0;
    let countAll = 0;
    let count = 0;
    let last = null;
    list.forEach((entry) => {
        if (!isReward(entry)) return;
        const key = `${entry.txid}:${entry.vout}`;
        if (seen[key]) return;
        seen[key] = true;
        const sat = toSatoshi(entry.amount);
        const at = entryTime(entry);
        total += sat;
        countAll += 1;
        if (at !== null && at >= since) {
            recent += sat;
            count += 1;
        }
        if (at !== null && (last === null || at > last)) last = at;
    });
    return {
        totalRewards: fromSatoshi(total),
        rewards30d: fromSatoshi(recent),
        count,
        countAll,
        lastRewardAt: last === null ? null : new Date(last).toISOString(),
        computedAt: new Date(nowMs).toISOString(),
        truncated: list.length >= (cap || DEFAULT_CAP),
    };
};

// A cached reader: at most one listtransactions call per `ttlMs`, shared by
// callers that ask at the same time. Failures are not cached.
//   rpc(method, params, opts) -> Promise (the monitor's rpc)
const createStakingSummary = (options) => {
    const rpc = options.rpc;
    const now = options.now || (() => Date.now());
    const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
    const cap = options.cap || DEFAULT_CAP;
    let cached = null;   // { at, value }
    let running = null;  // Promise while a read runs
    return () => {
        if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
        if (running) return running;
        running = rpc("listtransactions", ["*", cap, 0, true], { wallet: true, timeout: 120000 })
            .then((entries) => {
                const value = summarize(entries, now(), cap);
                cached = { at: now(), value };
                return value;
            })
            .then((value) => {
                running = null;
                return value;
            }, (err) => {
                running = null;
                throw err;
            });
        return running;
    };
};

module.exports = { summarize, createStakingSummary, REWARD_CATEGORIES, DEFAULT_CAP, DEFAULT_TTL_MS };
