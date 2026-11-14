import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverWindowsNode, ensureWindowsNode, runWindowsNodeCommand, windowsNodeCandidates, type WindowsNodeOptions } from '../windows-node';

const signal = () => new AbortController().signal;
const runtime = { executable: 'C:\\Program Files\\nodejs\\node.exe', npmCli: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', version: '26.13.1' };
const absent = { runtime: null, occupied: false };
const fixture = (overrides: WindowsNodeOptions = {}): WindowsNodeOptions => ({ platform: 'win32', refresh: async () => {},
  discover: async () => absent, resolveWinget: () => 'C:\\Users\\Тест Пользователь\\WindowsApps\\winget.exe',
  run: async () => { throw new Error('unexpected install'); }, ...overrides });

test('non-Windows and existing or older standalone installations never run WinGet', async () => {
  assert.equal(await ensureWindowsNode(signal(), undefined, fixture({ platform: 'linux', discover: async () => { throw new Error('unexpected discovery'); } })), null);
  assert.deepEqual(await ensureWindowsNode(signal(), undefined, fixture({ discover: async () => ({ runtime, occupied: true }) })), runtime);
  assert.equal(await ensureWindowsNode(signal(), undefined, fixture({ discover: async () => ({ runtime: null, occupied: true }) })), null);
});

test('fresh Windows install uses the LTS package, no upgrade/version pin or shell, and verifies discovery after refresh', async () => {
  const events: string[] = []; let refreshed = 0; let installed = false;
  const result = await ensureWindowsNode(signal(), (step, outcome) => events.push(step + ':' + outcome), fixture({
    refresh: async () => { refreshed++; },
    discover: async () => { assert.ok(refreshed > 0); return installed ? { runtime, occupied: true } : absent; },
    run: async (executable, args) => {
      assert.equal(executable, 'C:\\Users\\Тест Пользователь\\WindowsApps\\winget.exe');
      assert.deepEqual(args, ['install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--source', 'winget', '--no-upgrade', '--silent',
        '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity']);
      installed = true; return { code: 0, output: '' };
    },
  }));
  assert.deepEqual(result, runtime); assert.equal(refreshed, 2);
  assert.deepEqual(events, ['runtime-install:start', 'runtime-install:success']);
});

test('installer exit status alone never determines success; missing WinGet allows fallback', async () => {
  for (const code of [0, 1, -1978335189]) for (const available of [false, true]) {
    let discoveries = 0;
    const result = await ensureWindowsNode(signal(), undefined, fixture({
      discover: async () => ++discoveries > 1 && available ? { runtime, occupied: true } : absent,
      run: async () => ({ code, output: 'this is not evidence' }),
    }));
    assert.deepEqual(result, available ? runtime : null);
  }
  assert.equal(await ensureWindowsNode(signal(), undefined, fixture({ resolveWinget: () => null })), null);
});

test('cancelled or timed-out installation never silently starts a fallback', async () => {
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(ensureWindowsNode(aborted.signal, undefined, fixture()), { name: 'AbortError' });
  for (const failure of [Object.assign(new Error('installer pending'), { name: 'TimeoutError' }), Object.assign(new Error('installer pending'), { cleanupPending: true })]) {
    let discoveries = 0;
    await assert.rejects(ensureWindowsNode(signal(), undefined, fixture({
      discover: async () => { discoveries++; return absent; }, run: async () => { throw failure; },
    })), error => error === failure);
    assert.equal(discoveries, 1);
  }
  const controller = new AbortController();
  await assert.rejects(ensureWindowsNode(controller.signal, undefined, fixture({ run: async () => {
    controller.abort(); throw controller.signal.reason;
  } })), { name: 'AbortError' });
});

test('MSI discovery preserves literal Unicode/spaces and executes both node and npm before accepting a runtime', async () => {
  const env = { programfiles: 'D:\\Программы пользователя', ProgramW6432: 'D:\\Программы пользователя', 'ProgramFiles(x86)': 'relative' };
  const executable = 'D:\\Программы пользователя\\nodejs\\node.exe';
  assert.deepEqual(windowsNodeCandidates(env), [executable]);
  const calls: string[][] = [];
  const run: typeof runWindowsNodeCommand = async (file, args) => {
    if (file !== executable) throw new Error('not this fixture');
    calls.push(args);
    return { code: 0, output: args[0] === '-p' ? JSON.stringify({ version: '28.0.0', electron: false }) : '13.1.0\n' };
  };
  const found = await discoverWindowsNode(signal(), env, run);
  assert.deepEqual(found.runtime, { executable, npmCli: 'D:\\Программы пользователя\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', version: '28.0.0' });
  assert.deepEqual(calls.at(-1), [found.runtime!.npmCli, '--version']);
  const incomplete = await discoverWindowsNode(signal(), env, async (file, args) => {
    if (file !== executable) throw new Error('not this fixture');
    return args[0] === '-p' ? { code: 0, output: '{"version":"26.0.0","electron":false}' } : { code: 1, output: '' };
  });
  assert.deepEqual(incomplete, { runtime: null, occupied: true });
  for (const electron of [false, true]) {
    let npmCalled = false;
    const older = await discoverWindowsNode(signal(), env, async (file, args) => {
      if (file !== executable) throw new Error('not this fixture');
      if (args[0] !== '-p') npmCalled = true;
      return { code: 0, output: JSON.stringify({ version: '20.19.0', electron }) };
    });
    assert.deepEqual(older, { runtime: null, occupied: !electron });
    assert.equal(npmCalled, false);
  }
});

test('command runner executes real argv, bounds output and rejects timeout and cancellation', async () => {
  const value = await runWindowsNodeCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'Тест $() with spaces'], signal(), { capture: true, timeoutMs: 5000 });
  assert.deepEqual(value, { code: 0, output: 'Тест $() with spaces' });
  const bounded = await runWindowsNodeCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(20000));process.stderr.write("private");'], signal(), { capture: true, timeoutMs: 5000 });
  assert.equal(bounded.output.length, 8192); assert.equal(bounded.output.includes('private'), false);
  await assert.rejects(runWindowsNodeCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], signal(), { timeoutMs: 50 }), { name: 'TimeoutError' });
  const controller = new AbortController();
  const pending = runWindowsNodeCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], controller.signal, { timeoutMs: 5000 });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
});
