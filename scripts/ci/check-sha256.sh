#!/usr/bin/env bash
# The Qtum tarball docker-compose.yml pins is the one Qtum published.
#
#   scripts/ci/check-sha256.sh
#
# docker-compose.yml has VERSION (the qtumproject/qtum release tag) and
# QTUM_SHA256; the Dockerfile downloads qtum-<version>-x86_64-linux-gnu.tar.gz
# from that release and refuses any other bytes. This check compares the pinned
# sha256 with what the release publishes: GitHub's own digest of the asset (set
# for releases uploaded since mid 2025), the "Hash validation" list in the
# release notes, and, when neither exists, the sha256 of a fresh download.
# A difference means the file was replaced after the bump (or the pin is
# wrong): find out why before releasing.
# The release being a pre-release or a draft, or its tag not being a stable
# tag, also fails. GitHub not answering is a warning, not a failure (the
# build's own sha256 check still protects the image).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
REPO=qtumproject/qtum
arg() { yq ".services[].build.args[] | select(test(\"^$1=\"))" "$ROOT/docker-compose.yml" | sed "s/^$1=//"; }
tag=$(arg VERSION)
pinned=$(arg QTUM_SHA256)
file="qtum-${tag#v}-x86_64-linux-gnu.tar.gz"
echo "$tag" | grep -Eq '^v[0-9]+\.[0-9]+(\.[0-9]+)?$' || { echo "FAIL: VERSION '$tag' is not a stable Qtum release tag (v30.2)" >&2; exit 1; }
echo "$pinned" | grep -Eq '^[0-9a-f]{64}$' || { echo "FAIL: QTUM_SHA256 '$pinned' is not a sha256" >&2; exit 1; }

auth=()
[ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
tmp=$(mktemp)
code=$(curl -sS --retry 3 --max-time 30 ${auth[@]+"${auth[@]}"} -H 'Accept: application/vnd.github+json' -o "$tmp" -w '%{http_code}' \
  "https://api.github.com/repos/$REPO/releases/tags/$tag" || true)
rel=$(cat "$tmp")
rm -f "$tmp"
if [ "$code" = 404 ]; then
  echo "FAIL: $REPO has no release $tag (VERSION in docker-compose.yml)" >&2
  exit 1
elif [ "$code" != 200 ]; then
  echo "::warning::GitHub did not answer (HTTP ${code:-none}); the sha256 of $file was not compared with the release (the build checks the pinned $pinned)"
  exit 0
fi
if [ "$(echo "$rel" | jq -r '.draft or .prerelease')" != false ]; then
  echo "FAIL: $REPO $tag is a draft or a pre-release, not a stable release" >&2
  exit 1
fi
digest=$(echo "$rel" | jq -r --arg f "$file" '.assets[] | select(.name == $f) | .digest // empty' | sed -n 's/^sha256://p')
url=$(echo "$rel" | jq -r --arg f "$file" '.assets[] | select(.name == $f) | .browser_download_url')
[ -n "$url" ] || { echo "FAIL: release $tag has no asset $file" >&2; exit 1; }
listed=$(echo "$rel" | jq -r .body | tr -d '\r' | awk -v f="$file" '$1 ~ /^[0-9a-f]{64}$/ { n = split($2, p, "/"); if (p[n] == f) print $1 }' | head -1)

fails=0 compared=0
if [ -n "$digest" ]; then
  compared=1
  if [ "$digest" = "$pinned" ]; then echo "PASS: GitHub's digest of $file is $pinned, as pinned"; else echo "FAIL: GitHub's digest of $file is $digest, docker-compose.yml pins $pinned" >&2; fails=1; fi
fi
if [ -n "$listed" ]; then
  compared=1
  if [ "$listed" = "$pinned" ]; then echo "PASS: the release notes list $pinned for $file, as pinned"; else echo "FAIL: the release notes list $listed for $file, docker-compose.yml pins $pinned" >&2; fails=1; fi
fi
if [ "$compared" = 0 ]; then
  if got=$(curl -fsSL --retry 3 --max-time 900 "$url" | { command -v sha256sum >/dev/null && sha256sum || shasum -a 256; } | cut -c1-64); then
    if [ "$got" = "$pinned" ]; then echo "PASS: $file downloads with sha256 $pinned, as pinned (the release publishes no hash of its own)"; else echo "FAIL: $file downloads with sha256 $got, docker-compose.yml pins $pinned" >&2; fails=1; fi
  else
    echo "::warning::could not download $file to hash it; the build checks the pinned $pinned"
  fi
fi
[ "$fails" = 0 ] || exit 1
