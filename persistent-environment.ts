import { delimiter, isAbsolute, join, relative, sep, win32 } from 'node:path';
import { lstat, realpath, writeFile, link, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { spawnNativeCommand } from './native-command';
import type { RuntimeView } from './runtime-contract';

const marker = '# svaib standalone Python launcher\n';
async function systemPython(signal: AbortSignal, env: NodeJS.ProcessEnv) {
  return new Promise<boolean>(resolve => {
    const child = spawnNativeCommand('python3', ['-c', 'import sys;assert sys.version_info >= (3,10)'],
      { env, signal, shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    child.stdin.end(); child.stdout.resume();
    const timer = setTimeout(() => child.kill(), 10_000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

/** Install into an existing user PATH entry only; foreign commands are never replaced. */
async function posixLauncher(view: RuntimeView, signal: AbortSignal, env: NodeJS.ProcessEnv, home: string) {
  if (await systemPython(signal, env)) return;
  signal.throwIfAborted();
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const inside = relative(home, directory);
    if (inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) continue;
    let info; try { info = await lstat(directory); } catch { continue; }
    if (info.isSymbolicLink() || !info.isDirectory()) continue;
    const actual = relative(await realpath(home), await realpath(directory));
    if (actual === '..' || actual.startsWith('..' + sep) || isAbsolute(actual)) continue;
    const target = join(directory, 'python3');
    try {
      await lstat(target);
      continue;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    signal.throwIfAborted();
    const temporary = target + '.svaib-' + process.pid;
    try {
      await writeFile(temporary, '#!/bin/sh\n' + marker + "exec '" + view.python!.replaceAll("'", "'\\''") + "' \"$@\"\n", { mode: 0o700, flag: 'wx' });
      await link(temporary, target); // Exclusive publication, preserving a concurrent user command.
    } finally { await rm(temporary, { force: true }); }
    if (await systemPython(signal, env)) return;
  }
  throw new Error('Не удалось подготовить независимый python3 в пользовательском PATH. Исправь запуск Python и повтори подготовку.');
}

/** User environment persists independently of BB; the machine PATH is untouched. */
export async function persistHookEnvironment(root: string, view: RuntimeView, signal: AbortSignal,
  options: { env?: NodeJS.ProcessEnv; home?: string } = {}) {
  if (view.status !== 'ready' || !view.python) return;
  const env = options.env ?? process.env;
  if (process.platform !== 'win32') return posixLauncher(view, signal, env, options.home ?? homedir());
  const powershell = win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "$ErrorActionPreference='Stop'; $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); try { $bin=$env:SVAIB_RUNTIME_BIN; $old=$key.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $kind=if($key.GetValueNames() -contains 'Path'){$key.GetValueKind('Path')}else{[Microsoft.Win32.RegistryValueKind]::ExpandString}; $parts=@($old -split ';' | Where-Object { $_ -and $_ -ine $bin }); $key.SetValue('Path',(@($bin)+$parts -join ';'),$kind); $key.SetValue('SVAIB_PYTHON',$env:SVAIB_RUNTIME_PYTHON); if($env:SVAIB_RUNTIME_BASH){$key.SetValue('CLAUDE_CODE_GIT_BASH_PATH',$env:SVAIB_RUNTIME_BASH)} } finally { $key.Dispose() }";
  await new Promise<void>((resolve, reject) => {
    const child = spawnNativeCommand(powershell, ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...env, SVAIB_RUNTIME_BIN: join(root, 'bin'), SVAIB_RUNTIME_PYTHON: view.python,
        ...(view.bash ? { SVAIB_RUNTIME_BASH: view.bash } : {}) }, signal, shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    child.stdin.end(); child.stdout.resume();
    const timer = setTimeout(() => child.kill(), 15_000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Не удалось сохранить пользовательское окружение хуков.')); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Не удалось сохранить пользовательское окружение хуков.')); });
  });
}
