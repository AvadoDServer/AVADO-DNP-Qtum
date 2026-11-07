#!/usr/bin/env bash
# What identifies the package on the boxes did not change, the version goes up,
# and the manifest agrees with docker-compose.yml.
#
#   scripts/ci/check-identity.sh <base-ref> [out-dir]
#
# Boxes auto-update in place and cannot roll back, so an update must keep the
# package name, the volume, the host ports, the set of environment keys
# (EXTRA_OPTS), the type, and the compose service name, volumes and ports.
# dappnode_package.json at HEAD is compared with
#   - dappnode_package.json at <base-ref> (the branch the PR goes into),
#   - the manifest the production store serves for that name (if readable).
# Version rules: the version never goes down, and it must go up when anything
# that ends up in the package changed (build/, docker-compose.yml, the
# manifest, avatar.png). A held package (file "hold") is not released, so its
# version may stay while those files change.
# Consistency: the manifest's "upstream" is the compose VERSION (the Qtum tag
# the image is built from), and the compose image is <name>:<version>.
set -euo pipefail

BASE=${1:?usage: check-identity.sh <base-ref> [out-dir]}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${2:-$(mktemp -d "${TMPDIR:-/tmp}/identity.XXXXXX")}
STORE_POINTER=${AVADO_STORE_POINTER:-https://bo.ava.do/value/store}
GATEWAYS=${AVADO_IPFS_GATEWAYS:-http://80.208.229.228:8080 https://ipfs.io}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

fails=0
: >"$OUT/result.tsv"
check() { # <PASS|FAIL|INFO> <name> <detail>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$OUT/result.tsv"
  printf '  %-5s %-22s %s\n' "$1" "$2" "$3"
  [ "$1" = FAIL ] && fails=$((fails + 1))
  return 0
}
semver_cmp() { # prints -1, 0 or 1
  local -a a b
  local i
  IFS=. read -ra a <<<"${1#v}"
  IFS=. read -ra b <<<"${2#v}"
  for i in 0 1 2; do
    if [ "${a[$i]:-0}" -lt "${b[$i]:-0}" ]; then echo -1; return; fi
    if [ "${a[$i]:-0}" -gt "${b[$i]:-0}" ]; then echo 1; return; fi
  done
  echo 0
}
# The facts that must not change, as sorted JSON.
identity() { # <manifest.json>
  jq -S '{name, type: (.type // null), volumes: (.image.volumes // []),
    ports: ((.image.ports // []) | sort), env_keys: ([(.image.environment // [])[] | split("=")[0]] | sort)}' "$1"
}
compose_identity() { # <compose.yml>
  yq -o=json '{"services": (.services | keys), "service_volumes": [.services[].volumes // [] | .[]],
    "ports": [.services[].ports // [] | .[]], "volumes": ((.volumes // {}) | keys)}' "$1" | jq -S '.ports |= sort'
}
arg() { yq ".services[].build.args[] | select(test(\"^$2=\"))" "$1" | sed "s/^$2=//"; }

H="$ROOT/dappnode_package.json"
HC="$ROOT/docker-compose.yml"
name=$(jq -r .name "$H")
version=$(jq -r .version "$H")
held=""
if [ -f "$ROOT/hold" ]; then
  held=$(sed -n '/^[[:space:]]*#/d; /[^[:space:]]/{p;q;}' "$ROOT/hold")
  [ -n "$held" ] || held="held (no reason given)"
fi
echo "$name $version against $BASE${held:+ (HELD: $held)}"
[ -z "$held" ] || check INFO hold "HELD (not bumped or released until the file \"hold\" is removed): $held"

# --- the repo agrees with itself ------------------------------------------------------
qtum=$(arg "$HC" VERSION)
upstream=$(jq -r .upstream "$H")
if [ "$upstream" = "$qtum" ]; then
  check PASS upstream "the manifest's upstream $upstream is the compose VERSION"
else
  check FAIL upstream "the manifest says upstream $upstream, docker-compose.yml builds VERSION=$qtum"
fi
image=$(yq '.services[].image' "$HC")
if [ "$image" = "$name:$version" ]; then
  check PASS image-tag "compose image $image"
else
  check FAIL image-tag "compose image is $image, expected $name:$version"
fi
if [ "$(yq '.services | keys | .[0]' "$HC")" = "$name" ] && [ "$(yq '.services | length' "$HC")" = 1 ]; then
  check PASS compose-service "one compose service, named $name"
else
  check FAIL compose-service "docker-compose.yml must have exactly one service named $name (has: $(yq '.services | keys | join(" ")' "$HC"))"
fi

# Released by the CI already? ("Release <name> <version>" commits, as release.mjs reads them)
released=no
git -C "$ROOT" log HEAD --author='github-actions' -F --grep="Release $name $version" --format=%s | grep -qxF "Release $name $version" && released=yes

# --- base -------------------------------------------------------------------------
B="$OUT/base-manifest.json" BC="$OUT/base-compose.yml"
if git -C "$ROOT" show "$BASE:dappnode_package.json" >"$B" 2>/dev/null && [ "$(jq -r .name "$B")" = "$name" ]; then
  git -C "$ROOT" show "$BASE:docker-compose.yml" >"$BC"
  check INFO base "compared with $BASE"
  if diff -u <(identity "$B") <(identity "$H") >"$OUT/identity-vs-base.diff"; then
    check PASS identity-vs-base "name, type, volume, ports and environment keys unchanged"
  else
    check FAIL identity-vs-base "changed: $(grep '^[-+] ' "$OUT/identity-vs-base.diff" | tr -s ' ' | tr '\n' ' ' | cut -c1-300)"
  fi
  if diff -u <(compose_identity "$BC") <(compose_identity "$HC") >"$OUT/compose-vs-base.diff"; then
    check PASS compose-vs-base "service name, volumes and ports unchanged"
  else
    check FAIL compose-vs-base "changed: $(grep '^[-+] ' "$OUT/compose-vs-base.diff" | tr -s ' ' | tr '\n' ' ' | cut -c1-300)"
  fi
  envdiff=$(diff <(jq -r '.image.environment[]?' "$B" | sort) <(jq -r '.image.environment[]?' "$H" | sort) | grep '^[<>]' | tr '\n' ' ' || true)
  [ -z "$envdiff" ] || check INFO env-defaults "default values changed (new installs only): $envdiff"
  base_qtum=$(arg "$BC" VERSION)
  if [ "$(semver_cmp "$qtum" "$base_qtum")" = -1 ]; then
    check FAIL qtum-version "Qtum $qtum is older than $base_qtum on $BASE (boxes never go back to an older Qtum: its chain and wallet files may not open)"
  else
    check PASS qtum-version "Qtum $base_qtum -> $qtum"
  fi

  base_version=$(jq -r .version "$B")
  cmp=$(semver_cmp "$version" "$base_version")
  # What boxes read is the manifest; "upstream" in it is the Qtum tag.
  manifest_changed=$(diff <(jq -S 'del(.version)' "$B") <(jq -S 'del(.version)' "$H") | grep '^[<>]' | tr -s ' ' | tr '\n' ' ' | cut -c1-200 || true)
  build_changed=$(git -C "$ROOT" diff --name-only "$BASE" HEAD -- build docker-compose.yml dappnode_package.json avatar.png | head -5 | tr '\n' ' ' || true)
  if [ "$cmp" = -1 ]; then
    check FAIL version "$version is lower than $base_version on $BASE (versions only go up)"
  elif [ "$cmp" = 0 ] && [ -n "$manifest_changed" ] && [ -n "$held" ]; then
    check PASS version "still $version while held (the manifest changed: $manifest_changed); nothing is released until the hold ends"
  elif [ "$cmp" = 0 ] && [ -n "$manifest_changed" ]; then
    check FAIL version "still $version although the manifest changed ($manifest_changed); boxes only update to a higher version"
  elif [ "$cmp" = 0 ] && [ "$released" = no ] && [ -z "$held" ]; then
    check PASS version "$version, manifest unchanged, but $version is not released yet: the release publishes it after the merge"
  elif [ "$cmp" = 0 ]; then
    check PASS version "$version, manifest unchanged: nothing will be released"
    [ -z "$build_changed" ] || check INFO build-files "changed without a new version ($build_changed): they reach boxes with the next version"
  else
    check PASS version "$base_version -> $version"
  fi
else
  check INFO base "$name does not exist on $BASE: a new package, nothing to compare"
fi

# --- production ---------------------------------------------------------------------
prod=""
if pointer=$(curl -fsS --max-time 30 -H 'Cache-Control: no-cache' "$STORE_POINTER" 2>/dev/null); then
  store_cid=$(printf '%s' "$pointer" | jq -r 'if type == "string" then fromjson else . end | .hash' 2>/dev/null || true)
  for gw in $GATEWAYS; do
    if [ -n "$store_cid" ] && curl -fsS --max-time 60 "$gw/ipfs/$store_cid" -o "$OUT/store.json" 2>/dev/null &&
      jq -e .packages "$OUT/store.json" >/dev/null 2>&1; then
      prod=$store_cid
      break
    fi
  done
fi
if [ -z "$prod" ]; then
  check INFO production "the production store could not be read; compared with $BASE only"
elif jq -e --arg n "$name" '[.packages[] | select(.manifest.name == $n)] | length == 1' "$OUT/store.json" >/dev/null; then
  jq --arg n "$name" '.packages[] | select(.manifest.name == $n) | .manifest' "$OUT/store.json" >"$OUT/production-manifest.json"
  prod_version=$(jq -r .version "$OUT/production-manifest.json")
  prod_qtum=$(jq -r '.upstream // empty' "$OUT/production-manifest.json")
  if diff -u <(identity "$OUT/production-manifest.json") <(identity "$H") >"$OUT/identity-vs-production.diff"; then
    check PASS identity-vs-production "same name, type, volume, ports and environment keys as production $prod_version"
  else
    check FAIL identity-vs-production "differs from production $prod_version: $(grep '^[-+] ' "$OUT/identity-vs-production.diff" | tr -s ' ' | tr '\n' ' ' | cut -c1-300)"
  fi
  if [ "$(semver_cmp "$version" "$prod_version")" = -1 ]; then
    check FAIL version-vs-production "$version is lower than production $prod_version"
  else
    check PASS version-vs-production "$version, production has $prod_version"
  fi
  if [ -n "$prod_qtum" ] && [ "$(semver_cmp "$qtum" "$prod_qtum")" = -1 ]; then
    check FAIL qtum-vs-production "Qtum $qtum is older than production's $prod_qtum"
  else
    check PASS qtum-vs-production "Qtum $qtum, production runs ${prod_qtum:-?}"
  fi
else
  check INFO production "$name is not in the production store ($prod) yet"
fi

if [ "$fails" = 0 ]; then
  echo "PASS: $name keeps its identity"
else
  echo "FAIL: $fails identity check(s) failed for $name" >&2
  exit 1
fi
