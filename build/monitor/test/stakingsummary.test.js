// GET /staking-summary: rewards summed from listtransactions (Qtum v30 lists
// a coinstake as one "generate"/"immature" entry whose amount is the reward).
const test = require("node:test");
const assert = require("node:assert");
const { summarize, createStakingSummary } = require("../stakingsummary");
const entries = require("./fixtures/listtransactions.json");

const NOW = 1760400000 * 1000; // 2025-10-14

test("sums the confirmed rewards: mature and immature, not orphans, sends or receives, each transaction once", () => {
    const s = summarize(entries, NOW);
    assert.strictEqual(s.totalRewards, 1.28);
    assert.strictEqual(s.countAll, 4);
    assert.strictEqual(s.rewards30d, 0.87999877);
    assert.strictEqual(s.count, 3);
    assert.strictEqual(s.lastRewardAt, new Date(1760300000 * 1000).toISOString());
    assert.strictEqual(s.computedAt, new Date(NOW).toISOString());
    assert.strictEqual(s.truncated, false);
});

test("a wallet without rewards", () => {
    const s = summarize([entries[0], entries[7]], NOW);
    assert.deepStrictEqual(
        { totalRewards: s.totalRewards, rewards30d: s.rewards30d, count: s.count, countAll: s.countAll, lastRewardAt: s.lastRewardAt },
        { totalRewards: 0, rewards30d: 0, count: 0, countAll: 0, lastRewardAt: null },
    );
    assert.strictEqual(summarize(null, NOW).countAll, 0);
});

test("says when the wallet has more transactions than were read", () => {
    assert.strictEqual(summarize(entries, NOW, 8).truncated, true);
    assert.strictEqual(summarize(entries, NOW, 9).truncated, false);
});

test("asks qtumd once per minute, shares a running read, and does not cache a failure", async () => {
    let now = NOW;
    const calls = [];
    let fail = false;
    const rpc = (method, params, opts) => {
        calls.push({ method, params, opts });
        if (fail) return Promise.reject(new Error("Requested wallet does not exist or is not loaded"));
        return new Promise((resolve) => setTimeout(() => resolve(entries), 5));
    };
    const get = createStakingSummary({ rpc, now: () => now, cap: 100000 });
    const [a, b] = await Promise.all([get(), get()]);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].params, ["*", 100000, 0, true]);
    assert.strictEqual(calls[0].opts.wallet, true);
    assert.strictEqual(a, b);
    now += 59 * 1000;
    await get();
    assert.strictEqual(calls.length, 1, "cached for 60 s");
    now += 2 * 1000;
    fail = true;
    await assert.rejects(get(), /not loaded/);
    assert.strictEqual(calls.length, 2);
    fail = false;
    const c = await get();
    assert.strictEqual(calls.length, 3, "a failure is not cached");
    assert.strictEqual(c.countAll, 4);
});
