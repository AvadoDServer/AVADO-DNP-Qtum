// Private key helpers for Qtum descriptor wallets.
//
// Qtum v30 (Bitcoin Core 30) removed `dumpprivkey` and `importprivkey`.
// A descriptor wallet still knows every private key, but only as part of
// its descriptors (`listdescriptors true`): either a single key in WIF form
// (imported keys, e.g. `combo(WIF)`) or an extended private key plus a
// derivation path (e.g. `pkh(xprv/44h/88h/0h/0/*)`, or `combo(xprv/0h/0h/*h)`
// after a legacy wallet was migrated).
//
// findPrivateKey() finds the key for one address and returns it as WIF, the
// same format `dumpprivkey` used to return. A key is only returned when its
// public key equals the public key the wallet reports for the address, so a
// wrong key can never be shown.
//
// Only Node built-ins are used (Node 12 compatible).

const crypto = require("crypto");

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// secp256k1 group order
const CURVE_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const HARDENED = 0x80000000;

// WIF prefix per chain (Qtum chainparams: mainnet 128, testnet/regtest 239)
const WIF_PREFIX = { main: 0x80, test: 0xef, testnet4: 0xef, signet: 0xef, regtest: 0xef };

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest();
const hash256 = (buf) => sha256(sha256(buf));

function base58Decode(str) {
    let num = BigInt(0);
    for (const ch of str) {
        const idx = B58_ALPHABET.indexOf(ch);
        if (idx < 0) throw new Error("invalid base58 character");
        num = num * BigInt(58) + BigInt(idx);
    }
    let hex = num.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    const body = num === BigInt(0) ? Buffer.alloc(0) : Buffer.from(hex, "hex");
    let zeros = 0;
    while (zeros < str.length && str[zeros] === "1") zeros++;
    return Buffer.concat([Buffer.alloc(zeros), body]);
}

function base58Encode(buf) {
    let num = buf.length ? BigInt("0x" + buf.toString("hex")) : BigInt(0);
    let out = "";
    while (num > BigInt(0)) {
        out = B58_ALPHABET[Number(num % BigInt(58))] + out;
        num = num / BigInt(58);
    }
    for (let i = 0; i < buf.length && buf[i] === 0; i++) out = "1" + out;
    return out;
}

function base58CheckDecode(str) {
    const raw = base58Decode(str);
    if (raw.length < 5) throw new Error("too short");
    const payload = raw.slice(0, raw.length - 4);
    const checksum = raw.slice(raw.length - 4);
    if (!hash256(payload).slice(0, 4).equals(checksum)) throw new Error("bad checksum");
    return payload;
}

function base58CheckEncode(payload) {
    return base58Encode(Buffer.concat([payload, hash256(payload).slice(0, 4)]));
}

function publicKeyFromPrivate(privateKey, compressed = true) {
    const ecdh = crypto.createECDH("secp256k1");
    ecdh.setPrivateKey(privateKey);
    return ecdh.getPublicKey(null, compressed ? "compressed" : "uncompressed");
}

function to32Bytes(n) {
    return Buffer.from(n.toString(16).padStart(64, "0"), "hex");
}

function ser32(index) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(index >>> 0, 0);
    return b;
}

// BIP32 CKDpriv
function deriveChild(node, index) {
    const data = index >= HARDENED
        ? Buffer.concat([Buffer.alloc(1), node.key, ser32(index)])
        : Buffer.concat([publicKeyFromPrivate(node.key, true), ser32(index)]);
    const I = crypto.createHmac("sha512", node.chainCode).update(data).digest();
    const il = BigInt("0x" + I.slice(0, 32).toString("hex"));
    if (il >= CURVE_N) throw new Error("invalid child key");
    const k = (il + BigInt("0x" + node.key.toString("hex"))) % CURVE_N;
    if (k === BigInt(0)) throw new Error("invalid child key");
    return { key: to32Bytes(k), chainCode: I.slice(32) };
}

