import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import lockfile from 'proper-lockfile';
import { ADAPTER, privateDirectory, repairProvision, validateProvision } from './scripts/setup-kimi-cc.mjs';
import { rebaseManagedKimiPi, validateManagedKimiPi } from './kimi-pi-host';
import { rebaseClaudeProfile, rebasePiSources } from './legacy-source-relocation';

/** User-owned state outlives the BB package and host-data directory. */
export const standaloneRoot = (home = homedir()) => join(home, '.svaib', 'workplace');
type Component = 'kimi-cc' | 'kimi-pi' | 'kimi-pi-native' | 'runtime-preparation';
async function exists(path: string) {
  try { const info = await lstat(path); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Папка рабочего места изменена. Файлы сохранены.'); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function pending(target: string): Promise<{ source: string } | null> {
  try {
    const path = join(target, '.migration-pending.json'), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('Маркер переноса профиля изменён.');
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (value.schema !== 1 || typeof value.source !== 'string') throw new Error('Маркер переноса профиля изменён.');
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function ownedBase(home: string) {
  const parent = join(home, '.svaib'), base = standaloneRoot(home);
  await mkdir(parent, { recursive: true, mode: 0o700 }); await exists(parent);
  await mkdir(base, { recursive: true, mode: 0o700 }); await exists(base);
  const marker = join(base, 'workplace-owner.json');
  try {
    const info = await lstat(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error('Неизвестный владелец постоянной папки рабочего места.');
    const value = JSON.parse(await readFile(marker, 'utf8'));
    if (value.schema !== 1 || value.owner !== 'svaib-workplace') throw new Error('Неизвестный владелец постоянной папки рабочего места.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if ((await readdir(base)).length) throw new Error('Постоянная папка занята чужими файлами. Файлы сохранены.');
    await writeFile(marker, JSON.stringify({ schema: 1, owner: 'svaib-workplace' }), { flag: 'wx', mode: 0o600 });
  }
  await privateDirectory(base);
  return base;
}
export async function profilePath(legacy: string, component: Component, home = homedir()) {
  const target = join(standaloneRoot(home), component), source = join(legacy, component);
  if (await exists(target)) {
    const marker = join(standaloneRoot(home), 'workplace-owner.json'), info = await lstat(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error('Неизвестный владелец постоянной папки рабочего места.');
    const owner = JSON.parse(await readFile(marker, 'utf8'));
    if (owner.schema !== 1 || owner.owner !== 'svaib-workplace') throw new Error('Неизвестный владелец постоянной папки рабочего места.');
    if (!await pending(target)) return target;
  }
  return await exists(source) ? source : target;
}

/** Explicit preparation only. Keep the old tree as recovery; never merge two live profiles. */
export async function prepareStandalonePath(legacy: string, component: Component, signal: AbortSignal, home = homedir()) {
  if (!isAbsolute(legacy) || !isAbsolute(home)) throw new Error('Нужен абсолютный путь рабочего места.');
  const base = standaloneRoot(home), target = join(base, component), source = join(legacy, component);
  await ownedBase(home);
  const release = await lockfile.lock(base, { realpath: false, lockfilePath: join(base, '.relocate-' + component + '.lock'), retries: 0 });
  try {
    signal.throwIfAborted();
    const present = await exists(target), incomplete = present ? await pending(target) : null;
    if (present && !incomplete || !await exists(source)) return target;
    if (incomplete && incomplete.source !== source) throw new Error('Незавершённый перенос принадлежит другому профилю.');
    if (component === 'kimi-cc') await validateProvision(source);
    if (component === 'kimi-pi') await validateManagedKimiPi(source, signal);
    if (!present) {
      await mkdir(target, { mode: 0o700 });
      await writeFile(join(target, '.migration-pending.json'), JSON.stringify({ schema: 1, source }), { flag: 'wx', mode: 0o600 });
    }
    await cp(source, target, { recursive: true, dereference: false, verbatimSymlinks: true, force: true });
    signal.throwIfAborted();
    if (component === 'kimi-cc' || component === 'kimi-pi') {
      const owner = JSON.parse(await readFile(join(target, 'setup-owner.json'), 'utf8'));
      if (owner.schema !== 1 || component === 'kimi-cc' && owner.adapter !== ADAPTER || typeof owner.nodeExecutable !== 'string') throw new Error('Неизвестный владелец профиля Kimi.');
      let executable = owner.nodeExecutable;
      const inside = relative(resolve(legacy), resolve(executable));
      if (inside && inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside)) {
        if (!inside.startsWith('node-runtime' + sep)) throw new Error('Runtime находится в неподдерживаемой служебной папке. Исходный профиль сохранён.');
        const runtime = join(base, 'node-runtime');
        if (!await exists(runtime)) await cp(join(legacy, 'node-runtime'), runtime, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true });
        executable = join(base, inside);
      }
      if (component === 'kimi-pi') {
        await rebaseManagedKimiPi(source, target, executable, signal);
        await rebasePiSources(join(target, 'agent', 'settings.json'), dirname(legacy), base,
          { copiedProfile: { source, target } });
      } else {
        await repairProvision(target, { signal, nodeExecutable: executable });
        await rebaseClaudeProfile(source, target, dirname(legacy), base); await validateProvision(target);
      }
    }
    await writeFile(join(target, 'migration-source.json'), JSON.stringify({ schema: 1, source }), { mode: 0o600 });
    await rm(join(target, '.migration-pending.json'));
    return target;
  } finally { await release(); }
}
