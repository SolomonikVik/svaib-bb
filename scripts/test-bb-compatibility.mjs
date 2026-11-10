import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPackage, engineErrors, loadSemver, readOfficialMatrix, selectTargets } from './check-bb-compatibility.mjs';

const semver = loadSemver(process.env.BB_NPM_PACKAGE);
const policy = { schemaVersion: 1, minorLines: 3, baseline: '0.48.1', appliesFromPlugin: '0.5.8' };
const release = (v, fields = {}) => ({ tag_name: `desktop-v${v}`, draft: false, prerelease: false, published_at: '2026-11-10T00:00:00Z', ...fields });
const pkg = { version: '0.5.8', engines: { bb: '>=0.48.1', bbPluginSdk: '>=0.6.104 <0.7' } };
const targets = [{ bb: '0.48.1', sdk: '0.6.104' }, { bb: '0.49.0', sdk: '0.6.132' }];

test('transition starts at baseline; aliases, prereleases, drafts and older patches do not count', () => {
  const input = [release('0.47.1'), release('0.48.0'), release('0.48.1'), release('0.49.0'),
    release('0.99.0', { draft: true }), release('0.50.0', { prerelease: true }),
    release('0.60.0', { published_at: null }), release('0.51.0-beta.1'),
    release('0.99.0', { tag_name: 'desktop-latest' }), release('0.99.0', { tag_name: 'desktop-nightly' })];
  assert.deepEqual(selectTargets(input, policy, semver).map(x => x.bb), ['0.48.1', '0.49.0']);
});

test('window slides by minor lines, not patches or publication order', () => {
  const input = ['0.51.0', '0.48.9', '0.49.1', '0.50.0', '0.49.0', '0.50.2', '0.48.1'].map(v => release(v));
  assert.deepEqual(selectTargets(input, policy, semver).map(x => x.bb), ['0.49.1', '0.50.2', '0.51.0']);
});

test('major versions remain separate lines', () => {
  assert.deepEqual(selectTargets(['0.49.0', '1.0.0', '1.1.0', '1.1.2'].map(v => release(v)), policy, semver).map(x => x.bb), ['0.49.0', '1.0.0', '1.1.2']);
});

test('missing releases and invalid policy fail closed', () => {
  assert.throws(() => selectTargets([release('0.47.1')], policy, semver), /No stable/);
  assert.throws(() => selectTargets([], { ...policy, baseline: 'latest' }, semver), /Invalid/);
});

test('both engine ranges must admit every target; arbitrary valid semver ranges work', () => {
  assert.deepEqual(engineErrors(pkg, targets, semver), []);
  assert.match(engineErrors({ engines: { ...pkg.engines, bb: '>=0.49.0' } }, targets, semver)[0], /0.48.1.*engines.bb=/);
  assert.match(engineErrors({ engines: { ...pkg.engines, bbPluginSdk: '^0.6.132' } }, targets, semver)[0], /0.6.104.*bbPluginSdk/);
  assert.deepEqual(engineErrors({ engines: { bb: '0.48.1 || >=0.49.0', bbPluginSdk: '^0.6.104' } }, targets, semver), []);
  assert.equal(engineErrors({ engines: {} }, targets, semver).length, 2);
  assert.equal(engineErrors({ engines: { bb: '', bbPluginSdk: 'broken' } }, targets, semver).length, 2);
});

test('historical releases are explicitly unevaluated and never fetch a new matrix', async () => {
  const report = await checkPackage({ ...pkg, version: '0.5.7' }, policy, semver, () => assert.fail('historical fetch'));
  assert.equal(report.status, 'historical-not-evaluated');
  assert.deepEqual(report.targets, []);
});

test('new releases fail when the manifest raises a minimum; compatible versions pass', async () => {
  assert.equal((await checkPackage(pkg, policy, semver, async () => targets)).status, 'pass');
  assert.equal((await checkPackage({ ...pkg, engines: { ...pkg.engines, bb: '>=0.49.0' } }, policy, semver, async () => targets)).status, 'fail');
  await assert.rejects(checkPackage(pkg, policy, semver, async () => { throw new Error('unavailable'); }), /unavailable/);
});

test('release pagination and SDK lookup use the exact official tag', async () => {
  const urls = [];
  const matrix = await readOfficialMatrix(policy, semver, async url => {
    urls.push(url);
    if (new URL(url).searchParams.get('page') === '1') return Array.from({ length: 100 }, () => release('0.49.0'));
    if (new URL(url).searchParams.get('page') === '2') return [release('0.48.1')];
    assert.match(url, /^https:\/\/raw.githubusercontent.com\/get-bb\/bb\/desktop-v0\.(48\.1|49\.0)\/packages\/plugin-sdk\/package.json$/);
    return { name: '@get-bb/plugin-sdk', version: url.includes('0.48.1') ? '0.6.104' : '0.6.132' };
  });
  assert.equal(urls.length, 4);
  assert.deepEqual(matrix.map(({ bb, sdk }) => ({ bb, sdk })), targets);
});

test('invalid SDK metadata and network failures do not turn into a smaller support window', async () => {
  await assert.rejects(readOfficialMatrix(policy, semver, async url => url.includes('api.github.com')
    ? [release('0.49.0')] : { name: '@get-bb/plugin-sdk', version: 'latest' }), /Invalid SDK/);
  await assert.rejects(readOfficialMatrix(policy, semver, async () => { throw new Error('offline'); }), /offline/);
});
