#!/usr/bin/env bash
# Every qtumd option and qtum.conf key AVADO uses still exists in the Qtum
# Core inside the image, and qtumd starts with them.
#
#   scripts/ci/check-flags.sh <image> [out-dir]
#
# Reads the image's own files (what boxes run) and collects
#   - every -option on the qtumd command line in /etc/supervisord/supervisord.conf,
#   - every key of /package/data/qtum.conf (also those in [sections]),
#   - the qtum.conf keys the monitor writes (/package/monitor/index.js, the
#     delegation settings: stakingminfee, stakingminutxovalue),
# and checks each against `qtumd -help -help-debug`. Then qtumd really starts
# (mainnet, no peers, an empty data folder) with that qtum.conf, the monitor's
# keys and the supervisord command line: it must answer RPC calls, and its log
# must not say "Ignoring unknown configuration value", "Invalid parameter" or
# "Error". Qtum ignores an unknown qtum.conf key with only a log line, so the
# key would silently stop working; this check makes that a failure.
# Options users add through EXTRA_OPTS cannot be checked here.
set -euo pipefail

IMAGE=${1:?usage: check-flags.sh <image> [out-dir]}
OUT=${2:-$(mktemp -d "${TMPDIR:-/tmp}/check-flags.XXXXXX")}
mkdir -p "$OUT/files"
OUT=$(cd "$OUT" && pwd)

run() { docker run --rm --platform linux/amd64 "$@"; }

run --entrypoint /bin/sh "$IMAGE" -c 'cat /etc/supervisord/supervisord.conf' >"$OUT/files/supervisord.conf"
run --entrypoint /bin/sh "$IMAGE" -c 'cat /package/data/qtum.conf' >"$OUT/files/qtum.conf"
run --entrypoint /bin/sh "$IMAGE" -c 'cat /package/monitor/index.js' >"$OUT/files/monitor-index.js"
run --entrypoint qtumd "$IMAGE" -help -help-debug >"$OUT/help.txt" 2>&1 ||
  { cat "$OUT/help.txt" >&2; echo "FAIL: qtumd -help -help-debug did not run" >&2; exit 1; }

# Option names of the help text: "  -name=<x>" or "  -name" at the start of a line.
sed -nE 's/^  -([A-Za-z0-9][A-Za-z0-9_-]*)(=.*|\[=.*|$)/\1/p' "$OUT/help.txt" | sort -u >"$OUT/options.txt"
[ "$(wc -l <"$OUT/options.txt")" -gt 50 ] || { echo "FAIL: could not read the options from qtumd -help" >&2; exit 1; }

# used.tsv: <option> <where>
: >"$OUT/used.tsv"
cmdline=$(sed -nE 's/^command=(qtumd .*)$/\1/p' "$OUT/files/supervisord.conf")
[ -n "$cmdline" ] || { echo "FAIL: no qtumd command line in supervisord.conf" >&2; exit 1; }
for w in $cmdline; do
  case "$w" in -*) printf '%s\tsupervisord.conf command line\n' "$(echo "${w#-}" | sed 's/=.*//')" >>"$OUT/used.tsv" ;; esac
done
section=""
while IFS= read -r line; do
  line=${line%%#*}
  case "$line" in
  \[*\]) section="[${line//[\[\] ]/}]" ;;
  *=*) printf '%s\tqtum.conf%s\n' "$(echo "${line%%=*}" | tr -d ' ')" "${section:+ $section}" >>"$OUT/used.tsv" ;;
  esac
done <"$OUT/files/qtum.conf"
# The monitor maps its settings to qtum.conf keys: { "DELEGATION_FEE_PERCENT": "stakingminfee", ... }
monitor_keys=$(awk '/envVariablesToQtumConfigVariables = \{/ {on = 1; next} on && /\}/ {on = 0} on' "$OUT/files/monitor-index.js" |
  sed -nE 's/^[[:space:]]*"[A-Z_]+"[[:space:]]*:[[:space:]]*"([a-z0-9]+)".*/\1/p')
[ -n "$monitor_keys" ] || { echo "FAIL: could not find the qtum.conf keys the monitor writes (envVariablesToQtumConfigVariables in build/monitor/index.js)" >&2; exit 1; }
for k in $monitor_keys; do printf '%s\tqtum.conf key the monitor writes\n' "$k" >>"$OUT/used.tsv"; done

