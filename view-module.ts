import { defineRpcContract, type BbPluginApi, type PluginAgentConfiguration, type PluginAgentConfigurationContext } from '@get-bb/plugin-sdk';
import { upgradeViewReference } from './view-storage';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { z } from 'zod';
import { idSchema, viewSchema, submitSchema, updateSchema, confirmScaffoldSchema } from 'bb-plugin-svaib-view-pilot/model';
import { createViewBackend, viewSnapshotSchema, viewEventsSchema, viewMutationSchema, ViewTransportError,
  type ViewContext, type ViewBackendPort, type Snapshot } from './view-transport';
import { createViewPluginContext, ViewContextError, type ViewAccountPort, type PersistentRootValidator } from './view-native-context';
import { scaffoldConfirmationSchema, scaffoldConfigSchema } from 'bb-plugin-svaib-view-pilot/scaffold';
import { spaceSetupDocument } from 'bb-plugin-svaib-view-pilot/agent-session';
import { assertImportRoot, importScaffold, verifyScaffoldSnapshot, ScaffoldImportError } from './scaffold-import';

const threadIdSchema = z.string().regex(/^thr_[a-z0-9]+$/);
const select = z.object({ threadId: threadIdSchema, viewId: idSchema }).strict();
const expandedPathsSchema = z.array(z.string().min(1).max(2000).refine(path => !path.startsWith('/') && !path.split('/').some(part => !part || part === '.' || part === '..'))).max(100)
  .describe('Папки для раскрытия: пути от корня, например ["00_компания"]. Корень уже раскрыт; абсолютные пути не принимаются.');
const sourceHashSchema = z.string().regex(/^[0-9a-f]{64}$/).describe('sourceHash из результата svaib_view_prepare с теми же roles и expandedPaths.');
const rolesSchema = z.record(z.string().min(1).max(500), z.object({
  role:z.enum(['unit','aspect','kit','infrastructure','workspace']).describe('unit — направление; aspect — ракурс; kit — панель управления; infrastructure — служебная папка; workspace — пространство.'),
  source:z.string().min(1).max(800).describe('Основание из прочитанного README: файл и смысл роли, например «README.md: компания как целое».'),
}).strict()).describe('Необязательные уточнения автоматически распознанных ролей. Ключ — относительный путь, корень не указывается. Пример: {"00_company":{"role":"unit","source":"README.md: компания как целое"}}.');
type OverviewInput = {roles?: z.infer<typeof rolesSchema>; expandedPaths?: string[]; expectedSourceHash?: string};
const overviewSourceSchema = z.object({ schema: z.literal(1), root: z.string(), hash: z.string(), expandedPaths: expandedPathsSchema.optional() }).strict();
const pollId = z.string().uuid();
const errorSchema = z.object({ code: z.string(), message: z.string() }).strict();
const reply = <T extends z.ZodType>(value: T) => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value }).strict(), z.object({ ok: z.literal(false), error: errorSchema }).strict(),
]);
const freshness = { capturedAt: z.string().nullable().optional(), source: z.enum(['matches', 'changed', 'unverified']).optional(), refreshSuggested: z.boolean().optional() };
// The canonical schemas are also Standard Schema compatible across package-local Zod copies.
export const viewRpcContract = defineRpcContract({
  'view.binding': { input: z.object({ threadId: threadIdSchema }).strict(), output: reply(z.object({ viewId: idSchema.nullable() }).strict()) },
  'view.openCompany': { input: z.object({ threadId: threadIdSchema, companyId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), companyName: z.string().min(1).max(2000), viewId: idSchema.optional() }).strict(),
    output: reply(z.union([z.object({ viewId: idSchema, revision: z.number(), cursor: z.number(), presentation: z.enum(['tab-opened', 'not-opened']), message: z.string(), ...freshness }).strict(),
      z.object({ choices: z.array(z.object({ id: idSchema, title: z.string(), updatedAt: z.string(), kind: z.enum(['overview', 'scaffold']) }).strict()).min(2).max(100) }).strict()])) },
  'view.get': { input: select, output: reply(viewSnapshotSchema) },
  'view.expand': { input: select.extend({ nodeId: idSchema, expectedRevision: z.number().int().positive(), requestId: z.string().uuid() }), output: reply(z.object({ view: viewSchema }).strict()) },
  'view.submit': { input: select.extend({ mutation: submitSchema }), output: reply(viewMutationSchema) },
  'view.update': { input: select.extend({ mutation: updateSchema }), output: reply(viewMutationSchema) },
  'view.confirm': { input: select.extend({ mutation: confirmScaffoldSchema }), output: reply(viewMutationSchema) },
  'view.events': { input: select.extend({ pollId, after: z.number().int().nonnegative(), timeoutMs: z.number().int().min(0).max(10000) }), output: reply(viewEventsSchema) },
  'view.cancel': { input: select.extend({ pollId }), output: z.null() },
  'view.presentation': { input: z.object({ threadId: threadIdSchema }).strict(), output: z.object({ requestId: z.string().uuid().nullable() }).strict() },
  'view.presented': { input: z.object({ threadId: threadIdSchema, requestId: z.string().uuid(), opened: z.boolean() }).strict(), output: z.null() },
});
const storedBinding = z.object({ schema: z.literal(1), view_id: idSchema, context: z.object({
  account_id: z.string(), company_id: z.string(), subject_id: z.string(), thread_id: threadIdSchema,
  environment_id: z.string(), host_id: z.string(),
}).strict(), real_root: z.string() }).strict();
const bindingKey = (threadId: string) => 'screen:binding:' + threadId;
const OPEN_TOOL = 'svaib_view_open';
const EXISTING_TOOL = 'svaib_view_existing';
const OVERVIEW_TOOL = 'svaib_view_overview';
const BIND_TOOL = 'svaib_view_bind';
const RESULT_TOOL = 'svaib_view_result';
const PREVIOUS_TOOL = 'svaib_view_previous';
const PREPARE_TOOL = 'svaib_view_prepare';
const selectionSchema = z.object({
  viewId: idSchema.describe('ID существующего View из ответа svaib_view_previous или открытия. Если ID неизвестен, используй svaib_view_open без viewId; ID компании здесь не подходит.'),
  companyId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).describe('Стабильный ID выбранной серверной компании. Обязателен, если в текущей папке нет привязки компании. Имя компании и локальный путь не подходят.').optional(),
  mode: z.literal('company').optional(), // accepted for older company callers; never a local fallback
}).strict();
const resultSchema = z.object({ id: idSchema, revision: z.number().int().positive(), cursor: z.number().int().positive(),
  companyId: z.string(), status: z.enum(['pending', 'submitted', 'confirmed']), browserUrl: z.string().url().nullable(),
  catalogVersion: z.string().optional(), canonSnapshot: z.string().optional(), applicationStatus: z.literal('not-tracked'),
  view: viewSchema, intent: scaffoldConfigSchema.nullable(), submission: viewSchema.shape.submission,
  confirmation: scaffoldConfirmationSchema.nullable(),
}).strict();
const messages: Record<string, string> = {
  permission_denied: 'Нет доступа к представлению выбранной компании. Проверь подключение с агентом.',
  company_required: 'Не указан companyId выбранной компании.',
  context_changed: 'Представление относится к другой компании или рабочей папке.',
  feature_disabled: 'Серверные представления пока не включены в этом контуре.',
  not_found: 'Это представление не найдено в выбранной компании.',
  revision_conflict: 'Представление уже изменилось. Перечитай его и повтори действие.',
  cursor_expired: 'История событий обновилась; восстанавливаю представление.',
};
function knownError(error: unknown) {
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    return { code: error.name === 'AbortError' ? 'aborted' : 'timeout', message: 'Ожидание представления остановлено.' };
  if (error instanceof ViewContextError) return { code: error.code, message: error.message };
  if (error instanceof ScaffoldImportError) return { code: error.code, message: error.message };
  if (error instanceof ViewTransportError) return { code: error.code, message: messages[error.code] ?? 'Представление отклонило запрос. Перечитай его или проверь подключение с агентом.' };
  const accountCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['authentication_required', 'resource_mismatch', 'company_context_unavailable', 'context_changed', 'invalid_arguments', 'mcp_unavailable', 'mcp_protocol_error'].includes(accountCode))
    return { code: accountCode, message: messages[accountCode] ?? 'Подключение svaib не подтвердило доступ. Проверь вход в кабинет и выбранную компанию с агентом.' };
  return { code: 'view_unavailable', message: 'Не удалось загрузить представление. Проверь подключение с агентом и повтори.' };
}

