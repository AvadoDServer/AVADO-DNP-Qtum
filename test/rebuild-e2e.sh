#!/bin/bash
# End-to-end test of "Rebuild the wallet from the old copy", on regtest
# (no network, about 10 minutes with amd64 emulation).
#
#   test/rebuild-e2e.sh qtum.avado.dnp.dappnode.eth:0.0.15
#
# 1. build/monitor/test/fixtures/generate.sh makes legacy wallets with Qtum
#    Core v22.1 and a regtest chain where they have coins.
# 2. For each case the package image boots with a legacy wallet as its default
#    wallet and the test switch fail-migration (the upgrade fails, as on the
#    AVADO this is for), then the test presses "Rebuild" (POST /monitor/rebuild)
#    and checks the result against what Qtum v22.1 reported for the wallet:
#    same balance, every address is the wallet's own, labels, the old wallet
#    kept, the new wallet in the new format, nothing to rebuild a second time,
#    and no key or password in the log.
# 3. Failure cases: wrong password, a rebuilt wallet that misses a key
#    (drop-one-key), a rebuild interrupted by a container restart, a new
#    wallet that cannot be closed (unload-fails), a stop in the middle of the
#    final swap (crash-during-swap, crash-during-swap-partial), a wallet in
#    place that is not the saved copy, a saved copy that is gone, and a
#    wallet file cut short (a real migratewallet failure; the wallet tool
#    cannot dump it, so the rebuild reads its pages directly).
# Exits non-zero on the first failure and removes its containers and volumes.
set -euo pipefail
IMAGE=${1:?usage: $0 <image>}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(mktemp -d)
NAME=""
VOLUME=""
fail() { echo "FAIL: $*"; [ -n "$NAME" ] && docker logs "$NAME" 2>&1 | grep -v '^\s*$' | tail -40; exit 1; }
cleanup() {
    [ -n "$NAME" ] && docker rm -f "$NAME" >/dev/null 2>&1 || true
    [ -n "$VOLUME" ] && docker volume rm "$VOLUME" >/dev/null 2>&1 || true
    rm -rf "$OUT"
}
trap cleanup EXIT

echo "making legacy wallets with Qtum v22.1"
"$HERE/../build/monitor/test/fixtures/generate.sh" "$IMAGE" "$OUT" >/dev/null 2>&1 || fail "generate.sh"
WORK=$OUT/work

monitor() { # method path [json]
    docker exec "$NAME" curl -s -X "$1" "http://127.0.0.1/monitor/$2" -H 'Content-Type: application/json' -H 'X-Qtum-Wizard: 1' ${3:+-d "$3"}
}
cli() { docker exec "$NAME" qtum-cli -regtest -rpcport=3889 -rpcuser=avado -rpcpassword=avado1234 "$@"; }
in_box() { docker exec "$NAME" sh -c "$1"; }
# grep the container log (read whole first: grep -q would cut the pipe, and pipefail would see that)
log_has() { local logs; logs=$(docker logs "$NAME" 2>&1); grep -qF "$1" <<<"$logs"; }
status() { # {} while the monitor does not answer (nginx then sends an HTML error page)
    local out
    out=$(monitor GET walletstatus 2>/dev/null || true)
    if jq -e . >/dev/null 2>&1 <<<"$out"; then echo "$out"; else echo '{}'; fi
}
state() { status | jq -r '.state // empty'; }
wait_state() { # wanted states (regex), seconds
    local s="" i
    for i in $(seq 1 "$2"); do
        s=$(state)
        echo "$s" | grep -qE "^($1)$" && return 0
        sleep 1
    done
    fail "wallet state $s, expected $1"
}

start() { # wallet hooks [another wallet, copied to /package/data/other-wallet.dat]
    NAME=qtum-rebuild-$$-$1
    VOLUME=$NAME
    docker volume create "$VOLUME" >/dev/null
    docker run --rm --platform linux/amd64 -v "$VOLUME:/package/data" -v "$WORK:/src:ro" --entrypoint sh "$IMAGE" -c "
        awk '/^\[/{s=1} s || !/^(addnode|rpcbind)=/' /package/data/qtum.conf > /tmp/qtum.conf && cat /tmp/qtum.conf > /package/data/qtum.conf
        mkdir -p /package/data/qtum/regtest/wallets
        cp -R /src/regtest/blocks /src/regtest/chainstate /src/regtest/stateQtum /package/data/qtum/regtest/
        cp /src/regtest/wallets/$1/wallet.dat /package/data/qtum/regtest/wallets/wallet.dat
        [ -z '${3:-}' ] || cp /src/regtest/wallets/${3:-none}/wallet.dat /package/data/other-wallet.dat"
    docker run -d --name "$NAME" --platform linux/amd64 -e "EXTRA_OPTS=-regtest -rpcport=3889" \
        -e "QTUM_MONITOR_TEST_HOOKS=$2" -v "$VOLUME:/package/data" "$IMAGE" >/dev/null
}

