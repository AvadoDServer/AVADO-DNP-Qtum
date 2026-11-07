// Qtum-specific upstream helpers: hard-fork detection in the release notes, the
// chain height (for the fork's estimated date), the tarball sha256, and the
// owner's hard-fork issue.
//
// Hard forks: Qtum marks a hard-fork release in its notes with the block at
// which the new rules start, in several wordings:
//   v29.1  "### **Mandatory update before Mainnet block 5483000** (Testnet block 5442000)"
//   v27.1  "**Mandatory Update before block 4590000** (4510000 in testnet)"
//   v24.1  "**Mandatory Update before block 3385122** (3298892 in testnet)"
// and usually a "Fork ETA" with a date. The block rule is the release watcher's
// ("qtum-block", vendored in mandatory.js). A release whose TITLE says "Hard
// Fork" or "Mandatory update" but whose notes give no block still counts: the
// owner is told, without a block number.

import { createHash } from 'node:crypto';
import { checkMandatory, parseHumanDate } from './mandatory.js';
import { upsertIssue, closeIssue, listOpenIssues } from './issue.js';
import { compareVersions, isMajorBump, assetName, fmtUtc, hoursBetween, retry, BOT_BRANCH, UPSTREAM_REPO } from './common.js';

export const QTUM_API = 'https://qtum.info/api';
// Nominal Qtum block time since the v0.20.2 hard fork (32-second blocks).
const NOMINAL_BLOCK_SECONDS = 32;
// A hard-fork issue says "soon" (one more email) when the fork is closer than
// this and production does not run the release yet.
export const FORK_SOON_HOURS = 48;

// "Fork ETA" from the notes, for example
//   "Fork ETA</b><br>\nMainnet: <b>Jan 12 2026 – 01:24:40 UTC (block 5483000)</b>"
//   "Fork ETA: <b>Mainnet: Feb 15, 2025, 7:28:14 AM UTC</b> | Testnet: ..."
//   "Mainnet fork ETA: November 27, 2023 00:24 UTC"
export function forkEta(body, { defaultYear } = {}) {
  const text = String(body || '').replace(/<[^>]+>/g, ' ');
  if (!/\bETA\b/i.test(text)) return null;
  const m = /\bMainnet(?:\s+fork\s+ETA)?\s*:\s*([^|\n]+)/i.exec(text);
  return m ? parseHumanDate(m[1], { defaultYear }) : null;
}

const TITLE_FORK = /\bhard[- ]?fork\b|\bmandatory (?:update|upgrade)\b(?!\s+for\s+(?:windows|mac|macos|arm|the gui|qt))/i;

// Is this release a hard fork (a required update)? Returns null, or
// { tag, block, deadline, deadlineNote, eta, quote, rule }. `qtum` is the chain
// state { height, avgBlockSeconds, now } (readQtumHeight), or null.
export function forkInfo(release, qtum = null) {
  if (!release) return null;
  const defaultYear = release.published_at ? new Date(release.published_at).getUTCFullYear() : undefined;
  const eta = forkEta(release.body, { defaultYear });
  const hit = checkMandatory(release, ['qtum-block'], { qtum });
  if (hit?.mandatory) {
    const deadline = hit.deadline || eta;
    const deadlineNote = hit.deadline ? hit.deadlineNote : `${hit.deadlineNote}${eta ? '; date from the release notes (Fork ETA)' : ''}`;
    return { tag: release.tag_name, block: hit.block, deadline, deadlineNote, eta, quote: hit.quote, rule: 'qtum-block' };
  }
  const title = String(release.name || '');
  if (TITLE_FORK.test(title)) {
    return {
      tag: release.tag_name,
      block: null,
      deadline: eta,
      deadlineNote: eta ? 'date from the release notes (Fork ETA); no block number found' : 'no block number or date found in the release notes',
      eta,
      quote: title.slice(0, 200),
      rule: 'title',
    };
  }
  return null;
}

// Chain height and the recent average block time, read like the release
// watcher does (qtum.info). Returns { height, avgBlockSeconds, now } or null.
export async function readQtumHeight(http, { api = QTUM_API, now = new Date() } = {}) {
  try {
    const info = await http.json(`${api}/info`, { timeout: 20000 });
    if (!Number.isFinite(info?.height)) return null;
    let avg = null;
    try {
      const old = await http.json(`${api}/block/${info.height - 1000}`, { timeout: 20000 });
      if (Number.isFinite(old?.timestamp) && Number.isFinite(info.blockTime)) avg = (info.blockTime - old.timestamp) / 1000;
    } catch { /* the nominal block time below */ }
    return { height: info.height, avgBlockSeconds: avg && avg > 5 && avg < 600 ? avg : NOMINAL_BLOCK_SECONDS, now };
  } catch {
    return null;
  }
}

// --- the Linux tarball's sha256 -----------------------------------------------------

