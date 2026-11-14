import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { inspectNativeKimiPi, prepareNativeKimiPi, type NativePiOptions } from '../kimi-pi-native';

const signal = () => new AbortController().signal;
const BASE_URL = 'https://api.kimi.ai/coding/v1';
const FIRST = 'sk-kimi-first-synthetic';
const SECOND = 'sk-kimi-second-synthetic';
async function fixture(t: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), 'kimi-pi-native-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'ownership'); const agentDir = join(parent, 'native profile');
  const options: NativePiOptions = {
    agentDir, env: {},
    resolveRegistration: async directory => ({ command: process.execPath, args: ['synthetic-pi.js'], agentDir: directory }),
    probeVersion: async () => '1.5.2',
  };
  const put = async (name: string, value: unknown) => {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, name), JSON.stringify(value));
  };
  const get = async (name: string) => JSON.parse(await readFile(join(agentDir, name), 'utf8'));
  return { parent, root, agentDir, options, put, get };
}

test('native setup preserves unrelated credentials and model settings, returns only native registration', async t => {
  const f = await fixture(t);
  const otherAuth = { anthropic: { type: 'oauth', refresh: 'other-refresh', access: 'other-access', expires: 123 } };
  const otherModels = { tuning: 7, providers: { custom: { baseUrl: 'https://example.test', models: [{ id: 'other' }] }, 'kimi-coding': { models: [{ id: 'kimi-custom' }] } } };
  await f.put('auth.json', otherAuth); await f.put('models.json', otherModels);
  const events: unknown[] = [];
  const registration = await prepareNativeKimiPi(f.root, FIRST, signal(), (...event) => events.push(event), f.options);
  assert.deepEqual(registration, { command: process.execPath, args: ['synthetic-pi.js'], agentDir: f.agentDir });
  assert.deepEqual(await f.get('auth.json'), { ...otherAuth, 'kimi-coding': { type: 'api_key', key: FIRST } });
  assert.deepEqual(await f.get('models.json'), { ...otherModels, providers: { ...otherModels.providers, 'kimi-coding': { ...otherModels.providers['kimi-coding'], baseUrl: BASE_URL } } });
  const status = await inspectNativeKimiPi(f.root, signal(), f.options);
  assert.deepEqual(status, { installed: true, registration, profile: 'ready', hasCredential: true, canReplaceKey: true });
  assert.equal(JSON.stringify({ status, registration, events }).includes('sk-kimi-'), false);
  const ownerFiles = await readdir(f.root);
  assert.equal(ownerFiles.length, 1);
  assert.equal((await readFile(join(f.root, ownerFiles[0]), 'utf8')).includes(FIRST), false);
  if (process.platform !== 'win32') {
    for (const name of ['models.json', 'auth.json']) assert.equal((await stat(join(f.agentDir, name))).mode & 0o777, 0o600);
  }
});

test('existing API key, OAuth and native model/environment credentials stay byte for byte', async t => {
  for (const credential of [{ type: 'api_key', key: 'existing-key' }, { type: 'oauth', refresh: 'oauth-refresh', access: 'oauth-access', expires: 123 }]) {
    const f = await fixture(t);
    await f.put('auth.json', { 'kimi-coding': credential, other: { type: 'api_key', key: 'other' } });
    await f.put('models.json', { providers: { 'kimi-coding': { baseUrl: BASE_URL } } });
    const authBefore = await readFile(join(f.agentDir, 'auth.json'), 'utf8');
    const modelsBefore = await readFile(join(f.agentDir, 'models.json'), 'utf8');
    await prepareNativeKimiPi(f.root, FIRST, signal(), undefined, f.options);
    assert.equal(await readFile(join(f.agentDir, 'auth.json'), 'utf8'), authBefore);
    assert.equal(await readFile(join(f.agentDir, 'models.json'), 'utf8'), modelsBefore);
    assert.equal((await inspectNativeKimiPi(f.root, signal(), f.options)).canReplaceKey, false);
    await assert.rejects(prepareNativeKimiPi(f.root, SECOND, signal(), undefined, { ...f.options, replaceKey: true }), /PI_NATIVE_PROFILE_CHANGED/);
  }
  const env = await fixture(t);
  await prepareNativeKimiPi(env.root, FIRST, signal(), undefined, { ...env.options, env: { KIMI_API_KEY: 'synthetic-env-secret' } });
  await assert.rejects(stat(env.agentDir), { code: 'ENOENT' });
  const configured = await fixture(t);
  await configured.put('models.json', { providers: { 'kimi-coding': { apiKey: '!native-command', baseUrl: BASE_URL } } });
  const before = await readFile(join(configured.agentDir, 'models.json'), 'utf8');
  await prepareNativeKimiPi(configured.root, FIRST, signal(), undefined, configured.options);
  assert.equal(await readFile(join(configured.agentDir, 'models.json'), 'utf8'), before);
  await assert.rejects(stat(join(configured.agentDir, 'auth.json')), { code: 'ENOENT' });
});