stop() {
    docker rm -f "$NAME" >/dev/null
    docker volume rm "$VOLUME" >/dev/null
    NAME=""
    VOLUME=""
}

legacy_sha() { in_box 'sha256sum /package/data/qtum/regtest/wallets/wallet.dat | cut -c1-64'; }
wallet_kind() { in_box 'head -c 16 /package/data/qtum/regtest/wallets/wallet.dat | grep -q "SQLite format 3" && echo sqlite || echo other'; }

no_secrets_in_log() { # wallet
    local truth=$OUT/$1.truth.json logs
    logs=$(docker logs "$NAME" 2>&1)
    for wif in $(jq -r '.keys[].wif' "$truth"); do
        if grep -qF "$wif" <<<"$logs"; then fail "a private key of $1 is in the log"; fi
    done
    local master pass
    master=$(jq -r '.masterKey // empty' "$truth")
    if [ -n "$master" ] && grep -qF "$master" <<<"$logs"; then fail "the master key of $1 is in the log"; fi
    pass=$(jq -r '.passphrase // empty' "$truth")
    if [ -n "$pass" ] && grep -qF "$pass" <<<"$logs"; then fail "the password of $1 is in the log"; fi
    if grep -qE '[tx]prv[1-9A-HJ-NP-Za-km-z]{100,}' <<<"$logs"; then fail "an extended private key is in the log"; fi
    echo "ok   $1: no key, master key or password in the log"
}

rebuild_ok() { # wallet [passphrase]
    local wallet=$1 truth=$OUT/$1.truth.json body='{}'
    [ -n "${2:-}" ] && body=$(jq -nc --arg p "$2" '{passphrase: $p}')
    monitor POST rebuild "$body" | grep -q '"started":true' || fail "$wallet: rebuild did not start"
    wait_state 'ready|failed' 600
    [ "$(state)" = ready ] || fail "$wallet: rebuild failed: $(status | jq -r .message)"
    echo "ok   $wallet: rebuilt"

    local want got
    want=$(jq -r '.balances | .trusted + .immature + .untrusted_pending' "$truth")
    got=$(cli -rpcwallet= getbalances | jq -r '.mine | .trusted + .immature + .untrusted_pending')
    [ "$want" = "$got" ] || fail "$wallet: balance $got, Qtum v22.1 had $want"
    echo "ok   $wallet: balance $got equals the balance in Qtum v22.1"

    local addresses missing=0 a
    addresses=$(jq -r '.keys[].addresses[0]' "$truth")
    for a in $addresses; do
        [ "$(cli -rpcwallet= getaddressinfo "$a" | jq -r .ismine)" = true ] || missing=$((missing + 1))
    done
    [ $missing = 0 ] || fail "$wallet: $missing addresses are not the wallet's own"
    echo "ok   $wallet: all $(echo "$addresses" | wc -l | tr -d ' ') addresses of the old wallet are the new wallet's own"

    local n=0 label
    while IFS=$'\t' read -r a label; do
        cli -rpcwallet= getaddressesbylabel "$label" 2>/dev/null | jq -e --arg a "$a" 'has($a)' >/dev/null \
            || fail "$wallet: label \"$label\" of $a was not carried over"
        n=$((n + 1))
    done < <(jq -r '.labels | to_entries[] | select(.value.label != "") | [.key, .value.label] | @tsv' "$truth")
    echo "ok   $wallet: $n labels carried over"

    [ "$(cli -rpcwallet= getwalletinfo | jq -r .descriptors)" = true ] || fail "$wallet: not a descriptor wallet"
    [ "$(wallet_kind)" = sqlite ] || fail "$wallet: wallet.dat is not in the new format"
    in_box 'ls -d /package/data/qtum/regtest/wallets/legacy-wallet-replaced-*/wallet.dat' >/dev/null || fail "$wallet: the old wallet was not kept"
    [ "$(in_box 'sha256sum /package/data/qtum/regtest/wallets/legacy-wallet-replaced-*/wallet.dat | cut -c1-64')" = "$LEGACY_SHA" ] \
        || fail "$wallet: the kept old wallet is not the original"
    in_box '[ -z "$(ls -A /package/data/wallet-rebuild-tmp 2>/dev/null)" ]' || fail "$wallet: temporary files were left behind"
    [ "$(status | jq -r .migration.method)" = rebuild ] || fail "$wallet: walletstatus does not report the rebuild"
    echo "ok   $wallet: new wallet format, old wallet kept unchanged, no temporary files"

    monitor POST rebuild '{}' | grep -q 'There is no failed wallet upgrade to rebuild from' || fail "$wallet: a second rebuild was accepted"
    echo "ok   $wallet: a second rebuild is refused"
    cli -rpcwallet= getnewaddress "" legacy >/dev/null || fail "$wallet: no new address"
    echo "ok   $wallet: new addresses work"
}