// "<sha256>  x86_64-linux-gnu/qtum-24.1-x86_64-linux-gnu.tar.gz" lines of the
// "Hash validation" block -> Map(file name -> sha256).
export function bodyHashes(body) {
  const out = new Map();
  for (const line of String(body || '').split('\n')) {
    const m = /^\s*([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line);
    if (m) out.set(m[2].split('/').pop(), m[1]);
  }
  return out;
}

// GitHub's own digest of a release asset ("sha256:<hex>"; set for releases
// uploaded since mid 2025), or null.
export const assetDigest = (asset) => /^sha256:([0-9a-f]{64})$/.exec(asset?.digest || '')?.[1] || null;

// About 100 MB from GitHub: seconds normally; three tries fit the bump's 30 minutes.
export async function sha256OfUrl(url, { timeoutMs = 6 * 60 * 1000, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { status: res.status });
  const h = createHash('sha256');
  let bytes = 0;
  for await (const chunk of res.body) { h.update(chunk); bytes += chunk.length; }
  return { sha256: h.digest('hex'), bytes };
}

// The sha256 of the release's x86_64 Linux tarball: downloaded and hashed, and
// compared with every other source Qtum and GitHub publish (the asset digest,
// the "Hash validation" list in the notes). Any disagreement throws: a tarball
// that does not match what Qtum published is never pinned.
// Returns { sha256, asset, sources } or { missing: true } when the release has
// no such asset (yet).
export async function tarballSha256(release, { hash = sha256OfUrl, retryDelayMs = 10000 } = {}) {
  const name = assetName(release.tag_name);
  const asset = (release.assets || []).find((a) => a.name === name);
  if (!asset) return { missing: true, name };
  // A download that breaks off is tried again (a 404 is not).
  const got = await retry(`downloading ${name}`, () => hash(asset.browser_download_url), { delayMs: retryDelayMs });
  if (asset.size && got.bytes && got.bytes !== asset.size) throw new Error(`${name}: downloaded ${got.bytes} bytes, GitHub lists ${asset.size}`);
  const sources = ['downloaded and hashed'];
  const digest = assetDigest(asset);
  if (digest) {
    if (digest !== got.sha256) throw new Error(`${name}: the download hashes to ${got.sha256}, GitHub's asset digest is ${digest}`);
    sources.push("GitHub's asset digest");
  }
  const listed = bodyHashes(release.body).get(name);
  if (listed) {
    if (listed !== got.sha256) throw new Error(`${name}: the download hashes to ${got.sha256}, the release notes list ${listed}`);
    sources.push('the release notes');
  }
  return { sha256: got.sha256, asset, sources };
}

// The hashes the release publishes for its Linux tarball, without downloading
// it: { name, missing, digest, listed } (digest: GitHub's, listed: the notes').
export function publishedSha256(release) {
  const name = assetName(release.tag_name);
  const asset = (release.assets || []).find((a) => a.name === name);
  return { name, missing: !asset, digest: asset ? assetDigest(asset) : null, listed: bodyHashes(release.body).get(name) || null };
}

// Qtum's tarball must never change after the bump pinned it. Throws when the
// release now publishes (or serves) another sha256 than `pinned`.
//   now: { sha256, sources } of a fresh download, or null to compare only the
//   hashes the release publishes (no download).
export function assertPinUnchanged({ release, pinned, where, now = null }) {
  const p = publishedSha256(release);
  const seen = now
    ? [[now.sha256, 'the file GitHub serves now (downloaded and hashed)']]
    : [[p.digest, "GitHub's asset digest"], [p.listed, 'the release notes']].filter(([s]) => s);
  const differ = seen.filter(([s]) => s !== pinned);
  if (!differ.length) return;
  throw new Error(`Qtum ${release.tag_name}'s Linux tarball ${p.name} CHANGED after it was pinned: ${where} pins sha256 ${pinned}, but now it is ${differ.map(([s, src]) => `${s} according to ${src}`).join(' and ')}. That only happens when someone replaced the file on GitHub after the release. The bump bot stops here and never re-pins a changed file. Find out from Qtum why the file changed (https://github.com/${UPSTREAM_REPO}/releases/tag/${release.tag_name}); if the new file is genuine, change QTUM_SHA256 on ${BOT_BRANCH} yourself and merge that PR yourself (the gate leaves a changed pin to you).`);
}

// --- the owner's hard-fork issue ------------------------------------------------------

const forkKey = (tag) => `fork-${tag}`;

// The date the owner should read: the estimate from the chain height, else
// the date in the notes.
export function forkWhen(f) {
  if (f.deadline) return `about ${fmtUtc(f.deadline)}`;
  return 'date unknown';
}

// State of one fork against production: 'announced' | 'soon' | 'passed'.
const STATE_RANK = ['announced', 'soon', 'passed'];
export function forkState(f, { qtum, now = new Date() } = {}) {
  if (f.block && Number.isFinite(qtum?.height) && qtum.height >= f.block) return 'passed';
  if (f.deadline) {
    const left = hoursBetween(now, f.deadline);
    if (left <= 0) return 'passed';
    if (left < FORK_SOON_HOURS) return 'soon';
  }
  return 'announced';
}

// What stands between the fork release and production, and what the owner does.
//   held          the hold reason on the default branch, or null
//   mainReleased  the default branch's version is published (staging)
export function forkProgress({ repo, f, mainQtum, pr, held = null, mainReleased = false }) {
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const when = forkWhen(f);
  const publish = `**Publish it to production in editstore before ${when.replace(/^about /, '')}**, with a margin: boxes need time to auto-update and to restart Qtum.`;
  const merged = Boolean(mainQtum) && compareVersions(mainQtum, f.tag) >= 0;
  if (held) {
    return {
      prText: `the package is **HELD** (${held}): ${merged ? `the default branch has Qtum ${mainQtum}, but a held package is not published to staging` : 'the robot does not bump it, so no bump PR will come'}`,
      steps: [`End the hold: remove the \`hold\` file in a pull request you merge yourself${merged ? '' : ' (or update Qtum by hand, README "Update Qtum by hand")'}. The robot never bumps or publishes a held package, not even for a hard fork.`, 'Check the new version on staging (the test box).', publish],
      pipelineText: 'nothing while the package is held: no bump, no merge, no release (this issue is still kept up to date).',
    };
  }
  if (merged) {
    return {
      prText: `merged: the default branch has Qtum ${mainQtum}${mainReleased ? ' and it is on the **staging** store' : ', but it is not on staging yet (Actions → Release; a failed release has its own issue)'}`,
      steps: [mainReleased ? 'Check the new version on staging (the test box).' : 'Make sure the release reaches staging (Actions → Release), then check it on the test box.', publish],
      pipelineText: `its part is done${mainReleased ? '' : ' once the release has published the default branch to staging'}. Production is your click in editstore.`,
    };
  }
  return {
    prText: pr ? `[PR #${pr.number}](${server}/${repo}/pull/${pr.number})` : `no bump PR open yet (the bump robot opens one within 4 hours once the Linux tarball is published; branch \`${BOT_BRANCH}\`)`,
    steps: ['Make sure the bump PR is merged (if the gate cannot merge it, its own issue says why).', 'Check the new version on staging (the test box).', publish],
  };
}

function forkIssueText({ repo, f, release, state, prodQtum, mainQtum, pr, mode, qtum, majorFrom, held, mainReleased }) {
  const when = forkWhen(f);
  const where = f.block ? `mainnet block ${f.block}` : 'the fork';
  const title = state === 'passed'
    ? `[hard fork] Qtum ${f.tag}: ${where} has PASSED and production does not run it`
    : `[hard fork] Qtum ${f.tag}: required before ${where} (${when})`;
  const heightText = Number.isFinite(qtum?.height)
    ? `chain height ${qtum.height} now, about ${Math.round(qtum.avgBlockSeconds)} s per block${f.block ? `, ${Math.max(0, f.block - qtum.height)} blocks to go` : ''}`
    : 'the current chain height could not be read (qtum.info)';
  const modeText = mode === 'on'
    ? 'The gate merges the bump PR **as soon as our checks are green** (no 72-hour wait) and the release publishes it to the **staging** store.'
    : mode === 'off'
      ? '**PIPELINE_MODE is off**: the robot does not bump or merge. Merge the bump PR yourself (or open one by hand), with "Create a merge commit".'
      : '**Shadow mode** (PIPELINE_MODE not "on"): the gate only says it would merge. Merge the bump PR yourself when its checks are green, with "Create a merge commit"; the release then publishes it to staging.';
  const majorText = majorFrom
    ? `\n> **This is also a new MAJOR Qtum version** (${majorFrom} → ${f.tag}). The gate never merges a major version by itself; the PR's own issue asks you to review it. Start that review now: the fork date does not wait.\n`
    : '';
  const { prText, steps, pipelineText } = forkProgress({ repo, f, mainQtum, pr, held, mainReleased });
  const body = `**What happened:** Qtum Core ${f.tag} is a **hard fork**: "${f.quote}". ${release?.html_url ? `([release notes](${release.html_url}), published ${fmtUtc(release.published_at)})` : ''}

**Why it matters:** boxes that still run an older Qtum when the chain reaches ${where} stop following the Qtum chain: they stop staking and their wallet shows an old chain. Customers only get the new version when it is in the **production** store.

**When:** ${f.block ? `block ${f.block}, ` : ''}**${when}** (${f.deadlineNote}; ${heightText}). Recomputed every 4 hours.${f.eta ? ` Qtum's own estimate: ${fmtUtc(f.eta)}.` : ''}
${majorText}
| | |
|---|---|
| Production store runs | Qtum ${prodQtum || '(could not be read)'} |
| Default branch has | Qtum ${mainQtum || '?'} |
| Bump PR | ${prText} |

**What the pipeline does:** ${pipelineText || modeText}

**What you do:**
${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

<details><summary>Prompt for Claude Code</summary>

\`\`\`text
Qtum Core ${f.tag} is a hard fork (${f.block ? `mainnet block ${f.block}, ` : ''}${when}). In the AVADO-DNP-Qtum repository (${repo}), find the bump pull request (branch ${BOT_BRANCH}) and tell me in plain words: whether its checks are green, what (if anything) stops the gate from merging it, and whether the release reached the staging store. Read the release notes (https://github.com/${UPSTREAM_REPO}/releases/tag/${f.tag}) for changes that affect the AVADO package: RPCs the wizard (build/wizard/src) and the monitor (build/monitor) call, the wallet format, qtum.conf options and the qtumd command line. List what I must do before the fork. Do not merge or publish anything.
\`\`\`
</details>

This issue updates itself every 4 hours and closes by itself when the production store runs Qtum ${f.tag} or newer. You get another email if the fork comes closer than ${FORK_SOON_HOURS} hours, or passes, while production does not run it.`;
  return { title, body };
}

// Opens, updates and closes the owner's hard-fork issues. Called by the bump
// bot (so the email goes out as soon as the release appears) and by the gate.
//   releases   stable Qtum releases (newest first)
//   prodQtum   the Qtum tag the production store runs (null: unreadable)
//   mainQtum   the Qtum tag on the default branch
//   held       the hold reason on the default branch (null: not held)
//   mainReleased  the default branch's version is on staging already
// A fork counts while production runs an older Qtum than the fork release.
// Returns the forks found (for the PR text and the gate).
export async function syncForkIssues({ gh, repo, owner, releases, prodQtum, mainQtum, qtum, pr = null, mode = 'shadow', held = null, mainReleased = false, dryRun = false, say = console.log }) {
  const baseline = prodQtum || mainQtum;
  const forks = [];
  for (const r of releases || []) {
    if (baseline && compareVersions(r.tag_name, baseline) <= 0) continue;
    const f = forkInfo(r, qtum);
    if (f) forks.push({ f, release: r });
  }
  const open = dryRun ? [] : await listOpenIssues(gh, repo);
  // Forks production has caught up with: their issues close.
  if (prodQtum) {
    for (const i of open) {
      const tag = /^fork-(v\d+\.\d+(?:\.\d+)?)$/.exec(i.key || '')?.[1];
      if (tag && compareVersions(prodQtum, tag) >= 0) {
        await closeIssue(gh, repo, i, `Closed: the production store runs Qtum ${prodQtum}, which includes the ${tag} hard fork.`);
        say(`- hard fork ${tag}: production runs ${prodQtum}; issue #${i.number} closed`);
      }
    }
  }
  for (const { f, release } of forks) {
    // A state only moves forward (announced -> soon -> passed), so an estimate
    // that wobbles around the 48-hour mark does not send email after email.
    const before = /<!-- avado-pipeline:state (announced|soon|passed)@/.exec(open.find((i) => i.key === forkKey(f.tag))?.body || '')?.[1];
    const now = forkState(f, { qtum, now: qtum?.now || new Date() });
    const state = STATE_RANK.indexOf(before) > STATE_RANK.indexOf(now) ? before : now;
    const majorFrom = mainQtum && isMajorBump(mainQtum, f.tag) ? mainQtum : null;
    const { title, body } = forkIssueText({ repo, f, release, state, prodQtum, mainQtum, pr, mode, qtum, majorFrom, held, mainReleased });
    say(`- HARD FORK ${f.tag}: ${f.block ? `block ${f.block}, ` : ''}${forkWhen(f)} (${state}); production runs ${prodQtum || '?'}`);
    if (dryRun) continue;
    const changeNote = {
      announced: `Qtum ${f.tag} is a hard fork (${f.block ? `block ${f.block}, ` : ''}${forkWhen(f)}). The description above says what to do.`,
      soon: `**The ${f.tag} hard fork is less than ${FORK_SOON_HOURS} hours away** (${forkWhen(f)}) and production does not run it yet. Publish it to production in editstore now.`,
      passed: `**The ${f.tag} hard fork has passed** and production still runs Qtum ${prodQtum || '(unknown)'}: boxes on the old version no longer follow the chain. Publish ${f.tag} (or newer) to production now.`,
    }[state];
    await upsertIssue(gh, repo, { key: forkKey(f.tag), title, body, assignee: owner, state: `${state}@${f.tag}`, changeNote });
  }
  return forks.map(({ f }) => f);
}
