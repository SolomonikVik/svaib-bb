import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createHash } from 'node:crypto';
import { browserContract } from './account/browser-contract';
import { supportsConnection, type ConnectionProvider } from './account/connection-providers';
import { runtimeSignals, type RuntimeContext, type RuntimeView } from './runtime-contract';
import { runtimeSettingsContract } from './runtime-settings-contract';

/** Safe probes and explicit repair only; ordinary requests are never gated (simplification plan, stage 5). */
export function registerRuntimeGate(bb: BbPluginApi, maintenance = async () => ({ update: true, trust: true }), prepareProvider = async (_provider: string) => {}) {
  const client = bb.hosts.experimental_client({ contract: browserContract, experimental_signals: runtimeSignals });
  const probes = new Map<string, Promise<RuntimeView>>(), jobs = new Map<string, Promise<RuntimeView>>();
  const computerJobs = new Map<string, { scope: string; abort: AbortController; result: Promise<RuntimeView> }>();
  const abort = new AbortController(); bb.onDispose(() => abort.abort());
  async function localHost(hostId: string) {
    if ((await bb.sdk.system.config()).primaryHostId !== hostId) throw new Error('Подготовка доступна только на текущем компьютере исполнения.');
    return hostId;
  }
  const legacyContext = (context: RuntimeContext): RuntimeContext => ({ provider: context.provider, action: context.action,
    ...(context.hooks === undefined ? {} : { hooks: context.hooks }) });
  bb.onDispose(client.experimental_onSignal('runtimeProgress', ({ hostId, payload }) => {
    bb.realtime.publish('runtime-preparation-changed', { hostId, progress: payload });
  }));
  async function resolveContext(hostId: string, input: RuntimeContext): Promise<RuntimeContext> {
    if (input.executable) return input;
    if (input.provider === 'acp-claude-kimi') {
      try {
        const settings = await bb.sdk.plugins.getSettings({ pluginId: 'provider-acp' });
        const agents: unknown = JSON.parse(String(settings.values.customAgents ?? '[]'));
        const agent = Array.isArray(agents) ? agents.find(a => a?.id === 'claude-kimi') : null;
        if (typeof agent?.command === 'string' && Array.isArray(agent.args) && agent.args.every((a: unknown) => typeof a === 'string'))
          return { ...input, executable: agent.command, args: agent.args };
      } catch { /* The host still inspects its actual launcher; status cannot repair settings. */ }
    }
    if (input.provider !== 'acp-claude-kimi') {
      try {
        const status = await bb.sdk.hosts.providerCliStatus({ hostId });
        const name = input.provider === 'claude-code' ? 'claude' : input.provider;
        const cli = status[name] ?? status[input.provider];
        if (cli?.installed && cli.executablePath) return { ...input, executable: cli.executablePath };
      } catch { /* Older/offline discovery: bounded host probe resolves the native CLI. */ }
    }
    return input;
  }
  const inspect = async (hostId: string, input: RuntimeContext): Promise<RuntimeView> => {
    const context = await resolveContext(hostId, input), key = JSON.stringify([hostId, context]);
    const pending = probes.get(key); if (pending) return pending;
    const job = client.call('runtimeInspect', context, { hostId, signal: abort.signal, timeoutMs: 45_000 })
      .finally(() => probes.delete(key));
    probes.set(key, job); return job;
  };
  const prepare = (hostId: string, context: RuntimeContext, portableNode = false) => {
    const key = JSON.stringify([hostId, context, portableNode]), pending = jobs.get(key); if (pending) return pending;
    const job = (async (): Promise<RuntimeView> => {
      const resolved = await resolveContext(hostId, context);
      return client.call('runtimePrepare', { context: resolved, retry: true, portableNode },
        { hostId, signal: abort.signal, timeoutMs: 35 * 60_000 });
    })().finally(() => { jobs.delete(key); bb.realtime.publish('runtime-preparation-changed', { hostId }); });
    jobs.set(key, job); return job;
  };
  async function computer(threadId: string | null) {
    const system = await bb.sdk.system.config();
    if (!system.primaryHostId) throw new Error('Компьютер исполнения BB недоступен.');
    if (!threadId) return { hostId: system.primaryHostId, context: null, cwd: null };
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.deletedAt || !thread.environmentId) throw new Error('Рабочая папка разговора недоступна.');
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (environment.status !== 'ready' || environment.hostId !== system.primaryHostId)
      throw new Error('Подготовка доступна на текущем компьютере исполнения. Открой настройки на нём.');
    if (!supportsConnection(thread.providerId)) throw new Error('Этот провайдер не поддерживает подготовку svaib.');
    return { hostId: environment.hostId, context: await resolveContext(environment.hostId,
      { provider: thread.providerId, action: 'setup' as const, hooks: true }), cwd: environment.path };
  }
  const preparationKey = (scope: Awaited<ReturnType<typeof computer>>) =>
    'computer-prepared:v1:' + createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  async function computerRun(threadId: string | null, repair: boolean): Promise<RuntimeView> {
    let initial = await computer(threadId);
    if (repair && initial.context) {
      if (threadId && (await bb.sdk.threads.get({ threadId })).status === 'active') throw new Error('Дождись завершения ответа агента и повтори подготовку.');
      await prepareProvider(initial.context.provider);
      initial = await computer(threadId);
    }
    // The receipt is a display preference for a previously verified launch. It never authorizes a launch or supplies a fresh hook verdict.
    const receiptKey = preparationKey(initial);
    const signature = (view: RuntimeView) => createHash('sha256').update(JSON.stringify(
      [view.platform, view.python, view.bash, view.node, view.npmCli, view.versions, view.requirements])).digest('hex');
    let result: RuntimeView;
    if (repair) {
      const scope = JSON.stringify(initial), pending = computerJobs.get(initial.hostId);
      if (pending) {
        if (pending.scope !== scope) throw new Error('На этом компьютере уже идёт подготовка другого профиля.');
        return pending.result;
      }
      const cancel = new AbortController();
      const operation = (async () => {
        await bb.storage.kv.delete(receiptKey).catch(() => {});
        const result = await client.call('computerPrepare', { context: initial.context, cwd: initial.cwd, ...await maintenance() },
          { hostId: initial.hostId, signal: AbortSignal.any([abort.signal, cancel.signal]), timeoutMs: 35 * 60_000 });
        if (JSON.stringify(await computer(threadId)) !== JSON.stringify(initial)) throw new Error('Рабочее место изменилось. Повтори подготовку.');
        if (initial.context?.executable && initial.cwd && result.status === 'ready' && !result.installerUncertain && !result.operationError)
          await bb.storage.kv.set(receiptKey, signature(result)).catch(() => {});
        return result;
      })();
      computerJobs.set(initial.hostId, { scope, abort: cancel, result: operation });
      try { result = await operation; } finally { computerJobs.delete(initial.hostId); }
    } else result = await client.call('runtimeInspect', initial.context, { hostId: initial.hostId, signal: abort.signal, timeoutMs: 45_000 });
    if (JSON.stringify(await computer(threadId)) !== JSON.stringify(initial)) throw new Error('Рабочее место изменилось. Повтори подготовку.');
    if (repair) return result;
    const saved = await bb.storage.kv.get<string>(receiptKey).catch(() => undefined);
    const previouslyPrepared = Boolean(saved && result.status === 'ready' && !result.operationError &&
      !result.installerUncertain && signature(result) === saved);
    if (saved && !previouslyPrepared) await bb.storage.kv.delete(receiptKey).catch(() => {});
    if (result.status !== 'ready') return result;
    return { ...result, status: 'idle', previouslyPrepared, message: previouslyPrepared
      ? 'Подготовка пройдена ранее. Компоненты компьютера доступны.'
      : 'Компоненты доступны. Кнопка подготовки проверит исполнение хуков установленного Harness.' };
  }
  const maintaining = new Set<string>();
  bb.events.on('thread.idle', async ({ thread }) => {
    if (abort.signal.aborted || !supportsConnection(thread.providerId)) return;
    const preferences = await maintenance();
    if (!preferences.update) return;
    try {
      const initial = await computer(thread.id);
      if (!initial.context?.executable || !initial.cwd) return;
      const key = 'harness-maintenance:v1:' + createHash('sha256').update(JSON.stringify(initial)).digest('hex');
      if (maintaining.has(key) || Number(await bb.storage.kv.get(key) ?? 0) > Date.now()) return;
      maintaining.add(key);
      try {
        // Throttle failures too. A package check never generates a chat message.
        await bb.storage.kv.set(key, Date.now() + 24 * 60 * 60_000);
        const result = await client.call('harnessMaintain', { target: { provider: initial.context.provider, executable: initial.context.executable, ...(initial.context.args ? { args: initial.context.args } : {}), cwd: initial.cwd },
          options: { ...preferences, install: false } }, { hostId: initial.hostId, signal: abort.signal, timeoutMs: 5 * 60_000 });
        if (['updated', 'installed', 'skipped'].includes(result.state))
          await bb.storage.kv.delete(preparationKey(initial));
      } finally { maintaining.delete(key); }
    } catch { if (!abort.signal.aborted) bb.log.warn('Автообновление Harness не подтверждено. Действующая установка и источник сохранены.'); }
  });
  bb.rpc.register(runtimeSettingsContract, {
    computerStatus: ({ threadId }) => computerRun(threadId, false),
    computerPrepare: ({ threadId }) => computerRun(threadId, true),
    computerCancel: async () => {
      const { hostId } = await computer(null); computerJobs.get(hostId)?.abort.abort();
      const result = await client.call('runtimeCancel', null, { hostId, timeoutMs: 15_000 });
      return { ...result, status: 'failed' as const, message: 'Подготовка отменена. Сохранённый вход не сброшен; перед повтором проверим фактическое состояние.' };
    },
    runtimeHosts: async () => {
      const [config, hosts] = await Promise.all([bb.sdk.system.config(), bb.sdk.hosts.list()]);
      return { primaryHostId: config.primaryHostId, hosts: hosts.filter(h => h.id === config.primaryHostId).map(h => ({ id: h.id, name: h.name })) };
    },
    runtimeStatus: async ({ hostId, context }) => inspect(await localHost(hostId), legacyContext(context)),
    runtimeRepair: async ({ hostId, context, portableNode }) => prepare(await localHost(hostId), legacyContext(context), portableNode),
    runtimeCancelPreparation: async ({ hostId }) => client.call('runtimeCancel', null, { hostId: await localHost(hostId), timeoutMs: 15_000 }),
  });
  return {
    commands: [{ name: 'runtime', summary: 'Проверить или явно подготовить компьютер для выбранного провайдера',
      usage: 'bb svaib-workplace runtime status|prepare|cancel [--provider codex|claude-code|acp-claude-kimi|pi] [--action dispatch|setup|install|cli] [--portable-node] [--host <id>]' }],
    async run(argv: string[], signal?: AbortSignal) {
      try {
        const args = [...argv], action = args.shift(); let hostId: string | null = null, portableNode = false;
        let provider: ConnectionProvider = 'codex', runtimeAction: RuntimeContext['action'] = 'dispatch';
        while (args.length) {
          const flag = args.shift();
          if (flag === '--host') { hostId = args.shift() ?? null; if (!hostId) throw new Error('Укажи компьютер после --host.'); }
          else if (flag === '--retry') { /* Legacy flag: prepare is always an explicit fresh repair. */ }
          else if (flag === '--portable-node') portableNode = true;
          else if (flag === '--provider') { const next = args.shift(); if (!next || !supportsConnection(next)) throw new Error('Неизвестный провайдер.'); provider = next; }
          else if (flag === '--action') { const next = args.shift(); if (!['dispatch', 'setup', 'install', 'cli'].includes(next ?? '')) throw new Error('Неизвестный сценарий.'); runtimeAction = next as RuntimeContext['action']; }
          else throw new Error('Неизвестный параметр подготовки.');
        }
        hostId ??= (await bb.sdk.system.config()).primaryHostId;
        if (!hostId || !['status', 'prepare', 'cancel'].includes(action ?? '')) throw new Error('Используй runtime status|prepare|cancel [--provider <id>] [--host <id>].');
        const context: RuntimeContext = { provider, action: runtimeAction, hooks: true };
        await localHost(hostId);
        const cancel = () => { void client.call('runtimeCancel', null, { hostId: hostId!, timeoutMs: 15_000 }).catch(() => {}); };
        signal?.throwIfAborted(); if (action === 'prepare') signal?.addEventListener('abort', cancel, { once: true });
        try {
          const view = action === 'status' ? await inspect(hostId, context) : action === 'cancel'
            ? await client.call('runtimeCancel', null, { hostId, timeoutMs: 15_000 }) : await prepare(hostId, context, portableNode);
          return { exitCode: view.status === 'failed' ? 1 : 0, stdout: JSON.stringify(view, null, 2) };
        } finally { signal?.removeEventListener('abort', cancel); }
      } catch (error) { return { exitCode: 1, stderr: error instanceof Error ? error.message : 'Подготовка недоступна.' }; }
    },
  };
}
