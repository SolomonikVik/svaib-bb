// Internal provisioning module for the BB Kimi card. Never put keys in BB settings.
import { access, chmod, lstat, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { dirname, join, relative, resolve, sep, win32 } from 'node:path';
import { spawn } from 'node:child_process';

export const ADAPTER = '@agentclientprotocol/claude-agent-acp@0.100.0';
const MODEL = 'k3.1-pro';
export const MODELS = [
  [MODEL, 'Kimi K3.1 Pro'], ['k3.1-pro-highspeed', 'Kimi K3.1 Pro Highspeed (больше квоты)'],
  ['k3', 'Kimi K3'], ['k3-256k', 'Kimi K3 256K'],
  ['kimi-for-coding', 'Kimi K2.8 Preview'], ['kimi-for-coding-highspeed', 'Kimi K2.7 Code Highspeed (больше квоты)'],
];
// Keep the previous generated form recognizable for owned-profile migration.
function catalogSettings(legacy = false) {
  if (legacy) return { env: legacyEnv() };
  return { model: MODEL, effortLevel: 'high', availableModels: MODELS.map(([id]) => id),
    modelPicker: { replaceBuiltInOptions: true, options: MODELS.map(([model, label]) => ({ model, label })) },
    env: { ANTHROPIC_BASE_URL: 'https://api.kimi.ai/coding/', ANTHROPIC_MODEL: MODEL,
      ANTHROPIC_DEFAULT_FABLE_MODEL: MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
      CLAUDE_CODE_SUBAGENT_MODEL: MODEL,
      CLAUDE_CODE_MODEL_CAPABILITIES: 'k3*=effort,max_effort,-xhigh_effort;kimi-for-coding=effort,max_effort,-xhigh_effort;kimi-for-coding-highspeed=-effort,-max_effort,-xhigh_effort' } };
}

const SHORT_WINDOW = 262144;
// Claude Code's [1m] switch means 1,000,000, below Kimi's 1,048,576 limit.
const LONG_WINDOW = 1000000;
const safePolicy = () => ({ shortWindow: SHORT_WINDOW, longModels: [] });

/** No model request, redirects, response/error logging, or unbounded waiting. */
async function fetchCatalog(apiKey, { fetchImpl = fetch, signal, log = () => {} } = {}) {
  const started = Date.now();
  const timeout = AbortSignal.timeout(8000);
  log('catalog-fetch', 'start');
  try {
    signal?.throwIfAborted();
    const response = await fetchImpl('https://api.kimi.ai/coding/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'svaib-workplace/kimi-setup' },
      redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      log('catalog-fetch', 'fallback', { reason: 'http-error', httpStatus: response.status, elapsedMs: Date.now() - started });
      await response.body?.cancel(); return null;
    }
    // The catalog is small. Bound the body as well as the request duration.
    let text = '';
    let bytes = 0;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 262144) { log('catalog-fetch', 'fallback', { reason: 'oversized', elapsedMs: Date.now() - started }); return null; }
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    const body = JSON.parse(text);
    log('catalog-fetch', 'success', { byteCount: bytes, elapsedMs: Date.now() - started });
    return body;
  } catch (error) {
    log('catalog-fetch', signal?.aborted ? 'failure' : 'fallback', {
      reason: signal?.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : error instanceof SyntaxError ? 'invalid-json' : 'network-error', elapsedMs: Date.now() - started,
    });
    signal?.throwIfAborted();
    return null;
  }
}

const modelIdPattern = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const reservedModels = new Set(['default', 'opus', 'sonnet', 'haiku', 'best', 'opusplan', '__proto__', 'constructor', 'prototype']);
function validId(id) { return typeof id === 'string' && modelIdPattern.test(id) && !reservedModels.has(id); }
function seedCatalog() {
  return { defaultModel: MODEL, models: MODELS.map(([id, label]) => ({ id, label, context: SHORT_WINDOW,
    effort: id !== 'kimi-for-coding-highspeed', maxEffort: id !== 'kimi-for-coding-highspeed', retired: false })) };
}