for wallet in hd-plain hd-imported nonhd; do
    echo "--- $wallet"
    start "$wallet" fail-migration
    wait_state failed 300
    [ "$(status | jq -r .migration.canRebuild)" = true ] || fail "$wallet: the failed upgrade does not offer the rebuild"
    LEGACY_SHA=$(legacy_sha)
    rebuild_ok "$wallet"
    if [ "$wallet" = hd-imported ]; then
        status | jq -r .rebuild.notCarriedOver | grep -q '1 watch-only address' || fail "hd-imported: the watch-only address is not reported"
        echo "ok   hd-imported: the watch-only address that was not carried over is reported"
    fi
    no_secrets_in_log "$wallet"
    stop
done

echo "--- hd-encrypted"
start hd-encrypted fail-migration
wait_state 'failed|needs-passphrase' 300
LEGACY_SHA=$(legacy_sha)
PASS=$(jq -r .passphrase "$OUT/hd-encrypted.truth.json")
monitor POST rebuild '{}' | grep -q started || fail "rebuild without password did not start"
wait_state 'needs-passphrase|failed' 300
[ "$(state)" = needs-passphrase ] || fail "no password asked: $(status | jq -r .message)"
[ "$(status | jq -r .rebuild.state)" = needs-passphrase ] || fail "the password is not asked for the rebuild"
echo "ok   hd-encrypted: the rebuild asks for the password"
monitor POST rebuild "$(jq -nc --arg p "${PASS}x" '{passphrase: $p}')" | grep -q started || fail "rebuild with wrong password did not start"
sleep 2
wait_state 'failed|needs-passphrase' 300
status | jq -r .message | grep -q 'password is not correct' || fail "wrong password: $(status | jq -r .message)"
[ "$(legacy_sha)" = "$LEGACY_SHA" ] || fail "wrong password: the old wallet changed"
echo "ok   hd-encrypted: a wrong password fails cleanly, the old wallet is untouched"
rebuild_ok hd-encrypted "$PASS"
[ "$(cli -rpcwallet= getwalletinfo | jq -r .unlocked_until)" = 0 ] || fail "hd-encrypted: the new wallet is not locked"
cli -rpcwallet= walletpassphrase "$PASS" 5 >/dev/null || fail "hd-encrypted: the password does not unlock the new wallet"
echo "ok   hd-encrypted: the new wallet is locked with the same password"
no_secrets_in_log hd-encrypted
stop

echo "--- a rebuilt wallet that misses a key is not used"
start hd-plain fail-migration,drop-one-key
wait_state failed 300
LEGACY_SHA=$(legacy_sha)
monitor POST rebuild '{}' | grep -q started || fail "rebuild did not start"
sleep 2
wait_state 'failed|ready' 600
[ "$(state)" = failed ] || fail "the check let a wallet with a missing key through"
status | jq -r .message | grep -q 'missing in the new wallet' || fail "unexpected reason: $(status | jq -r .message)"
[ "$(legacy_sha)" = "$LEGACY_SHA" ] || fail "the old wallet changed"
in_box 'ls -d /package/data/wallet-rebuild-failed/*/rebuilt-*/wallet.dat' >/dev/null || fail "the rebuilt wallet was not kept for support"
in_box '! ls -d /package/data/qtum/regtest/wallets/rebuilt-* 2>/dev/null' || fail "the rebuilt wallet was left in the wallet directory"
echo "ok   missing key: rebuild refused, old wallet untouched, rebuilt wallet parked"
no_secrets_in_log hd-plain
stop

