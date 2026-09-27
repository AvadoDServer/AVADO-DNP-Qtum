#!/usr/bin/env node
// Release (release.yml, on every push to the default branch and when the gate
// starts it): publishes the package to the STAGING store when its version is
// not published yet, and ONLY the exact build our PR checks tested. Replaces
// AvadoDServer/ci-release-action for this repo.
//
// When the package is not held (no "hold" file) and its version has no release
// yet (no "Release <name> <version>" commit and no entry in releases.json):
//   1. find the build the PR checks tested for exactly these files: artifact
//      avado-build-<content id> (scripts/ci/content-id.sh: every file except
//      releases.json, so a merge commit, a squash and a re-run after a partial
//      release all find it), made by a PR-checks run of this repo for the
//      commit it names; its manifest is read back from AVADO's IPFS node and
//      must equal the default branch's dappnode_package.json, and its image
//      must be on the node. There is NO fallback build: without a tested build
//      nothing is published and the run fails, so the owner gets an issue that
//      says how to get one ("PR checks" with pr = the default branch, then Release).
//   2. store.setPackageHash on adminrpc.ava.do, then record the hash in
//      releases.json (the AVADOSDK format) and commit "Release <name> <version>"
//      + "Manifest hash: <hash>" and push,
// then ONE store.releaseStore on bo.ava.do: the server only queues the staging
// rebuild and does not say whether it worked. Same calls and the same secret
// (RPC_TOKEN) as ci-release-action. Versions only go up. Nothing new: nothing is
// published (with RELEASE_STORE=true the staging rebuild is requested again).
//
// DRY RUN when RPC_TOKEN is empty or DRY_RUN=true: everything up to the store
// calls is done or shown, nothing is committed, pushed or published.
//
// Environment: GITHUB_REPOSITORY, GITHUB_TOKEN (contents write, actions read),
// RPC_TOKEN, DRY_RUN, RELEASE_STORE, IPFS_API (the IPFS API the tested builds
// were added to; default AVADO's node), ADMIN_RPC_URL, STORE_RPC_URL.

import { readFileSync, writeFileSync, existsSync, mkdtempSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { makeClient } from './lib/gh.js';
import {
  BOT_NAME, BOT_EMAIL, PR_CHECKS_PATH, MANIFEST, RELEASES, compareVersions, maxVersion, readPackage, git, fetchBranch, pushHead,
  releasedVersions, readProductionVersions, holdReason, contentId, ensureCommit, retry, env, notice, warning, recordFailure,
} from './lib/common.js';

export const AVADO_IPFS_API = 'http://80.208.229.228:35001';
const root = process.cwd();
const repo = env('GITHUB_REPOSITORY');
const token = env('GITHUB_TOKEN');
const rpcToken = env('RPC_TOKEN');
const dryRun = !rpcToken || env('DRY_RUN') === 'true';
const storeAgain = env('RELEASE_STORE') === 'true';
const ipfsApi = env('IPFS_API', AVADO_IPFS_API);
const adminRpc = env('ADMIN_RPC_URL', 'https://adminrpc.ava.do');
const storeRpc = env('STORE_RPC_URL', 'https://bo.ava.do/rpc');
const server = env('GITHUB_SERVER_URL', 'https://github.com');
const runLink = (id) => `${server}/${repo}/actions/runs/${id}`;
const out = [];
const say = (s) => { console.log(s); out.push(s); };

const sh = (cmd, args, opts = {}) => String(execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 << 20, ...opts }) ?? '').trim();
const stripBuild = (m) => {
  const c = structuredClone(m);
  if (c.image) { delete c.image.path; delete c.image.hash; delete c.image.size; }
  delete c.builddate;
  return c;
};
const isLocal = (url) => /localhost|127\.0\.0\.1/.test(url || '');

async function ipfs(api, path) {
  const res = await fetch(`${api}/api/v0/${path}`, { method: 'POST', signal: AbortSignal.timeout(120000) });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`IPFS ${path.split('?')[0]}: HTTP ${res.status} ${text.slice(0, 160)}`), { status: res.status });
  return text;
}

async function rpc(url, headers, method, params, { strict }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
  let body = null;
  try { body = JSON.parse(text); } catch { /* checked below */ }
  if (body?.error) throw new Error(`${method}: ${JSON.stringify(body.error).slice(0, 300)}`);
  if (strict && (!body || body.result === undefined)) throw new Error(`${method}: unexpected answer ${text.slice(0, 200)}`);
  if (!body) warning(`${method}: the answer was not JSON (${text.slice(0, 120)}); HTTP ${res.status} counts as success, as in ci-release-action`);
  return body?.result;
}

