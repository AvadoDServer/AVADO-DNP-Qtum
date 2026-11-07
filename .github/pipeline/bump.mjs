#!/usr/bin/env node
// Bump bot (bump.yml, every 4 hours): when a newer stable Qtum Core release
// exists (github.com/qtumproject/qtum, tags like v30.2), open or update ONE pull
// request on branch avado-bot/bump that moves the package to it: VERSION and
// QTUM_SHA256 (the sha256 of its x86_64 Linux tarball, downloaded and compared
// with every hash Qtum and GitHub publish) in docker-compose.yml, the compose
// image tag, and "upstream" and "version" (one patch up) in dappnode_package.json.
// A release whose PR the owner closed without merging is skipped: the bot waits
// for a newer Qtum release (reopening the PR undoes the skip). A held package
// (file "hold" in the repo root) is left alone.
//
// Hard forks: a release whose notes say "Mandatory update before Mainnet block
// N" opens an issue for the owner AT ONCE, with the block and its estimated
// date (lib/qtum.js), whether or not a PR can be opened yet.
//
// Environment:
//   GITHUB_REPOSITORY, GITHUB_TOKEN   this repo; reads, and the fallback for writes
//   PAT_TOKEN                          optional: pushes and PRs made with it start
//                                      the PR checks (GITHUB_TOKEN ones do not);
//                                      without it, or when GitHub rejects it
//                                      (expired), the checks are started by hand
//                                      (workflow_dispatch of pr-checks.yml) and
//                                      the owner gets an issue to renew it
//   PIPELINE_OWNER                     who gets the issues (default flisko)
//   PIPELINE_MODE                      only for the wording of the hard-fork issue
//   INPUT_VERSION                      TEST ONLY: pretend this Qtum tag is the newest
//   DRY_RUN=true                       print what would happen, write nothing
//
// Run in a checkout of the default branch with full history (fetch-depth: 0).

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeClient } from './lib/gh.js';
import { upsertIssue, findIssue, closeIssue } from './lib/issue.js';
import { tarballSha256, publishedSha256, assertPinUnchanged, syncForkIssues, readQtumHeight, forkWhen } from './lib/qtum.js';
import {
  BOT_NAME, BOT_EMAIL, BOT_BRANCH, UPSTREAM_REPO, MANIFEST, COMPOSE, bumpMarker, markerTarget, compareVersions, maxVersion, bumpPatch,
  stableReleases, isMajorBump, readQtumVersion, readQtumSha256, setQtumVersion, setQtumSha256, setImageVersion, setManifestField, readPackage,
  holdReason, isReleased, git, fetchBranch, pushHead, isWorkflowPushRefusal, remoteSha, releasedVersions, readProductionVersions, assetName,
  env, fmtUtc, hoursBetween, notice, warning, recordFailure,
} from './lib/common.js';

const root = process.cwd();
const repo = env('GITHUB_REPOSITORY');
const token = env('GITHUB_TOKEN');
const pat = env('PAT_TOKEN');
const pretend = env('INPUT_VERSION');
const dryRun = env('DRY_RUN') === 'true';
const owner = env('PIPELINE_OWNER', 'flisko');
const mode = env('PIPELINE_MODE', 'shadow');
// How long a Qtum release may lack its Linux tarball before the bot says so.
const ASSET_WAIT_HOURS = 24;
const ZERO_SHA = '0'.repeat(64);
const summary = [];
const say = (line) => { console.log(line); summary.push(line); };

function writeSummary() {
  const f = env('GITHUB_STEP_SUMMARY');
  if (f) appendFileSync(f, `${summary.join('\n')}\n`);
}

function isBotCommit(c) {
  const email = c.commit?.author?.email || '';
  const msg = c.commit?.message || '';
  return email === BOT_EMAIL && (/^Bump Qtum to /.test(msg) || /^Merge .* into avado-bot\/bump/.test(msg));
}

// Is PAT_TOKEN still accepted? An expired or revoked token answers 401.
async function patWorks() {
  if (!pat) return false;
  try {
    await makeClient({ token: pat }).get(`repos/${repo}`);
    return true;
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      warning(`PAT_TOKEN was rejected (HTTP ${err.status}: expired or revoked); using the built-in token and starting the checks by hand`);
      return false;
    }
    warning(`could not check PAT_TOKEN (${err.message}); trying it anyway`);
    return true;
  }
}

