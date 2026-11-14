import { mkdir, readFile, readdir, rename, rm, rmdir, stat, lstat, writeFile, chmod } from 'node:fs/promises';
import { join, win32, delimiter, isAbsolute, dirname, basename } from 'node:path';
import { experimental_hostToolchain as toolchain } from '@get-bb/plugin-sdk/process';
import { ensureWindowsNode, discoverWindowsNode, runWindowsNodeCommand, type WindowsNode } from './windows-node';
import { verifyKimiRuntime } from './kimi-runtime-diagnostics';
import { ADAPTER, validateProvision } from './scripts/setup-kimi-cc.mjs';
import { ensureKimiRuntime } from './kimi-runtime';
import { runtimeViewSchema, requirementsFor, type RuntimeView, type RuntimeContext, type RuntimeRequirement } from './runtime-contract';
export { runtimeViewSchema, type RuntimeView } from './runtime-contract';

const jobs = new Map<string, Promise<RuntimeView>>();
const cancellations = new Map<string, AbortController>();
const scopes = new Map<string, string>();
const variable = (env: NodeJS.ProcessEnv, name: string) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
const safeResolve = (name: string) => { try { return toolchain.resolve(name); } catch { return null; } };
export const runtimeEnvironment = (view: RuntimeView): NodeJS.ProcessEnv => view.status === 'ready' && view.python ? {
  SVAIB_PYTHON: view.python, ...(view.bash ? { CLAUDE_CODE_GIT_BASH_PATH: view.bash } : {}), ...(view.path ? { PATH: view.path } : {}),
} : {};

/** Legacy status is operation history and discovery hints, never readiness evidence. */
async function readStatus(root: string): Promise<RuntimeView | null> {
  try { return runtimeViewSchema.parse(JSON.parse(await readFile(join(root, 'status.json'), 'utf8'))); } catch { return null; }
}
export type RuntimePreparationOptions = {
  platform?: string; env?: NodeJS.ProcessEnv; resolve?: typeof safeResolve; run?: typeof runWindowsNodeCommand;
  refresh?: () => Promise<void>; node?: (signal: AbortSignal) => Promise<WindowsNode | null>;
  discoverNode?: (signal: AbortSignal) => Promise<WindowsNode | null>;
  portable?: (signal: AbortSignal) => Promise<WindowsNode>; retry?: boolean; portableNode?: boolean;
  context?: RuntimeContext; progress?: (view: RuntimeView) => void;
  /** Deterministic fixture boundary under the claim; never accepted by host RPC. */
  beforeStaleLockTakeover?: () => Promise<void>;
};
const pythonCode = "import sys,json;assert sys.version_info >= (3,10);print(json.dumps({'executable':sys.executable,'version':sys.version.split()[0]}))";
const legacyInstallerSteps = new Set(['node', 'Python', 'python', 'Git for Windows с Git Bash', 'Git', 'git']);
const unfinishedInstaller = (view: RuntimeView | null) => !!view && (view.installerUncertain === true || view.step === 'cleanup'
  || (view.installerUncertain === undefined && view.status === 'preparing' && legacyInstallerSteps.has(view.step)));
const fenceRepair = (view: RuntimeView, context?: RuntimeContext): RuntimeView => view.installerUncertain
  && !(view.status === 'ready' && context?.action === 'dispatch')
  ? { ...view, status: 'failed', step: 'cleanup', message: 'Завершение установщика не подтверждено. Второй установщик не запущен. Проверь завершение процесса в Windows.' }
  : view;

