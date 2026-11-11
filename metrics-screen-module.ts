/** Permanent metrics page: BB stores a reference; gateway owns the document and revision. */
import { defineRpcContract, type BbPluginApi, type PluginAgentConfigurationContext } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { idSchema } from 'bb-plugin-svaib-screen-pilot/model';
import { buildMetricPlot } from 'bb-plugin-svaib-screen-pilot/metrics-view';
import { screenSnapshotSchema, screenEventsSchema, ScreenTransportError } from './screen-transport';
import { createScreenPluginContext, type PersistentRootValidator, type ScreenAccountPort, type VerifiedScreenCompany } from './screen-native-context';
import type { CatalogWorkspace } from './config';

const selector = z.object({ workspaceId: idSchema, accountId: z.string().min(1).max(256) }).strict();
const selected = selector.extend({ screenId: idSchema });
const discussion = z.object({ screenId: idSchema, revision: z.number().int().positive(), blockId: idSchema,
  metricId: idSchema, metricLabel: z.string().max(4000), mode: z.enum(['months', 'year', 'current']),
  year: z.string().regex(/^\d{4}$/), periods: z.array(z.string().max(10)).max(1200),
  seriesIds: z.array(idSchema).min(1).max(50), showPlan: z.boolean() }).strict();
const metricsTask = z.object({ schema: z.literal(1), task: z.literal('svaib-metrics'), workspaceId: idSchema, operation: z.enum(['prepare', 'discuss']), context: discussion.optional() }).strict();
const previewSchema = z.object({ prompt: z.string(), title: z.string(), projectId: z.string(), environmentId: z.string(),
  accountId: z.string(), hostId: z.string(), rootPath: z.string() }).strict();
const reply = <T extends z.ZodType>(schema: T) => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: schema }).strict(),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }).strict() }).strict(),
]);
export const metricsScreenRpcContract = defineRpcContract({
  'metricsScreen.binding': { input: selector, output: reply(z.object({ screenId: idSchema.nullable() }).strict()) },
  'metricsScreen.pin': { input: selected, output: reply(z.object({ screenId: idSchema }).strict()) },
  'metricsScreen.get': { input: selected, output: reply(screenSnapshotSchema) },
  'metricsScreen.events': { input: selected.extend({ pollId: z.string().uuid(), after: z.number().int().nonnegative(), timeoutMs: z.number().int().min(0).max(10000) }), output: reply(screenEventsSchema) },
  'metricsScreen.cancel': { input: selected.extend({ pollId: z.string().uuid() }), output: z.null() },
  'metricsScreen.prepare': { input: selector, output: reply(previewSchema) },
  'metricsScreen.discuss': { input: selector.extend({ context: discussion }), output: reply(previewSchema) },
});
type Page = { workspace: CatalogWorkspace; member: VerifiedScreenCompany };
const pinSchema = z.object({ schema: z.literal(1), screenId: idSchema, accountId: z.string(), companyId: z.string(),
  subjectId: z.string(), environmentId: z.string(), projectId: z.string(), hostId: z.string(), root: z.string() }).strict();

