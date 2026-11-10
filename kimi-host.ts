import { spawn } from 'node:child_process';
import { lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, posix, win32 } from 'node:path';
import { provision, resumeProvision, registration, upgradeProvision, validateProvision, ADAPTER } from './scripts/setup-kimi-cc.mjs';
import { kimiAgentSchema } from './kimi-contract';
import { ensureKimiRuntime, existingKimiRuntime } from './kimi-runtime';
import { kimiStep, type KimiDiagnosticLog } from './kimi-diagnostics';

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

/** The only commands run by setup: a bounded Node probe and pinned npm install. */
export function kimiCommand(executable: string, args: string[], signal: AbortSignal, capture = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { signal, shell: false, windowsHide: true, env: kimiCommandEnvironment(executable), stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error('Установка не завершилась. Проверь интернет и повтори этот шаг.'), { name: 'TimeoutError' })); }, capture ? 5_000 : 180_000);
    child.stdout?.on('data', chunk => {
      output += String(chunk);
      if (output.length > 4096) { child.kill(); reject(new Error('Не удалось проверить Node.js.')); }
    });
    child.once('error', error => { clearTimeout(timer); reject(new Error('Не удалось запустить Node.js или npm.', { cause: error })); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(output); else reject(Object.assign(new Error('Установка не завершилась. Проверь интернет и повтори этот шаг.'), { exitCode: code, signal }));
    });
  });
}
async function node(signal: AbortSignal) {
  return existingKimiRuntime(signal);
}
async function regular(path: string, directory = false, maxBytes = 32_768) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.size > maxBytes)) throw new Error('Профиль настройки изменён. Ничего не перезаписано.');
}
export async function inspectKimi(root: string, signal: AbortSignal) {
  const runtime = await node(signal);
  const base = { nodeReady: Boolean(runtime), nodeVersion: runtime?.version ?? null };
  try { await regular(root, true); }
  catch (error) {
    return { ...base, profile: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' as const : 'blocked' as const, agent: null };
  }
  try {
    await regular(join(root, 'setup-owner.json'), false, 262_144);
    const owner = JSON.parse(await readFile(join(root, 'setup-owner.json'), 'utf8'));
    if (owner.schema !== 1 || owner.adapter !== ADAPTER || typeof owner.nodeExecutable !== 'string') throw new Error();
    try { await regular(join(root, 'bb-agent.json')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...base, profile: 'partial' as const, agent: null };
      throw error;
    }
    const agent = kimiAgentSchema.parse(JSON.parse(await readFile(join(root, 'bb-agent.json'), 'utf8')));
    if (![false, true, 'catalog' as const].some(legacy => JSON.stringify(agent) === JSON.stringify(registration(root, owner.nodeExecutable, legacy)))) throw new Error();
    let verifyModels: string[] = [];
    try {
      const { catalog } = await validateProvision(root);
      verifyModels = catalog.models.filter(model => !model.retired).map(model => model.id + (model.context >= 1_000_000 ? '[1m]' : ''));
    } catch { /* An unrecognized profile cannot supply a trusted verification model. */ }
    return { ...base, profile: 'ready' as const, agent, verifyModels };
  } catch { return { ...base, profile: 'blocked' as const, agent: null }; }
}
export async function prepareKimi(root: string, apiKey: string | undefined, signal: AbortSignal, log: KimiDiagnosticLog = () => {}) {
  signal.throwIfAborted();
  const status = await inspectKimi(root, signal);
  log('profile-inspect', 'success', { profile: status.profile });
  if (status.profile === 'ready') return upgradeProvision(root, { signal, log });
  if (status.profile === 'blocked') throw new Error('Папка настройки изменена. Существующие файлы сохранены; нужна помощь партнёра.');
  const install = async (executable: string, args: string[]) => { await kimiCommand(executable, args, signal); };
  const runtime = await kimiStep(log, 'runtime', () => ensureKimiRuntime(root, signal));
  if (status.profile === 'partial') return resumeProvision({ root, install, npmCli: runtime.npmCli, nodeExecutable: runtime.executable, signal, log });
  if (!apiKey) throw new Error('Введи ключ из консоли Kimi Code.');
  return provision({ root, apiKey, install, nodeExecutable: runtime.executable, npmCli: runtime.npmCli, signal, log });
}

export async function replaceKimiKey(root: string, apiKey: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch, log: KimiDiagnosticLog = () => {}) {
  signal.throwIfAborted();
  if (!/^sk-kimi-[A-Za-z0-9_-]+$/.test(apiKey)) throw new Error('Нужен ключ из консоли Kimi Code.');
  const status = await inspectKimi(root, signal);
  if (status.profile !== 'ready') throw new Error('Собственный профиль настройщика не найден.');
  await validateProvision(root);
  await regular(join(root, 'credentials.json'));
  // Publish conservative settings while the old key is still in place. Every
  // interruption after the key rename then leaves a recognized, safe profile.
  await upgradeProvision(root, { signal, restrictContext: true, log });
  signal.throwIfAborted();
  const temporary = join(root, '.key-' + randomUUID());
  try {
    await writeFile(temporary, JSON.stringify({ apiKey }), { mode: 0o600, flag: 'wx' });
    signal.throwIfAborted();
    await rename(temporary, join(root, 'credentials.json'));
    log('key-commit', 'success');
  } finally { await rm(temporary, { force: true }); }
  await upgradeProvision(root, { signal, fetchImpl, log });
}
