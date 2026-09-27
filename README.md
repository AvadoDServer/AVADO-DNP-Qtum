# AVADO Qtum

The Qtum mainnet node for AVADO: package `qtum.avado.dnp.dappnode.eth`, with a
setup wizard (`http://qtum.my.ava.do`), the Qtum web wallet
(`https://qtum.my.ava.do`) and super staking.

## Layout

```
dappnode_package.json   the manifest: name, version, "upstream" (the Qtum Core tag),
                        volume data:/package/data, ports 3888 (P2P) and 3889 (RPC),
                        environment EXTRA_OPTS
docker-compose.yml      build args VERSION (the qtumproject/qtum release tag, e.g.
                        v30.2) and QTUM_SHA256 (sha256 of its x86_64 Linux tarball);
                        the only place the Qtum version is written besides "upstream"
releases.json           the release record (written by release.yml)
hold                    only while the owner holds the package back (see "Hold")
build/Dockerfile        downloads the pinned tarball and refuses any other bytes;
                        builds the wizard and the monitor
build/files/            qtum.conf, supervisord.conf (the qtumd command line), nginx.conf
build/monitor/          the monitor: starts qtumd, upgrades old (legacy) wallets to
                        descriptor wallets, exports and imports keys, restores backups
build/wizard/           the setup wizard (React)
test/smoke-test.sh      regtest smoke test: every RPC the wizard uses, every monitor endpoint
scripts/ci/             the checks the pipeline runs (see "Checks")
.github/workflows/      pr-checks, bump, gate, release (see "How releases work")
.github/pipeline/       the bump, gate and release logic (Node, no dependencies)
```

## How releases work

In plain words: **a robot prepares every Qtum update, our own checks test it
(also every private key of old wallets), it waits 72 hours after the Qtum
release (at once for a hard fork), and a tested update goes to the staging
store by itself. Customers only get it when you publish it to production in
editstore, as before.** A new *major* Qtum version is never merged by the
robot: you review it. Until you set `PIPELINE_MODE` to `on`, the robot only
prepares and comments; it never merges (see "Modes").

DAppNode has no Qtum package, so unlike Teku there is no second opinion from
DAppNode's real node: the 72-hour wait with our checks green takes its place.

