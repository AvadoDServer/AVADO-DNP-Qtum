#!/bin/bash
# Generates the legacy-wallet fixtures for the monitor tests (regtest keys,
# no real coins). Needs Docker (amd64 emulation is fine).
#
#   build/monitor/test/fixtures/generate.sh <package image> [out dir]
#
# 1. qtum/qtum:22.1 (the Qtum Core version that made the AVADO wallets)
#    creates four legacy (Berkeley DB) wallets on regtest: make-wallets.sh.
#    Its `dumpwallet` output is the ground truth.
# 2. The Qtum v29.1 wallet tool in the package image (the one the rebuild
#    uses) dumps every record of each wallet: <name>.dump.
#    The wallet files are kept as <name>.wallet.dat (for bdbfile.js).
# 3. groundtruth.js turns the `dumpwallet` output into <name>.truth.json.
# 4. v30-check.sh: the Qtum v30.2 node of the package image computes the
#    checksums of the descriptors the rebuild makes (<name>.descinfo.json),
#    imports them into a new wallet (<name>.rebuilt.json) and migrates the
#    same wallet with its own `migratewallet` (<name>.migrated.json).
#
# Without [out dir] the fixtures are written next to this script. With an
# [out dir], the regtest chain and the wallet files stay in <out dir>/work
# (the end-to-end test test/rebuild-e2e.sh uses them).
set -euo pipefail
IMAGE=${1:?usage: $0 <package image> [out dir]}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${2:-$HERE}
OLD_QTUM=qtum/qtum:22.1
WORK=$OUT/work
rm -rf "$WORK"
mkdir -p "$WORK"

newkey() { node -e '
const k = require(process.argv[1]);
const crypto = require("crypto");
console.log(k.encodeWif(crypto.randomBytes(32), 0xef, process.argv[2] === "c"));' "$HERE/../../qtumkeys.js" "$1"; }
PASSPHRASE="regtest only $(node -e 'console.log(require("crypto").randomBytes(6).toString("hex"))')"

cp "$HERE/make-wallets.sh" "$WORK/make-wallets.sh"
docker run --rm --platform linux/amd64 -u root -v "$WORK:/out" --entrypoint sh "$OLD_QTUM" /out/make-wallets.sh \
    "$(newkey c)" "$(newkey u)" "$(newkey c)" "$(newkey c)" "$(newkey u)" "$PASSPHRASE"
rm "$WORK/make-wallets.sh"
printf '%s' "$PASSPHRASE" > "$WORK/hd-encrypted.passphrase"

for wallet in hd-plain hd-encrypted hd-imported nonhd; do
    tmp=$WORK/dump-$wallet
    mkdir -p "$tmp/wallets"
    cp "$WORK/regtest/wallets/$wallet/wallet.dat" "$tmp/wallets/wallet.dat"
    docker run --rm --platform linux/amd64 -v "$tmp:/w" --entrypoint /usr/local/lib/qtum-legacy/qtum-wallet "$IMAGE" \
        -datadir=/w -wallet= -dumpfile=/w/out.dump dump >/dev/null
    cp "$tmp/out.dump" "$OUT/$wallet.dump"
    # the wallet file itself, for the tests of the direct (raw page) reader
    cp "$WORK/regtest/wallets/$wallet/wallet.dat" "$OUT/$wallet.wallet.dat"
    rm -rf "$tmp"
    node "$HERE/groundtruth.js" "$WORK/$wallet.dumpwallet" "$WORK/$wallet.info.json" \
        $([ $wallet = hd-encrypted ] && echo "$WORK/hd-encrypted.passphrase") > "$OUT/$wallet.truth.json"
done
# 4. The Qtum v30.2 node in the package image checks the descriptors the
#    rebuild would import (checksums) and migrates the same wallets with its
#    own `migratewallet`, to compare the result: v30-check.sh.
check=$WORK/v30-check
mkdir -p "$check/regtest/wallets" "$check/out"
cp -R "$WORK/regtest/blocks" "$WORK/regtest/chainstate" "$WORK/regtest/stateQtum" "$check/regtest/"
for wallet in hd-plain hd-encrypted hd-imported nonhd; do
    mkdir -p "$check/regtest/wallets/legacy-$wallet"
    cp "$WORK/regtest/wallets/$wallet/wallet.dat" "$check/regtest/wallets/legacy-$wallet/"
    node "$HERE/descriptors.js" "$OUT/$wallet.dump" \
        $([ $wallet = hd-encrypted ] && echo "$WORK/hd-encrypted.passphrase") > "$check/$wallet.request.json"
done
cp "$WORK/hd-encrypted.passphrase" "$check/"
cp "$HERE/v30-check.sh" "$check/"
docker run --rm --platform linux/amd64 -v "$check:/w" --entrypoint sh "$IMAGE" /w/v30-check.sh
for wallet in hd-plain hd-encrypted hd-imported nonhd; do
    cp "$check/out/$wallet.descinfo.json" "$check/out/$wallet.rebuilt.json" "$check/out/$wallet.migrated.json" "$OUT/"
done
rm -rf "$check"

# the committed fixtures need neither the chain nor the wallet files
[ "$OUT" = "$HERE" ] && rm -rf "$WORK"
echo "fixtures written to $OUT"