/** API additions need no local model registry; unknown capabilities stay disabled. */
export function parseCatalog(body) {
  if (!Array.isArray(body?.data) || !body.data.length || body.data.length > 128) return null;
  const models = [];
  const seen = new Set();
  for (const row of body.data) {
    if (!validId(row?.id) || seen.has(row.id)) return null;
    seen.add(row.id);
    const label = typeof row.display_name === 'string' ? row.display_name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) : row.id;
    const fixed256 = row.id === 'k3-256k' || row.id === 'kimi-for-coding-highspeed';
    const limits = [row.context_length, row.limit?.context].filter(value => Number.isSafeInteger(value) && value > 0);
    const context = limits.length ? Math.min(...limits, fixed256 ? SHORT_WINDOW : LONG_WINDOW) : SHORT_WINDOW;
    const levels = row.think_efforts?.support === false ? [] : row.think_efforts?.valid_efforts ?? row.reasoning?.effort?.valid;
    // CLI represents low/medium(high)/high and optionally max, not arbitrary enums.
    const effort = row.supports_reasoning !== false && Array.isArray(levels) && levels.includes('low') && levels.includes('high');
    models.push({ id: row.id, label: label || row.id, context, effort, maxEffort: effort && levels.includes('max'), retired: false });
  }
  return models;
}

function validCatalog(value) {
  return value && Array.isArray(value.models) && value.models.length > 0 && value.models.length <= 129
    && value.models.some(model => model.id === value.defaultModel)
    && new Set(value.models.map(model => model.id)).size === value.models.length
    && value.models.every(model => validId(model.id) && typeof model.label === 'string' && model.label.length <= 120
      && Number.isSafeInteger(model.context) && model.context > 0 && model.context <= LONG_WINDOW
      && typeof model.effort === 'boolean' && typeof model.maxEffort === 'boolean' && typeof model.retired === 'boolean');
}

export async function discoverCatalog(apiKey, previous = seedCatalog(), options = {}) {
  const body = await fetchCatalog(apiKey, options);
  const fresh = parseCatalog(body);
  const fallback = model => ({ ...model, context: Math.min(SHORT_WINDOW, model.context) });
  if (!fresh) {
    options.log?.('catalog-normalize', 'fallback', { reason: body === null ? 'cached' : 'invalid-catalog', modelCount: previous.models.length, longModelCount: 0 });
    return { ...previous, models: previous.models.map(fallback) };
  }
  options.log?.('catalog-normalize', 'success', { modelCount: fresh.length, longModelCount: fresh.filter(model => model.context >= LONG_WINDOW).length });
  if (options.initial) return { defaultModel: fresh.some(model => model.id === previous.defaultModel) ? previous.defaultModel : fresh[0].id, models: fresh };
  const selected = previous.models.find(model => model.id === previous.defaultModel);
  // A removed default stays visible as unavailable; never silently select a new model.
  if (selected && !fresh.some(model => model.id === selected.id)) fresh.push({ ...fallback(selected), retired: true });
  return { defaultModel: previous.defaultModel, models: fresh };
}

function dynamicSettings(catalog) {
  const base = catalogSettings();
  const shortWindow = Math.min(SHORT_WINDOW, ...catalog.models.filter(model => model.context < LONG_WINDOW).map(model => model.context));
  const modelId = id => catalog.models.find(model => model.id === id)?.context >= LONG_WINDOW ? `${id}[1m]` : id;
  const window = model => model.context >= LONG_WINDOW ? LONG_WINDOW : shortWindow;
  const defaultModel = modelId(catalog.defaultModel);
  return { ...base, model: defaultModel, availableModels: catalog.models.map(model => modelId(model.id)), availableModelsMatch: 'exact',
    modelPicker: { replaceBuiltInOptions: true, options: catalog.models.map(model => ({ model: modelId(model.id),
      label: `${model.label} (${window(model) === LONG_WINDOW ? '1M' : Math.floor(window(model) / 1024) + 'K'})`,
      ...(model.retired ? { description: 'Модель больше не доступна в каталоге Kimi. Выбери другую модель для нового разговора.' } : {}),
    })) },
    modelSettings: Object.fromEntries(catalog.models.map(model => [model.id, { autoCompactWindow: Math.max(100000, window(model)) }])),
    env: { ...base.env, ANTHROPIC_MODEL: defaultModel, ANTHROPIC_DEFAULT_FABLE_MODEL: defaultModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: defaultModel, ANTHROPIC_DEFAULT_SONNET_MODEL: defaultModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: defaultModel, CLAUDE_CODE_SUBAGENT_MODEL: defaultModel,
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(shortWindow),
      CLAUDE_CODE_MODEL_CAPABILITIES: catalog.models.map(model => `${model.id}=${model.effort ? '' : '-'}effort,${model.maxEffort ? '' : '-'}max_effort,-xhigh_effort`).join(';'),
    },
  };
}