1. **Bump** (every 4 hours, `bump.yml`). When Qtum publishes a new stable
   release (github.com/qtumproject/qtum, tags like `v30.3`; pre-releases and
   release candidates are ignored) and its Linux tarball
   `qtum-<version>-x86_64-linux-gnu.tar.gz` is attached, the robot opens ONE
   pull request on branch `avado-bot/bump`: `VERSION` and `QTUM_SHA256` in
   `docker-compose.yml` and the compose image tag, and `upstream` and
   `version` (one step up) in `dappnode_package.json`. The sha256 is taken from
   the downloaded tarball and must equal every hash Qtum and GitHub publish for
   it (GitHub's asset digest, the "Hash validation" list in the notes). If an
   even newer Qtum appears while the PR is open, the same PR is updated. If you
   close the PR without merging, that Qtum release is skipped and the robot
   waits for the next one (reopen the PR to undo).
2. **Hard forks** (bump and gate). When the notes of a release newer than what
   production runs say "Mandatory update before Mainnet block N" (or its title
   says "Hard Fork"), you get an issue **at once**, with the block and its
   estimated date (from the chain height on qtum.info, and Qtum's own "Fork
   ETA"). It is updated every 4 hours, emails you again when the fork is less
   than 48 hours away or has passed while production still runs an older Qtum,
   and closes by itself when the production store runs the fork release.
3. **Checks** (`pr-checks.yml`, status `avado/checks`), on free GitHub machines:
   - the tarball the compose file pins is the one the Qtum release publishes;
   - the package is built with the AVADOSDK exactly as before (files added to
     AVADO's IPFS node), and the image is loaded back from the uploaded file;
   - the `qtumd` and `qtum-cli` inside are exactly the new version;
   - every `qtumd` option (the supervisord command line) and every `qtum.conf`
     key we use (also the delegation settings the monitor writes) exists, and
     `qtumd` really starts with them without "Ignoring unknown configuration
     value" (Qtum only logs that and silently drops the setting);
   - the **regtest smoke test**: every RPC the wizard uses, every monitor
     endpoint, the key export re-derives its address, and other web sites
     cannot use `/rpc` or change the monitor;
   - the **wallet regression**: wallets made by Qtum 22.1 (packages
     0.0.9/0.0.10) and 0.20.3 (0.0.1-0.0.8), one with a password, and a
     descriptor wallet made by the **production image**, are upgraded by the
     new build; the wizard's "Show private key" must return exactly the key the
     old wallet had for every address (HD, change, imported), a wrong password
     changes nothing, the password never appears in the logs, a copy of the old
     wallet is kept, a restart does not upgrade again, and the chain data the
     older version wrote opens without a reindex;
   - the package **boots on Qtum mainnet** with its real command line: the
     wallet of a new box is made, it finds a peer, the header sync moves, every
     published port has a listener, and `docker stop` stops qtumd cleanly;
   - the package name, volume, ports and settings names are the same as on
     the default branch and in production, the version goes up, and Qtum
     never goes back to an older version.
   A check that fails only because of the public network (peers, header sync)
   is tried once more on the spot.
4. **Gate** (every 4 hours, after every check run and after the bump, `gate.yml`,
   status `avado/gate`). It merges the PR (a merge commit) only when our checks
   are green, the branch contains the default branch, it is **not a new major
   Qtum version**, and:
   - **72 hours** have passed since the Qtum release; or
   - the release is a **hard fork** (or the release watcher marks it URGENT):
     then it does not wait.

   It does **not** merge when our checks fail, when anything is unclear, when
   the new Qtum is a new **major** version (v30 → v31: it opens a "needs review"
   issue with a Claude Code prompt; Bitcoin Core majors remove RPCs and wallet
   features, v30 broke the wizard's key export and import), or when a person
   pushed changes to the checks, their test scripts or the pipeline onto the
   robot's branch (those are yours to review and merge). Then it opens an issue
   for you (see "What the emails mean"). Checks that failed on an outside step
   (the build, the mainnet boot, the production image download) are first run
   once more, without an email. The gate writes its reasoning in a comment on
   the PR, updated on every run. It also starts the release when a version on
   the default branch never got a release run.
5. **Release** (`release.yml`, after the merge). When the version is new and
   the package is not held, it is published to the **staging** store: **only
   the exact build the checks tested for these files** (found by a content id
   that ignores `releases.json`; a merge commit, a squash and a re-run all find
   it), its hash recorded in `releases.json` and in a commit
   `Release <name> <version>` (the format the release watcher and editstore
   know), then `store.setPackageHash` and one `store.releaseStore`, with the
   `RPC_TOKEN` secret, as the old `ci-release-action` did. It never builds
   anything itself. Without a tested build nothing is published, and you get an
   issue that says what to do (below). Without `RPC_TOKEN` it only shows what it
   would do.
6. **Production**: unchanged. You publish it in editstore when you are happy
   with staging (for a hard fork: before the fork date, with a margin).

Human pull requests get the same checks. **Open them from a branch in this
repo** (not a fork) and merge them yourself with **"Create a merge commit"**
when the branch is up to date with the default branch: the release then
publishes the version you raised, from the build the checks tested. Pull
requests from forks are checked on a throwaway IPFS node and their builds are
never released; after merging one, run the checks for the default branch
(below).

**"Release: NOT published ... no tested build"**: the default branch has files
the checks never tested (a merge while the branch was behind, a fork PR, a
direct push). Actions → **PR checks** → Run workflow with `pr` = `main`; when it
is green, Actions → **Release** → Run workflow.

### Modes

Settings → Secrets and variables → Actions → **Variables** → repository
variable `PIPELINE_MODE`:

| Value | Effect |
|---|---|
| (not set) or `shadow` | The robot bumps, the checks run, hard forks are reported; the gate says what it *would* do (status and PR comment) but never merges. This is the default. |
| `on` | Normal: bump, check, gate, merge, release to staging |
| `off` | The bump robot and the gate do nothing (no hard-fork issues either; the release watcher still reports forks). Checks still run on pull requests, and a merge you make yourself is still released to staging |

A merge you make yourself is released to staging in every mode.

Other variables: `PIPELINE_OWNER` (who gets the issues, default `flisko`),
`IPFS_PROVIDER` (leave empty; `local` is only for a test copy of this repo, its
builds can never be released).

### Hold

A file `hold` in the repo root, whose first line says why, holds the package
back: it is not bumped, not built by the checks and not released; boxes keep the
version they have. Hard forks are still reported. You end a hold by removing the
file in a pull request you merge yourself; its checks then build and test the
package, and the merge publishes it to staging.

### What the emails mean

GitHub emails the person an issue is assigned to (`PIPELINE_OWNER`). Keep
**Email** ticked for "Participating, @mentions and custom" in
github.com/settings/notifications.

- **"[hard fork] Qtum <version>: required before mainnet block N (about <date>)"**:
  a Qtum hard fork is coming. Boxes still on an older Qtum at that block stop
  following the chain and stop staking. Make sure the bump PR is merged, check
  it on staging, and **publish it to production before the date**. You get
  another email when it is less than 48 hours away (or has passed) and
  production still runs an older Qtum. It closes by itself when production has it.
- **"[needs review] Qtum <version>: new MAJOR version ..."**: the robot never
  merges a new major Qtum. The issue has the check results and a Claude Code
  prompt that walks through the removed RPCs and wallet changes. Merge the PR
  yourself with "Create a merge commit" when you are happy, or close it to skip.
- **"[needs fix] Qtum <version>: our checks failed ..."**: the new Qtum broke
  something (a removed RPC the wizard uses, an option that no longer exists, a
  wallet that no longer upgrades), and the automatic re-run did not help.
  Nothing was merged or released. The issue has the failing check, its log
  lines, and a **ready-to-paste Claude Code prompt**: run `gh pr checkout <n>`,
  start `claude`, paste the prompt, review, push. The checks run again and the
  gate merges when they are green. The issue closes by itself.
- **"[needs review] Qtum <version>: a person changed the checks or the
  pipeline ..."**: someone (or Claude Code) pushed changes to the checks, their
  test scripts or the pipeline onto the robot's PR. Read them, and merge the PR
  yourself if they are right.
- **"[pipeline broken] <workflow> workflow failed"**: the robot itself broke
  (GitHub, qtum.info, AVADO's IPFS node or store did not answer, or a bug), or
  the release found no tested build. Nothing reaches any box. The issue shows
  the error, the run link and a prompt; it closes by itself after the next
  successful run.
- **"[pipeline] PAT_TOKEN was rejected: renew it"**: the personal token expired.
  The robot keeps working without it; renew it when convenient (see "Secrets").
- A comment on one of these issues means the situation changed (a new failure,
  or it came back). A problem that stays the same does not send more emails.

Also watch for: the release watcher (`AvadoDServer/avado-release-control`)
emails "URGENT: pipeline workflows stopped" when `bump.yml` or `gate.yml` is
disabled or keeps failing (once this repo is added to its `workflows` list).
GitHub switches off scheduled workflows in a public repo after 60 days without
commits ("disabled_inactivity"); the fix is Actions → the workflow → **Enable
workflow**.

### Secrets

- `RPC_TOKEN` (organisation secret, as before): used only by `release.yml` for
  `store.setPackageHash` and `store.releaseStore`. The release job runs no build
  and no third-party code next to it.
- `PAT_TOKEN` (repository secret, optional): the bump robot pushes and opens its
  PR with it, so the checks start by themselves (GitHub does not start
  workflows for changes made with the built-in token). Use a **fine-grained**
  token: resource owner AvadoDServer, only this repository, Contents and Pull
  requests read and write, with an expiry date. Not a classic `repo` token: it
  would open every AvadoDServer repository. When it is missing or expired, the
  robot starts the checks itself through `workflow_dispatch` (the PR then also
  shows a "PR checks" run marked "action required" that can be ignored) and
  emails you once to renew it.
- `WATCHER_READ_TOKEN` (optional): lets the gate read the release watcher's
  URGENT issues. A fine-grained token for `AvadoDServer/avado-release-control`
  with Issues: read only. Without it the gate uses the Qtum release notes, and
  the PR comment says "release watcher: not read".

### Update Qtum by hand

Change `VERSION` and `QTUM_SHA256` in `docker-compose.yml` (the sha256 from the
release's "Hash validation" list, or `sha256sum` of the downloaded tarball),
set `upstream` to the same tag and raise `version` in `dappnode_package.json`
and the compose image tag, open a pull request from a branch in this repo, and
merge it when `avado/checks` is green. (Or run the Bump Qtum workflow by hand.)

## Checks

The scripts the checks run also work on your Mac (Docker needed; an Apple
Silicon Mac runs the amd64 image slowly, the mainnet boot is best left to CI):

```bash
scripts/ci/check-identity.sh origin/master       # name, volume, ports, env keys, versions
scripts/ci/check-sha256.sh                       # the pinned tarball is the one Qtum published
docker build --platform linux/amd64 -t qtum-test \
  --build-arg VERSION=v30.2 --build-arg QTUM_SHA256=<sha256 from docker-compose.yml> build/
scripts/ci/check-version.sh qtum-test v30.2
scripts/ci/check-flags.sh qtum-test
test/smoke-test.sh qtum-test
scripts/ci/production-image.sh qtum.avado.dnp.dappnode.eth avado-ci/production:latest /tmp/prod
scripts/ci/legacy-wallet-test.sh qtum-test avado-ci/production:latest /tmp/wallets
scripts/ci/boot-test.sh qtum-test /tmp/boot
node --test ".github/pipeline/test/*.test.mjs"   # the gate's rules (Node 22)
```

`scripts/ci/sdk-build.sh <out> <ipfs api>` is the AVADOSDK build the checks use
(AVADOSDK pinned at commit 23d6757). `scripts/ci/content-id.sh` prints the
content id the tested build is named after.

The wallet regression runs every wallet offline (mainnet, no peers), so it is
exact and repeatable; its wallets hold no coins. Their keys stay on the runner
(`<out>/keys/`) and are never uploaded. The old Qtum versions run with the
command line every package has used (`-superstaking`), because that decides how
the chain database is indexed. The mainnet boot proves peers, the header sync
and a clean start and stop with the package's real command line, not block
validation or staking with real weight (a GitHub machine has neither the time
nor a funded wallet).

## Test copy (dry run)

To try the pipeline without touching this repo or the store: push it to a
private repository, set the variable `IPFS_PROVIDER=local` there (builds go to a
throwaway IPFS node on the runner), do not add `RPC_TOKEN` (the release is a
dry run), set `PIPELINE_MODE=on` if the gate should merge, and tick Settings →
Actions → General → "Allow GitHub Actions to create and approve pull requests"
(needed without `PAT_TOKEN`). Run "Bump Qtum" by hand with a `version` to
simulate a release; a version that does not exist makes the build fail, which
exercises the issue path. Set `PIPELINE_MODE=off` there afterwards. The first
copy is `flisko/qtum-pipeline-dryrun` (private, paused).
