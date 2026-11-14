import { lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { provision, repairProvision, registration, upgradeProvision, validateProvision, npmCliPath, ADAPTER } from './scripts/setup-kimi-cc.mjs';
import { kimiAgentSchema, type KimiHostStatus } from './kimi-contract';
import { ensureKimiRuntime, existingKimiRuntime, probeKimiNode } from './kimi-runtime';
import { kimiStep, type KimiDiagnosticLog } from './kimi-diagnostics';
import { installKimiAdapter } from './kimi-adapter-install';
import { verifyKimiRuntime } from './kimi-runtime-diagnostics';
export { kimiCommandEnvironment } from './kimi-adapter-install';

async function node(signal: AbortSignal) {
  return existingKimiRuntime(signal);
}
async function regular(path: string, directory = false, maxBytes = 32_768) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.size > maxBytes)) throw new Error('Профиль настройки изменён. Ничего не перезаписано.');
}
export async function inspectKimi(root: string, signal: AbortSignal): Promise<KimiHostStatus> {
  const runtime = await node(signal);
  const base = { nodeReady: Boolean(runtime), nodeVersion: runtime?.version ?? null };
  try { await regular(root, true); }
  catch (error) {
    return { ...base, profile: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' as const : 'blocked' as const, agent: null, needsKey: (error as NodeJS.ErrnoException).code === 'ENOENT' };
  }
  let owned = false; let ownedAgent: ReturnType<typeof registration> | null = null;
  try {
    await regular(join(root, 'setup-owner.json'), false, 262_144);
    const owner = JSON.parse(await readFile(join(root, 'setup-owner.json'), 'utf8'));
    if (owner.schema !== 1 || owner.adapter !== ADAPTER || typeof owner.nodeExecutable !== 'string') throw new Error();
    owned = true; ownedAgent = registration(root, owner.nodeExecutable);
    // A missing/invalid secret is recoverable only in this marker-owned profile.
    // Links, directories and oversized files remain unsafe, rather than key entry.
    let needsKey = false;
    try { await regular(join(root, 'credentials.json')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ...base, profile: 'blocked' as const, agent: null, needsKey: false };
      needsKey = true;
    }
    if (!needsKey) {
      let credentialText: string;
      try { credentialText = await readFile(join(root, 'credentials.json'), 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ...base, profile: 'blocked' as const, agent: null, needsKey: false };
        credentialText = ''; needsKey = true;
      }
      try {
        const credentials = JSON.parse(credentialText);
        needsKey = !credentials || Array.isArray(credentials) || !/^sk-kimi-[A-Za-z0-9_-]+$/.test(credentials.apiKey);
      } catch { needsKey = true; }
    }
    if (needsKey) return { ...base, profile: 'partial' as const, agent: ownedAgent, needsKey: true };
    try { await regular(join(root, 'bb-agent.json')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...base, profile: 'partial' as const, agent: ownedAgent };
      throw error;
    }
    const agent = kimiAgentSchema.parse(JSON.parse(await readFile(join(root, 'bb-agent.json'), 'utf8')));
    if (![false, true, 'catalog' as const].some(legacy => JSON.stringify(agent) === JSON.stringify(registration(root, owner.nodeExecutable, legacy)))) throw new Error();
    let verifyModels: string[] = [];
    try {
      const { catalog } = await validateProvision(root);
      verifyModels = catalog.models.filter(model => !model.retired).map(model => model.id + (model.context >= 1_000_000 ? '[1m]' : ''));
    } catch { return { ...base, profile: 'partial' as const, agent: ownedAgent }; }
    return { ...base, profile: 'ready' as const, agent, verifyModels };
  } catch { return { ...base, profile: owned ? 'partial' as const : 'blocked' as const, agent: ownedAgent }; }
}
export async function prepareKimi(root: string, apiKey: string | undefined, signal: AbortSignal, log: KimiDiagnosticLog = () => {}, options: { ensureRuntime?: typeof ensureKimiRuntime; installAdapter?: typeof installKimiAdapter } = {}) {
  signal.throwIfAborted();
  const status = await inspectKimi(root, signal);
  log('profile-inspect', 'success', { profile: status.profile });
  if (status.profile === 'ready' || status.profile === 'partial') {
    if (status.needsKey && !apiKey) throw new Error('Введи ключ из консоли Kimi Code.');
    // A marker-owned profile may be rebuilt deterministically with today's
    // verified runtime. Keep credentials/native settings, regenerate launch files.
    const previousOwner = JSON.parse(await readFile(join(root, 'setup-owner.json'), 'utf8'));
    const runtime = await probeKimiNode(previousOwner.nodeExecutable, signal) ? { executable: previousOwner.nodeExecutable } : await (options.ensureRuntime ?? ensureKimiRuntime)(root, signal, { log });
    await repairProvision(root, { signal, log, nodeExecutable: runtime.executable, apiKey });
    await validateProvision(root);
    const owner = JSON.parse(await readFile(join(root, 'setup-owner.json'), 'utf8'));
    try { await verifyKimiRuntime(root, owner.nodeExecutable, signal, log); }
    catch (error) {
      signal.throwIfAborted();
      log('adapter-install', 'start', { reason: 'repair' });
      await (options.installAdapter ?? installKimiAdapter)(root, owner.nodeExecutable,
        [await npmCliPath(owner.nodeExecutable), 'install', '--prefix', join(root, 'runtime'), '--no-audit', '--no-fund', ADAPTER], signal, log);
      log('adapter-install', 'success', { reason: 'repair' });
    }
    return upgradeProvision(root, { signal, log });
  }
  if (status.profile === 'blocked') throw new Error('Неизвестный профиль настройки. Существующие файлы сохранены.');
  const install = async (executable: string, args: string[]) => { await installKimiAdapter(root, executable, args, signal, log); };
  const runtime = await kimiStep(log, 'runtime', () => (options.ensureRuntime ?? ensureKimiRuntime)(root, signal, { log }));
  if (!apiKey) throw new Error('Введи ключ из консоли Kimi Code.');
  return provision({ root, apiKey, install, nodeExecutable: runtime.executable, npmCli: runtime.npmCli, signal, log });
}

export async function replaceKimiKey(root: string, apiKey: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch, log: KimiDiagnosticLog = () => {}) {
  signal.throwIfAborted();
  if (!/^sk-kimi-[A-Za-z0-9_-]+$/.test(apiKey)) throw new Error('Нужен ключ из консоли Kimi Code.');
  const status = await inspectKimi(root, signal);
  if (status.profile !== 'ready') throw new Error('Собственный профиль настройщика не найден или изменён. Сначала восстанови его.');
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

/** Catalog maintenance never repairs/installs runtime or starts a model. */
export async function refreshKimiCatalog(root: string, signal: AbortSignal, log: KimiDiagnosticLog = () => {}) {
  signal.throwIfAborted();
  const status = await inspectKimi(root, signal);
  if (status.profile !== 'ready') throw new Error('Сначала восстанови собственный профиль Kimi.');
  return upgradeProvision(root, { signal, log });
}