// One artifact: is it a build our PR checks made and tested for these files?
// Returns { record, from } (local: true when it was added to a throwaway IPFS
// node) or { reject: why }. Throws when something could not be READ (after
// retries), so a network hiccup never turns into "use another build".
async function checkCandidate(gh, a, cid, manifestNow) {
  const from = runLink(a.workflow_run.id);
  const run = await retry('reading the PR-checks run', () => gh.get(`repos/${repo}/actions/runs/${a.workflow_run.id}`));
  if (run.path !== PR_CHECKS_PATH) return { reject: `${from} is not a PR-checks run (${run.path})` };
  if (!run.head_repository || run.head_repository.id !== run.repository?.id) return { reject: `${from} ran for a fork` };
  if (!['pull_request', 'workflow_dispatch'].includes(run.event)) return { reject: `${from} was started by ${run.event}` };

  // A fresh folder for every attempt: a half-finished download must not get in the way.
  const dir = await retry('downloading the tested build record', async () => {
    const d = mkdtempSync(join(tmpdir(), 'avado-build-'));
    sh('gh', ['run', 'download', String(a.workflow_run.id), '-R', repo, '-n', a.name, '-D', d], { env: { ...process.env, GH_TOKEN: token } });
    return d;
  });
  const record = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(record.commit || '')) return { reject: `${from}: the record names no commit` };
  // A pull_request run checks the PR head; a run started by hand (the bump bot
  // without PAT_TOKEN, or "PR checks" with pr = the default branch) checks the
  // commit it names, and pr-checks.yml refuses to start one for a fork.
  if (run.event === 'pull_request' && run.head_sha !== record.commit) return { reject: `${from} checked ${run.head_sha.slice(0, 7)}, not ${record.commit.slice(0, 7)}` };
  await retry('fetching the tested commit', async () => ensureCommit(root, token, record.commit));
  const builtId = contentId(root, record.commit);
  if (record.contentId !== cid || builtId !== cid) return { reject: `${from} tested other files (commit ${record.commit.slice(0, 7)})` };
  if (record.name !== manifestNow.name || record.version !== manifestNow.version || record.upstream !== manifestNow.upstream) {
    return { reject: `${from} is ${record.name} ${record.version} (Qtum ${record.upstream})` };
  }
  // A build added to a throwaway IPFS node (a test copy with IPFS_PROVIDER=local)
  // cannot be read back, and boxes could never download it.
  if (record.provider !== ipfsApi || isLocal(record.provider)) {
    return { record, from, local: true, why: `the tested build ${from} was added to ${record.provider}, which cannot be read back or downloaded by boxes` };
  }
  const manifest = JSON.parse(await retry('reading the tested manifest from IPFS', () => ipfs(ipfsApi, `cat?arg=${encodeURIComponent(record.manifestHash)}`)));
  if (!isDeepStrictEqual(stripBuild(manifest), manifestNow)) return { reject: `the manifest of ${from} differs from the default branch's ${MANIFEST}` };
  if (manifest.image?.hash !== record.imageHash) return { reject: `${from}: the image hash differs from its manifest` };
  const cidOnly = record.imageHash.replace('/ipfs/', '');
  await retry('checking the tested image on IPFS', async () => {
    try {
      await ipfs(ipfsApi, `pin/ls?arg=${encodeURIComponent(cidOnly)}&type=recursive`);
    } catch {
      await ipfs(ipfsApi, `block/stat?arg=${encodeURIComponent(cidOnly)}`);
    }
  });
  return { record, from };
}

// The build the PR checks tested for exactly these files. Oldest first, so a
// re-run after a partial release picks the same build (the same hash).
async function testedBuild(gh, cid, manifestNow) {
  const name = `avado-build-${cid}`;
  const list = await retry('listing the tested builds', () => gh.get(`repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`));
  const candidates = (list?.artifacts || [])
    .filter((a) => !a.expired && a.workflow_run && a.workflow_run.head_repository_id === a.workflow_run.repository_id)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (!candidates.length) return { missing: `no tested build ${name} was found (the PR checks of this repo never tested exactly these files, or the build is older than 90 days)` };
  const rejects = [];
  let local = null;
  for (const a of candidates) {
    const r = await checkCandidate(gh, a, cid, manifestNow);
    if (r.record && !r.local) return r;
    if (r.local) { local = local || r; continue; }
    rejects.push(r.reject);
  }
  if (local) return local;
  return { missing: `no usable tested build: ${rejects.join('; ')}` };
}

function pushWithRetry(base) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      pushHead(root, token, base);
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      warning(`push rejected (attempt ${attempt}); rebasing on the new ${base}`);
      fetchBranch(root, token, base);
      git(root, ['-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`, 'rebase', '-q', `origin/${base}`]);
    }
  }
}

async function releaseStore(names) {
  if (dryRun) {
    say(`DRY RUN: would call store.releaseStore once on ${storeRpc} (staging store rebuilt${names.length ? ` with ${names.join(', ')}` : ''})`);
    return;
  }
  await rpc(storeRpc, { admintoken: rpcToken }, 'store.releaseStore', null, { strict: false });
  say(`store.releaseStore: the staging rebuild is queued${names.length ? ` with ${names.join(', ')}` : ''}. The server does not report whether the rebuild worked: check the package on the test box. Production stays the owner's click in editstore.`);
}