function contextSettingsV2(policy = safePolicy()) {
  const base = catalogSettings();
  const modelId = id => policy.longModels.includes(id) ? `${id}[1m]` : id;
  const window = id => policy.longModels.includes(id) ? LONG_WINDOW : policy.shortWindow;
  return { ...base, model: modelId(MODEL), availableModels: MODELS.map(([id]) => modelId(id)),
    availableModelsMatch: 'exact',
    modelPicker: { replaceBuiltInOptions: true, options: MODELS.map(([id, label]) => ({
      model: modelId(id), label: `${label} (${window(id) === LONG_WINDOW ? '1M' : Math.floor(window(id) / 1024) + 'K'})`,
    })) },
    modelSettings: Object.fromEntries(MODELS.map(([id]) => [id, { autoCompactWindow: Math.max(100000, window(id)) }])),
    env: { ...base.env,
      ANTHROPIC_MODEL: modelId(MODEL), ANTHROPIC_DEFAULT_FABLE_MODEL: modelId(MODEL),
      ANTHROPIC_DEFAULT_OPUS_MODEL: modelId(MODEL), ANTHROPIC_DEFAULT_SONNET_MODEL: modelId(MODEL),
      ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId(MODEL), CLAUDE_CODE_SUBAGENT_MODEL: modelId(MODEL),
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(policy.shortWindow),
    },
  };
}

// Reconstruct only a byte-for-byte generated profile. Any user edit is preserved.
function generatedSettings(text) {
  if ([catalogSettings(), catalogSettings(true)].some(value => text === JSON.stringify(value, null, 2))) return true;
  try {
    const value = JSON.parse(text);
    const shortWindow = Number(value.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
    if (!Number.isSafeInteger(shortWindow) || shortWindow <= 0 || shortWindow > SHORT_WINDOW) return false;
    const longModels = MODELS.filter(([id]) => value.availableModels?.includes(`${id}[1m]`)).map(([id]) => id);
    return text === JSON.stringify(contextSettingsV2({ shortWindow, longModels }), null, 2);
  } catch { return false; }
}
function legacyEnv() {
  const MODEL = 'k3.1-pro[1m]';
  return { ANTHROPIC_BASE_URL: 'https://api.kimi.ai/coding/', ANTHROPIC_MODEL: MODEL,
    ANTHROPIC_CUSTOM_MODEL_OPTION: MODEL, ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'Kimi K3.1 Pro (1M)',
    CLAUDE_MODEL_CONFIG: JSON.stringify({ availableModels: [MODEL] }),
    ANTHROPIC_DEFAULT_FABLE_MODEL: MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: MODEL, CLAUDE_CODE_EFFORT_LEVEL: 'high', MAX_THINKING_TOKENS: '16384',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1048576', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1048576' };
}

function command(executable, args, options = {}) {
  return new Promise((yes, no) => {
    const child = spawn(executable, args, { stdio: 'inherit', ...options });
    child.once('error', () => no(new Error('Не удалось запустить установку. Проверь Node.js 22+ и npm.')));
    child.once('exit', code => code === 0 ? yes() : no(new Error(`Установка завершилась с кодом ${code}. Сохрани текущий шаг и передай помощнику текст ошибки без ключа.`)));
  });
}

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink()) throw new Error('Папка профиля не должна быть символической ссылкой.');
  if (process.platform === 'win32') {
    // Set the ACL before writing the key. Do not rely on POSIX mode on Windows.
    const systemRoot = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'systemroot')?.[1] ?? 'C:\\Windows';
    await command(win32.join(systemRoot, 'System32', 'icacls.exe'), [path, '/inheritance:r', '/grant:r', `${userInfo().username}:(OI)(CI)F`], { stdio: 'ignore' });
  } else await chmod(path, 0o700);
}

