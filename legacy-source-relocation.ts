import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { replaceRegistration } from './scripts/replace-pi-registration.mjs';

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const inside = (root: string, path: string) => { const name = relative(root, path); return !!name && name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name); };
const hookCache = 'plugins/svaib/hooks/__pycache__';
const packagePath = (root: string, path: string) => relative(root, path).split(sep).join('/');
async function ownPiDependency(root: string, pkg: string) {
  // Native module resolution canonicalizes parent aliases (macOS /var -> /private/var).
  const dependency = createRequire(join(pkg, 'package.json')).resolve('pi-subagents');
  return inside(await realpath(root), await realpath(dependency));
}
async function object(path: string) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 2_000_000) throw new Error('Не удалось подтвердить владельца прежнего источника Harness.');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function verifyFiles(root: string, files: unknown) {
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Некорректная папка прежнего Harness.');
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Нет проверенного состава прежнего Harness.');
  const names = Object.keys(files);
  if (!names.length || names.length > 10000) throw new Error('Некорректный состав прежнего Harness.');
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name), name = packagePath(root, full);
      if (entry.isSymbolicLink()) throw new Error('Ссылка в прежнем источнике Harness.');
      // Older Pi hooks wrote bytecode for the modules in the owned manifest.
      if (entry.isDirectory() && name === hookCache) {
        for (const cache of await readdir(full, { withFileTypes: true })) {
          const module = /^(.+?)\.[\w-]+(?:\.opt-\d+)?\.pyc$/.exec(cache.name)?.[1];
          if (!cache.isFile() || !module || !names.includes(`plugins/svaib/hooks/${module}.py`))
            throw new Error('Чужой файл в кэше хуков Harness.');
        }
        continue;
      }
      if (entry.isDirectory()) { if (!names.some(key => key.startsWith(name + '/'))) throw new Error('Чужая папка в прежнем Harness.'); await walk(full); }
      else if (!names.includes(name)) throw new Error('Чужой файл в прежнем Harness.');
    }
  }
  await walk(root);
  for (const [name, expected] of Object.entries(files)) {
    const path = resolve(root, name);
    if (!inside(root, path) || !/^[a-f0-9]{64}$/.test(String(expected))) throw new Error('Некорректная граница прежнего Harness.');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_000_000 || digest(await readFile(path)) !== expected)
      throw new Error('Прежний источник Harness изменился. Он сохранён.');
  }
}
async function copyInstalled(source: string, target: string, identity: object, verify: (root: string) => Promise<void>) {
  const parent = dirname(target); await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await lstat(parent)).isSymbolicLink()) throw new Error('Постоянная папка источников стала ссылкой.');
  const release = await lockfile.lock(parent, { realpath: false, lockfilePath: target + '.lock', retries: 0 });
  try {
    const marker = target + '.owner.json', identityValue = { schema: 1, source, identity };
    let previous: any = null;
    try { previous = await object(marker); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous) {
      const { phase, ...saved } = previous;
      if (JSON.stringify(saved) !== JSON.stringify(identityValue)) throw new Error('Постоянная папка источника занята чужими файлами.');
    }
    let present = false;
    try { const info = await lstat(target); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Папка источника изменена.'); present = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (present && !previous) throw new Error('Постоянная папка источника занята чужими файлами.');
    if (present && previous.phase !== 'copying') { await verify(target); return target; }
    await verify(source);
    if (!previous) await writeFile(marker, JSON.stringify({ ...identityValue, phase: 'copying' }), { flag: 'wx', mode: 0o600 });
    await cp(source, target, { recursive: true, verbatimSymlinks: true, force: !!present, errorOnExist: !present,
      filter: path => {
        const name = packagePath(source, path);
        return basename(path) !== 'npm-cache' && name !== hookCache && name !== 'node_modules/svaib-plugin/' + hookCache;
      } });
    await verify(source); await verify(target);
    await writeFile(marker, JSON.stringify({ ...identityValue, phase: 'ready' }), { mode: 0o600 });
    return target;
  } finally { await release(); }
}

