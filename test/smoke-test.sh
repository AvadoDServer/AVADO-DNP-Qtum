#!/bin/bash
# Smoke test for a built Qtum package image, on regtest (no network, about 2 minutes).
#
#   test/smoke-test.sh qtum.avado.dnp.dappnode.eth:0.0.15
#
# Boots the image the way the package runs it (supervisord, monitor, nginx),
# with EXTRA_OPTS="-regtest -rpcport=3889", then calls every RPC the Qtum
# Staking app (the package's page, "the wizard" below) uses through nginx /rpc
# and the monitor endpoints it uses. A new Qtum
# release can remove RPCs (v30 removed dumpprivkey and importprivkey), which
# the build-time `qtumd -version` check does not notice; this does. It also
# checks that other web sites cannot use /rpc or change anything in the monitor,
# and which page each address opens: the wizard on http and https, the Qtum
# Web Wallet on https port 8443.
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
# the node's own command line tool (for slow calls nginx would time out)
cli() { docker exec "$NAME" qtum-cli -regtest -rpcport=3889 -rpcuser=avado -rpcpassword=avado1234 "$@"; }
# the coins the wallet staked itself: Qtum v30 lists each such coinstake as a
# "send" of 0 whose fee is the (positive) reward
own_stakes() {
    local out
    out=$(cli -rpcwallet= listtransactions "*" 500 0 true 2>/dev/null \
        | jq -c '[.[] | select(.category == "send" and .generated == true and .fee > 0 and .confirmations > 0)]' 2>/dev/null || true)
    echo "${out:-[]}"
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
for method in getblockchaininfo getnetworkinfo getbalances getwalletinfo getstakinginfo getconnectioncount; do
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

# The Qtum Staking app's own monitor routes (0.0.17): rewards, the node log,
# the backup download and upload (they replace the old wizard's WAMP copy).
summary=$(monitor GET staking-summary)
echo "$summary" | grep -q '"totalRewards":' || fail "monitor staking-summary: $summary"
# regtest: the one block mined above is the wallet's only (immature) reward
echo "$summary" | grep -q '"countAll":1' || fail "monitor staking-summary does not count the mined block: $summary"
echo "ok   monitor staking-summary"
logs=$(monitor GET 'logs?lines=5')
echo "$logs" | grep -q '"lines":\[' || fail "monitor logs: $logs"
[ "$(echo "$logs" | grep -o '","' | wc -l)" -le 4 ] || fail "monitor logs sent more than 5 lines: $logs"
monitor GET 'logs?lines=3' | grep -q 'UpdateTip\|"lines":\["' || fail "monitor logs has no log lines"
echo "ok   monitor logs"
for route in staking-summary logs; do
    code=$(docker exec "$NAME" curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1/monitor/$route")
    [ "$code" = 403 ] || fail "$route without the wizard header answered $code"
done
echo "ok   staking-summary and logs refuse requests without the wizard header"
docker exec "$NAME" sh -c 'curl -s -D /tmp/backup.headers -o /tmp/download.dat -X POST http://127.0.0.1/monitor/backup -H "X-Qtum-Wizard: 1"'
docker exec "$NAME" head -c 15 /tmp/download.dat | grep -q "SQLite format 3" || fail "monitor backup did not send a wallet file"
docker exec "$NAME" grep -qi 'content-disposition: attachment; filename="qtum-wallet-' /tmp/backup.headers || fail "monitor backup has no file name"
[ -z "$(docker exec "$NAME" sh -c 'ls /tmp | grep qtum-wallet-download- || true')" ] || fail "monitor backup left its copy in /tmp"
echo "ok   monitor backup (the wallet file, the copy removed)"
code=$(docker exec "$NAME" curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1/monitor/backup)
[ "$code" = 403 ] || fail "backup without the wizard header answered $code"
# a backup larger than nginx's default 1 MB body limit is accepted
docker exec "$NAME" sh -c 'head -c 3000000 /dev/urandom > /tmp/big.dat'
answer=$(docker exec "$NAME" curl -s -X POST http://127.0.0.1/monitor/uploadbackup -H 'X-Qtum-Wizard: 1' \
    -H 'Content-Type: application/octet-stream' --data-binary @/tmp/big.dat)
echo "$answer" | grep -q '"file":"wallet-upload.dat"' || fail "monitor uploadbackup: $answer"
[ "$(docker exec "$NAME" stat -c %s /package/data/restore/wallet-upload.dat)" = 3000000 ] || fail "the uploaded backup is not complete"
docker exec "$NAME" rm -f /package/data/restore/wallet-upload.dat /tmp/big.dat /tmp/download.dat /tmp/backup.headers
echo "ok   monitor uploadbackup (3 MB, where /restore expects it)"

# Inside the container, qtum.my.ava.do is the container itself, as on the box
# (the certificate is the *.my.ava.do one, so curl gets the right name).
curlq() {
    docker exec "$NAME" curl -sk --resolve qtum.my.ava.do:80:127.0.0.1 \
        --resolve qtum.my.ava.do:443:127.0.0.1 --resolve qtum.my.ava.do:8443:127.0.0.1 "$@"
}

# Which page each address opens. The Qtum Web Wallet was on https port 443
# until 0.0.14; now qtum.my.ava.do is the wizard on http and https (browsers
# open https when you type the address), and the Web Wallet is on port 8443.
title() { curlq "$1" | grep -o '<title>[^<]*</title>' || true; }
opens() { # url expected-title description
    [ "$(title "$1")" = "<title>$2</title>" ] || fail "$1 opens \"$(title "$1")\", not $2"
    echo "ok   $3"
}
opens http://qtum.my.ava.do/ "AVADO Qtum Staking" "http://qtum.my.ava.do opens the Qtum Staking app"
opens https://qtum.my.ava.do/ "AVADO Qtum Staking" "https://qtum.my.ava.do opens the Qtum Staking app"
opens http://qtum.my.ava.do/wallet "AVADO Qtum Staking" "a deep link (/wallet) opens the app too"
script=$(curlq https://qtum.my.ava.do/ | grep -o 'src="/assets/[^"]*\.js"' | head -n1 | cut -d'"' -f2)
[ -n "$script" ] && [ "$(curlq -o /dev/null -w '%{http_code}' "https://qtum.my.ava.do$script")" = 200 ] \
    || fail "the Qtum Staking app's script $script does not load"
echo "ok   the Qtum Staking app's script loads"
opens https://qtum.my.ava.do:8443/ "Qtum Web Wallet" "https://qtum.my.ava.do:8443 opens the Qtum Web Wallet"
script=$(curlq https://qtum.my.ava.do:8443/ | grep -o 'src="/js/app[^"]*"' | head -n1 | cut -d'"' -f2)
[ -n "$script" ] && [ "$(curlq -o /dev/null -w '%{http_code}' "https://qtum.my.ava.do:8443$script")" = 200 ] \
    || fail "the Qtum Web Wallet's script $script does not load"
echo "ok   the Qtum Web Wallet's scripts load"
answer=$(curlq -o /dev/null -w '%{http_code} %{redirect_url}' http://qtum.my.ava.do:8443/)
[ "$answer" = "301 https://qtum.my.ava.do:8443/" ] || fail "http://qtum.my.ava.do:8443 answered: $answer"
echo "ok   http://qtum.my.ava.do:8443 goes to https"

# Browsers send an Origin header. /rpc (it adds the RPC password), /ws (the
# connection to the AVADO) and the monitor calls that change something only
# accept the wizard's own page, over the scheme it was opened with; reading
# the monitor stays open to other pages.
from() { # origin method url [json]: status line and CORS header of the answer
    curlq -o /dev/null -D - -X "$2" "$3" -H "Origin: $1" -H 'Content-Type: application/json' ${4:+-d "$4"} \
        | tr -d '\r' | grep -iE '^HTTP/|^access-control-allow-origin' | tr '\n' ' '
}
getblockcount='{"jsonrpc":"1.0","id":"smoke","method":"getblockcount","params":[]}'
fee='{"DELEGATION_FEE_PERCENT":10}'
check() { # expected-status expected-cors(yes|no) answer description
    echo "$3" | grep -q " $1 " || fail "$4: expected HTTP $1, got: $3"
    if [ "$2" = yes ]; then
        echo "$3" | grep -qi 'access-control-allow-origin: \*' || fail "$4: no CORS header: $3"
    elif echo "$3" | grep -qi 'access-control-allow-origin'; then
        fail "$4: unexpected CORS header: $3"
    fi
    echo "ok   $4"
}
for wizard in http://qtum.my.ava.do https://qtum.my.ava.do; do
    over=${wizard%%:*}
    check 200 no "$(from $wizard POST $wizard/rpc "$getblockcount")" "$over: /rpc from the wizard's own page"
    check 403 no "$(from $over://evil.example POST $wizard/rpc "$getblockcount")" "$over: /rpc from another web site is refused"
    check 403 no "$(from null POST $wizard/rpc "$getblockcount")" "$over: /rpc from a sandboxed page (Origin null) is refused"
    check 403 no "$(from $over://evil.example OPTIONS $wizard/rpc)" "$over: /rpc preflight from another web site is refused"
    check 403 no "$(from https://qtum.my.ava.do:8443 POST $wizard/rpc "$getblockcount")" "$over: /rpc from the Qtum Web Wallet's page is refused"
    check 403 no "$(from $over://evil.example POST $wizard/monitor/setenv "$fee")" "$over: monitor setenv from another web site is refused"
    check 403 no "$(from $over://evil.example POST $wizard/monitor/restartQtum)" "$over: monitor restartQtum from another web site is refused"
    check 200 no "$(from $wizard POST $wizard/monitor/setenv "$fee")" "$over: monitor setenv from the wizard's own page"
    check 200 yes "$(from $over://evil.example GET $wizard/monitor/walletstatus)" "$over: monitor walletstatus stays readable from other pages"
    check 403 no "$(from $over://evil.example POST $wizard/monitor/uploadbackup)" "$over: monitor uploadbackup from another web site is refused"
done
# the page opened over one scheme cannot use the other one
check 403 no "$(from http://qtum.my.ava.do POST https://qtum.my.ava.do/rpc "$getblockcount")" "/rpc over https from the http page is refused"
check 403 no "$(from https://qtum.my.ava.do POST http://qtum.my.ava.do/rpc "$getblockcount")" "/rpc over http from the https page is refused"
# the Web Wallet's address serves only the Web Wallet's files
curlq -X POST https://qtum.my.ava.do:8443/rpc -H 'Content-Type: application/json' -d "$getblockcount" | grep -q '"result"' \
    && fail "https://qtum.my.ava.do:8443/rpc answers RPC calls"
echo "ok   the Qtum Web Wallet's address has no /rpc"
# 0.0.17 no longer passes /ws on to the AVADO's WAMP (nothing uses it): the
# address is the app's page now
curlq -H 'Upgrade: websocket' -H 'Connection: Upgrade' http://qtum.my.ava.do/ws | grep -q '<title>AVADO Qtum Staking</title>' \
    || fail "/ws still reaches something else than the app"
echo "ok   /ws no longer reaches WAMP"
# only the upload route takes a large body
code=$(docker exec "$NAME" sh -c 'head -c 2000000 /dev/zero | curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1/monitor/setenv -H "Content-Type: application/json" --data-binary @-')
[ "$code" = 413 ] || fail "a 2 MB body to setenv answered $code, not 413"
code=$(docker exec "$NAME" curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1/monitor/uploadbackup -H 'X-Qtum-Wizard: 1' -d 'x')
[ "$code" = 415 ] || fail "an upload that is not a file answered $code, not 415"
echo "ok   large bodies only on the upload route; the upload takes files only"

# Proof of stake: rewards for coins the wallet staked itself. Qtum v30 lists
# such a coinstake as a "send" of 0 with the reward as a positive fee; the
# staking summary must count it. 2010 blocks make coins old enough to stake;
# after a restart the regtest node stakes them within a few minutes.
echo "mining 2010 blocks so that the wallet can stake"
cli generatetoaddress 2010 "$address" >/dev/null
# the summary and the wallet's own stakes, read while no new stake came in
read_both() { # -> sets summary, stakes
    for _ in 1 2 3 4 5; do
        local s1
        s1=$(own_stakes)
        summary=$(monitor GET staking-summary)
        stakes=$(own_stakes)
        [ "$(echo "$s1" | jq length)" = "$(echo "$stakes" | jq length)" ] && return 0
    done
    fail "the wallet kept staking while the summary was read"
}
read_both
before=$summary
before_stakes=$stakes
monitor POST restartQtum >/dev/null
for i in $(seq 1 90); do
    sleep 10
    [ "$(own_stakes | jq length)" -gt "$(echo "$before_stakes" | jq length)" ] && break
done
read_both
new_stakes=$(jq -n --argjson a "$stakes" --argjson b "$before_stakes" '($a | length) - ($b | length)')
[ "$new_stakes" -ge 1 ] || fail "the wallet did not stake within 15 minutes"
earned=$(jq -n --argjson a "$stakes" --argjson b "$before_stakes" '($a | map(.fee) | add) - (($b | map(.fee) | add) // 0)')
counted=$(jq -n --argjson a "$summary" --argjson b "$before" '$a.countAll - $b.countAll')
gained=$(jq -n --argjson a "$summary" --argjson b "$before" '$a.totalRewards - $b.totalRewards')
[ "$counted" = "$new_stakes" ] || fail "staking summary counted $counted new rewards, the wallet staked $new_stakes times: $summary"
jq -n --argjson g "$gained" --argjson e "$earned" '$e > 0 and (($g - $e) | fabs) < 0.00000001' | grep -q true \
    || fail "staking summary gained $gained QTUM, the stakes earned $earned: $summary"
echo "ok   proof of stake: $new_stakes stake(s) of the wallet's own coins counted, $earned QTUM earned (Total earned grew by it)"
echo "PASS"
