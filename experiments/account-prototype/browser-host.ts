import { spawn } from 'node:child_process';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { browserContract } from './browser-contract';
import { nativeHookAutomatic } from './hook-native';
import { join } from 'node:path';
import { inspectKimi, prepareKimi, replaceKimiKey } from '../../kimi-host';
import { randomUUID } from 'node:crypto';
import { kimiDiagnostics, kimiDiagnosticSignals, kimiStep } from '../../kimi-diagnostics';

// The authorization URL never passes through a model, terminal or saved thread.
export default experimental_defineHostEntry({ contract: browserContract, experimental_signals: kimiDiagnosticSignals, handlers: {
  async kimiInspect(_, context) { return inspectKimi(join(context.experimental_paths.dataDir, 'kimi-cc'), context.signal); },
  async kimiPrepare({ apiKey, diagnosticId }, context) {
    const log = kimiDiagnostics(diagnosticId ?? randomUUID(), 'host', event => context.experimental_emitSignal('kimiDiagnostic', event));
    return kimiStep(log, 'prepare', () => prepareKimi(join(context.experimental_paths.dataDir, 'kimi-cc'), apiKey, context.signal, log));
  },
  async kimiReplaceKey({ apiKey, diagnosticId }, context) {
    const log = kimiDiagnostics(diagnosticId ?? randomUUID(), 'host', event => context.experimental_emitSignal('kimiDiagnostic', event));
    await kimiStep(log, 'key-replace', () => replaceKimiKey(join(context.experimental_paths.dataDir, 'kimi-cc'), apiKey, context.signal, fetch, log)); return null;
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
