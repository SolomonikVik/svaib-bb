import { spawn } from 'node:child_process';
import { lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { provision, resumeProvision, registration, npmCliPath, ADAPTER } from './scripts/setup-kimi-cc.mjs';
import { kimiAgentSchema } from './kimi-contract';

/** The only commands run by setup: a bounded Node probe and pinned npm install. */
export function kimiCommand(executable: string, args: string[], signal: AbortSignal, capture = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { signal, shell: false, windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Установка не завершилась. Проверь интернет и повтори этот шаг.')); }, capture ? 5_000 : 180_000);
    child.stdout?.on('data', chunk => {
      output += String(chunk);
      if (output.length > 4096) { child.kill(); reject(new Error('Не удалось проверить Node.js.')); }
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Не удалось запустить Node.js или npm.')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output); else reject(new Error('Установка не завершилась. Проверь интернет и повтори этот шаг.'));
    });
  });
}
async function node(signal: AbortSignal) {
  try {
    const result = JSON.parse(await kimiCommand(process.platform === 'win32' ? 'node.exe' : 'node', ['-p', 'JSON.stringify({executable:process.execPath,version:process.versions.node})'], signal, true));
    if (typeof result.executable !== 'string' || typeof result.version !== 'string') return null;
    return result as { executable: string; version: string };
  } catch { return null; }
}
async function regular(path: string, directory = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.size > 32_768)) throw new Error('Профиль настройки изменён. Ничего не перезаписано.');
}
export async function inspectKimi(root: string, signal: AbortSignal) {
  const runtime = await node(signal);
  let npmReady = false;
  if (runtime) { try { await npmCliPath(runtime.executable); npmReady = true; } catch { /* Manual prerequisite. */ } }
  const base = { nodeReady: Boolean(runtime && npmReady && Number(runtime.version.split('.')[0]) >= 22), nodeVersion: runtime?.version ?? null };
  try { await regular(root, true); }
  catch (error) {
    return { ...base, profile: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' as const : 'blocked' as const, agent: null };
  }
  try {
    await regular(join(root, 'setup-owner.json'));
    const owner = JSON.parse(await readFile(join(root, 'setup-owner.json'), 'utf8'));
    if (owner.schema !== 1 || owner.adapter !== ADAPTER || typeof owner.nodeExecutable !== 'string') throw new Error();
    try { await regular(join(root, 'bb-agent.json')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...base, profile: 'partial' as const, agent: null };
      throw error;
    }
    const agent = kimiAgentSchema.parse(JSON.parse(await readFile(join(root, 'bb-agent.json'), 'utf8')));
    if (JSON.stringify(agent) !== JSON.stringify(registration(root, owner.nodeExecutable))) throw new Error();
    return { ...base, profile: 'ready' as const, agent };
  } catch { return { ...base, profile: 'blocked' as const, agent: null }; }
}
export async function prepareKimi(root: string, apiKey: string | undefined, signal: AbortSignal) {
  signal.throwIfAborted();
  const status = await inspectKimi(root, signal);
  if (!status.nodeReady) throw new Error('Установи Node.js 22 или новее и повтори проверку.');
  if (status.profile === 'ready') return status.agent!;
  if (status.profile === 'blocked') throw new Error('Папка настройки изменена. Существующие файлы сохранены; нужна помощь партнёра.');
  const install = async (executable: string, args: string[]) => { await kimiCommand(executable, args, signal); };
  if (status.profile === 'partial') return resumeProvision({ root, install });
  if (!apiKey) throw new Error('Введи ключ из консоли Kimi Code.');
  const runtime = await node(signal);
  if (!runtime) throw new Error('Не удалось проверить Node.js.');
  return provision({ root, apiKey, install, nodeExecutable: runtime.executable });
}

export async function replaceKimiKey(root: string, apiKey: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!/^sk-kimi-[A-Za-z0-9_-]+$/.test(apiKey)) throw new Error('Нужен ключ из консоли Kimi Code.');
  const status = await inspectKimi(root, signal);
  if (status.profile !== 'ready') throw new Error('Собственный профиль настройщика не найден.');
  await regular(join(root, 'credentials.json'));
  signal.throwIfAborted();
  const temporary = join(root, '.key-' + randomUUID());
  try {
    await writeFile(temporary, JSON.stringify({ apiKey }), { mode: 0o600, flag: 'wx' });
    signal.throwIfAborted();
    await rename(temporary, join(root, 'credentials.json'));
  } finally { await rm(temporary, { force: true }); }
}
