#!/usr/bin/env node
// Gate (gate.yml, every 4 hours, whenever the PR checks finish, and after the
// bump bot pushed): decides whether the bump bot's PR may be merged, and merges
// it; keeps the owner's hard-fork issues up to date; and makes sure every
// version on the default branch gets its release run.
//
// Merge (a merge commit, never squash) only when our checks ("avado/checks",
// set by this repo's PR-checks workflow) are green on the PR head, the branch
// contains the current default branch, no person changed the checks or the
// pipeline on the branch, the new Qtum is NOT a new major version, and
//   - 72 hours have passed since the Qtum release (DAppNode has no Qtum
//     package, so the wait with our checks green is the second opinion), or
//   - the release is a hard fork: its notes say "Mandatory update before
//     Mainnet block N" (or its title says "Hard Fork"), or the release watcher
//     marks it URGENT. Then it merges at once.
// A new MAJOR Qtum version (v30 -> v31) is never merged by the gate: the owner
// gets an issue with a review prompt and merges it himself.
// Never merge when our checks failed or anything is unclear: then an issue
// assigned to the owner explains it and carries a ready-to-paste Claude Code
// prompt. A check that failed only on something outside our package (the
// AVADOSDK build, the mainnet boot test, the production image download, a
// runner step) is run once more first (GitHub "re-run failed jobs"), without
// an email.
//
// Environment:
//   GITHUB_REPOSITORY, GITHUB_TOKEN   this repo (contents, pull requests, issues,
//                                      statuses write; actions write to re-run the
//                                      checks and start release.yml)
//   WATCHER_READ_TOKEN                 optional: reads the release watcher's URGENT
//                                      issues (AvadoDServer/avado-release-control)
//   PIPELINE_MODE                      shadow (default, also when not set: decide
//                                      and comment, never merge) | on (merge) | off
//   PIPELINE_OWNER                     who gets the issues (default flisko)
//   GATE_WAIT_HOURS                    default 72
//   GITHUB_SERVER_URL, GITHUB_RUN_ID   for links to this run
// Run in a checkout of the default branch with full history (fetch-depth: 0).

import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeClient } from './lib/gh.js';
import { upsertIssue, closeIssue, findIssue, listOpenIssues } from './lib/issue.js';
import { forkInfo, syncForkIssues, readQtumHeight, forkWhen } from './lib/qtum.js';
import {
  BOT_EMAIL, BOT_BRANCH, UPSTREAM_REPO, PR_CHECKS_PATH, MANIFEST, COMPOSE, RELEASES, compareVersions, stableReleases, isMajorBump,
  readQtumVersion, readPackage, holdReason, releasedVersions, readProductionVersions, git, fetchBranch, retry, isTransient, env,
  hoursBetween, fmtUtc, recordFailure,
} from './lib/common.js';

export const CHECKS_CONTEXT = 'avado/checks';
export const GATE_CONTEXT = 'avado/gate';
const GATE_COMMENT = '<!-- avado-bot:gate -->';
const ALLOWED_BOT_FILES = new Set([COMPOSE, MANIFEST]);
// Files a person may change on the bot branch and still let the gate merge:
// the build (build/), the compose file and the manifest. Anything else (the
// checks and their test scripts, the pipeline, the hold and the release
// record) is merged only by the owner, after reading it.
export const OWNER_MERGE_FILES = /^(\.github\/|scripts\/|test\/|hold$|releases\.json$)/;
// Steps whose failure is usually outside our package (public network, IPFS
// node, production store, GitHub downloads, the runner): they are re-run once.
export const RETRYABLE_STEPS = /^(AVADOSDK build|Boots on Qtum mainnet|Production image|Old Qtum builds|Throwaway IPFS node|Qtum release tarball|Free disk space|Set up job|Run actions\/|Post Run actions\/|Complete job)/;