async function main() {
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  const gh = makeClient({ token });
  const base = (await gh.get(`repos/${repo}`)).default_branch;
  fetchBranch(root, token, base);
  git(root, ['checkout', '-q', '--detach', `origin/${base}`]);
  const cid = contentId(root, 'HEAD');
  say(`${dryRun ? 'DRY RUN' + (rpcToken ? ' (DRY_RUN=true)' : ' (no RPC_TOKEN)') + ': nothing is committed or published. ' : ''}${base} at ${git(root, ['rev-parse', '--short', 'HEAD'])}, content id ${cid.slice(0, 12)}, IPFS ${ipfsApi}`);

  let prod = null;
  try { prod = await readProductionVersions({ http: gh.http }); } catch (err) { warning(`production store unreadable (${err.message}); the version guard uses git history only`); }

  const pkg = readPackage(root);
  const manifestNow = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
  const { name, version } = pkg;
  if (pkg.upstream !== pkg.qtum || pkg.image.name !== name || pkg.image.version !== version) {
    throw new Error(`${MANIFEST} and docker-compose.yml disagree (manifest ${name} ${version}, upstream ${pkg.upstream}; compose VERSION ${pkg.qtum}, image ${pkg.image.name}:${pkg.image.version}); the PR checks refuse this too`);
  }
  const hold = holdReason(root);
  if (hold) {
    say(`- ${name}: HELD, not published (${hold}). Boxes keep ${prod?.versions.get(name) ? `production ${prod.versions.get(name)}` : 'what they have'}.`);
    if (storeAgain) await releaseStore([]);
    return;
  }
  const relFile = join(root, RELEASES);
  const record = existsSync(relFile) ? JSON.parse(readFileSync(relFile, 'utf8')) : {};
  const released = releasedVersions(root, name);
  if (record[version]?.hash || released.includes(version)) {
    say(`- ${name} ${version} is already published${record[version]?.hash ? ` (${record[version].hash})` : ''}; nothing to do`);
    say('Nothing to publish: the version is not new.');
    if (storeAgain) await releaseStore([]);
    return;
  }
  const highest = maxVersion([...released, prod?.versions.get(name)].filter(Boolean));
  if (highest && compareVersions(version, highest) <= 0) {
    throw new Error(`${name} ${version} is not above the highest version already released (${highest}); versions only go up`);
  }
  say(`- ${name} ${version} (Qtum ${pkg.qtum}) will be published${highest ? ` (last released ${highest})` : ''}`);

  // Find the tested build BEFORE publishing anything: a read error stops the
  // run here, with nothing published.
  const b = await testedBuild(gh, cid, manifestNow);
  if (!(b.record && (!b.local || dryRun))) {
    throw new Error(`NOT published (nothing untested is ever published):
- ${name} ${version}: ${b.missing || b.why}
To publish it: in GitHub, Actions -> "PR checks" -> Run workflow, with pr = ${base} (it builds and tests the default branch exactly as it is). When it is green, Actions -> "Release" -> Run workflow. If the checks fail, fix the cause in a pull request instead.`);
  }

  const hash = b.record.manifestHash.replace(/^\/ipfs\//, '');
  const source = b.local
    ? `the tested build ${b.from} (DRY RUN: it was added to a test IPFS node, ${b.record.provider}, so it could not be read back)`
    : `the build the PR checks tested (${b.from}, commit ${b.record.commit.slice(0, 7)})`;
  record[version] = { hash: `/ipfs/${hash}`, type: 'manifest', uploadedTo: { [b.record.provider]: new Date(b.record.builtAt).toUTCString() } };
  const message = `Release ${name} ${version}\n\nManifest hash: ${hash}\n\nQtum ${pkg.qtum}. Published from ${source}.`;
  say(`- ${name} ${version}: manifest ${hash}, image ${b.record.imageHash}, from ${source}`);
  if (dryRun) {
    say(`  DRY RUN: would call store.setPackageHash({name: "${name}", ipfsHash: "${hash}"}) on ${adminRpc}, then commit "Release ${name} ${version}" with ${RELEASES} and push to ${base}`);
    say(`  DRY RUN: ${RELEASES} would get: ${JSON.stringify({ [version]: record[version] })}`);
  } else {
    if (isLocal(b.record.provider)) throw new Error(`refusing to publish a build that was added to a test IPFS node (${b.record.provider}); boxes could not download it`);
    writeFileSync(relFile, JSON.stringify(record, null, 2)); // the AVADOSDK's format (no final newline)
    await rpc(adminRpc, { Authorization: rpcToken }, 'store.setPackageHash', { name, ipfsHash: hash }, { strict: true });
    say(`  store.setPackageHash ${name} -> ${hash}: ok`);
    git(root, ['add', '-f', RELEASES]);
    git(root, ['-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`, 'commit', '-q', '-m', message]);
    pushWithRetry(base);
    say(`  committed and pushed "Release ${name} ${version}"`);
  }
  await releaseStore([`${name} ${version}`]);
  if (!dryRun) notice(`Published to staging: ${name} ${version}`);
}

main()
  .catch((err) => {
    console.log(`::error::${err.stack || err.message}`);
    out.push(`**Release failed:** ${err.message}`);
    recordFailure(err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    const f = env('GITHUB_STEP_SUMMARY');
    if (f) appendFileSync(f, `${out.join('\n')}\n`);
  });