test('only the last owned Kimi key is replaceable, unrelated auth additions do not invalidate it', async t => {
  const f = await fixture(t);
  await prepareNativeKimiPi(f.root, FIRST, signal(), undefined, f.options);
  await f.put('auth.json', { ...await f.get('auth.json'), later: { type: 'api_key', key: 'added-later' } });
  assert.equal((await inspectNativeKimiPi(f.root, signal(), f.options)).canReplaceKey, true);
  await prepareNativeKimiPi(f.root, SECOND, signal(), undefined, { ...f.options, replaceKey: true });
  assert.equal((await f.get('auth.json'))['kimi-coding'].key, SECOND);
  assert.equal((await f.get('auth.json')).later.key, 'added-later');
  await f.put('auth.json', { ...await f.get('auth.json'), 'kimi-coding': { type: 'api_key', key: 'changed-outside-wizard' } });
  assert.equal((await inspectNativeKimiPi(f.root, signal(), f.options)).canReplaceKey, false);
  await assert.rejects(prepareNativeKimiPi(f.root, FIRST, signal(), undefined, { ...f.options, replaceKey: true }), /PI_NATIVE_PROFILE_CHANGED/);
  assert.equal((await f.get('auth.json'))['kimi-coding'].key, 'changed-outside-wizard');
});

test('a committed key remains owned after interruption before ownership finalization', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareNativeKimiPi(f.root, FIRST, signal(), undefined, { ...f.options,
    beforeWrite: step => { if (step === 'owner') throw new Error('synthetic interruption'); },
  }), /PI_NATIVE_PROFILE_BLOCKED/);
  const status = await inspectNativeKimiPi(f.root, signal(), f.options);
  assert.equal(status.profile, 'ready'); assert.equal(status.canReplaceKey, true);
  const before = await readFile(join(f.agentDir, 'auth.json'), 'utf8');
  await prepareNativeKimiPi(f.root, undefined, signal(), undefined, f.options);
  assert.equal(await readFile(join(f.agentDir, 'auth.json'), 'utf8'), before);
  await prepareNativeKimiPi(f.root, SECOND, signal(), undefined, { ...f.options, replaceKey: true });
  assert.equal((await f.get('auth.json'))['kimi-coding'].key, SECOND);
});

test('interruption between models and auth preserves old data and retries safely', async t => {
  const f = await fixture(t);
  await f.put('auth.json', { other: { type: 'api_key', key: 'other' } });
  await assert.rejects(prepareNativeKimiPi(f.root, FIRST, signal(), undefined, { ...f.options,
    beforeWrite: step => { if (step === 'auth') throw new Error('synthetic interruption'); },
  }), /PI_NATIVE_PROFILE_BLOCKED/);
  assert.deepEqual(await f.get('auth.json'), { other: { type: 'api_key', key: 'other' } });
  assert.equal((await inspectNativeKimiPi(f.root, signal(), f.options)).profile, 'absent');
  await prepareNativeKimiPi(f.root, SECOND, signal(), undefined, f.options);
  assert.equal((await f.get('auth.json'))['kimi-coding'].key, SECOND);
  assert.equal((await f.get('auth.json')).other.key, 'other');
});

test('interrupted owned replacement retains ownership of the old key', async t => {
  const f = await fixture(t);
  await prepareNativeKimiPi(f.root, FIRST, signal(), undefined, f.options);
  await assert.rejects(prepareNativeKimiPi(f.root, SECOND, signal(), undefined, { ...f.options, replaceKey: true,
    beforeWrite: step => { if (step === 'auth') throw new Error('synthetic interruption'); },
  }), /PI_NATIVE_PROFILE_BLOCKED/);
  assert.equal((await f.get('auth.json'))['kimi-coding'].key, FIRST);
  assert.equal((await inspectNativeKimiPi(f.root, signal(), f.options)).canReplaceKey, true);
});

