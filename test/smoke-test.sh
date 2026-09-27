#!/bin/bash
# Smoke test for a built Qtum package image, on regtest (no network, about 2 minutes).
#
#   test/smoke-test.sh qtum.avado.dnp.dappnode.eth:0.0.14
#
# Boots the image the way the package runs it (supervisord, monitor, nginx),
# with EXTRA_OPTS="-regtest -rpcport=3889", then calls every RPC the wizard
# uses through nginx /rpc and the monitor endpoints the wizard uses. A new Qtum
# release can remove RPCs (v30 removed dumpprivkey and importprivkey), which
# the build-time `qtumd -version` check does not notice; this does.
# Exits non-zero on the first failure and removes its container and volume.
set -eu
IMAGE=${1:?usage: $0 <image>}
NAME=qtum-smoke-$$
VOLUME=$NAME
fail() { echo "FAIL: $*"; docker logs "$NAME" 2>&1 | tail -30; exit 1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "$VOLUME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

rpc() { # method [params]: result, or fail
    local out
    out=$(docker exec "$NAME" curl -s -X POST http://127.0.0.1/rpc -H 'Content-Type: application/json' \
        -d "{\"jsonrpc\":\"1.0\",\"id\":\"smoke\",\"method\":\"$1\",\"params\":${2:-[]}}")
    echo "$out" | grep -q '"error":null' || fail "rpc $1 $2 -> $out"
    echo "$out"
}
monitor() { # method path [json]: body, with the header the wizard sends
    docker exec "$NAME" curl -s -X "$1" "http://127.0.0.1/monitor/$2" -H 'Content-Type: application/json' -H 'X-Qtum-Wizard: 1' ${3:+-d "$3"}
}
field() { sed -E "s/.*\"$1\":\"?([^\",}]*)\"?.*/\1/"; }

docker volume create "$VOLUME" >/dev/null
# qtumd refuses to start on regtest while addnode/rpcbind are set outside a
# network section, so the test drops those two mainnet lines from qtum.conf.
docker run --rm --platform linux/amd64 -v "$VOLUME:/package/data" --entrypoint sh "$IMAGE" -c \
    'awk "/^\[/{s=1} s || !/^(addnode|rpcbind)=/" /package/data/qtum.conf > /tmp/qtum.conf && cat /tmp/qtum.conf > /package/data/qtum.conf'
docker run -d --name "$NAME" --platform linux/amd64 -e "EXTRA_OPTS=-regtest -rpcport=3889" -v "$VOLUME:/package/data" "$IMAGE" >/dev/null

echo "waiting for the wallet"
for i in $(seq 1 180); do
    state=$(monitor GET walletstatus 2>/dev/null | field state || true)
    [ "$state" = ready ] && break
    [ "$state" = failed ] && fail "wallet status failed"
    sleep 2
done
[ "$state" = ready ] || fail "wallet not ready after 6 minutes (state: $state)"
echo "ok   wallet ready"

address=$(rpc getnewaddress '["","legacy"]' | field result)
rpc generatetoaddress "[1,\"$address\"]" >/dev/null
for method in getblockchaininfo getbalances getstakinginfo getconnectioncount; do
    rpc $method >/dev/null && echo "ok   $method"
done
rpc listlabels >/dev/null && echo "ok   listlabels"
rpc getaddressesbylabel '[""]' | grep -q "$address" || fail "getaddressesbylabel does not list $address"
echo "ok   getnewaddress, getaddressesbylabel"
rpc backupwallet '["/tmp/wallet.backup"]' >/dev/null
docker exec "$NAME" head -c 15 /tmp/wallet.backup | grep -q "SQLite format 3" || fail "backupwallet did not write a wallet file"
echo "ok   backupwallet"

wif=$(monitor POST privkey "{\"address\":\"$address\"}" | field privateKey)
checksum=$(rpc getdescriptorinfo "[\"pkh($wif)\"]" | field checksum)
rpc deriveaddresses "[\"pkh($wif)#$checksum\"]" | grep -q "$address" || fail "the exported private key does not belong to $address"
echo "ok   monitor privkey (the key re-derives the address)"
monitor GET getenv | grep -q DELEGATION_FEE_PERCENT || fail "monitor getenv"
echo "ok   monitor getenv"
code=$(docker exec "$NAME" curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1/monitor/privkey -H 'Content-Type: application/json' -d "{\"address\":\"$address\"}")
[ "$code" = 403 ] || fail "privkey without the wizard header answered $code"
echo "ok   key endpoints refuse requests without the wizard header"
monitor POST backupdone '{}' | grep -q '"ok":true' || fail "monitor backupdone"
echo "ok   monitor backupdone"
echo "PASS"
