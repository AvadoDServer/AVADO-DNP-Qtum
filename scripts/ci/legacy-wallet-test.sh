#!/usr/bin/env bash
# Wallet regression: boxes keep every private key through an update.
#
#   scripts/ci/legacy-wallet-test.sh <candidate-image> <production-image> <out-dir>
#
# Qtum v30 cannot load legacy (Berkeley DB) wallets; the package's monitor
# upgrades them to descriptor wallets on the first start (build/monitor), and
# exports keys from descriptors because v30 removed dumpprivkey. Every Qtum
# update must keep that working. All runs are on mainnet, offline (no peers),
# each on a fresh volume, with the package's own entrypoint:
#
#   A  legacy wallet made by Qtum 22.1 (packages 0.0.9/0.0.10): HD addresses of
#      every type, change addresses and an imported key. Then the PRODUCTION
#      image runs on it and adds an address, and is killed (SIGKILL, like a
#      power cut). Then the candidate starts on the same volume.
#   B  legacy wallet made by Qtum 0.20.3 (packages 0.0.1-0.0.8) and closed
#      cleanly; the candidate starts on it directly (a box that was off for
#      years and skips every version in between).
#   C  legacy wallet made by Qtum 22.1 with a password (two HD seeds). The
#      candidate must wait for the password (a wrong one changes nothing), then
#      upgrade it; the password must never appear in the logs.
#   D  descriptor wallet made by the PRODUCTION image on a new box (what boxes
#      installed with 0.0.11+ have). The candidate must not touch it.
#
# Passes when, for every wallet, the candidate's "Show private key" endpoint
# (POST /monitor/privkey, what the wizard calls) returns EXACTLY the key the old
# Qtum's dumpprivkey returned (A, B, C), or the production wallet's descriptors
# are unchanged and every exported key re-derives its address (D); every address
# is still the wallet's own; new addresses work; the upgrade keeps a copy of the
# old wallet; a restart does not upgrade again; the chain data opens without
# errors; and the candidate stops cleanly.
#
# The old Qtum builds are downloaded from github.com/qtumproject/qtum and
# checked against pinned sha256 values (LEGACY_BIN_CACHE=<dir> keeps them;
# LEGACY_FETCH_ONLY=1 only downloads them).
# The wallets hold no coins. Their keys are written to <out-dir>/keys/ (do not
# upload that folder).
set -uo pipefail

CAND=${1:?usage: legacy-wallet-test.sh <candidate-image> <production-image> <out-dir>}
PROD=${2:?usage: legacy-wallet-test.sh <candidate-image> <production-image> <out-dir>}
OUT=${3:?usage: legacy-wallet-test.sh <candidate-image> <production-image> <out-dir>}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$OUT/keys"
OUT=$(cd "$OUT" && pwd)
BINS=${LEGACY_BIN_CACHE:-$OUT/bins}
mkdir -p "$BINS"
BINS=$(cd "$BINS" && pwd)
WAIT=${LEGACY_WAIT_SECONDS:-600}

# Old Qtum Core builds that made the wallets boxes still have (sha256 as
# published in their release notes).
QTUM_22_URL=https://github.com/qtumproject/qtum/releases/download/v22.1/qtum-22.1-x86_64-linux-gnu.tar.gz
QTUM_22_SHA256=34f2c6ca10026cc1600cfb3fbc1e606b7f163a15d98781866be6fc34e7269ea0
QTUM_020_URL=https://github.com/qtumproject/qtum/releases/download/mainnet-fastlane-v0.20.3/qtum-0.20.3-x86_64-linux-gnu.tar.gz
QTUM_020_SHA256=25629b6f3e3d5c0aa4501d20a890142e4b394dfff145de04496a527eaf8d2e18

