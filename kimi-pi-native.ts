import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { experimental_hostToolchain as toolchain } from '@get-bb/plugin-sdk/process';
import { experimental_spawnPortableProcess as spawnPortable, experimental_killPortableProcess as killPortable } from '@get-bb/plugin-sdk/provider-bridge';
import lockfile from 'proper-lockfile';
import type { KimiDiagnosticLog } from './kimi-diagnostics';
import type { NativePiRegistration, NativePiStatus } from './kimi-pi-contract';

const PROVIDER = 'kimi-coding';
const BASE_URL = 'https://api.kimi.ai/coding/v1';
const MAX_CONFIG_BYTES = 1024 * 1024;
const noLog: KimiDiagnosticLog = () => {};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const problem = (code: string) => new Error(code);

type Owner = { schema: 1; agentDir: string; credentialHash: string | null; pendingHash?: string };
export type NativePiOptions = {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable executable discovery/probe keeps fixtures away from user profiles. */
  resolveRegistration?: (agentDir: string, signal: AbortSignal) => Promise<NativePiRegistration | null>;
  probeVersion?: (registration: NativePiRegistration, signal: AbortSignal) => Promise<string>;
  beforeWrite?: (step: 'models' | 'auth' | 'owner') => void | Promise<void>;
};

function profileDir(options: NativePiOptions) {
  const env = options.env ?? process.env;
  const value = options.agentDir ?? env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
  const expanded = value === '~' ? homedir() : value.startsWith('~/') || value.startsWith('~\\') ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(expanded)) throw problem('PI_NATIVE_PROFILE_BLOCKED');
  return resolve(expanded);
}
async function regular(path: string, directory = false) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.size > MAX_CONFIG_BYTES)) throw problem('PI_NATIVE_PROFILE_BLOCKED');
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function jsonFile(path: string): Promise<Record<string, any>> {
  if (!await regular(path)) return {};
  let value: unknown;
  try { value = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { throw problem('PI_NATIVE_PROFILE_BLOCKED'); }
  if (!record(value)) throw problem('PI_NATIVE_PROFILE_BLOCKED');
  return value;
}
function kimiModels(models: Record<string, any>) {
  if (models.providers !== undefined && !record(models.providers)) throw problem('PI_NATIVE_PROFILE_BLOCKED');
  const provider = models.providers?.[PROVIDER];
  if (provider !== undefined && !record(provider)) throw problem('PI_NATIVE_PROFILE_BLOCKED');
  return provider as Record<string, any> | undefined;
}
function kimiCredential(auth: Record<string, any>) {
  const credential = auth[PROVIDER];
  if (credential !== undefined && (!record(credential) || !['api_key', 'oauth'].includes(credential.type))) throw problem('PI_NATIVE_PROFILE_BLOCKED');
  if (credential?.type === 'api_key' && (typeof credential.key !== 'string' || !credential.key)) throw problem('PI_NATIVE_PROFILE_BLOCKED');
  return credential as Record<string, any> | undefined;
}
const ownerPath = (root: string, directory: string) => join(root, 'native-' + hash(directory) + '.json');
async function ownerFile(root: string, directory: string): Promise<Owner | null> {
  if (!await regular(root, true)) return null;
  const path = ownerPath(root, directory);
  if (!await regular(path)) return null;
  const owner = await jsonFile(path);
  if (owner.schema !== 1 || owner.agentDir !== directory
    || !(owner.credentialHash === null || /^[a-f0-9]{64}$/.test(owner.credentialHash))
    || owner.pendingHash !== undefined && !/^[a-f0-9]{64}$/.test(owner.pendingHash)
    || Object.keys(owner).some(key => !['schema', 'agentDir', 'credentialHash', 'pendingHash'].includes(key))) throw problem('PI_NATIVE_PROFILE_BLOCKED');
  return owner as Owner;
}
async function atomicJson(path: string, value: unknown) {
  const temporary = path + '.' + randomUUID();
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await regular(path);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
async function discover(directory: string, signal: AbortSignal): Promise<NativePiRegistration | null> {
  signal.throwIfAborted();
  await toolchain.refresh();
  const command = toolchain.resolve('pi');
  return command && isAbsolute(command) ? { command, args: [], agentDir: directory } : null;
}
async function version(registration: NativePiRegistration, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawnPortable({ command: registration.command, args: [...registration.args, '--version'],
      env: { ...process.env, PI_CODING_AGENT_DIR: registration.agentDir, PI_OFFLINE: '1' },
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let failure: Error | undefined; let settled = false;
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(cleanup); signal.removeEventListener('abort', abort);
      error ? reject(error) : resolveResult(output.trim());
    };
    const stop = (error: Error) => {
      if (failure || settled) return; failure = error;
      try {
        if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
        else killPortable(child, 'SIGKILL');
      } catch { /* Bounded close below. */ }
      cleanup = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); finish(error); }, 1000);
    };
    const abort = () => stop(problem('PI_NATIVE_PROBE_CANCELLED'));
    const timer = setTimeout(() => stop(problem('PI_NATIVE_PROBE_FAILED')), 30_000);
    child.stdout!.on('data', chunk => { output += String(chunk); if (output.length > 8192) stop(problem('PI_NATIVE_PROBE_FAILED')); });
    child.stderr!.on('data', () => {});
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('error', () => finish(problem('PI_NATIVE_PROBE_FAILED')));
    child.once('close', code => finish(failure ?? (code === 0 ? undefined : problem('PI_NATIVE_PROBE_FAILED'))));
  });
}
function supportedVersion(value: string) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 1 || major === 1 && (minor > 5 || minor === 5 && patch >= 1);
}
async function state(ownerRoot: string, directory: string, env: NodeJS.ProcessEnv) {
  await regular(directory, true);
  const auth = await jsonFile(join(directory, 'auth.json'));
  const credential = kimiCredential(auth);
  const owner = await ownerFile(ownerRoot, directory);
  const fingerprint = credential === undefined ? null : hash(credential);
  const owned = fingerprint !== null && !!owner && (owner.credentialHash === fingerprint || owner.pendingHash === fingerprint);
  const modelsPath = join(directory, 'models.json');
  const modelsRaw = await regular(modelsPath) ? await readFile(modelsPath) : null;
  let models: Record<string, any> = {}, provider: Record<string, any> | undefined, modelsDamaged = false;
  try {
    const parsed: unknown = modelsRaw === null ? {} : JSON.parse(modelsRaw.toString('utf8').replace(/^\uFEFF/, ''));
    if (!record(parsed)) throw problem('PI_NATIVE_PROFILE_BLOCKED');
    models = parsed;
    provider = kimiModels(models);
  } catch {
    if (!owned) throw problem('PI_NATIVE_PROFILE_BLOCKED');
    modelsDamaged = true;
    // Keep every parseable unrelated field/provider. Raw bytes are retained
    // before explicit repair when the generated transport cannot be parsed.
    if (!record(models.providers)) models = { ...models, providers: {} };
    else models = { ...models, providers: { ...models.providers } };
    delete models.providers[PROVIDER];
  }
  const needsRepair = owned && (modelsRaw === null || modelsDamaged || provider?.baseUrl !== BASE_URL)
    || provider?.baseUrl !== undefined && provider.baseUrl !== BASE_URL;
  if (needsRepair && !owned) throw problem('PI_NATIVE_PROFILE_BLOCKED');
  const externalKey = Object.keys(env).includes('KIMI_API_KEY') || provider?.apiKey !== undefined;
  return { auth, models, modelsRaw, modelsDamaged, credential, provider, owner, fingerprint, owned, hasCredential: credential !== undefined || externalKey, externalKey, needsRepair };
}

