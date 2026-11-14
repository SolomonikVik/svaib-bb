// Replace one verified local Pi registration under Pi's own settings-file lock.
import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { isAbsolute, dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import lockfile from 'proper-lockfile';

function atomicWrite(path, text, mode) {
  const temporary = join(dirname(path), `.svaib-pi-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function replaceRegistration({ settingsPath, oldSource, packageRoot }, persist = atomicWrite) {
  if (!isAbsolute(settingsPath) || !isAbsolute(packageRoot) || !oldSource) {
    throw new Error('Explicit settings file, previous source and absolute packageRoot are required');
  }
  const info = lstatSync(settingsPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a regular settings file');
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== 'svaib-plugin') throw new Error('Expected the prepared svaib package');
  // Same path and lock options as native Pi. Read and replace inside the lock,
  // so concurrent native settings writes retain their unrelated changes.
  const release = lockfile.lockSync(settingsPath, { realpath: false });
  try {
    const text = readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(text);
    if (!settings || Array.isArray(settings) || typeof settings !== 'object' || !Array.isArray(settings.packages)) {
      throw new Error('Expected scoped Pi package registrations');
    }
    const source = entry => typeof entry === 'string' ? entry : entry?.source;
    const matches = settings.packages.map((entry, index) => source(entry) === oldSource ? index : -1).filter(index => index >= 0);
    if (matches.length !== 1) throw new Error('Expected exactly one previous registration');
    const index = matches[0];
    const samePath = value => typeof value === 'string' && !/^(npm:|git:|https?:)/.test(value)
      && resolve(dirname(settingsPath), value) === resolve(packageRoot);
    if (settings.packages.some((entry, other) => other !== index && samePath(source(entry)))) {
      throw new Error('The new source is already registered separately');
    }
    if (samePath(oldSource)) return { changed: false };
    const previous = settings.packages[index];
    settings.packages[index] = typeof previous === 'string' ? packageRoot : { ...previous, source: packageRoot };
    // Atomic replacement: a failed write leaves the previous registration usable.
    persist(settingsPath, JSON.stringify(settings, null, 2) + '\n', info.mode & 0o777);
    return { changed: true };
  } finally {
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      settings: { type: 'string' }, 'old-source': { type: 'string' }, 'package-root': { type: 'string' },
    } });
    console.log(JSON.stringify(replaceRegistration({
      settingsPath: values.settings ?? '', oldSource: values['old-source'], packageRoot: values['package-root'] ?? '',
    })));
  } catch {
    console.error('Pi registration replacement refused; preserve the previous profile and inspect the selected scope.');
    process.exitCode = 1;
  }
}