async function reportPat(gh, ok) {
  if (dryRun) return;
  const key = 'pat-token-rejected';
  try {
    if (ok || !pat) {
      const issue = await findIssue(gh, repo, key);
      if (issue?.state === 'open') await closeIssue(gh, repo, issue, pat ? 'PAT_TOKEN works again.' : 'PAT_TOKEN is not set any more; the bot works without it (it starts the checks itself).');
      return;
    }
    await upsertIssue(gh, repo, {
      key,
      title: '[pipeline] PAT_TOKEN was rejected: renew it',
      assignee: owner,
      state: 'rejected',
      body: `GitHub rejected the repository secret \`PAT_TOKEN\` (a personal access token; they expire). The bump bot still works: it pushes with the built-in token and starts the PR checks itself, so the PR shows an extra "PR checks" run marked "action required" that can be ignored.

**To fix it:** create a fine-grained token at github.com/settings/personal-access-tokens: resource owner AvadoDServer, only this repository (${repo}), permissions Contents, Pull requests and Workflows: read and write, with an expiry date. Then Settings -> Secrets and variables -> Actions -> \`PAT_TOKEN\` -> Update. This issue closes by itself on the next bump run after that.`,
    });
  } catch (err) {
    warning(`could not report the PAT_TOKEN state (${err.message})`);
  }
}

