// GET /logs: the last lines of debug.log, keys hidden.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { lineCount, tailLines, readLog, scrub } = require("../logtail");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qtum-logtail-"));
const write = (name, text) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, text);
    return file;
};
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("the number of lines: 1 to 2000, 200 when missing or not a number", () => {
    assert.strictEqual(lineCount(undefined), 200);
    assert.strictEqual(lineCount(null), 200);
    assert.strictEqual(lineCount("abc"), 200);
    assert.strictEqual(lineCount("0"), 200);
    assert.strictEqual(lineCount("-5"), 200);
    assert.strictEqual(lineCount("50"), 50);
    assert.strictEqual(lineCount("99999"), 2000);
});

test("reads the last lines, also across read chunks, and none of a missing file", () => {
    const lines = [];
    for (let i = 1; i <= 5000; i++) lines.push(`2026-10-13T10:00:00Z line ${i} ${"x".repeat(40)}`);
    const file = write("debug.log", `${lines.join("\n")}\n`);
    assert.deepStrictEqual(tailLines(file, 3), lines.slice(-3));
    assert.deepStrictEqual(tailLines(file, 2000), lines.slice(-2000));
    assert.deepStrictEqual(tailLines(write("short.log", "one\ntwo"), 10), ["one", "two"]);
    assert.deepStrictEqual(tailLines(path.join(tmp, "missing.log"), 10), []);
    assert.deepStrictEqual(tailLines(write("empty.log", ""), 10), []);
});

test("never reads more than the byte limit, and drops a line cut off at its start", () => {
    const file = write("long.log", `${"a".repeat(300)}\n${"b".repeat(10)}\n${"c".repeat(10)}\n`);
    assert.deepStrictEqual(tailLines(file, 10, 25), ["b".repeat(10), "c".repeat(10)]);
});

test("hides anything that could be a key: WIF keys, extended keys, 64 hex digits", () => {
    const wif = "cVpF924EspNh8KjYsfhgY96mmxvT6DgdWiTYMtMjuM74hJaU5psW";
    const xprv = "tprv8ZgxMBicQKsPd7Uf69XL1XwhmjHopUGep8GuEiJDZmbQz6o58LninorQAfcKZWARbtRtfnLcJ5MQ2AtHcQJCCRUcMRvmDUjyEmNUWwx8UbK";
    const hex = "0f".repeat(32);
    const file = write("secrets.log", `wallet key ${wif}\nimport ${xprv}\nraw ${hex} done\naddress QgHkG8Ffz6wfBDoQXQdEYvJbkmCkcyzMnb kept\n`);
    const out = readLog(file, "10");
    assert.deepStrictEqual(out, ["wallet key [key]", "import [key]", "raw [key] done", "address QgHkG8Ffz6wfBDoQXQdEYvJbkmCkcyzMnb kept"]);
    assert.strictEqual(scrub(`x ${wif}`), "x [key]");
});