test('invalid JSON, symlinks and foreign Kimi base URLs block without repairs', async t => {
  for (const kind of ['json', 'auth-symlink', 'models-symlink', 'directory-symlink', 'foreign-url', 'invalid-key-record']) {
    const f = await fixture(t);
    await mkdir(f.agentDir);
    const external = join(f.parent, 'external.json'); await writeFile(external, '{}');
    if (kind === 'json') await writeFile(join(f.agentDir, 'auth.json'), 'user text');
    if (kind === 'auth-symlink' || kind === 'models-symlink') await symlink(external, join(f.agentDir, kind.startsWith('auth') ? 'auth.json' : 'models.json'));
    if (kind === 'directory-symlink') { await rm(f.agentDir, { recursive: true }); await symlink(f.parent, f.agentDir); }
    if (kind === 'foreign-url') await f.put('models.json', { providers: { 'kimi-coding': { baseUrl: 'https://other.example' } } });
    if (kind === 'invalid-key-record') await f.put('auth.json', { 'kimi-coding': { type: 'api_key' } });
    assert.equal((await inspectNativeKimiPi(f.root, signal(), f.options)).profile, 'blocked', kind);
    await assert.rejects(prepareNativeKimiPi(f.root, FIRST, signal(), undefined, f.options), /PI_NATIVE_PROFILE_BLOCKED/, kind);
    assert.equal(await readFile(external, 'utf8'), '{}');
    if (kind === 'json') assert.equal(await readFile(join(f.agentDir, 'auth.json'), 'utf8'), 'user text');
    if (kind === 'foreign-url') assert.equal((await f.get('models.json')).providers['kimi-coding'].baseUrl, 'https://other.example');
  }
});

test('preparation coordinates with native auth locks and concurrent wizard operations', async t => {
  const f = await fixture(t);
  await f.put('auth.json', {});
  const releaseNative = await lockfile.lock(join(f.agentDir, 'auth.json'));
  try { await assert.rejects(prepareNativeKimiPi(f.root, FIRST, signal(), undefined, f.options), /PI_NATIVE_BUSY/); }
  finally { await releaseNative(); }
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  let proceed!: () => void; const gate = new Promise<void>(resolve => { proceed = resolve; });
  const first = prepareNativeKimiPi(f.root, FIRST, signal(), undefined, { ...f.options, beforeWrite: async step => {
    if (step === 'models') { enter(); await gate; }
  } });
  await entered;
  try { await assert.rejects(prepareNativeKimiPi(f.root, SECOND, signal(), undefined, f.options), /PI_NATIVE_BUSY/); }
  finally { proceed(); }
  await first;
  assert.equal((await f.get('auth.json'))['kimi-coding'].key, FIRST);
});

test('manual edits are preserved and unrelated concurrent auth additions merge', async t => {
  const f = await fixture(t);
  await f.put('models.json', { original: true });
  await assert.rejects(prepareNativeKimiPi(f.root, FIRST, signal(), undefined, { ...f.options, beforeWrite: async step => {
    if (step === 'models') await f.put('models.json', { manual: true });
  } }), /PI_NATIVE_PROFILE_CHANGED/);
  assert.deepEqual(await f.get('models.json'), { manual: true });
  await prepareNativeKimiPi(f.root, FIRST, signal(), undefined, { ...f.options, beforeWrite: async step => {
    if (step === 'auth') await f.put('auth.json', { other: { type: 'api_key', key: 'concurrent-other' } });
  } });
  assert.equal((await f.get('auth.json')).other.key, 'concurrent-other');
  await assert.rejects(prepareNativeKimiPi(f.root, SECOND, signal(), undefined, { ...f.options, replaceKey: true, beforeWrite: async step => {
    if (step === 'auth') await f.put('auth.json', { 'kimi-coding': { type: 'api_key', key: 'manual-change' } });
  } }), /PI_NATIVE_PROFILE_CHANGED/);
  assert.equal((await f.get('auth.json'))['kimi-coding'].key, 'manual-change');
});