export function registerMetricsScreenModule(bb: BbPluginApi, options: {
  account: ScreenAccountPort; resolveWorkspace(id: string): Promise<Page>;
  validatePersistentRootForTesting?: PersistentRootValidator;
}) {
  const native = createScreenPluginContext({ sdk: bb.sdk, kv: bb.storage.kv, account: options.account,
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
      throw new ScreenTransportError('context_changed');
    return page;
  }
  async function fence(input: z.infer<typeof selector>, page: Page, signal: AbortSignal) {
    const next = await resolve(input, signal);
    if (page.member.epoch !== next.member.epoch || JSON.stringify(identity(next)) !== JSON.stringify(identity(page)))
      throw new ScreenTransportError('context_changed');
  }
  async function remote(input: z.infer<typeof selector>, page: Page, name: string, args: Record<string, unknown>, signal: AbortSignal) {
    await fence(input, page, signal);
    const raw = await options.account.callMcpForContext({ name, arguments: { ...args, company_id: page.member.company_id } }, page.member, signal);
    await fence(input, page, signal);
    const envelope = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown() }).passthrough().parse(raw);
    if (envelope.isError) {
      const reason = z.object({ reason: z.string() }).safeParse(envelope.structuredContent);
      throw new ScreenTransportError(reason.success ? reason.data.reason : 'screen_unavailable');
    }
    return envelope.structuredContent;
  }
  async function pinFor(page: Page) {
    const raw = await bb.storage.kv.get(key(page));
    if (raw === undefined) return null;
    const pin = pinSchema.parse(raw);
    const { schema, screenId, ...saved } = pin;
    if (JSON.stringify(saved) !== JSON.stringify(identity(page))) throw new ScreenTransportError('context_changed');
    return screenId;
  }
  async function snapshot(input: z.infer<typeof selected>, page: Page, signal: AbortSignal, requirePin = true) {
    if (requirePin && await pinFor(page) !== input.screenId) throw new ScreenTransportError('screen_binding_required');
    const result = screenSnapshotSchema.parse(await remote(input, page, 'screen_get', { id: input.screenId }, signal));
    if (result.screen.id !== input.screenId || result.cursor !== result.screen.revision) throw new ScreenTransportError('invalid_response');
    if (requirePin && await pinFor(page) !== input.screenId) throw new ScreenTransportError('context_changed');
    const blocks = result.screen.document.blocks;
    if (blocks.length !== 1 || blocks[0].type !== 'metrics') throw new ScreenTransportError('metrics_required');
    return result;
  }
  async function pin(input: z.infer<typeof selected>, signal = active()) {
    const page = await resolve(input, signal);
    await snapshot(input, page, signal, false); // Live membership and Screen access, including readers.
    await fence(input, page, signal);
    await bb.storage.kv.set(key(page), { schema: 1, screenId: input.screenId, ...identity(page) });
    await fence(input, page, signal);
    bb.realtime.publish('metrics-screen-changed', { workspaceId: input.workspaceId });
    return { screenId: input.screenId };
  }
  function preview(page: Page, title: string, prompt: string) {
    return { prompt, title, projectId: page.workspace.projectId, environmentId: page.workspace.environmentId,
      accountId: page.member.account_id, hostId: page.workspace.hostId, rootPath: page.workspace.root };
  }
  const pollKey = (input: z.infer<typeof selected> & { pollId: string }) => `${input.accountId}:${input.workspaceId}:${input.screenId}:${input.pollId}`;
  async function preparePage(input: z.infer<typeof selector>) {
      const signal = active(), page = await resolve(input, signal), screenId = await pinFor(page);
      if (screenId && !(await snapshot({ ...input, screenId }, page, signal)).screen.canEdit) throw new ScreenTransportError('permission_denied');
      await fence(input, page, signal);
      return preview(page, screenId ? 'Обновить показатели' : 'Подготовить показатели',
        `Подготовь показатели компании ${page.member.company_id} для страницы «Цели и показатели» BB.\n`+
        `Рабочее место: ${page.workspace.id}. ${screenId ? `Закреплён Screen ${screenId}; прочитай его и сохрани тот же ID.` : 'Сначала найди подходящий существующий Screen; новый создавай только при отсутствии подходящего.'}\n`+
        'Проверь screen_catalog: нужен компонент metrics версии 1 (metricsDashboardVersion=1). Прочитай доступные источники скиллом metrics-values; передай источники, время проверки, пропуски и оговорки. Источники не меняй. '+
        'Создай или обнови через общий MCP документ schemaVersion=1 с единственным блоком {id:"metrics",type:"metrics",version:1,title,data:<MetricsDashboard>}. '+
        `После серверной проверки закрепи экран инструментом svaib_metrics_pin с workspaceId="${page.workspace.id}" и реальным screenId. Не публикуй локальный снимок автоматически. Если данных или доступа не хватает, задай один нужный вопрос.`);
  }
  async function discussPage(input: z.infer<typeof selector> & { context: z.infer<typeof discussion> }) {
      const signal = active(), page = await resolve(input, signal), context = input.context;
      const { screen } = await snapshot({ ...input, screenId: context.screenId }, page, signal);
      if (screen.revision !== context.revision) throw new ScreenTransportError('revision_conflict');
      const block = screen.document.blocks.find(b => b.id === context.blockId);
      const metric = block?.type === 'metrics' ? block.data.metrics.find(m => m.id === context.metricId) : undefined;
      if (!metric || new Set(context.seriesIds).size !== context.seriesIds.length || context.seriesIds.some(id => !metric.series.some(s => s.id === id))) throw new ScreenTransportError('invalid_arguments');
      const plot = buildMetricPlot(metric, context.seriesIds, context.mode, context.year, context.showPlan);
      const first = plot.periods.indexOf(context.periods[0] ?? '');
      const validPeriods = plot.periods.length === 0 ? context.periods.length === 0
        : context.periods.length > 0 && first >= 0 && JSON.stringify(plot.periods.slice(first, first + context.periods.length)) === JSON.stringify(context.periods);
      if (!validPeriods) throw new ScreenTransportError('invalid_arguments');
      return preview(page, `Обсудить: ${metric.label}`, 'Разбери выбранный показатель вместе со мной. Сначала прочитай сохранённый Screen через общий MCP. Если его редакция изменилась, скажи об этом и сверь контекст. Источники и документы без отдельного поручения не меняй.\n'+
        JSON.stringify({ companyId: page.member.company_id, screenId: screen.id, revision: screen.revision, blockId: block!.id,
          metricId: metric.id, metricLabel: metric.label, mode: context.mode, year: context.year, periods: context.periods,
          seriesIds: context.seriesIds, showPlan: context.showPlan, source: metric.source }));
  }
  async function respond<T>(run: () => Promise<T>) {
    try { return { ok: true as const, value: await run() }; }
    catch (cause) {
      const code = cause instanceof ScreenTransportError ? cause.code : 'context_unavailable';
      const messages: Record<string, string> = {
        revision_conflict: 'Показатели изменились. Перечитай экран и выбери показатель снова.',
        metrics_required: 'Для этой страницы нужен Screen с одной панелью показателей.',
        screen_binding_required: 'Закрепи Screen для этой страницы.',
        context_changed: 'Подключение или рабочая папка изменились. Открой страницу заново.',
      };
      return { ok: false as const, error: { code, message: messages[code] ?? 'Screen недоступен. Проверь подключение и доступ к компании.' } };
    }
  }
  bb.rpc.register(metricsScreenRpcContract, {
    'metricsScreen.binding': input => respond(async () => {
      const signal = active(), page = await resolve(input, signal), screenId = await pinFor(page);
      if (screenId) await snapshot({ ...input, screenId }, page, signal);
      await fence(input, page, signal); return { screenId };
    }),
    'metricsScreen.pin': input => respond(() => pin(input)),
    'metricsScreen.get': input => respond(async () => { const signal = active(); return snapshot(input, await resolve(input, signal), signal); }),
    'metricsScreen.events': input => respond(async () => {
      const id = pollKey(input), controller = new AbortController();
      for (const [key, expiry] of canceled) if (expiry < Date.now()) canceled.delete(key);
      if (canceled.delete(id)) controller.abort();
      polls.get(id)?.abort(); polls.set(id, controller);
      const signal = AbortSignal.any([active(), controller.signal]);
      try {
        const page = await resolve(input, signal);
        if (await pinFor(page) !== input.screenId) throw new ScreenTransportError('context_changed');
        const result = screenEventsSchema.parse(await remote(input, page, 'screen_events', { id: input.screenId, after: input.after, timeoutMs: input.timeoutMs }, signal));
        if (await pinFor(page) !== input.screenId || result.screen.id !== input.screenId || result.cursor !== result.screen.revision || result.cursor < input.after ||
          result.historyStart > result.cursor || result.events.some((event, i) => event.revision !== event.seq || event.seq <= input.after || event.seq > result.cursor || (i > 0 && result.events[i-1].seq >= event.seq)))
          throw new ScreenTransportError('invalid_response');
        return result;
      } finally { if (polls.get(id) === controller) polls.delete(id); }
    }),
    'metricsScreen.cancel': async input => { const id = pollKey(input); polls.get(id)?.abort(); canceled.set(id, Date.now()+30000); return null; },
    'metricsScreen.prepare': input => respond(() => preparePage(input)),
    'metricsScreen.discuss': input => respond(() => discussPage(input)),
  });
  bb.agents.registerTool({ name: 'svaib_metrics_pin', description: 'Закрепляет существующий серверный Screen с компонентом metrics на постоянной странице «Цели и показатели» BB. Проверяет текущую компанию, аккаунт, папку и доступ; числа не копирует.',
    parameters: z.object({ workspaceId: idSchema, screenId: idSchema }).strict(), execute: async (input, ctx) => {
      const signal = active(), live = await native.resolve(ctx.threadId, signal);
      const selector = { ...input, accountId: live.context.account_id };
      const page = await resolve(selector, signal);
      if (page.workspace.root !== live.realRoot || page.member.company_id !== live.context.company_id ||
        page.workspace.environmentId !== live.context.environment_id || page.workspace.hostId !== live.context.host_id || page.member.subject_id !== live.context.subject_id)
        throw new ScreenTransportError('context_changed');
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
        throw new ScreenTransportError('context_changed');
      const input = { workspaceId: task.workspaceId, accountId: live.context.account_id };
      if (task.operation === 'discuss') {
        if (!task.context) throw new ScreenTransportError('invalid_arguments');
        return discussPage({ ...input, context: task.context });
      }
      return preparePage(input);
    }).then(value => JSON.stringify(value)) });
  return { tool: 'svaib_metrics_pin', isTask: (metadata: unknown) => metricsTask.safeParse(metadata).success,
    configure: (_context: PluginAgentConfigurationContext) => ({ tools: ['svaib_metrics_context'], skills: [],
      instructions: 'Это действие со страницы «Цели и показатели». Первым вызови svaib_metrics_context: он проверит текущий доступ, компанию, папку и поручение. Выполняй только успешно проверенное поручение и уточнения человека. При отказе не используй старый контекст для чтения или записи компании; помоги восстановить доступ.' }) };

}
