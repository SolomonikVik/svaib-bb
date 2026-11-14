import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MessageDispatchHookContext, MessageDispatchHookDecision, PluginAgentToolContext, PluginBbSdk, PluginKvStorage } from '@get-bb/plugin-sdk';
import { connectionBindingSchema, connectionMetadataSchema } from './connection';
import { supportsConnection } from './connection-providers';
import { NativeLogin, nativeStartSchema } from './native-login';
import { continuationInputSchema, continuationSchema, mergeContinuation, checkContinuation, continuationPrompt, type ContinuationInput } from './continuation';

const PREFIX = 'native-auth-attempt:';
const serverKeySchema = z.enum(['svaib', 'plugin:svaib:svaib']);
export const authWaitSchema = z.object({
  action: z.enum(['wait', 'status', 'cancel']).default('wait'),
  terminalId: z.string().regex(/^term_[a-z0-9]+$/).optional(),
  serverKey: serverKeySchema.optional().describe('Для action=wait обязателен точный ключ сервера, проверенный в native-профиле. Для status/cancel не нужен.'),
  // Identifies the verified native profile; never a credential or environment dump.
  configRoot: z.string().min(1).max(4096).optional(),
  continuation: continuationInputSchema.optional(),
}).strict().refine(input => input.action !== 'wait' || !!input.serverKey,
  { path: ['serverKey'], message: 'Для ожидания передай проверенный точный serverKey; имя сервера не подставляется по умолчанию.' });
const deliverySchema = z.object({
  step: z.enum(['reconnect', 'verify']), text: z.string(), checkpoint: z.number(), startedAt: z.number(),
  queuedId: z.string().optional(), requestId: z.string().optional(), turnId: z.string().optional(),
}).strict();
const attemptSchema = z.object({
  id: z.string(), threadId: z.string(), binding: connectionBindingSchema, cwd: z.string(),
  terminalId: z.string().nullable(), serverKey: serverKeySchema, configRoot: z.string(),
  managed: z.boolean(), startedAt: z.number(), deadline: z.number(), cursor: z.number(),
  phase: z.enum(['starting', 'waiting', 'reconnect', 'verify', 'delivered', 'cancelled', 'uncertain']),
  success: z.boolean().nullable(), delivery: deliverySchema.optional(),
  continuation: continuationSchema.optional(), cleanupPending: z.boolean().optional(),
}).strict();
type Attempt = z.infer<typeof attemptSchema>;
type Context = Pick<PluginAgentToolContext, 'threadId' | 'projectId' | 'signal'>;
type Dependencies = {
  sdk: PluginBbSdk; kv: PluginKvStorage; pluginId: string;
  python?: (hostId: string) => Promise<string | { executable: string; path?: string }>;
  now?: () => number; intervalMs?: number;
};
const eventsToRead = ['client/turn/requested', 'client/turn/rejected', 'turn/input/accepted', 'turn/completed',
  'system/thread/interrupted', 'thread/context/cleared'] as const;
const active = (a: Attempt) => !['delivered', 'cancelled', 'uncertain'].includes(a.phase);
class ContextChanged extends Error {}

/** Observe native login without cabinet grants, global setup phases or model polling.
 * The receipt records delivery, never authorization. Only native whoami establishes access.
 */