// The rules, as a pure function (tested in test/pipeline.test.mjs).
//   checks: 'success' | 'failure' | 'error' | 'pending' | 'missing'
//   mandatory: set when a release the PR covers is a hard fork (or URGENT)
//   major: the PR moves to a new major Qtum version
//   rerun: a re-run of checks that failed on an outside cause was just started
export function decide({ checks, mandatory, major = false, releasedAt, now, upToDate, conflict, errors = [], unexpectedFiles = [], ownerFiles = [], rerun = null, waitHours = 72, headAt = null, silentHours = 6 }) {
  if (errors.length) return { action: 'block', cause: 'unclear', why: `could not read everything needed: ${errors.join('; ')}` };
  if (unexpectedFiles.length) return { action: 'block', cause: 'unexpected-files', why: `bot commits change files a bump never touches: ${unexpectedFiles.join(', ')}` };
  if (ownerFiles.length) return { action: 'block', cause: 'owner-merge', why: `a person changed files the gate never merges by itself (${ownerFiles.slice(0, 5).join(', ')}${ownerFiles.length > 5 ? ', ...' : ''}); the owner reviews and merges this PR` };
  if (conflict) return { action: 'block', cause: 'conflict', why: 'the PR conflicts with the default branch' };
  if (major) {
    const state = checks === 'success' ? 'our checks are green' : checks === 'failure' || checks === 'error' ? 'our checks failed' : 'our checks are not finished';
    return { action: 'block', cause: 'major', why: `this is a new major Qtum version, which the gate never merges by itself (${state}); the owner reviews and merges it` };
  }
  if (rerun) return { action: 'wait', cause: 'rerun', why: `our checks failed on something outside our package (${rerun}); they are being run once more` };
  if (checks === 'failure' || checks === 'error') return { action: 'block', cause: 'checks-failed', why: 'our checks failed' };
  if (!releasedAt) return { action: 'block', cause: 'unclear', why: 'there is no published Qtum release for this version' };
  if (checks !== 'success') {
    // Checks that never report must not make the gate wait silently forever.
    const waited = headAt ? hoursBetween(headAt, now) : 0;
    if (waited >= silentHours) return { action: 'block', cause: 'unclear', why: `our checks have not reported a result ${Math.floor(waited)} h after the last push (status: ${checks})` };
    return { action: 'wait', cause: 'checks', why: checks === 'missing' ? 'our checks have not started yet' : 'our checks are running' };
  }
  if (!upToDate) return { action: 'wait', cause: 'behind', why: 'the branch is behind the default branch; the bump bot refreshes it' };
  if (mandatory) return { action: 'merge', cause: 'hard-fork', why: `our checks are green and ${mandatory.source} (no 72-hour wait)` };
  const age = hoursBetween(releasedAt, now);
  if (age >= waitHours) return { action: 'merge', cause: 'waited', why: `our checks are green and ${Math.floor(age)} h passed since the Qtum release (wait: ${waitHours} h)` };
  const at = new Date(new Date(releasedAt).getTime() + waitHours * 3600000);
  return { action: 'wait', cause: 'soak', why: `our checks are green; waiting ${waitHours} h after the Qtum release, until ${fmtUtc(at)}`, mergeAt: at.toISOString() };
}

// Which files make the PR the owner's to merge (people's commits only).
export function ownerMergeFiles(files, botOnly) {
  return botOnly ? [] : files.filter((f) => OWNER_MERGE_FILES.test(f));
}

// Did every failed job of a checks run fail only on outside steps? (A job lost
// without a failed step, for example a runner that went away, counts as outside.)
export function retryable(jobs) {
  return jobs.length > 0 && jobs.every((j) => {
    const steps = j.steps || (j.step ? [j.step] : []);
    return steps.every((s) => RETRYABLE_STEPS.test(s));
  });
}

// --- reading --------------------------------------------------------------------

// The "avado/checks" status on the PR head, accepted only from this repo's
// PR-checks workflow (a run in this repo, not a fork, for this commit).
async function checksState(gh, repo, sha) {
  const statuses = await gh.paginate(`repos/${repo}/commits/${sha}/statuses`, { maxPages: 3 });
  const mine = statuses.filter((s) => s.context === CHECKS_CONTEXT && s.creator?.login === 'github-actions[bot]');
  const latest = mine.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
  if (!latest) return { state: 'missing' };
  const runId = /\/actions\/runs\/(\d+)/.exec(latest.target_url || '')?.[1];
  if (!runId) return { state: 'missing', note: 'the status does not link a PR-checks run' };
  let run;
  try {
    run = await gh.get(`repos/${repo}/actions/runs/${runId}`);
  } catch (err) {
    return { state: 'missing', note: `the linked run ${runId} could not be read (${err.message.slice(0, 80)})` };
  }
  if (run.path !== PR_CHECKS_PATH || !run.head_repository || run.head_repository.id !== run.repository?.id) {
    return { state: 'missing', note: `the status comes from ${run.path || 'an unknown workflow'}${run.head_repository?.id !== run.repository?.id ? ' in a fork' : ''}, not from this repo's PR checks` };
  }
  if (run.event === 'pull_request' && run.head_sha !== sha) return { state: 'missing', note: `the linked run checked ${run.head_sha.slice(0, 7)}` };
  let state = latest.state;
  // A run that is running again (a re-run) counts as running, whatever it said before.
  if (run.status !== 'completed') state = 'pending';
  return { state, url: latest.target_url, description: latest.description, runId, run };
}

