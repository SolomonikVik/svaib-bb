import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { defineRpcContract, type BbPluginApi, type PluginAgentConfiguration, type PluginAgentConfigurationContext } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { registerKimiSetup } from './kimi-setup';
import { kimiCheckMetadataSchema } from './kimi-contract';
import { contextualPreviewText, actionPrompt, getAction, getWorkspace, resolveActionContext, validateInstructions, READ_ONLY_RULES } from './catalog';
import { aspectIdSchema, idSchema, loadConfig, loadConfigSync, workspaceSchema, type CatalogWorkspace, type WorkplaceConfig } from './config';
import type { ActionContext, ActionPreview, Overview, SourceDocument, SourceRef, StartedAction, WorkspaceId } from './types';
import { discoverSkills, enrichWorkspaceActions, type SkillCatalog } from './skills';
import { applyMetricsUpdate } from './metrics-update';
import { registerAccountModule } from './experiments/account-prototype/account-module';
import { CONNECTION_SKILL } from './experiments/account-prototype/connection';
import { supportsConnection } from './experiments/account-prototype/connection-providers';
import { registerScreenModule } from './screen-module';
import { createScreenPluginContext, type PersistentRootValidator } from './screen-native-context';
import { companyWorkspaceRpc, createCompanyWorkspaces, isCompanyWorkspace, matchesCompanyProfileScope, type CompanyProfileScope } from './company-workspaces';

const actionInput = z.object({ workspaceId: idSchema, actionId: idSchema, aspectId: aspectIdSchema.optional(), itemId: idSchema.optional() }).strict();
const actionMetadata = actionInput.extend({ schema: z.literal(1) }).strict();

export const rpcContract = defineRpcContract({
  ...companyWorkspaceRpc,
  overview: { input: z.null(), output: z.object({ workspaces: z.array(workspaceSchema), generatedAt: z.string(), accountId: z.string().nullable().optional() }).strict() },
  source: {
    input: z.object({ workspaceId: idSchema, sourceId: z.string().min(1).max(80) }).strict(),
    output: z.object({ title: z.string(), path: z.string(), content: z.string(), modifiedAt: z.string(), hostId: z.string(), documentContext: z.object({ threadId: z.string(), rootPath: z.string(), target: z.object({ kind: z.literal('workspace'), environmentId: z.string(), path: z.string() }).strict() }).strict().optional() }).strict(),
  },
  preview: {
    input: actionInput,
    output: z.object({ prompt: z.string(), title: z.string(), projectId: z.string(), environmentId: z.string(), accountId: z.string().nullable(),
      hostId: z.string().optional(), rootPath: z.string().optional(), defaultCheckoutMatches: z.boolean().optional() }).strict(),
  },
  start: {
    input: actionInput.extend({ prompt: z.string().trim().min(1).max(24_000) }).strict(),
    output: z.object({ threadId: z.string(), projectId: z.string() }).strict(),
  },
});

const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_SOURCE_CHARACTERS = 180_000;

