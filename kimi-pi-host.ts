import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { ensureKimiRuntime, type KimiRuntime } from './kimi-runtime';
import { installKimiAdapter, kimiCommandEnvironment } from './kimi-adapter-install';
import { type KimiDiagnosticLog } from './kimi-diagnostics';
import { isPiModelCredentialName, type KimiPiRegistration, type KimiPiStatus } from './kimi-pi-contract';

export const KIMI_PI_VERSION = '1.5.2';
export const KIMI_PI_PACKAGE = `@earendil-works/pi-coding-agent@${KIMI_PI_VERSION}`;
const packageParts = ['runtime', 'node_modules', '@earendil-works', 'pi-coding-agent'];
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ownerSchema = z.object({
  schema: z.literal(1), package: z.literal(KIMI_PI_PACKAGE), generation: z.uuid(),
  nodeExecutable: z.string().min(1), nodeHash: hash,
  launcherHash: hash, modelsHash: hash,
  authHash: hash.nullable(), pendingAuthHash: hash.optional(),
  runtime: z.object({ cliHash: hash, packageHash: hash }).strict().nullable(),
}).strict();
type Owner = z.infer<typeof ownerSchema>;
type Options = {
  replaceKey?: boolean;
  externalAgentDir?: string;
  externalEnvNames?: string[];
  ensureRuntime?: typeof ensureKimiRuntime;
  install?: typeof installKimiAdapter;
  verify?: typeof verifyKimiPiRuntime;
};
const noLog: KimiDiagnosticLog = () => {};
// The portable Node is immutable. Avoid rereading its large binary on each UI poll;
// any metadata change causes a fresh digest before trusting the owned registration.
const nodeDigests = new Map<string, { signature: string; hash: string }>();
const changed = () => new Error('Профиль Pi изменён. Существующие файлы сохранены; нужна помощь партнёра.');
const ownerPath = (root: string) => join(root, 'setup-owner.json');
const agentDir = (root: string) => join(root, 'agent');
export const kimiPiCli = (root: string) => join(root, ...packageParts, 'dist', 'bundle', 'cli.js');
const packagePath = (root: string) => join(root, ...packageParts, 'package.json');

