import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { experimental_hostToolchain as toolchain } from '@get-bb/plugin-sdk/process';

const VERSION = '22.23.4';
const jobs = new Map<string, Promise<KimiRuntime>>();
export type KimiRuntime = { executable: string; npmCli: string; version: string };

async function probe(executable: string, signal: AbortSignal): Promise<string | null> {
  return new Promise(resolve => {
    const child = spawn(executable, ['-p', 'JSON.stringify({version:process.versions.node,electron:!!process.versions.electron})'],
      { signal, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 5000);
    child.stdout.on('data', data => { output += String(data); if (output.length > 4096) child.kill(); });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', code => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(output);
        resolve(code === 0 && !value.electron && Number(value.version?.split('.')[0]) >= 22 ? value.version : null);
      } catch { resolve(null); }
    });
  });
}

/** Uses BB's supported toolchain API, including its npm; never assumes PATH node exists. */
export async function existingKimiRuntime(signal: AbortSignal): Promise<KimiRuntime | null> {
  try {
    const pair = toolchain.npmCli();
    if (pair) {
      const version = await probe(pair.node, signal);
      if (version) return { executable: pair.node, npmCli: pair.cli, version };
    }
  } catch { /* A desktop Electron runtime is not necessarily a standalone Node. */ }
  return null;
}

export function nodeArchive(platform: string, arch: string) {
  const os = platform === 'win32' ? 'win' : platform;
  if (!['win', 'darwin', 'linux'].includes(os) || !['x64', 'arm64'].includes(arch)) throw new Error('Автоматическая установка Node.js недоступна для этой системы. Установи Node.js 22+ и повтори.');
  const directory = `node-v${VERSION}-${os}-${arch}`;
  return { directory, file: directory + (os === 'win' ? '.zip' : '.tar.gz'), executable: os === 'win' ? 'node.exe' : 'bin/node', npm: os === 'win' ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js' };
}

export function nodeExtractCommand(platform: string, archivePath: string, destination: string, environment: NodeJS.ProcessEnv = process.env) {
  if (platform === 'win32') {
    const systemRoot = Object.entries(environment).find(([name]) => name.toLowerCase() === 'systemroot')?.[1] ?? 'C:\\Windows';
    return {
      executable: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:SVAIB_NODE_ARCHIVE, $env:SVAIB_NODE_DESTINATION)'],
      env: { ...environment, SVAIB_NODE_ARCHIVE: archivePath, SVAIB_NODE_DESTINATION: destination },
    };
  }
  return { executable: 'tar', args: ['-xf', archivePath, '-C', destination], env: environment };
}

export function checkedNodeArchive(bytes: Uint8Array, checksums: string, name: string) {
  const line = checksums.split(/\r?\n/).find(line => line.trim().split(/\s+/)[1] === name);
  const expected = line?.trim().split(/\s+/)[0];
  if (!expected || !/^[a-f0-9]{64}$/.test(expected) || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Загрузка Node.js повреждена. Повтори установку.');
}

async function regular(path: string, directory = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('Папка runtime изменена. Существующие файлы сохранены.');
}

async function download(url: string, signal: AbortSignal, limit: number) {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('Не удалось скачать компоненты Node.js. Проверь интернет и повтори.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) throw new Error('Размер загрузки Node.js превышает ожидаемый.');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}

async function managedRuntime(parent: string, signal: AbortSignal): Promise<KimiRuntime> {
  const spec = nodeArchive(process.platform, process.arch);
  const base = join(parent, 'node-runtime'); await mkdir(base, { recursive: true, mode: 0o700 }); await regular(base, true);
  const target = join(base, spec.directory);
  async function saved(): Promise<KimiRuntime | null> {
    try { await regular(target, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    await regular(join(target, 'runtime-owner.json')); await regular(join(target, spec.executable)); await regular(join(target, spec.npm));
    const owner = JSON.parse(await readFile(join(target, 'runtime-owner.json'), 'utf8'));
    if (owner.version !== VERSION || owner.archive !== spec.file || owner.nodeSha256 !== createHash('sha256').update(await readFile(join(target, spec.executable))).digest('hex')) throw new Error('Собственный runtime Node.js изменён. Ничего не перезаписано.');
    const version = await probe(join(target, spec.executable), signal);
    if (!version) throw new Error('Не удалось запустить подготовленный Node.js. Повтори установку.');
    return { executable: join(target, spec.executable), npmCli: join(target, spec.npm), version };
  }
  const current = await saved(); if (current) return current;
  const temp = await mkdtemp(join(base, '.prepare-'));
  try {
    const origin = `https://nodejs.org/dist/v${VERSION}/`;
    const sums = await download(origin + 'SHASUMS256.txt', signal, 128_000);
    const archive = await download(origin + spec.file, signal, 150 * 1024 * 1024);
    checkedNodeArchive(archive, sums.toString('utf8'), spec.file);
    const archivePath = join(temp, spec.file); await writeFile(archivePath, archive);
    const extraction = nodeExtractCommand(process.platform, archivePath, temp);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(extraction.executable, extraction.args,
        { env: extraction.env, signal, shell: false, windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Распаковка Node.js не завершилась. Повтори установку.')); }, 180_000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('Не удалось распаковать Node.js. Установи Node.js 22+ и повтори.')); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Не удалось распаковать Node.js. Повтори установку.')); });
    });
    const prepared = join(temp, spec.directory); await regular(prepared, true); await regular(join(prepared, spec.executable)); await regular(join(prepared, spec.npm));
    if (process.platform !== 'win32') await chmod(join(prepared, spec.executable), 0o700);
    if (!await probe(join(prepared, spec.executable), signal)) throw new Error('Скачанный Node.js не запускается на этом компьютере.');
    await writeFile(join(prepared, 'runtime-owner.json'), JSON.stringify({ version: VERSION, archive: spec.file, nodeSha256: createHash('sha256').update(await readFile(join(prepared, spec.executable))).digest('hex') }), { flag: 'wx', mode: 0o600 });
    await rename(prepared, target);
    return (await saved())!;
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function ensureKimiRuntime(profileRoot: string, signal: AbortSignal, options: { forceManaged?: boolean } = {}) {
  if (!options.forceManaged) { const ready = await existingKimiRuntime(signal); if (ready) return ready; }
  const parent = dirname(profileRoot);
  const pending = jobs.get(parent); if (pending) return pending;
  const run = managedRuntime(parent, signal).finally(() => jobs.delete(parent)); jobs.set(parent, run); return run;
}
