import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeCommand, spawnNativeCommand } from '../native-command';
import { withCodexHooks } from '../experiments/account-prototype/hook-native';

test('native binaries keep literal argv and batch launchers use only a bounded cmd layer', () => {
  const args = ['a&b', 'кириллица с пробелами', '"quoted"', '%PATH%', '!bang!', 'tail\\'];
  assert.deepEqual(nativeCommand('C:\\Codex\\codex.exe', args, 'win32').args, args);
  assert.deepEqual(nativeCommand('/bin/codex', args, 'linux').args, args);
  const batch = nativeCommand('C:\\Users\\Тест Пользователь\\codex.cmd', args, 'win32');
  assert.match(batch.executable, /System32\\cmd.exe$/); assert.equal(batch.windowsVerbatimArguments, true);
  assert.deepEqual(batch.args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
  assert.throws(() => nativeCommand('C:\\codex.cmd', ['bad\nargument'], 'win32'));
});

test('native child preserves stdio, literal argv and exit status on the current OS', async () => {
  const args = ['a&b', 'кириллица с пробелами', '"quoted"', '%PATH%', '!bang!', 'tail\\', ''];
  const child = spawnNativeCommand(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>{console.log(JSON.stringify(process.argv.slice(1)));process.exitCode=23})', ...args], { stdio: ['pipe', 'pipe', 'ignore'] });
  let output = ''; child.stdout!.on('data', chunk => output += String(chunk)); child.stdin!.end();
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 23); assert.deepEqual(JSON.parse(output), args);
});

test('hook control waits for actual EOF shutdown before returning and releasing its cwd', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'svaib process exit ')); t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex'), marker = join(root, 'exited');
  await writeFile(executable, '#!/usr/bin/env node\n' +
    'const rl=require("node:readline").createInterface({input:process.stdin});rl.on("line",line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({id:m.id,result:{ok:true}}))});' +
    `rl.on("close",()=>setTimeout(()=>{require("node:fs").writeFileSync(${JSON.stringify(marker)},"clean");process.exit(0)},150));`, { mode: 0o700 });
  const old = process.env.CODEX_HOME; delete process.env.CODEX_HOME;
  try {
    assert.deepEqual(await withCodexHooks({ executable, cwd: root }, AbortSignal.timeout(10_000), rpc => rpc('probe', {}), root), { ok: true });
    assert.equal(await readFile(marker, 'utf8'), 'clean');
  } finally { if (old !== undefined) process.env.CODEX_HOME = old; }
});

test('real Windows .cmd and .bat launchers preserve argv and Codex app-server stdio', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'svaib launcher Кириллица с пробелами ')); t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'argv.cjs');
  await writeFile(script, 'process.stdin.resume();process.stdin.on("end",()=>{console.log(JSON.stringify(process.argv.slice(2)));process.exitCode=23})');
  const args = ['a&b', 'кириллица с пробелами', '"quoted"', '%PATH%', '!bang!', 'tail\\', ''];
  for (const relative of ['codex.cmd', 'codex.bat', 'node_modules/.bin/codex.cmd']) {
    const launcher = join(root, relative); await mkdir(join(launcher, '..'), { recursive: true });
    await writeFile(join(launcher, '..', 'probe.cjs'), 'process.stdin.resume();process.stdin.on("end",()=>{console.log(JSON.stringify(process.argv.slice(2)));process.exitCode=23})');
    await writeFile(launcher, `@echo off\r\n"${process.execPath}" "%~dp0probe.cjs" %*\r\n`);
    const child = spawnNativeCommand(launcher, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = ''; child.stdout!.on('data', chunk => output += String(chunk)); child.stdin!.end();
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 23, relative); assert.deepEqual(JSON.parse(output), args, relative);
  }
  const rpc = join(root, 'rpc.cjs'), launcher = join(root, 'rpc.cmd');
  const marker = join(root, 'exited');
  await writeFile(rpc, 'const rl=require("node:readline").createInterface({input:process.stdin});rl.on("line",line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({id:m.id,result:{ok:true}}))});' +
    `rl.on("close",()=>setTimeout(()=>{require("node:fs").writeFileSync(${JSON.stringify(marker)},"clean");process.exit(0)},150));`);
  await writeFile(launcher, `@echo off\r\n"${process.execPath}" "%~dp0rpc.cjs" %*\r\n`);
  const old = process.env.CODEX_HOME; delete process.env.CODEX_HOME;
  try {
    assert.deepEqual(await withCodexHooks({ executable: launcher, cwd: root }, AbortSignal.timeout(10_000), rpc => rpc('probe', {}), root), { ok: true });
    assert.equal(await readFile(marker, 'utf8'), 'clean');
  }
  finally { if (old !== undefined) process.env.CODEX_HOME = old; }
});