/** Safe factual probe. Does not install, write shims/status, or ask a model. */
export async function inspectRuntime(root: string, context: RuntimeContext | null = null,
  signal: AbortSignal = new AbortController().signal, options: RuntimePreparationOptions = {}): Promise<RuntimeView> {
  // Refreshing discovery is safe and lets a manual install become visible without CLI retry.
  await (options.refresh ?? (() => toolchain.refresh()))().catch(() => { signal.throwIfAborted(); });
  const platform = options.platform ?? process.platform, env = options.env ?? toolchain.environment();
  const resolve = options.resolve ?? safeResolve, run = options.run ?? runWindowsNodeCommand;
  const previous = await readStatus(root), requirements = requirementsFor(context, platform);
  const view: RuntimeView = { platform, status: 'idle', step: 'probe', message: 'Проверяю компоненты компьютера.',
    requirements, missing: [], versions: {}, ...(context ? { context } : {}),
    ...(previous?.status === 'failed' ? { operationError: previous.message } : {}),
    ...(unfinishedInstaller(previous) ? { installerUncertain: true } : {}) };
  const bin = join(root, 'bin');
  // Reuse only existing owned launchers, never a saved ready/failed verdict.
  const shim = platform === 'win32' ? join(bin, 'python3.cmd') : join(bin, 'python3');
  let hasShim = false; try { hasShim = (await lstat(shim)).isFile() && !(await lstat(bin)).isSymbolicLink(); } catch { /* no repair yet */ }
  const path = variable(env, 'PATH') ?? '';
  const probeEnv = { ...env };
  if (hasShim) {
    for (const key of Object.keys(probeEnv)) if (key.toLowerCase() === 'path') delete probeEnv[key];
    view.path = [...new Set([bin, ...path.split(platform === 'win32' ? ';' : delimiter)])].join(platform === 'win32' ? ';' : delimiter); probeEnv.PATH = view.path;
  }
  async function probe(executable: string | null | undefined, args: string[], pattern: RegExp) {
    if (!executable || (platform === 'win32' && /[\\/]WindowsApps[\\/]/i.test(executable))) return null;
    try { const result = await run(executable, args, signal, { timeoutMs: 10_000, capture: true, env: probeEnv });
      return result.code === 0 && pattern.test(result.output.trim()) ? result.output.trim() : null;
    } catch { signal.throwIfAborted(); return null; }
  }
  function missing(requirement: RuntimeRequirement) { if (!view.missing!.includes(requirement)) view.missing!.push(requirement); }
  if (requirements.includes('python')) {
    const candidates = [env.SVAIB_PYTHON, previous?.python, resolve('python3'), resolve('python.exe'), resolve('python')];
    if (platform === 'win32') {
      const answer = await probe(resolve('py.exe'), ['-3', '-c', 'import sys;print(sys.executable)'], /\S/); if (answer) candidates.push(answer);
      for (const parent of [variable(env, 'LOCALAPPDATA') && win32.join(variable(env, 'LOCALAPPDATA')!, 'Programs', 'Python'), variable(env, 'ProgramFiles')]) {
        if (!parent) continue;
        try { for (const name of await readdir(parent)) if (/^Python3\d+$/i.test(name)) candidates.push(win32.join(parent, name, 'python.exe')); } catch { /* optional location */ }
      }
    }
    for (const candidate of [...new Set(candidates)]) {
      const result = await probe(candidate, ['-c', pythonCode], /^\{/); if (!result) continue;
      try { const answer = JSON.parse(result); if (typeof answer.executable === 'string' && typeof answer.version === 'string') {
        view.python = answer.executable; view.versions!.python = answer.version; break;
      } } catch { /* not a Python response */ }
    }
    if (!view.python) missing('python');
    else {
      probeEnv.SVAIB_PYTHON = view.python;
      // Pi uses spawn(SVAIB_PYTHON || python3); CC/Codex first invoke python3.
      if (context?.provider !== 'pi') {
        const launcher = hasShim ? shim : resolve('python3');
        if (!await probe(launcher, ['-c', pythonCode], /^\{/)) missing('python');
      }
    }
  }
  if (requirements.includes('bash')) {
    // An explicitly selected CC Bash is usable without making git.exe a dispatch dependency.
    for (const bash of [variable(env, 'CLAUDE_CODE_GIT_BASH_PATH'), previous?.bash]) {
      if (bash && await probe(bash, ['-c', 'printf svaib-bash-ok'], /^svaib-bash-ok$/)) { view.bash = bash; break; }
    }
    const bases = ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)'].map(name => variable(env, name)).filter((value): value is string => !!value);
    const gits = [previous?.git, resolve('git.exe'), ...bases.map(base => win32.join(base, 'Git', 'cmd', 'git.exe'))];
    for (const git of view.bash ? [] : [...new Set(gits)]) {
      const version = await probe(git, ['--version'], /^git version /); if (!git || !version) continue;
      const base = win32.dirname(win32.dirname(git));
      for (const bash of [variable(env, 'CLAUDE_CODE_GIT_BASH_PATH'), previous?.bash, win32.join(base, 'bin', 'bash.exe'), win32.join(base, 'usr', 'bin', 'bash.exe')]) {
        if (bash && await probe(bash, ['-c', 'printf svaib-bash-ok'], /^svaib-bash-ok$/)) { view.git = git; view.bash = bash; view.versions!.git = version; break; }
      }
      if (view.bash) break;
    }
    if (!view.bash) missing('bash');
    else if (view.python) {
      // Exercise the actual shell lookup used by CC's python3 hook command.
      if (!await probe(view.bash, ['-c', `python3 -c '${pythonCode.replaceAll("'", "'\\''")}'`], /^\{/)) missing('python');
    }
  }
  if (requirements.includes('node') || requirements.includes('npm') || requirements.includes('bb')) {
    let node: WindowsNode | null = null;
    if (previous?.node && previous.npmCli) {
      const value = await probe(previous.node, ['-p', 'JSON.stringify({version:process.versions.node,electron:!!process.versions.electron})'], /^\{/);
      try { const parsed = JSON.parse(value ?? '{}'); if (!parsed.electron && Number(parsed.version?.split('.')[0]) >= 22)
        node = { executable: previous.node, npmCli: previous.npmCli, version: parsed.version }; } catch { /* rediscover */ }
    }
    node ??= await (options.discoverNode ?? (async () => platform === 'win32'
      ? (await discoverWindowsNode(signal, probeEnv, run)).runtime : null))(signal);
    if (node) {
      view.node = node.executable; view.npmCli = node.npmCli; view.versions!.node = node.version;
      const npm = await probe(node.executable, [node.npmCli, '--version'], /^\d+\.\d+\.\d+$/);
      if (npm) view.versions!.npm = npm; else if (requirements.includes('npm')) missing('npm');
    } else { if (requirements.includes('node')) missing('node'); if (requirements.includes('npm')) missing('npm'); }
  }
  if (requirements.includes('bb')) {
    const bb = resolve('bb') || env.BB_CLI_LAUNCHER || env.BB_CLI || resolve('bb.cmd') || resolve('bb.exe');
    const script = bb && ((platform === 'win32' && win32.extname(bb) === '') || /\.(?:c|m)?js$/i.test(bb));
    if (script && !view.node) {
      const candidate = resolve('node') ?? resolve('node.exe');
      const value = await probe(candidate, ['-p', 'JSON.stringify({version:process.versions.node,electron:!!process.versions.electron})'], /^\{/);
      try { const parsed = JSON.parse(value ?? '{}'); if (candidate && !parsed.electron && Number(parsed.version?.split('.')[0]) >= 22) { view.node = candidate; view.versions!.node = parsed.version; } } catch { /* no usable JS runtime */ }
    }
    const version = await probe(script ? view.node : bb, script ? [bb!, '--version'] : ['--version'], /\d+\.\d+\.\d+/);
    if (!version) missing('bb'); else view.versions!.bb = version;
  }
  if (requirements.includes('launcher') && context) {
    const name = context.provider === 'codex' ? 'codex' : context.provider === 'pi' ? 'pi' : 'claude';
    let executable = context.executable ?? resolve(name), args = context.args ?? [];
    let invalidLaunch = false;
    // BB's Pi bridge resolves these on the execution host. Backend discovery
    // supplies only a native fallback; ownership is irrelevant to a safe probe.
    if (context.provider === 'pi' && env.BB_PI_BRIDGE_COMMAND) {
      executable = env.BB_PI_BRIDGE_COMMAND;
      try {
        const prefix: unknown = env.BB_PI_BRIDGE_ARGS ? JSON.parse(env.BB_PI_BRIDGE_ARGS) : [];
        if (!Array.isArray(prefix) || !prefix.every(arg => typeof arg === 'string')) throw new Error('Invalid Pi arguments');
        args = prefix;
      } catch { invalidLaunch = true; }
    }
    // Keep host override values local: argv may contain user credentials.
    const version = invalidLaunch ? null : await probe(executable, [...args, '--version'], /\d+\.\d+/);
    if (!version) missing('launcher');
    else {
      view.versions!.launcher = version;
      // ACP's own --version does not touch the wrapped Claude executable.
      // For our marker-owned wrapper, probe that native consumer as well.
      if (context.provider === 'acp-claude-kimi' && context.args?.[0] && basename(context.args[0]) === 'launch.mjs') {
        const profileRoot = dirname(context.args[0]); let owner: { schema?: unknown; adapter?: unknown; nodeExecutable?: unknown } | null = null;
        try {
          const marker = join(profileRoot, 'setup-owner.json'); const info = await lstat(marker);
          if (!info.isSymbolicLink() && info.isFile() && info.size <= 262144) owner = JSON.parse(await readFile(marker, 'utf8'));
        } catch { /* A foreign launcher is checked through its own --version only. */ }
        if (owner?.schema === 1 && owner.adapter === ADAPTER && owner.nodeExecutable === executable) {
          try { await validateProvision(profileRoot); await verifyKimiRuntime(profileRoot, executable!, signal, () => {}); }
          catch { signal.throwIfAborted(); missing('launcher'); }
        }
      }
    }
  }
  view.status = view.missing!.length ? 'failed' : 'ready'; view.step = view.missing![0] ?? 'ready';
  view.message = view.status === 'ready' ? 'Необходимые компоненты работают.'
    : `Не работают необходимые компоненты: ${view.missing!.join(', ')}. Открой настройки svaib → Подготовка компьютера.`;
  return view;
}

/** Explicit repair: the only runtime entry which can install or write launchers. */
export async function prepareRuntime(root: string, signal: AbortSignal, options: RuntimePreparationOptions = {}): Promise<RuntimeView> {
  const scope = JSON.stringify(options.context ?? null);
  const pending = jobs.get(root); if (pending) { if (scopes.get(root) === scope) return pending; await pending; return fenceRepair(await inspectRuntime(root, options.context ?? null, signal, options), options.context); }
  const cancel = new AbortController(); cancellations.set(root, cancel); scopes.set(root, scope);
  const job = prepare(root, AbortSignal.any([signal, cancel.signal]), options).finally(() => { jobs.delete(root); cancellations.delete(root); scopes.delete(root); }); jobs.set(root, job); return job;
}
export async function cancelRuntime(root: string) {
  cancellations.get(root)?.abort();
  const pending = jobs.get(root); if (pending) return pending;
  const previous = await readStatus(root);
  return inspectRuntime(root, previous?.context ?? null);
}
async function prepare(root: string, signal: AbortSignal, options: RuntimePreparationOptions): Promise<RuntimeView> {
  const platform = options.platform ?? process.platform, env = options.env ?? toolchain.environment();
  const resolve = options.resolve ?? safeResolve, run = options.run ?? runWindowsNodeCommand;
  let view = await inspectRuntime(root, options.context ?? null, signal, options);
  // A possibly-running installer fences conflicting mutation, never factual probes.
  if (view.installerUncertain) return fenceRepair(view, options.context);
  if (!isAbsolute(root)) throw new Error('Нужна абсолютная папка подготовки рабочего места.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Папка подготовки стала ссылкой. Существующие файлы сохранены.');
  const lock = join(root, 'prepare.lock');
  // Serialize every main-lock acquisition, stale takeover and release. This
  // empty sibling survives rm(lock); rmdir(claim) is the atomic handoff. A crash
  // while holding it fails closed rather than guessing that mutation stopped.
  const claim = join(root, 'prepare.lock.claim');
  async function claimLock(wait = false) {
    for (let attempt = 0; attempt < (wait ? 100 : 3); attempt++) {
      try { await mkdir(claim); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const entry = await lstat(claim).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
        if (!entry) continue; // A normal neighbour release raced our EEXIST.
        if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Блокировка подготовки стала ссылкой или файлом. Подготовка остановлена.');
        if (!wait) return false;
      }
      if (wait) await new Promise(resolve => setTimeout(resolve, 10));
    }
    return false;
  }
  const busy = (): RuntimeView => ({ platform, status: 'preparing', step: 'lock', message: 'Подготовка уже выполняется на этом компьютере. Дождись её завершения.' });
  if (!await claimLock()) return busy();
  try {
    try { await mkdir(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if ((await lstat(lock)).isSymbolicLink()) throw new Error('Блокировка подготовки стала ссылкой. Подготовка остановлена.');
      let alive = true;
      try { const pid = Number(await readFile(join(lock, 'pid'), 'utf8')); if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0);
        else alive = Date.now() - (await stat(lock)).mtimeMs < 30_000; }
      catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        else if ((probe as NodeJS.ErrnoException).code === 'ENOENT') { try { alive = Date.now() - (await stat(lock)).mtimeMs < 30_000; } catch { alive = false; } }
      }
      if (alive) return busy();
      await options.beforeStaleLockTakeover?.();
      // No other worker can replace this directory between PID read and rm.
      await rm(lock, { recursive: true }); await mkdir(lock);
    }
    if ((await lstat(lock)).isSymbolicLink()) throw new Error('Блокировка подготовки стала ссылкой. Подготовка остановлена.');
    await writeFile(join(lock, 'pid'), String(process.pid), { flag: 'wx' });
  } finally { await rmdir(claim); }
  async function releaseOwnedLock() {
    // Cancellation does not cancel cleanup; a busy/crashed claim fails closed.
    if (!await claimLock(true)) return;
    try {
      if ((await lstat(lock)).isSymbolicLink()) throw new Error('Блокировка подготовки стала ссылкой. Подготовка остановлена.');
      if (await readFile(join(lock, 'pid'), 'utf8') === String(process.pid)) await rm(lock, { recursive: true });
    } finally { await rmdir(claim); }
  }
  let retainLock = false;
  async function save() { const temp = join(root, 'status-' + process.pid + '.tmp'); await writeFile(temp, JSON.stringify(view)); await rename(temp, join(root, 'status.json')); options.progress?.(view); }
  async function step(name: string, message: string) { view = { ...view, status: 'preparing', step: name, message }; await save(); signal.throwIfAborted(); }
  async function refresh() { await (options.refresh ?? (() => toolchain.refresh()))().catch(() => { signal.throwIfAborted(); }); }
  async function externalInstaller<T>(work: () => Promise<T>): Promise<T> {
    // Existing status is the crash fence. A dead orchestration worker does not
    // prove an external installer stopped; persist this BEFORE invoking it.
    view = { ...view, installerUncertain: true }; retainLock = true; await save();
    try {
      const result = await work();
      view = { ...view, installerUncertain: false }; await save(); retainLock = false;
      return result;
    } catch (error) {
      if (!(error as { cleanupPending?: boolean }).cleanupPending) {
        // The runner confirmed exit (including a confirmed cancellation).
        view = { ...view, installerUncertain: false }; await save(); retainLock = false;
      }
      throw error;
    }
  }
  async function install(id: string, name: string) {
    await step(name, `Устанавливаю ${name}. Если Windows покажет системный запрос, подтверди его.`);
    const winget = resolve('winget.exe'); if (!winget) throw new Error(`WinGet недоступен. Установи ${name} вручную и повтори подготовку.`);
    await externalInstaller(() => run(winget, ['install', '--id', id, '--exact', '--source', 'winget', '--no-upgrade', '--silent',
      '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], signal, { timeoutMs: 10 * 60_000, env }));
    signal.throwIfAborted(); await refresh();
  }
  try {
    // The initial inspect can predate another worker's installer. This read is
    // authoritative under our exclusive main lock and precedes EVERY status
    // write. Preserve the persisted bytes and the lock if work is unfinished.
    const currentStatus = await readStatus(root);
    if (unfinishedInstaller(currentStatus)) {
      retainLock = true;
      return fenceRepair({ ...view, installerUncertain: true }, options.context);
    }
    await step('probe', 'Проверяю необходимые компоненты компьютера.'); await refresh();
    if (view.requirements!.includes('python') && !view.python && platform === 'win32') {
      await install('Python.Python.3.13', 'Python'); view = await inspectRuntime(root, options.context ?? null, signal, options);
    }
    if (view.requirements!.includes('python') && !view.python) throw new Error('Python 3.10+ не запускается. Установи Python и повтори подготовку.');
    if (platform === 'win32' && view.requirements!.includes('bash') && !view.bash) {
      await install('Git.Git', 'Git for Windows с Git Bash'); view = await inspectRuntime(root, options.context ?? null, signal, options);
      if (!view.bash) throw new Error('Git Bash не запускается. Проверь Git for Windows и повтори подготовку.');
    }
    if (platform === 'win32' && view.requirements!.includes('node') && (!view.node || !view.versions?.npm)) {
      await step('node', 'Проверяю Node.js и npm для установщика.');
      const node = await externalInstaller(async () => options.portableNode
        ? await (options.portable ?? (signal => ensureKimiRuntime(join(root, 'portable', 'runtime'), signal, { forceManaged: true })))(signal)
        : await (options.node ?? (signal => ensureWindowsNode(signal)))(signal));
      if (!node) throw new Error('Нужен рабочий Node.js 22+ с npm. Установи его или выбери переносимый резерв: bb svaib-workplace runtime prepare --portable-node.');
      view.node = node.executable; view.npmCli = node.npmCli; view.versions = { ...view.versions, node: node.version }; await save();
    }
    if (view.python && view.requirements!.includes('python')) {
      const bin = join(root, 'bin'); await mkdir(bin, { recursive: true });
      if ((await lstat(bin)).isSymbolicLink()) throw new Error('Папка launcher стала ссылкой. Существующие файлы сохранены.');
      for (const name of platform === 'win32' ? ['python3', 'python3.cmd'] : ['python3']) {
        try { if ((await lstat(join(bin, name))).isSymbolicLink()) throw new Error('Launcher стал ссылкой. Существующие файлы сохранены.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const quoted = (platform === 'win32' ? view.python.replaceAll('\\', '/') : view.python).replaceAll("'", "'\\''");
      await writeFile(join(bin, 'python3'), `#!/bin/sh\nexec '${quoted}' "$@"\n`, { mode: 0o700 });
      await chmod(join(bin, 'python3'), 0o700);
      if (platform === 'win32') await writeFile(join(bin, 'python3.cmd'), '@"%SVAIB_PYTHON%" %*\r\n');
      // Include known installation directories even before the parent BB gets a new PATH.
      view.path = platform === 'win32' ? [bin, win32.dirname(view.python), ...(view.git ? [win32.dirname(view.git)] : []), ...(view.bash ? [win32.dirname(view.bash)] : []),
        ...(view.node ? [win32.dirname(view.node)] : []), variable(env, 'PATH') ?? ''].join(';')
        : [...new Set([bin, dirname(view.python), ...(variable(env, 'PATH') ?? '').split(delimiter)])].join(delimiter); await save();
    }
    view = await inspectRuntime(root, options.context ?? null, signal, { ...options, env: { ...env, ...(view.python ? { SVAIB_PYTHON: view.python } : {}), ...(view.path ? { PATH: view.path } : {}) } });
    // A successful operation replaces only its history; no failure is a lasting gate.
    delete view.operationError; await save(); return view;
  } catch (error) {
    retainLock ||= (error as { cleanupPending?: boolean }).cleanupPending === true;
    view = { ...view, platform, status: 'failed', message: signal.aborted ? 'Подготовка отменена. Повтор запускается кнопкой «Подготовить» или CLI prepare --retry.'
      : `${error instanceof Error ? error.message : 'Подготовка не завершена.'} Для повтора: bb svaib-workplace runtime prepare --retry.` };
    if (retainLock) view = { ...view, step: 'cleanup', installerUncertain: true, message: 'Завершение установщика не подтверждено. Второй установщик не запущен. Проверь завершение процесса в Windows; подготовка требует технического восстановления.' };
    await save(); return view;
  } finally { if (!retainLock) await releaseOwnedLock(); }
}