CONF="-conf=/package/data/qtum.conf -datadir=/package/data/qtum"
OFFLINE="-connect=0 -proxy=127.0.0.1:9 -listen=0"
ID="avado-wallet-$$"
FATAL='Please restart with -reindex|Corrupted block database|Error opening block database|Error initializing block database|Error loading block database|EXCEPTION:|Assertion .* failed|terminate called|Fatal Error'

die() {
  echo "legacy-wallet-test: $*" >&2
  exit 1
}
log() { echo "legacy-wallet-test: $(date -u +%H:%M:%S) $*" >&2; }
cleanup() {
  docker ps -aq --filter "name=^$ID-" | xargs -r docker rm -f >/dev/null 2>&1
  docker volume ls -q --filter "name=^$ID-" | xargs -r docker volume rm >/dev/null 2>&1
}
trap cleanup EXIT

fails=0
: >"$OUT/result.tsv"
check() { # <PASS|FAIL|INFO> <name> <detail>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$OUT/result.tsv"
  printf '  %-5s %-30s %s\n' "$1" "$2" "$3"
  [ "$1" = FAIL ] && fails=$((fails + 1))
  return 0
}
pass_if() { # <condition result 0|1> <name> <detail on pass> <detail on fail>
  if [ "$1" = 0 ]; then check PASS "$2" "$3"; else check FAIL "$2" "$4"; fi
}

# --- old Qtum builds -----------------------------------------------------------------
fetch_qtum() { # <url> <sha256> <dir>
  local url=$1 sha=$2 dir=$3 tgz got
  tgz="$BINS/$(basename "$1")"
  [ -x "$dir/qtumd" ] && return 0
  if [ ! -f "$tgz" ] || [ "$( (sha256sum "$tgz" 2>/dev/null || shasum -a 256 "$tgz") | cut -c1-64)" != "$sha" ]; then
    curl -fsSL --retry 3 --max-time 900 -o "$tgz.part" "$url" || die "could not download $url"
    mv "$tgz.part" "$tgz"
  fi
  got=$( (sha256sum "$tgz" 2>/dev/null || shasum -a 256 "$tgz") | cut -c1-64)
  [ "$got" = "$sha" ] || die "$(basename "$tgz") has sha256 $got, expected $sha"
  mkdir -p "$dir"
  tar -xzf "$tgz" -C "$dir" --strip-components=2 --wildcards '*/bin/qtumd' '*/bin/qtum-cli' 2>/dev/null ||
    tar -xzf "$tgz" -C "$dir" --strip-components=2 "$(tar -tzf "$tgz" | grep '/bin/qtumd$')" "$(tar -tzf "$tgz" | grep '/bin/qtum-cli$')"
  [ -x "$dir/qtumd" ] || die "no qtumd in $tgz"
}
fetch_qtum "$QTUM_22_URL" "$QTUM_22_SHA256" "$BINS/qtum-22.1"
fetch_qtum "$QTUM_020_URL" "$QTUM_020_SHA256" "$BINS/qtum-0.20.3"
# LEGACY_FETCH_ONLY=1: only download and check the old builds (the PR checks do
# this in a step of its own, which the gate re-runs when GitHub did not answer).
if [ "${LEGACY_FETCH_ONLY:-}" = 1 ]; then
  log "old Qtum builds ready in $BINS"
  exit 0
fi
for img in "$CAND" "$PROD"; do docker image inspect "$img" >/dev/null 2>&1 || die "image $img not found"; done