/** Register once from the root factory. Server MCP calls and UI share one backend OAuth grant. */
export function registerViewModule(bb: BbPluginApi, options: { account: ViewAccountPort; presentationTimeoutMs?: number;
  /** Test-only injection; production uses the shared persistent-folder validator. */
  validatePersistentRootForTesting?: PersistentRootValidator }) {
  const native = createViewPluginContext({ sdk: bb.sdk, kv: bb.storage.kv, account: options.account,
    validatePersistentRootForTesting: options.validatePersistentRootForTesting });
  const lifetime = new AbortController();
  const requestSignal = (signal?: AbortSignal) => AbortSignal.any([lifetime.signal, AbortSignal.timeout(25000), ...(signal ? [signal] : [])]);
  const polls = new Map<string, AbortController>();
  const canceled = new Map<string, number>();
  const presentations = new Map<string, { requestId: string; finish: (opened: boolean) => void }>();
  async function present(threadId: string, signal: AbortSignal) {
    presentations.get(threadId)?.finish(false);
    const requestId = randomUUID();
    return new Promise<boolean>(resolve => {
      const finish = (opened: boolean) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (presentations.get(threadId)?.requestId === requestId) presentations.delete(threadId);
        resolve(opened);
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(false), options.presentationTimeoutMs ?? 3500);
      presentations.set(threadId, { requestId, finish });
      if (signal.aborted) { finish(false); return; }
      signal.addEventListener('abort', abort, { once: true });
      bb.realtime.publish('view-open-requested', { threadId, requestId });
    });
  }
  const pollKey = (input: { threadId: string; viewId: string; pollId: string }) => `${input.threadId}:${input.viewId}:${input.pollId}`;
  function prune() { const now = Date.now(); for (const [key, expiry] of canceled) if (expiry < now) canceled.delete(key); }
  async function respond<T>(run: () => Promise<T>) {
    try { return { ok: true as const, value: await run() }; }
    catch (error) { return { ok: false as const, error: knownError(error) }; }
  }
  async function readBinding(threadId: string) {
    const raw = await bb.storage.kv.get(bindingKey(threadId));
    if (raw === undefined) return undefined;
    const normalized = upgradeViewReference(raw, 'screen_id', 'view_id');
    const parsed = storedBinding.safeParse(normalized);
    if (parsed.success && normalized !== raw) await bb.storage.kv.set(bindingKey(threadId), parsed.data);
    return parsed;
  }
  async function backend(threadId: string, viewId: string, signal: AbortSignal): Promise<ReturnType<typeof createViewBackend>> {
    const live = await native.resolve(threadId, signal);
    const stored = await readBinding(threadId);
    if (!stored?.success || stored.data.view_id !== viewId || stored.data.real_root !== live.realRoot ||
      JSON.stringify(stored.data.context) !== JSON.stringify(live.context))
      throw new ViewContextError('view_binding_required', 'Попроси агента открыть или привязать представление в этом разговоре.');
    return createViewBackend({ binding: { ...live.context, view_id: viewId },
      readTrustedContext: async active => {
        const checked = await native.resolve(threadId, active);
        if (checked.epoch !== live.epoch || checked.realRoot !== live.realRoot) throw new ViewTransportError('context_changed');
        return checked.context;
      },
      callMcp: (request, call) => options.account.callMcpForContext(request,
        { ...call.expectedContext, epoch: live.epoch }, call.signal),
    });
  }
  async function useBackend<T>(input: { threadId: string; viewId: string }, run: (port: ViewBackendPort, signal: AbortSignal) => Promise<T>, signal = requestSignal()) {
    const port = await backend(input.threadId, input.viewId, signal);
    try { return await run(port, signal); } finally { port.dispose(); }
  }
  type Live = Awaited<ReturnType<typeof native.resolve>>;
  function rootId(live: Live, device: string, inode: string) {
    return createHash('sha256').update(JSON.stringify([live.context.host_id, live.realRoot, device, inode])).digest('hex');
  }
  async function currentRootId(live: Live) {
    const stat = await lstat(live.realRoot, { bigint: true });
    return rootId(live, String(stat.dev), String(stat.ino));
  }
  async function sourceRelation(live: Live, viewId: string, overview: {sourceId?: string; sourceHash: string}, currentId: string) {
    if (overview.sourceId) return overview.sourceId === currentId ? 'same' : 'different';
    const stored = overviewSourceSchema.safeParse(await bb.storage.kv.get(`screen:overview:${live.context.company_id}:${viewId}`));
    if (!stored.success || stored.data.hash !== overview.sourceHash) return 'unknown';
    return stored.data.root === live.realRoot ? 'same' : 'different';
  }
  async function verifyOverviewSource(snapshot: Snapshot, live: Awaited<ReturnType<typeof native.resolve>>, viewId: string, active: AbortSignal) {
    const blocks = snapshot.view.document.blocks;
    const config = blocks.length === 1 && blocks[0].type === 'scaffold' && blocks[0].config.schemaVersion === 2 ? blocks[0].config : null;
    if (!config?.overview) return undefined;
    const source = overviewSourceSchema.safeParse(
      await bb.storage.kv.get(`screen:overview:${live.context.company_id}:${viewId}`));
    if (!source.success || source.data.root !== live.realRoot || source.data.hash !== config.overview.sourceHash)
      return 'unverified' as const;
    if (config.overview.sourceId && config.overview.sourceId !== await currentRootId(live)) return 'unverified' as const;
    const current = await importScaffold(live.realRoot, { companyName: config.companyName,
      limits: { maxDepth: config.overview.maxDepth }, expandedPaths: source.data.expandedPaths, allowDepthBoundary: true, signal: active });
    return current.snapshot.hash === source.data.hash ? 'matches' as const : 'changed' as const;
  }
  async function bind(threadId: string, viewId: string, active = requestSignal(), companyId?: string, restoreCompanyName?: string) {
    const live = await native.resolve(threadId, active, companyId);
    const port = createViewBackend({ binding: { ...live.context, view_id: viewId },
      readTrustedContext: async signal => { const checked = await native.resolve(threadId, signal);
        if (checked.epoch !== live.epoch || checked.realRoot !== live.realRoot) throw new ViewTransportError('context_changed');
        return checked.context; },
      callMcp: (request, call) => options.account.callMcpForContext(request, { ...call.expectedContext, epoch: live.epoch }, call.signal) });
    try {
      let snapshot = await port.get(active); // Shared /mcp must authorize the actual company and view first.
      // A requested constructor may have been explicitly cleared. Restore only
      // that empty view for its owner, preserving its ID and CAS boundary.
      if (restoreCompanyName && snapshot.view.canEdit === true && snapshot.view.document.blocks.length === 0) {
        if (await hasExistingContent(live.realRoot)) {
          await saveOverview(threadId, { viewId, companyId: live.context.company_id,
            requestId: randomUUID(), companyName: restoreCompanyName, expectedRevision: snapshot.view.revision }, active);
        } else {
          await remote(live, 'view_update', { id: viewId, requestId: randomUUID(),
            expectedRevision: snapshot.view.revision, document: spaceSetupDocument(restoreCompanyName) }, active);
        }
        snapshot = await port.get(active);
      }
      const source = await verifyOverviewSource(snapshot, live, viewId, active);
      const block = snapshot.view.document.blocks[0];
      const capturedAt = block?.type === 'scaffold' && block.config.schemaVersion === 2 ? block.config.overview?.capturedAt ?? null : null;
      const refreshSuggested = source !== undefined && (source !== 'matches' || !capturedAt || Date.now() - Date.parse(capturedAt) > 24 * 60 * 60 * 1000);
      if (JSON.stringify(await native.resolve(threadId, active)) !== JSON.stringify(live)) throw new ViewTransportError('context_changed');
      await bb.storage.kv.set(bindingKey(threadId), { schema: 1, view_id: viewId, context: live.context, real_root: live.realRoot });
      if (JSON.stringify(await native.resolve(threadId, active)) !== JSON.stringify(live)) throw new ViewTransportError('context_changed');
      bb.realtime.publish('view-changed', { threadId, viewId });
      const opened = await present(threadId, active);
      return { viewId, revision: snapshot.view.revision, cursor: snapshot.cursor,
        ...(source !== undefined ? { source, capturedAt, refreshSuggested } : {}),
        presentation: opened ? 'tab-opened' as const : 'not-opened' as const,
        message: opened ? 'BB открыл вкладку представления. Дождись загрузки и попроси пользователя проверить структуру.'
          : 'Представление подготовлено, но открытие вкладки BB не подтверждено. Не утверждай, что пользователь её видит; попроси открыть «Конструктор» в этом разговоре.' };
    } finally { port.dispose(); }
  }
  async function openView(threadId: string, viewId: string, companyId: string | undefined, create: { requestId: string; companyName: string; onlyIfEmpty?: boolean; sourceId?: string } | undefined, active: AbortSignal) {
    const live = await native.resolve(threadId, active, companyId);
    const result = await options.account.callMcpForContext({ name: 'view_open', arguments: {
      id: viewId, preset: 'space-setup', company_id: live.context.company_id, ...(create ? { create } : {}),
    } }, { ...live.context, epoch: live.epoch }, active);
    const parsed = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown() }).passthrough().parse(result);
    if (parsed.isError) {
      const reason = z.object({ reason: z.string() }).safeParse(parsed.structuredContent);
      throw new ViewTransportError(reason.success ? reason.data.reason : 'mcp_error');
    }
    const after = await native.resolve(threadId, active);
    if (JSON.stringify(after) !== JSON.stringify(live)) throw new ViewTransportError('context_changed');
    return bind(threadId, viewId, active);
  }
  async function remote(live: Awaited<ReturnType<typeof native.resolve>>, name: string, args: Record<string, unknown>, active: AbortSignal) {
    if (JSON.stringify(await native.resolve(live.context.thread_id, active)) !== JSON.stringify(live)) throw new ViewTransportError('context_changed');
    const raw = await options.account.callMcpForContext({ name, arguments: { ...args, company_id: live.context.company_id } }, { ...live.context, epoch: live.epoch }, active);
    const envelope = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown() }).passthrough().parse(raw);
    if (envelope.isError) { const reason = z.object({ reason: z.string() }).safeParse(envelope.structuredContent); throw new ViewTransportError(reason.success ? reason.data.reason : 'mcp_error'); }
    if (JSON.stringify(await native.resolve(live.context.thread_id, active)) !== JSON.stringify(live)) throw new ViewTransportError('context_changed');
    return envelope.structuredContent;
  }
  async function prepareTree(live: Awaited<ReturnType<typeof native.resolve>>, input: OverviewInput & {companyName:string; previousConfig?: Parameters<typeof importScaffold>[1]['previousConfig']}, active: AbortSignal) {
    const imported = await importScaffold(live.realRoot, {companyName:input.companyName,roles:input.roles,previousConfig:input.previousConfig,
      expandedPaths:input.expandedPaths,limits:{maxDepth:1},allowDepthBoundary:true,signal:active});
    await verifyScaffoldSnapshot(live.realRoot,imported.snapshot,active);
    if(input.expectedSourceHash && imported.snapshot.hash!==input.expectedSourceHash)
      throw new ViewContextError('snapshot_changed','Папка изменилась после проверки агентом. Перечитай дерево перед показом.');
    const sourceId = rootId(live, imported.snapshot.root.device, imported.snapshot.root.inode);
    if (input.previousConfig?.overview?.sourceId && input.previousConfig.overview.sourceId !== sourceId)
      throw new ViewContextError('overview_source_mismatch', 'Обзор относится к другой папке.');
    imported.scaffoldConfig.overview!.sourceId = sourceId;
    imported.scaffoldConfig.overview!.capturedAt=new Date().toISOString();
    return imported;
  }
  async function saveOverview(threadId: string, input: OverviewInput & { viewId: string; companyId?: string; requestId: string; companyName?: string; expectedRevision?: number; onlyIfEmpty?: boolean; revealNodeId?: string }, active: AbortSignal) {
    const live = await native.resolve(threadId, active, input.companyId);
    const capability = await remote(live, 'view_catalog', {}, active) as Record<string, unknown>;
    if (capability.overviewVersion !== 1 || (input.expectedRevision !== undefined && capability.overviewRefreshVersion !== 1))
      throw new ViewContextError('overview_unsupported', 'Сервер ещё не поддерживает обновление обзора. Сохранённый View оставлен на месте.');
    const previous = input.expectedRevision === undefined ? undefined : viewSnapshotSchema.parse(await remote(live, 'view_get', {id: input.viewId}, active)).view;
    if (previous && previous.revision !== input.expectedRevision) throw new ViewTransportError('revision_conflict');
    const oldBlock = previous?.document.blocks[0];
    if (previous && previous.document.blocks.length > 0 && (previous.document.blocks.length !== 1 || oldBlock?.type !== 'scaffold')) throw new ViewContextError('wrong_view_kind', 'Обновлять из папки можно только конструктор каркаса.');
    const previousConfig = oldBlock?.type === 'scaffold' && oldBlock.config.schemaVersion === 2 ? oldBlock.config : undefined;
    if (previousConfig?.overview && await sourceRelation(live, input.viewId, previousConfig.overview, await currentRootId(live)) !== 'same')
      throw new ViewContextError('overview_source_mismatch', 'Источник сохранённого обзора не совпадает с выбранной папкой или неизвестен.');
    const companyName = input.companyName ?? previousConfig?.companyName;
    if (!companyName) throw new ViewContextError('wrong_view_kind', 'Этот экран не является конструктором каркаса.');
    const imported = await prepareTree(live,{...input,companyName,previousConfig},active);
    if (input.revealNodeId && previousConfig) {
      // The new read must not bless stale branches preserved from the old tree.
      if (await verifyOverviewSource({view:previous!,cursor:previous!.revision},live,input.viewId,active) !== 'matches')
        throw new ViewContextError('snapshot_changed','Папка изменилась во время чтения ветки. Обнови каркас с сохранением пожеланий.');
      await verifyScaffoldSnapshot(live.realRoot,imported.snapshot,active);
      const revealed = imported.scaffoldConfig.tree.find(node => node.id === input.revealNodeId);
      if (!revealed || revealed.type !== 'folder') throw new ViewTransportError('invalid_arguments');
      const nodes = new Map(imported.scaffoldConfig.tree.map(node => [node.id,node]));
      const parts: string[] = []; let cursor = revealed;
      while(cursor.parentId) {parts.unshift(cursor.name);cursor=nodes.get(cursor.parentId)!;}
      const boundary = imported.snapshot.entries.find(entry => entry.path === parts.join('/'));
      if(boundary?.kind !== 'directory' || boundary.opaqueReason !== null) throw new ViewTransportError('invalid_arguments');
      // Only replace the formerly opaque branch. Saved edits elsewhere remain intact.
      const below = (tree: typeof previousConfig.tree) => {
        const ids = new Set([input.revealNodeId!]); let changed = true;
        while (changed) { changed = false; for (const node of tree) if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {ids.add(node.id); changed = true;} }
        return ids;
      };
      const oldIds = below(previousConfig.tree), newIds = below(imported.scaffoldConfig.tree);
      imported.scaffoldConfig = scaffoldConfigSchema.parse({...imported.scaffoldConfig,
        tree: [...previousConfig.tree.filter(node => !oldIds.has(node.id)), ...imported.scaffoldConfig.tree.filter(node => newIds.has(node.id))]}) as typeof imported.scaffoldConfig;
    }
    const document = { schemaVersion: 1, title: previous?.document.title ?? 'Существующее пространство — обзор',
      description: 'Ограниченный снимок папки. Нераскрытые ветки сохранены; файлы пространства не изменяются.', layout: 'stack',
      blocks: [{ id: oldBlock?.id ?? 'space-setup', type: 'scaffold', version: 1, title: 'Фактические папки и файлы', config: imported.scaffoldConfig }] };
    await remote(live, previous ? 'view_update' : 'view_create', { id: input.viewId, requestId: input.requestId, document,
      ...(previous ? { expectedRevision: input.expectedRevision, refreshOverview: true } : input.onlyIfEmpty ? { onlyIfEmpty: true } : {}) }, active);
    await bb.storage.kv.set(`screen:overview:${live.context.company_id}:${input.viewId}`, {schema: 1, root: live.realRoot, hash: imported.snapshot.hash,
      ...(input.expandedPaths?.length ? {expandedPaths: input.expandedPaths} : {})});
    bb.realtime.publish('view-changed', {threadId, viewId: input.viewId});
    return { imported, live };
  }
  async function hasExistingContent(root: string): Promise<boolean> {
    assertImportRoot(root);
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name !== '.svaib' || !entry.isDirectory() || entry.isSymbolicLink()) return true;
      const metadata = await readdir(`${root}/.svaib`, { withFileTypes: true });
      if (metadata.some(item => item.name !== 'platform.json' || !item.isFile() || item.isSymbolicLink())) return true;
    }
    return false;
  }
  const openCompany = (input: OverviewInput & { threadId: string; companyId: string; companyName: string; viewId?: string; expectedRevision?:number }, signal?: AbortSignal) => respond(async () => {
      const active = requestSignal(signal);
      const live = await native.resolve(input.threadId, active, input.companyId);
      async function remote(name: string, args: Record<string, unknown>) {
        const raw = await options.account.callMcpForContext({ name, arguments: { ...args, company_id: live.context.company_id } }, { ...live.context, epoch: live.epoch }, active);
        const envelope = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown() }).passthrough().parse(raw);
        if (envelope.isError) { const reason = z.object({ reason: z.string() }).safeParse(envelope.structuredContent); throw new ViewTransportError(reason.success ? reason.data.reason : 'mcp_error'); }
        if (JSON.stringify(await native.resolve(input.threadId, active)) !== JSON.stringify(live)) throw new ViewTransportError('context_changed');
        return envelope.structuredContent;
      }
      const catalog = z.object({ viewDiscoveryVersion: z.number().int().min(2) }).passthrough().safeParse(await remote('view_catalog', {}));
      if (!catalog.success) throw new ViewContextError('view_discovery_unsupported', 'Сервер ещё не поддерживает поиск конструкторов компании. Обнови серверный View; новый экран автоматически не создаётся.');
      async function reopen(viewId:string) {
        if(input.expectedSourceHash) {
          if(input.expectedRevision===undefined)throw new ViewContextError('view_discovery_changed','Найден сохранённый View. Прочитай его пожелания и ревизию перед обновлением.');
          await saveOverview(input.threadId,{...input,viewId,requestId:randomUUID()},active);
        }
        return bind(input.threadId,viewId,active,input.companyId,input.companyName);
      }
      const discoverySchema = z.object({ complete: z.boolean(), views: z.array(z.object({ id: idSchema, title: z.string().min(1).max(2000), updatedAt: z.string().max(100), kind: z.enum(['overview', 'scaffold']) }).strict()).max(100) }).strict();
      async function choose(allowCreate: boolean): Promise<Awaited<ReturnType<typeof openView>> | { choices: z.infer<typeof discoverySchema>['views'] }> {
        const found = discoverySchema.parse(await remote('view_get', { discover: true, component: 'scaffold' }));
        if (!found.complete) throw new ViewContextError('view_discovery_incomplete', 'Список конструкторов получен не полностью; создание и автоматический выбор остановлены.');
        if (input.viewId) {
          if (!found.views.some(item => item.id === input.viewId)) throw new ViewContextError('view_choice_stale', 'Выбранный конструктор больше не доступен. Обнови список.');
          return reopen(input.viewId);
        }
        const sourceId = await currentRootId(live);
        const choices = [];
        for (const item of found.views) {
          if (item.kind === 'overview') {
            const snapshot = viewSnapshotSchema.parse(await remote('view_get', {id: item.id}));
            const block = snapshot.view.document.blocks[0];
            if (block?.type === 'scaffold' && block.config.overview &&
              await sourceRelation(live, item.id, block.config.overview, sourceId) === 'different') continue;
          }
          choices.push(item);
        }
        if (choices.length === 1) return reopen(choices[0].id);
        if (choices.length > 1) return { choices };
        if (!allowCreate) throw new ViewContextError('view_discovery_changed', 'Список конструкторов изменился. Повтори открытие.');
        const existing = await hasExistingContent(live.realRoot);
        if (JSON.stringify(await native.resolve(input.threadId, active)) !== JSON.stringify(live)) throw new ViewTransportError('context_changed');
        const viewId = 'scaffold-' + randomUUID();
        try {
          if (existing) {
            await saveOverview(input.threadId, { viewId, companyId: input.companyId,
              requestId: randomUUID(), companyName: input.companyName, onlyIfEmpty: true,
              roles:input.roles,expandedPaths:input.expandedPaths,expectedSourceHash:input.expectedSourceHash }, active);
            return bind(input.threadId, viewId, active, input.companyId);
          }
          if(input.expectedSourceHash)throw new ViewContextError('snapshot_changed','Папка изменилась после проверки агентом. Подготовь дерево заново.');
          return await openView(input.threadId, viewId, input.companyId,
            { requestId: randomUUID(), companyName: input.companyName, onlyIfEmpty: true, ...(found.views.length ? {sourceId} : {}) }, active);
        }
        catch (error) {
          if (error instanceof ViewTransportError && ['view_discovery_changed', 'already_exists'].includes(error.code)) return choose(false);
          throw error;
        }
      }
      return choose(true);
  });
  bb.rpc.register(viewRpcContract, {
    'view.openCompany': input => openCompany(input),
    'view.binding': input => respond(async () => {
      const active = requestSignal();
      const parsed = await readBinding(input.threadId);
      if (!parsed) return { viewId: null };
      if (!parsed.success) throw new ViewTransportError('invalid_binding');
      // Binding is an identity reference. The surface must make its own live authorized read before showing data.
      const port = await backend(input.threadId, parsed.data.view_id, active);
      port.dispose();
      return { viewId: parsed.data.view_id };
    }),
    'view.get': input => respond(() => useBackend(input, (port, signal) => port.get(signal))),
    'view.expand': input => respond(async () => {
      const active = requestSignal();
      const snapshot = await useBackend(input, port => port.get(active), active);
      if (snapshot.view.canEdit !== true) throw new ViewTransportError('permission_denied');
      if (snapshot.view.revision !== input.expectedRevision) throw new ViewTransportError('revision_conflict');
      const block = snapshot.view.document.blocks[0];
      if (snapshot.view.document.blocks.length !== 1 || block?.type !== 'scaffold' || block.config.schemaVersion !== 2 || !block.config.overview)
        throw new ViewTransportError('invalid_arguments');
      const nodes = new Map(block.config.tree.map(node => [node.id, node]));
      const target = nodes.get(input.nodeId);
      if (!target || target.type !== 'folder' || !target.note.startsWith('Не загружено.')) throw new ViewTransportError('invalid_arguments');
      const parts: string[] = []; let cursor = target;
      while (cursor.parentId) {parts.unshift(cursor.name); cursor = nodes.get(cursor.parentId)!;}
      const live = await native.resolve(input.threadId, active);
      if (await verifyOverviewSource(snapshot, live, input.viewId, active) !== 'matches')
        throw new ViewContextError('snapshot_changed', 'Папка изменилась. Попроси агента обновить каркас с сохранением пожеланий.');
      const source = overviewSourceSchema.parse(await bb.storage.kv.get(`screen:overview:${live.context.company_id}:${input.viewId}`));
      const expandedPaths = [...new Set([...(source.expandedPaths ?? []), parts.join('/')])];
      expandedPathsSchema.parse(expandedPaths);
      await saveOverview(input.threadId, {viewId: input.viewId, requestId: input.requestId,
        expectedRevision: input.expectedRevision, expandedPaths, revealNodeId: input.nodeId}, active);
      return {view: (await useBackend(input, port => port.get(active), active)).view};
    }),
    'view.submit': input => respond(() => useBackend(input, (port, signal) => port.submit(input.mutation, signal))),
    'view.update': input => respond(() => useBackend(input, (port, signal) => port.update(input.mutation, signal))),
    'view.confirm': input => respond(() => useBackend(input, (port, signal) => port.confirmScaffold(input.mutation, signal))),
    'view.events': input => respond(async () => {
      prune(); const key = pollKey(input);
      if (canceled.has(key)) throw new ViewTransportError('aborted');
      if (polls.has(key) || polls.size >= 128) throw new ViewTransportError('poll_conflict');
      const controller = new AbortController(); polls.set(key, controller);
      const signal = requestSignal(controller.signal);
      try { return await useBackend(input, (port, active) => port.events({ after: input.after, timeoutMs: input.timeoutMs }, active), signal); }
      finally { polls.delete(key); }
    }),
    'view.cancel': input => {
      prune(); const key = pollKey(input); polls.get(key)?.abort();
      if (canceled.size >= 256) canceled.delete(canceled.keys().next().value!);
      canceled.set(key, Date.now() + 60000); return null;
    },
    'view.presentation': ({ threadId }) => ({ requestId: presentations.get(threadId)?.requestId ?? null }),
    'view.presented': ({ threadId, requestId, opened }) => {
      const current = presentations.get(threadId);
      if (current?.requestId === requestId) current.finish(opened);
      return null;
    },
  });
  bb.agents.registerTool({ name: BIND_TOOL, description: 'Показать в BB существующий серверный View по его viewId.',
    parameters: selectionSchema, execute: async ({ viewId, companyId }, ctx) =>
      JSON.stringify(await respond(() => bind(ctx.threadId, viewId, requestSignal(ctx.signal), companyId))) });
  bb.agents.registerTool({ name: PREPARE_TOOL, description: 'Локальный инструмент BB читает выбранную постоянную папку разговора. Возвращает дерево, границы и sourceHash для показа конструктора.',
    parameters: selectionSchema.partial({viewId:true}).extend({companyName:z.string().min(1).max(2000),roles:rolesSchema.optional(),expandedPaths:expandedPathsSchema.optional()}).strict(),
    execute: async ({viewId,companyId,companyName,roles,expandedPaths},ctx) => JSON.stringify(await respond(async () => {
      const active=requestSignal(ctx.signal),live=await native.resolve(ctx.threadId,active,companyId);
      if(!await hasExistingContent(live.realRoot))throw new ViewContextError('empty_space','Выбранная папка пустая. Обзор существующего пространства недоступен.');
      const previous=viewId ? viewSnapshotSchema.parse(await remote(live,'view_get',{id:viewId},active)).view : undefined;
      const block=previous?.document.blocks[0];
      const previousConfig=block?.type==='scaffold' && block.config.schemaVersion===2 ? block.config : undefined;
      if (viewId && previousConfig?.overview && await sourceRelation(live, viewId, previousConfig.overview, await currentRootId(live)) !== 'same')
        throw new ViewContextError('overview_source_mismatch', 'Источник прежних ролей не совпадает с выбранной папкой или неизвестен.');
      const imported=await prepareTree(live,{companyName,roles,expandedPaths,previousConfig},active);
      return {sourceHash:imported.snapshot.hash,config:imported.scaffoldConfig,
        ...(previous ? {viewId,expectedRevision:previous.revision} : {}),
        instruction:'Это черновик для проверки агентом. Проверь дерево осознанно до передачи в View; сам факт вызова инструмента проверкой не считается.'};
    })) });
  bb.agents.registerTool({ name: OPEN_TOOL, description: 'Открыть конструктор компании. Без viewId предлагает подходящие View. Для показа дерева передай параметры проверенного черновика и его sourceHash в expectedSourceHash, для сохранённого View — также expectedRevision.',
    parameters: selectionSchema.partial({ viewId: true }).extend({ companyName: z.string().min(1).max(2000).optional(), roles:rolesSchema.optional(),expandedPaths:expandedPathsSchema.optional(),expectedSourceHash:sourceHashSchema.optional(),expectedRevision:z.number().int().positive().optional(), create: z.object({ requestId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), companyName: z.string().min(1).max(2000) }).strict().optional() }).strict(),
    execute: async ({ viewId, create, companyId, companyName,roles,expandedPaths,expectedSourceHash,expectedRevision }, ctx) => {
      if (viewId && (create || !companyName)) return JSON.stringify(await respond(() => openView(ctx.threadId, viewId, companyId, create, requestSignal(ctx.signal))));
      if (create) return JSON.stringify({ ok: false, error: { code: 'invalid_request', message: 'Для поиска по компании передай companyId без create; ID нового View определит система.' } });
      return JSON.stringify(await respond(async () => {
        const active = requestSignal(ctx.signal);
        const selected = companyId ?? (await native.resolve(ctx.threadId, active)).context.company_id;
        const result = await openCompany({ threadId: ctx.threadId, companyId: selected, companyName: companyName ?? selected, roles,expandedPaths,expectedSourceHash,expectedRevision,...(viewId ? { viewId } : {}) }, active);
        if (!result.ok) throw new ViewContextError(result.error.code, result.error.message);
        return result.value;
      }));
    } });
  bb.agents.registerTool({ name: EXISTING_TOOL, description: 'Показать снимок рабочей папки в View. Обновление по expectedRevision заменяет снимок и снимает подтверждение. Используй параметры и хеш проверенного черновика.',
    parameters: selectionSchema.extend({ expectedRevision: z.number().int().positive().optional(), expectedSourceHash:sourceHashSchema.optional(),requestId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), companyName: z.string().min(1).max(100), expandedPaths: expandedPathsSchema.optional(),
      roles: rolesSchema.optional(),
    }).strict(),
    execute: async ({ viewId, companyId, requestId, companyName, roles, expectedRevision, expandedPaths,expectedSourceHash }, ctx) => JSON.stringify(await respond(async () => {
      const active = requestSignal(ctx.signal);
      const { imported } = await saveOverview(ctx.threadId, {viewId, companyId, requestId, companyName, roles, expectedRevision, expandedPaths,expectedSourceHash}, active);
      const opened = await bind(ctx.threadId, viewId, active);
      return { ...opened, coverage: 'limited-overview', hiddenBranches: imported.snapshot.ignoredRoots.length,
        warning: 'Это частичный обзор, а не план изменения файлов. Нераскрытые ветки сохранены; перед изменениями нужен полный разбор.' };
    })) });
  bb.agents.registerTool({ name: RESULT_TOOL, description: 'Прочитать состояние View, выбор и пожелания человека. Изменение файлов требует отдельного согласования.',
    parameters: z.object({ viewId: idSchema }).strict(), execute: async ({ viewId }, ctx) => JSON.stringify(await respond(async () => {
      const active = requestSignal(ctx.signal);
      const live = await native.resolve(ctx.threadId, active);
      const result = await options.account.callMcpForContext({ name: 'view_result', arguments: { id: viewId, company_id: live.context.company_id } }, { ...live.context, epoch: live.epoch }, active);
      const envelope = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown() }).passthrough().parse(result);
      if (envelope.isError) {
        const reason = z.object({ reason: z.string() }).safeParse(envelope.structuredContent);
        throw new ViewTransportError(reason.success ? reason.data.reason : 'mcp_error');
      }
      const parsed = resultSchema.safeParse(envelope.structuredContent);
      if (!parsed.success || parsed.data.id !== viewId || parsed.data.companyId !== live.context.company_id ||
        parsed.data.cursor !== parsed.data.revision || parsed.data.view.id !== viewId || parsed.data.view.revision !== parsed.data.revision ||
        JSON.stringify(parsed.data.submission) !== JSON.stringify(parsed.data.view.submission) ||
        (parsed.data.status === 'confirmed' ? parsed.data.confirmation?.revision !== parsed.data.revision : parsed.data.confirmation !== null))
        throw new ViewTransportError('invalid_response');
      const after = await native.resolve(ctx.threadId, active);
      if (JSON.stringify(after) !== JSON.stringify(live)) throw new ViewTransportError('context_changed');
      return parsed.data;
    })) });
  bb.agents.registerTool({ name: OVERVIEW_TOOL, description: 'Прочитать сохранённое дерево View и границы снимка.',
    parameters: z.object({ viewId: idSchema }).strict(), execute: async ({ viewId }, ctx) => JSON.stringify(await respond(async () => {
      const active = requestSignal(ctx.signal);
      const live = await native.resolve(ctx.threadId, active);
      const snapshot = viewSnapshotSchema.parse(await remote(live,'view_get',{id:viewId},active));
      const blocks = snapshot.view.document.blocks;
      if (blocks.length !== 1 || blocks[0].type !== 'scaffold' || blocks[0].config.schemaVersion !== 2 || !blocks[0].config.overview)
        throw new ViewContextError('not_overview', 'Этот View не является ограниченным обзором.');
      const source = await verifyOverviewSource(snapshot, live, viewId, active);
      if (JSON.stringify(await native.resolve(ctx.threadId, active)) !== JSON.stringify(live)) throw new ViewTransportError('context_changed');
      return { viewId, revision: snapshot.view.revision, cursor: snapshot.cursor,
        config: blocks[0].config, status: 'overview-only', source,
        warning: source === 'matches' ? 'Исходный снимок соответствует рабочей папке в пределах его границ; изменения дерева выражают намерение, перед файловыми действиями нужен полный разбор.'
          : source === 'changed' ? 'Рабочая папка изменилась после снимка; повторите обзор перед выводами о текущем состоянии.'
            : 'Связь обзора с текущей папкой не подтверждена. Не выдавайте его за текущую структуру; выберите обзор подтверждённого источника.' };
    })) });
  bb.agents.registerTool({ name: PREVIOUS_TOOL, description: 'Найти конструкторы выбранной компании и папки без открытия. Учитывай пожелания к последнему подходящему View.',
    parameters: z.object({ companyId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) }).strict(),
    execute: async ({ companyId }, ctx) => JSON.stringify(await respond(async () => {
      const active = requestSignal(ctx.signal);
      const live = await native.resolve(ctx.threadId, active, companyId);
      const found = z.object({views: z.array(z.object({id: idSchema, title: z.string(), updatedAt: z.string(), kind: z.enum(['overview', 'scaffold'])})), complete: z.boolean()}).parse(await remote(live, 'view_get', {discover: true, component: 'scaffold'}, active));
      const views = [];
      const sourceId = await currentRootId(live);
      for (const item of found.views) {
        const snapshot = viewSnapshotSchema.parse(await remote(live, 'view_get', {id: item.id}, active));
        const block = snapshot.view.document.blocks[0];
        const capturedAt = block?.type === 'scaffold' && block.config.schemaVersion === 2 ? block.config.overview?.capturedAt ?? null : null;
        const relation = block?.type === 'scaffold' && block.config.overview
          ? await sourceRelation(live, item.id, block.config.overview, sourceId) : undefined;
        views.push({sourceRelation: relation, viewId: item.id, title: item.title, revision: snapshot.view.revision, updatedAt: item.updatedAt,
          kind: item.kind, capturedAt, refreshSuggested: (item.kind === 'overview' || await hasExistingContent(live.realRoot)) && (!capturedAt || Date.now() - Date.parse(capturedAt) > 24 * 60 * 60 * 1000)});
      }
      if (JSON.stringify(await native.resolve(ctx.threadId, active)) !== JSON.stringify(live)) throw new ViewTransportError('context_changed');
      return { views, truncated: !found.complete };
    })) });
  function dispose() { lifetime.abort(); for (const poll of polls.values()) poll.abort(); polls.clear(); canceled.clear(); }
  bb.onDispose(dispose);
  bb.events.on('thread.deleted', ({ thread }) => { for (const [key, poll] of polls) if (key.startsWith(thread.id + ':')) poll.abort(); });
  return {
    configure(_context: PluginAgentConfigurationContext): PluginAgentConfiguration {
      return { tools: [OPEN_TOOL, EXISTING_TOOL, OVERVIEW_TOOL, BIND_TOOL, RESULT_TOOL, PREVIOUS_TOOL, PREPARE_TOOL], skills: [] };
    }, dispose,
  };
}
