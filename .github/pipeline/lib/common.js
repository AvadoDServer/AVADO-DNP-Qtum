// Shared helpers for the Qtum pipeline (bump, gate, release). Node 20+, no
// dependencies. Everything that reads or edits the repo layout lives here, so
// the three workflows agree on it.
//
// Layout (see README): one package, one network (Qtum mainnet). The upstream
// Qtum Core release is written in docker-compose.yml as two build args:
//   - VERSION=v30.2            the qtumproject/qtum release tag
//   - QTUM_SHA256=<64 hex>     sha256 of its qtum-<version>-x86_64-linux-gnu.tar.gz
// The Dockerfile downloads that tarball and refuses any other bytes. The
// manifest (dappnode_package.json) repeats the tag as "upstream", and the
// compose image tag is <name>:<version>. A file "hold" in the repo root means
// the owner holds the package back: no bump, no release.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const BOT_NAME = 'github-actions[bot]';
export const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
export const BOT_BRANCH = 'avado-bot/bump';
export const BUMP_MARKER = '<!-- avado-bot:bump -->';
// The bump PR's marker names the Qtum release it offers, so a PR the owner
// closed is remembered as "skip this release" (bump.mjs).
export const bumpMarker = (target) => (target ? `<!-- avado-bot:bump target=${target} -->` : BUMP_MARKER);
export const markerTarget = (body) => /<!-- avado-bot:bump target=(v\d+\.\d+(?:\.\d+)?) -->/.exec(body || '')?.[1] || null;
export const PR_CHECKS_PATH = '.github/workflows/pr-checks.yml';
export const UPSTREAM_REPO = 'qtumproject/qtum';
// Stable Qtum Core releases only: "v30.2", "v29.1", "v30.2.1" (the release
// watcher's tag_pattern). Pre-releases, drafts, rc/beta tags and the old
// "mainnet-ignition-..." / "mainnet-fastlane-..." tags never match.
export const STABLE_TAG = /^v(\d+)\.(\d+)(?:\.(\d+))?$/;
export const MANIFEST = 'dappnode_package.json';
export const COMPOSE = 'docker-compose.yml';
export const RELEASES = 'releases.json';
export const HOLD_FILE = 'hold';
// The Linux build the Dockerfile installs.
export const assetName = (tag) => `qtum-${bare(tag)}-x86_64-linux-gnu.tar.gz`;

// --- versions ----------------------------------------------------------------

// Package versions (0.0.14) and Qtum tags (v30.2, v30.2.1): [major, minor, patch].
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export const bare = (tag) => String(tag).replace(/^v/, '');
export const major = (v) => parseVersion(v)?.[0] ?? null;
// A new MAJOR Qtum Core (v30 -> v31) follows a new Bitcoin Core major, which
// removes or changes RPCs and wallet features (v30 removed legacy wallets,
// dumpprivkey and importprivkey, which broke the wizard). Never merged by itself.
export const isMajorBump = (from, to) => major(to) > major(from);

export function maxVersion(list) {
  return list.filter((v) => parseVersion(v)).reduce((a, b) => (a === null || compareVersions(b, a) > 0 ? b : a), null);
}

export function bumpPatch(v) {
  const p = parseVersion(v);
  if (!p) throw new Error(`not a version: ${v}`);
  return `${p[0]}.${p[1]}.${p[2] + 1}`;
}

// Stable upstream releases only (no draft, pre-release, rc, beta), newest version first.
export function stableReleases(releases) {
  return (releases || [])
    .filter((r) => !r.draft && !r.prerelease && STABLE_TAG.test(r.tag_name))
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
}

// --- repo files ----------------------------------------------------------------

// "      - VERSION=v30.2" (the list form of build args, as the file has it)
const argLine = (key) => new RegExp(`^(\\s*-\\s*${key}=)["']?([^\\s"'#]+)["']?(\\s*(#.*)?)$`, 'm');
function readArg(text, key) {
  const all = [...String(text).matchAll(new RegExp(argLine(key).source, 'gm'))];
  if (all.length !== 1) throw new Error(`expected exactly one "- ${key}=" build arg in ${COMPOSE}, found ${all.length}`);
  return all[0][2];
}
function setArg(text, key, value) {
  readArg(text, key);
  const out = text.replace(argLine(key), (_, pre, _old, post) => `${pre}${value}${post || ''}`);
  if (readArg(out, key) !== value) throw new Error(`could not set ${key}`);
  return out;
}

export const SHA256_RE = /^[0-9a-f]{64}$/;