export class AuthContinuation {
  private attempts = new Map<string, Attempt>();
  private native = new Map<string, NativeLogin>();
  private locks = new Map<string, Promise<unknown>>();
  private abort = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private d: Dependencies) {}
  private now() { return this.d.now?.() ?? Date.now(); }
  private async save(a: Attempt) {
    await this.d.kv.set(PREFIX + a.threadId, attemptSchema.parse(a));
    this.attempts.set(a.threadId, a);
  }
  private serial<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(threadId) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.locks.set(threadId, next);
    void next.finally(() => { if (this.locks.get(threadId) === next) this.locks.delete(threadId); }).catch(() => {});
    return next;
  }
  private async login(threadId: string) {
    let native = this.native.get(threadId);
    if (!native) {
      native = new NativeLogin(this.d.sdk, this.d.kv, this.d.pluginId, this.d.python, 'native-auth-runtime:' + threadId);
      await native.load(); this.native.set(threadId, native);
    }
    return native;
  }
  async load() {
    for (const key of await this.d.kv.list(PREFIX)) {
      const parsed = attemptSchema.safeParse(await this.d.kv.get(key));
      if (parsed.success && key === PREFIX + parsed.data.threadId) this.attempts.set(parsed.data.threadId, parsed.data);
    }
    this.schedule();
  }
  private schedule() {
    if (this.abort.signal.aborted || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().finally(() => this.schedule()).catch(() => {});
    }, this.d.intervalMs ?? 2000);
    this.timer.unref();
  }
  async dispose() { this.abort.abort(); clearTimeout(this.timer); await Promise.allSettled([...this.locks.values()]); }
  private async context(ctx: Pick<Context, 'threadId' | 'projectId'>) {
    const thread = await this.d.sdk.threads.get({ threadId: ctx.threadId });
    if (!thread || thread.id !== ctx.threadId || thread.projectId !== ctx.projectId || !thread.environmentId || thread.deletedAt || thread.archivedAt ||
        !supportsConnection(thread.providerId) || ['stopping', 'error'].includes(thread.status))
      throw new ContextChanged('Разговор авторизации недоступен; сохранённые входы не изменены.');
    const env = await this.d.sdk.environments.get({ environmentId: thread.environmentId });
    if (env.id !== thread.environmentId || env.projectId !== thread.projectId || !env.path) throw new ContextChanged('Рабочее место авторизации изменилось.');
    if (env.status !== 'ready') throw new Error('Рабочее место временно недоступно.');
    const binding = connectionBindingSchema.parse({ projectId: thread.projectId, environmentId: env.id, hostId: env.hostId, providerId: thread.providerId });
    return { thread, binding, cwd: env.path };
  }
  private async latest(threadId: string) {
    const rows = await this.d.sdk.threads.events.list({ threadId, order: 'desc', limit: '1', types: [...eventsToRead] });
    return rows[0]?.seq ?? 0;
  }
  private result(a?: Attempt) {
    return { pending: !!a && (active(a) || !!a.cleanupPending), cleanupPending: !!a?.cleanupPending, automatic: true,
      terminalId: a?.terminalId ?? null, serverKey: a?.serverKey ?? null,
      state: a?.phase ?? 'idle', message: !a ? 'Активного ожидания нет.' : a.phase === 'uncertain'
        ? 'Состояние продолжения не подтверждено. Проверь сохранённый MCP здесь без повторного OAuth.'
        : a.phase === 'cancelled' ? 'Автоматическое продолжение отменено; сохранённые входы не изменены.'
        : a.phase === 'delivered' ? 'Продолжение доставлено. Проверь настоящий native MCP whoami здесь.'
        : 'Вход наблюдается в фоне. Пользователю осталось подтвердить браузер; писать «готово» и повторять ожидание не нужно. После входа этот разговор продолжится сам.' };
  }
  private async capture(a: Attempt, input?: ContinuationInput) {
    if (!input) return;
    const raw = await this.d.sdk.threads.getPluginMetadata({ threadId: a.threadId });
    const metadata = connectionMetadataSchema.safeParse(raw);
    const prior = a.continuation ?? (metadata.success ? metadata.data.continuation : undefined);
    a.continuation = prior ? mergeContinuation(checkContinuation(prior, a.binding.projectId, a.binding.environmentId), input)
      : continuationSchema.parse({ version: 1, captured: true, sourceThreadId: a.threadId,
        sourceProjectId: a.binding.projectId, sourceEnvironmentId: a.binding.environmentId, data: input });
    if (metadata.success && metadata.data.continuation) await this.d.sdk.threads.updatePluginMetadata({ threadId: a.threadId, set: { continuation: a.continuation } });
  }
  async wait(input: z.infer<typeof authWaitSchema>, ctx: Context) {
    return this.serial(ctx.threadId, async () => {
      ctx.signal.throwIfAborted();
      if (input.action === 'cancel') { await this.cancelInside(ctx.threadId); return this.result(this.attempts.get(ctx.threadId)); }
      if (input.action === 'status') { await this.context(ctx); return this.result(this.attempts.get(ctx.threadId)); }
      if (this.attempts.get(ctx.threadId)?.cleanupPending) throw new Error('Предыдущее продолжение ещё очищается автоматически. Не запускай второй OAuth; проверь status после очистки.');
      if (!input.terminalId) throw new Error('Для ожидания укажи терминал непосредственно запущенного native OAuth.');
      if (!input.serverKey) throw new Error('Для ожидания передай проверенный точный serverKey; имя сервера не угадывай.');
      const { binding, cwd } = await this.context(ctx);
      const terminal = await this.d.sdk.terminals.get({ terminalId: input.terminalId });
      if (terminal.threadId !== ctx.threadId || terminal.environmentId !== binding.environmentId ||
          terminal.hostId !== binding.hostId || terminal.initialCwd !== cwd)
        throw new Error('Терминал авторизации относится к другому разговору или рабочему месту.');
      const previous = this.attempts.get(ctx.threadId);
      if (previous?.phase === 'delivered' && previous.terminalId === terminal.id) {
        await this.capture(previous, input.continuation); await this.save(previous); return this.result(previous);
      }
      if (previous && active(previous)) {
        if (previous.terminalId !== terminal.id || JSON.stringify(previous.binding) !== JSON.stringify(binding) ||
            (input.serverKey && previous.serverKey !== input.serverKey) || (input.configRoot && previous.configRoot !== input.configRoot))
          throw new Error('Этот разговор уже ожидает другой вход. Второй процесс не запускай.');
        await this.capture(previous, input.continuation); await this.save(previous); return this.result(previous);
      }
      const a: Attempt = { id: randomUUID(), threadId: ctx.threadId, binding, cwd, terminalId: terminal.id,
        serverKey: input.serverKey, configRoot: input.configRoot ?? 'terminal:' + terminal.id,
        managed: false, startedAt: this.now(), deadline: this.now() + 65 * 60_000, cursor: await this.latest(ctx.threadId),
        phase: 'waiting', success: null };
      await this.capture(a, input.continuation);
      ctx.signal.throwIfAborted(); await this.save(a); this.schedule();
      return this.result(a);
    });
  }
  /** Codex already has a managed native receiver. Its attempt is now independent of cabinet/setup. */
  async start(input: z.infer<typeof nativeStartSchema>, ctx: Context) {
    return this.serial('native-profile-start', () => this.serial(ctx.threadId, async () => {
      if (this.attempts.get(ctx.threadId)?.cleanupPending) throw new Error('Предыдущее продолжение ещё очищается автоматически; новый вход не запущен.');
      const { binding, cwd } = await this.context(ctx);
      if (binding.providerId !== 'codex') throw new Error('Для этого провайдера используй штатный CLI его профиля и svaib_connect_wait.');
      const previous = this.attempts.get(ctx.threadId);
      if (previous && active(previous)) {
        if (JSON.stringify(previous.binding) !== JSON.stringify(binding) || previous.configRoot !== input.configRoot || previous.serverKey !== input.serverKey)
          throw new Error('Уже выполняется другой вход; рабочая попытка сохранена.');
        return this.result(previous);
      }
      for (const other of this.attempts.values()) if ((active(other) || other.phase === 'uncertain' || other.cleanupPending) && other.threadId !== ctx.threadId &&
          other.binding.hostId === binding.hostId && other.binding.providerId === binding.providerId &&
          other.configRoot === input.configRoot && other.serverKey === input.serverKey)
        throw new Error('В этом native-профиле уже ожидается вход из другого разговора. Он не изменён.');
      const a: Attempt = { id: randomUUID(), threadId: ctx.threadId, binding, cwd, terminalId: null,
        configRoot: input.configRoot, serverKey: input.serverKey, managed: true, startedAt: this.now(),
        deadline: this.now() + 65 * 60_000, cursor: await this.latest(ctx.threadId), phase: 'starting', success: null };
      const valid = async () => {
        ctx.signal.throwIfAborted(); this.abort.signal.throwIfAborted();
        const current = await this.context(ctx);
        if (this.attempts.get(ctx.threadId) !== a || JSON.stringify(current.binding) !== JSON.stringify(binding) || current.cwd !== cwd)
          throw new Error('Рабочее место авторизации изменилось.');
      };
      await this.save(a);
      try {
        const native = await this.login(ctx.threadId);
        const result = await native.start(input, { runId: a.id, threadId: a.threadId, binding }, valid);
        await valid(); a.terminalId = result.terminalId; a.phase = 'waiting'; await this.save(a); this.schedule();
        return { ...this.result(a), terminalId: result.terminalId };
      } catch (error) { a.phase = 'uncertain'; await this.save(a); throw error; }
    }));
  }
  private owner(a: Attempt) { return { runId: a.id, threadId: a.threadId, binding: a.binding }; }
  private command(a: Attempt, step: 'reconnect' | 'verify') {
    if (step === 'reconnect') return `/mcp reconnect ${a.serverKey}`;
    return `Продолжение MCP svaib [${a.id}]. ` + (a.success
      ? 'Штатный процесс входа завершился успешно. Проверь настоящий native MCP whoami текущего разговора и продолжи исходное поручение. '
      : 'Процесс входа завершился без подтверждения либо истекло время ожидания. Проверь сохранённый доступ и объясни фактический результат. ') +
      'Не проси пользователя писать «готово», нажимать кнопку завершения или выполнять /mcp. Не повторяй OAuth. ' +
      'Если инструмент отсутствует, используй подтверждённое штатное обновление MCP выбранного харнеса; отсутствие такого способа назови ограничением. ' +
      'Не объявляй подключение готовым без whoami. Компания, профиль, папка и онбординг этим поручением не меняются. При смене задачи следуй новому поручению.' +
      (a.continuation ? continuationPrompt(a.continuation) : ' Исходное поручение возьми из текущего разговора; не расширяй его.');
  }
  private async cancelInside(threadId: string) {
    const a = this.attempts.get(threadId); if (!a) return;
    a.phase = 'cancelled'; a.cleanupPending = true; await this.save(a); // Fence continuation before awaiting cleanup.
    await this.removeQueued(a);
    if (a.managed && !await (await this.login(threadId)).retire(this.owner(a))) return;
    a.cleanupPending = false; await this.save(a);
  }
  private async removeQueued(a: Attempt) {
    if (a.delivery) {
      const threadId = a.threadId;
      const rows = await this.d.sdk.threads.queuedMessages.list({ threadId });
      const own = rows.find(row => row.originPluginId === this.d.pluginId &&
        (!a.delivery!.queuedId || row.id === a.delivery!.queuedId) &&
        row.content.length === 1 && row.content[0].type === 'text' && row.content[0].text === a.delivery!.text);
      if (own) await this.d.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: own.id });
    }
  }
  async cancel(threadId: string) { return this.serial(threadId, () => this.cancelInside(threadId)); }
  async confirmed(threadId: string) {
    return this.serial(threadId, async () => {
      const a = this.attempts.get(threadId);
      if (a && active(a)) { a.phase = 'delivered'; a.cleanupPending = true; await this.save(a); await this.removeQueued(a); a.cleanupPending = false; await this.save(a); }
    });
  }
  async tick() {
    if (this.abort.signal.aborted) return;
    await Promise.all([...this.attempts.values()].filter(a => active(a) || a.cleanupPending).map(a => this.serial(a.threadId, async () => {
      if (a.cleanupPending) {
        if (a.phase === 'cancelled') await this.cancelInside(a.threadId);
        else { await this.removeQueued(a); a.cleanupPending = false; await this.save(a); }
      } else await this.poll(a);
    }).catch(() => {})));
  }
  /** Composed into the root's one message.dispatch hook. Do not take the poll lock:
   * threads.send calls this hook while the poll owns that lock. */
  async admit(ctx: MessageDispatchHookContext): Promise<MessageDispatchHookDecision> {
    const a = this.attempts.get(ctx.thread.id), delivery = a?.delivery;
    const own = ctx.originPluginId === this.d.pluginId || ctx.queuedMessages.some(row => row.originPluginId === this.d.pluginId);
    const authText = ctx.input.blocks.some(block => block.type === 'text' &&
      (/^Продолжение MCP svaib \[[a-f0-9-]+\]\./.test(block.text) || /^\/mcp reconnect (svaib|plugin:svaib:svaib)$/.test(block.text)));
    if (!own || !authText) return { action: 'proceed' };
    if (!a || !delivery || !ctx.input.blocks.some(block => block.type === 'text' && block.text === delivery.text))
      return { action: 'reject', message: 'Это продолжение относится к прежней попытке входа и отменено.' };
    const reject = async () => {
      a.phase = 'cancelled'; a.cleanupPending = true; await this.save(a);
      return { action: 'reject' as const, message: 'Автоматическое продолжение входа отменено; сохранённый доступ не изменён.' };
    };
    if (!active(a) || this.abort.signal.aborted || ctx.thread.deletedAt || ctx.thread.archivedAt || ctx.thread.status === 'stopping' ||
        ctx.thread.projectId !== a.binding.projectId || ctx.thread.environmentId !== a.binding.environmentId ||
        ctx.thread.providerId !== a.binding.providerId || ctx.host?.id !== a.binding.hostId || ctx.environment?.path !== a.cwd ||
        ctx.input.blocks.length !== 1) return reject();
    const stops = await this.d.sdk.threads.events.list({ threadId: a.threadId, afterSeq: String(a.cursor), order: 'asc', limit: '100',
      types: ['system/thread/interrupted', 'thread/context/cleared', 'turn/completed'] });
    if (stops.some(event => event.type !== 'turn/completed' || event.data.status === 'interrupted')) return reject();
    if (stops.length === 100) return { action: 'wait', reason: 'Проверяю актуальность продолжения входа', sendAt: this.now() + 2000 };
    return { action: 'proceed' };
  }
  private async poll(a: Attempt) {
    if (this.abort.signal.aborted || !active(a)) return;
    let current: Awaited<ReturnType<AuthContinuation['context']>>;
    try { current = await this.context({ threadId: a.threadId, projectId: a.binding.projectId }); }
    catch (error) {
      if (error instanceof ContextChanged) await this.cancelInside(a.threadId);
      else if (this.now() >= a.deadline) { a.phase = 'uncertain'; await this.save(a); }
      return;
    }
    if (JSON.stringify(current.binding) !== JSON.stringify(a.binding) || current.cwd !== a.cwd) { await this.cancelInside(a.threadId); return; }
    const events = await this.d.sdk.threads.events.list({ threadId: a.threadId, afterSeq: String(a.cursor),
      order: 'asc', limit: '100', types: [...eventsToRead] });
    for (const event of events) {
      a.cursor = event.seq;
      if (event.type === 'system/thread/interrupted' || event.type === 'thread/context/cleared' ||
          (event.type === 'turn/completed' && event.data.status === 'interrupted')) { await this.cancelInside(a.threadId); return; }
      const delivery = a.delivery;
      if (!delivery) continue;
      if (event.type === 'client/turn/rejected' && event.data.requestId === delivery.requestId) {
        a.phase = 'uncertain'; await this.save(a); return;
      }
      if (event.type === 'client/turn/requested' && event.seq > delivery.checkpoint &&
          // SDK 104 predates event.originPluginId. The exact saved payload and
          // checkpoint still correlate its request; access always needs whoami.
          (!('originPluginId' in event.data) || event.data.originPluginId === this.d.pluginId) && event.data.input?.length === 1 &&
          event.data.input[0].type === 'text' && event.data.input[0].text === delivery.text) delivery.requestId = event.data.requestId;
      if (event.type === 'turn/input/accepted' && event.data.clientRequestId === delivery.requestId && event.scope.kind === 'turn') delivery.turnId = event.scope.turnId;
      if (event.type === 'turn/completed' && event.scope.kind === 'turn' && event.scope.turnId === delivery.turnId) {
        if (event.data.status !== 'completed') { await this.cancelInside(a.threadId); return; }
        a.phase = delivery.step === 'reconnect' ? 'verify' : 'delivered'; delete a.delivery;
      }
    }
    await this.save(a);
    if (events.length === 100 || this.abort.signal.aborted || !active(a)) return;
    if (a.phase === 'starting') {
      const status = await (await this.login(a.threadId)).status(this.owner(a));
      if (!status || status.unavailable) { a.phase = 'uncertain'; await this.save(a); return; }
      a.terminalId = status.terminalId; a.phase = 'waiting';
    }
    if (a.phase === 'waiting') {
      let terminal: Awaited<ReturnType<PluginBbSdk['terminals']['get']>>;
      try { terminal = await this.d.sdk.terminals.get({ terminalId: a.terminalId! }); }
      catch (error) {
        if ((error instanceof Error && /^HTTP 404:/.test(error.message)) || this.now() >= a.deadline) { a.phase = 'uncertain'; await this.save(a); }
        return;
      }
      if (terminal.threadId !== a.threadId || terminal.environmentId !== a.binding.environmentId || terminal.hostId !== a.binding.hostId || terminal.initialCwd !== a.cwd) {
        await this.cancelInside(a.threadId); return;
      }
      if (['starting', 'running'].includes(terminal.status) && this.now() < a.deadline) return;
      if (terminal.status === 'disconnected' || (!['starting', 'running'].includes(terminal.status) && terminal.closeReason !== 'process-exit')) {
        a.phase = 'uncertain'; await this.save(a); return;
      }
      a.success = terminal.status === 'exited' && terminal.exitCode === 0;
      // Only this installed ACP adapter has a confirmed exact-command reconnect.
      a.phase = a.success && a.binding.providerId === 'acp-claude-kimi' ? 'reconnect' : 'verify';
      await this.save(a);
    }
    if (!['reconnect', 'verify'].includes(a.phase)) return;
    const queue = await this.d.sdk.threads.queuedMessages.list({ threadId: a.threadId });
    if (a.delivery) {
      const expected = a.delivery.text;
      const queued = queue.find(row => row.originPluginId === this.d.pluginId && row.content.length === 1 && row.content[0].type === 'text' && row.content[0].text === expected);
      if (queued) {
        a.delivery.queuedId = queued.id; await this.save(a);
        // Core creates each row with groupWithNext:false and drains one group.
        // The admission guard also refuses a manually grouped multi-block command.
        return;
      }
      // Reconcile a crash between send and persistence from accepted request/turn events.
      // If neither queue nor receipt exists, do not blindly send a possible duplicate.
      if ((!a.delivery.requestId && this.now() - a.delivery.startedAt > 30_000) || this.now() >= a.deadline) { a.phase = 'uncertain'; await this.save(a); }
      return;
    }
    if (current.thread.status !== 'idle' || queue.length) return;
    const step = a.phase as 'reconnect' | 'verify';
    a.delivery = { step, text: this.command(a, step), checkpoint: a.cursor, startedAt: this.now() }; await this.save(a);
    if (this.abort.signal.aborted) return;
    // One block is required by the ACP /mcp parser; no adjacent visible helper text.
    const sent = await this.d.sdk.threads.send({ threadId: a.threadId, mode: 'start', originPluginId: this.d.pluginId,
      input: [{ type: 'text', text: a.delivery.text, mentions: [], visibility: 'agent-only' }] });
    if (sent.delivery === 'queued') a.delivery.queuedId = sent.queuedMessage.id;
    await this.save(a);
  }
}