export function registration(root, executable = process.execPath, legacy = false) {
  const launcher = join(root, 'launch.mjs');
  const skills = relative(homedir(), join(root, 'claude', 'skills'));
  return { id: 'claude-kimi', displayName: 'Kimi (CC)', command: executable,
    args: [launcher], ...(legacy ? { modelCli: { listArgs: [launcher, '--list-models'], primaryModels: [legacy === true ? 'k3.1-pro[1m]' : MODEL] } } : {}),
    nativeSkillRoots: { user: skills.startsWith('..') ? [] : [skills.split(sep).join('/')],
      project: ['.claude/skills', '.agents/skills'].map(path => ({ path, recursive: true, ancestors: true })) } };
}

export async function npmCliPath(nodeExecutable = process.execPath) {
  const bin = dirname(nodeExecutable);
  for (const path of [join(bin, 'node_modules/npm/bin/npm-cli.js'),
    resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js']) {
    try { await access(path); return path; } catch { /* next supported Node installation */ }
  }
  throw new Error('npm не найден рядом с Node.js. Установи Node.js 22+ официальным установщиком с npm.');
}

export async function provision({ root, apiKey, install = command, npmCli = null, nodeExecutable = process.execPath, fetchImpl = fetch, signal, log = () => {} }) {
  if (!/^sk-kimi-[A-Za-z0-9_-]+$/.test(apiKey)) throw new Error('Ожидается ключ Kimi Code вида sk-kimi-…; значение не сохранено.');
  root = resolve(root);
  // A separate directory and exclusive writes preserve every existing profile.
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root, { mode: 0o700 });
  await privateDirectory(root);
  const configRoot = join(root, 'claude');
  await privateDirectory(configRoot);
  await writeFile(join(root, 'credentials.json'), JSON.stringify({ apiKey }), { mode: 0o600, flag: 'wx' });
  const initialCatalog = seedCatalog();
  await writeFile(join(configRoot, 'settings.json'), JSON.stringify(dynamicSettings(initialCatalog), null, 2), { mode: 0o600, flag: 'wx' });
  await writeFile(join(configRoot, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, penguinModeOrgEnabled: true }), { mode: 0o600, flag: 'wx' });
  await writeFile(join(root, 'setup-owner.json'), JSON.stringify({ schema: 1, adapter: ADAPTER, nodeExecutable, catalogs: [initialCatalog] }), { mode: 0o600, flag: 'wx' });
  await finishProvision({ root, install, npmCli, nodeExecutable, log });
  return upgradeProvision(root, { fetchImpl, signal, initial: true, log });
}

// Only a profile created by this helper can resume a failed dependency download.
export async function resumeProvision({ root, install = command, npmCli = null, nodeExecutable = null, fetchImpl = fetch, signal, log = () => {} }) {
  for (const name of ['', 'setup-owner.json', 'credentials.json', 'claude', 'claude/settings.json']) {
    if ((await lstat(join(root, name))).isSymbolicLink()) throw new Error('Профиль настройки изменён. Ничего не перезаписано.');
  }
  const owner = JSON.parse(await readFile(join(root, 'setup-owner.json'), 'utf8'));
  if (owner.schema !== 1 || owner.adapter !== ADAPTER || typeof owner.nodeExecutable !== 'string') throw new Error('Неизвестный профиль настройки.');
  if (nodeExecutable && nodeExecutable !== owner.nodeExecutable) {
    owner.nodeExecutable = nodeExecutable;
    const temporary = join(root, 'setup-owner.json.resume');
    await writeFile(temporary, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(root, 'setup-owner.json'));
  }
  await finishProvision({ root, install, npmCli, nodeExecutable: owner.nodeExecutable, log });
  return upgradeProvision(root, { fetchImpl, signal, initial: true, log });
}