async function regular(path: string, directory = false, limit = 262_144): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.size > limit)) throw changed();
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function privateWrite(path: string, value: string) {
  const temporary = path + '.' + randomUUID();
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const registration = (root: string, owner: Owner): KimiPiRegistration => ({
  command: owner.nodeExecutable, args: [join(root, 'launch.mjs'), owner.generation], agentDir: agentDir(root),
});
function launcher(root: string, executable: string) {
  const cli = kimiPiCli(root);
  return `// Owned Kimi/Pi launcher. The first argument is BB's stable profile generation.\n` +
    `import { dirname, delimiter } from 'node:path';\nimport { pathToFileURL } from 'node:url';\n` +
    `const cli = ${JSON.stringify(cli)};\n` +
    `process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(agentDir(root))};\n` +
    `const names = Object.keys(process.env).filter(name => process.platform === 'win32' ? name.toLowerCase() === 'path' : name === 'PATH');\n` +
    `const inherited = names.map(name => process.env[name]).filter(Boolean).join(delimiter);\n` +
    `for (const name of names) delete process.env[name];\n` +
    `process.env[process.platform === 'win32' ? 'Path' : 'PATH'] = dirname(${JSON.stringify(executable)}) + delimiter + inherited;\n` +
    `process.argv = [process.execPath, cli, ...process.argv.slice(3)];\n` +
    `await import(pathToFileURL(cli).href);\n`;
}
const models = json({ providers: { 'kimi-coding': { baseUrl: 'https://api.kimi.ai/coding/v1' } } });

/** Only metadata is inspected outside our profile; no external credentials are read. */
async function externalProfile(root: string, externalAgentDir?: string) {
  const external = resolve(externalAgentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'));
  if (external === resolve(agentDir(root))) return false;
  try {
    const stat = await lstat(external);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
    for (const name of await readdir(external)) {
      const entry = await lstat(join(external, name));
      // Native discovery creates these even before any login or user setup.
      if (name === 'sessions' && entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (name === 'auth.json' && entry.isFile() && !entry.isSymbolicLink() && entry.size <= 4) continue;
      return true;
    }
    return false;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; return true; }
}
async function fileHash(path: string, limit?: number): Promise<string | null> {
  if (!await regular(path, false, limit)) return null;
  return digest(await readFile(path));
}
async function nodeHash(path: string) {
  if (!await regular(path, false, 256 * 1024 * 1024)) throw changed();
  const info = await lstat(path);
  const signature = [info.size, info.mtimeMs, info.ctimeMs, info.ino].join(':');
  const previous = nodeDigests.get(path);
  if (previous?.signature === signature) return previous.hash;
  const value = digest(await readFile(path));
  if (nodeDigests.size >= 16) nodeDigests.delete(nodeDigests.keys().next().value!);
  nodeDigests.set(path, { signature, hash: value });
  return value;
}
async function readOwner(root: string): Promise<Owner | null> {
  if (!await regular(ownerPath(root))) return null;
  const parsed = ownerSchema.safeParse(JSON.parse(await readFile(ownerPath(root), 'utf8')));
  if (!parsed.success || !isAbsolute(parsed.data.nodeExecutable)) throw changed();
  return parsed.data;
}
async function validate(root: string, owner: Owner) {
  if (owner.launcherHash !== digest(launcher(root, owner.nodeExecutable))) throw changed();
  let complete = true;
  if (!await regular(owner.nodeExecutable, false, 256 * 1024 * 1024) || await nodeHash(owner.nodeExecutable) !== owner.nodeHash) complete = false;
  if (await regular(agentDir(root), true)) {
    for (const [path, expected] of [[join(root, 'launch.mjs'), owner.launcherHash], [join(agentDir(root), 'models.json'), owner.modelsHash]]) {
      const actual = await fileHash(path);
      if (actual === null) complete = false;
      else if (actual !== expected) complete = false;
    }
  } else complete = false;
  const authHash = await fileHash(join(agentDir(root), 'auth.json'));
  if (authHash !== null && authHash !== owner.authHash && authHash !== owner.pendingAuthHash) {
    const auth = JSON.parse(await readFile(join(agentDir(root), 'auth.json'), 'utf8'));
    if (!auth || typeof auth !== 'object' || Array.isArray(auth) || auth['kimi-coding']?.type !== 'api_key' || typeof auth['kimi-coding'].key !== 'string') throw changed();
    complete = false;
  }
  const pendingCommitted = owner.pendingAuthHash !== undefined && authHash === owner.pendingAuthHash;
  const needsKey = authHash === null || owner.pendingAuthHash !== undefined && !pendingCommitted;
  let runtimeComplete = false;
  if (owner.runtime) {
    const cliHash = await fileHash(kimiPiCli(root), 128 * 1024 * 1024);
    const packageHash = await fileHash(packagePath(root));
    runtimeComplete = cliHash === owner.runtime.cliHash && packageHash === owner.runtime.packageHash;
  }
  return { complete: complete && runtimeComplete && !needsKey && !owner.pendingAuthHash, needsKey, pendingCommitted, runtimeComplete };
}

export async function inspectKimiPi(root: string, signal: AbortSignal, options: Pick<Options, 'externalAgentDir' | 'externalEnvNames'> = {}): Promise<KimiPiStatus> {
  signal.throwIfAborted();
  const hasExternalProfile = (options.externalEnvNames ?? Object.keys(process.env)).some(isPiModelCredentialName)
    || await externalProfile(root, options.externalAgentDir);
  const status = (profile: KimiPiStatus['profile'], owner: Owner | null = null, needsKey = false): KimiPiStatus => ({
    profile, registration: owner ? registration(root, owner) : null, needsKey, hasExternalProfile,
  });
  try {
    if (!isAbsolute(root) || resolve(root) !== root) throw changed();
    if (!await regular(root, true)) return status('absent', null, true);
    const owner = await readOwner(root);
    if (!owner) return (await readdir(root)).every(name => name === '.profile-lock') ? status('absent', null, true) : status('blocked');
    const result = await validate(root, owner);
    return status(result.complete ? 'ready' : 'partial', owner, result.needsKey);
  } catch { return status('blocked'); }
}

/** No profile or extension is loaded: --version only, with a private probe directory. */
export async function verifyKimiPiRuntime(root: string, executable: string, signal: AbortSignal, log: KimiDiagnosticLog = noLog) {
  signal.throwIfAborted();
  if (!await regular(packagePath(root)) || !await regular(kimiPiCli(root), false, 128 * 1024 * 1024)) throw new Error('Компоненты Pi установлены не полностью. Повтори настройку.');
  const pkg = JSON.parse(await readFile(packagePath(root), 'utf8'));
  if (pkg.name !== '@earendil-works/pi-coding-agent' || pkg.version !== KIMI_PI_VERSION) throw changed();
  log('runtime-probe', 'start', { component: 'pi' });
  await new Promise<void>((resolveResult, reject) => {
    const child = spawn(executable, [kimiPiCli(root), '--version'], { shell: false, windowsHide: true, signal,
      cwd: root, env: { ...kimiCommandEnvironment(executable), PI_CODING_AGENT_DIR: join(root, '.probe-profile'), PI_OFFLINE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errorBytes = 0;
    child.stdout.on('data', data => { output += String(data); if (output.length > 8192) child.kill(); });
    child.stderr.on('data', data => { errorBytes += data.length; if (errorBytes > 8192) child.kill(); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Pi не запустился за 30 секунд. Повтори настройку.')); }, 30_000);
    child.once('error', () => { clearTimeout(timeout); reject(new Error('Не удалось запустить Pi. Повтори настройку.')); });
    child.once('close', code => { clearTimeout(timeout); code === 0 && output.trim() === KIMI_PI_VERSION ? resolveResult() : reject(new Error('Проверка запуска Pi не пройдена. Повтори настройку.')); });
  });
  log('runtime-probe', 'success', { component: 'pi', version: KIMI_PI_VERSION });
}

async function profileLock(root: string) {
  const directory = join(root, '.profile-lock');
  await mkdir(directory, { recursive: true, mode: 0o700 }); await regular(directory, true);
  const name = `${process.pid}-${randomUUID()}.lock`; const claim = join(directory, name);
  await writeFile(claim, '', { flag: 'wx', mode: 0o600 });
  const release = () => rm(claim, { force: true });
  try {
    for (const entry of await readdir(directory)) {
      if (entry === name) continue;
      const pid = entry.match(/^(\d+)-[a-f0-9-]{36}\.lock$/u)?.[1];
      if (!pid) throw changed();
      let alive = true;
      try { process.kill(Number(pid), 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      if (alive) throw new Error('Подготовка Pi уже идёт. Дождись её завершения и повтори.');
    }
    return release;
  } catch (error) { await release(); throw error; }
}

/** The only input carrying a key is this call. It never reaches argv, diagnostics or registration. */
export async function prepareKimiPi(root: string, apiKey: string | undefined, signal: AbortSignal,
  log: KimiDiagnosticLog = noLog, options: Options = {}): Promise<KimiPiRegistration> {
  signal.throwIfAborted();
  if (!isAbsolute(root) || resolve(root) !== root) throw changed();
  if (apiKey !== undefined && (!/^sk-kimi-[A-Za-z0-9_-]+$/.test(apiKey) || apiKey.length > 512)) throw new Error('Нужен ключ из консоли Kimi Code.');
  if (!await regular(root, true)) await mkdir(root, { mode: 0o700, recursive: true });
  const release = await profileLock(root);
  try {
    const status = await inspectKimiPi(root, signal, options);
    log('profile-inspect', 'success', { profile: status.profile });
    if (status.profile === 'blocked') throw changed();
    if (status.profile === 'absent' && !apiKey || status.needsKey && !apiKey) throw new Error('Введи ключ из консоли Kimi Code.');
    if (options.replaceKey && status.profile === 'absent') throw new Error('Собственный профиль Pi не найден.');
    if (status.profile === 'ready' && apiKey && !options.replaceKey) throw new Error('Pi уже настроен. Для нового ключа выбери «Заменить ключ».');
    const runtime: KimiRuntime = await (options.ensureRuntime ?? ensureKimiRuntime)(root, signal, { forceManaged: true, log });
    if (runtime.version !== '22.23.4') throw new Error('Для этого Pi нужен подготовленный Node.js 22.23.4.');
    let owner = await readOwner(root);
    if (!owner) {
      owner = { schema: 1, package: KIMI_PI_PACKAGE, generation: randomUUID(), nodeExecutable: runtime.executable,
        nodeHash: await nodeHash(runtime.executable), launcherHash: digest(launcher(root, runtime.executable)), modelsHash: digest(models), authHash: null, runtime: null };
      await privateWrite(ownerPath(root), json(owner));
    } else {
      owner.nodeExecutable = runtime.executable; owner.nodeHash = await nodeHash(runtime.executable);
      owner.launcherHash = digest(launcher(root, runtime.executable));
      const result = await validate(root, owner);
      if (result.pendingCommitted) {
        owner.authHash = owner.pendingAuthHash!; delete owner.pendingAuthHash;
        await privateWrite(ownerPath(root), json(owner));
      }
    }
    signal.throwIfAborted();
    if (!await regular(agentDir(root), true)) await mkdir(agentDir(root), { mode: 0o700 });
    // Marker-owned generated files may be repaired; native settings and auth remain.
    await regular(join(root, 'launch.mjs'));
    await privateWrite(join(root, 'launch.mjs'), launcher(root, runtime.executable));
    const modelsPath = join(agentDir(root), 'models.json');
    let currentModels: Record<string, any> = {};
    if (await regular(modelsPath)) {
      try { currentModels = JSON.parse(await readFile(modelsPath, 'utf8')); } catch {
        await privateWrite(modelsPath + '.before-repair-' + randomUUID(), await readFile(modelsPath, 'utf8'));
      }
    }
    if (!currentModels || typeof currentModels !== 'object' || Array.isArray(currentModels)) currentModels = {};
    const repairedModels = json({ ...currentModels, providers: { ...currentModels.providers, 'kimi-coding': {
      ...(currentModels.providers?.['kimi-coding'] ?? {}), baseUrl: 'https://api.kimi.ai/coding/v1' } } });
    await privateWrite(modelsPath, repairedModels);
    owner.modelsHash = digest(repairedModels);
    const existingAuthHash = await fileHash(join(agentDir(root), 'auth.json'));
    if (!apiKey && existingAuthHash !== null) owner.authHash = existingAuthHash;
    await privateWrite(ownerPath(root), json(owner));
    if (apiKey) {
      // Journal expected bytes before replacing auth, then finish even if the caller disconnects.
      // A killed process is recovered by comparing the two known hashes, never by printing auth.
      const authPath = join(agentDir(root), 'auth.json');
      const previousAuth = await regular(authPath) ? JSON.parse(await readFile(authPath, 'utf8')) : {};
      const auth = json({ ...previousAuth, 'kimi-coding': { type: 'api_key', key: apiKey } }); apiKey = undefined;
      owner.pendingAuthHash = digest(auth);
      await privateWrite(ownerPath(root), json(owner));
      await privateWrite(join(agentDir(root), 'auth.json'), auth);
      owner.authHash = owner.pendingAuthHash; delete owner.pendingAuthHash;
      await privateWrite(ownerPath(root), json(owner));
      log('key-commit', 'success');
    }
    signal.throwIfAborted();
    const verify = options.verify ?? verifyKimiPiRuntime;
    if (!(await validate(root, owner)).runtimeComplete) {
      log('adapter-install', 'start');
      const publishVerifier: typeof verifyKimiPiRuntime = async (candidate, executable, abort, diagnostic) => {
        await verify(candidate, executable, abort, diagnostic);
        if (candidate !== root) {
          // Commit the expected runtime bytes before the installer publishes its staging tree.
          // A killed process can then distinguish an owned partial publication from foreign files.
          owner!.runtime = { cliHash: digest(await readFile(kimiPiCli(candidate))), packageHash: digest(await readFile(packagePath(candidate))) };
          await privateWrite(ownerPath(root), json(owner));
        }
      };
      await (options.install ?? installKimiAdapter)(root, runtime.executable,
        [runtime.npmCli, 'install', '--prefix', join(root, 'runtime'), '--cache', join(root, 'npm-cache'), '--ignore-scripts', '--no-audit', '--no-fund', KIMI_PI_PACKAGE], signal, log, { verify: publishVerifier });
      log('adapter-install', 'success');
      owner.runtime = { cliHash: digest(await readFile(kimiPiCli(root))), packageHash: digest(await readFile(packagePath(root))) };
      await privateWrite(ownerPath(root), json(owner));
    } else await verify(root, runtime.executable, signal, log);
    if (!(await validate(root, owner)).complete) throw changed();
    return registration(root, owner);
  } finally { apiKey = undefined; await release(); }
}
