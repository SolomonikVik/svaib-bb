import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { installKimiAdapter } from '../kimi-adapter-install';
import { inspectKimiPi, prepareKimiPi, kimiPiCli, KIMI_PI_PACKAGE } from '../kimi-pi-host';
import { kimiPiHostMethods } from '../kimi-pi-contract';

const execute = promisify(execFile);
const signal = () => new AbortController().signal;
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const parent = await mkdtemp(join(tmpdir(), 'kimi-pi-host-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, root: join(parent, 'managed'), externalAgentDir: join(parent, 'external'), externalEnvNames: [] };
}
const ensureRuntime: NonNullable<Parameters<typeof prepareKimiPi>[4]>['ensureRuntime'] = async (_root, _signal, options) => {
  assert.equal(options?.forceManaged, true);
  return { executable: process.execPath, npmCli: '/synthetic/npm-cli.js', version: '22.23.4' };
};
async function fixtureNpm(_executable: string, args: string[]) {
  assert.equal(args.includes('--ignore-scripts'), true);
  assert.equal(args.includes(KIMI_PI_PACKAGE), true);
  assert.equal(args.some(arg => arg.includes('sk-kimi-')), false);
  const prefix = args[args.indexOf('--prefix') + 1];
  const packageRoot = join(prefix, 'node_modules', '@earendil-works', 'pi-coding-agent');
  await mkdir(join(packageRoot, 'dist', 'bundle'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.5.2' }));
  await writeFile(join(packageRoot, 'dist', 'bundle', 'cli.js'), `
    if (process.argv.includes('--version')) console.log('1.5.2');
    else console.log(JSON.stringify({args:process.argv.slice(2),agentDir:process.env.PI_CODING_AGENT_DIR,
      nodeOnPath:(process.env.Path || process.env.PATH).split(require('node:path').delimiter)[0]}));
  `);
}
const install: NonNullable<Parameters<typeof prepareKimiPi>[4]>['install'] = (root, executable, args, abort, log, options) =>
  installKimiAdapter(root, executable, args, abort, log, { ...options, run: fixtureNpm });

test('native Pi launcher keeps keys private, profile consistent and Node available without global PATH', async t => {
  const paths = await fixture(t);
  const events: unknown[] = [];
  const registration = await prepareKimiPi(paths.root, 'sk-kimi-first-synthetic', signal(), (...event) => events.push(event), { ...paths, ensureRuntime, install });
  assert.equal(JSON.stringify({ registration, events }).includes('sk-kimi-'), false);
  assert.equal((await inspectKimiPi(paths.root, signal(), paths)).profile, 'ready');
  const result = await execute(registration.command, [...registration.args, '--mode', 'rpc'], { env: { PATH: '', PI_CODING_AGENT_DIR: paths.externalAgentDir } });
  assert.deepEqual(JSON.parse(result.stdout), { args: ['--mode', 'rpc'], agentDir: registration.agentDir, nodeOnPath: dirname(process.execPath) });
  const auth = JSON.parse(await readFile(join(registration.agentDir, 'auth.json'), 'utf8'));
  assert.deepEqual(auth, { 'kimi-coding': { type: 'api_key', key: 'sk-kimi-first-synthetic' } });
  assert.equal(JSON.parse(await readFile(join(registration.agentDir, 'models.json'), 'utf8')).providers['kimi-coding'].baseUrl, 'https://api.kimi.ai/coding/v1');
  if (process.platform !== 'win32') {
    for (const name of ['auth.json', 'models.json']) assert.equal((await stat(join(registration.agentDir, name))).mode & 0o777, 0o600);
  }
  assert.equal(kimiPiHostMethods.kimiPiPrepare.input.safeParse({ apiKey: 'other-service-key' }).success, false);
});

test('interrupted npm install resumes from committed key and never asks for or changes it again', async t => {
  const paths = await fixture(t);
  const abort = new AbortController();
  await assert.rejects(prepareKimiPi(paths.root, 'sk-kimi-retained-synthetic', abort.signal, undefined, {
    ...paths, ensureRuntime, install: async () => { abort.abort(); throw abort.signal.reason; },
  }), { name: 'AbortError' });
  const first = await inspectKimiPi(paths.root, signal(), paths);
  assert.equal(first.profile, 'partial'); assert.equal(first.needsKey, false);
  const authBefore = await readFile(join(paths.root, 'agent', 'auth.json'), 'utf8');
  const ready = await prepareKimiPi(paths.root, undefined, signal(), undefined, { ...paths, ensureRuntime, install });
  assert.deepEqual(ready, first.registration);
  assert.equal(await readFile(join(paths.root, 'agent', 'auth.json'), 'utf8'), authBefore);
  assert.equal((await inspectKimiPi(paths.root, signal(), paths)).profile, 'ready');
});

test('an interruption between verified staging and publication keeps enough ownership evidence to resume', async t => {
  const paths = await fixture(t);
  await assert.rejects(prepareKimiPi(paths.root, 'sk-kimi-retained-synthetic', signal(), undefined, {
    ...paths, ensureRuntime,
    install: (root, executable, args, abort, log, options) => installKimiAdapter(root, executable, args, abort, log, {
      run: fixtureNpm,
      verify: async (...verifyArgs) => { await options!.verify!(...verifyArgs); throw new Error('synthetic interruption before publish'); },
    }),
  }), /synthetic interruption/);
  const partial = await inspectKimiPi(paths.root, signal(), paths);
  assert.equal(partial.profile, 'partial'); assert.equal(partial.needsKey, false);
  await prepareKimiPi(paths.root, undefined, signal(), undefined, { ...paths, ensureRuntime, install });
  assert.equal((await inspectKimiPi(paths.root, signal(), paths)).profile, 'ready');
});

test('owned key replacement is explicit, stable in BB and preserves later package/MCP settings', async t => {
  const paths = await fixture(t);
  const first = await prepareKimiPi(paths.root, 'sk-kimi-first-synthetic', signal(), undefined, { ...paths, ensureRuntime, install });
  await writeFile(join(first.agentDir, 'settings.json'), JSON.stringify({ packages: ['retained-svaib-package'] }));
  await assert.rejects(prepareKimiPi(paths.root, 'sk-kimi-second-synthetic', signal(), undefined, { ...paths, ensureRuntime, install }), /Заменить ключ/);
  const second = await prepareKimiPi(paths.root, 'sk-kimi-second-synthetic', signal(), undefined, { ...paths, ensureRuntime, install, replaceKey: true });
  assert.deepEqual(second, first);
  assert.equal(JSON.parse(await readFile(join(second.agentDir, 'auth.json'), 'utf8'))['kimi-coding'].key, 'sk-kimi-second-synthetic');
  assert.deepEqual(JSON.parse(await readFile(join(second.agentDir, 'settings.json'), 'utf8')), { packages: ['retained-svaib-package'] });
});

test('killed auth commit is recovered from journal without another key or a second profile', async t => {
  const paths = await fixture(t);
  const registration = await prepareKimiPi(paths.root, 'sk-kimi-first-synthetic', signal(), undefined, { ...paths, ensureRuntime, install });
  const ownerFile = join(paths.root, 'setup-owner.json'); const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
  const auth = JSON.stringify({ 'kimi-coding': { type: 'api_key', key: 'sk-kimi-committed-synthetic' } }, null, 2) + '\n';
  owner.pendingAuthHash = createHash('sha256').update(auth).digest('hex');
  await writeFile(ownerFile, JSON.stringify(owner)); await writeFile(join(registration.agentDir, 'auth.json'), auth);
  const pending = await inspectKimiPi(paths.root, signal(), paths);
  assert.equal(pending.profile, 'partial'); assert.equal(pending.needsKey, false);
  assert.deepEqual(await prepareKimiPi(paths.root, undefined, signal(), undefined, { ...paths, ensureRuntime, install }), registration);
  assert.equal((await inspectKimiPi(paths.root, signal(), paths)).profile, 'ready');
  assert.equal(await readFile(join(registration.agentDir, 'auth.json'), 'utf8'), auth);
});

test('uncommitted key journal asks for key while leaving the last working credential intact', async t => {
  const paths = await fixture(t);
  const registration = await prepareKimiPi(paths.root, 'sk-kimi-first-synthetic', signal(), undefined, { ...paths, ensureRuntime, install });
  const authBefore = await readFile(join(registration.agentDir, 'auth.json'), 'utf8');
  const ownerFile = join(paths.root, 'setup-owner.json'); const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
  owner.pendingAuthHash = createHash('sha256').update('never-committed').digest('hex');
  await writeFile(ownerFile, JSON.stringify(owner));
  const pending = await inspectKimiPi(paths.root, signal(), paths);
  assert.equal(pending.profile, 'partial'); assert.equal(pending.needsKey, true);
  await assert.rejects(prepareKimiPi(paths.root, undefined, signal(), undefined, { ...paths, ensureRuntime, install }), /Введи ключ/);
  assert.equal(await readFile(join(registration.agentDir, 'auth.json'), 'utf8'), authBefore);
});

test('foreign files and links are preserved while owned generated model settings are repaired', async t => {
  const paths = await fixture(t);
  await mkdir(paths.root); await writeFile(join(paths.root, 'notes.txt'), 'keep');
  assert.equal((await inspectKimiPi(paths.root, signal(), paths)).profile, 'blocked');
  await assert.rejects(prepareKimiPi(paths.root, 'sk-kimi-synthetic', signal(), undefined, { ...paths, ensureRuntime, install }));
  assert.equal(await readFile(join(paths.root, 'notes.txt'), 'utf8'), 'keep');
  const owned = join(paths.parent, 'owned');
  const registration = await prepareKimiPi(owned, 'sk-kimi-original-synthetic', signal(), undefined, { ...paths, ensureRuntime, install });
  await writeFile(join(registration.agentDir, 'models.json'), '{"providers":{"other":{}}}');
  await prepareKimiPi(owned, undefined, signal(), undefined, { ...paths, ensureRuntime, install });
  assert.deepEqual(JSON.parse(await readFile(join(registration.agentDir, 'models.json'), 'utf8')).providers.other, {});
  assert.equal(JSON.parse(await readFile(join(registration.agentDir, 'auth.json'), 'utf8'))['kimi-coding'].key, 'sk-kimi-original-synthetic');
  if (process.platform !== 'win32') {
    const linked = join(paths.parent, 'linked'); await symlink(owned, linked);
    assert.equal((await inspectKimiPi(linked, signal(), paths)).profile, 'blocked');
    await assert.rejects(prepareKimiPi(linked, 'sk-kimi-synthetic', signal(), undefined, { ...paths, ensureRuntime, install }));
  }
});

test('external Pi profile detection reads metadata only and never folds its credentials into managed profile', async t => {
  const paths = await fixture(t);
  assert.equal((await inspectKimiPi(paths.root, signal(), paths)).hasExternalProfile, false);
  assert.equal((await inspectKimiPi(paths.root, signal(), { ...paths, externalEnvNames: ['KIMI_API_KEY'] })).hasExternalProfile, true);
  await mkdir(join(paths.externalAgentDir, 'sessions'), { recursive: true });
  await writeFile(join(paths.externalAgentDir, 'auth.json'), '{}\n');
  assert.equal((await inspectKimiPi(paths.root, signal(), paths)).hasExternalProfile, false);
  await writeFile(join(paths.externalAgentDir, 'auth.json'), 'intentionally-invalid-private-file');
  const inspected = await inspectKimiPi(paths.root, signal(), paths);
  assert.equal(inspected.hasExternalProfile, true);
  assert.equal(JSON.stringify(inspected).includes('intentionally-invalid'), false);
  const registration = await prepareKimiPi(paths.root, 'sk-kimi-synthetic', signal(), undefined, { ...paths, ensureRuntime, install });
  assert.equal(await readFile(join(paths.externalAgentDir, 'auth.json'), 'utf8'), 'intentionally-invalid-private-file');
  assert.notEqual(registration.agentDir, paths.externalAgentDir);
});

test('missing and corrupt owned Pi runtime repair and launch without changing credentials', async t => {
  const paths = await fixture(t);
  await prepareKimiPi(paths.root, 'sk-kimi-synthetic', signal(), undefined, { ...paths, ensureRuntime, install });
  const authBefore = await readFile(join(paths.root, 'agent', 'auth.json'), 'utf8');
  await rm(join(paths.root, 'runtime'), { recursive: true });
  assert.equal((await inspectKimiPi(paths.root, signal(), paths)).profile, 'partial');
  await prepareKimiPi(paths.root, undefined, signal(), undefined, { ...paths, ensureRuntime, install });
  assert.equal(await readFile(join(paths.root, 'agent', 'auth.json'), 'utf8'), authBefore);
  await writeFile(kimiPiCli(paths.root), 'throw new Error("changed runtime")');
  assert.equal((await inspectKimiPi(paths.root, signal(), paths)).profile, 'partial');
  const repaired = await prepareKimiPi(paths.root, undefined, signal(), undefined, { ...paths, ensureRuntime, install });
  assert.equal(await readFile(join(paths.root, 'agent', 'auth.json'), 'utf8'), authBefore);
  const launched = await execute(repaired.command, [...repaired.args, '--mode', 'rpc']);
  assert.deepEqual(JSON.parse(launched.stdout).args, ['--mode', 'rpc']);
});

test('profile mutations reject a second live installer instead of racing credential/runtime publication', async t => {
  const paths = await fixture(t);
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void; const wait = new Promise<void>(resolve => { finish = resolve; });
  const first = prepareKimiPi(paths.root, 'sk-kimi-first-synthetic', signal(), undefined, { ...paths, ensureRuntime,
    install: async (...args) => { entered(); await wait; return install!(...args); } });
  await started;
  try { await assert.rejects(prepareKimiPi(paths.root, 'sk-kimi-second-synthetic', signal(), undefined, { ...paths, ensureRuntime, install }), /уже идёт/); }
  finally { finish(); }
  const registration = await first;
  assert.equal(JSON.parse(await readFile(join(registration.agentDir, 'auth.json'), 'utf8'))['kimi-coding'].key, 'sk-kimi-first-synthetic');
});
