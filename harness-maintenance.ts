import { spawnNativeCommand } from './native-command';
import { nativeHookAutomaticForProfile, withCodexHooks } from './account/hook-native';
import { inspectHooks } from './account/hook-trust';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { ownedLegacyMarketplace, piLocalSourcePath, rebasePiSources, relocatedPiPackage } from './legacy-source-relocation';

import { experimental_hostToolchain as toolchain } from '@get-bb/plugin-sdk/process';
import { kimiPiCli } from './kimi-pi-host';
import { replaceRegistration } from './scripts/replace-pi-registration.mjs';
import { preserveCodexSkillChoices } from './codex-skill-preferences';
import { onboardingContract } from './onboarding-contract';
import { harnessInstallPreference } from './native-plugin-disabled';
import { HARNESS_SOURCE, PI_HARNESS_SOURCE } from './harness-source';
export { HARNESS_SOURCE, PI_HARNESS_SOURCE } from './harness-source';

export type HarnessTarget = { provider: 'codex' | 'claude-code' | 'acp-claude-kimi' | 'pi'; executable: string; args?: string[]; cwd: string; configRoot?: string };
export type MaintenanceResult = { state: 'installed' | 'updated' | 'checked' | 'unchanged' | 'skipped'; message: string; version?: string; pluginRoot?: string };
export type NativeRun = (args: string[], env: NodeJS.ProcessEnv) => Promise<unknown>;

/** Bounded native manager calls. No credentials, CLI output or model calls leave this process. */
export function nativeManager(target: HarnessTarget, signal: AbortSignal): NativeRun {
  return (args, env) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const prefix = target.args ?? [];
    const child = spawnNativeCommand(target.executable, [...prefix, ...(target.provider === 'acp-claude-kimi' ? ['--claude'] : []), ...args],
      { cwd: target.cwd, env, shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, signal });
    child.stdin.end();
    let output = '', overflow = false;
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on('data', bytes => { if (output.length + bytes.length > 2_000_000) { overflow = true; child.kill(); } else output += bytes.toString(); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Не удалось запустить штатный менеджер Harness.')); });
    child.once('close', code => { clearTimeout(timer);
      if (code !== 0 || overflow) {
        const marketplace = args.includes('marketplace') && (args.includes('add') || args.includes('upgrade') || args.includes('update'));
        return reject(new Error(marketplace
          ? 'Штатный менеджер не смог открыть или обновить marketplace svaib. Проверь доступ к репозиторию и повтори подготовку.'
          : 'Штатный менеджер не подтвердил операцию с Harness. Проверь его установленную версию в выбранном профиле и повтори подготовку.'));
      }
      if (target.provider === 'pi' && args[0] === 'list') return resolve(output);
      try { resolve(JSON.parse(output)); } catch {
        try { resolve(JSON.parse(output.trimEnd().split(/\r?\n/).pop()!)); } catch { resolve(null); }
      }
    });
  });
}