async function finishProvision({ root, install, npmCli, nodeExecutable, log }) {
  const runtime = join(root, 'runtime');
  const started = Date.now(); log('adapter-install', 'start');
  try {
    await install(nodeExecutable,
      [npmCli ?? await npmCliPath(nodeExecutable), 'install', '--prefix', runtime, '--no-audit', '--no-fund', ADAPTER]);
    log('adapter-install', 'success', { elapsedMs: Date.now() - started });
  } catch (error) { log('adapter-install', 'failure', { reason: 'failed', elapsedMs: Date.now() - started }); throw error; }
  const launcher = launcherSource(root);
  await sameOrNew(join(root, 'launch.mjs'), launcher);
  const agent = registration(root, nodeExecutable);
  await sameOrNew(join(root, 'bb-agent.json'), JSON.stringify(agent, null, 2));
  return agent;
}

async function sameOrNew(path, content) {
  try { await writeFile(path, content, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || (await lstat(path)).isSymbolicLink() || await readFile(path, 'utf8') !== content) throw error;
  }
}

function launcherSource(root, legacy = false, previous = false) {
  const adapterDir = join(root, 'runtime', 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist');
  return `import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
const root = dirname(fileURLToPath(import.meta.url));
function run(command, args, env) {
  const child = spawn(command, args, { env, stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  child.once('error', () => { console.error('Компонент Kimi не запустился.'); process.exitCode = 1; });
  child.once('close', (code, signal) => {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
  });
}
if (process.argv.includes('--list-models')) {
  ${legacy ? "console.log('k3.1-pro[1m] - Kimi K3.1 Pro (1M)');" : previous ? MODELS.map(([id, label]) => `console.log(${JSON.stringify(id + ' - ' + label)});`).join('\n  ') : "const settings = JSON.parse(readFileSync(join(root, 'claude', 'settings.json'), 'utf8'));\n  for (const model of settings.modelPicker.options) console.log(model.model + ' - ' + model.label);"}
} else {
  const apiKey = JSON.parse(readFileSync(join(root, 'credentials.json'), 'utf8')).apiKey;
  const settings = JSON.parse(readFileSync(join(root, 'claude', 'settings.json'), 'utf8'));
  const env = { ...process.env, ...settings.env, ANTHROPIC_API_KEY: apiKey, CLAUDE_CONFIG_DIR: join(root, 'claude') };
  ${legacy ? '' : "for (const name of ['ANTHROPIC_CUSTOM_MODEL_OPTION', 'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME', 'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION', 'ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_MODEL_CONFIG', 'MAX_THINKING_TOKENS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS']) delete env[name];\n  "}delete env.ANTHROPIC_AUTH_TOKEN;
  ${legacy || previous === true ? '' : `// The 256K ceiling applies to plain IDs; [1m] is selected per model from the catalog.
  env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  delete env.DISABLE_COMPACT;
  delete env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  `}delete env.CLAUDE_CODE_EXECUTABLE;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  delete env.CLAUDE_CODE_USE_FOUNDRY;
  const adapterDir = ${JSON.stringify(adapterDir)};
  if (process.argv[2] === '--claude') {
    delete process.env.CLAUDE_CODE_EXECUTABLE;
    Object.assign(process.env, env);
    const { claudeCliPath } = await import(pathToFileURL(join(adapterDir, 'acp-agent.js')));
    const cli = await claudeCliPath();
    run(cli, process.argv.slice(3), env);
  } else {
    run(process.execPath, [join(adapterDir, 'index.js'), ...process.argv.slice(2)], env);
  }
}
`;
}

/** Upgrade only byte-for-byte generated files. Credentials and user edits are retained. */
export async function validateProvision(root) {
  for (const name of ['', 'setup-owner.json', 'credentials.json', 'claude', 'claude/settings.json', 'launch.mjs', 'bb-agent.json']) {
    if ((await lstat(join(root, name))).isSymbolicLink()) throw new Error('Профиль настройки изменён. Ничего не перезаписано.');
  }
  const ownerText = await readFile(join(root, 'setup-owner.json'), 'utf8');
  const owner = JSON.parse(ownerText);
  if (owner.schema !== 1 || owner.adapter !== ADAPTER) throw new Error('Неизвестный профиль настройки.');
  if (owner.catalogs !== undefined && (!Array.isArray(owner.catalogs) || owner.catalogs.length > 2 || !owner.catalogs.every(validCatalog))) throw new Error('Повреждён каталог настройки.');
  const files = [
    ['claude/settings.json', null, null],
    ['launch.mjs', launcherSource(root, true), launcherSource(root)],
    ['bb-agent.json', JSON.stringify(registration(root, owner.nodeExecutable, true), null, 2), JSON.stringify(registration(root, owner.nodeExecutable), null, 2)],
  ];
  const pending = [];
  const snapshots = [['setup-owner.json', ownerText]];
  let catalog;
  for (const [name, before, after] of files) {
    const actual = await readFile(join(root, name), 'utf8');
    snapshots.push([name, actual]);
    const interim = name === 'bb-agent.json' ? JSON.stringify(registration(root, owner.nodeExecutable, 'catalog'), null, 2) : null;
    if (name === 'claude/settings.json') catalog = owner.catalogs?.find(value => actual === JSON.stringify(dynamicSettings(value), null, 2));
    const known = name === 'claude/settings.json' ? !!catalog || generatedSettings(actual)
      : actual === before || actual === after || actual === interim || name === 'launch.mjs'
        && [true, 'context'].some(previous => actual === launcherSource(root, false, previous));
    if (!known) throw new Error('Профиль настройки изменён. Существующие файлы сохранены.');
    if (name === 'claude/settings.json') continue;
    if (actual !== after) pending.push([name, after]);
  }
  return { pending, owner, snapshots, catalog: catalog ?? seedCatalog() };
}

async function atomicWrite(path, content) {
  const temporary = path + '.upgrade-' + randomUUID();
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function upgradeProvision(root, { fetchImpl = fetch, signal, initial = false, restrictContext = false, log = () => {} } = {}) {
  log('profile-validate', 'start');
  let validated;
  try { validated = await validateProvision(root); }
  catch (error) { log('profile-validate', 'failure', { reason: 'failed' }); throw error; }
  const { pending, owner, snapshots, catalog: previous } = validated;
  log('profile-validate', 'success');
  const credentials = await readFile(join(root, 'credentials.json'), 'utf8');
  const { apiKey } = JSON.parse(credentials);
  const catalog = restrictContext
    ? { ...previous, models: previous.models.map(model => ({ ...model, context: Math.min(SHORT_WINDOW, model.context) })) }
    : await discoverCatalog(apiKey, previous, { fetchImpl, signal, initial, log });
  if (restrictContext) log('catalog-normalize', 'fallback', { reason: 'conservative', modelCount: catalog.models.length, longModelCount: 0 });
  signal?.throwIfAborted();
  const started = Date.now(); log('profile-write', 'start');
  try {
    // Network I/O must not open a window for overwriting edits or a replaced key.
    await validateProvision(root);
    for (const [name, before] of [...snapshots, ['credentials.json', credentials]]) {
      if (await readFile(join(root, name), 'utf8') !== before) throw new Error('Профиль изменился во время проверки контекста. Повтори настройку.');
    }
    // Journal both known generations first. A crash between file renames remains
    // recognizable, while an unrelated edit still fails the byte-for-byte check.
    const ownerPath = join(root, 'setup-owner.json');
    await atomicWrite(ownerPath, JSON.stringify({ ...owner, catalogs: [catalog, previous] }));
    pending.push(['claude/settings.json', JSON.stringify(dynamicSettings(catalog), null, 2)]);
    for (const [name, after] of pending) {
      await atomicWrite(join(root, name), after);
    }
    await atomicWrite(ownerPath, JSON.stringify({ ...owner, catalogs: [catalog] }));
    log('profile-write', 'success', { elapsedMs: Date.now() - started });
  } catch (error) { log('profile-write', 'failure', { reason: 'failed', elapsedMs: Date.now() - started }); throw error; }
  return registration(root, owner.nodeExecutable);
}