echo "--- an interrupted rebuild is not resumed"
start hd-plain fail-migration,slow-rebuild
wait_state failed 300
LEGACY_SHA=$(legacy_sha)
monitor POST rebuild '{}' | grep -q started || fail "rebuild did not start"
for i in $(seq 1 120); do
    [ "$(status | jq -r '.rebuild.step // empty')" = "Creating the new wallet" ] && break
    sleep 1
done
[ "$(status | jq -r '.rebuild.step // empty')" = "Creating the new wallet" ] || fail "the rebuild did not get to the new wallet"
docker restart "$NAME" >/dev/null
sleep 5
wait_state 'failed|ready' 300
status | jq -r .message | grep -q 'rebuild was interrupted' || fail "interrupted: $(status | jq -r .message)"
[ "$(legacy_sha)" = "$LEGACY_SHA" ] || fail "interrupted: the old wallet changed"
in_box '! ls -d /package/data/qtum/regtest/wallets/rebuilt-* 2>/dev/null' || fail "interrupted: the half-made wallet is still in the wallet directory"
in_box 'ls -d /package/data/wallet-rebuild-failed/*/rebuilt-*' >/dev/null || fail "interrupted: the half-made wallet was not kept"
in_box '[ -z "$(ls -A /package/data/wallet-rebuild-tmp 2>/dev/null)" ]' || fail "interrupted: temporary files were left behind"
echo "ok   interrupted: reported, old wallet untouched, half-made wallet parked, temporary files removed"
# pressing Rebuild again works (without the slow switch the next start would retry the upgrade)
rebuild_ok hd-plain
stop

echo "--- the wallet in place is not the saved copy: the rebuild uses the wallet in place"
start hd-plain fail-migration hd-imported
wait_state failed 300
# replace the wallet while qtumd runs (it cannot load a legacy wallet, so the file is not open)
in_box 'cp /package/data/other-wallet.dat /package/data/qtum/regtest/wallets/wallet.dat'
LEGACY_SHA=$(legacy_sha)
rebuild_ok hd-imported
for a in $(jq -r '.keys[].addresses[0]' "$OUT/hd-plain.truth.json" | head -5); do
    [ "$(cli -rpcwallet= getaddressinfo "$a" | jq -r .ismine)" = false ] || fail "the rebuilt wallet has keys of the saved copy"
done
in_box 'ls -d /package/data/wallet-backups/*-legacy-wallet-before-rebuild/wallet.dat' >/dev/null || fail "the wallet in place was not copied first"
log_has 'the saved copy is not the wallet in place' || fail "the fresh copy is not logged"
echo "ok   different wallet in place: copied first, the rebuilt wallet has its keys and not the saved copy's"
no_secrets_in_log hd-imported
stop

echo "--- the new wallet cannot be closed: it is parked, the old wallet stays"
start hd-plain fail-migration,unload-fails
wait_state failed 300
LEGACY_SHA=$(legacy_sha)
monitor POST rebuild '{}' | grep -q started || fail "rebuild did not start"
sleep 2
wait_state 'failed|ready' 600
[ "$(state)" = failed ] || fail "unload-fails: the new wallet was used"
status | jq -r .message | grep -q 'could not be closed' || fail "unload-fails: $(status | jq -r .message)"
[ "$(legacy_sha)" = "$LEGACY_SHA" ] || fail "unload-fails: the old wallet changed"
in_box '! ls -d /package/data/qtum/regtest/wallets/rebuilt-* 2>/dev/null' || fail "unload-fails: the new wallet is still in the wallet directory"
in_box 'ls -d /package/data/wallet-rebuild-failed/*/rebuilt-*/wallet.dat' >/dev/null || fail "unload-fails: the new wallet was not parked"
cli getblockcount >/dev/null || fail "unload-fails: Qtum is not running"
echo "ok   unload-fails: reported, new wallet parked, old wallet untouched, Qtum running"
stop

