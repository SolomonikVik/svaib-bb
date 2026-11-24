import { spawn } from 'node:child_process';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { browserContract } from './browser-contract';
import { nativeHookAutomatic } from './hook-native';
import { dirname, join } from 'node:path';
import { inspectMigratedKimi, prepareKimi, refreshKimiCatalog, replaceKimiKey } from '../kimi-host';
import { inspectKimiPi, prepareKimiPi } from '../kimi-pi-host';
import { inspectNativeKimiPi, prepareNativeKimiPi } from '../kimi-pi-native';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { kimiDiagnostics, kimiDiagnosticSignals, kimiStep } from '../kimi-diagnostics';
import { logKimiRuntime } from '../kimi-runtime-diagnostics';
import { prepareKimiRuntime } from '../kimi-runtime-preparation';
import { inspectRuntime, prepareRuntime, cancelRuntime } from '../runtime-preparation';
import { runtimeSignals } from '../runtime-contract';
import { prepareStandalonePath, profilePath, standaloneRoot } from '../standalone-paths';
import { maintainHarness } from '../harness-maintenance';
import { onboardingContract } from '../onboarding-contract';
import { runtimeEnvironment } from '../runtime-preparation';
import { persistHookEnvironment } from '../persistent-environment';
import { spawnNativeCommand } from '../native-command';
import { experimental_hostToolchain as toolchain } from '@get-bb/plugin-sdk/process';
import hookProbe from './hook-probe-source.json';

const maintenanceScope = (value: { provider: string; executable?: string; args?: string[] }) =>
  createHash('sha256').update(JSON.stringify([value.provider, value.executable, value.args])).digest('hex');