function renderBody({ target, from, release, row, skipped, forks, major, sha, pretendNote, checksNote, marker }) {
  const skippedText = skipped.length ? `\nThis also covers ${skipped.map((s) => `[${s}](https://github.com/${UPSTREAM_REPO}/releases/tag/${s})`).join(', ')}.` : '';
  const forkText = forks.length
    ? `\n> **Hard fork:** ${forks.map((f) => `Qtum ${f.tag} is required before ${f.block ? `mainnet block ${f.block}` : 'its fork'} (${forkWhen(f)})`).join('; ')}. The gate does not wait the 72 hours for this one, and the owner has an issue with the date.\n`
    : '';
  const majorText = major
    ? `\n> **New MAJOR Qtum version (${from} → ${target}).** The gate never merges this PR by itself: a new Bitcoin Core major can remove RPCs and wallet features (v30 removed legacy wallets, \`dumpprivkey\` and \`importprivkey\`, which broke the wizard). The owner has an issue with a review prompt; the checks below still run, so the review starts from their results.\n`
    : '';
  return `${marker}
## Qtum Core ${target}
${pretendNote || ''}
Qtum Core ${from} → **${target}**${release ? ` ([release notes](${release.html_url}), published ${fmtUtc(release.published_at)})` : ''}.${skippedText}
${forkText}${majorText}
| Package | Now | New |
|---|---|---|
| \`${row.name}\` | ${row.from} | **${row.to}** |

Tarball \`${assetName(target)}\`: sha256 \`${sha}\`${row.shaSources ? ` (${row.shaSources.join(', ')})` : ''}.

### What happens next (nothing to do unless you get an email)
1. **Checks** (\`avado/checks\`): the package is built with the AVADOSDK; the exact \`qtumd\` version and the tarball's sha256 are checked; every \`qtumd\` option and \`qtum.conf\` key we use must be accepted; the regtest smoke test calls every RPC the wizard uses and every monitor endpoint; the legacy-wallet test upgrades wallets made by old Qtum versions and by the production image and compares every private key; the package boots on Qtum mainnet (peers, header sync moving); name, volume, ports and settings are compared with the default branch and production.${checksNote || ''}
2. **Gate** (\`avado/gate\`, every 4 hours and after the checks): merges this PR when the checks are green **and** 72 hours have passed since the Qtum release (at once for a hard fork). ${major ? '**Not for this PR: it is a new major version.** ' : ''}If a check fails or anything is unclear, it does **not** merge and opens an issue assigned to the owner with a ready-to-paste Claude Code prompt.
3. **Release**: after the merge the version is published to the **staging** store, from exactly the build the checks tested. Production stays a manual click in editstore.

Pushing a fix to \`${BOT_BRANCH}\` is fine: the bot keeps your commits (a fix that touches \`.github/\`, \`scripts/\`, \`test/\`, \`hold\` or \`releases.json\`, or changes \`VERSION\` or \`QTUM_SHA256\`, is left for the owner to merge). **Closing this PR without merging skips Qtum ${target}**: the bot waits for a newer Qtum release (reopen the PR to undo). To pause the bot, set the repository variable \`PIPELINE_MODE\` to \`off\` (see README).
`;
}

async function main() {
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  const gh = makeClient({ token });
  const meta = await gh.get(`repos/${repo}`);
  const base = meta.default_branch;
  const repoOwner = repo.split('/')[0];

  // Checked on every run, so an expired PAT_TOKEN is noticed before a release waits.
  let patOk = await patWorks();
  await reportPat(gh, patOk || !pat);
  const writeToken = () => (patOk ? pat : token);

  fetchBranch(root, token, base);
  const onBase = readPackage(root, `origin/${base}`);
  const mainQtum = onBase.qtum;

  // --- upstream, the production store, hard forks ----------------------------------
  const rels = await gh.get(`repos/${UPSTREAM_REPO}/releases?per_page=40`);
  const upstreamList = stableReleases(rels);
  if (!upstreamList.length) throw new Error(`no stable ${UPSTREAM_REPO} release in the API answer; refusing to guess`);
  let prod = null;
  try {
    prod = await readProductionVersions({ http: gh.http });
  } catch (err) {
    warning(`production store unreadable (${err.message}); versions are based on git history only`);
  }
  const prodManifest = prod?.manifests.get(onBase.name) || null;
  const prodQtum = prodManifest?.upstream || null;

  const openPrs = await gh.get(`repos/${repo}/pulls?state=open&head=${repoOwner}:${encodeURIComponent(BOT_BRANCH)}`);
  let pr = (openPrs || [])[0] || null;

  // The owner hears about a hard fork at once, before anything else can fail
  // (also while the package is held: the issue then says so).
  const hold = holdReason(root, `origin/${base}`);
  const qtum = await readQtumHeight(gh.http);
  const forksAll = await syncForkIssues({
    gh, repo, owner, releases: upstreamList, prodQtum, mainQtum, qtum, pr, mode, held: hold, mainReleased: isReleased(root, `origin/${base}`), dryRun, say,
  });

  let target;
  let release = null;
  if (pretend) {
    target = pretend.startsWith('v') ? pretend : `v${pretend}`;
    compareVersions(target, '0.0.0');
    release = upstreamList.find((r) => r.tag_name === target) || null;
    notice(`TEST: pretending Qtum ${target} is the newest release (input "version")`);
  } else {
    release = upstreamList[0];
    target = release.tag_name;
  }
  say(`Qtum on ${base}: ${mainQtum} (package ${onBase.name} ${onBase.version}). Production: ${prodManifest ? `${prodManifest.version} (Qtum ${prodQtum})` : 'unreadable'}. Newest stable Qtum: ${target}${pretend ? ' (pretend)' : ''}.`);

  let prQtum = null;
  let prSha = null;
  if (pr) {
    fetchBranch(root, token, BOT_BRANCH);
    const prCompose = git(root, ['show', `origin/${BOT_BRANCH}:${COMPOSE}`]);
    prQtum = readQtumVersion(prCompose);
    try { prSha = readQtumSha256(prCompose); } catch { /* a person broke the line: the checks say so */ }
  }

  if (hold) {
    say(`${onBase.name} is HELD on ${base} (${hold}): nothing is bumped. Remove the "hold" file in a PR you merge yourself to end the hold.`);
    return;
  }

  if (compareVersions(target, mainQtum) <= 0) {
    say(`Nothing to do: ${base} already has Qtum ${mainQtum}.`);
    if (pr && compareVersions(prQtum, mainQtum) <= 0) {
      say(`Closing PR #${pr.number}: it offers Qtum ${prQtum}, ${base} already has ${mainQtum}.`);
      if (!dryRun) {
        const ghw = makeClient({ token: writeToken() });
        await ghw.post(`repos/${repo}/issues/${pr.number}/comments`, { body: `Closed by the bump bot: \`${base}\` already has Qtum ${mainQtum}.` });
        await ghw.patch(`repos/${repo}/pulls/${pr.number}`, { state: 'closed' });
        try { await ghw.del(`repos/${repo}/git/refs/heads/${BOT_BRANCH}`); } catch { /* already gone */ }
      }
    }
    return;
  }

  // A release whose PR the owner closed without merging is skipped.
  if (!pr && !pretend) {
    const closed = await gh.get(`repos/${repo}/pulls?state=closed&head=${repoOwner}:${encodeURIComponent(BOT_BRANCH)}&per_page=50`);
    const skippedBy = (closed || []).find((p) => !p.merged_at && markerTarget(p.body) === target);
    if (skippedBy) {
      say(`Qtum ${target} was skipped by the owner (PR #${skippedBy.number} was closed without merging); waiting for a newer Qtum release. Reopen PR #${skippedBy.number} to undo.`);
      return;
    }
  }

  // --- the new package version -------------------------------------------------------
  const released = releasedVersions(root, onBase.name, `origin/${base}`);
  const prodVersion = prod?.versions.get(onBase.name) || null;
  const highest = maxVersion([onBase.version, ...released, prodVersion].filter(Boolean));
  const row = { name: onBase.name, from: onBase.version, to: bumpPatch(highest), prodVersion, shaSources: null };

  // --- the open PR as it is --------------------------------------------------------------
  let humanCommits = [];
  let upToDate = false;
  if (pr) {
    const commits = await gh.get(`repos/${repo}/pulls/${pr.number}/commits?per_page=100`);
    humanCommits = (commits || []).filter((c) => !isBotCommit(c));
    upToDate = (() => { try { git(root, ['merge-base', '--is-ancestor', `origin/${base}`, `origin/${BOT_BRANCH}`]); return true; } catch { return false; } })();
    const prVersion = JSON.parse(git(root, ['show', `origin/${BOT_BRANCH}:${MANIFEST}`])).version;
    if (prQtum === target && upToDate && compareVersions(prVersion, row.to) >= 0) {
      // Nothing to push, and no need to download the tarball again: its pin is
      // compared with the hashes the release publishes now.
      if (release && prSha && prSha !== ZERO_SHA) assertPinUnchanged({ release, pinned: prSha, where: `PR #${pr.number}` });
      if (release && publishedSha256(release).missing) warning(`${assetName(target)} is no longer attached to Qtum ${target}'s release; PR #${pr.number} keeps its pin (a rebuild would fail)`);
      say(`PR #${pr.number} already offers Qtum ${target} on top of the current ${base}; nothing to push.`);
      return;
    }
  }

  // The Linux tarball must exist before anything is built from it; its sha256 is pinned.
  let sha;
  const t = release ? await tarballSha256(release) : { missing: true, name: assetName(target) };
  if (!t.missing) {
    sha = t.sha256;
    row.shaSources = t.sources;
  } else if (pretend) {
    sha = ZERO_SHA;
    notice(`TEST: ${assetName(target)} does not exist; the PR pins a sha256 of zeros, so the checks fail (that exercises the issue path)`);
  } else {
    const ageH = release?.published_at ? hoursBetween(release.published_at, new Date()) : 0;
    if (ageH > ASSET_WAIT_HOURS) {
      throw new Error(`Qtum ${target} was released on GitHub ${fmtUtc(release.published_at)} (${Math.floor(ageH)} h ago), but its Linux build ${t.name} is still not attached to the release. Check whether Qtum renamed the file or skipped the Linux build; the bump bot waits until it exists.`);
    }
    say(`Waiting: Qtum ${target} is released on GitHub but ${t.name} is not attached yet. The next run tries again (the owner is told after ${ASSET_WAIT_HOURS} h).`);
    return;
  }
  // A file Qtum replaced after the bump pinned it is never re-pinned.
  if (pr && prQtum === target && prSha && prSha !== ZERO_SHA && release && !t.missing) {
    assertPinUnchanged({ release, pinned: prSha, where: `PR #${pr.number}`, now: t });
  }
  const shaSources = row.shaSources;

  // Releases this PR covers, and the hard forks among them.
  const covered = upstreamList.filter((r) => compareVersions(r.tag_name, mainQtum) > 0 && compareVersions(r.tag_name, target) <= 0);
  const skipped = covered.filter((r) => r.tag_name !== target).map((r) => r.tag_name).reverse();
  const forks = forksAll.filter((f) => compareVersions(f.tag, mainQtum) > 0 && compareVersions(f.tag, target) <= 0);
  const major = isMajorBump(mainQtum, target);

  // --- the commit -----------------------------------------------------------------------
  const edit = () => {
    const composePath = join(root, COMPOSE);
    const manifestPath = join(root, MANIFEST);
    const cur = JSON.parse(readFileSync(manifestPath, 'utf8')).version;
    if (compareVersions(cur, row.to) >= 0) row.to = cur; // an owner commit on the branch already set a higher version
    let compose = readFileSync(composePath, 'utf8');
    compose = setImageVersion(setQtumSha256(setQtumVersion(compose, target), sha), row.name, row.to);
    writeFileSync(composePath, compose);
    writeFileSync(manifestPath, setManifestField(setManifestField(readFileSync(manifestPath, 'utf8'), 'version', row.to), 'upstream', target));
  };
  const author = ['-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`];
  const message = [
    `Bump Qtum to ${target}`,
    '',
    `${row.name} ${row.from} -> ${row.to}`,
    `${assetName(target)} sha256 ${sha}`,
    ...(pretend ? ['', 'TEST ONLY: pretend version (bump.yml input), not a real Qtum release.'] : []),
  ].join('\n');

  // What the branch looks like on GitHub now: the push only overwrites exactly that.
  const lease = remoteSha(root, token, BOT_BRANCH);
  if (!pr || humanCommits.length === 0) {
    git(root, ['checkout', '-q', '-B', BOT_BRANCH, `origin/${base}`]);
    edit();
  } else {
    git(root, ['checkout', '-q', '-B', BOT_BRANCH, `origin/${BOT_BRANCH}`]);
    if (!upToDate) {
      try {
        git(root, [...author, 'merge', '--no-edit', '-m', `Merge ${base} into ${BOT_BRANCH}`, `origin/${base}`]);
      } catch (err) {
        git(root, ['merge', '--abort']);
        throw new Error(`PR #${pr.number} has commits by people and conflicts with ${base}; resolve the conflict on ${BOT_BRANCH} by hand (${err.message.split('\n')[0]})`);
      }
    }
    edit();
  }
  git(root, ['add', COMPOSE, MANIFEST]);
  const staged = git(root, ['diff', '--cached', '--name-only']);
  if (staged) git(root, [...author, 'commit', '-q', '-m', message]);
  say(`Branch ${BOT_BRANCH}: ${git(root, ['log', '--oneline', '-1'])}${!pr || humanCommits.length === 0 ? ` (recreated on the current ${base})` : ''}`);
  say(`- ${row.name} ${row.from} -> ${row.to}${row.prodVersion ? ` (production ${row.prodVersion})` : ''}`);
  say(`- ${assetName(target)} sha256 ${sha}${shaSources ? ` (${shaSources.join(', ')})` : ''}`);
  if (major) say(`- NEW MAJOR Qtum version (${mainQtum} -> ${target}): the gate never merges it; the owner reviews it`);
  for (const f of forks) say(`- hard fork ${f.tag}: ${f.block ? `block ${f.block}, ` : ''}${forkWhen(f)}`);

  const title = `Qtum Core ${target} (package ${row.to})${major ? ' (MAJOR, owner review)' : ''}${forks.length ? ' (HARD FORK)' : ''}${pretend ? ' [TEST]' : ''}`;
  const body = () => renderBody({
    target,
    from: mainQtum,
    release,
    row,
    skipped,
    forks,
    major,
    sha,
    marker: bumpMarker(pretend ? null : target),
    pretendNote: pretend ? `\n> **TEST ONLY.** Qtum ${target} was given by hand (bump.yml input "version")${release ? '' : '; it is not a real release'}. Close this PR when the test is done.\n` : '',
    checksNote: patOk ? '' : ' (Started by the bump bot through workflow_dispatch, because PAT_TOKEN is not set or was rejected.)',
  });

  if (dryRun) {
    say(`DRY RUN: would push ${BOT_BRANCH} and ${pr ? `update PR #${pr.number}` : 'open a PR'}: ${title}`);
    return;
  }

  // The gate may have merged or closed the PR while this run worked: start over next time.
  if (pr) {
    const now = await gh.get(`repos/${repo}/pulls/${pr.number}`);
    if (now.state !== 'open') {
      say(`PR #${pr.number} was ${now.merged_at ? 'merged' : 'closed'} while this run worked; nothing pushed. The next run starts over.`);
      return;
    }
  }

  // GitHub lets a token bring a change of .github/workflows/ into an existing
  // branch only with the "Workflows" permission (GITHUB_TOKEN never has it). So
  // when the default branch changed a workflow file since the bot's branch was
  // made, refreshing that branch can be refused. A PR with only bot commits is
  // then replaced by a new PR on a fresh branch (a new branch made from the
  // default branch is accepted); a PR with people's commits is left to them.
  const refused = (err) => isWorkflowPushRefusal(err.gitOutput || err.message);
  const push = async (opts) => {
    try {
      pushHead(root, writeToken(), BOT_BRANCH, opts);
      return;
    } catch (err) {
      if (refused(err) || !patOk) throw err;
      warning(`push with PAT_TOKEN failed (${String(err.message).split('\n')[0]}); trying the built-in token`);
      patOk = false;
      await reportPat(gh, false);
    }
    pushHead(root, token, BOT_BRANCH, opts);
  };
  try {
    await push({ lease });
  } catch (err) {
    if (!refused(err)) throw new Error(`could not push ${BOT_BRANCH} (${String(err.message).split('\n')[0]}); if the branch changed during this run, the next run tries again`);
    if (pr && humanCommits.length) {
      throw new Error(`could not bring ${base} into PR #${pr.number}: ${base} changed a file in .github/workflows/ since ${BOT_BRANCH} was made, and GitHub lets only a token with the "Workflows" permission bring such a change into a branch. The PR has commits by people, so the bot does not replace it. To fix it: merge ${base} into ${BOT_BRANCH} yourself (gh pr checkout ${pr.number} -R ${repo}; git merge origin/${base}; git push), or give PAT_TOKEN the permission "Workflows: Read and write" (README, "Secrets").`);
    }
    const ghw0 = makeClient({ token: writeToken() });
    if (pr) {
      // The marker loses its target, so closing this PR does not skip the release.
      const note = `**Replaced by a new pull request:** \`${base}\` changed a workflow file, which the bump bot's token may not bring into an existing branch, so it made \`${BOT_BRANCH}\` again from \`${base}\`. Closing this PR does not skip Qtum ${target}.`;
      await ghw0.patch(`repos/${repo}/pulls/${pr.number}`, { body: `${bumpMarker(null)}\n${note}\n\n${String(pr.body || '').replace(/<!-- avado-bot:bump[^>]*-->\n?/g, '')}`, state: 'closed' });
      say(`Closed PR #${pr.number}: ${base} changed a workflow file, so ${BOT_BRANCH} is made again from ${base} under a new PR.`);
    }
    try { await ghw0.del(`repos/${repo}/git/refs/heads/${BOT_BRANCH}`); } catch (e) { if (e.status !== 404 && e.status !== 422) throw e; }
    try {
      await push({ lease: '' });
    } catch (e) {
      if (!refused(e)) throw e;
      throw new Error(`GitHub refused even a new ${BOT_BRANCH} made from ${base} (${String(e.message).split('\n')[0]}). Give PAT_TOKEN the permission "Workflows: Read and write" (README, "Secrets"); the next run then opens the PR.`);
    }
    pr = null;
  }

  const ghw = makeClient({ token: writeToken() });
  let number;
  if (pr) {
    await ghw.patch(`repos/${repo}/pulls/${pr.number}`, { title, body: body() });
    number = pr.number;
    say(`Updated PR #${number}.`);
  } else {
    const created = await ghw.post(`repos/${repo}/pulls`, { title, head: BOT_BRANCH, base, body: body(), maintainer_can_modify: true });
    number = created.number;
    pr = created;
    say(`Opened PR #${number}: ${created.html_url}`);
  }
  try { await ghw.post(`repos/${repo}/issues/${number}/labels`, { labels: ['avado-bot', ...(major ? ['major'] : []), ...(forks.length ? ['hard-fork'] : [])] }); } catch { /* labels are optional */ }

  if (!patOk) {
    // GITHUB_TOKEN pushes do not start workflows, but a workflow_dispatch does.
    await gh.post(`repos/${repo}/actions/workflows/pr-checks.yml/dispatches`, { ref: base, inputs: { pr: String(number) } });
    say(`Started the PR checks for #${number} through workflow_dispatch (PAT_TOKEN ${pat ? 'was rejected' : 'is not set'}).`);
  }
  // The gate looks at the new PR now: a major version or a hard fork is
  // reported to the owner at once, not only after the checks.
  try {
    await gh.post(`repos/${repo}/actions/workflows/gate.yml/dispatches`, { ref: base });
    say('Started the gate.');
  } catch (err) {
    warning(`could not start the gate (${err.message}); it runs within 4 hours anyway`);
  }
}

main()
  .catch((err) => {
    console.log(`::error::${err.message}`);
    summary.push(`**Bump failed:** ${err.message}`);
    recordFailure(err.message);
    process.exitCode = 1;
  })
  .finally(writeSummary);