/** Relocate an already installed, hash-owned BB source; never download or choose a version. */
export async function relocateLegacyPackage(source: string, pluginRoot: string, persistentRoot: string): Promise<string | null> {
  if (!isAbsolute(source) || !inside(pluginRoot, source)) return null;
  const methods = join(pluginRoot, 'methods'), runtimes = join(pluginRoot, 'pi-runtimes');
  if (inside(methods, source) && dirname(source) === methods) {
    const owner = await object(join(methods, '.' + basename(source) + '.owner.json'));
    if (owner.schema !== 1 || owner.pluginId !== 'svaib-workplace' || !['claude', 'codex', 'pi'].includes(owner.provider)) throw new Error('Неизвестный владелец прежнего Harness.');
    return copyInstalled(source, join(persistentRoot, 'legacy-methods', basename(source)), owner, root => verifyFiles(root, owner.files));
  }
  if (inside(runtimes, source) && basename(source) === 'svaib-plugin' && basename(dirname(source)) === 'node_modules') {
    const generation = dirname(dirname(source)), version = (await object(join(source, 'package.json'))).version;
    if (dirname(generation) !== runtimes || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Неизвестная граница прежнего Pi runtime.');
    const ready = await object(join(runtimes, '.' + version + '.ready.json'));
    const owner = await object(join(methods, '.pi-' + version + '.owner.json'));
    if (ready.schema !== 1 || ready.pluginId !== 'svaib-workplace' || ready.directory !== basename(generation)
      || owner.schema !== 1 || owner.pluginId !== 'svaib-workplace' || owner.provider !== 'pi' || owner.version !== version) throw new Error('Неизвестный владелец прежнего Pi runtime.');
    const verify = async (root: string) => {
      const pkg = join(root, 'node_modules', 'svaib-plugin'); await verifyFiles(pkg, owner.files);
      if (!await ownPiDependency(root, pkg)) throw new Error('Зависимость Pi находится вне собственного runtime.');
    };
    const target = await copyInstalled(generation, join(persistentRoot, 'legacy-pi-runtimes', basename(generation)), { ready, owner }, verify);
    return join(target, 'node_modules', 'svaib-plugin');
  }
  return null;
}

/** Only a BB preparation receipt can identify a local marketplace as ours to switch. */
export async function ownedLegacyMarketplace(path: unknown, provider: 'codex' | 'claude', pluginRoot?: string, persistentRoot?: string) {
  if (typeof path !== 'string' || !isAbsolute(path)) return false;
  const old = pluginRoot && join(pluginRoot, 'methods', provider);
  const moved = persistentRoot && join(persistentRoot, 'legacy-methods', provider);
  if (path !== old && path !== moved) return false;
  let receipt;
  try { receipt = await object(path === old ? join(dirname(path), '.' + provider + '.owner.json') : path + '.owner.json'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  const owner = path === old ? receipt : receipt.phase === 'ready' && receipt.identity;
  if (owner?.schema !== 1 || owner?.pluginId !== 'svaib-workplace' || owner.provider !== provider) return false;
  await verifyFiles(path, owner.files);
  return true;
}

/** Native CC stores absolute cache paths. Rebase only the copied profile and owned old sources. */
export async function rebaseClaudeProfile(source: string, target: string, pluginRoot: string, persistentRoot: string) {
  const rebase = (value: unknown) => typeof value === 'string' && inside(source, value) ? join(target, relative(source, value)) : value;
  try { if ((await lstat(join(target, 'claude', 'plugins'))).isSymbolicLink()) throw new Error('Каталог native-плагинов стал ссылкой.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const name of ['installed_plugins.json', 'known_marketplaces.json']) {
    const path = join(target, 'claude', 'plugins', name);
    let doc: any; try { doc = await object(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (name === 'installed_plugins.json') {
      for (const rows of Object.values(doc.plugins ?? {})) if (Array.isArray(rows)) for (const row of rows) row.installPath = rebase(row.installPath);
    } else for (const [marketplace, item] of Object.entries(doc) as [string, any][]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      item.installLocation = rebase(item.installLocation);
      if (marketplace === 'svaib' && item.source?.source === 'directory' && typeof item.source.path === 'string') {
        const old = item.source.path, relocated = await relocateLegacyPackage(old, pluginRoot, persistentRoot);
        if (relocated) { item.source.path = relocated; if (item.installLocation === old) item.installLocation = relocated; }
      }
    }
    await writeFile(path, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  }
  const settingsPath = join(target, 'claude', 'settings.json'), settings = await object(settingsPath);
  const declaration = settings.extraKnownMarketplaces?.svaib?.source;
  if (declaration?.source === 'directory' && typeof declaration.path === 'string') {
    const relocated = await relocateLegacyPackage(declaration.path, pluginRoot, persistentRoot);
    if (relocated) { declaration.path = relocated; await writeFile(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 }); }
  }
}

export function piLocalSourcePath(settingsPath: string, source: string): string | undefined {
  const path = source.trim();
  if (!path || /^(npm|git|github|https?|ssh|builtin):/.test(path)) return;
  if (path.startsWith('file://')) {
    try { return fileURLToPath(path); } catch { return; }
  }
  if (path === '~') return homedir();
  if (path.startsWith('~/') || process.platform === 'win32' && path.startsWith('~\\')) return resolve(homedir(), path.slice(2));
  // Native Pi persists paths relative to the settings file, including bare paths
  // like vendor/methodology when the package lives inside the profile.
  return resolve(dirname(settingsPath), path);
}

export async function rebasePiSources(settingsPath: string, pluginRoot: string, persistentRoot: string,
  { beforeChange, copiedProfile }: { beforeChange?: (source: string) => Promise<void>; copiedProfile?: { source: string; target: string } } = {}) {
  let settings; try { settings = await object(settingsPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const fromSettings = copiedProfile ? join(copiedProfile.source, relative(copiedProfile.target, settingsPath)) : settingsPath;
  const packages = [...(settings.packages ?? [])];
  let changed = false;
  for (const [index, entry] of packages.entries()) {
    const source = typeof entry === 'string' ? entry : entry?.source;
    if (typeof source !== 'string') continue;
    const local = piLocalSourcePath(fromSettings, source);
    if (!local) continue;
    let target: string | null = null;
    if (inside(pluginRoot, local)) {
      await beforeChange?.(source);
      target = await relocateLegacyPackage(local, pluginRoot, persistentRoot);
    }
    if (copiedProfile) {
      const { source: from, target: to } = copiedProfile;
      target ??= local === from || inside(from, local) ? resolve(to, relative(from, local)) : local;
      if (target === piLocalSourcePath(settingsPath, source)) continue;
      packages[index] = typeof entry === 'string' ? target : { ...entry, source: target };
      changed = true;
    } else if (target) replaceRegistration({ settingsPath, oldSource: source, packageRoot: target });
  }
  // A copied profile is still staged under prepareStandalonePath's lock.
  if (changed) await writeFile(settingsPath, JSON.stringify({ ...settings, packages }, null, 2) + '\n');
}

export async function relocatedPiPackage(source: string, persistentRoot: string) {
  const runtimes = join(persistentRoot, 'legacy-pi-runtimes');
  if (!inside(runtimes, source) || basename(source) !== 'svaib-plugin' || basename(dirname(source)) !== 'node_modules') return false;
  const root = dirname(dirname(source)), marker = await object(root + '.owner.json');
  if (dirname(root) !== runtimes || marker.schema !== 1 || marker.identity?.owner?.pluginId !== 'svaib-workplace') return false;
  await verifyFiles(source, marker.identity.owner.files);
  return ownPiDependency(root, source);
}
