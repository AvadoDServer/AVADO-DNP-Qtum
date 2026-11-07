#!/usr/bin/env bash
# The Qtum Core inside the image is exactly the release the repo pins.
#
#   scripts/ci/check-version.sh <image> <qtum-tag>        (for example v30.2)
#
# Runs `qtumd -version` and `qtum-cli -version` in the image (no node starts)
# and requires "version v30.2.0" for the tag v30.2 (v30.2.1 for v30.2.1). The
# Dockerfile already refuses a tarball whose sha256 differs from QTUM_SHA256;
# this proves the binaries on the PATH are the ones from that tarball. The
# Qtum v29.1 wallet tool (only used to flush old legacy wallets) is printed as
# information.
set -euo pipefail

IMAGE=${1:?usage: check-version.sh <image> <qtum-tag>}
TAG=${2:?usage: check-version.sh <image> <qtum-tag>}
case "$TAG" in
v[0-9]*.[0-9]*.[0-9]*) WANT=$TAG ;;
v[0-9]*.[0-9]*) WANT=$TAG.0 ;;
*) echo "FAIL: '$TAG' is not a Qtum release tag like v30.2" >&2; exit 1 ;;
esac

out=$(docker run --rm --platform linux/amd64 --entrypoint /bin/sh "$IMAGE" -c \
  'command -v qtumd; qtumd -version | head -1; qtum-cli -version | head -1; /usr/local/lib/qtum-legacy/qtum-wallet -version 2>/dev/null | head -1 || true' 2>&1) || true
printf '%s\n' "$out" | sed 's/^/  /'
path=$(printf '%s\n' "$out" | sed -n 1p)
daemon=$(printf '%s\n' "$out" | grep -m1 '^Qtum Core daemon version ' || true)
cli=$(printf '%s\n' "$out" | grep -m1 '^Qtum Core RPC client version ' || true)
fails=0
if [ "$path" != /usr/local/bin/qtumd ]; then
  echo "FAIL: qtumd on the PATH is '$path', expected /usr/local/bin/qtumd (from the pinned tarball)" >&2
  fails=1
fi
for line in "$daemon" "$cli"; do
  case "$line" in
  *" version $WANT "* | *" version $WANT") ;;
  *)
    echo "FAIL: expected Qtum Core $WANT, the image says: ${line:-<no version line>}" >&2
    fails=1
    ;;
  esac
done
[ "$fails" = 0 ] || exit 1
echo "PASS: the image runs Qtum Core $WANT (qtumd and qtum-cli)"
