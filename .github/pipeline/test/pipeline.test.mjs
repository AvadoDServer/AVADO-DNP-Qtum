// Unit tests for the pipeline rules: node --test ".github/pipeline/test/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { decide, logExcerpt, ownerMergeFiles, retryable } from '../gate.mjs';
import { forkInfo, forkEta, forkState, bodyHashes, assetDigest, tarballSha256, syncForkIssues } from '../lib/qtum.js';
import {
  compareVersions, bumpPatch, maxVersion, stableReleases, isMajorBump, readQtumVersion, setQtumVersion, readQtumSha256, setQtumSha256,
  readImageTag, setImageVersion, setManifestField, readPackage, bumpMarker, markerTarget, holdReason, contentId, assetName,
} from '../lib/common.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const released = '2026-09-17T02:27:13Z';
const at = (h) => new Date(new Date(released).getTime() + h * 3600000);
const base = { checks: 'success', mandatory: null, major: false, releasedAt: released, now: at(1), upToDate: true, conflict: false };

// Excerpts of real Qtum release notes (qtumproject/qtum).
const NOTES = {
  'v29.1': {
    name: 'Qtum Core v29.1 – Hard Fork - Upgrade to bitcoin core 29.1 - EVM Pectra - Improvements and Bug fixes.',
    published_at: '2025-11-04T23:29:36Z',
    body: '### **Mandatory update before Mainnet block 5483000** (Testnet block 5442000)\n\n---\n\n### ▸ Qtum Core upgraded to Bitcoin Core [29.1](https://bitcoincore.org/en/releases/29.1/)\n\n<p align="center">\n<b>Fork ETA</b><br>\nMainnet: <b>Jan 12 2026 – 01:24:40 UTC (block 5483000)</b><br>\nTestnet: <b>Dec 12 2025 – 00:40:14 UTC (block 5442000)</b>\n</p>\n',
  },
  'v27.1': {
    name: 'Qtum Core v27.1 – Hard Fork - Upgrade to bitcoin core 27.1 - EVM Dencun - Improvements and Bug fixes.',
    published_at: '2024-11-03T18:46:17Z',
    body: '* v27.1 – Hard Fork - **Mandatory Update before block 4590000** (4510000 in testnet) – Upgrade to bitcoin core 27.1\n\n<p align="center">\nFork ETA: <b>Mainnet: Feb 15, 2025, 7:28:14 AM UTC</b> | Testnet: Dec 31, 2024, 6:19:16 PM UTC \n</p>\n\n```\n0b1f612f0762184240c785c66b548f2dab8eed5e25481c635806ddf81807aa86  qtum-27.1-x86_64-linux-gnu.tar.gz\n```\n',
  },
  'v24.1': {
    name: 'Qtum Core v24.1 – Hard Fork - Upgrade to bitcoin core 24.1 - EVM Shanghai - Improvements and Bug fixes.',
    published_at: '2023-09-02T04:22:14Z',
    body: '* v24.1 – Hard Fork - **Mandatory Update before block 3385122** (3298892 in testnet) – Upgrade to bitcoin core 24.1\n\nTestnet fork ETA: October 8, 2023 01:18 UTC\nMainnet fork ETA: November 27, 2023 00:24 UTC\n\n```\n13f7ca5c352732772e924bd07db0e8327e0a850edd9c89e7d191e0734990621c  x86_64-linux-gnu/qtum-24.1-x86_64-linux-gnu.tar.gz\n```\n',
  },
  'v30.2': {
    name: 'Qtum Core v30.2 - Upgrade to bitcoin core v30.2 - Improvements and Bug fixes',
    published_at: '2026-07-22T06:32:25Z',
    body: '### ▸ Legacy Wallets No Longer Supported\n\nLegacy (BDB) wallets are no longer supported. Descriptor (sqlite) wallets are now the only supported wallet format. To migrate an existing legacy wallet:\n\n```bash\n./qtum-cli migratewallet wallet.dat\n```\n\nThe following legacy-only RPCs have been removed: `dumpprivkey`, `importprivkey`. You must upgrade your scripts.\n',
  },
  'v25.1': { name: 'Qtum Core v25.1 - Upgrade to bitcoin core v25.1 - Ledger Improvements - Bug fixes', published_at: '2024-03-04T23:47:33Z', body: 'Bug fixes.' },
  'v22.0': { name: 'Qtum Core v22.0 - Hard Fork -  Taproot - Schnorr Signatures - Evmone - Improvements and Bug fixes', published_at: '2022-05-27T22:20:02Z', body: 'Taproot and Schnorr signatures.' },
};
const rel = (tag) => ({ tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/qtumproject/qtum/releases/tag/${tag}`, assets: [], ...NOTES[tag] });

test('merges when our checks are green and 72 h passed since the Qtum release', () => {
  assert.equal(decide({ ...base, now: at(71.9) }).action, 'wait');
  assert.equal(decide({ ...base, now: at(71.9) }).cause, 'soak');
  const d = decide({ ...base, now: at(72) });
  assert.equal(d.action, 'merge');
  assert.equal(d.cause, 'waited');
});

test('a hard fork does not wait the 72 h', () => {
  const d = decide({ ...base, mandatory: { source: 'Qtum v29.1 is a hard fork' } });
  assert.equal(d.action, 'merge');
  assert.equal(d.cause, 'hard-fork');
});

test('a new major Qtum version never merges by itself, not even a hard fork with green checks after 72 h', () => {
  for (const checks of ['success', 'failure', 'pending', 'missing']) {
    const d = decide({ ...base, checks, major: true, mandatory: { source: 'fork' }, now: at(500) });
    assert.equal(d.action, 'block', checks);
    assert.equal(d.cause, 'major', checks);
  }
  assert.ok(isMajorBump('v30.2', 'v31.0'));
  assert.ok(!isMajorBump('v30.2', 'v30.3'));
  assert.ok(!isMajorBump('v30.2', 'v30.2.1'));
});

test('never merges when our checks failed, and says so before anything else', () => {
  const d = decide({ ...base, checks: 'failure', mandatory: { source: 'fork' }, now: at(500) });
  assert.equal(d.action, 'block');
  assert.equal(d.cause, 'checks-failed');
  assert.equal(decide({ ...base, checks: 'failure', releasedAt: null }).cause, 'checks-failed');
});

test('waits while checks run or the branch is behind', () => {
  assert.equal(decide({ ...base, checks: 'pending', now: at(100) }).cause, 'checks');
  assert.equal(decide({ ...base, checks: 'missing', now: at(100) }).cause, 'checks');
  assert.equal(decide({ ...base, upToDate: false, now: at(100) }).cause, 'behind');
});

test('checks that stay silent for 6 h after the last push block instead of waiting forever', () => {
  const headAt = at(0).toISOString();
  assert.equal(decide({ ...base, checks: 'missing', headAt, now: at(5.9) }).action, 'wait');
  const d = decide({ ...base, checks: 'pending', headAt, now: at(6) });
  assert.equal(d.action, 'block');
  assert.equal(d.cause, 'unclear');
});

test('anything unclear blocks', () => {
  assert.equal(decide({ ...base, releasedAt: null }).cause, 'unclear');
  assert.equal(decide({ ...base, errors: ['Qtum releases: HTTP 500'] }).cause, 'unclear');
  assert.equal(decide({ ...base, conflict: true }).cause, 'conflict');
  assert.equal(decide({ ...base, unexpectedFiles: ['build/Dockerfile'] }).cause, 'unexpected-files');
});

test('a person changing the checks or the pipeline on the bot branch leaves the merge to the owner', () => {
  const files = ['docker-compose.yml', 'dappnode_package.json', 'build/monitor/index.js', 'build/wizard/src/App.js'];
  assert.deepEqual(ownerMergeFiles(files, false), [], 'a monitor or wizard fix may still merge by itself');
  for (const f of ['scripts/ci/check-flags.sh', 'scripts/ci/legacy-wallet-test.sh', 'test/smoke-test.sh', '.github/pipeline/release.mjs',
    '.github/workflows/release.yml', 'hold', 'releases.json']) {
    assert.deepEqual(ownerMergeFiles([...files, f], false), [f], f);
  }
  assert.deepEqual(ownerMergeFiles(['test/smoke-test.sh'], true), [], 'bot-only PRs are guarded by the unexpected-files rule');
  const d = decide({ ...base, now: at(100), ownerFiles: ['test/smoke-test.sh'] });
  assert.equal(d.action, 'block');
  assert.equal(d.cause, 'owner-merge');
});

test('checks that failed on an outside step run once more, without an issue', () => {
  const outside = [{ name: 'package', step: 'Boots on Qtum mainnet' }, { name: 'package', step: 'AVADOSDK build (build, add to IPFS)' }];
  assert.ok(retryable(outside));
  assert.ok(retryable([{ name: 'package', steps: ['Production image (from the store)', 'Old Qtum builds (download for the wallet test)'] }]));
  assert.ok(retryable([{ name: 'package', step: null }]), 'a job lost without a failed step (runner) is retried');
  for (const step of ['Legacy wallets keep every key (production image, then this build)', 'Regtest smoke test (every RPC the wizard uses)',
    'Every qtumd option and qtum.conf key is accepted', 'Exact Qtum version']) {
    assert.ok(!retryable([...outside, { name: 'package', step }]), step);
  }
  assert.ok(!retryable([{ name: 'Plan (unit tests, identity, tarball)', step: 'Unit tests of the pipeline rules' }]));
  assert.ok(!retryable([]));
  const d = decide({ ...base, checks: 'failure', rerun: 'package: Boots on Qtum mainnet' });
  assert.equal(d.action, 'wait');
  assert.equal(d.cause, 'rerun');
});

test('hard forks: the block and the date from the release notes', () => {
  const qtum = { height: 5480000, avgBlockSeconds: 32, now: new Date('2026-01-11T00:00:00Z') };
  const f29 = forkInfo(rel('v29.1'), qtum);
  assert.equal(f29.block, 5483000);
  assert.equal(f29.rule, 'qtum-block');
  assert.equal(f29.deadline.toISOString(), new Date(qtum.now.getTime() + 3000 * 32 * 1000).toISOString(), 'estimated from the chain height');
  assert.equal(f29.eta.toISOString(), '2026-01-12T01:24:00.000Z', 'Qtum\'s own ETA (minutes)');
  const f27 = forkInfo(rel('v27.1'));
  assert.equal(f27.block, 4590000);
  assert.equal(f27.deadline.toISOString(), '2025-02-15T07:28:00.000Z', 'without the chain height: the notes\' ETA');
  const f24 = forkInfo(rel('v24.1'));
  assert.equal(f24.block, 3385122);
  assert.equal(f24.eta.toISOString(), '2023-11-27T00:24:00.000Z');
  assert.equal(forkInfo(rel('v30.2')), null, '"Legacy wallets no longer supported" and "must upgrade your scripts" are not a fork');
  assert.equal(forkInfo(rel('v25.1')), null);
  const f22 = forkInfo(rel('v22.0'));
  assert.equal(f22.block, null, 'a "Hard Fork" title without a block still counts');
  assert.equal(f22.rule, 'title');
  assert.equal(forkInfo({ tag_name: 'v0.18.3', name: 'Mainnet Ignition v0.18.3 - Mandatory update for Windows x64: Bug fix.', body: '' }), null);
  assert.equal(forkEta('Mainnet: tomorrow'), null, 'a date only counts next to "ETA"');
});

test('hard-fork state only moves forward: announced, soon (< 48 h), passed', () => {
  const now = new Date('2026-01-10T12:00:00Z');
  const f = { block: 5483000, deadline: new Date('2026-01-12T01:24:40Z') };
  assert.equal(forkState(f, { now }), 'soon');
  assert.equal(forkState({ ...f, deadline: new Date('2026-01-20T00:00:00Z') }, { now }), 'announced');
  assert.equal(forkState(f, { qtum: { height: 5483000 }, now }), 'passed');
  assert.equal(forkState({ block: null, deadline: null }, { now }), 'announced');
});

test('the hard-fork issue opens once, gets one more email when the fork is near, closes when production has it', async () => {
  const issues = [];
  const comments = [];
  const gh = {
    async get(path) {
      if (/\/issues\?state=/.test(path)) {
        const open = /state=open/.test(path);
        return issues.filter((i) => !open || i.state === 'open');
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, body) {
      if (path.endsWith('/labels')) return {};
      const m = /issues\/(\d+)\/comments$/.exec(path);
      if (m) { comments.push({ n: Number(m[1]), body: body.body }); return {}; }
      const issue = { number: issues.length + 1, state: 'open', html_url: `u/${issues.length + 1}`, ...body };
      issues.push(issue);
      return issue;
    },
    async patch(path, body) {
      const n = Number(/issues\/(\d+)$/.exec(path)[1]);
      Object.assign(issues.find((i) => i.number === n), body);
      return {};
    },
  };
  const releases = [rel('v30.2'), { ...rel('v29.1'), tag_name: 'v31.1' }];
  const run = (qtum, prodQtum) => syncForkIssues({ gh, repo: 'o/r', owner: 'flisko', releases, prodQtum, mainQtum: 'v30.2', qtum, say: () => {} });
  const far = { height: 5400000, avgBlockSeconds: 32, now: new Date('2026-01-01T00:00:00Z') };
  const forks = await run(far, 'v30.2');
  assert.deepEqual(forks.map((f) => f.tag), ['v31.1']);
  assert.equal(issues.length, 1);
  assert.match(issues[0].title, /^\[hard fork\] Qtum v31\.1: required before mainnet block 5483000 \(about 2026-01-31/);
  assert.match(issues[0].body, /new MAJOR Qtum version/, 'v30 -> v31 is also a major version');
  assert.deepEqual(issues[0].assignees, ['flisko']);
  await run(far, 'v30.2');
  assert.equal(comments.length, 0, 'nothing new: no comment, no email');
  const near = { height: 5480000, avgBlockSeconds: 32, now: new Date('2026-01-11T00:00:00Z') };
  await run(near, 'v30.2');
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /less than 48 hours away/);
  await run({ ...near, height: 5470000 }, 'v30.2');
  assert.equal(comments.length, 1, 'a later, farther estimate does not go back to "announced"');
  await run(near, 'v31.1');
  assert.equal(issues[0].state, 'closed', 'production runs the fork release');
});

test('the tarball sha256 is compared with every published hash', async () => {
  assert.equal(assetName('v30.2'), 'qtum-30.2-x86_64-linux-gnu.tar.gz');
  assert.equal(bodyHashes(NOTES['v24.1'].body).get('qtum-24.1-x86_64-linux-gnu.tar.gz'), '13f7ca5c352732772e924bd07db0e8327e0a850edd9c89e7d191e0734990621c');
  assert.equal(assetDigest({ digest: `sha256:${'a'.repeat(64)}` }), 'a'.repeat(64));
  assert.equal(assetDigest({}), null);
  const good = '0b1f612f0762184240c785c66b548f2dab8eed5e25481c635806ddf81807aa86';
  const release = { ...rel('v27.1'), assets: [{ name: 'qtum-27.1-x86_64-linux-gnu.tar.gz', size: 10, browser_download_url: 'x', digest: `sha256:${good}` }] };
  const ok = await tarballSha256(release, { hash: async () => ({ sha256: good, bytes: 10 }) });
  assert.equal(ok.sha256, good);
  assert.deepEqual(ok.sources, ['downloaded and hashed', "GitHub's asset digest", 'the release notes']);
  await assert.rejects(tarballSha256(release, { hash: async () => ({ sha256: 'b'.repeat(64), bytes: 10 }) }), /asset digest/);
  await assert.rejects(tarballSha256({ ...release, assets: [{ ...release.assets[0], digest: undefined }] }, { hash: async () => ({ sha256: 'b'.repeat(64), bytes: 10 }) }), /release notes list/);
  assert.deepEqual(await tarballSha256({ ...release, assets: [] }), { missing: true, name: 'qtum-27.1-x86_64-linux-gnu.tar.gz' });
});

test('versions: stable Qtum tags only, two or three parts', () => {
  assert.equal(compareVersions('v30.2', 'v30.2.0'), 0);
  assert.equal(compareVersions('v30.10', 'v30.9'), 1);
  assert.equal(compareVersions('v31.0', 'v30.2.1'), 1);
  assert.equal(bumpPatch('0.0.14'), '0.0.15');
  assert.equal(maxVersion(['0.0.14', '0.0.9', '0.0.100']), '0.0.100');
  const rels = [
    { tag_name: 'v30.2', draft: false, prerelease: false },
    { tag_name: 'v31.0rc1', draft: false, prerelease: false },
    { tag_name: 'v31.0', draft: false, prerelease: true },
    { tag_name: 'v30.3', draft: true, prerelease: false },
    { tag_name: 'mainnet-fastlane-v0.20.4', draft: false, prerelease: false },
    { tag_name: 'v30.2.1', draft: false, prerelease: false },
  ];
  assert.deepEqual(stableReleases(rels).map((r) => r.tag_name), ['v30.2.1', 'v30.2']);
});

test('the bump edits only the version lines of the real files', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  const pkg = readPackage(ROOT);
  assert.equal(pkg.upstream, pkg.qtum, 'manifest upstream = compose VERSION');
  assert.deepEqual(pkg.image, { name: pkg.name, version: pkg.version }, 'compose image = name:version');
  const changed = (a, b) => a.split('\n').filter((l, i) => l !== b.split('\n')[i]).length;
  const other = pkg.qtum === 'v99.1' ? 'v99.2' : 'v99.1';
  const sha = readQtumSha256(compose) === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
  const edited = setImageVersion(setQtumSha256(setQtumVersion(compose, other), sha), pkg.name, bumpPatch(pkg.version));
  assert.equal(readQtumVersion(edited), other);
  assert.equal(readQtumSha256(edited), sha);
  assert.equal(readImageTag(edited).version, bumpPatch(pkg.version));
  assert.equal(changed(edited, compose), 3);
  assert.equal(setImageVersion(setQtumSha256(setQtumVersion(edited, pkg.qtum), pkg.sha256), pkg.name, pkg.version), compose);
  assert.throws(() => setQtumSha256(compose, '1234'));
  assert.throws(() => setQtumVersion(compose, 'v30.2rc1'));
  assert.throws(() => setImageVersion(compose, 'other.avado.dnp.dappnode.eth', '0.0.1'));
  assert.throws(() => readQtumVersion(`${compose}\n        - VERSION=v1.0\n`), /exactly one/);
  const manifest = readFileSync(join(ROOT, 'dappnode_package.json'), 'utf8');
  const m2 = setManifestField(setManifestField(manifest, 'version', bumpPatch(pkg.version)), 'upstream', other);
  assert.equal(JSON.parse(m2).version, bumpPatch(pkg.version));
  assert.equal(JSON.parse(m2).upstream, other);
  assert.equal(changed(m2, manifest), 2);
  assert.throws(() => setManifestField(manifest, 'nosuchfield', 'x'));
});

test('the issue shows the failing lines of a job log, not setup or cleanup noise', () => {
  const log = [
    '2026-09-26T22:10:19.1Z ##[group]Run scripts/ci/legacy-wallet-test.sh',
    '2026-09-26T22:10:19.2Z   PASS  A-made-legacy                  Qtum 22.1 made a legacy (Berkeley DB) wallet',
    '2026-09-26T22:10:19.3Z   FAIL  A-keys                         2 of 13 keys differ or are missing: Qabc Qdef',
    '2026-09-26T22:10:19.7Z \x1b[36;1mshell: /usr/bin/bash -e {0}\x1b[0m',
    '2026-09-26T22:10:19.8Z ##[error]Process completed with exit code 1.',
    '2026-09-26T22:10:19.9Z Post job cleanup.',
    '2026-09-26T22:10:20.0Z [command]/usr/bin/git version',
  ].join('\n');
  const x = logExcerpt(log);
  assert.match(x, /FAIL {2}A-keys/);
  assert.match(x, /##\[error\]/);
  assert.doesNotMatch(x, /Post job|\[command\]|\x1b|shell: /);
});

test('the bump PR marker names its Qtum release (closing the PR skips that release)', () => {
  assert.equal(markerTarget(`${bumpMarker('v30.3')}\n## Qtum Core v30.3`), 'v30.3');
  assert.equal(markerTarget(`${bumpMarker(null)}\n## TEST`), null, 'a [TEST] PR never skips a real release');
  assert.equal(markerTarget('no marker'), null);
});

