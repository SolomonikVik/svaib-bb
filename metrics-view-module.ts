/** Permanent metrics page: BB stores a reference; gateway owns the document and revision. */
import { defineRpcContract, type BbPluginApi, type PluginAgentConfigurationContext } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { idSchema, refreshSchema } from 'bb-plugin-svaib-view-pilot/model';
import { buildMetricPlot } from 'bb-plugin-svaib-view-pilot/metrics-view';
import { viewSnapshotSchema, viewEventsSchema, ViewTransportError } from './view-transport';
import { createViewPluginContext, type PersistentRootValidator, type ViewAccountPort, type VerifiedViewCompany } from './view-native-context';
import { upgradeViewReference } from './view-storage';
import type { CatalogWorkspace } from './config';

const selector = z.object({ workspaceId: idSchema, accountId: z.string().min(1).max(256) }).strict();
const selected = selector.extend({ viewId: idSchema });
const discussion = z.object({ viewId: idSchema, revision: z.number().int().positive(), blockId: idSchema,
  metricId: idSchema, metricLabel: z.string().max(4000), mode: z.enum(['months', 'year', 'current']),
  year: z.string().regex(/^\d{4}$/), periods: z.array(z.string().max(10)).max(1200),
  seriesIds: z.array(idSchema).min(1).max(50), showPlan: z.boolean() }).strict();
const refreshContext = z.object({ viewId: idSchema, requestId: z.string().uuid(), leaseId: z.string().min(1).max(200),
  generation: z.number().int().positive(), revision: z.number().int().positive() }).strict();
const metricsTask = z.object({ schema: z.literal(1), task: z.literal('svaib-metrics'), workspaceId: idSchema,
  operation: z.enum(['prepare', 'discuss', 'refresh']), context: discussion.optional(), refresh: refreshContext.optional() }).strict();
const publicationChoice = z.object({ id: idSchema, title: z.string().min(1).max(2000), purpose: z.string().max(200),
  coverage: z.string().max(200), ready: z.boolean(), updatedAt: z.string(), revision: z.number().int().positive(), canEdit: z.boolean(), refresh: refreshSchema.nullable().optional() }).strict();
const publicationList = z.object({ publications: z.array(publicationChoice).max(100), complete: z.boolean() }).strict();
const refreshResult = z.object({ id: idSchema, revision: z.number().int().positive(), refresh: refreshSchema, acquired: z.boolean() }).strict();
const previewSchema = z.object({ prompt: z.string(), title: z.string(), projectId: z.string(), environmentId: z.string(),
  accountId: z.string(), hostId: z.string(), rootPath: z.string(), refresh: refreshContext.optional() }).strict();
const reply = <T extends z.ZodType>(schema: T) => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: schema }).strict(),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }).strict() }).strict(),
]);
export const metricsViewRpcContract = defineRpcContract({
  'metricsView.binding': { input: selector, output: reply(z.object({ viewId: idSchema.nullable(), publications: z.array(publicationChoice).optional(), complete: z.boolean().optional() }).strict()) },
  'metricsView.choose': { input: selected, output: reply(z.object({ viewId: idSchema }).strict()) },
  'metricsView.release': { input: selected.extend({ leaseId: z.string().min(1).max(200), requestId: z.string().uuid() }), output: reply(z.object({ released: z.literal(true) }).strict()) },
  'metricsView.pin': { input: selected, output: reply(z.object({ viewId: idSchema }).strict()) },
  'metricsView.get': { input: selected, output: reply(viewSnapshotSchema) },
  'metricsView.browserLink': { input: selected, output: reply(z.object({ viewId: idSchema, url: z.string().url() }).strict()) },
  'metricsView.events': { input: selected.extend({ pollId: z.string().uuid(), after: z.number().int().nonnegative(), timeoutMs: z.number().int().min(0).max(10000) }), output: reply(viewEventsSchema) },
  'metricsView.cancel': { input: selected.extend({ pollId: z.string().uuid() }), output: z.null() },
  'metricsView.refresh': { input: selected.extend({ requestId: z.string().uuid(), action: z.enum(['request', 'claim']) }), output: reply(z.object({ acquired: z.boolean(), refresh: refreshSchema, preview: previewSchema.optional() }).strict()) },
  'metricsView.prepare': { input: selector, output: reply(previewSchema) },
  'metricsView.discuss': { input: selector.extend({ context: discussion }), output: reply(previewSchema) },
});
type Page = { workspace: CatalogWorkspace; member: VerifiedViewCompany };
const pinSchema = z.object({ schema: z.literal(1), viewId: idSchema, accountId: z.string(), companyId: z.string(),
  subjectId: z.string(), environmentId: z.string(), projectId: z.string(), hostId: z.string(), root: z.string() }).strict();

