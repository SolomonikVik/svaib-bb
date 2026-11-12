import { spawnNativeCommand, nativeStartupError } from '../../native-command';
import { experimental_killPortableProcess as killPortable } from '@get-bb/plugin-sdk/provider-bridge';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { approveHooks, inspectHooks } from './hook-trust';

/** A separate control process makes no model calls and never reads credential files. */
export async function withCodexHooks<T>(input: { executable: string; cwd: string }, signal: AbortSignal,
  operation: (rpc: (method: string, params: Record<string, unknown>) => Promise<any>) => Promise<T>,
  configRoot = join(homedir(), '.codex')): Promise<T> {
  if (!isAbsolute(input.executable) || !isAbsolute(input.cwd)) throw new Error('Не установлено рабочее место Codex.');
  if (process.env.CODEX_HOME && resolve(process.env.CODEX_HOME) !== configRoot) throw new Error('Нестандартный профиль Codex пока не поддерживается.');
  signal.throwIfAborted();
  const child = spawnNativeCommand(input.executable, ['app-server', '--stdio'], { cwd: input.cwd,
    env: { ...process.env, CODEX_HOME: configRoot }, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
  const reader = createInterface({ input: child.stdout });
  let closed = false;
  const closing = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve(); }));
  const waitForClose = async (milliseconds: number) => {
    if (closed) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([closing.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
    finally { clearTimeout(timer); }
  };
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let id = 0;
  let exited = false;
  const fail = (error = new Error('Не удалось связаться с Codex: stage=api.')) => { for (const item of pending.values()) item.reject(error); pending.clear(); };
  const stop = () => { fail(); child.stdin.end(); };
  signal.addEventListener('abort', stop, { once: true });
  child.once('error', error => fail(nativeStartupError(error, input.executable)));
  child.stdin.on('error', () => fail());
  child.stdout.on('error', () => fail());
  child.once('exit', () => { exited = true; fail(); });
  reader.on('line', line => {
    if (line.length > 2_000_000) { stop(); return; }
    let message: any; try { message = JSON.parse(line); } catch { stop(); return; }
    if (message.method && message.id != null) {
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'unsupported' } }) + '\n');
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error('Codex не выполнил проверку хуков.')); else entry.resolve(message.result);
  });
  const rpc = (method: string, params: Record<string, unknown>) => new Promise<any>((resolveCall, reject) => {
    if (exited || signal.aborted) { reject(new Error('Проверка хуков остановлена.')); return; }
    const requestId = ++id;
    pending.set(requestId, { resolve: resolveCall, reject });
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n', error => { if (error) { pending.delete(requestId); reject(new Error('Не удалось связаться с Codex.')); } });
  });
  const timeout = setTimeout(stop, 30_000);
  try {
    await rpc('initialize', { clientInfo: { name: 'svaib-hook-review', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    return await operation(rpc);
  } finally {
    clearTimeout(timeout); signal.removeEventListener('abort', stop); fail(); reader.close(); child.stdin.end();
    // EOF lets app-server finish any config write and releases a batch launcher's
    // working directory. Sending a signal alone does not confirm process exit.
    if (!await waitForClose(2000)) {
      killPortable(child, 'SIGTERM');
      if (!await waitForClose(3000)) {
        killPortable(child, 'SIGKILL');
        if (!await waitForClose(3000)) throw new Error('Завершение проверки Codex не подтверждено. Дождись выхода процесса перед повтором.');
      }
    }
  }
}

export const nativeHookAutomaticForProfile = (input: { executable: string; cwd: string }, signal: AbortSignal, configRoot: string) =>
  withCodexHooks(input, signal, async rpc => {
    const review = await inspectHooks(rpc, input.cwd);
    signal.throwIfAborted();
    const result = await approveHooks(rpc, input.cwd, review.fingerprint);
    return { ...result, changed: review.hooks.some(hook => hook.trustStatus !== 'trusted') };
  }, configRoot);

export const nativeHookAutomatic = (input: { executable: string; cwd: string }, signal: AbortSignal) =>
  nativeHookAutomaticForProfile(input, signal, join(homedir(), '.codex'));