async function piIdle(signal: AbortSignal) {
  const windows = process.platform === 'win32';
  const executable = windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/ps';
  const args = windows ? ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -ne $PID} | ForEach-Object {"$($_.Name) $($_.CommandLine)"}']
    : ['-ww', '-eo', 'ucomm=,args='];
  return new Promise<boolean>((resolve, reject) => {
    const child = spawnNativeCommand(executable, args, { signal, shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    child.stdin.end(); let output = '', large = false;
    child.stdout.on('data', bytes => { if (output.length + bytes.length > 2_000_000) { large = true; child.kill(); } else output += bytes.toString(); });
    const timer = setTimeout(() => child.kill(), 10_000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Не удалось проверить окно обслуживания Pi.')); });
    child.once('close', code => { clearTimeout(timer); if (code !== 0 || large) return reject(new Error('Не удалось проверить окно обслуживания Pi.'));
      const rows = output.trim().split(/\r?\n/);
      if (!output.trim()) return reject(new Error('Не удалось проверить окно обслуживания Pi.'));
      resolve(!rows.some(line => {
        const [, name, args = ''] = /^\s*(\S+)\s*(.*)$/.exec(line) ?? [];
        // Pi sets process.title to "pi" after startup. Its original argv and
        // the profile selected inside a Kimi launcher can no longer be recovered.
        if (/^pi(?:\.exe)?$/i.test(name) || /^pi(?:\s|$)/.test(args)) return true;
        if (!/^(?:node|nodejs|bun)(?:\.exe)?$/i.test(name)) return false;
        if (windows && !args.trim()) return true; // CIM may hide a process's command line.
        return /@earendil-works[\\/]pi-coding-agent[\\/]|[\\/]pi(?:\.(?:cmd|exe))?["']?(?:\s|$)|[\\/]kimi-pi[\\/]launch\.mjs/.test(args);
      }));
    });
  });
}

async function piManifest(root: string) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'svaib-plugin' || !manifest.pi?.extensions?.includes('./plugins/svaib/pi/extension.ts')
    || !manifest.pi?.skills?.includes('./plugins/svaib/skills')) throw new Error('Установленный пакет Pi не соответствует Harness svaib.');
  createRequire(join(root, 'package.json')).resolve('pi-subagents');
  return manifest;
}

// Use the selected Pi's package manager for staging and resource filtering. Neither operation changes registrations.
const piPackageProgram = `
  import { join } from 'node:path';
  import { pathToFileURL } from 'node:url';
  const [cli, source, scope, action] = process.argv.slice(1);
  const sdk = await import(import.meta.resolve('@earendil-works/pi-coding-agent', pathToFileURL(cli).href));
  const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR;
  const projectTrusted = new sdk.ProjectTrustStore(agentDir).get(cwd) === true;
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: projectTrusted || action === 'filters' && scope === 'project' });
  const manager = new sdk.DefaultPackageManager({ cwd, agentDir, settingsManager });
  if (action === 'path') console.log(JSON.stringify({ root: manager.getInstalledPath(source, scope) }));
  else if (action === 'install' && scope === 'project' && !projectTrusted) console.log(JSON.stringify({ needsProjectTrust: true }));
  else if (action === 'install') {
    await manager.install(source, { local: scope === 'project' });
    console.log(JSON.stringify({ root: manager.getInstalledPath(source, scope) }));
  } else {
    const resources = await manager.resolve(async () => 'skip');
    const root = manager.getInstalledPath(source, scope);
    const enabled = (items, path) => root && items.some(item => item.enabled && item.path === join(root, path)
      && item.metadata.scope === scope && item.metadata.source === source);
    console.log(JSON.stringify({ enabled: Boolean(enabled(resources.extensions, 'plugins/svaib/pi/extension.ts')
      && enabled(resources.skills, 'plugins/svaib/skills/onboarding/SKILL.md')) }));
  }
`;
type PiPackageRequest = (target: HarnessTarget, env: NodeJS.ProcessEnv, signal: AbortSignal,
  source: string, project: boolean, action: 'install' | 'filters' | 'path') => Promise<{ root?: string; enabled?: boolean }>;
const piPackageRequest: PiPackageRequest = async (target, env, signal, source, project, action) => {
  const managed = target.args?.[0];
  const cli = managed ? kimiPiCli(dirname(managed)) : await realpath(target.executable);
  await toolchain.refresh();
  const node = managed ? target.executable : toolchain.resolve('node');
  if (!node || !isAbsolute(node)) throw new Error('Для проверки пакета Pi нужен Node выбранного профиля.');
  const run = nativeManager({ ...target, executable: node, args: [] }, signal);
  const result = await run(['--experimental-import-meta-resolve', '--input-type=module', '-e', piPackageProgram,
    cli, source, project ? 'project' : 'user', action], action === 'filters' ? { ...env, PI_OFFLINE: '1' } : env) as { root?: string; enabled?: boolean; needsProjectTrust?: boolean } | null;
  if (result?.needsProjectTrust) throw new Error('Для обслуживания пакета проекта Pi требуется сохранённое разрешение этого проекта в Pi.');
  if (!result) throw new Error('Штатный Pi не подтвердил состояние пакета.');
  return result;
};

async function piListing(run: NativeRun, env: NodeJS.ProcessEnv, source: string) {
  const output = await run(['list'], env);
  if (typeof output !== 'string') throw new Error('Не удалось прочитать штатный список пакетов Pi.');
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const index = lines.findIndex(line => line.trim().replace(/ \(filtered\)$/, '') === source);
  const path = index >= 0 && lines[index + 1]?.trim();
  return { visible: index >= 0, filtered: index >= 0 && lines[index].trimEnd().endsWith(' (filtered)'), root: path && isAbsolute(path) ? path : undefined };
}

async function maintainPi(target: HarnessTarget, options: { update: boolean; install: boolean }, signal: AbortSignal,
  dependencies: { run?: NativeRun; piIdle?: () => Promise<boolean>; piPackage?: PiPackageRequest; legacyPluginRoot?: string; persistentRoot?: string }) : Promise<MaintenanceResult> {
  if (process.env.BB_PI_BRIDGE_COMMAND && process.env.BB_PI_BRIDGE_COMMAND !== target.executable)
    return { state: 'skipped', message: 'Пользовательский launcher Pi сохранён. Для обновления нужен его подтверждённый профиль.' };
  const directory = target.configRoot ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
  const env = { ...process.env, PI_CODING_AGENT_DIR: directory };
  const run = dependencies.run ?? nativeManager(target, signal);
  const projectSettings = join(target.cwd, '.pi', 'settings.json');
  const hiddenProject = 'Штатный Pi не показывает этот пакет проекта. Проверь, какой проект и профиль открыты в Pi.';
  if (options.install && dependencies.legacyPluginRoot && dependencies.persistentRoot) {
    for (const path of [join(directory, 'settings.json'), projectSettings])
      await rebasePiSources(path, dependencies.legacyPluginRoot, dependencies.persistentRoot, { beforeChange: async source => {
        if (path === projectSettings && !(await piListing(run, env, source)).visible) throw new Error(hiddenProject);
        if (!await (dependencies.piIdle ?? (() => piIdle(signal)))()) throw new Error('Заверши процессы Pi, использующие этот профиль, и повтори подготовку в окне обслуживания.');
      } });
  }
  const declarations: { source: string; project: boolean; filtered: boolean; legacySettings?: string }[] = [];
  let otherSource = false;
  for (const path of [join(directory, 'settings.json'), projectSettings]) {
    let settings;
    try { settings = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const item of settings.packages ?? []) {
      const source = typeof item === 'string' ? item : item?.source;
      const filtered = Array.isArray(item?.extensions) || Array.isArray(item?.skills);
      if (typeof source === 'string' && /^(?:git:(?:https:\/\/)?github\.com\/|https:\/\/github\.com\/|git@github\.com:)SolomonikVik\/svaib-plugin(?:\.git)?(?:[@#][^\s]+)?$/i.test(source)) declarations.push({ source, filtered, project: path === projectSettings });
      else if (typeof source === 'string') {
        const localPath = piLocalSourcePath(path, source);
        if (localPath && dependencies.persistentRoot && await relocatedPiPackage(localPath, dependencies.persistentRoot)) {
          declarations.push({ source, filtered, project: path === projectSettings, legacySettings: path }); continue;
        }
        if (source.includes('svaib-plugin')) otherSource = true;
        if (localPath) {
          try { if (JSON.parse(await readFile(join(localPath, 'package.json'), 'utf8')).name === 'svaib-plugin') otherSource = true; } catch { /* Unknown packages are not ours to repair. */ }
        }
      }
    }
  }
  if (otherSource) return { state: 'skipped', message: 'Существующий источник Harness Pi сохранён. Его перенос требует отдельной проверки native-регистрации и фильтров.' };
  if (declarations.length > 1) return { state: 'skipped', message: 'В Pi несколько источников svaib. Сохрани scope и выбери нужный в штатном менеджере.' };
  const existing = declarations[0];
  let source = existing?.source ?? PI_HARNESS_SOURCE;
  let state: MaintenanceResult['state'] = 'unchanged';
  let previousVersion: string | undefined;
  if (!existing && !options.install) return { state: 'skipped', message: 'Harness ещё не установлен в этом профиле Pi.' };
  const previous = existing && await piListing(run, env, source);
  if (existing?.project && !previous?.visible) return { state: 'skipped', message: hiddenProject };
  let update = options.update && (options.install || !existing?.legacySettings);
  if (previous?.root && update) {
    try {
      previousVersion = (await piManifest(previous.root)).version;
      if (options.install && !existing?.legacySettings) {
        await onboardingContract(join(previous.root, 'plugins', 'svaib'));
        update = false;
      }
    } catch { /* Native update can repair an incomplete or incompatible package in an idle profile. */ }
  }
  if (!existing || update) {
    // Pi install updates an existing checkout even when it has no registration.
    const checkout = !existing && (await (dependencies.piPackage ?? piPackageRequest)(
      target, env, signal, source, false, 'path')).root;
    if (checkout) return { state: 'skipped', message: 'В профиле Pi остались файлы Harness без регистрации. Проверь источник и версию в штатном менеджере Pi перед повторной установкой.' };
    if (existing && !await (dependencies.piIdle ?? (() => piIdle(signal)))())
      return { state: 'skipped', message: 'Заверши процессы Pi, использующие этот профиль, и повтори подготовку в окне обслуживания.' };
    // Native update finds the scope from the registered source in this cwd.
    if (existing?.legacySettings) {
      const project = existing.project;
      const { root: packageRoot } = await (dependencies.piPackage ?? piPackageRequest)(target, env, signal, PI_HARNESS_SOURCE, project, 'install');
      if (!packageRoot || !isAbsolute(packageRoot)) throw new Error('Pi не подтвердил путь нового Git-пакета.');
      await piManifest(packageRoot);
      signal.throwIfAborted();
      replaceRegistration({ settingsPath: existing.legacySettings, oldSource: source, packageRoot, nativeSource: PI_HARNESS_SOURCE });
      source = PI_HARNESS_SOURCE;
    } else await run([existing ? 'update' : 'install', source], env);
    state = existing ? 'updated' : 'installed';
  }
  const { root, filtered } = state === 'unchanged' && previous ? previous : await piListing(run, env, source);
  if (!root || !isAbsolute(root)) throw new Error('Штатный Pi не подтвердил установленный путь Harness.');
  const manifest = await piManifest(root);
  if (filtered || existing?.filtered) {
    const result = await (dependencies.piPackage ?? piPackageRequest)(target, env, signal, source, existing?.project ?? false, 'filters');
    if (!result.enabled) return { state: 'skipped', version: manifest.version,
      message: 'В выбранном профиле фильтры Pi отключают расширение svaib или скилл onboarding.' };
  }
  if (state === 'updated' && !existing?.legacySettings && previousVersion === manifest.version) state = 'checked';
  return { state, message: 'Harness Pi подтверждён штатным менеджером. Новый процесс загрузит установленную версию.',
    version: manifest.version, pluginRoot: join(root, 'plugins', 'svaib') };
}

const officialRepository = 'solomonikvik/svaib-plugin';
function officialGit(source: unknown) {
  if (typeof source !== 'string') return false;
  const repo = source.toLowerCase().replace(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)/, '').replace(/\.git$/, '');
  return repo === officialRepository;
}

async function marketplaceSource(codex: boolean, item: any, run: NativeRun, env: NodeJS.ProcessEnv) {
  let source = codex && item?.marketplaceSource;
  if (!source) {
    const response = await run(['plugin', 'marketplace', 'list', '--json'], env) as any;
    const rows = codex ? response?.marketplaces : response;
    if (!Array.isArray(rows)) return { official: false };
    const matches = rows.filter(row => row.name === 'svaib');
    if (!matches.length) return { missing: true, official: false };
    if (matches.length !== 1) return { official: false };
    source = codex ? matches[0].marketplaceSource : matches[0];
  }
  const kind = codex ? source?.sourceType : source?.source;
  return {
    official: kind === 'git' && officialGit(codex ? source.source : source.url) || !codex && kind === 'github' && officialGit(source.repo),
    local: codex && kind === 'local' ? source.source : !codex && kind === 'directory' ? source.path : undefined,
  };
}

async function claudeLegacyScope(root: string, cwd: string, source: string) {
  const scopes = [];
  for (const [scope, path] of [['user', join(root, 'settings.json')], ['project', join(cwd, '.claude', 'settings.json')],
    ['local', join(cwd, '.claude', 'settings.local.json')]]) {
    let settings;
    try { settings = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const entry = settings?.extraKnownMarketplaces?.svaib;
    if (!entry) continue;
    if (entry.source?.source !== 'directory' || entry.source.path !== source) return;
    scopes.push({ scope, entry });
  }
  return scopes.length === 1 ? scopes[0] : undefined;
}

async function maintainHarnessInside(target: HarnessTarget, options: { update: boolean; trust: boolean; install: boolean }, signal: AbortSignal,
  dependencies: { run?: NativeRun; preserveSkillChoices?: typeof preserveCodexSkillChoices; installPreference?: typeof harnessInstallPreference; trust?: typeof nativeHookAutomaticForProfile; hookRoot?: () => Promise<string | undefined>; piIdle?: () => Promise<boolean>; piPackage?: PiPackageRequest; legacyPluginRoot?: string; persistentRoot?: string } = {}): Promise<MaintenanceResult> {
  if (!isAbsolute(target.executable) || !isAbsolute(target.cwd) || target.configRoot && !isAbsolute(target.configRoot)) throw new Error('Не подтверждён профиль Harness.');
  if (target.provider === 'pi') return maintainPi(target, options, signal, dependencies);
  const codex = target.provider === 'codex';
  const root = target.configRoot ?? (codex ? process.env.CODEX_HOME : target.provider === 'acp-claude-kimi' && target.args?.[0]
    ? join(dirname(target.args[0]), 'claude') : process.env.CLAUDE_CONFIG_DIR) ?? join(homedir(), codex ? '.codex' : '.claude');
  const env = { ...process.env, [codex ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: root };
  const run = dependencies.run ?? nativeManager(target, signal);
  const inventory = async () => {
    const raw = await run(['plugin', 'list', '--json'], env) as any;
    const list = codex ? raw?.installed : Array.isArray(raw) ? raw : raw?.plugins;
    if (!Array.isArray(list)) throw new Error('Штатный менеджер вернул неизвестный список плагинов.');
    return list.filter((item: any) => (item.pluginId ?? item.id) === 'svaib@svaib');
  };
  let rows = await inventory();
  if (rows.length > 1) return { state: 'skipped', message: 'Найдено несколько установок svaib. Сохрани их scope и выбери нужную в штатном менеджере.' };
  let state: MaintenanceResult['state'] = 'unchanged';
  const previousVersion = rows[0]?.version;
  const itemBefore = rows[0];
  if (!itemBefore && !options.install) return { state: 'skipped', message: 'Harness ещё не установлен в этом профиле.' };
  const preference = itemBefore ? null :
    await (dependencies.installPreference ?? harnessInstallPreference)(codex ? 'codex' : 'claude', root, target.cwd, target, signal);
  if (itemBefore?.enabled === false || itemBefore?.installed === false || preference?.disabled)
    return { state: 'skipped', message: 'Установка svaib отключена пользователем.' };
  const installScope = preference?.scope ?? 'user';
  const source = await marketplaceSource(codex, itemBefore, run, env);
  const keepSource: MaintenanceResult = { state: 'skipped', message: 'У svaib в этом профиле другой источник. Проверь его в штатном менеджере.' };
  const addingMarketplace = source.missing && !itemBefore;
  if (!source.official && !addingMarketplace &&
    !await ownedLegacyMarketplace(source.local, codex ? 'codex' : 'claude', dependencies.legacyPluginRoot, dependencies.persistentRoot)) return keepSource;
  if (codex && itemBefore && options.update && (source.official || options.install)) {
    const safe = await (dependencies.preserveSkillChoices ?? preserveCodexSkillChoices)(target.executable, target.cwd, root, itemBefore.version, signal);
    if (!safe) return { state: 'skipped', message: 'В Codex есть отключение скилла svaib по пути. Проверь выбор для этого скилла в настройках Codex перед обновлением.' };
  }
  if (addingMarketplace) {
    await run(['plugin', 'marketplace', 'add', HARNESS_SOURCE, ...(codex ? [] : ['--scope', installScope]), '--json'], env);
  } else if (!source.official) {
    // Background checks and a disabled update preference keep the verified legacy installation.
    if (options.install && (options.update || !itemBefore)) {
      if (codex) await run(['plugin', 'marketplace', 'add', HARNESS_SOURCE, '--json'], env);
      else {
        const declaration = await claudeLegacyScope(root, target.cwd, source.local);
        if (!declaration) return keepSource;
        const settings = { extraKnownMarketplaces: { svaib: { ...declaration.entry, source: { source: 'git', url: HARNESS_SOURCE } } } };
        await run(['--settings', JSON.stringify(settings), 'plugin', 'marketplace', 'add', HARNESS_SOURCE, '--scope', declaration.scope, '--json'], env);
      }
    }
  }
  if (!itemBefore) {
    await run(codex ? ['plugin', 'add', 'svaib@svaib', '--json'] : ['plugin', 'install', 'svaib@svaib', '--scope', installScope, '--json'], env);
    state = 'installed';
  } else if (options.update && (source.official || options.install)) {
    if (!codex && !['user', 'project', 'local'].includes(itemBefore.scope)) throw new Error('Не удалось определить scope установленного Harness.');
    await run(['plugin', 'marketplace', codex ? 'upgrade' : 'update', 'svaib', ...(codex ? ['--json'] : [])], env);
    await run(codex ? ['plugin', 'add', 'svaib@svaib', '--json'] : ['plugin', 'update', 'svaib@svaib', '--scope', itemBefore.scope, '--json'], env);
    state = 'updated';
  }
  signal.throwIfAborted();
  rows = await inventory();
  if (rows.length !== 1 || rows[0].enabled === false || rows[0].installed === false) throw new Error('Установка Harness не подтверждена штатным менеджером.');
  const current = await marketplaceSource(codex, rows[0], run, env);
  const sameLegacy = state === 'unchanged' && source.local && current.local === source.local;
  if (!current.official && !sameLegacy) return keepSource;
  if (codex && options.trust) await (dependencies.trust ?? nativeHookAutomaticForProfile)(
    { executable: target.executable, cwd: target.cwd }, signal, root);
  const item = rows[0];
  if (state === 'updated' && (typeof previousVersion !== 'string' || item.version === previousVersion)) state = 'checked';
  const pluginRoot = codex ? await (dependencies.hookRoot ?? (() => withCodexHooks({ executable: target.executable, cwd: target.cwd }, signal, async rpc => {
    const review = await inspectHooks(rpc, target.cwd);
    const roots = [...new Set(review.hooks.map(hook => dirname(dirname(hook.sourcePath))))];
    if (roots.length !== 1 || review.hooks.some(hook => hook.trustStatus !== 'trusted')) throw new Error('Хуки svaib ещё не подключены в этом профиле.');
    return roots[0];
  }, root)))() : item.installPath;
  return { state, message: state === 'unchanged' ? 'Harness установлен; обновление выключено.' : state === 'checked'
    ? 'Проверка обновления завершена; новая версия не подтверждена. Установленная версия сохранена.'
    : 'Harness подтверждён штатным менеджером. Новый процесс загрузит установленную версию.',
    ...(typeof item.version === 'string' ? { version: item.version } : {}),
    ...(typeof pluginRoot === 'string' ? { pluginRoot } : {}) };
}

const managerJobs = new Map<string, Promise<MaintenanceResult>>();
/** Serialize native managers for one profile, including foreground and idle checks. */
export function maintainHarness(...args: Parameters<typeof maintainHarnessInside>): Promise<MaintenanceResult> {
  const target = args[0];
  const key = JSON.stringify([target.provider, target.executable, target.args, target.configRoot]);
  const previous = managerJobs.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => { args[2].throwIfAborted(); return maintainHarnessInside(...args); });
  managerJobs.set(key, operation);
  void operation.finally(() => { if (managerJobs.get(key) === operation) managerJobs.delete(key); }).catch(() => {});
  return operation;
}
