// Internal provisioning module for the BB Kimi card. Never put keys in BB settings.
import { access, chmod, lstat, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
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
function settings(legacy = false) {
  if (legacy) return { env: legacyEnv() };
  return { model: MODEL, effortLevel: 'high', availableModels: MODELS.map(([id]) => id),
    modelPicker: { replaceBuiltInOptions: true, options: MODELS.map(([model, label]) => ({ model, label })) },
    env: { ANTHROPIC_BASE_URL: 'https://api.kimi.ai/coding/', ANTHROPIC_MODEL: MODEL,
      ANTHROPIC_DEFAULT_FABLE_MODEL: MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
      CLAUDE_CODE_SUBAGENT_MODEL: MODEL,
      CLAUDE_CODE_MODEL_CAPABILITIES: 'k3*=effort,max_effort,-xhigh_effort;kimi-for-coding=effort,max_effort,-xhigh_effort;kimi-for-coding-highspeed=-effort,-max_effort,-xhigh_effort' } };
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

export async function provision({ root, apiKey, install = command, npmCli = null, nodeExecutable = process.execPath }) {
  if (!/^sk-kimi-[A-Za-z0-9_-]+$/.test(apiKey)) throw new Error('Ожидается ключ Kimi Code вида sk-kimi-…; значение не сохранено.');
  root = resolve(root);
  // A separate directory and exclusive writes preserve every existing profile.
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root, { mode: 0o700 });
  await privateDirectory(root);
  const configRoot = join(root, 'claude');
  await privateDirectory(configRoot);
  await writeFile(join(root, 'credentials.json'), JSON.stringify({ apiKey }), { mode: 0o600, flag: 'wx' });
  await writeFile(join(configRoot, 'settings.json'), JSON.stringify(settings(), null, 2), { mode: 0o600, flag: 'wx' });
  await writeFile(join(configRoot, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, penguinModeOrgEnabled: true }), { mode: 0o600, flag: 'wx' });
  await writeFile(join(root, 'setup-owner.json'), JSON.stringify({ schema: 1, adapter: ADAPTER, nodeExecutable }), { mode: 0o600, flag: 'wx' });
  return finishProvision({ root, install, npmCli, nodeExecutable });
}

// Only a profile created by this helper can resume a failed dependency download.
export async function resumeProvision({ root, install = command, npmCli = null, nodeExecutable = null }) {
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
  const result = await finishProvision({ root, install, npmCli, nodeExecutable: owner.nodeExecutable });
  return upgradeProvision(root).then(() => result);
}

async function finishProvision({ root, install, npmCli, nodeExecutable }) {
  const runtime = join(root, 'runtime');
  await install(nodeExecutable,
    [npmCli ?? await npmCliPath(nodeExecutable), 'install', '--prefix', runtime, '--no-audit', '--no-fund', ADAPTER]);
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

function launcherSource(root, legacy = false) {
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
  ${legacy ? "console.log('k3.1-pro[1m] - Kimi K3.1 Pro (1M)');" : MODELS.map(([id, label]) => `console.log(${JSON.stringify(id + ' - ' + label)});`).join('\n  ')}
} else {
  const apiKey = JSON.parse(readFileSync(join(root, 'credentials.json'), 'utf8')).apiKey;
  const settings = JSON.parse(readFileSync(join(root, 'claude', 'settings.json'), 'utf8'));
  const env = { ...process.env, ...settings.env, ANTHROPIC_API_KEY: apiKey, CLAUDE_CONFIG_DIR: join(root, 'claude') };
  ${legacy ? '' : "for (const name of ['ANTHROPIC_CUSTOM_MODEL_OPTION', 'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME', 'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION', 'ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_MODEL_CONFIG', 'MAX_THINKING_TOKENS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS']) delete env[name];\n  "}delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_EXECUTABLE;
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
export async function upgradeProvision(root) {
  for (const name of ['', 'setup-owner.json', 'claude', 'claude/settings.json', 'launch.mjs', 'bb-agent.json']) {
    if ((await lstat(join(root, name))).isSymbolicLink()) throw new Error('Профиль настройки изменён. Ничего не перезаписано.');
  }
  const owner = JSON.parse(await readFile(join(root, 'setup-owner.json'), 'utf8'));
  if (owner.schema !== 1 || owner.adapter !== ADAPTER) throw new Error('Неизвестный профиль настройки.');
  const files = [
    ['claude/settings.json', JSON.stringify(settings(true), null, 2), JSON.stringify(settings(), null, 2)],
    ['launch.mjs', launcherSource(root, true), launcherSource(root)],
    ['bb-agent.json', JSON.stringify(registration(root, owner.nodeExecutable, true), null, 2), JSON.stringify(registration(root, owner.nodeExecutable), null, 2)],
  ];
  const pending = [];
  for (const [name, before, after] of files) {
    const actual = await readFile(join(root, name), 'utf8');
    const interim = name === 'bb-agent.json' ? JSON.stringify(registration(root, owner.nodeExecutable, 'catalog'), null, 2) : null;
    if (actual !== before && actual !== after && actual !== interim) throw new Error('Профиль настройки изменён. Существующие файлы сохранены.');
    if (actual !== after) pending.push([name, after]);
  }
  for (const [name, after] of pending) {
    const temporary = join(root, name + '.upgrade');
    await writeFile(temporary, after, { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(root, name));
  }
  return registration(root, owner.nodeExecutable);
}
