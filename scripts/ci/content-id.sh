#!/usr/bin/env bash
# Prints the content id of a commit: a hash of every file git tracks at that
# commit EXCEPT the release record releases.json.
#
#   scripts/ci/content-id.sh [commit]        (default HEAD)
#
# The PR checks name the build they tested after it (artifact
# avado-build-<content id>), and release.yml looks the build up by the content
# id of the default branch. A "Release ..." commit only changes releases.json,
# so the id stays the same after a partial release and a re-run still finds
# the tested build. A merge commit, a squash merge and the PR head have the
# same id when they contain the same files.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
REV=${1:-HEAD}
if command -v sha256sum >/dev/null; then sum() { sha256sum; }; else sum() { shasum -a 256; }; fi
git -C "$ROOT" ls-tree -r --full-tree "$REV" |
  { grep -Ev $'\treleases\\.json$' || true; } |
  sum | cut -c1-40
