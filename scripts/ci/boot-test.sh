#!/usr/bin/env bash
# Boots the package image on Qtum mainnet, the way a new box runs it, and
# watches it for a few minutes.
#
#   scripts/ci/boot-test.sh <image> <out-dir> [manifest]
#
# The container runs its own entrypoint (supervisord -> monitor -> qtumd, and
# nginx) with a fresh data volume and the environment and ports of the manifest
# (default: dappnode_package.json of this repo), like a new install.
#
# Passes when, within BOOT_READY_MINUTES (default 10) of the start and then
# BOOT_MINUTES (default 8) of watching:
#   - qtumd answers RPC calls and runs the main chain, directly and through the
#     wizard's /rpc; the monitor made the wallet of a new box (state "ready"),
#     and the wizard and the monitor answer through nginx,
#   - it had at least BOOT_MIN_PEERS peers (default 1: Qtum mainnet is small and
#     a GitHub runner accepts no inbound connections; the first dry run saw 2
#     peers in 8 minutes. The header sync moving is the real proof of P2P),
#   - the header sync moved forward by at least BOOT_MIN_PROGRESS headers
#     (default 1000): Qtum first "pre-synchronizes" the headers (its log line
#     "Pre-synchronizing blockheaders, height: N" and getpeerinfo's
#     presynced_headers), then downloads them (getblockchaininfo headers), then
#     the blocks; any of them moving counts,
#   - supervisord started qtumd once and it never exited, and no fatal line
#     (reindex needed, database error, assertion, ...) was logged,
#   - every port the manifest publishes has a listener in the container (P2P
#     3888 and RPC 3889 are qtumd's own),
#   - `docker stop` with the 180 s the DAPPMANAGER gives stops qtumd cleanly.
# Logs, samples and qtumd's command line are written to <out-dir>.
# Exit code 0: pass. 1: a check failed. 2: only checks that depend on the
# public network failed (peers, header progress), so the workflow tries once
# more on a fresh volume before it reports a failure.
set -uo pipefail

IMAGE=${1:?usage: boot-test.sh <image> <out-dir> [manifest]}
OUT=${2:?usage: boot-test.sh <image> <out-dir> [manifest]}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MANIFEST=${3:-$ROOT/dappnode_package.json}
READY_MIN=${BOOT_READY_MINUTES:-10}
WATCH_MIN=${BOOT_MINUTES:-8}
MIN_PEERS=${BOOT_MIN_PEERS:-1}
MIN_PROGRESS=${BOOT_MIN_PROGRESS:-1000}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
CONF="-conf=/package/data/qtum.conf -datadir=/package/data/qtum"

die() {
  echo "boot-test: $*" >&2
  exit 1
}
log() { echo "boot-test: $(date -u +%H:%M:%S) $*" >&2; }

id="avado-boot-$$"
VOL="$id-data"
C="$id-qtum"
cleanup() {
  docker rm -f "$C" >/dev/null 2>&1
  docker volume rm "$VOL" >/dev/null 2>&1
}
trap cleanup EXIT

# Environment and ports as the manifest gives them to the DAPPMANAGER (a key
# without a value, "EXTRA_OPTS", is set empty, as on a box). Ports are
# published on 127.0.0.1 only: the runner is not a box, nobody must reach its RPC.
env_args=()
while IFS= read -r e; do
  case "$e" in *=*) env_args+=(-e "$e") ;; *) env_args+=(-e "$e=") ;; esac
done < <(jq -r '.image.environment[]?' "$MANIFEST")
port_args=()
while IFS= read -r p; do port_args+=(-p "127.0.0.1:$p"); done < <(jq -r '.image.ports[]?' "$MANIFEST")
volume=$(jq -r '.image.volumes[0]' "$MANIFEST")
[ "${volume#*:}" = /package/data ] || die "unexpected volume $volume"

docker volume create "$VOL" >/dev/null || die "cannot create a docker volume"
log "starting $IMAGE on mainnet (env: $(jq -rc '.image.environment' "$MANIFEST"), ports: $(jq -rc '.image.ports' "$MANIFEST"))"
started=$(date +%s)
docker run -d --name "$C" --platform linux/amd64 -v "$VOL:/package/data" "${env_args[@]}" "${port_args[@]}" "$IMAGE" >/dev/null ||
  die "cannot start the container"