printf '%-26s %-8s %s\n' OPTION RESULT "USED IN"
sort -u "$OUT/used.tsv" | while IFS=$'\t' read -r opt where; do
  if grep -qxF -- "$opt" "$OUT/options.txt"; then r=ok; else r=MISSING; fi
  printf '%-26s %-8s %s\n' "-$opt" "$r" "$where"
done | tee "$OUT/result.txt"
missing=$(grep -c ' MISSING ' "$OUT/result.txt" || true)
total=$(wc -l <"$OUT/result.txt" | tr -d ' ')

# --- qtumd really starts with them ----------------------------------------------------
# The conf the monitor writes: its keys before the first [section], as ini.stringify does.
conf_lines=""
for k in $monitor_keys; do
  case "$k" in stakingminfee) v=10 ;; stakingminutxovalue) v=100 ;; *) v=1 ;; esac
  conf_lines="$conf_lines$k=$v\n"
done
extra=$(echo "$cmdline" | sed -E 's/^qtumd //; s/-conf=[^ ]+//; s/-datadir=[^ ]+//; s/%\(ENV_EXTRA_OPTS\)s//')
set +e
run --entrypoint /bin/sh -e CONF_LINES="$conf_lines" -e EXTRA="$extra" "$IMAGE" -c '
  { printf "$CONF_LINES"; cat /package/data/qtum.conf; } > /tmp/qtum.conf
  mkdir -p /tmp/d
  # offline: no peers, no listening (these options are checked too)
  qtumd -conf=/tmp/qtum.conf -datadir=/tmp/d $EXTRA -connect=0 -proxy=127.0.0.1:9 -listen=0 -printtoconsole=0 2>/tmp/stderr.txt &
  ok=0
  for i in $(seq 1 120); do
    if qtum-cli -conf=/tmp/qtum.conf -datadir=/tmp/d getblockchaininfo >/tmp/info.json 2>/dev/null; then ok=1; break; fi
    kill -0 $! 2>/dev/null || break
    sleep 1
  done
  [ "$ok" = 1 ] && qtum-cli -conf=/tmp/qtum.conf -datadir=/tmp/d stop >/dev/null 2>&1
  wait $!
  echo "=== rpc: $ok"; cat /tmp/info.json 2>/dev/null | head -3
  echo "=== stderr"; cat /tmp/stderr.txt
  echo "=== conf"; cat /tmp/qtum.conf
  echo "=== debug.log"; cat /tmp/d/debug.log 2>/dev/null
' >"$OUT/start.txt" 2>&1
set -e
start_fail=""
grep -q '^=== rpc: 1' "$OUT/start.txt" || start_fail="qtumd did not answer RPC calls with the package's qtum.conf and command line"
bad=$(sed -n '/^=== stderr/,/^=== conf/p; /^=== debug.log/,$p' "$OUT/start.txt" | grep -E 'Ignoring unknown configuration value|Invalid parameter|Error: |Error parsing|is not (a )?(valid|supported)|has been removed' | head -5 || true)
warns=$(sed -n '/^=== debug.log/,$p' "$OUT/start.txt" | grep -iE 'warning|deprecated' | sed -E 's/^[0-9TZ:-]+ //' | sort -u | head -5 || true)
[ -z "$warns" ] || printf 'INFO: qtumd warnings at start (not failures):\n%s\n' "$(echo "$warns" | sed 's/^/  /')"

fails=0
if [ "$missing" != 0 ]; then
  echo "FAIL: $missing of $total options and qtum.conf keys AVADO uses do not exist in this Qtum version (see MISSING above; help text in $OUT/help.txt)" >&2
  fails=1
fi
if [ -n "$start_fail" ]; then
  echo "FAIL: $start_fail (see $OUT/start.txt)" >&2
  sed -n '/^=== stderr/,/^=== conf/p; /^=== debug.log/,$p' "$OUT/start.txt" | grep -v '^=== conf' | tail -20 >&2
  fails=1
fi
if [ -n "$bad" ]; then
  echo "FAIL: qtumd complained about the package's settings:" >&2
  echo "$bad" | sed 's/^/  /' >&2
  fails=1
fi
[ "$fails" = 0 ] || exit 1
echo "PASS: all $total options and qtum.conf keys AVADO uses exist in this Qtum version, and qtumd starts with them without a complaint"