/** No caller-controlled path enters filesystem APIs. Symlinked sources are rejected. */
async function checkedPath(workspace: CatalogWorkspace, sourceId: string): Promise<{ source: SourceRef; path: string }> {
  const source = workspace.sources.find((item) => item.id === sourceId);
  if (!source) throw new Error('Источник отсутствует в списке выбранного пространства.');
  const root = await realpath(workspace.root);
  const target = resolve(source.path);
  const actual = await realpath(target);
  const inside = relative(root, actual);
  if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`) || actual !== target) {
    throw new Error('Источник недоступен: ссылка или путь за пределами выбранного пространства.');
  }
  return { source, path: actual };
}

/** Overview reads metadata only, including for personal and HR sources. */
export async function buildOverview(config: WorkplaceConfig): Promise<Overview> {
  const workspaces = await Promise.all(config.workspaces.map(async (item) => {
    const sources = await Promise.all(item.sources.map(async (source): Promise<SourceRef> => {
      try {
        const checked = await checkedPath(item, source.id);
        const metadata = await stat(checked.path);
        if (!metadata.isFile()) return { ...source };
        return { ...source, updatedAt: metadata.mtime.toISOString() };
      } catch {
        // Missing/unreadable sources remain visible, with no invented freshness.
        return { ...source };
      }
    }));
    const updatedAt = sources.flatMap((source) => source.updatedAt ? [source.updatedAt] : []).sort().at(-1) ?? '';
    return {
      id: item.id, name: item.name, eyebrow: item.eyebrow, description: item.description,
      ...(item.companyId ? { companyId: item.companyId } : {}),
      ...(item.tabColor ? { tabColor: item.tabColor } : {}),
      goal: item.goal, goalLabel: item.goalLabel, updatedAt, sources,
      snapshotAt: item.snapshotAt, signals: item.signals,
      actions: item.actions.map(({ method, sourceIds, ...action }) => action),
      ...(item.planner ? { planner: item.planner } : {}), ...(item.metrics ? { metrics: item.metrics } : {}),
      ...(item.metricsDashboard ? { metricsDashboard: item.metricsDashboard } : {}),
      ...(item.aspects ? { aspects: item.aspects } : {}),
      ...(item.personal ? { personal: item.personal } : {}),
      ...(item.clientHub ? { clientHub: item.clientHub } : {}),
      ...(item.linkHub ? { linkHub: item.linkHub, fileContext: { hostId: item.hostId, environmentId: item.environmentId, rootPath: item.documentRoot ?? item.root } } : {}),
    };
  }));
  return { workspaces, generatedAt: new Date().toISOString() };
}

export async function readSource(config: WorkplaceConfig, workspaceId: WorkspaceId, sourceId: string): Promise<SourceDocument> {
  const workspace = getWorkspace(config, workspaceId);
  const checked = await checkedPath(workspace, sourceId);
  const file = await open(checked.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error('Источник не является обычным файлом.');
    if (!['.md', '.markdown'].includes(extname(checked.path).toLowerCase())) throw new Error('Этот формат не поддерживается встроенным просмотром. Здесь можно читать только Markdown (.md, .markdown).');
    if (before.size > MAX_SOURCE_BYTES) throw new Error('Источник слишком велик для встроенного просмотра. Открой его в рабочем пространстве.');
    const rechecked = await checkedPath(workspace, sourceId);
    const current = await stat(rechecked.path);
    if (before.dev !== current.dev || before.ino !== current.ino) throw new Error('Источник изменился во время открытия. Попробуй ещё раз.');
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    let size = 0;
    while (size < buffer.byteLength) {
      const { bytesRead } = await file.read(buffer, size, buffer.byteLength - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_SOURCE_BYTES) throw new Error('Источник превышает размер встроенного просмотра.');
    const after = await file.stat();
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('Источник изменился во время чтения. Попробуй ещё раз.');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)); }
    catch { throw new Error('Двоичные источники и текст не в UTF-8 не поддерживаются.'); }
    if (content.length > MAX_SOURCE_CHARACTERS) throw new Error('Источник слишком длинный для встроенного просмотра.');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)) throw new Error('Двоичные источники не поддерживаются.');
    if (/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(content)) throw new Error('HTML не поддерживается встроенным просмотром Markdown.');
    return { title: checked.source.title, path: checked.source.path, content, modifiedAt: after.mtime.toISOString(), hostId: workspace.hostId,
      ...(workspace.documentThreadId && workspace.documentRoot ? { documentContext: { threadId: workspace.documentThreadId, rootPath: workspace.documentRoot, target: { kind: 'workspace' as const, environmentId: workspace.environmentId, path: relative(workspace.documentRoot, checked.path) } } } : {}),
    };
  } finally {
    await file.close();
  }
}

export function previewAction(config: WorkplaceConfig, workspaceId: WorkspaceId, actionId: string, context: ActionContext = {}): ActionPreview {
  const workspace = getWorkspace(config, workspaceId);
  const selected = getAction(workspace, actionId);
  actionPrompt(workspace, selected, context); // Validate the exact context and SDK instruction length before composer opens.
  const selection = contextualPreviewText(workspace, selected, context);
  const { item } = resolveActionContext(workspace, selected, context);
  return {
    prompt: `${selected.prompt}${selection ? `\n\n${selection}` : ''}`,
    title: `${workspace.name} · ${item ? `${item.title} · ` : ''}${selected.title}`,
    projectId: workspace.projectId, environmentId: workspace.environmentId,
  };
}

export default async function plugin(bb: BbPluginApi) {
  return initializePlugin(bb);
}

/** Tests use an isolated temporary workspace; the production entrypoint never accepts an override. */
export async function initializePluginForTesting(bb: BbPluginApi, validatePersistentRootForTesting: PersistentRootValidator) {
  return initializePlugin(bb, validatePersistentRootForTesting);
}

async function initializePlugin(bb: BbPluginApi, validatePersistentRootForTesting?: PersistentRootValidator) {
  const settings = bb.settings.define({
    configPath: { type: 'string', label: 'Локальное описание пространств (абсолютный путь на BB-сервере)', default: '' },
    productionOAuthSession: { type: 'string', label: 'Подключение svaib (служебное, не редактировать)', secret: true },
  });
  const initialSettings = await settings.get();
  let configPath = initialSettings.configPath;
  const skillCatalogs = new Map<string, SkillCatalog>();
  const skillScope = (workspace: CatalogWorkspace) => JSON.stringify([workspace.projectId, workspace.environmentId, workspace.hostId]);
  settings.onChange(next => { configPath = next.configPath; skillCatalogs.clear(); });
  const primaryHostId = (await bb.sdk.system.config()).primaryHostId;
  await registerKimiSetup(bb, primaryHostId);
  function validateLocal(config: WorkplaceConfig) {
    validateInstructions(config);
    if (config.workspaces.some(w => w.hostId !== primaryHostId)) throw new Error('Этот эксперимент читает только пространства на машине BB-сервера. Удалённые hosts пока не поддерживаются.');
    return config;
  }
  async function legacyConfig() {
    const config = await loadConfig((await settings.get()).configPath);
    return validateLocal(config);
  }
  async function currentConfig() {
    const epoch = account.epoch();
    const [legacy, managed] = await Promise.all([legacyConfig(), companies.catalog()]);
    if (epoch !== account.epoch()) throw new Error('Подключение изменилось. Обнови рабочее место.');
    return { ...legacy, workspaces: [...legacy.workspaces.filter(w => !managed.replaced.includes(w.id)),
      ...managed.workspaces.map(w => w.workspace)], visibleCompanies: new Set(managed.workspaces.filter(w => w.visible).map(w => w.workspace.id)), accountId: managed.accountId, epoch };
  }
  async function configWithSkills(workspaceId?: string) {
    const config = await currentConfig();
    if (workspaceId) getWorkspace(config, workspaceId);
    const workspaces = await Promise.all(config.workspaces.map(async workspace => {
      if (workspaceId && workspace.id !== workspaceId) return workspace;
      const catalog = await discoverSkills(bb.sdk, workspace);
      skillCatalogs.set(skillScope(workspace), catalog);
      return enrichWorkspaceActions(workspace, catalog);
    }));
    return { ...config, workspaces };
  }
  // Each module uses the root plugin identity and production credential store.
  const account = await registerAccountModule(bb, { registerConfigure: false, sessionStore: {
    read: async () => (await settings.get()).productionOAuthSession ?? '',
    write: async value => { await settings.experimental_set({ productionOAuthSession: value || null }); },
  } });
  let claimedLegacy = new Set<string>();
  let claimedScopes: CompanyProfileScope[] = [];
  const companies = createCompanyWorkspaces({ sdk: bb.sdk, kv: bb.storage.kv, account, legacy: legacyConfig,
    validateRoot: validatePersistentRootForTesting, onClaimed: ids => { claimedLegacy = new Set(ids); },
    onScopesChanged: scopes => { claimedScopes = scopes; } });
  claimedLegacy = new Set(await companies.claimedLegacyIds());
  claimedScopes = await companies.claimedScopes();
  const screen = registerScreenModule(bb, { account, validatePersistentRootForTesting });
  const workContext = createScreenPluginContext({ sdk: bb.sdk, kv: bb.storage.kv, account, validatePersistentRootForTesting });
  const contextTool = 'svaib_workspace_context';
  bb.agents.registerTool({ name: contextTool,
    description: 'Проверяет текущий доступ, компанию и рабочую папку действия, выбранного во вкладке svaib, и возвращает его инструкцию.',
    parameters: z.object({}).strict(),
    execute: async (_, ctx) => {
      const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: ctx.threadId });
      const selected = actionMetadata.parse(metadata);
      if (!thread.environmentId) throw new Error('Разговору нужна рабочая папка компании.');
      const raw = await companies.threadWorkspace(selected.workspaceId, thread.environmentId);
      const live = await workContext.resolve(ctx.threadId, undefined, raw.companyId);
      const workspace = enrichWorkspaceActions(raw, await discoverSkills(bb.sdk, raw));
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId! });
      if (!workspace.companyId || thread.projectId !== workspace.projectId || thread.environmentId !== workspace.environmentId ||
          environment.hostId !== workspace.hostId || ctx.projectId !== workspace.projectId) throw new Error('Среда разговора не совпадает с рабочим местом компании.');
      const verified = await account.verifiedCompany(workspace.companyId);
      if (verified.epoch !== account.epoch() || live.epoch !== verified.epoch || live.realRoot !== workspace.root ||
          live.context.account_id !== verified.account_id) throw new Error('Подключение изменилось. Открой действие заново.');
      return actionPrompt(workspace, getAction(workspace, selected.actionId), selected);
    } });
  // No agent, source-content read, external write or schedule at plugin load.
  const workplaceConfiguration = (context: PluginAgentConfigurationContext): PluginAgentConfiguration => {
    const empty = { tools: [], skills: [] };
    if (context.origin.pluginId !== bb.pluginId || context.origin.kind !== null) return empty;
    const unavailable = { ...empty, instructions: `${READ_ONLY_RULES}\n\nНе выполняй выбранное действие: описание пространства, маршрут действия или выбранная среда недоступны/не совпадают. Покажи коротко, что нужно вернуться к рабочему месту и проверить его локальную настройку. Не ищи другое пространство и не обходи это ограничение.` };
    const parsed = actionMetadata.safeParse(context.pluginMetadata);
    if (!parsed.success) return unavailable;
    if (claimedLegacy.has(parsed.data.workspaceId)) return unavailable;
    if (isCompanyWorkspace(parsed.data.workspaceId)) return { tools: [contextTool], skills: [],
      instructions: `Это новый разговор по действию из рабочего места компании svaib. Перед чтением материалов и выполнением задачи обязательно вызови ${contextTool} без параметров. Он проверит действительный доступ, компанию и выбранную среду и вернёт инструкцию действия. Следуй этой инструкции и правилам пользователя. При ошибке остановись и предложи открыть нужную компанию в кабинете; не подставляй другую папку или компанию.` };
    try {
      const config = validateLocal(loadConfigSync(configPath));
      const rawWorkspace = config.workspaces.find(w => w.id === parsed.data.workspaceId);
      if (!rawWorkspace) return unavailable;
      if (matchesCompanyProfileScope(rawWorkspace, claimedScopes)) return unavailable;
      // configure is synchronous. Only a catalog actually observed
      // by overview/preview/start may supply skills; paths are rechecked here.
      const workspace = enrichWorkspaceActions(rawWorkspace, skillCatalogs.get(skillScope(rawWorkspace)) ?? { skills: [], checkedAt: '' });
      const selected = workspace.actions.find(a => a.id === parsed.data.actionId);
      if (!selected || selected.available === false) return unavailable;
      if (context.project.id !== workspace.projectId || context.environment.id !== workspace.environmentId || context.host.id !== workspace.hostId) return unavailable;
      return { ...empty, instructions: actionPrompt(workspace, selected, parsed.data) };
    } catch {
      // SDK drops thrown enrichment, but does not cancel a thread start.
      // Keep a safe instruction for our origin even when local configuration breaks.
      return unavailable;
    }
  };
  // One configure callback owns dispatch. Metadata routes tasks; handlers still check authority.
  bb.agents.configure(context => {
    const own = context.origin.pluginId === bb.pluginId && context.origin.kind === null;
    if (own && kimiCheckMetadataSchema.safeParse(context.pluginMetadata).success &&
        context.provider.id === 'acp-claude-kimi' && context.host.id === primaryHostId) {
      return { tools: [], skills: [], instructions: 'Это короткая проверка ответа Kimi. Ответь ровно KIMI_READY. Не используй инструменты, не читай и не меняй файлы. Не начинай подключение svaib или онбординг.' };
    }
    const setup = own && context.pluginMetadata.task === 'svaib-connect';
    const supported = supportsConnection(context.provider.id);
    const base = setup ? account.configure(context) : own ? workplaceConfiguration(context)
      : supported ? account.configure(context) : { tools: [], skills: [] };
    const finishedSetup = setup && context.pluginMetadata.phase === 'work';
    // BB freezes tools when constructing the provider session. A metadata-only
    // setup -> work transition cannot add Screen to that already running session.
    // Pre-stage only a valid scoped setup; the handlers still authorize the
    // actual account/company/workspace on every call.
    const configuredSetup = setup && (base.tools?.length ?? 0) > 0;
    const visual = supported && (!setup || finishedSetup || configuredSetup) ? screen.configure(context) : { tools: [], skills: [] };
    const ordinaryScreenGuidance = 'Если человек просит открыть или продолжить конструктор пространства, вызови svaib_screen_open в текущем проекте BB с выбранными companyId и companyName без screenId: система найдёт доступные Screen и при нескольких предложит выбор. Не придумывай ID. Сам инструмент проверит папку и доступ; предварительные shell-команды не нужны. Если папка не подходит, следуй сообщению инструмента.';
    const instructions = configuredSetup && base.instructions && visual.instructions
      ? `${base.instructions}\n\nПосле успешного whoami, если согласованный сценарий включает подготовку пространства, продолжи его по правилам пользователя. ${visual.instructions}`
      : supported && !own ? [base.instructions, ordinaryScreenGuidance].filter(Boolean).join('\n\n') : base.instructions;
    return {
      tools: [...new Set([...(base.tools ?? []), ...(visual.tools ?? [])])],
      skills: [...new Set([...(base.skills ?? []), ...(visual.skills ?? []), ...(!setup && supported ? [CONNECTION_SKILL] : [])])],
      // Native/work chats discover available tools without receiving another task's instructions.
      ...(instructions ? { instructions } : {}),
    };
  });
  bb.rpc.register(rpcContract, {
    companyDirectory: () => companies.directory(),
    companyTargets: ({ companyId }) => companies.targets(companyId),
    bindCompanyWorkspace: async ({ companyId, environmentId }) => {
      const result = await companies.bind(companyId, environmentId); claimedLegacy = new Set(await companies.claimedLegacyIds());
      bb.realtime.publish('workplaces-changed', null); return result;
    },
    showCompanyTab: async ({ companyId, visible }) => {
      const result = await companies.show(companyId, visible); claimedLegacy = new Set(await companies.claimedLegacyIds());
      bb.realtime.publish('workplaces-changed', null); return result;
    },
    overview: async () => {
      const config = await configWithSkills();
      const result = await buildOverview({ ...config, workspaces: config.workspaces.filter(w => !w.companyId || config.visibleCompanies.has(w.id)) });
      if (config.epoch !== account.epoch()) throw new Error('Подключение изменилось. Обнови рабочее место.');
      return { ...result, accountId: config.accountId };
    },
    source: async ({ workspaceId, sourceId }) => {
      const config = await currentConfig(); const document = await readSource(config, workspaceId, sourceId);
      if (config.epoch !== account.epoch()) throw new Error('Подключение изменилось. Открой документ заново.');
      return document;
    },
    preview: async ({ workspaceId, actionId, ...context }) => {
      const config = await configWithSkills(workspaceId);
      const workspace = getWorkspace(config, workspaceId);
      const preview = previewAction(config, workspaceId, actionId, context);
      let defaultCheckoutMatches = false;
      try {
        const [project, environment] = await Promise.all([bb.sdk.projects.get({ projectId: workspace.projectId }),
          bb.sdk.environments.get({ environmentId: workspace.environmentId })]);
        const sources = project.sources.filter(s => s.type === 'local_path' && s.hostId === workspace.hostId);
        const inside = environment.path ? relative(environment.path, workspace.root) : '..';
        defaultCheckoutMatches = project.id === workspace.projectId && environment.id === workspace.environmentId && environment.status === 'ready' &&
          environment.projectId === workspace.projectId && environment.hostId === workspace.hostId && sources.length === 1 &&
          sources[0].type === 'local_path' && sources[0].projectId === workspace.projectId && sources[0].path === environment.path &&
          (inside === '' || (inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside)));
      } catch (error) {
        if (workspace.companyId) throw error;
        // A legacy action can still use its exact reuse environment; an
        // unverified native fallback never becomes an alternative folder.
      }
      if (config.epoch !== account.epoch()) throw new Error('Подключение изменилось. Открой действие заново.');
      return { ...preview, accountId: config.accountId, hostId: workspace.hostId, rootPath: workspace.root, defaultCheckoutMatches };
    },
    start: async ({ workspaceId, actionId, prompt, ...context }): Promise<StartedAction> => {
      const config = await configWithSkills(workspaceId);
      const preview = previewAction(config, workspaceId, actionId, context);
      const workspace = getWorkspace(config, workspaceId);
      const defaults = await bb.sdk.projects.defaultExecutionOptions({ projectId: preview.projectId });
      const thread = await bb.sdk.threads.spawn({
        ...(defaults ?? {}),
        projectId: preview.projectId, environment: { type: 'reuse', environmentId: preview.environmentId },
        title: preview.title, visibility: 'visible',
        pluginMetadata: { workspaceId, actionId, ...context, schema: 1 },
        prompt: `${actionPrompt(workspace, getAction(workspace, actionId), context)}\n\nЗапрос пользователя:\n${prompt}`,
      });
      return { threadId: thread.id, projectId: preview.projectId };
    },
  });

  bb.cli.register({
    name: 'svaib-workplace', summary: 'Inspect workplace contexts or apply an explicitly enabled metrics snapshot',
    commands: [
      { name: 'status', summary: 'Show contexts and source freshness', usage: 'bb svaib-workplace status [--json]' },
      { name: 'sources', summary: 'List whitelisted source paths', usage: 'bb svaib-workplace sources [--json]' },
      { name: 'apply-metrics', summary: 'Apply a validated metrics snapshot to one opted-in workspace', usage: 'bb svaib-workplace apply-metrics --workspace <id> --file <absolute-json> --expected-snapshot <preparedAt> [--check]' },
    ],
    async run(argv) {
      const json = argv.includes('--json');
      const args = argv.filter((value) => value !== '--json');
      const command = args[0];
      const usage = 'bb svaib-workplace status|sources [--json]\nbb svaib-workplace apply-metrics --workspace <id> --file <absolute-json> --expected-snapshot <preparedAt> [--check]\nStatus/sources read metadata only. apply-metrics changes only the opted-in snapshot; --check never writes. No agents are started.';
      if (args.length === 0 || command === '--help' || command === 'help') return { exitCode: 0, stdout: usage };
      if (command === 'apply-metrics') {
        try {
          const values = new Map<string, string>();
          let check = false;
          for (let i = 1; i < args.length; i++) {
            const flag = args[i];
            if (flag === '--check' && !check) { check = true; continue; }
            if (!['--workspace', '--file', '--expected-snapshot'].includes(flag) || values.has(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(usage);
            values.set(flag, args[++i]);
          }
          if (values.size !== 3) throw new Error(usage);
          const requestedId = values.get('--workspace')!;
          const config = await currentConfig();
          const target = config.workspaces.filter(w => w.id === requestedId || w.metricsUpdateWorkspaceId === requestedId);
          if (target.length !== 1) throw new Error('Нет действительного доступа к рабочему месту этих графиков. Открой нужную компанию заново.');
          const scope = (w: CatalogWorkspace) => JSON.stringify([w.companyId ?? null, w.root, w.projectId, w.environmentId, w.hostId]);
          const expected = scope(target[0]);
          const physicalId = target[0].metricsUpdateWorkspaceId ?? target[0].id;
          const configPath = (await settings.get()).configPath;
          const result = await applyMetricsUpdate({ configPath, workspaceId: physicalId, inputPath: values.get('--file')!, expectedSnapshot: values.get('--expected-snapshot')!, check }, async raw => {
            const current = await currentConfig();
            const live = current.workspaces.filter(w => (w.metricsUpdateWorkspaceId ?? w.id) === physicalId);
            if ((await settings.get()).configPath !== configPath || current.accountId !== config.accountId || current.epoch !== config.epoch ||
                live.length !== 1 || scope(live[0]) !== expected || raw.id !== physicalId || raw.root !== live[0].root ||
                raw.projectId !== live[0].projectId || raw.environmentId !== live[0].environmentId || raw.hostId !== live[0].hostId) {
              throw new Error('Доступ или папка компании изменились. Графики не обновлены.');
            }
          });
          return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
        } catch (error) { return { exitCode: 1, stderr: (error instanceof Error ? error.message : String(error)).slice(0, 2000) }; }
      }
      if (args.length !== 1 || (command !== 'status' && command !== 'sources')) return { exitCode: 1, stderr: usage };
      const overview = await buildOverview(await currentConfig());
      const values = overview.workspaces.map(({ id, name, sources, updatedAt }) => ({ id, name, updatedAt, sources }));
      const lines = values.map((item) => command === 'sources'
        ? `${item.name}\n${item.sources.map((source) => `  ${source.id}: ${source.path}`).join('\n')}`
        : `${item.name}: ${item.sources.filter((source) => source.updatedAt).length}/${item.sources.length} sources available; latest ${item.updatedAt || 'unknown'}`);
      return { exitCode: 0, stdout: json ? JSON.stringify({ generatedAt: overview.generatedAt, workspaces: values }, null, 2) : lines.join('\n\n') };
    },
  });
}