async function checkModelsSnapshot(path: string, before: Buffer | null) {
  const current = await regular(path) ? await readFile(path) : null;
  if (before === null ? current !== null : current === null || !current.equals(before)) throw problem('PI_NATIVE_PROFILE_CHANGED');
}

async function backupDamagedModels(path: string, current: { modelsRaw: Buffer | null; modelsDamaged: boolean }) {
  if (current.modelsDamaged && current.modelsRaw !== null) {
    await writeFile(path + '.before-repair-' + randomUUID(), current.modelsRaw, { mode: 0o600, flag: 'wx' });
  }
}

/** Inspect native CLI/profile without creating files or resolving credential values. */
export async function inspectNativeKimiPi(ownerRoot: string, signal: AbortSignal, options: NativePiOptions = {}): Promise<NativePiStatus> {
  signal.throwIfAborted();
  let registration: NativePiRegistration | null = null;
  try {
    const directory = profileDir(options);
    registration = await (options.resolveRegistration ?? discover)(directory, signal);
    const current = await state(ownerRoot, directory, options.env ?? process.env);
    if (!registration) return { installed: false, registration: null, profile: 'absent', hasCredential: current.hasCredential, canReplaceKey: false };
    if (!isAbsolute(registration.command) || registration.agentDir !== directory || !registration.args.every(arg => typeof arg === 'string')) throw problem('PI_NATIVE_PROFILE_BLOCKED');
    const cliVersion = await (options.probeVersion ?? version)(registration, signal);
    if (!supportedVersion(cliVersion)) throw problem('PI_NATIVE_VERSION_UNSUPPORTED');
    return { installed: true, registration, profile: current.hasCredential ? 'ready' : 'absent',
      hasCredential: current.hasCredential, canReplaceKey: current.owned && !current.externalKey, ...(current.needsRepair ? { needsRepair: true } : {}) };
  } catch {
    signal.throwIfAborted();
    return { installed: registration !== null, registration: null, profile: 'blocked', hasCredential: false, canReplaceKey: false };
  }
}