test('native discovery distinguishes absent, old and unrecognized CLIs without installing', async t => {
  const f = await fixture(t);
  const absent = { ...f.options, resolveRegistration: async () => null };
  assert.equal((await inspectNativeKimiPi(f.root, signal(), absent)).installed, false);
  await assert.rejects(prepareNativeKimiPi(f.root, FIRST, signal(), undefined, absent), /PI_NATIVE_NOT_INSTALLED/);
  for (const value of ['1.5.0', '0.99.99', 'unexpected binary', '1.5.2-extra']) {
    const result = await inspectNativeKimiPi(f.root, signal(), { ...f.options, probeVersion: async () => value });
    assert.equal(result.installed, true); assert.equal(result.profile, 'blocked'); assert.equal(result.registration, null);
  }
  assert.equal((await inspectNativeKimiPi(f.root, signal(), { ...f.options, probeVersion: async () => '1.5.1' })).profile, 'absent');
  await assert.rejects(stat(f.agentDir), { code: 'ENOENT' });
});

test('actual process probe preserves prefix arguments and never puts keys in argv or logs', async t => {
  const f = await fixture(t);
  const cli = join(f.parent, 'pi fixture.cjs');
  await writeFile(cli, `if (process.argv.slice(2).join(' ') !== 'prefix --version') process.exit(12); console.log('1.5.2');`);
  const options = { ...f.options, probeVersion: undefined,
    resolveRegistration: async (agentDir: string) => ({ command: process.execPath, args: [cli, 'prefix'], agentDir }),
  };
  const events: unknown[] = [];
  const registration = await prepareNativeKimiPi(f.root, FIRST, signal(), (...event) => events.push(event), options);
  assert.deepEqual(registration.args, [cli, 'prefix']);
  assert.equal(JSON.stringify({ registration, events }).includes(FIRST), false);
});

test('missing key and cancellation leave fresh native profiles untouched, failed probes never expose output', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareNativeKimiPi(f.root, undefined, signal(), undefined, f.options), /PI_NATIVE_KEY_REQUIRED/);
  await assert.rejects(stat(f.agentDir), { code: 'ENOENT' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(prepareNativeKimiPi(f.root, FIRST, abort.signal, undefined, f.options), { name: 'AbortError' });
  await assert.rejects(stat(f.agentDir), { code: 'ENOENT' });
  const cli = join(f.parent, 'failed-probe.cjs');
  await writeFile(cli, `console.log('sk-kimi-synthetic-from-broken-cli'); console.error('synthetic-private-stderr'); process.exit(1);`);
  const status = await inspectNativeKimiPi(f.root, signal(), { ...f.options, probeVersion: undefined,
    resolveRegistration: async agentDir => ({ command: process.execPath, args: [cli], agentDir }),
  });
  assert.equal(status.profile, 'blocked');
  assert.equal(JSON.stringify(status).includes('synthetic-from-broken-cli'), false);
  assert.equal(JSON.stringify(status).includes('synthetic-private-stderr'), false);
});


test('explicit native repair restores only owned Kimi transport and preserves auth and unrelated providers', async t => {
  const f = await fixture(t);
  await prepareNativeKimiPi(f.root, FIRST, signal(), undefined, f.options);
  await f.put('models.json', { providers: { 'kimi-coding': { baseUrl: 'https://broken.invalid', models: [{ id: 'custom' }] }, other: { baseUrl: 'https://other.test' } } });
  const auth = await readFile(join(f.agentDir, 'auth.json'), 'utf8');
  const inspected = await inspectNativeKimiPi(f.root, signal(), f.options);
  assert.equal(inspected.needsRepair, true); assert.equal(inspected.hasCredential, true);
  await prepareNativeKimiPi(f.root, undefined, signal(), undefined, f.options);
  assert.equal(await readFile(join(f.agentDir, 'auth.json'), 'utf8'), auth);
  assert.deepEqual((await f.get('models.json')).providers, { 'kimi-coding': { baseUrl: BASE_URL, models: [{ id: 'custom' }] }, other: { baseUrl: 'https://other.test' } });
  assert.equal((await inspectNativeKimiPi(f.root, signal(), f.options)).needsRepair, undefined);
});
