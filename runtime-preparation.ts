import { mkdir, readFile, readdir, rename, rm, stat, lstat, writeFile } from 'node:fs/promises';
import { dirname, join, win32, isAbsolute } from 'node:path';
import { experimental_hostToolchain as toolchain } from '@get-bb/plugin-sdk/process';
import { ensureWindowsNode, runWindowsNodeCommand, type WindowsNode } from './windows-node';
import { ensureKimiRuntime } from './kimi-runtime';
import { runtimeViewSchema, type RuntimeView } from './runtime-contract';
export { runtimeViewSchema, type RuntimeView } from './runtime-contract';

const jobs = new Map<string, Promise<RuntimeView>>();
const cancellations = new Map<string, AbortController>();
const variable = (env: NodeJS.ProcessEnv, name: string) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
const safeResolve = (name: string) => { try { return toolchain.resolve(name); } catch { return null; } };
export const runtimeEnvironment = (view: RuntimeView): NodeJS.ProcessEnv => view.status === 'ready' && view.python ? {
  SVAIB_PYTHON: view.python, ...(view.bash ? { CLAUDE_CODE_GIT_BASH_PATH: view.bash } : {}), ...(view.path ? { PATH: view.path } : {}),
} : {};

export async function inspectRuntime(root: string): Promise<RuntimeView> {
  try { return runtimeViewSchema.parse(JSON.parse(await readFile(join(root, 'status.json'), 'utf8'))); }
  catch { return { platform: process.platform, status: 'idle', step: 'probe', message: 'Подготовка компьютера ещё не выполнена.' }; }
}

export type RuntimePreparationOptions = {
  platform?: string; env?: NodeJS.ProcessEnv; resolve?: typeof safeResolve; run?: typeof runWindowsNodeCommand;
  refresh?: () => Promise<void>; node?: (signal: AbortSignal) => Promise<WindowsNode | null>;
  portable?: (signal: AbortSignal) => Promise<WindowsNode>; retry?: boolean; portableNode?: boolean;
  progress?: (view: RuntimeView) => void;
};

/** Runs in the execution host, before a provider starts. No profile, login or marketplace is replaced. */
export async function prepareRuntime(root: string, signal: AbortSignal, options: RuntimePreparationOptions = {}): Promise<RuntimeView> {
  const pending = jobs.get(root); if (pending) return pending;
  const cancel = new AbortController(); cancellations.set(root, cancel);
  const job = prepare(root, AbortSignal.any([signal, cancel.signal]), options).finally(() => { jobs.delete(root); cancellations.delete(root); }); jobs.set(root, job); return job;
}

export async function cancelRuntime(root: string) {
  cancellations.get(root)?.abort();
  return jobs.get(root) ?? inspectRuntime(root);
}

