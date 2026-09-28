#!/usr/bin/env bash
# Loads the image customer boxes run today: the package's entry in the live
# production store (https://bo.ava.do/value/store), its manifest and its image,
# fetched from AVADO's IPFS gateway (ipfs.io as a fallback). Every file is
# checked against its IPFS hash with kubo (ipfs add --only-hash), so the
# gateway does not have to be trusted.
#
#   scripts/ci/production-image.sh <package-name> <tag> <out-dir>
#
# Tags the loaded image <tag> and writes <out-dir>/production.json:
#   { name, version, upstream, manifestHash, imageHash, imageSize, image, imageId, store }
#
# `docker load` also sets the image's own tag (<name>:<production version>),
# which replaces a candidate image with the same tag: tag the candidate by its
# image id BEFORE running this (the PR checks do).
# PRODUCTION_CACHE=<dir> keeps downloads between runs (local use).
set -euo pipefail

NAME=${1:?usage: production-image.sh <package-name> <tag> <out-dir>}
TAG=${2:?usage: production-image.sh <package-name> <tag> <out-dir>}
OUT=${3:?usage: production-image.sh <package-name> <tag> <out-dir>}
STORE_POINTER=${AVADO_STORE_POINTER:-https://bo.ava.do/value/store}
GATEWAYS=${AVADO_IPFS_GATEWAYS:-http://80.208.229.228:8080 https://ipfs.io}
KUBO_IMAGE="ipfs/kubo:v0.25.0@sha256:9d917826eb669276040efb39cf6c68ae7463356a8e216eb13b278de00aa126be"
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
CACHE=${PRODUCTION_CACHE:-$OUT/cache}
mkdir -p "$CACHE"
CACHE=$(cd "$CACHE" && pwd)

die() {
  echo "production-image: $*" >&2
  exit 1
}
log() { echo "production-image: $(date -u +%H:%M:%S) $*" >&2; }

kubo_ready=0
cid_of() { # <file>: the IPFS hash (CIDv0, default chunker) the AVADOSDK and kubo give it
  if [ "$kubo_ready" = 0 ]; then
    docker image inspect "$KUBO_IMAGE" >/dev/null 2>&1 || docker pull -q "$KUBO_IMAGE" >/dev/null
    kubo_ready=1
  fi
  docker run --rm -v "$1:/f:ro" --entrypoint sh "$KUBO_IMAGE" -c 'ipfs init -e >/dev/null 2>&1; ipfs add -Q --only-hash /f'
}

fetch_cid() { # <cid> <out-file> [max seconds]: download from a gateway and verify the hash
  local cid=${1#/ipfs/} out=$2 max=${3:-60} gw
  if [ -f "$out" ] && [ "$(cid_of "$out")" = "$cid" ]; then return 0; fi
  for gw in $GATEWAYS; do
    if curl -fsS --retry 2 --max-time "$max" "$gw/ipfs/$cid" -o "$out.part" 2>/dev/null; then
      if [ "$(cid_of "$out.part")" = "$cid" ]; then
        mv "$out.part" "$out"
        return 0
      fi
      log "$gw returned content that does not match $cid; trying the next gateway"
    fi
  done
  rm -f "$out.part"
  die "could not fetch $cid (with a matching hash) from: $GATEWAYS"
}

log "reading the production store pointer $STORE_POINTER"
pointer=$(curl -fsS --retry 3 --max-time 30 -H 'Cache-Control: no-cache' "$STORE_POINTER") || die "cannot read $STORE_POINTER"
store_cid=$(printf '%s' "$pointer" | jq -r 'if type == "string" then fromjson else . end | .hash')
[ -n "$store_cid" ] && [ "$store_cid" != null ] || die "the store pointer has no hash: $pointer"
fetch_cid "$store_cid" "$OUT/store.json"
jq --arg n "$NAME" '[.packages[] | select(.manifest.name == $n)] | if length == 1 then .[0] else error("\(length) store entries for \($n)") end' \
  "$OUT/store.json" >"$OUT/store-entry.json" || die "$NAME is not (exactly once) in the production store $store_cid"
fetch_cid "$(jq -r .manifesthash "$OUT/store-entry.json")" "$OUT/production-manifest.json"
version=$(jq -r .version "$OUT/production-manifest.json")
upstream=$(jq -r '.upstream // empty' "$OUT/production-manifest.json")
image_hash=$(jq -r .image.hash "$OUT/production-manifest.json")
image_size=$(jq -r .image.size "$OUT/production-manifest.json")
[ -n "$image_hash" ] && [ "$image_hash" != null ] || die "the production manifest of $NAME has no image hash"
log "production store $store_cid: $NAME $version (Qtum ${upstream:-?}), image ${image_hash#/ipfs/} ($image_size bytes)"

file="$CACHE/${image_hash#/ipfs/}.tar.xz"
fetch_cid "$image_hash" "$file" 1800
[ "$(wc -c <"$file" | tr -d ' ')" = "$image_size" ] || die "the production image size differs from the manifest"
loaded=$(docker load -i "$file" | sed -n 's/^Loaded image: //p' | tail -1)
[ -n "$loaded" ] || die "docker load did not report an image"
docker tag "$loaded" "$TAG"
image_id=$(docker image inspect --format '{{.Id}}' "$TAG")
jq -n --arg name "$NAME" --arg version "$version" --arg upstream "$upstream" \
  --arg manifestHash "$(jq -r .manifesthash "$OUT/store-entry.json")" --arg imageHash "$image_hash" --argjson imageSize "$image_size" \
  --arg image "$TAG" --arg imageId "$image_id" --arg store "$store_cid" \
  '{name: $name, version: $version, upstream: $upstream, manifestHash: $manifestHash, imageHash: $imageHash,
    imageSize: $imageSize, image: $image, imageId: $imageId, store: $store}' >"$OUT/production.json"
log "loaded $loaded as $TAG ($image_id)"
echo "$OUT/production.json"