export function readQtumVersion(composeText) {
  const v = readArg(composeText, 'VERSION');
  if (!STABLE_TAG.test(v)) throw new Error(`VERSION in ${COMPOSE} is not a Qtum release tag like v30.2: ${v}`);
  return v;
}
export const setQtumVersion = (composeText, tag) => {
  if (!STABLE_TAG.test(tag)) throw new Error(`not a Qtum release tag: ${tag}`);
  return setArg(composeText, 'VERSION', tag);
};

export function readQtumSha256(composeText) {
  const s = readArg(composeText, 'QTUM_SHA256');
  if (!SHA256_RE.test(s)) throw new Error(`QTUM_SHA256 in ${COMPOSE} is not a sha256: ${s}`);
  return s;
}
export const setQtumSha256 = (composeText, sha) => {
  if (!SHA256_RE.test(sha)) throw new Error(`not a sha256: ${sha}`);
  return setArg(composeText, 'QTUM_SHA256', sha);
};

// "    image: 'qtum.avado.dnp.dappnode.eth:0.0.14'" -> the version after the colon.
const IMAGE_LINE = /^(\s*image:\s*["']?)([a-z0-9.-]+):([0-9]+\.[0-9]+\.[0-9]+)(["']?\s*)$/m;
export function readImageTag(composeText) {
  const all = [...String(composeText).matchAll(new RegExp(IMAGE_LINE.source, 'gm'))];
  if (all.length !== 1) throw new Error(`expected exactly one "image: <name>:<version>" line in ${COMPOSE}, found ${all.length}`);
  return { name: all[0][2], version: all[0][3] };
}
export function setImageVersion(composeText, name, version) {
  const cur = readImageTag(composeText);
  if (cur.name !== name) throw new Error(`the compose image is ${cur.name}, not ${name}`);
  const out = composeText.replace(IMAGE_LINE, (_, pre, n, _old, post) => `${pre}${n}:${version}${post}`);
  if (readImageTag(out).version !== version) throw new Error('could not set the compose image version');
  return out;
}

// Replaces only a top-level string field ("version", "upstream"), so the file
// keeps its formatting; refuses to change anything else.
export function setManifestField(text, field, value) {
  const before = JSON.parse(text);
  if (typeof before[field] !== 'string') throw new Error(`the manifest has no top-level "${field}"`);
  const re = new RegExp(`^( {2}"${field}":\\s*")([^"]*)(",?\\s*)$`, 'm');
  if (!re.test(text)) throw new Error(`no top-level "${field}" line in the manifest`);
  const out = text.replace(re, (_, pre, _old, post) => `${pre}${value}${post}`);
  const after = JSON.parse(out);
  if (after[field] !== value || JSON.stringify({ ...after, [field]: before[field] }) !== JSON.stringify(before)) {
    throw new Error(`setting "${field}" changed more than "${field}"`);
  }
  return out;
}
export const setManifestVersion = (text, version) => setManifestField(text, 'version', version);

export function readManifest(root, ref = null) {
  const text = ref ? git(root, ['show', `${ref}:${MANIFEST}`]) : readFileSync(join(root, MANIFEST), 'utf8');
  return JSON.parse(text);
}

// What the repo says at a ref (default: the working tree): package name and
// version, Qtum tag and tarball sha256, and whether they agree with each other.
export function readPackage(root, ref = null) {
  const m = readManifest(root, ref);
  const compose = ref ? git(root, ['show', `${ref}:${COMPOSE}`]) : readFileSync(join(root, COMPOSE), 'utf8');
  return {
    name: m.name,
    version: m.version,
    upstream: m.upstream,
    qtum: readQtumVersion(compose),
    sha256: readQtumSha256(compose),
    image: readImageTag(compose),
  };
}

// The owner holds the package back: a file "hold" in the repo root. Its first
// line that is not a comment is the reason. A held package is not raised by
// the bump bot and not published by the release; boxes keep the version they
// have. Removing the file (a PR the owner reviews and merges) ends the hold.
// Returns the reason, or null.
const firstLine = (text) => String(text).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || 'held (no reason given)';
export function holdReason(root, ref = null) {
  if (ref) {
    try { return firstLine(git(root, ['show', `${ref}:${HOLD_FILE}`])); } catch { return null; }
  }
  const p = join(root, HOLD_FILE);
  return existsSync(p) ? firstLine(readFileSync(p, 'utf8')) : null;
}

// The content id of a commit (scripts/ci/content-id.sh): a hash of every
// tracked file except the release record releases.json. The PR checks name
// the build they tested after it; release.mjs looks it up.
export function contentId(root, rev = 'HEAD') {
  return execFileSync(join(root, 'scripts/ci/content-id.sh'), [rev], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Retries a read (or an idempotent call) that failed for a reason that may go
// away: network errors, timeouts, HTTP 5xx and 429. Anything else fails at once.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function isTransient(err) {
  const s = err?.status;
  return s === undefined || s === null || s >= 500 || s === 429 || s === 408;
}
export async function retry(what, fn, { tries = 3, delayMs = 5000, transient = isTransient } = {}) {
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (attempt === tries || !transient(err)) break;
      console.log(`::warning::${what} failed (attempt ${attempt} of ${tries}): ${String(err.message).split('\n')[0]}; trying again`);
      await sleep(delayMs * attempt);
    }
  }
  throw last;
}

// --- git -------------------------------------------------------------------------

export function git(root, args, opts = {}) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

// Git credentials through the environment (git 2.31+), so the token never
// appears in a command line or an error message. Works in private repos too
// (the workflows check out with persist-credentials: false).
export function gitAuthEnv(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function fetchBranch(root, token, branch) {
  git(root, ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { env: gitAuthEnv(token) });
}

// force: true overwrites the branch; lease (a sha, or '' for "must not exist")
// overwrites it only if it is still where this run saw it.
export function pushHead(root, token, branch, { force = false, lease = undefined } = {}) {
  const how = lease !== undefined ? [`--force-with-lease=refs/heads/${branch}:${lease}`] : force ? ['--force'] : [];
  execFileSync('git', ['-C', root, 'push', '-q', ...how, 'origin', `HEAD:refs/heads/${branch}`], { stdio: 'inherit', env: gitAuthEnv(token) });
}

// The sha a branch has on the remote now ('' when it does not exist).
export function remoteSha(root, token, branch) {
  const out = execFileSync('git', ['-C', root, 'ls-remote', 'origin', `refs/heads/${branch}`], { encoding: 'utf8', env: gitAuthEnv(token) });
  return out.split(/\s+/)[0] || '';
}

// Makes a commit (for example a tested PR head) available locally.
export function ensureCommit(root, token, sha) {
  try { git(root, ['cat-file', '-e', `${sha}^{commit}`]); return; } catch { /* fetch it */ }
  git(root, ['fetch', '-q', 'origin', sha], { env: gitAuthEnv(token) });
  git(root, ['cat-file', '-e', `${sha}^{commit}`]);
}

// Versions the CI released for a package name: commits "Release <name> <version>"
// by github-actions[bot] (ci-release-action and this pipeline's release.yml).
export function releasedVersions(root, name, ref = 'HEAD') {
  const out = git(root, ['log', ref, `--author=${BOT_NAME}`, '-F', `--grep=Release ${name} `, '--format=%s']);
  const re = new RegExp(`^Release ${name.replace(/\./g, '\\.')} (\\d+\\.\\d+\\.\\d+)$`);
  return out.split('\n').map((s) => re.exec(s.trim())?.[1]).filter(Boolean);
}

// --- production store (read only) ----------------------------------------------------

// name -> version, and name -> manifest (its "upstream" is the Qtum tag boxes run).
export async function readProductionVersions({ http, pointerUrl = 'https://bo.ava.do/value/store', gateways = ['http://80.208.229.228:8080', 'https://ipfs.io'] }) {
  let v = JSON.parse(await http.text(pointerUrl, { headers: { 'Cache-Control': 'no-cache' } }));
  if (typeof v === 'string') v = JSON.parse(v);
  let lastErr;
  for (const gw of gateways) {
    try {
      const store = await http.json(`${gw}/ipfs/${v.hash}`, { timeout: 60000 });
      const versions = new Map();
      const manifests = new Map();
      for (const p of store.packages || []) {
        if (!p.manifest?.name) continue;
        versions.set(p.manifest.name, p.manifest.version);
        manifests.set(p.manifest.name, p.manifest);
      }
      return { hash: v.hash, versions, manifests };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('production store unreadable');
}

// --- small things ------------------------------------------------------------------------

export function env(name, fallback = undefined) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function hoursBetween(a, b) {
  return (new Date(b) - new Date(a)) / 3600000;
}

export function fmtUtc(d) {
  return new Date(d).toISOString().replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC');
}

// GitHub Actions log helpers.
export const notice = (msg) => console.log(`::notice::${String(msg).replace(/\n/g, '%0A')}`);
export const warning = (msg) => console.log(`::warning::${String(msg).replace(/\n/g, '%0A')}`);

// A failing script writes what went wrong here; report.mjs puts it into the
// owner's "[pipeline broken]" issue, so the email says what to do.
export function failureFile() {
  return env('PIPELINE_FAILURE_FILE', join(env('RUNNER_TEMP', '/tmp'), 'pipeline-failure.md'));
}
export function recordFailure(text) {
  try { writeFileSync(failureFile(), `${String(text).trim()}\n`); } catch { /* the log still has it */ }
}