// "m/44h/88h/0h/0/5", "m/0'/0'/5'" or "/0h/0h" -> [indexes]
function parsePath(path) {
    if (!path) return [];
    return path.split("/")
        .filter((p) => p !== "" && p !== "m")
        .map((p) => {
            const hardened = /['hH]$/.test(p);
            const n = parseInt(hardened ? p.slice(0, -1) : p, 10);
            if (!Number.isInteger(n) || n < 0 || n >= HARDENED || !/^\d+['hH]?$/.test(p)) {
                throw new Error(`invalid path element ${p}`);
            }
            return hardened ? n + HARDENED : n;
        });
}

function startsWith(path, prefix) {
    if (prefix.length > path.length) return false;
    return prefix.every((v, i) => path[i] === v);
}

// Decode a WIF private key. Returns null when the string is not a WIF key.
function decodeWif(wif) {
    let payload;
    try {
        payload = base58CheckDecode(wif);
    } catch (e) {
        return null;
    }
    if (payload.length === 33) return { prefix: payload[0], key: payload.slice(1, 33), compressed: false };
    if (payload.length === 34 && payload[33] === 0x01) return { prefix: payload[0], key: payload.slice(1, 33), compressed: true };
    return null;
}

function encodeWif(key, prefix, compressed = true) {
    const parts = [Buffer.from([prefix]), key];
    if (compressed) parts.push(Buffer.from([0x01]));
    return base58CheckEncode(Buffer.concat(parts));
}

// Decode an extended private key (xprv/tprv). Returns null otherwise.
function decodeExtendedPrivateKey(str) {
    let payload;
    try {
        payload = base58CheckDecode(str);
    } catch (e) {
        return null;
    }
    if (payload.length !== 78 || payload[45] !== 0x00) return null;
    return {
        depth: payload[4],
        chainCode: payload.slice(13, 45),
        key: payload.slice(46, 78),
    };
}

// Every key expression inside a descriptor, e.g. for
// "pkh([d34db33f/44h/88h/0h]xprv.../0/*)#checksum" ->
//   { originPath: "/44h/88h/0h", key: "xprv...", path: "/0" }
const KEY_EXPRESSION = /(?:\[([0-9a-fA-F]{8})((?:\/\d+['hH]?)*)\])?([1-9A-HJ-NP-Za-km-z]{50,120})((?:\/\d+['hH]?)*)(\/\*['hH]?)?/g;

function keyExpressions(descriptor) {
    const body = String(descriptor).split("#")[0];
    const out = [];
    let m;
    KEY_EXPRESSION.lastIndex = 0;
    while ((m = KEY_EXPRESSION.exec(body)) !== null) {
        out.push({ hasOrigin: m[1] !== undefined, originPath: m[2] || "", key: m[3], path: m[4] || "" });
    }
    return out;
}

/**
 * Find the private key for one address.
 *
 * @param {Array<{desc: string}>} descriptors result of `listdescriptors true`
 * @param {{pubkey: string, hdkeypath?: string}} target from `getaddressinfo`
 * @param {string} chain `getblockchaininfo().chain` ("main", "test", ...)
 * @returns {string|null} WIF private key, or null when not found
 */
function findPrivateKey(descriptors, target, chain) {
    const wantPubkey = String(target.pubkey || "").toLowerCase();
    if (!wantPubkey) return null;
    const hdPath = target.hdkeypath ? parsePath(target.hdkeypath) : null;
    const wifPrefix = WIF_PREFIX[chain] !== undefined ? WIF_PREFIX[chain] : WIF_PREFIX.main;

    for (const d of descriptors || []) {
        for (const expr of keyExpressions(d.desc)) {
            // Single imported key, e.g. combo(WIF)
            const wif = decodeWif(expr.key);
            if (wif) {
                if (publicKeyFromPrivate(wif.key, wif.compressed).toString("hex") === wantPubkey) {
                    return expr.key;
                }
                continue;
            }

            // Extended key with a derivation path
            const ext = decodeExtendedPrivateKey(expr.key);
            if (!ext || !hdPath) continue;
            let keyPosition;
            if (expr.hasOrigin) keyPosition = parsePath(expr.originPath);
            else if (ext.depth === 0) keyPosition = [];
            else continue; // unknown position of a non-master key
            if (!startsWith(hdPath, keyPosition)) continue;

            let node = { key: ext.key, chainCode: ext.chainCode };
            try {
                for (const index of hdPath.slice(keyPosition.length)) node = deriveChild(node, index);
            } catch (e) {
                continue;
            }
            if (publicKeyFromPrivate(node.key, true).toString("hex") === wantPubkey) {
                return encodeWif(node.key, wifPrefix, true);
            }
        }
    }
    return null;
}

module.exports = {
    findPrivateKey,
    decodeWif,
    encodeWif,
    parsePath,
    keyExpressions,
    deriveChild,
    decodeExtendedPrivateKey,
    publicKeyFromPrivate,
    base58CheckDecode,
    base58CheckEncode,
};