async function prepare(root: string, signal: AbortSignal, options: RuntimePreparationOptions): Promise<RuntimeView> {
  const platform = options.platform ?? process.platform, env = options.env ?? toolchain.environment();
  const resolve = options.resolve ?? safeResolve, run = options.run ?? runWindowsNodeCommand;
  const previous = await inspectRuntime(root);
  if (previous.status === 'failed' && previous.step === 'cleanup') return previous;
  if (previous.status === 'failed' && !options.retry) return previous;
  if (!isAbsolute(root)) throw new Error('Нужна абсолютная папка подготовки рабочего места.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Папка подготовки стала ссылкой. Существующие файлы сохранены.');
  // An OS-wide owned lock fences installers in separate BB host workers.
  const lock = join(root, 'prepare.lock');
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let alive = true;
    try { const pid = Number(await readFile(join(lock, 'pid'), 'utf8')); if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0);
      else alive = Date.now() - (await stat(lock)).mtimeMs < 30_000; }
    catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
      else if ((probe as NodeJS.ErrnoException).code === 'ENOENT') {
        // The creator may still be writing its pid. A crash in that tiny window
        // must not leave an eternal lock; no installer starts before pid exists.
        try { alive = Date.now() - (await stat(lock)).mtimeMs < 30_000; } catch { alive = false; }
      }
    }
    if (alive) return { platform, status: 'preparing', step: 'lock', message: 'Подготовка уже выполняется на этом компьютере. Дождись её завершения.' };
    await rm(lock, { recursive: true }); await mkdir(lock);
  }
  if ((await lstat(lock)).isSymbolicLink()) throw new Error('Блокировка подготовки стала ссылкой. Подготовка остановлена.');
  await writeFile(join(lock, 'pid'), String(process.pid), { flag: 'wx' });
  let view: RuntimeView = { platform, status: 'preparing', step: 'probe', message: 'Проверяю компоненты компьютера.', versions: {} };
  let retainLock = false;
  async function save() { const temp = join(root, 'status-' + process.pid + '.tmp'); await writeFile(temp, JSON.stringify(view)); await rename(temp, join(root, 'status.json')); options.progress?.(view); }
  async function step(name: string, message: string) { view = { ...view, step: name, message }; await save(); signal.throwIfAborted(); }
  async function probe(executable: string | null, args: string[], pattern: RegExp) {
    if (!executable) return null;
    const probeEnv = view.path ? Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== 'path')) : env;
    if (view.path) probeEnv.PATH = view.path;
    try { const result = await run(executable, args, signal, { timeoutMs: 10_000, capture: true, env: probeEnv });
      return result.code === 0 && pattern.test(result.output.trim()) ? result.output.trim() : null;
    } catch { signal.throwIfAborted(); return null; }
  }
  async function refresh() { await (options.refresh ?? (() => toolchain.refresh()))().catch(() => { signal.throwIfAborted(); }); }
  async function install(id: string, name: string) {
    await step(name, `Устанавливаю ${name}. Если Windows покажет системный запрос, подтверди его.`);
    const winget = resolve('winget.exe');
    if (!winget) throw new Error(`WinGet недоступен. Установи ${name} вручную и повтори подготовку.`);
    const result = await run(winget, ['install', '--id', id, '--exact', '--source', 'winget', '--no-upgrade', '--silent',
      '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], signal,
    { timeoutMs: 10 * 60_000, env });
    signal.throwIfAborted(); await refresh();
    // WinGet may report a reboot/previous install; real probes decide readiness.
    return result.code;
  }
  try {
    await save(); await refresh();
    await step('python', 'Проверяю запуск Python 3.10 или новее.');
    const script = join(root, 'probe.py');
    await writeFile(script, "import sys,json\nassert sys.version_info >= (3,10)\nprint(json.dumps({'executable':sys.executable,'version':sys.version.split()[0]}))\n");
    const findPython = async () => {
      const candidates = [env.SVAIB_PYTHON, resolve('python3'), resolve('python.exe'), resolve('python')];
      if (platform === 'win32') {
        const py = resolve('py.exe'), answer = await probe(py, ['-3', '-c', 'import sys;print(sys.executable)'], /\S/);
        if (answer) candidates.push(answer);
        for (const parent of [variable(env, 'LOCALAPPDATA') && win32.join(variable(env, 'LOCALAPPDATA')!, 'Programs', 'Python'), variable(env, 'ProgramFiles')]) {
          if (!parent) continue;
          try { for (const name of await readdir(parent)) if (/^Python3\d+$/i.test(name)) candidates.push(win32.join(parent, name, 'python.exe')); } catch { /* optional location */ }
        }
      }
      for (const candidate of [...new Set(candidates)]) {
        if (!candidate || (platform === 'win32' && /[\\/]WindowsApps[\\/]/i.test(candidate))) continue;
        const result = await probe(candidate, [script], /^\{/); if (!result) continue;
        try { const answer = JSON.parse(result); if (typeof answer.executable === 'string' && typeof answer.version === 'string') return answer as { executable: string; version: string }; } catch { /* no marker */ }
      }
      return null;
    };
    let python = await findPython();
    if (!python && platform === 'win32') { await install('Python.Python.3.13', 'Python'); python = await findPython(); }
    if (!python) throw new Error('Python 3.10+ не запускает проверочный файл. Установи Python и повтори подготовку.');
    view.python = python.executable; view.versions!.python = python.version;
    if (platform === 'win32') {
      await step('git', 'Проверяю Git for Windows и Git Bash.');
      const findGit = async () => {
        const bases = ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)'].map(name => variable(env, name)).filter((value): value is string => !!value);
        const gits = [resolve('git.exe'), ...bases.map(base => win32.join(base, 'Git', 'cmd', 'git.exe'))];
        for (const git of gits) {
          const version = await probe(git, ['--version'], /^git version /); if (!git || !version) continue;
          const base = win32.dirname(win32.dirname(git));
          for (const bash of [variable(env, 'CLAUDE_CODE_GIT_BASH_PATH'), win32.join(base, 'bin', 'bash.exe'), win32.join(base, 'usr', 'bin', 'bash.exe')]) {
            if (bash && await probe(bash, ['-c', 'printf svaib-bash-ok'], /^svaib-bash-ok$/)) return { git, bash, version };
          }
        }
        return null;
      };
      let git = await findGit();
      if (!git) { await install('Git.Git', 'Git for Windows с Git Bash'); git = await findGit(); }
      if (!git) throw new Error('Git или Git Bash не запускается. Проверь Git for Windows и повтори подготовку.');
      view.git = git.git; view.bash = git.bash; view.versions!.git = git.version;
      await step('node', 'Проверяю Node.js и npm.');
      let savedNode: WindowsNode | null = null;
      if (previous.status === 'ready' && previous.node && previous.npmCli) {
        const version = await probe(previous.node, ['-p', 'JSON.stringify({version:process.versions.node,electron:!!process.versions.electron})'], /^\{/);
        try { const parsed = JSON.parse(version ?? '{}'); if (!parsed.electron && Number(parsed.version?.split('.')[0]) >= 22)
          savedNode = { executable: previous.node, npmCli: previous.npmCli, version: parsed.version }; } catch { /* re-discover */ }
      }
      const node = savedNode ?? (options.portableNode
        ? await (options.portable ?? (signal => ensureKimiRuntime(join(root, 'portable', 'runtime'), signal, { forceManaged: true })))(signal)
        : await (options.node ?? (signal => ensureWindowsNode(signal)))(signal));
      if (!node) throw new Error('Нужен рабочий Node.js 22+ с npm. Установи его или выбери переносимый резерв: bb svaib-workplace runtime prepare --portable-node.');
      view.node = node.executable; view.npmCli = node.npmCli; view.versions!.node = node.version;
      const npm = await probe(node.executable, [node.npmCli, '--version'], /^\d+\.\d+\.\d+$/);
      if (!npm) throw new Error('npm не запускается выбранным Node.js. Повтори подготовку.');
      view.versions!.npm = npm;
      // Repairs old python3 hook registrations without rewriting installed package bytes.
      const bin = join(root, 'bin'); await mkdir(bin, { recursive: true });
      if ((await lstat(bin)).isSymbolicLink()) throw new Error('Папка launcher стала ссылкой. Существующие файлы сохранены.');
      const quoted = python.executable.replaceAll('\\', '/').replaceAll("'", "'\\''");
      await writeFile(join(bin, 'python3'), `#!/bin/sh\nexec '${quoted}' "$@"\n`, { mode: 0o700 });
      // Environment expansion preserves a Unicode interpreter path independently
      // of cmd.exe's active codepage; no absolute Unicode path is batch source.
      await writeFile(join(bin, 'python3.cmd'), '@"%SVAIB_PYTHON%" %*\r\n');
      view.path = [bin, win32.dirname(python.executable), win32.dirname(git.git), win32.dirname(git.bash), win32.dirname(node.executable), variable(env, 'PATH') ?? ''].join(';');
      await step('bb', 'Проверяю CLI текущего BB.');
      const bb = env.BB_CLI || resolve('bb.cmd') || resolve('bb.exe') || resolve('bb');
      if (!await probe(bb, ['--version'], /\d+\.\d+\.\d+/)) throw new Error('CLI BB не запускается на компьютере исполнения. Проверь установку BB и повтори подготовку.');
    }
    view = { ...view, status: 'ready', step: 'ready', message: 'Компьютер подготовлен. Рабочие профили и входы сохранены.' }; await save(); return view;
  } catch (error) {
    retainLock = (error as { cleanupPending?: boolean }).cleanupPending === true;
    view = { platform, status: 'failed', step: view.step, message: signal.aborted ? 'Подготовка отменена. Для повтора: bb svaib-workplace runtime prepare --retry.'
      : `${error instanceof Error ? error.message : 'Подготовка не завершена.'} Для повтора: bb svaib-workplace runtime prepare --retry.` };
    if (retainLock) view = { platform, status: 'failed', step: 'cleanup', message: 'Завершение установщика не подтверждено. Второй установщик не запущен. Проверь завершение процесса в Windows; подготовка требует технического восстановления.' };
    await save(); return view;
  } finally { if (!retainLock) await rm(lock, { recursive: true, force: true }); }
}