cli() { docker exec "$C" qtum-cli $CONF "$@" 2>/dev/null; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$C" 2>/dev/null)" = true ]; }
wallet_state() { docker exec "$C" curl -s -m 10 http://127.0.0.1/monitor/walletstatus 2>/dev/null | jq -r '.state // empty' 2>/dev/null; }
presync_log() { # highest "Pre-synchronizing blockheaders, height: N" so far
  docker exec "$C" sh -c 'grep -hoE "(Pre-synchronizing|Synchronizing) blockheaders, height: [0-9]+" /package/data/qtum/debug.log 2>/dev/null' |
    grep -oE '[0-9]+$' | sort -n | tail -1
}

# --- wait until qtumd answers and the wallet is ready ---------------------------------
ready=0 wstate=""
while [ $(($(date +%s) - started)) -lt $((READY_MIN * 60)) ]; do
  running || break
  wstate=$(wallet_state)
  if cli getblockchaininfo >/dev/null && [ "$wstate" = ready ]; then
    ready=1
    break
  fi
  sleep 10
done
ready_after=$(($(date +%s) - started))

# --- watch ------------------------------------------------------------------------
printf 'time\tseconds\tpeers\tblocks\theaders\tpresynced\tlog_height\tprogress\n' >"$OUT/samples.tsv"
first="" last="" max_peers=0 chain=""
progress_now() { # the furthest the header sync got, by any measure
  local info peers pre lg
  info=$(cli getblockchaininfo)
  peers=$(cli getpeerinfo)
  pre=$(echo "$peers" | jq '[.[] | (.presynced_headers // -1), (.synced_headers // -1)] | max // -1' 2>/dev/null)
  lg=$(presync_log)
  echo "$(echo "$info" | jq -r '.blocks // 0') $(echo "$info" | jq -r '.headers // 0') ${pre:--1} ${lg:-0} $(echo "$peers" | jq 'length' 2>/dev/null || echo 0) $(echo "$info" | jq -r '.chain // empty')"
}
if [ "$ready" = 1 ]; then
  log "qtumd and the wallet were ready after ${ready_after} s; watching for $WATCH_MIN minutes"
  watch_until=$(($(date +%s) + WATCH_MIN * 60))
  while [ "$(date +%s)" -lt "$watch_until" ]; do
    running || break
    read -r blocks headers pre lg npeers ch <<<"$(progress_now)"
    [ -n "$ch" ] && chain=$ch
    p=$blocks
    for v in $headers $pre $lg; do [ "$v" -gt "$p" ] 2>/dev/null && p=$v; done
    [ -n "$first" ] || first=$p
    last=$p
    [ "${npeers:-0}" -gt "$max_peers" ] 2>/dev/null && max_peers=$npeers
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%H:%M:%S)" $(($(date +%s) - started)) "$npeers" "$blocks" "$headers" "$pre" "$lg" "$p" >>"$OUT/samples.tsv"
    sleep 20
  done
fi

# What qtumd really runs with, what listens, what the wizard answers.
docker exec "$C" sh -c 'for p in $(pgrep -x qtumd); do tr "\0" " " </proc/$p/cmdline; echo; done' >"$OUT/cmdline.txt" 2>&1
docker exec "$C" sh -c 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null' >"$OUT/tcp.txt" 2>&1
cli getnetworkinfo >"$OUT/networkinfo.json"
cli getpeerinfo | jq -c '.[] | {addr, subver, synced_headers, presynced_headers}' >"$OUT/peers.jsonl" 2>/dev/null
rpc_chain=$(docker exec "$C" curl -s -m 20 -X POST http://127.0.0.1/rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"1.0","id":"boot","method":"getblockchaininfo","params":[]}' 2>/dev/null | jq -r '.result.chain // empty' 2>/dev/null)
wizard=$(docker exec "$C" curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1/ 2>/dev/null)
getenv=$(docker exec "$C" curl -s -m 10 http://127.0.0.1/monitor/getenv 2>/dev/null)
stopped_clean=unknown exit_code=""
if running; then
  log "stopping the container (180 s grace, as the DAPPMANAGER)"
  docker stop -t 180 "$C" >/dev/null 2>&1
  exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$C")
fi
docker logs "$C" >"$OUT/container.log" 2>&1
docker run --rm -v "$VOL:/d:ro" --entrypoint cat "$IMAGE" /d/qtum/debug.log >"$OUT/debug.log" 2>/dev/null
# "Shutdown done" (v30) or "Shutdown: done" (older), and supervisord saw qtumd exit 0
grep -Eq 'Shutdown:? done' "$OUT/container.log" && grep -q 'stopped: qtum (exit status 0)' "$OUT/container.log" && [ "$exit_code" = 0 ] && stopped_clean=yes

# --- verdict ------------------------------------------------------------------------
fails=0
outside_only=1
: >"$OUT/result.tsv"
check() { # <PASS|FAIL|INFO> <name> <detail>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$OUT/result.tsv"
  printf '  %-5s %-16s %s\n' "$1" "$2" "$3"
  if [ "$1" = FAIL ]; then
    fails=$((fails + 1))
    case "$2" in peers | header-sync) ;; *) outside_only=0 ;; esac
  fi
  return 0
}

if [ "$ready" = 1 ]; then
  check PASS start "qtumd answered and the wallet of a new box was ready after ${ready_after} s"