/** Add only Kimi fields in the actual native profile; native auth lock protects other providers. */
export async function prepareNativeKimiPi(ownerRoot: string, apiKey: string | undefined, signal: AbortSignal,
  log: KimiDiagnosticLog = noLog, options: NativePiOptions & { replaceKey?: boolean } = {}): Promise<NativePiRegistration> {
  signal.throwIfAborted();
  if (!isAbsolute(ownerRoot)) throw problem('PI_NATIVE_PROFILE_BLOCKED');
  if (apiKey !== undefined && (!/^sk-kimi-[A-Za-z0-9_-]+$/.test(apiKey) || apiKey.length > 512)) throw problem('PI_NATIVE_KEY_REQUIRED');
  const inspected = await inspectNativeKimiPi(ownerRoot, signal, options);
  if (!inspected.installed) throw problem('PI_NATIVE_NOT_INSTALLED');
  if (inspected.profile === 'blocked' || !inspected.registration) throw problem('PI_NATIVE_PROFILE_BLOCKED');
  const registration = inspected.registration; const directory = registration.agentDir;
  // An existing login or environment credential needs no writes, even a supplied key
  // must not silently replace it. Recheck under lock below before every mutation.
  if (inspected.hasCredential && !options.replaceKey && !inspected.needsRepair) return registration;
  if (!apiKey && !inspected.hasCredential) throw problem('PI_NATIVE_KEY_REQUIRED');
  if (!await regular(directory, true)) await mkdir(directory, { recursive: true, mode: 0o700 });
  const authPath = join(directory, 'auth.json'); const modelsPath = join(directory, 'models.json');
  // Match Pi's proper-lockfile(authPath) protocol. Exclusive creation never replaces a file.
  try { await writeFile(authPath, '{}\n', { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw problem('PI_NATIVE_PROFILE_BLOCKED'); }
  await regular(authPath);
  let compromised = false;
  let releaseAuth: (() => Promise<void>) | undefined; let releaseModels: (() => Promise<void>) | undefined;
  try {
    // Pi has synchronous readers using proper-lockfile's default 10s stale
    // threshold as well as its 30s async path; refresh inside both windows.
    releaseAuth = await lockfile.lock(authPath, { retries: 0, stale: 30_000, update: 5_000, onCompromised: () => { compromised = true; } });
    releaseModels = await lockfile.lock(modelsPath, { realpath: false, retries: 0, stale: 30_000, update: 5_000, onCompromised: () => { compromised = true; } });
    const check = () => { signal.throwIfAborted(); if (compromised) throw problem('PI_NATIVE_PROFILE_CHANGED'); };
    check();
    const current = await state(ownerRoot, directory, options.env ?? process.env);
    if (current.hasCredential && !options.replaceKey && !current.needsRepair) return registration;
    if (options.replaceKey && (!current.owned || current.externalKey)) throw problem('PI_NATIVE_PROFILE_CHANGED');
    if (current.needsRepair && !options.replaceKey) {
      if (!current.owned) throw problem('PI_NATIVE_PROFILE_CHANGED');
      await options.beforeWrite?.('models'); check();
      await checkModelsSnapshot(modelsPath, current.modelsRaw);
      await backupDamagedModels(modelsPath, current);
      await atomicJson(modelsPath, { ...current.models, providers: { ...current.models.providers,
        [PROVIDER]: { ...current.provider, baseUrl: BASE_URL } } });
      return registration;
    }
    if (!apiKey) throw problem('PI_NATIVE_KEY_REQUIRED');
    if (current.provider?.baseUrl !== undefined && current.provider.baseUrl !== BASE_URL && !current.owned) throw problem('PI_NATIVE_PROFILE_CHANGED');
    if (!await regular(ownerRoot, true)) await mkdir(ownerRoot, { recursive: true, mode: 0o700 });
    const nextCredential = { type: 'api_key', key: apiKey }; apiKey = undefined;
    const nextHash = hash(nextCredential);
    const owner: Owner = { schema: 1, agentDir: directory, credentialHash: current.fingerprint, pendingHash: nextHash };
    await atomicJson(ownerPath(ownerRoot, directory), owner);
    if (current.provider?.baseUrl !== BASE_URL) {
      await options.beforeWrite?.('models'); check();
      // Detect a manual editor that ignored the cooperative lock before publication.
      await checkModelsSnapshot(modelsPath, current.modelsRaw);
      await backupDamagedModels(modelsPath, current);
      const merged = { ...current.models, providers: { ...(current.models.providers ?? {}), [PROVIDER]: { ...(current.provider ?? {}), baseUrl: BASE_URL } } };
      await atomicJson(modelsPath, merged);
    }
    await options.beforeWrite?.('auth'); check();
    const latestAuth = await jsonFile(authPath);
    if (hash(kimiCredential(latestAuth) ?? null) !== hash(current.credential ?? null)) throw problem('PI_NATIVE_PROFILE_CHANGED');
    // Preserve unrelated credentials even if an editor added one while we held the lock.
    await atomicJson(authPath, { ...latestAuth, [PROVIDER]: nextCredential });
    await options.beforeWrite?.('owner'); check();
    await atomicJson(ownerPath(ownerRoot, directory), { schema: 1, agentDir: directory, credentialHash: nextHash });
    log('key-commit', 'success');
    return registration;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') throw problem('PI_NATIVE_BUSY');
    if (error instanceof Error && /^PI_NATIVE_[A-Z_]+$/.test(error.message)) throw error;
    throw problem('PI_NATIVE_PROFILE_BLOCKED');
  } finally { apiKey = undefined; try { await releaseModels?.(); } finally { await releaseAuth?.(); } }
}