// The authorization URL never passes through a model, terminal or saved thread.
export default experimental_defineHostEntry({ contract: browserContract, experimental_signals: { ...kimiDiagnosticSignals, ...runtimeSignals }, handlers: {
  async computerPrepare(input, context) {
    const root = await prepareStandalonePath(context.experimental_paths.dataDir, 'runtime-preparation', context.signal);
    const view = await prepareRuntime(root, context.signal, { ...(input.context ? { context: input.context } : {}),
      progress: ({ platform, status, step, message, context: scope }) => context.experimental_emitSignal('runtimeProgress', { platform, status, step, message, context: scope }) });
    if (view.status !== 'ready') return view;
    await persistHookEnvironment(root, view, context.signal);
    let execution = input.context;
    const environment = toolchain.environment();
    let configRoot: string | undefined;
    if (execution?.provider === 'pi' && environment.BB_PI_BRIDGE_COMMAND) {
      const owned = await inspectKimiPi(await profilePath(context.experimental_paths.dataDir, 'kimi-pi'), context.signal);
      let args: unknown; try { args = JSON.parse(environment.BB_PI_BRIDGE_ARGS ?? '[]'); } catch { /* Unknown overrides are preserved. */ }
      if (!owned.registration || owned.registration.command !== environment.BB_PI_BRIDGE_COMMAND ||
        JSON.stringify(owned.registration.args) !== JSON.stringify(args) || owned.registration.agentDir !== environment.PI_CODING_AGENT_DIR)
        return { ...view, status: 'idle' as const, message: 'Пользовательский профиль Pi сохранён. Не удалось подтвердить его launcher для установки Harness.' };
      execution = { ...execution, executable: owned.registration.command, args: owned.registration.args };
      configRoot = owned.registration.agentDir;
    } else if (execution) configRoot = execution.provider === 'pi' ? environment.PI_CODING_AGENT_DIR
      : execution.provider === 'codex' ? environment.CODEX_HOME : execution.provider === 'claude-code' ? environment.CLAUDE_CONFIG_DIR : undefined;
    if (!execution?.executable || !input.cwd) return { ...view, status: 'idle' as const,
      message: 'Компоненты компьютера проверены. Для проверки установленного Harness открой рабочий разговор.' };
    try {
      const target = { ...execution, executable: execution.executable, cwd: input.cwd, ...(configRoot ? { configRoot } : {}) };
      const installed = await maintainHarness(target, { update: input.update, trust: input.trust, install: true }, context.signal,
        { legacyPluginRoot: dirname(context.experimental_paths.dataDir), persistentRoot: standaloneRoot() });
      if (!installed.pluginRoot) return { ...view, status: 'idle' as const, message: installed.message };
      await onboardingContract(installed.pluginRoot);
      await mkdir(context.experimental_paths.tempDir, { recursive: true, mode: 0o700 });
      const probePath = join(context.experimental_paths.tempDir, 'hook-probe-' + hookProbe.sha256 + '.py');
      try { await writeFile(probePath, hookProbe.source, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await lstat(probePath)).isSymbolicLink()
          || await readFile(probePath, 'utf8') !== hookProbe.source) throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const child = spawnNativeCommand(view.python!, [probePath,
          '--plugin-root', installed.pluginRoot!, ...(view.bash ? ['--bash', view.bash] : []),
          ...(process.platform === 'win32' && target.provider === 'codex' ? ['--powershell'] : []), ...(target.provider === 'pi' ? ['--pi'] : [])],
        { env: { ...process.env, ...runtimeEnvironment(view) }, signal: context.signal, shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        child.stdin.end(); child.stdout.resume();
        const timer = setTimeout(() => child.kill(), 90_000);
        child.once('error', () => { clearTimeout(timer); reject(new Error('Не удалось запустить проверку хуков.')); });
        child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Обработчики карты и учёта не прошли проверку. Проверь Python, PATH и установленный Harness.')); });
      });
      await writeFile(join(root, 'harness-status.json'), JSON.stringify({ scope: maintenanceScope(target), message: null }), { mode: 0o600 });
      return { ...view, message: 'Компоненты, карта пространства и учёт скиллов проверены запуском.' };
    } catch (error) { return { ...view, status: 'failed' as const, step: 'hooks', message: error instanceof Error ? error.message : 'Не удалось проверить Harness.' }; }
  },
  async runtimePrepare(input, context) {
    const root = await prepareStandalonePath(context.experimental_paths.dataDir, 'runtime-preparation', context.signal);
    const view = await prepareRuntime(root, context.signal, { ...input,
      progress: ({ platform, status, step, message, context: scope }) => context.experimental_emitSignal('runtimeProgress', { platform, status, step, message, context: scope }) });
    await persistHookEnvironment(root, view, context.signal); return view;
  },
  async runtimeInspect(input, context) {
    const root = await profilePath(context.experimental_paths.dataDir, 'runtime-preparation');
    const view = await inspectRuntime(root, input, context.signal);
    try {
      const path = join(root, 'harness-status.json'), info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink() && info.size < 4096) {
        const previous = JSON.parse(await readFile(path, 'utf8'));
        if (typeof previous.message === 'string' && (!input || previous.scope === maintenanceScope(input))) view.operationError = previous.message;
      }
    } catch { /* Maintenance history never controls a launch. */ }
    return view;
  },
  async runtimeCancel(_, context) { return cancelRuntime(await profilePath(context.experimental_paths.dataDir, 'runtime-preparation')); },
  async kimiPiNativePrerequisites(_, context) {
    const result = await prepareRuntime(await prepareStandalonePath(context.experimental_paths.dataDir, 'runtime-preparation', context.signal), context.signal, {
      context: { provider: 'pi', action: 'install', hooks: true },
      progress: ({ platform, status, step, message, context: scope }) => context.experimental_emitSignal('runtimeProgress', { platform, status, step, message, context: scope }),
    });
    if (result.status !== 'ready') throw new Error(result.message);
    return null;
  },
  async kimiPiNativeInspect(_, context) { return inspectNativeKimiPi(await profilePath(context.experimental_paths.dataDir, 'kimi-pi-native'), context.signal); },
  async kimiPiNativePrepare({ apiKey, replaceKey, diagnosticId }, context) {
    const log = kimiDiagnostics(diagnosticId ?? randomUUID(), 'host', event => context.experimental_emitSignal('kimiDiagnostic', event));
    const root = await prepareStandalonePath(context.experimental_paths.dataDir, 'kimi-pi-native', context.signal);
    return kimiStep(log, replaceKey ? 'key-replace' : 'prepare', () => prepareNativeKimiPi(root, apiKey, context.signal, log, { replaceKey }));
  },
  async kimiPiInspect(_, context) { return inspectKimiPi(await profilePath(context.experimental_paths.dataDir, 'kimi-pi'), context.signal); },
  async kimiPiPrepare({ apiKey, replaceKey, diagnosticId }, context) {
    const log = kimiDiagnostics(diagnosticId ?? randomUUID(), 'host', event => context.experimental_emitSignal('kimiDiagnostic', event));
    const root = await prepareStandalonePath(context.experimental_paths.dataDir, 'kimi-pi', context.signal);
    return kimiStep(log, replaceKey ? 'key-replace' : 'prepare', () => prepareKimiPi(root, apiKey, context.signal, log, { replaceKey }));
  },
  async kimiInspect(_, context) { return inspectMigratedKimi(await profilePath(context.experimental_paths.dataDir, 'kimi-cc'), join(context.experimental_paths.dataDir, 'kimi-cc'), context.signal); },
  async kimiPrepare({ apiKey, diagnosticId }, context) {
    const log = kimiDiagnostics(diagnosticId ?? randomUUID(), 'host', event => context.experimental_emitSignal('kimiDiagnostic', event));
    const root = await prepareStandalonePath(context.experimental_paths.dataDir, 'kimi-cc', context.signal);
    const runtimeRoot = await prepareStandalonePath(context.experimental_paths.dataDir, 'runtime-preparation', context.signal);
    try { return await kimiStep(log, 'prepare', () => prepareKimi(root, apiKey, context.signal, log, {
      ensureRuntime: (profileRoot, signal) => prepareKimiRuntime(runtimeRoot, profileRoot, signal, {
        progress: ({ platform, status, step, message, context: scope }) => context.experimental_emitSignal('runtimeProgress', { platform, status, step, message, context: scope }),
      }),
    })); }
    catch (error) { await logKimiRuntime(root, context.signal, log); throw error; }
  },
  async kimiRefreshCatalog({ diagnosticId }, context) {
    const log = kimiDiagnostics(diagnosticId ?? randomUUID(), 'host', event => context.experimental_emitSignal('kimiDiagnostic', event));
    return refreshKimiCatalog(await profilePath(context.experimental_paths.dataDir, 'kimi-cc'), context.signal, log);
  },
  async kimiReplaceKey({ apiKey, diagnosticId }, context) {
    const log = kimiDiagnostics(diagnosticId ?? randomUUID(), 'host', event => context.experimental_emitSignal('kimiDiagnostic', event));
    const root = await profilePath(context.experimental_paths.dataDir, 'kimi-cc');
    try { await kimiStep(log, 'key-replace', () => replaceKimiKey(root, apiKey, context.signal, fetch, log)); }
    finally { await logKimiRuntime(root, context.signal, log); }
    return null;
  },
  async automaticHooks(input, context) { return nativeHookAutomatic(input, context.signal); },
  async harnessMaintain({ target, options }, context) {
    const root = await profilePath(context.experimental_paths.dataDir, 'runtime-preparation');
    const record = async (message: string | null) => {
      await writeFile(join(root, 'harness-status.json'), JSON.stringify({ scope: maintenanceScope(target), message }), { mode: 0o600 }).catch(() => {});
    };
    try {
      const result = await maintainHarness(target, options, context.signal,
        { legacyPluginRoot: dirname(context.experimental_paths.dataDir), persistentRoot: standaloneRoot() });
      if (result.pluginRoot) await onboardingContract(result.pluginRoot);
      await record(result.pluginRoot ? null : result.message); return result;
    } catch (error) {
      await record(error instanceof Error ? error.message.slice(0, 1000) : 'Не удалось проверить Harness. Повтори подготовку.'); throw error;
    }
  },
  async openLogin({ url }) {
    const configured = process.env.BROWSER;
    const executable = configured && !/\s/.test(configured) ? configured
      : process.platform === 'darwin' ? '/usr/bin/open'
      : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const args = process.platform === 'win32' && executable === 'rundll32.exe' ? ['url.dll,FileProtocolHandler', url] : [url];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { detached: true, stdio: 'ignore', shell: false });
      child.once('error', () => reject(new Error('Не удалось открыть браузер для входа.')));
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    return null;
  },
} });