else
  check FAIL start "not ready within $READY_MIN minutes (qtumd answering: $(cli getblockcount >/dev/null && echo yes || echo no), wallet state: ${wstate:-none})"
fi
if [ "$chain" = main ] && [ "$rpc_chain" = main ]; then
  check PASS network "main chain (qtum-cli and the wizard's /rpc)"
else
  check FAIL network "expected the main chain; qtum-cli says '${chain:-?}', the wizard's /rpc says '${rpc_chain:-?}'"
fi
if [ "$wizard" = 200 ] && echo "$getenv" | grep -q DELEGATION_FEE_PERCENT; then
  check PASS wizard "the wizard page and the monitor answer through nginx"
else
  check FAIL wizard "wizard page HTTP ${wizard:-none}, monitor getenv: ${getenv:0:120}"
fi
if [ "$max_peers" -ge "$MIN_PEERS" ]; then check PASS peers "up to $max_peers peers (need $MIN_PEERS)"; else check FAIL peers "at most $max_peers peers (need $MIN_PEERS)"; fi
if [ -n "$first" ] && [ -n "$last" ] && [ $((last - first)) -ge "$MIN_PROGRESS" ]; then
  check PASS header-sync "header sync moved from $first to $last while watching"
else
  check FAIL header-sync "header sync did not move enough (${first:-?} -> ${last:-?}, need +$MIN_PROGRESS)"
fi

spawned=$(grep -c "spawned: 'qtum'" "$OUT/container.log" || true)
exited=$(grep -E "exited: qtum |gave up: qtum" "$OUT/container.log" | grep -v 'exit status 0; expected' || true)
if [ "$spawned" = 1 ] && [ -z "$exited" ]; then
  check PASS process "supervisord started qtumd once and it kept running"
else
  check FAIL process "qtumd was started $spawned time(s); $(echo "$exited" | head -2 | tr '\n' ' ')"
fi
FATAL='Please restart with -reindex|Corrupted block database|Error opening block database|Error initializing block database|Error loading block database|EXCEPTION:|Assertion .* failed|terminate called|Fatal Error|Error parsing|Invalid parameter|Ignoring unknown configuration value'
if grep -Eq "$FATAL" "$OUT/container.log" "$OUT/debug.log"; then
  check FAIL fatal-lines "$(grep -Eh "$FATAL" "$OUT/container.log" "$OUT/debug.log" | head -3 | cut -c1-200 | tr '\n' ' ')"
else
  check PASS fatal-lines "no fatal line in the log"
fi
# TCP ports with a listener (state 0A in /proc/net/tcp*) against the ports the manifest publishes.
listening=$(while read -r _ local _ st _; do [ "$st" = 0A ] && echo $((16#${local##*:})); done < <(grep -E '^[[:space:]]*[0-9]+:' "$OUT/tcp.txt") | sort -un | tr '\n' ' ')
published=$(jq -r '.image.ports[]? | split(":") | last | sub("/tcp$"; "")' "$MANIFEST" | grep -v /udp | sort -un | tr '\n' ' ')
unserved=""
for p in $published; do echo " $listening " | grep -q " $p " || unserved="$unserved $p"; done
if [ -z "$unserved" ]; then
  check PASS ports "every published port has a listener (published: ${published% }; listening: ${listening% })"
else
  check FAIL ports "published port(s)$unserved have no listener (listening: ${listening% }); did Qtum change its default P2P or RPC port?"
fi
if [ "$stopped_clean" = yes ]; then
  check PASS stop "docker stop: qtumd shut down cleanly within 180 s (exit status 0)"
else
  check FAIL stop "docker stop: container exit code ${exit_code:-?}; 'Shutdown done' logged: $(grep -Ec 'Shutdown:? done' "$OUT/container.log"); $(grep -E 'stopped: qtum|exited: qtum' "$OUT/container.log" | tail -1)"
fi
check INFO version "$(jq -r '.subversion // "?"' "$OUT/networkinfo.json" 2>/dev/null), protocol $(jq -r '.protocolversion // "?"' "$OUT/networkinfo.json" 2>/dev/null)"
check INFO peer-versions "$(jq -r '.subver' "$OUT/peers.jsonl" 2>/dev/null | sort | uniq -c | sort -rn | head -4 | awk '{c=$1; $1=""; printf "%s x%s,", $0, c}' | sed 's/,$//')"
check INFO cmdline "$(head -1 "$OUT/cmdline.txt" | cut -c1-200)"

if [ "$fails" = 0 ]; then
  echo "PASS: the package booted on Qtum mainnet and synced headers"
else
  echo "FAIL: $fails boot check(s) failed (logs: $OUT/container.log, $OUT/debug.log)" >&2
  echo "----- last 30 lines of qtumd's log" >&2
  tail -30 "$OUT/debug.log" >&2
  [ "$outside_only" = 1 ] && exit 2
  exit 1
fi