export function registerMetricsViewModule(bb: BbPluginApi, options: {
  account: ViewAccountPort; resolveWorkspace(id: string): Promise<Page>;
  validatePersistentRootForTesting?: PersistentRootValidator;
}) {
  const native = createViewPluginContext({ sdk: bb.sdk, kv: bb.storage.kv, account: options.account,
    validatePersistentRootForTesting: options.validatePersistentRootForTesting });
  const lifetime = new AbortController();
  const polls = new Map<string, AbortController>();
  const canceled = new Map<string, number>();
  const active = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(25000)]);
  const key = (page: Page) => `screen:metrics:${page.member.account_id}:${page.workspace.id}`;
  function identity(page: Page) {
    const { workspace: w, member: m } = page;
    return { accountId: m.account_id, companyId: m.company_id, subjectId: m.subject_id,
      environmentId: w.environmentId, projectId: w.projectId, hostId: w.hostId, root: w.root };
  }
  async function resolve(input: z.infer<typeof selector>, signal: AbortSignal) {
    signal.throwIfAborted();
    const page = await options.resolveWorkspace(input.workspaceId);
    signal.throwIfAborted();
    if (page.member.account_id !== input.accountId || page.member.epoch !== options.account.epoch() ||
      !page.workspace.companyId || page.workspace.companyId !== page.member.company_id)
      throw new ViewTransportError('context_changed');
    return page;
  }
  async function fence(input: z.infer<typeof selector>, page: Page, signal: AbortSignal) {
    const next = await resolve(input, signal);
    if (page.member.epoch !== next.member.epoch || JSON.stringify(identity(next)) !== JSON.stringify(identity(page)))
      throw new ViewTransportError('context_changed');
  }
  async function remote(input: z.infer<typeof selector>, page: Page, name: string, args: Record<string, unknown>, signal: AbortSignal) {
    await fence(input, page, signal);
    const raw = await options.account.callMcpForContext({ name, arguments: { ...args, company_id: page.member.company_id } }, page.member, signal);
    await fence(input, page, signal);
    const envelope = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown() }).passthrough().parse(raw);
    if (envelope.isError) {
      const reason = z.object({ reason: z.string() }).safeParse(envelope.structuredContent);
      throw new ViewTransportError(reason.success ? reason.data.reason : 'view_unavailable');
    }
    return envelope.structuredContent;
  }
  async function pinFor(page: Page) {
    const raw = await bb.storage.kv.get(key(page));
    if (raw === undefined) return null;
    const normalized = upgradeViewReference(raw, 'screenId', 'viewId');
    const pin = pinSchema.parse(normalized);
    const { schema, viewId, ...saved } = pin;
    if (JSON.stringify(saved) !== JSON.stringify(identity(page))) throw new ViewTransportError('context_changed');
    if (normalized !== raw) await bb.storage.kv.set(key(page), pin);
    return viewId;
  }
  async function snapshot(input: z.infer<typeof selected>, page: Page, signal: AbortSignal, requirePin = true) {
    if (requirePin && await pinFor(page) !== input.viewId) throw new ViewTransportError('view_binding_required');
    const result = viewSnapshotSchema.parse(await remote(input, page, 'view_get', { id: input.viewId }, signal));
    if (result.view.id !== input.viewId || result.cursor !== result.view.revision) throw new ViewTransportError('invalid_response');
    if (requirePin && await pinFor(page) !== input.viewId) throw new ViewTransportError('context_changed');
    const blocks = result.view.document.blocks;
    if (result.view.publicationReady === false && result.view.publication && blocks.length === 0) return result;
    if (blocks.length !== 1 || blocks[0].type !== 'metrics') throw new ViewTransportError('metrics_required');
    return result;
  }
  async function savePin(input: z.infer<typeof selected>, page: Page, signal: AbortSignal, notify = true) {
    await fence(input, page, signal);
    await bb.storage.kv.set(key(page), { schema: 1, viewId: input.viewId, ...identity(page) });
    await fence(input, page, signal);
    if (notify) bb.realtime.publish('metrics-view-changed', { workspaceId: input.workspaceId });
    return { viewId: input.viewId };
  }
  async function pin(input: z.infer<typeof selected>, signal = active()) {
    const page = await resolve(input, signal);
    await snapshot(input, page, signal, false); // Explicit agent pin validates the component and live access.
    return savePin(input, page, signal);
  }
  async function choose(input: z.infer<typeof selected>) {
    const signal = active(), page = await resolve(input, signal);
    const found = await publications(input, page, signal);
    if (!found.publications.some(item => item.id === input.viewId)) throw new ViewTransportError('permission_denied');
    return savePin(input, page, signal);
  }
  async function publications(input: z.infer<typeof selector>, page: Page, signal: AbortSignal) {
    return publicationList.parse(await remote(input, page, 'view_metrics_list', {}, signal));
  }
  async function binding(input: z.infer<typeof selector>) {
    const signal = active(), page = await resolve(input, signal);
    const viewId = await pinFor(page);
    if (viewId) {
      await fence(input, page, signal);
      return { viewId };
    }
    const found = await publications(input, page, signal);
    if (found.complete && found.publications.length === 1) {
      const selected = found.publications[0].id;
      await savePin({ ...input, viewId: selected }, page, signal, false);
      return { viewId: selected };
    }
    await fence(input, page, signal);
    return { viewId: null, publications: found.publications, complete: found.complete };
  }
  function refreshPrompt(page: Page, refresh: z.infer<typeof refreshContext>) {
    return preview(page, 'Обновить показатели',
      `Обнови общую публикацию показателей ${refresh.viewId} компании ${page.member.company_id}.\n`+
      `Рабочее место: ${page.workspace.id}. До чтения источников выполни проверку svaib_metrics_context. `+
      `Работа уже зарезервирована: leaseId=${refresh.leaseId}, generation=${refresh.generation}, expectedRevision=${refresh.revision}. `+
      'Прочитай сохранённое представление и доступные источники скиллом metrics-values. Источники не меняй. '+
      'Сохрани ID, определения, охват и аудиторию; передай время проверки, пропуски и оговорки. '+
      `Опубликуй результат только view_metrics_refresh с action="complete", id="${refresh.viewId}", leaseId="${refresh.leaseId}", expectedRevision=${refresh.revision}, новым requestId и проверенным document. `+
      `При ошибке вызови view_metrics_refresh с action="fail", тем же id/leaseId, новым requestId и кратким error. Не используй view_update. `+
      'Если lease истёк или доступ отозван, остановись; поздний результат не публикуй.');
  }
  async function refreshPage(input: z.infer<typeof selected> & { requestId: string; action: 'request' | 'claim' }) {
    const signal = active(), page = await resolve(input, signal);
    if (await pinFor(page) !== input.viewId) throw new ViewTransportError('view_binding_required');
    const result = refreshResult.parse(await remote(input, page, 'view_metrics_refresh',
      { id: input.viewId, requestId: input.requestId, action: input.action }, signal));
    if (result.id !== input.viewId || await pinFor(page) !== input.viewId) throw new ViewTransportError('context_changed');
    await fence(input, page, signal);
    if (input.action !== 'claim' || !result.acquired) return { acquired: false, refresh: result.refresh };
    if (!result.refresh.leaseId) throw new ViewTransportError('invalid_response');
    const refresh = { viewId: input.viewId, requestId: input.requestId, leaseId: result.refresh.leaseId,
      generation: result.refresh.generation, revision: result.revision };
    return { acquired: true, refresh: result.refresh, preview: { ...refreshPrompt(page, refresh), refresh } };
  }
  async function browserLink(input: z.infer<typeof selected>) {
    const signal = active(), page = await resolve(input, signal);
    await snapshot(input, page, signal); // A link never bypasses the current pin or metrics access.
    const result = z.object({ id: idSchema, companyId: z.string(), revision: z.number().int().positive(),
      cursor: z.number().int().positive(), browserUrl: z.string().max(8192).nullable() }).passthrough()
      .safeParse(await remote(input, page, 'view_open', { id: input.viewId, preset: 'space-setup' }, signal));
    if (!result.success || result.data.id !== input.viewId || result.data.companyId !== page.member.company_id ||
      result.data.cursor !== result.data.revision) throw new ViewTransportError('invalid_response');
    if (!result.data.browserUrl) throw new ViewTransportError('browser_unavailable');
    let url: URL;
    try { url = new URL(result.data.browserUrl); } catch { throw new ViewTransportError('invalid_response'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.pathname !== '/view' ||
      url.searchParams.getAll('view').length !== 1 || url.searchParams.get('view') !== input.viewId ||
      url.searchParams.getAll('company_id').length !== 1 || url.searchParams.get('company_id') !== page.member.company_id ||
      [...url.searchParams.keys()].length !== 2)
      throw new ViewTransportError('invalid_response');
    if (await pinFor(page) !== input.viewId) throw new ViewTransportError('context_changed');
    await fence(input, page, signal);
    return { viewId: input.viewId, url: url.href };
  }
  function preview(page: Page, title: string, prompt: string) {
    return { prompt, title, projectId: page.workspace.projectId, environmentId: page.workspace.environmentId,
      accountId: page.member.account_id, hostId: page.workspace.hostId, rootPath: page.workspace.root };
  }
  const pollKey = (input: z.infer<typeof selected> & { pollId: string }) => `${input.accountId}:${input.workspaceId}:${input.viewId}:${input.pollId}`;
  async function preparePage(input: z.infer<typeof selector>) {
    const signal = active(), page = await resolve(input, signal), viewId = await pinFor(page);
    if (viewId) {
      const published = (await publications(input, page, signal)).publications.find(item => item.id === viewId);
      if (!(published ? published.canEdit : (await snapshot({ ...input, viewId }, page, signal)).view.canEdit)) throw new ViewTransportError('permission_denied');
      await fence(input, page, signal);
      return preview(page, 'Обновить показатели', 'Обнови общую публикацию показателей. Перед чтением источников нужно получить серверное поручение обновления.');
    }
    const found = await publications(input, page, signal);
    if (found.publications.length) throw new ViewTransportError('publication_available');
    if (!found.complete) throw new ViewTransportError('discovery_incomplete');
    await fence(input, page, signal);
    return preview(page, 'Подготовить показатели',
      `Подготовь общую публикацию показателей компании ${page.member.company_id} для страницы «Цели и показатели» BB.\n`+
      `Рабочее место: ${page.workspace.id}. Сначала вызови view_metrics_list; существующую подходящую публикацию используй без нового чтения источников. `+
      'Проверь view_catalog: нужен компонент metrics версии 1 (metricsDashboardVersion=1). Определи по описанию задачи и источников стабильные publication sourceKey, definitionKey, coverageKey, purpose, coverage и явную audience; не читай значения показателей до резервирования. '+
      'Вызови view_metrics_reserve с publication, новым id и requestId. ready=true: используй возвращённый существующий id без чтения источников. acquired=false и ready=false: работа уже выполняется, закрепи возвращённый id и сообщи об ожидании, источники не читай. acquired=true: сохрани leaseId, generation и revision, только теперь прочитай доступные источники скиллом metrics-values. Передай источники, время проверки, пропуски и оговорки; источники не меняй. '+
      'После резервирования публикуй только view_metrics_refresh action=complete с возвращёнными id, leaseId, expectedRevision и новым requestId; при ошибке action=fail с кратким error. document schemaVersion=1 с единственным блоком {id:"metrics",type:"metrics",version:1,title,data:<MetricsDashboard>}; '+
      'Для одинакового задания сохраняй те же ключи; sourceKey не должен зависеть от даты снимка. Доступны audience kind="company" или kind="members" с проверенными subject ID; закрытые данные не публикуй всем. '+
      `После серверной проверки закрепи возвращённый ID инструментом svaib_metrics_pin с workspaceId="${page.workspace.id}" и реальным viewId. Не публикуй локальный снимок автоматически. Если данных или доступа не хватает, задай один нужный вопрос.`);
  }
  async function discussPage(input: z.infer<typeof selector> & { context: z.infer<typeof discussion> }) {
      const signal = active(), page = await resolve(input, signal), context = input.context;
      const { view } = await snapshot({ ...input, viewId: context.viewId }, page, signal);
      if (view.revision !== context.revision) throw new ViewTransportError('revision_conflict');
      const block = view.document.blocks.find(b => b.id === context.blockId);
      const metric = block?.type === 'metrics' ? block.data.metrics.find(m => m.id === context.metricId) : undefined;
      if (!metric || new Set(context.seriesIds).size !== context.seriesIds.length || context.seriesIds.some(id => !metric.series.some(s => s.id === id))) throw new ViewTransportError('invalid_arguments');
      const plot = buildMetricPlot(metric, context.seriesIds, context.mode, context.year, context.showPlan);
      const first = plot.periods.indexOf(context.periods[0] ?? '');
      const validPeriods = plot.periods.length === 0 ? context.periods.length === 0
        : context.periods.length > 0 && first >= 0 && JSON.stringify(plot.periods.slice(first, first + context.periods.length)) === JSON.stringify(context.periods);
      if (!validPeriods) throw new ViewTransportError('invalid_arguments');
      return preview(page, `Обсудить: ${metric.label}`, 'Разбери выбранный показатель вместе со мной. Сначала прочитай сохранённый View через общий MCP. Если его редакция изменилась, скажи об этом и сверь контекст. Источники и документы без отдельного поручения не меняй.\n'+
        JSON.stringify({ companyId: page.member.company_id, viewId: view.id, revision: view.revision, blockId: block!.id,
          metricId: metric.id, metricLabel: metric.label, mode: context.mode, year: context.year, periods: context.periods,
          seriesIds: context.seriesIds, showPlan: context.showPlan, source: metric.source }));
  }
  async function respond<T>(run: () => Promise<T>) {
    try { return { ok: true as const, value: await run() }; }
    catch (cause) {
      const code = cause instanceof ViewTransportError ? cause.code : 'context_unavailable';
      const messages: Record<string, string> = {
        revision_conflict: 'Показатели изменились. Перечитай представление и выбери показатель снова.',
        metrics_required: 'Для этой страницы нужно представление с одной панелью показателей.',
        view_binding_required: 'Закрепи представление для этой страницы.',
        context_changed: 'Подключение или рабочая папка изменились. Открой страницу заново.',
        browser_unavailable: 'Ссылка для браузера пока недоступна.',
        publication_available: 'Общая публикация уже подготовлена. Открой её на странице показателей.',
        discovery_incomplete: 'Список публикаций пока неполон. Повтори проверку перед подготовкой.',
        refresh_unavailable: 'Обновление уже завершилось или поручение истекло. Начни обновление со страницы показателей.',
      };
      return { ok: false as const, error: { code, message: messages[code] ?? 'Представление недоступно. Проверь подключение и доступ к компании.' } };
    }
  }
  bb.rpc.register(metricsViewRpcContract, {
    'metricsView.binding': input => respond(() => binding(input)),
    'metricsView.choose': input => respond(() => choose(input)),
    'metricsView.release': input => respond(async () => {
      const signal = active(), page = await resolve(input, signal);
      if (await pinFor(page) !== input.viewId) throw new ViewTransportError('view_binding_required');
      const result = refreshResult.parse(await remote(input, page, 'view_metrics_refresh', { id: input.viewId, requestId: input.requestId, leaseId: input.leaseId, action: 'fail', error: 'Не удалось запустить партнёра для обновления данных.' }, signal));
      if (result.id !== input.viewId) throw new ViewTransportError('invalid_response');
      return { released: true as const };
    }),
    'metricsView.pin': input => respond(() => pin(input)),
    'metricsView.get': input => respond(async () => { const signal = active(); return snapshot(input, await resolve(input, signal), signal); }),
    'metricsView.browserLink': input => respond(() => browserLink(input)),
    'metricsView.events': input => respond(async () => {
      const id = pollKey(input), controller = new AbortController();
      for (const [key, expiry] of canceled) if (expiry < Date.now()) canceled.delete(key);
      if (canceled.delete(id)) controller.abort();
      polls.get(id)?.abort(); polls.set(id, controller);
      const signal = AbortSignal.any([active(), controller.signal]);
      try {
        const page = await resolve(input, signal);
        if (await pinFor(page) !== input.viewId) throw new ViewTransportError('context_changed');
        const result = viewEventsSchema.parse(await remote(input, page, 'view_events', { id: input.viewId, after: input.after, timeoutMs: input.timeoutMs }, signal));
        if (await pinFor(page) !== input.viewId || (result.view && (result.view.id !== input.viewId || result.cursor !== result.view.revision)) || Boolean(result.view) !== Boolean(result.events.length) || result.cursor < input.after ||
          result.historyStart > result.cursor || result.events.some((event, i) => event.revision !== event.seq || event.seq <= input.after || event.seq > result.cursor || (i > 0 && result.events[i-1].seq >= event.seq)))
          throw new ViewTransportError('invalid_response');
        return result;
      } finally { if (polls.get(id) === controller) polls.delete(id); }
    }),
    'metricsView.cancel': async input => { const id = pollKey(input); polls.get(id)?.abort(); canceled.set(id, Date.now()+30000); return null; },
    'metricsView.refresh': input => respond(() => refreshPage(input)),
    'metricsView.prepare': input => respond(() => preparePage(input)),
    'metricsView.discuss': input => respond(() => discussPage(input)),
  });
  bb.agents.registerTool({ name: 'svaib_metrics_pin', description: 'Закрепляет существующий серверный View с компонентом metrics на постоянной странице «Цели и показатели» BB. Проверяет текущую компанию, аккаунт, папку и доступ; числа не копирует.',
    parameters: z.object({ workspaceId: idSchema, viewId: idSchema }).strict(), execute: async (input, ctx) => {
      const signal = active(), live = await native.resolve(ctx.threadId, signal);
      const selector = { ...input, accountId: live.context.account_id };
      const page = await resolve(selector, signal);
      if (page.workspace.root !== live.realRoot || page.member.company_id !== live.context.company_id ||
        page.workspace.environmentId !== live.context.environment_id || page.workspace.hostId !== live.context.host_id || page.member.subject_id !== live.context.subject_id)
        throw new ViewTransportError('context_changed');
      return JSON.stringify(await pin(selector, signal));
    } });
  bb.onDispose(() => { lifetime.abort(); for (const controller of polls.values()) controller.abort(); polls.clear(); canceled.clear(); });
  bb.agents.registerTool({ name: 'svaib_metrics_context', description: 'Проверяет актуальные аккаунт, компанию, рабочую папку и выбранный контекст действия с показателями; возвращает поручение этой страницы.',
    parameters: z.object({}).strict(), execute: async (_, ctx) => respond(async () => {
      const task = metricsTask.parse(await bb.sdk.threads.getPluginMetadata({ threadId: ctx.threadId }));
      const page = await options.resolveWorkspace(task.workspaceId);
      const live = await native.resolve(ctx.threadId, active(), page.member.company_id);
      if (page.workspace.root !== live.realRoot || page.workspace.environmentId !== live.context.environment_id ||
        page.workspace.hostId !== live.context.host_id || page.workspace.projectId !== ctx.projectId ||
        page.member.account_id !== live.context.account_id || page.member.subject_id !== live.context.subject_id)
        throw new ViewTransportError('context_changed');
      const input = { workspaceId: task.workspaceId, accountId: live.context.account_id };
      if (task.operation === 'discuss') {
        if (!task.context) throw new ViewTransportError('invalid_arguments');
        return discussPage({ ...input, context: task.context });
      }
      if (task.operation === 'refresh') {
        if (!task.refresh) throw new ViewTransportError('invalid_arguments');
        const result = await refreshPage({ ...input, viewId: task.refresh.viewId, requestId: task.refresh.requestId, action: 'claim' });
        if (!result.acquired || !result.preview || JSON.stringify(result.preview.refresh) !== JSON.stringify(task.refresh))
          throw new ViewTransportError('refresh_unavailable');
        return result.preview;
      }
      return preparePage(input);
    }).then(value => JSON.stringify(value)) });
  return { tool: 'svaib_metrics_pin', isTask: (metadata: unknown) => metricsTask.safeParse(metadata).success,
    configure: (_context: PluginAgentConfigurationContext) => ({ tools: ['svaib_metrics_context'], skills: [],
      instructions: 'Это действие со страницы «Цели и показатели». Первым вызови svaib_metrics_context: он проверит текущий доступ, компанию, папку и поручение. Выполняй только успешно проверенное поручение и уточнения человека. При отказе не используй старый контекст для чтения или записи компании; помоги восстановить доступ.' }) };

}
