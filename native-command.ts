import { spawn, type SpawnOptions } from 'node:child_process';
import { win32 } from 'node:path';

const meta = /([()\][%!^"`<>&|;, *?])/g;
export function nativeStartupError(error: unknown, executable: string) {
  const raw = error as NodeJS.ErrnoException;
  const code = typeof raw?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(raw.code) ? raw.code : 'UNKNOWN';
  const syscall = typeof raw?.syscall === 'string' && /^[a-zA-Z]+$/.test(raw.syscall) ? raw.syscall : 'spawn';
  const extension = /\.(exe|cmd|bat)$/i.exec(executable)?.[1].toLowerCase() ?? 'native';
  return new Error(`Не удалось запустить Codex: stage=spawn host=${process.platform} launcher=${extension} code=${code} syscall=${syscall}. Проверь CLI в этом рабочем месте.`);
}
/** cmd.exe is used only for a batch launcher, with argv escaped at both boundaries.
 * The escaping follows cross-spawn's MIT-licensed Windows argument algorithm. */
export function nativeCommand(executable: string, args: string[], platform = process.platform,
  env: NodeJS.ProcessEnv = process.env) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) return { executable, args, windowsVerbatimArguments: false };
  if ([executable, ...args].some(value => /[\0\r\n]/.test(value))) throw new Error('Недопустимый аргумент Windows launcher.');
  const double = /node_modules[\\/]\.bin[\\/][^\\/]+\.(cmd|bat)$/i.test(executable);
  const escaped = args.map(value => {
    let arg = '"' + value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1') + '"';
    arg = arg.replace(meta, '^$1');
    return double ? arg.replace(meta, '^$1') : arg;
  });
  const command = win32.normalize(executable).replace(meta, '^$1');
  const systemRoot = Object.entries(env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1] ?? 'C:\\Windows';
  return { executable: win32.join(systemRoot, 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/v:off', '/c', '"' + [command, ...escaped].join(' ') + '"'], windowsVerbatimArguments: true };
}

export function spawnNativeCommand(executable: string, args: string[], options: SpawnOptions & { stdio: ['pipe', 'pipe', 'ignore'] }) {
  const command = nativeCommand(executable, args, process.platform, options.env);
  return spawn(command.executable, command.args, { ...options, shell: false,
    windowsVerbatimArguments: command.windowsVerbatimArguments });
}
