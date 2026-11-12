import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { experimental_hostToolchain as toolchain } from '@get-bb/plugin-sdk/process';
import { experimental_killPortableProcess as killPortable } from '@get-bb/plugin-sdk/provider-bridge';
import type { KimiDiagnosticLog } from './kimi-diagnostics';
import { nativeCommand } from './native-command';

export type WindowsNode = { executable: string; npmCli: string; version: string };
type Discovery = { runtime: WindowsNode | null; occupied: boolean };
type RunResult = { code: number | null; output: string };
export type WindowsNodeOptions = {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  discover?: (signal: AbortSignal) => Promise<Discovery>;
  resolveWinget?: () => string | null;
  refresh?: () => Promise<void>;
  run?: typeof runWindowsNodeCommand;
};

/** No shell, npm.cmd, retained installer output, or unbounded child lifetime. */
export function runWindowsNodeCommand(executable: string, args: string[], signal: AbortSignal,
  options: { timeoutMs: number; capture?: boolean; pulse?: () => void; env?: NodeJS.ProcessEnv }): Promise<RunResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let output = ''; let settled = false; let failure: Error | undefined;
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    const command = nativeCommand(executable, args, process.platform, options.env);
    const child = spawn(command.executable, command.args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env, windowsVerbatimArguments: command.windowsVerbatimArguments });
    const finish = (error?: Error, code: number | null = null) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(cleanup); clearInterval(heartbeat); signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve({ code, output });
    };
    const stop = (error: Error) => {
      if (settled || failure) return; failure = error;
      try { killPortable(child, 'SIGKILL'); } catch { /* Do not launch a second installer after an uncertain stop. */ }
      cleanup = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        finish(Object.assign(error, { cleanupPending: true }));
      }, 3000);
    };
    const abort = () => stop(new DOMException('Установка Node.js отменена.', 'AbortError'));
    const timer = setTimeout(() => stop(Object.assign(new Error('Установка Node.js не завершилась. Проверь системный запрос Windows и повтори.'), { name: 'TimeoutError' })), options.timeoutMs);
    const heartbeat = setInterval(() => options.pulse?.(), 5000);
    child.stdout.on('data', data => { if (options.capture && output.length < 8192) output += String(data).slice(0, 8192 - output.length); });
    child.stderr.on('data', () => {});
    child.once('error', () => finish(failure ?? new Error('Не удалось запустить компонент Node.js.')));
    child.once('close', code => finish(failure, code));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function variable(env: NodeJS.ProcessEnv, name: string) {
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/** MSI's default location is usable before this BB process inherits the new PATH. */
export function windowsNodeCandidates(env: NodeJS.ProcessEnv) {
  return [...new Set(['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)'].map(name => variable(env, name))
    .filter((path): path is string => !!path && win32.isAbsolute(path)).map(path => win32.join(path, 'nodejs', 'node.exe')))];
}

export async function discoverWindowsNode(signal: AbortSignal, env: NodeJS.ProcessEnv = process.env,
  run = runWindowsNodeCommand): Promise<Discovery> {
  signal.throwIfAborted();
  const candidates = new Map<string, string>();
  try {
    const pair = toolchain.npmCli();
    if (pair) candidates.set(pair.node, pair.cli);
    const executable = toolchain.resolve('node.exe');
    if (executable && !candidates.has(executable)) candidates.set(executable, win32.join(win32.dirname(executable), 'node_modules/npm/bin/npm-cli.js'));
  } catch { /* Known MSI locations remain available without toolchain discovery. */ }
  for (const executable of windowsNodeCandidates(env)) {
    if (!candidates.has(executable)) candidates.set(executable, win32.join(win32.dirname(executable), 'node_modules/npm/bin/npm-cli.js'));
  }
  let occupied = false;
  for (const [executable, npmCli] of candidates) {
    try {
      const result = await run(executable, ['-p', 'JSON.stringify({version:process.versions.node,electron:!!process.versions.electron})'], signal, { timeoutMs: 5000, capture: true });
      const value = JSON.parse(result.output);
      if (result.code !== 0 || value.electron || !/^\d+\.\d+\.\d+$/.test(value.version)) continue;
      occupied = true; // Preserve an older/incomplete standalone installation too.
      if (Number(value.version.split('.')[0]) < 22) continue;
      const npm = await run(executable, [npmCli, '--version'], signal, { timeoutMs: 15_000, capture: true });
      if (npm.code === 0 && /^\d+\.\d+\.\d+$/.test(npm.output.trim())) return { runtime: { executable, npmCli, version: value.version }, occupied };
    } catch { signal.throwIfAborted(); }
  }
  return { runtime: null, occupied };
}

let installation: Promise<WindowsNode | null> | undefined;

/** Install only when no existing standalone Node would be replaced. No patch pin. */
export async function ensureWindowsNode(signal: AbortSignal, log: KimiDiagnosticLog = () => {}, options: WindowsNodeOptions = {}): Promise<WindowsNode | null> {
  if ((options.platform ?? process.platform) !== 'win32') return null;
  signal.throwIfAborted();
  // Options are a fixture boundary; production callers share one host install.
  if (installation && Object.keys(options).length === 0) return installation;
  const work = async () => {
    const discover = options.discover ?? ((signal: AbortSignal) => discoverWindowsNode(signal, options.env));
    try { await (options.refresh ?? (() => toolchain.refresh()))(); } catch { signal.throwIfAborted(); }
    const current = await discover(signal);
    if (current.runtime) return current.runtime;
    if (current.occupied) { log('runtime-install', 'fallback', { component: 'node', runtimeKind: 'portable', reason: 'conservative' }); return null; }
    const winget = options.resolveWinget ? options.resolveWinget() : toolchain.resolve('winget.exe');
    if (!winget) { log('runtime-install', 'fallback', { component: 'node', runtimeKind: 'portable', reason: 'unavailable' }); return null; }
    const started = Date.now();
    const pulse = () => log('runtime-install', 'progress', { component: 'node', runtimeKind: 'winget', elapsedMs: Date.now() - started });
    log('runtime-install', 'start', { component: 'node', runtimeKind: 'winget' });
    let code: number | null = null;
    try {
      ({ code } = await (options.run ?? runWindowsNodeCommand)(winget,
        ['install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--source', 'winget', '--no-upgrade', '--silent',
          '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'],
        signal, { timeoutMs: 10 * 60_000, pulse }));
    } catch (error) {
      signal.throwIfAborted();
      if ((error as Error).name === 'TimeoutError' || (error as { cleanupPending?: boolean }).cleanupPending) throw error;
      // Process launch failures may use the portable fallback; actual probes decide success.
    }
    signal.throwIfAborted();
    try { await (options.refresh ?? (() => toolchain.refresh()))(); } catch { signal.throwIfAborted(); }
    const installed = await discover(signal);
    if (installed.runtime) {
      log('runtime-install', 'success', { component: 'node', runtimeKind: 'winget', version: installed.runtime.version });
      return installed.runtime;
    }
    log('runtime-install', 'fallback', { component: 'node', runtimeKind: 'portable', reason: 'unavailable', ...(code !== null ? { exitCode: code | 0 } : {}) });
    return null;
  };
  if (Object.keys(options).length) return work();
  installation = work().finally(() => { installation = undefined; });
  return installation;
}
