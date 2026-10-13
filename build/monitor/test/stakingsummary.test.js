// GET /staking-summary: rewards summed from listtransactions.
//
// test/fixtures/listtransactions.json is a real capture (trimmed, entries
// unchanged) from the 0.0.17 image on regtest: 2011 mined blocks, a payment
// of 1234.5 to a "savings" address, then two proof-of-stake blocks staked by
// the wallet itself after a restart. Kept: the two oldest mature coinbases
// ("generate"), the three newest immature ones, the payment ("send" and
// "receive") and both stakes. Qtum v30.2 lists a stake of the wallet's own
// coins as a "send" of 0 with generated: true and the reward as the fee.
const test = require("node:test");
const assert = require("node:assert");
const { summarize, rewards, createStakingSummary } = require("../stakingsummary");
const entries = require("./fixtures/listtransactions.json");

const CAPTURED = 1791922530 * 1000; // when the capture was taken
const DAY = 24 * 3600 * 1000;
const STAKES = ["8442a6f72392ad2ef057ad2eabd15b71bb2c5aaf45861346f705f7470928bc22", "a06b7402147000abb393382c5bae23b3394d827f6ce94e37939aef44425a0ec9"];

test("the real capture holds the shapes the summary must read", () => {
    const own = entries.filter((e) => e.category === "send" && e.generated === true);
    assert.deepStrictEqual(own.map((e) => [e.txid, e.amount, e.fee]), STAKES.map((t) => [t, 0, 20000]));
    assert.strictEqual(entries.filter((e) => e.category === "generate" || e.category === "immature").length, 5);
});

test("counts the wallet's own stakes (the fee of a generated send) and every generate/immature output; not payments", () => {
    const s = summarize(entries, CAPTURED);
    assert.strictEqual(s.countAll, 7); // 5 mined blocks (regtest only) + 2 stakes
    assert.strictEqual(s.totalRewards, 140000.0009); // one coinbase also holds the payment's fee
    assert.strictEqual(s.count, 7);
    assert.strictEqual(s.rewards30d, 140000.0009);
    assert.strictEqual(s.lastRewardAt, new Date(1791922524 * 1000).toISOString()); // the second stake
    assert.strictEqual(s.computedAt, new Date(CAPTURED).toISOString());
    assert.strictEqual(s.truncated, false);
    const found = rewards(entries);
    STAKES.forEach((txid) => assert.deepStrictEqual(found.filter((r) => r.txid === txid).map((r) => r.sat), [20000e8]));
    assert.ok(!found.some((r) => r.txid.startsWith("ceed2583")), "a payment is not a reward");
});

test("only the stakes: what a mainnet wallet sees (no proof-of-work blocks)", () => {
    const s = summarize(entries.filter((e) => e.category === "send" || e.category === "receive"), CAPTURED);
    assert.deepStrictEqual([s.countAll, s.totalRewards], [2, 40000]);
});

test("one reward per transaction: a stake listed twice, an output listed twice", () => {
    const stake = entries.find((e) => e.txid === STAKES[0]);
    const coinbase = entries.find((e) => e.category === "immature");
    const s = summarize([stake, Object.assign({}, stake), coinbase, Object.assign({}, coinbase)], CAPTURED);
    assert.deepStrictEqual([s.countAll, s.totalRewards], [2, 40000]);
});

test("a super staker's fee output (generate/immature) wins over the send's fee in the same transaction", () => {
    const stake = entries.find((e) => e.txid === STAKES[0]);
    const output = Object.assign({}, stake, { category: "immature", amount: 0.4, fee: undefined, vout: 2 });
    const s = summarize([stake, output], CAPTURED);
    assert.deepStrictEqual([s.countAll, s.totalRewards], [1, 0.4]);
});

test("not counted: unconfirmed, orphaned or abandoned stakes", () => {
    const stake = entries.find((e) => e.txid === STAKES[0]);
    const variants = [
        Object.assign({}, stake, { confirmations: 0 }),
        Object.assign({}, stake, { confirmations: -3 }),
        Object.assign({}, stake, { abandoned: true }),
        Object.assign({}, entries.find((e) => e.category === "immature"), { category: "orphan" }),
    ];
    assert.strictEqual(summarize(variants, CAPTURED).countAll, 0);
});

test("the 30-day window, an empty wallet, truncation", () => {
    const later = summarize(entries, CAPTURED + 31 * DAY);
    assert.deepStrictEqual([later.countAll, later.count, later.rewards30d], [7, 0, 0]);
    assert.strictEqual(summarize(null, CAPTURED).countAll, 0);
    assert.strictEqual(summarize([], CAPTURED).lastRewardAt, null);
    assert.strictEqual(summarize(entries, CAPTURED, 9).truncated, true);
    assert.strictEqual(summarize(entries, CAPTURED, 10).truncated, false);
});

test("reads listtransactions again only for a new wallet transaction or after 10 minutes; shares a running read; never caches a failure", async () => {
    let now = CAPTURED;
    let txcount = 2015;
    let fail = false;
    const calls = [];
    const rpc = (method, params, opts) => {
        calls.push({ method, params, opts });
        if (method === "getwalletinfo") return Promise.resolve({ txcount });
        if (fail) return Promise.reject(new Error("Requested wallet does not exist or is not loaded"));
        return new Promise((resolve) => setTimeout(() => resolve(entries), 5));
    };
    const reads = () => calls.filter((c) => c.method === "listtransactions").length;
    const get = createStakingSummary({ rpc, now: () => now });
    const [a, b] = await Promise.all([get(), get()]);
    assert.strictEqual(reads(), 1);
    assert.deepStrictEqual(calls.find((c) => c.method === "listtransactions").params, ["*", 100000, 0, true]);
    assert.strictEqual(calls[0].opts.wallet, true);
    assert.strictEqual(a, b);
    now += 9 * 60 * 1000;
    await get();
    assert.strictEqual(reads(), 1, "same wallet transactions within 10 minutes: cached");
    txcount += 1; // a stake came in
    await get();
    assert.strictEqual(reads(), 2, "a new wallet transaction: read again");
    now += 10 * 60 * 1000;
    fail = true;
    await assert.rejects(get(), /not loaded/);
    assert.strictEqual(reads(), 3);
    fail = false;
    const c = await get();
    assert.strictEqual(reads(), 4, "a failure is not cached");
    assert.strictEqual(c.countAll, 7);
});

test("when getwalletinfo fails, it reads listtransactions (and reports its error)", async () => {
    const rpc = (method) => (method === "getwalletinfo" ? Promise.reject(new Error("timeout")) : Promise.resolve(entries));
    const get = createStakingSummary({ rpc, now: () => CAPTURED });
    assert.strictEqual((await get()).countAll, 7);
});
