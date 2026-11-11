import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rename, rm, readdir, writeFile } from 'node:fs/promises';
import { join, win32, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { experimental_killPortableProcess } from '@get-bb/plugin-sdk/provider-bridge';
import type { KimiDiagnosticLog } from './kimi-diagnostics';
import { kimiErrorFields } from './kimi-diagnostics';
import { verifyKimiRuntime } from './kimi-runtime-diagnostics';

export const KIMI_INSTALL_TIMEOUT_MS = 15 * 60_000;

/** Windows environment names are case-insensitive, including inside host workers. */
export function kimiCommandEnvironment(executable: string, environment: NodeJS.ProcessEnv = process.env, platform: string = process.platform) {
  const env = { ...environment };
  const paths = platform === 'win32' ? win32 : posix;
  const pathKeys = Object.keys(env).filter(key => platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH');
  const inherited = pathKeys.map(key => env[key]).filter(Boolean).join(paths.delimiter);
  for (const key of pathKeys) delete env[key];
  env[platform === 'win32' ? 'Path' : 'PATH'] = paths.dirname(executable) + paths.delimiter + inherited;
  return env;
}

/** npm output is drained and counted, never retained or forwarded to the UI/log. */
export function kimiInstallCommand(executable: string, args: string[], signal: AbortSignal, log: KimiDiagnosticLog,
  options: { timeoutMs?: number; heartbeatMs?: number; cleanupMs?: number } = {}): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const started = Date.now(); let outputBytes = 0; let settled = false; let failure: unknown;
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(executable, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32',
      env: kimiCommandEnvironment(executable), stdio: ['ignore', 'pipe', 'pipe'] });
    const count = (chunk: Buffer) => { outputBytes = Math.min(Number.MAX_SAFE_INTEGER, outputBytes + chunk.length); };
    child.stdout.on('data', count); child.stderr.on('data', count);
    const pulse = () => { if (!settled) log('adapter-install', 'progress', { elapsedMs: Date.now() - started, outputBytes }); };
    const heartbeat = setInterval(pulse, options.heartbeatMs ?? 5000);
    const finish = (error?: unknown) => {
      if (settled) return; settled = true;
      clearTimeout(deadline); clearTimeout(cleanup); clearInterval(heartbeat); signal.removeEventListener('abort', abort);
      child.stdout.off('data', count); child.stderr.off('data', count);
      error ? reject(error) : resolve();
    };
    const stop = (error: unknown) => {
      if (settled || failure) return; failure = error;
      try {
        if (process.platform !== 'win32' && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        } else experimental_killPortableProcess(child, 'SIGKILL');
      } catch { /* Wait for close; an unconfirmed process never owns the next install directory. */ }
      cleanup = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        finish(Object.assign(error instanceof Error ? error : new Error('Install cancelled'), { cleanupPending: true }));
      }, options.cleanupMs ?? 3000);
    };
    const abort = () => stop(new DOMException('Install cancelled', 'AbortError'));
    const deadline = setTimeout(() => stop(Object.assign(new Error('Установка компонентов не завершилась за 15 минут. Повтори настройку.'), { name: 'TimeoutError' })), options.timeoutMs ?? KIMI_INSTALL_TIMEOUT_MS);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('error', error => { if (child.pid) stop(error); else finish(error); });
    child.once('close', (exitCode, signal) => {
      pulse();
      finish(failure ?? (exitCode === 0 ? undefined : Object.assign(new Error('Не удалось установить компоненты Kimi. Повтори настройку.'), { exitCode, signal })));
    });
  });
}

async function existsDirectory(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Папка компонентов Kimi изменена. Существующие файлы сохранены.');
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Install afresh in a private staging tree; publish only a verified runtime. */
export async function installKimiAdapter(root: string, executable: string, args: string[], signal: AbortSignal, log: KimiDiagnosticLog,
  options: { run?: typeof kimiInstallCommand; verify?: typeof verifyKimiRuntime } = {}) {
  signal.throwIfAborted();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await existsDirectory(root);
  const release = await acquireInstall(root);
  try { await installKimiAdapterLocked(root, executable, args, signal, log, options); }
  finally { await release(); }
}

/** Cross-worker gate. Publish our claim BEFORE inspecting peers, so two arrivals
 * cannot both pass. Never delete another claim: dead processes are ignored;
 * an unconfirmed live worker requires retry/restart rather than an unsafe unlock. */
async function acquireInstall(root: string) {
  const directory = join(root, '.runtime-lock');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await existsDirectory(directory);
  const name = `${process.pid}-${randomUUID()}.lock`;
  const claim = join(directory, name);
  await writeFile(claim, '', { flag: 'wx', mode: 0o600 });
  const release = () => rm(claim, { force: true });
  try {
    for (const peer of await readdir(directory)) {
      if (peer === name) continue;
      const pid = peer.match(/^(\d+)-[a-f0-9-]{36}\.lock$/u)?.[1];
      if (!pid || Number(pid) < 1) throw new Error('Неизвестная блокировка установки Kimi. Существующие файлы сохранены.');
      let alive = true;
      try { process.kill(Number(pid), 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      if (alive) throw Object.assign(new Error('Предыдущая установка Kimi ещё работает. Дождись её завершения; если BB перезапускался, полностью закрой и запусти его заново.'), { code: 'EBUSY' });
    }
    return release;
  } catch (error) { await release(); throw error; }
}

async function installKimiAdapterLocked(root: string, executable: string, args: string[], signal: AbortSignal, log: KimiDiagnosticLog,
  options: { run?: typeof kimiInstallCommand; verify?: typeof verifyKimiRuntime }) {
  const runtime = join(root, 'runtime');
  const prefix = args.indexOf('--prefix');
  if (prefix < 0 || args[prefix + 1] !== runtime) throw new Error('Unexpected Kimi install destination');
  signal.throwIfAborted();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(root, '.install-'));
  const stagedRuntime = join(staging, 'runtime');
  const backup = join(root, '.runtime-previous-' + randomUUID());
  let oldMoved = false; let published = false; let cleanupPending = false;
  const verify = options.verify ?? verifyKimiRuntime;
  try {
    const stagedArgs = [...args]; stagedArgs[prefix + 1] = stagedRuntime;
    await (options.run ?? kimiInstallCommand)(executable, stagedArgs, signal, log);
    await verify(staging, executable, signal, log);
    signal.throwIfAborted();
    if (await existsDirectory(runtime)) { await rename(runtime, backup); oldMoved = true; }
    await rename(stagedRuntime, runtime); published = true;
    await verify(root, executable, signal, log);
  } catch (error) {
    cleanupPending = !!(error as { cleanupPending?: boolean })?.cleanupPending;
    if (published) await rm(runtime, { recursive: true, force: true });
    if (oldMoved) await rename(backup, runtime);
    log('adapter-install', 'failure', { reason: 'failed', ...kimiErrorFields(error) });
    throw error;
  } finally {
    // An unconfirmed process can still be writing. Keep that isolated tree and never reuse it.
    if (!cleanupPending) await rm(staging, { recursive: true, force: true });
  }
  if (oldMoved) await rm(backup, { recursive: true, force: true });
}