// The useful part of a failed job's log: the lines that say what failed, and
// the last lines before the first error (setup and cleanup noise dropped).
export function logExcerpt(log) {
  const lines = String(log || '')
    .split('\n')
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\r$/, ''));
  // Only the step that failed: from the last "##[group]Run ..." before the first error.
  const errorAt = lines.findIndex((l) => l.startsWith('##[error]'));
  const stepAt = errorAt === -1 ? 0 : lines.slice(0, errorAt).map((l) => l.startsWith('##[group]Run ')).lastIndexOf(true);
  // GitHub echoes each step's script between "##[group]Run ..." and "##[endgroup]": not output.
  let inRun = false;
  const output = lines.slice(Math.max(stepAt, 0)).filter((l) => {
    if (l.startsWith('##[group]Run ')) { inRun = true; return false; }
    if (inRun && l.startsWith('##[endgroup]')) { inRun = false; return false; }
    return !inRun;
  });
  const firstError = output.findIndex((l) => l.startsWith('##[error]'));
  const upto = firstError === -1 ? output : output.slice(0, firstError + 1);
  const noise = /^(##\[(group|endgroup)\]|shell: |env:$|\s+[A-Z_]+: |\[command\]|Post job cleanup|Cleaning up orphan)/;
  const useful = upto.filter((l) => l.trim() && !noise.test(l));
  const key = useful.filter((l) => /(^|\s)FAIL\b|FAIL:|MISSING|MISMATCH|^##\[error\]|^-{5} |^ {4}[-+]|\bError: |rc=[1-9]/.test(l)).slice(0, 30);
  const tail = useful.slice(-25).filter((l) => !key.includes(l));
  return [...key, ...(tail.length ? ['...', ...tail] : [])].join('\n').slice(0, 6000);
}

async function failedJobs(gh, repo, runId, { logs = true } = {}) {
  if (!runId) return { runId: null, jobs: [] };
  const data = await gh.get(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`);
  const jobs = [];
  // "avado/checks" only sums up the others.
  for (const j of (data?.jobs || []).filter((x) => x.conclusion === 'failure' && x.name !== CHECKS_CONTEXT)) {
    const steps = (j.steps || []).filter((s) => s.conclusion === 'failure').map((s) => s.name);
    const step = steps.join('", "') || null;
    let excerpt = '';
    if (logs) {
      try {
        excerpt = logExcerpt(await gh.redirectedText(`repos/${repo}/actions/jobs/${j.id}/logs`));
      } catch (err) {
        excerpt = `(log not readable: ${err.message})`;
      }
    }
    jobs.push({ name: j.name, url: j.html_url, step, steps, excerpt });
  }
  return { runId, jobs };
}

// The watcher's URGENT issues for this package ("<name>@<qtum tag>"). Returns
// { hit, read }: read says whether the watcher could be read, so a broken read is shown.
async function watcherMandatory(name, from, to) {
  const tok = env('WATCHER_READ_TOKEN');
  const watcher = env('WATCHER_REPO', 'AvadoDServer/avado-release-control');
  if (!tok) return { hit: null, read: 'not read (no WATCHER_READ_TOKEN)' };
  try {
    const gh = makeClient({ token: tok });
    const issues = await gh.get(`repos/${watcher}/issues?state=open&labels=urgent&per_page=100`);
    for (const i of issues || []) {
      const key = /<!-- avado-watch:urgent key=(\S+) -->/.exec(i.body || '')?.[1] || '';
      const at = key.lastIndexOf('@');
      if (at < 0 || key.slice(0, at) !== name) continue;
      const tag = key.slice(at + 1);
      if (/^v\d+\.\d+(\.\d+)?$/.test(tag) && compareVersions(tag, from) > 0 && compareVersions(tag, to) <= 0) {
        return { hit: { tag, source: `the release watcher marks Qtum ${tag} as required (${i.html_url})` }, read: 'read' };
      }
    }
    return { hit: null, read: 'read' };
  } catch (err) {
    console.log(`::warning::could not read the watcher's URGENT issues (${err.message}); using the release notes only`);
    return { hit: null, read: `unreadable (${err.status ? `HTTP ${err.status}` : err.message.slice(0, 60)})` };
  }
}

// Every version on the default branch gets a release run: if the package is
// not held and its version has no "Release ..." commit and no release run ran
// on the current head, start one (a gate merge made with GITHUB_TOKEN starts no
// push workflow, and the dispatch after it may have failed).
async function reconcileReleases(gh, repo, base, root, say) {
  const ref = `origin/${base}`;
  if (holdReason(root, ref)) return;
  const head = git(root, ['rev-parse', ref]);
  const m = JSON.parse(git(root, ['show', `${ref}:${MANIFEST}`]));
  let record = {};
  try { record = JSON.parse(git(root, ['show', `${ref}:${RELEASES}`])); } catch { /* none yet */ }
  if (record[m.version]?.hash || releasedVersions(root, m.name, ref).includes(m.version)) return;
  const missing = `${m.name} ${m.version}`;
  const runs = await gh.get(`repos/${repo}/actions/workflows/release.yml/runs?per_page=30`);
  const onHead = (runs?.workflow_runs || []).find((r) => r.head_sha === head);
  if (onHead) {
    say(`- not released yet on ${base}: ${missing}; release run ${onHead.html_url} (${onHead.status}${onHead.conclusion ? `, ${onHead.conclusion}` : ''}) covers it${onHead.conclusion === 'failure' ? ' (its failure issue says what to do)' : ''}`);
    return;
  }
  await retry('starting release.yml', () => gh.post(`repos/${repo}/actions/workflows/release.yml/dispatches`, { ref: base }));
  say(`- not released yet on ${base}: ${missing}, and no release run ran on ${head.slice(0, 7)}: started release.yml`);
}

// --- the issue text ------------------------------------------------------------------

function issueText({ repo, pr, target, mainQtum, decision, checks, failed, runUrl, mandatory, release }) {
  const server = env('GITHUB_SERVER_URL', 'https://github.com');
  const prUrl = `${server}/${repo}/pull/${pr.number}`;
  const notes = `https://github.com/${UPSTREAM_REPO}/releases/tag/${target}`;
  const headline = {
    'checks-failed': `our checks failed for Qtum ${target}`,
    major: `new MAJOR version ${mainQtum} → ${target}: please review and merge`,
    'owner-merge': `a person changed the checks or the pipeline on the Qtum ${target} PR: please review and merge`,
    conflict: `the Qtum ${target} PR conflicts with the default branch`,
    'unexpected-files': 'the bump PR changes unexpected files',
    unclear: `the gate could not decide on Qtum ${target}`,
  }[decision.cause] || decision.why;
  const title = `[needs ${decision.cause === 'major' || decision.cause === 'owner-merge' ? 'review' : 'fix'}] Qtum ${target}: ${headline}`;

  const facts = [
    `- Pull request: ${prUrl} (branch \`${BOT_BRANCH}\`, Qtum ${mainQtum} → ${target})`,
    `- Our checks: **${checks.state}**${checks.url ? ` ([run](${checks.url}))` : ''}${checks.note ? ` (${checks.note})` : ''}`,
    `- Qtum ${target}: ${release ? `released ${fmtUtc(release.published_at)}, [release notes](${release.html_url})` : 'no such release'}`,
    `- Gate run: ${runUrl}`,
  ];
  if (mandatory) facts.push(`- **Hard fork:** ${mandatory.source}`);

  const rules = `Rules:
- Never change the package name, the volume (data:/package/data), the ports (3888, 3889) or the environment variable EXTRA_OPTS in dappnode_package.json, and keep the version the bot set there.
- Keep qtumd's command line (build/files/supervisord.conf) and qtum.conf (build/files/qtum.conf) the same except for what Qtum ${target} requires (compare with \`docker run --rm --entrypoint qtumd <image> -help -help-debug\`).
- Never weaken the wallet safety in build/monitor: a wallet is never deleted or replaced by an empty one, every private key must stay exportable.
- Do not edit .github/**, scripts/**, test/** (the checks), hold or releases.json. If the fix really needs that, make the change in a separate commit, say so clearly, and tell me that I must review and merge the PR myself: the gate never merges such a PR by itself.
- Before pushing, run the checks that failed locally (README.md, section "Checks"): build the image, then for example scripts/ci/check-flags.sh, test/smoke-test.sh and scripts/ci/legacy-wallet-test.sh.
- Commit with a clear message and push to ${BOT_BRANCH}. Do not merge the PR yourself: ${decision.cause === 'major' ? 'the checks run again, and I merge a new major version myself after reading your summary.' : 'the checks run again and the gate merges when they are green.'}`;

  let what = '';
  let prompt = '';
  if (decision.cause === 'checks-failed') {
    const jobs = failed.jobs.length
      ? failed.jobs.map((j) => `### ${j.name}${j.step ? ` (step "${j.step}")` : ''}\n${j.url}\n\n\`\`\`text\n${j.excerpt}\n\`\`\``).join('\n\n')
      : '(the failed jobs could not be listed; open the run link)';
    const forkTip = mandatory ? `\n\n**This release is a hard fork** (${mandatory.source}): the fix is urgent. The hard-fork issue has the date.` : '';
    what = `The automatic update to Qtum ${target} stopped because our checks failed. The gate already ran the failed checks once more if they looked like an outside problem. Nothing was merged or released; boxes are not affected.${forkTip}\n\n${jobs}`;
    prompt = `In the AVADO-DNP-Qtum repository (${repo}), pull request #${pr.number} on branch ${BOT_BRANCH} moves the package from Qtum Core ${mainQtum} to ${target}. Its checks failed:
${failed.jobs.map((j) => `- ${j.name}${j.step ? `, step "${j.step}"` : ''}: ${j.url}`).join('\n') || `- see ${checks.url}`}
Download the logs with: gh run download ${failed.runId || '<run id>'} -R ${repo}
First decide whether the cause is outside our package: too few peers or no header progress on Qtum mainnet from a GitHub runner, AVADO's IPFS node or the production store (bo.ava.do), GitHub's release downloads, or the runner itself. If so, do not change any files: run \`gh run rerun ${failed.runId || '<run id>'} -R ${repo} --failed\` and tell me.
Otherwise find why the check fails with Qtum ${target} (read the release notes: ${notes}, and the Bitcoin Core release notes they link). Typical causes: a removed or renamed RPC the wizard or the monitor calls (test/smoke-test.sh), a qtumd option or qtum.conf key that no longer exists (scripts/ci/check-flags.sh), a wallet change that breaks the legacy-wallet upgrade or the key export (scripts/ci/legacy-wallet-test.sh). Fix it on this branch.
${rules}`;
  } else if (decision.cause === 'major') {
    what = `Qtum ${target} is a new **major** version (from ${mainQtum}). Qtum majors follow Bitcoin Core majors, which remove or change RPCs and wallet features: Qtum v30 removed legacy wallets and the \`dumpprivkey\` and \`importprivkey\` RPCs, which broke the wizard's "Show private key" and "Import private key" until the monitor was changed. So the gate never merges a major version by itself. Nothing was merged or released; boxes are not affected.

Our checks still run on the PR (${checks.state}${checks.url ? `, [run](${checks.url})` : ''}): the regtest smoke test calls every RPC the wizard uses, and the legacy-wallet test upgrades old wallets and compares every private key. They are a good start for the review, not a replacement for it.${mandatory ? `\n\n**This release is also a hard fork** (${mandatory.source}). Do the review now: the fork date does not wait. The hard-fork issue has the date.` : ''}

**When you are happy:** merge ${prUrl} yourself with **"Create a merge commit"** (the branch must contain the default branch and the checks must be green): the release then publishes exactly the tested build to staging. To skip this version, close the PR.`;
    prompt = `In the AVADO-DNP-Qtum repository (${repo}), pull request #${pr.number} on branch ${BOT_BRANCH} moves the package from Qtum Core ${mainQtum} to ${target}, a new MAJOR version. The pipeline never merges a major version by itself: Qtum v30 (Bitcoin Core 30) removed legacy wallets and the RPCs dumpprivkey and importprivkey, which broke the wizard until the monitor was changed.
1. Read the release notes (${notes}) and the Bitcoin Core release notes they link. List every removed, renamed or changed RPC, RPC result field, command-line option, qtum.conf option and wallet feature.
2. Check each one against what the package uses: the wizard (build/wizard/src; it calls qtumd through /rpc), the monitor (build/monitor/index.js, qtumkeys.js, walletfiles.js), build/files/qtum.conf, build/files/supervisord.conf and build/Dockerfile. Build the image (README.md, section "Checks") and compare with \`qtumd -help -help-debug\` and \`qtum-cli help\` inside it.
3. Read this PR's check results (${checks.url || 'the avado/checks status on the PR'}): the smoke test, the legacy-wallet test (every private key must export identically), the flags check and the mainnet boot.
4. Fix what is needed on this branch and push; wait for the checks.
5. Tell me in plain words what changes for owners of an AVADO box (wallet, staking, the wizard) and whether I can merge. Do not merge the PR yourself.
${rules}`;
  } else if (decision.cause === 'owner-merge') {
    what = `Someone pushed commits to the bot's PR that change files the gate never merges by itself: the checks or their test scripts, the pipeline, the hold or the release record. Such a change can weaken the checks for every later release, so a person must read it. Nothing was merged or released; boxes are not affected.

**What to do:** open ${prUrl}, read the changes to those files, and if they are right, merge it yourself with **"Create a merge commit"** (the release then publishes it to staging as usual). If not, remove those commits from the branch.`;
    prompt = `In ${repo}, pull request #${pr.number} (branch ${BOT_BRANCH}, Qtum ${mainQtum} → ${target}) has commits by people that change: ${decision.why}.
Show me those changes (gh pr diff ${pr.number} -R ${repo}) and explain in plain words what each one does and whether it weakens a check or changes what boxes run. Do not change any files and do not merge.`;
  } else if (decision.cause === 'conflict') {
    what = 'The PR cannot be merged because it conflicts with the default branch, and it has commits by people, so the bot does not rebuild it.';
    prompt = `In ${repo}, pull request #${pr.number} (branch ${BOT_BRANCH}) conflicts with the default branch. Check it out (gh pr checkout ${pr.number} -R ${repo}), merge the default branch into it, resolve the conflicts keeping VERSION=${target}, its QTUM_SHA256 and the bot's package version, and push.
${rules}`;
  } else {
    what = `The gate stopped: ${decision.why}. Nothing was merged or released; boxes are not affected.`;
    prompt = `In ${repo}, the release gate stopped on pull request #${pr.number} (Qtum ${mainQtum} → ${target}) with: "${decision.why}". Gate run: ${runUrl}. Find out why and tell me what to do; change files only on branch ${BOT_BRANCH}.
${rules}`;
  }

  const body = `**What happened:** ${decision.why}.

${what}

**How to ${decision.cause === 'major' ? 'review' : 'fix'} it with Claude Code** (on your Mac):
\`\`\`bash
gh pr checkout ${pr.number} -R ${repo}
claude    # then paste the prompt below
\`\`\`

<details open><summary>Prompt for Claude Code</summary>

\`\`\`text
${prompt}
\`\`\`
</details>

**Facts**
${facts.join('\n')}

This issue updates itself on every gate run (every 4 hours and after each check run) and closes by itself when the cause is gone (for a major version: when the PR is merged or closed).`;
  return { title, body };
}

// --- main --------------------------------------------------------------------------------

async function main() {
  const repo = env('GITHUB_REPOSITORY');
  const token = env('GITHUB_TOKEN');
  const mode = env('PIPELINE_MODE', 'shadow');
  const owner = env('PIPELINE_OWNER', 'flisko');
  const waitHours = Number(env('GATE_WAIT_HOURS', '72'));
  const runUrl = `${env('GITHUB_SERVER_URL', 'https://github.com')}/${repo}/actions/runs/${env('GITHUB_RUN_ID', '0')}`;
  const now = new Date(env('GATE_NOW', new Date().toISOString()));
  const root = process.cwd();
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  if (mode === 'off') return console.log('PIPELINE_MODE is off: nothing to do.');
  const merging = mode === 'on';
  const gh = makeClient({ token });
  const out = [];
  const say = (s) => { console.log(s); out.push(s); };
  if (!merging) say(`PIPELINE_MODE is ${env('PIPELINE_MODE') ? `"${mode}"` : 'not set'}: shadow mode, the gate decides and comments but never merges (set it to "on" to merge).`);

  const meta = await gh.get(`repos/${repo}`);
  const base = meta.default_branch;
  fetchBranch(root, token, base);
  await reconcileReleases(gh, repo, base, root, say);
  const onBase = readPackage(root, `origin/${base}`);

  const prs = await gh.get(`repos/${repo}/pulls?state=open&head=${repo.split('/')[0]}:${encodeURIComponent(BOT_BRANCH)}`);
  const pr = (prs || [])[0];

  // Hard forks: the owner's issues, kept up to date on every run.
  const errors = [];
  const safe = async (what, fn) => { try { return await fn(); } catch (err) { errors.push(`${what}: ${err.message}`); return null; } };
  const rels = await safe('Qtum releases', () => gh.get(`repos/${UPSTREAM_REPO}/releases?per_page=40`));
  const stable = stableReleases(rels || []);
  let prodQtum = null;
  try {
    prodQtum = (await readProductionVersions({ http: gh.http })).manifests.get(onBase.name)?.upstream || null;
  } catch (err) {
    console.log(`::warning::production store unreadable (${err.message})`);
  }
  const qtum = await readQtumHeight(gh.http);
  if (rels) await syncForkIssues({ gh, repo, owner, releases: stable, prodQtum, mainQtum: onBase.qtum, qtum, pr, mode, say });

  // Issues of PRs that are gone close themselves.
  for (const i of await listOpenIssues(gh, repo)) {
    const n = /^pr-(\d+)$/.exec(i.key || '')?.[1];
    if (n && (!pr || Number(n) !== pr.number)) {
      const old = await gh.get(`repos/${repo}/pulls/${n}`);
      if (old.state !== 'open') await closeIssue(gh, repo, i, `Closed: PR #${n} is ${old.merged_at ? 'merged' : 'closed'}.`);
    }
  }
  if (!pr) {
    say('No open bump PR: nothing to gate.');
    return finish(out);
  }

  const full = await gh.get(`repos/${repo}/pulls/${pr.number}`);
  const sha = full.head.sha;

  const target = readQtumVersion(await gh.file(repo, COMPOSE, sha));
  const mainQtum = onBase.qtum;
  const checks = await checksState(gh, repo, sha);
  const cmp = await gh.get(`repos/${repo}/compare/${encodeURIComponent(base)}...${sha}`);
  const upToDate = cmp.behind_by === 0;
  const conflict = full.mergeable === false && full.mergeable_state === 'dirty';

  // Bot-only PRs may change only the bump's files; people's commits may not
  // change the checks or the pipeline without the owner's own merge.
  const commits = await gh.get(`repos/${repo}/pulls/${pr.number}/commits?per_page=100`);
  const botOnly = (commits || []).every((c) => c.commit?.author?.email === BOT_EMAIL);
  const headAt = (commits || []).at(-1)?.commit?.committer?.date || null;
  const files = ((await gh.paginate(`repos/${repo}/pulls/${pr.number}/files`, { maxPages: 30 })) || []).map((f) => f.filename);
  const unexpectedFiles = botOnly ? files.filter((f) => !ALLOWED_BOT_FILES.has(f)) : [];
  const ownerFiles = ownerMergeFiles(files, botOnly);

  // Upstream: the release of the target, and the hard forks among everything
  // between the default branch and it.
  const release = stable.find((r) => r.tag_name === target) || null;
  const covered = stable.filter((r) => compareVersions(r.tag_name, mainQtum) > 0 && compareVersions(r.tag_name, target) <= 0);
  let mandatory = null;
  for (const r of covered) {
    const f = forkInfo(r, qtum);
    if (f && !mandatory) mandatory = { tag: r.tag_name, block: f.block, source: `Qtum ${r.tag_name} is a hard fork ("${f.quote}"; ${f.block ? `block ${f.block}, ` : ''}${forkWhen(f)})` };
  }
  const watcher = await watcherMandatory(onBase.name, mainQtum, target);
  if (!mandatory && watcher.hit) mandatory = watcher.hit;
  const major = isMajorBump(mainQtum, target);

  // Checks that failed only on outside steps run once more (first attempt only).
  let rerun = null;
  if ((checks.state === 'failure' || checks.state === 'error') && checks.run) {
    const steps = await failedJobs(gh, repo, checks.runId, { logs: false });
    if (checks.run.run_attempt === 1 && retryable(steps.jobs)) {
      try {
        await gh.post(`repos/${repo}/actions/runs/${checks.runId}/rerun-failed-jobs`, {});
        rerun = steps.jobs.map((j) => `${j.name}: ${j.steps.join(', ') || 'no step'}`).join('; ');
      } catch (err) {
        console.log(`::warning::could not re-run the failed checks (${err.message})`);
      }
    }
  }

  const decision = decide({
    checks: checks.state,
    mandatory,
    major,
    releasedAt: release?.published_at || null,
    now,
    upToDate,
    conflict,
    errors,
    unexpectedFiles,
    ownerFiles,
    rerun,
    waitHours,
    headAt,
  });

  say(`PR #${pr.number} (${sha.slice(0, 7)}): Qtum ${mainQtum} -> ${target}${major ? ' (MAJOR)' : ''}`);
  say(`- our checks: ${checks.state}${checks.url ? ` (${checks.url})` : ''}${checks.note ? ` (${checks.note})` : ''}`);
  say(`- Qtum ${target} released: ${release ? fmtUtc(release.published_at) : 'no such release'}`);
  say(`- hard fork: ${mandatory ? mandatory.source : 'no'} (release watcher: ${watcher.read})`);
  say(`- branch contains ${base}: ${upToDate ? 'yes' : 'no'}${conflict ? ' (conflict)' : ''}`);
  if (ownerFiles.length) say(`- changed by people, owner merges: ${ownerFiles.join(', ')}`);
  say(`- DECISION: ${decision.action.toUpperCase()}: ${decision.why}${!merging && decision.action === 'merge' ? ' (shadow mode: not merging)' : ''}`);

  // Status on the PR head and one comment that is edited in place (no email).
  const statusState = { merge: 'success', wait: 'pending', block: 'failure' }[decision.action];
  const statusText = !merging && decision.action === 'merge' ? `shadow mode, would merge: ${decision.why}` : decision.why;
  await gh.post(`repos/${repo}/statuses/${sha}`, { state: statusState, context: GATE_CONTEXT, description: statusText.slice(0, 139), target_url: runUrl });
  const table = `${GATE_COMMENT}
### Gate: ${decision.action === 'merge' ? (!merging ? 'would merge (shadow mode)' : 'merging') : decision.action === 'wait' ? 'waiting' : 'stopped'}
${decision.why}.

| | |
|---|---|
| Qtum | ${mainQtum} → ${target}${major ? ' (**new major version: the owner merges**)' : ''} |
| Our checks | ${checks.state}${checks.url ? ` ([run](${checks.url}))` : ''}${checks.note ? ` (${checks.note})` : ''} |
| Qtum ${target} released | ${release ? fmtUtc(release.published_at) : '—'} |
| Merges without a hard fork after | ${release ? fmtUtc(new Date(release.published_at).getTime() + waitHours * 3600000) : '—'} |
| Hard fork | ${mandatory ? mandatory.source : 'no'} |
| Release watcher | ${watcher.read} |
| Up to date with ${base} | ${upToDate ? 'yes' : 'no'} |
| Mode | ${merging ? 'on (merges)' : 'shadow (never merges; set PIPELINE_MODE=on)'} |

Checked ${fmtUtc(now)} by ${runUrl}`;
  const comments = await gh.get(`repos/${repo}/issues/${pr.number}/comments?per_page=100`);
  const mine = (comments || []).find((c) => (c.body || '').startsWith(GATE_COMMENT));
  if (mine) await gh.patch(`repos/${repo}/issues/comments/${mine.id}`, { body: table });
  else await gh.post(`repos/${repo}/issues/${pr.number}/comments`, { body: table });

  const key = `pr-${pr.number}`;
  if (decision.action === 'block') {
    const failed = decision.cause === 'checks-failed' ? await failedJobs(gh, repo, checks.runId) : { runId: null, jobs: [] };
    const { title, body } = issueText({ repo, pr, target, mainQtum, decision, checks, failed, runUrl, mandatory, release });
    // A major version is one review: new pushes and check results update the
    // text without another email; anything else emails on every new situation.
    const state = decision.cause === 'major' ? `major@${target}` : `${decision.cause}@${target}@${sha.slice(0, 7)}`;
    const issue = await upsertIssue(gh, repo, {
      key, title, body, assignee: owner, state,
      changeNote: `New situation for Qtum ${target} (head ${sha.slice(0, 7)}): ${decision.why}. The description above is up to date.`,
    });
    say(`- issue: ${issue.html_url}`);
  } else if (decision.action === 'merge' || decision.cause === 'soak') {
    // Closed only when the problem is really gone: not while a fix is still
    // being checked (that would close and reopen it: two extra emails).
    const issue = await findIssue(gh, repo, key);
    if (issue?.state === 'open') {
      await closeIssue(gh, repo, issue, `Resolved: ${decision.why}.`);
      say(`- closed issue #${issue.number}`);
    }
  }

  if (decision.action === 'merge' && merging) {
    let merged;
    try {
      merged = await gh.put(`repos/${repo}/pulls/${pr.number}/merge`, {
        merge_method: 'merge',
        sha,
        commit_title: `Merge pull request #${pr.number} from ${BOT_BRANCH}: Qtum ${target}`,
        commit_message: `${decision.why}.\nGate: ${runUrl}`,
      });
    } catch (err) {
      // 409: the branch moved during this run (the bump bot pushed); 405: GitHub
      // cannot merge it right now. The next run decides on the new state.
      if (err.status === 409 || err.status === 405) {
        say(`- not merged: GitHub answered HTTP ${err.status} (${String(err.message).slice(0, 160)}); the next gate run decides again`);
        return finish(out);
      }
      throw err;
    }
    say(`- merged: ${merged.sha}`);
    try { await gh.del(`repos/${repo}/git/refs/heads/${BOT_BRANCH}`); } catch { /* auto-deleted */ }
    // A merge made with GITHUB_TOKEN does not start push workflows; start the
    // release (retried; if it still fails, the next gate run starts it).
    try {
      await retry('starting release.yml', () => gh.post(`repos/${repo}/actions/workflows/release.yml/dispatches`, { ref: base }), { transient: isTransient });
      say('- started release.yml');
    } catch (err) {
      say(`- PR #${pr.number} MERGED, but release.yml could not be started (${err.message}); the next gate run starts it`);
      throw err;
    }
  }
  return finish(out);
}

function finish(lines) {
  const f = env('GITHUB_STEP_SUMMARY');
  if (f) appendFileSync(f, `${lines.join('\n')}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.log(`::error::${err.stack || err.message}`);
    recordFailure(err.message);
    process.exitCode = 1;
  });
}