echo "--- stopped in the middle of the final swap: the next start finishes it"
start hd-plain fail-migration,crash-during-swap
wait_state failed 300
LEGACY_SHA=$(legacy_sha)
rebuild_ok hd-plain
log_has 'crash-during-swap stops the monitor' || fail "crash-during-swap: the switch did not fire"
log_has 'interrupted wallet rebuild was finished' || fail "crash-during-swap: the swap was not finished at start-up"
echo "ok   crash-during-swap: the swap was finished at the next start"
no_secrets_in_log hd-plain
stop

echo "--- the saved copy is gone: the rebuild copies the wallet in place and goes on"
start nonhd fail-migration
wait_state failed 300
in_box 'rm -rf /package/data/wallet-backups/*'
[ "$(status | jq -r .migration.canRebuild)" = true ] || fail "no saved copy: the rebuild is not offered"
LEGACY_SHA=$(legacy_sha)
rebuild_ok nonhd
in_box 'ls -d /package/data/wallet-backups/*-legacy-wallet-before-rebuild/wallet.dat' >/dev/null || fail "no saved copy: the wallet in place was not copied first"
echo "ok   no saved copy: rebuilt from a fresh copy of the wallet in place"
stop

echo "--- stopped after only wallet.dat was moved aside: the next start moves the rest too"
start hd-plain fail-migration,crash-during-swap-partial
wait_state failed 300
# Berkeley DB files of the old wallet next to it (as Qtum v29 and older leave them)
in_box 'cd /package/data/qtum/regtest/wallets && mkdir database && touch db.log .walletlock'
LEGACY_SHA=$(legacy_sha)
rebuild_ok hd-plain
log_has 'crash-during-swap-partial stops the monitor' || fail "partial swap: the switch did not fire"
log_has 'interrupted wallet rebuild was finished' || fail "partial swap: the swap was not finished at start-up"
left=$(in_box 'ls -A /package/data/qtum/regtest/wallets' | grep -vE '^(wallet\.dat|wallet\.dat-journal|legacy-wallet-replaced-.*)$' || true)
[ -z "$left" ] || fail "partial swap: old wallet files left next to the new wallet: $left"
for f in wallet.dat database db.log .walletlock README.txt; do
    in_box "ls -d /package/data/qtum/regtest/wallets/legacy-wallet-replaced-*/$f" >/dev/null || fail "partial swap: $f is not in the kept directory"
done
echo "ok   partial swap: only the new wallet in the wallet folder, every old wallet file kept"
stop

echo "--- a wallet file cut short: the upgrade fails for real, the rebuild reads the pages directly"
mkdir -p "$WORK/regtest/wallets/hd-plain-cut"
node "$HERE/../build/monitor/test/fixtures/truncate.js" "$WORK/regtest/wallets/hd-plain/wallet.dat" "$OUT/hd-plain.truth.json" \
    "$WORK/regtest/wallets/hd-plain-cut/wallet.dat" > "$OUT/cut.json" || fail "could not cut the wallet"
echo "     kept $(jq .cut "$OUT/cut.json") of $(jq .pages "$OUT/cut.json") pages, $(jq .keysRead "$OUT/cut.json") of $(jq '.keys | length' "$OUT/hd-plain.truth.json") key records"
# every address is recoverable (surviving keys or derived from the seed), so the whole balance must come back
[ "$(jq .all "$OUT/cut.json")" = true ] || fail "cut: not every address is recoverable: $(jq -c . "$OUT/cut.json")"
[ "$(jq .keysRead "$OUT/cut.json")" -lt "$(jq '.keys | length' "$OUT/hd-plain.truth.json")" ] || fail "cut: no key record was lost"
start hd-plain-cut ""
wait_state failed 300
LEGACY_SHA=$(legacy_sha)
log_has 'wallet upgrade failed' || fail "cut: the real upgrade did not fail"
rebuild_ok hd-plain
log_has 'the wallet tool cannot read the old wallet, reading it directly' || fail "cut: the rebuild did not read the pages directly"
[ "$(status | jq -r .rebuild.source)" = raw-pages ] || fail "cut: walletstatus does not report the direct read"
[ "$(status | jq -r .rebuild.seedRestored)" = true ] || fail "cut: the seed was not restored"
in_box 'grep -q "\"source\": \"raw-pages\"" /package/data/wallet-state.json && grep -q "\"pagesMissing\": [1-9]" /package/data/wallet-state.json' \
    || fail "cut: the report for support has no source/pagesMissing"
echo "ok   cut: real upgrade failure, read directly, every address and the whole balance restored"
no_secrets_in_log hd-plain
stop

echo "PASS"