# --- helpers ---------------------------------------------------------------------------
newkey() { # a random mainnet private key (WIF, compressed), for importprivkey
  node -e "const k=require('$ROOT/build/monitor/qtumkeys.js'); let x; do { x=require('crypto').randomBytes(32); } while (x[0] === 0xff); console.log(k.encodeWif(x, 0x80, true))"
}
# old qtumd on a volume, in the production image (the environment boxes had),
# with the command line every package has used since 0.0.1 (supervisord.conf:
# -superstaking, which also decides how the chain database is indexed: a
# datadir written without it is refused by later versions with "You need to
# rebuild the database using -reindex to change -addrindex").
old_start() { # <container> <volume> <bin dir>
  docker run -d --name "$1" --platform linux/amd64 -v "$2:/package/data" -v "$3:/legacy:ro" --entrypoint /legacy/qtumd \
    "$PROD" $CONF -superstaking $OFFLINE -printtoconsole >/dev/null || die "cannot start $1"
  local _
  for _ in $(seq 1 120); do
    docker exec "$1" /legacy/qtum-cli $CONF getblockcount >/dev/null 2>&1 && return 0
    sleep 1
  done
  docker logs "$1" 2>&1 | tail -20 >&2
  die "$1: the old qtumd did not answer"
}
ocli() { local c=$1; shift; docker exec "$c" /legacy/qtum-cli $CONF "$@"; }
old_stop() { # <container>: a clean stop
  ocli "$1" stop >/dev/null 2>&1
  timeout 180 docker wait "$1" >/dev/null 2>&1 || docker stop -t 60 "$1" >/dev/null 2>&1
  docker logs "$1" >"$OUT/$1.log" 2>&1
  docker rm "$1" >/dev/null 2>&1
}
pkg_start() { # <container> <image> <volume>: the package's own entrypoint (supervisord, monitor, nginx)
  docker run -d --name "$1" --platform linux/amd64 -e "EXTRA_OPTS=$OFFLINE" -v "$3:/package/data" "$2" >/dev/null || die "cannot start $1"
}
pcli() { local c=$1; shift; docker exec "$c" qtum-cli $CONF "$@"; }
mon_get() { docker exec "$1" curl -s -m 20 "http://127.0.0.1/monitor/$2"; }
mon_post() { docker exec "$1" curl -s -m 60 -X POST "http://127.0.0.1/monitor/$2" -H 'Content-Type: application/json' -H 'X-Qtum-Wizard: 1' -d "$3"; }
rpcw() { # <container> <method> [json params]: the whole JSON answer of /rpc (the wizard's path)
  docker exec "$1" curl -s -m 60 -X POST http://127.0.0.1/rpc -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"1.0\",\"id\":\"t\",\"method\":\"$2\",\"params\":${3:-[]}}"
}
result() { jq -r '.result | if type == "string" then . else tojson end' 2>/dev/null; }
state_of() { mon_get "$1" walletstatus | jq -r '.state // empty' 2>/dev/null; }
wait_state() { # <container> "<states>": prints the state it reached, or TIMEOUT
  local c=$1 want=$2 s="" _
  for _ in $(seq 1 "$WAIT"); do
    s=$(state_of "$c")
    if [ -n "$s" ] && echo " $want " | grep -q " $s "; then echo "$s"; return 0; fi
    [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ] || { echo "EXITED"; return 1; }
    sleep 1
  done
  echo "TIMEOUT(last: ${s:-none})"
  return 1
}
# production of any version: 0.0.14+ has /monitor/walletstatus; 0.0.13 and older
# only load (or create) the default wallet.
wait_prod_wallet() { # <container>
  local c=$1 s _
  for _ in $(seq 1 "$WAIT"); do
    s=$(state_of "$c")
    case "$s" in ready) return 0 ;; failed | needs-passphrase) return 1 ;; esac
    pcli "$c" listwallets 2>/dev/null | grep -q '""' && return 0
    docker logs "$c" 2>&1 | grep -q 'gave up: qtum' && return 1 # qtumd cannot start (supervisord gave up)
    sleep 1
  done
  return 1
}
wait_idle() { # <container>: until no wallet task runs
  local _
  for _ in $(seq 1 "$WAIT"); do
    [ "$(mon_get "$1" walletstatus | jq -r '.busy // "none"' 2>/dev/null)" = none ] && return 0
    sleep 1
  done
  return 1
}
privkey() { mon_post "$1" privkey "{\"address\":\"$2\"}" | jq -r '.privateKey // empty' 2>/dev/null; }
# Does this WIF key make this address? (pkh for Q..., sh(wpkh) for M..., wpkh for qc1...)
rederives() { # <container> <address> <wif>
  local c=$1 a=$2 w=$3 t desc sum got
  for t in "pkh(KEY)" "sh(wpkh(KEY))" "wpkh(KEY)"; do
    desc=${t/KEY/$w}
    sum=$(rpcw "$c" getdescriptorinfo "[\"$desc\"]" | jq -r '.result.checksum // empty')
    [ -n "$sum" ] || continue
    got=$(rpcw "$c" deriveaddresses "[\"$desc#$sum\"]" | jq -r '.result[0] // empty')
    [ "$got" = "$a" ] && return 0
  done
  return 1
}
compare_keys() { # <container> <truth file "address wif"> <label>
  local c=$1 f=$2 label=$3 ok=0 bad=0 mine=0 a w got list=""
  while read -r a w; do
    [ -n "$a" ] || continue
    [ "$(rpcw "$c" getaddressinfo "[\"$a\"]" | jq -r '.result.ismine')" = true ] && mine=$((mine + 1))
    got=$(privkey "$c" "$a")
    if [ -n "$got" ] && [ "$got" = "$w" ]; then ok=$((ok + 1)); else bad=$((bad + 1)); list="$list $a"; fi
  done <"$f"
  local total=$((ok + bad))
  pass_if "$([ "$bad" = 0 ] && [ "$total" -gt 0 ] && echo 0 || echo 1)" "$label-keys" \
    "all $total private keys export exactly as the old wallet had them" "$bad of $total keys differ or are missing:$list"
  pass_if "$([ "$mine" = "$total" ] && echo 0 || echo 1)" "$label-ismine" "all $total addresses are still the wallet's own" "only $mine of $total addresses are the wallet's own"
}
fatal_lines() { grep -E "$FATAL" "$1" | head -3 | cut -c1-200 | tr '\n' ' '; }
is_bdb() { # <container> <file>: Berkeley DB magic at offset 12
  local m
  m=$(docker exec "$1" sh -c "od -An -tx1 -j12 -N4 '$2' 2>/dev/null" | tr -d ' \n')
  [ "$m" = 62310500 ] || [ "$m" = 00053162 ]
}
logs_of() { docker logs "$1" >"$OUT/$2.log" 2>&1; }

# --- A: a Qtum 22.1 legacy wallet, then the production image, killed ------------------
scenario_a() {
  local V="$ID-a" C1="$ID-a-old" C2="$ID-a-production" C3="$ID-a-candidate" T="$OUT/keys/A.txt" a t info wif
  log "A: legacy wallet made by Qtum 22.1, then production, killed; then the candidate"
  docker volume create "$V" >/dev/null
  old_start "$C1" "$V" "$BINS/qtum-22.1"
  ocli "$C1" createwallet "" >/dev/null || die "A: createwallet failed on 22.1"
  info=$(ocli "$C1" getwalletinfo)
  pass_if "$([ "$(echo "$info" | jq -r .format)" = bdb ] && [ "$(echo "$info" | jq -r .descriptors)" = false ] && echo 0 || echo 1)" \
    A-made-legacy "Qtum 22.1 made a legacy (Berkeley DB) wallet" "Qtum 22.1 did not make a legacy wallet: $(echo "$info" | jq -c '{format, descriptors}')"
  : >"$T"
  for t in legacy legacy legacy p2sh-segwit p2sh-segwit p2sh-segwit bech32 bech32 bech32; do ocli "$C1" getnewaddress "" "$t" >>"$T.addr"; done
  ocli "$C1" getrawchangeaddress legacy >>"$T.addr"
  ocli "$C1" getrawchangeaddress bech32 >>"$T.addr"
  wif=$(newkey)
  ocli "$C1" importprivkey "$wif" "" false >/dev/null || die "A: importprivkey failed"
  a=$(ocli "$C1" deriveaddresses "pkh($wif)#$(ocli "$C1" getdescriptorinfo "pkh($wif)" | jq -r .checksum)" | jq -r '.[0]')
  echo "$a" >>"$T.addr"
  while read -r a; do echo "$a $(ocli "$C1" dumpprivkey "$a")" >>"$T"; done <"$T.addr"
  old_stop "$C1"

  pkg_start "$C2" "$PROD" "$V"
  if wait_prod_wallet "$C2"; then
    a=$(pcli "$C2" getnewaddress "" legacy)
    wif=$(privkey "$C2" "$a")
    [ -n "$wif" ] || wif=$(pcli "$C2" dumpprivkey "$a" 2>/dev/null)
    if [ -n "$a" ] && [ -n "$wif" ]; then
      echo "$a $wif" >>"$T"
      check PASS A-production-ran "the production image loaded the wallet and made address $a"
    else
      check FAIL A-production-ran "the production image loaded the wallet but could not make an address and export its key"
    fi
  else
    check FAIL A-production-ran "the production image did not load the legacy wallet (see $C2.log)"
  fi
  sleep 5
  docker kill "$C2" >/dev/null 2>&1
  logs_of "$C2" "$C2"
  docker rm "$C2" >/dev/null 2>&1

  pkg_start "$C3" "$CAND" "$V"
  local st
  st=$(wait_state "$C3" "ready failed needs-passphrase")
  pass_if "$([ "$st" = ready ] && echo 0 || echo 1)" A-ready "the candidate's wallet is ready" "the candidate's wallet state is $st: $(mon_get "$C3" walletstatus | jq -c '{message, migration}' 2>/dev/null)"
  local ws info2
  ws=$(mon_get "$C3" walletstatus)
  info2=$(rpcw "$C3" getwalletinfo | jq -c '.result | {format, descriptors}')
  check INFO A-upgrade "$(echo "$ws" | jq -c '{migration: .migration.state, newBackupRequired}' 2>/dev/null)"
  pass_if "$([ "$info2" = '{"format":"sqlite","descriptors":true}' ] && echo 0 || echo 1)" A-descriptor-wallet "the wallet is a descriptor (sqlite) wallet now" "getwalletinfo says $info2"
  compare_keys "$C3" "$T" A
  local copy
  copy=$(docker exec "$C3" sh -c 'ls -d /package/data/wallet-backups/*-legacy-wallet-before-upgrade 2>/dev/null | head -1')
  if [ "$(echo "$ws" | jq -r '.migration.state // empty')" = "done" ]; then
    pass_if "$([ -n "$copy" ] && is_bdb "$C3" "$copy/wallet.dat" && echo 0 || echo 1)" A-kept-copy "a copy of the legacy wallet is kept in ${copy#/package/data/}" "no legacy copy in /package/data/wallet-backups"
    pass_if "$([ "$(echo "$ws" | jq -r .newBackupRequired)" = true ] && echo 0 || echo 1)" A-backup-notice "the wizard asks the owner to download a new backup" "newBackupRequired is not true after the upgrade"
  fi
  local n kind addr w
  for kind in legacy p2sh-segwit bech32; do
    addr=$(rpcw "$C3" getnewaddress "[\"\",\"$kind\"]" | result)
    w=$(privkey "$C3" "$addr")
    if [ -n "$addr" ] && [ -n "$w" ] && rederives "$C3" "$addr" "$w"; then n=ok; else n=bad; fi
    pass_if "$([ "$n" = ok ] && echo 0 || echo 1)" "A-new-$kind" "new $kind address $addr, its exported key re-derives it" "new $kind address '${addr:-none}': the exported key '${w:+(set)}' does not re-derive it"
  done
  rpcw "$C3" backupwallet '["/tmp/wallet.backup"]' >/dev/null
  pass_if "$(docker exec "$C3" head -c 15 /tmp/wallet.backup 2>/dev/null | grep -q 'SQLite format 3' && echo 0 || echo 1)" A-backup "backupwallet writes a SQLite wallet file (the wizard's Download backup)" "backupwallet did not write a wallet file"
  logs_of "$C3" "$C3-first-start"
  local f
  f=$(fatal_lines "$OUT/$C3-first-start.log")
  pass_if "$([ -z "$f" ] && echo 0 || echo 1)" A-chain-data "the candidate opened the chain data production wrote (no reindex, no database error)" "$f"

  # a restart must not upgrade again, and must keep every key
  docker restart -t 180 "$C3" >/dev/null
  st=$(wait_state "$C3" "ready failed needs-passphrase")
  local again
  again=$(docker logs "$C3" 2>&1 | awk '/Monitor starting/ {n++} n >= 2' | grep -c 'wallet upgraded to a descriptor wallet' || true)
  pass_if "$([ "$st" = ready ] && [ "$again" = 0 ] && echo 0 || echo 1)" A-restart "after a restart: ready, no second upgrade" "after a restart: state $st, upgrades logged again: $again"
  compare_keys "$C3" "$T" A-after-restart
  docker stop -t 180 "$C3" >/dev/null 2>&1
  local code
  code=$(docker inspect -f '{{.State.ExitCode}}' "$C3")
  logs_of "$C3" "$C3"
  # "Shutdown done" (v30) or "Shutdown: done" (older), and supervisord saw qtumd exit 0
  pass_if "$([ "$code" = 0 ] && grep -Eq 'Shutdown:? done' "$OUT/$C3.log" && grep -q 'stopped: qtum (exit status 0)' "$OUT/$C3.log" && echo 0 || echo 1)" A-clean-stop \
    "docker stop: qtumd shut down cleanly (exit status 0)" "docker stop: container exit code $code; $(grep -Ec 'Shutdown:? done' "$OUT/$C3.log") 'Shutdown done' lines; $(grep -E 'stopped: qtum|exited: qtum' "$OUT/$C3.log" | tail -1)"
  docker rm "$C3" >/dev/null 2>&1
}

# --- B: a Qtum 0.20.3 legacy wallet, straight to the candidate --------------------------
scenario_b() {
  local V="$ID-b" C1="$ID-b-old" C3="$ID-b-candidate" T="$OUT/keys/B.txt" a t wif st
  log "B: legacy wallet made by Qtum 0.20.3, closed cleanly, straight to the candidate"
  docker volume create "$V" >/dev/null
  old_start "$C1" "$V" "$BINS/qtum-0.20.3"
  # Qtum 0.20 makes the default wallet by itself on the first start.
  ocli "$C1" listwallets | grep -q '""' || ocli "$C1" createwallet "" >/dev/null 2>&1
  : >"$T"
  for t in legacy legacy p2sh-segwit p2sh-segwit bech32 bech32; do ocli "$C1" getnewaddress "" "$t" >>"$T.addr"; done
  ocli "$C1" getrawchangeaddress legacy >>"$T.addr"
  wif=$(newkey)
  ocli "$C1" importprivkey "$wif" "" false >/dev/null || die "B: importprivkey failed"
  a=$(ocli "$C1" deriveaddresses "pkh($wif)#$(ocli "$C1" getdescriptorinfo "pkh($wif)" | jq -r .checksum)" | jq -r '.[0]')
  echo "$a" >>"$T.addr"
  while read -r a; do echo "$a $(ocli "$C1" dumpprivkey "$a")" >>"$T"; done <"$T.addr"
  check INFO B-made "Qtum 0.20.3 wallet with $(wc -l <"$T" | tr -d ' ') addresses"
  old_stop "$C1"

  pkg_start "$C3" "$CAND" "$V"
  st=$(wait_state "$C3" "ready failed needs-passphrase")
  pass_if "$([ "$st" = ready ] && echo 0 || echo 1)" B-ready "the candidate's wallet is ready" "the candidate's wallet state is $st: $(mon_get "$C3" walletstatus | jq -c '{message, migration}' 2>/dev/null)"
  pass_if "$([ "$(rpcw "$C3" getwalletinfo | jq -r .result.descriptors)" = true ] && echo 0 || echo 1)" B-descriptor-wallet "the wallet is a descriptor wallet now" "the wallet is not a descriptor wallet"
  compare_keys "$C3" "$T" B
  logs_of "$C3" "$C3"
  local f
  f=$(fatal_lines "$OUT/$C3.log")
  pass_if "$([ -z "$f" ] && echo 0 || echo 1)" B-chain-data "the candidate opened the chain data Qtum 0.20.3 wrote" "$f"
  docker rm -f "$C3" >/dev/null 2>&1
}

# --- C: a Qtum 22.1 legacy wallet with a password ------------------------------------------
scenario_c() {
  local V="$ID-c" C1="$ID-c-old" C3="$ID-c-candidate" T="$OUT/keys/C.txt" a t st pass
  pass=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
  log "C: legacy wallet made by Qtum 22.1 with a password"
  docker volume create "$V" >/dev/null
  old_start "$C1" "$V" "$BINS/qtum-22.1"
  ocli "$C1" createwallet "" >/dev/null || die "C: createwallet failed on 22.1"
  for t in legacy bech32; do ocli "$C1" getnewaddress "" "$t" >>"$T.addr"; done
  ocli "$C1" encryptwallet "$pass" >/dev/null || die "C: encryptwallet failed"
  ocli "$C1" walletpassphrase "$pass" 600 >/dev/null || die "C: walletpassphrase failed"
  for t in legacy p2sh-segwit; do ocli "$C1" getnewaddress "" "$t" >>"$T.addr"; done
  : >"$T"
  while read -r a; do echo "$a $(ocli "$C1" dumpprivkey "$a")" >>"$T"; done <"$T.addr"
  ocli "$C1" walletlock >/dev/null
  old_stop "$C1"

  pkg_start "$C3" "$CAND" "$V"
  st=$(wait_state "$C3" "ready failed needs-passphrase")
  pass_if "$([ "$st" = needs-passphrase ] && echo 0 || echo 1)" C-asks-password "the candidate waits for the wallet password (nothing upgraded without it)" "the candidate's wallet state is $st, expected needs-passphrase"
  mon_post "$C3" migrate '{"passphrase":"not-the-password"}' >/dev/null
  sleep 2
  wait_idle "$C3"
  st=$(state_of "$C3")
  pass_if "$([ "$st" = needs-passphrase ] && echo 0 || echo 1)" C-wrong-password "a wrong password changes nothing (still waiting for the password)" "after a wrong password the state is $st"
  mon_post "$C3" migrate "{\"passphrase\":\"$pass\"}" >/dev/null
  sleep 2
  st=$(wait_state "$C3" "ready failed")
  pass_if "$([ "$st" = ready ] && echo 0 || echo 1)" C-upgraded "with the right password the wallet is upgraded and ready" "with the right password the state is $st: $(mon_get "$C3" walletstatus | jq -c '{message, migration}' 2>/dev/null)"
  rpcw "$C3" walletpassphrase "[\"$pass\",600]" >/dev/null
  pass_if "$([ "$(rpcw "$C3" getwalletinfo | jq -r '.result.unlocked_until != null')" = true ] && echo 0 || echo 1)" C-still-encrypted "the upgraded wallet still has its password" "the upgraded wallet is not encrypted"
  compare_keys "$C3" "$T" C
  logs_of "$C3" "$C3"
  pass_if "$(grep -qF "$pass" "$OUT/$C3.log" && echo 1 || echo 0)" C-password-not-logged "the password does not appear in the logs" "THE PASSWORD APPEARS IN THE LOGS"
  docker rm -f "$C3" >/dev/null 2>&1
}

# --- D: a descriptor wallet made by the production image --------------------------------
scenario_d() {
  local V="$ID-d" C2="$ID-d-production" C3="$ID-d-candidate" T="$OUT/keys/D.txt" kind a w st
  log "D: descriptor wallet made by the production image on a new box"
  docker volume create "$V" >/dev/null
  pkg_start "$C2" "$PROD" "$V"
  wait_prod_wallet "$C2" || { logs_of "$C2" "$C2"; check FAIL D-production-wallet "the production image made no wallet (see $C2.log)"; docker rm -f "$C2" >/dev/null; return; }
  : >"$T"
  for kind in legacy p2sh-segwit bech32; do
    a=$(pcli "$C2" getnewaddress "" "$kind")
    w=$(privkey "$C2" "$a")
    echo "$a ${w:--}" >>"$T"
  done
  pcli "$C2" listdescriptors true | jq -r '.descriptors[].desc' | sort >"$OUT/keys/D-descriptors-production.txt"
  check INFO D-production-wallet "production $(pcli "$C2" getwalletinfo | jq -c '{format, descriptors}') with $(wc -l <"$OUT/keys/D-descriptors-production.txt" | tr -d ' ') descriptors"
  docker stop -t 180 "$C2" >/dev/null 2>&1
  logs_of "$C2" "$C2"
  docker rm "$C2" >/dev/null 2>&1

  pkg_start "$C3" "$CAND" "$V"
  st=$(wait_state "$C3" "ready failed needs-passphrase")
  pass_if "$([ "$st" = ready ] && echo 0 || echo 1)" D-ready "the candidate's wallet is ready" "the candidate's wallet state is $st"
  pass_if "$([ "$(mon_get "$C3" walletstatus | jq -r '.migration')" = null ] && echo 0 || echo 1)" D-untouched "no upgrade was started on a descriptor wallet" "an upgrade was started on a descriptor wallet: $(mon_get "$C3" walletstatus | jq -c .migration)"
  rpcw "$C3" listdescriptors '[true]' | jq -r '.result.descriptors[].desc' | sort >"$OUT/keys/D-descriptors-candidate.txt"
  pass_if "$(cmp -s "$OUT/keys/D-descriptors-production.txt" "$OUT/keys/D-descriptors-candidate.txt" && [ -s "$OUT/keys/D-descriptors-candidate.txt" ] && echo 0 || echo 1)" \
    D-descriptors "every descriptor (with its private key) is exactly what production had" "the descriptors differ from production (keys/D-descriptors-*.txt)"
  local ok=0 bad=0 list="" pw
  while read -r a pw; do
    w=$(privkey "$C3" "$a")
    if [ -n "$w" ] && rederives "$C3" "$a" "$w" && { [ "$pw" = - ] || [ "$pw" = "$w" ]; }; then ok=$((ok + 1)); else bad=$((bad + 1)); list="$list $a"; fi
  done <"$T"
  pass_if "$([ "$bad" = 0 ] && echo 0 || echo 1)" D-keys "all $ok exported keys re-derive their addresses$(grep -qv ' -$' "$T" && echo ' and equal production'"'"'s export')" "$bad keys do not re-derive their address or differ from production's export:$list"
  logs_of "$C3" "$C3"
  docker rm -f "$C3" >/dev/null 2>&1
}

log "candidate $CAND, production $PROD ($(docker run --rm --platform linux/amd64 --entrypoint qtumd "$PROD" -version | head -1))"
scenario_a
scenario_b
scenario_c
scenario_d

if [ "$fails" = 0 ]; then
  echo "PASS: every wallet kept every private key through the update"
else
  echo "FAIL: $fails wallet check(s) failed (logs in $OUT)" >&2
  exit 1
fi
