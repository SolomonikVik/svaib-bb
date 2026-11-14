import { spawn } from 'node:child_process';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { browserContract } from './browser-contract';
import { nativeHookAutomatic } from './hook-native';
import { join } from 'node:path';
import { inspectKimi, prepareKimi, refreshKimiCatalog, replaceKimiKey } from '../../kimi-host';
import { inspectKimiPi, prepareKimiPi } from '../../kimi-pi-host';
import { inspectNativeKimiPi, prepareNativeKimiPi } from '../../kimi-pi-native';
import { randomUUID } from 'node:crypto';
import { kimiDiagnostics, kimiDiagnosticSignals, kimiStep } from '../../kimi-diagnostics';
import { logKimiRuntime } from '../../kimi-runtime-diagnostics';
import { prepareKimiRuntime } from '../../kimi-runtime-preparation';
import { inspectRuntime, prepareRuntime, cancelRuntime } from '../../runtime-preparation';
import { runtimeSignals } from '../../runtime-contract';

// The authorization URL never passes through a model, terminal or saved thread.
export default experimental_defineHostEntry({ contract: browserContract, experimental_signals: { ...kimiDiagnosticSignals, ...runtimeSignals }, handlers: {
  async runtimePrepare(input, context) {
    return prepareRuntime(join(context.experimental_paths.dataDir, 'runtime-preparation'), context.signal, { ...input,
      progress: ({ platform, status, step, message, context: scope }) => context.experimental_emitSignal('runtimeProgress', { platform, status, step, message, context: scope }) });
  },
  async runtimeInspect(input, context) { return inspectRuntime(join(context.experimental_paths.dataDir, 'runtime-preparation'), input, context.signal); },
  async runtimeCancel(_, context) { return cancelRuntime(join(context.experimental_paths.dataDir, 'runtime-preparation')); },
  async kimiPiNativePrerequisites(_, context) {
    const result = await prepareRuntime(join(context.experimental_paths.dataDir, 'runtime-preparation'), context.signal, {
      context: { provider: 'pi', action: 'install', hooks: true },
      progress: ({ platform, status, step, message, context: scope }) => context.experimental_emitSignal('runtimeProgress', { platform, status, step, message, context: scope }),
    });
    if (result.status !== 'ready') throw new Error(result.message);
    return null;
  },
  async kimiPiNativeInspect(_, context) { return inspectNativeKimiPi(join(context.experimental_paths.dataDir, 'kimi-pi-native'), context.signal); },
  async kimiPiNativePrepare({ apiKey, replaceKey, diagnosticId }, context) {
    const log = kimiDiagnostics(diagnosticId ?? randomUUID(), 'host', event => context.experimental_emitSignal('kimiDiagnostic', event));
    return kimiStep(log, replaceKey ? 'key-replace' : 'prepare', () => prepareNativeKimiPi(
      join(context.experimental_paths.dataDir, 'kimi-pi-native'), apiKey, context.signal, log, { replaceKey }));
  },
  async kimiPiInspect(_, context) { return inspectKimiPi(join(context.experimental_paths.dataDir, 'kimi-pi'), context.signal); },
  async kimiPiPrepare({ apiKey, replaceKey, diagnosticId }, context) {
    const log = kimiDiagnostics(diagnosticId ?? randomUUID(), 'host', event => context.experimental_emitSignal('kimiDiagnostic', event));
    return kimiStep(log, replaceKey ? 'key-replace' : 'prepare', () => prepareKimiPi(
      join(context.experimental_paths.dataDir, 'kimi-pi'), apiKey, context.signal, log, { replaceKey }));
  },
  async kimiInspect(_, context) { return inspectKimi(join(context.experimental_paths.dataDir, 'kimi-cc'), context.signal); },
  async kimiPrepare({ apiKey, diagnosticId }, context) {
    const log = kimiDiagnostics(diagnosticId ?? randomUUID(), 'host', event => context.experimental_emitSignal('kimiDiagnostic', event));
    const root = join(context.experimental_paths.dataDir, 'kimi-cc');
    try { return await kimiStep(log, 'prepare', () => prepareKimi(root, apiKey, context.signal, log, {
      ensureRuntime: (profileRoot, signal) => prepareKimiRuntime(join(context.experimental_paths.dataDir, 'runtime-preparation'), profileRoot, signal, {
        progress: ({ platform, status, step, message, context: scope }) => context.experimental_emitSignal('runtimeProgress', { platform, status, step, message, context: scope }),
      }),
    })); }
    catch (error) { await logKimiRuntime(root, context.signal, log); throw error; }
  },
  async kimiRefreshCatalog({ diagnosticId }, context) {
    const log = kimiDiagnostics(diagnosticId ?? randomUUID(), 'host', event => context.experimental_emitSignal('kimiDiagnostic', event));
    return refreshKimiCatalog(join(context.experimental_paths.dataDir, 'kimi-cc'), context.signal, log);
  },
  async kimiReplaceKey({ apiKey, diagnosticId }, context) {
    const log = kimiDiagnostics(diagnosticId ?? randomUUID(), 'host', event => context.experimental_emitSignal('kimiDiagnostic', event));
    const root = join(context.experimental_paths.dataDir, 'kimi-cc');
    try { await kimiStep(log, 'key-replace', () => replaceKimiKey(root, apiKey, context.signal, fetch, log)); }
    finally { await logKimiRuntime(root, context.signal, log); }
    return null;
  },
  async automaticHooks(input, context) { return nativeHookAutomatic(input, context.signal); },
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
