import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

const moduleUrl = new URL('../experiments/account-prototype/skills/svaib-workplace-connect/scripts/replace-pi-registration.mjs', import.meta.url);
const { replaceRegistration } = await import(moduleUrl.href);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'svaib Pi пробелы '));
  const old = join(root, 'old');
  const next = join(root, 'new');
  for (const path of [old, next]) {
    mkdirSync(path);
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'svaib-plugin' }));
  }
  const settingsPath = join(root, 'settings.json');
  const original = { packages: [{ source: './old', extensions: [], skills: ['skills/space-scaffold'],
    prompts: ['!private'], themes: [], autoload: false, futureField: { keep: true } }, 'npm:other'],
    defaultProvider: 'unchanged', otherSetting: { keep: true } };
  writeFileSync(settingsPath, JSON.stringify(original));
  return { root, old, next, settingsPath, original,
    options: { settingsPath, oldSource: './old', packageRoot: next },
    read: () => JSON.parse(readFileSync(settingsPath, 'utf8')),
    close: () => rmSync(root, { recursive: true, force: true }) };
}

test('Pi source replacement preserves every filter, other packages/settings and supports rollback', () => {
  const f = fixture();
  try {
    assert.deepEqual(replaceRegistration(f.options), { changed: true });
    assert.deepEqual(f.read(), { ...f.original, packages: [{ ...f.original.packages[0] as object, source: f.next }, 'npm:other'] });
    replaceRegistration({ ...f.options, oldSource: f.next, packageRoot: f.old });
    assert.deepEqual(f.read(), { ...f.original, packages: [{ ...f.original.packages[0] as object, source: f.old }, 'npm:other'] });
  } finally { f.close(); }
});

test('Pi legacy same source is a byte-preserving no-op and never removes registration', () => {
  const f = fixture();
  try {
    const before = readFileSync(f.settingsPath);
    assert.deepEqual(replaceRegistration({ ...f.options, packageRoot: f.old }), { changed: false });
    assert.deepEqual(readFileSync(f.settingsPath), before);
  } finally { f.close(); }
});

test('Pi replacement refuses duplicates, missing source and a busy native lock without writes', () => {
  const f = fixture();
  try {
    const before = readFileSync(f.settingsPath);
    assert.throws(() => replaceRegistration({ ...f.options, oldSource: 'missing' }));
    const release = lockfile.lockSync(f.settingsPath, { realpath: false });
    try { assert.throws(() => replaceRegistration(f.options)); } finally { release(); }
    assert.deepEqual(readFileSync(f.settingsPath), before);
    const duplicated = { ...f.original, packages: [...f.original.packages, f.next] };
    writeFileSync(f.settingsPath, JSON.stringify(duplicated));
    assert.throws(() => replaceRegistration(f.options));
    assert.deepEqual(f.read(), duplicated);
  } finally { f.close(); }
});

test('Pi failed persistence keeps the previous registration and releases its lock', () => {
  const f = fixture();
  try {
    const before = readFileSync(f.settingsPath);
    assert.throws(() => replaceRegistration(f.options, () => { throw new Error('disk failure'); }));
    assert.deepEqual(readFileSync(f.settingsPath), before);
    assert.deepEqual(replaceRegistration(f.options), { changed: true });
  } finally { f.close(); }
});

test('Pi project scope changes only its selected file; string registrations remain strings', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, '.pi'));
    const project = join(f.root, '.pi/settings.json');
    writeFileSync(project, JSON.stringify({ packages: ['../old'], editor: 'kept' }));
    replaceRegistration({ settingsPath: project, oldSource: '../old', packageRoot: f.next });
    assert.deepEqual(JSON.parse(readFileSync(project, 'utf8')), { packages: [f.next], editor: 'kept' });
    assert.deepEqual(f.read(), f.original);
  } finally { f.close(); }
});