test('hold: the first line that is not a comment is the reason; no file means not held', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hold-'));
  assert.equal(holdReason(dir), null);
  writeFileSync(join(dir, 'hold'), '\n# why\nwaits for the wallet migration to settle\n# more\n');
  assert.equal(holdReason(dir), 'waits for the wallet migration to settle');
  writeFileSync(join(dir, 'hold'), '# only comments\n');
  assert.equal(holdReason(dir), 'held (no reason given)');
});

test('the content id ignores the release record only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'content-id-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q');
  mkdirSync(join(dir, 'scripts/ci'), { recursive: true });
  copyFileSync(join(ROOT, 'scripts/ci/content-id.sh'), join(dir, 'scripts/ci/content-id.sh'));
  writeFileSync(join(dir, 'dappnode_package.json'), '{"version":"0.0.15"}\n');
  const commit = (msg) => { g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg); return g('rev-parse', 'HEAD'); };
  const a = commit('a');
  writeFileSync(join(dir, 'releases.json'), '{"0.0.15":{"hash":"/ipfs/Qm"}}');
  const b = commit('Release qtum.avado.dnp.dappnode.eth 0.0.15');
  writeFileSync(join(dir, 'dappnode_package.json'), '{"version":"0.0.16"}\n');
  const c = commit('c');
  mkdirSync(join(dir, 'build'), { recursive: true });
  writeFileSync(join(dir, 'build/releases.json'), '{}');
  const d = commit('d');
  assert.equal(contentId(dir, a), contentId(dir, b), 'a Release commit does not change the content id');
  assert.notEqual(contentId(dir, b), contentId(dir, c));
  assert.notEqual(contentId(dir, c), contentId(dir, d), 'only the root releases.json is ignored');
  assert.match(contentId(dir, a), /^[0-9a-f]{40}$/);
});
