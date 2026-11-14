import type { BbPluginApi, MessageDispatchHookContext, MessageDispatchHookDecision } from '@get-bb/plugin-sdk';
import { browserContract } from './experiments/account-prototype/browser-contract';
import { connectionProviders, supportsConnection, type ConnectionProvider } from './experiments/account-prototype/connection-providers';
import { runtimeSignals, type RuntimeContext, type RuntimeView } from './runtime-contract';
import { runtimeSettingsContract } from './runtime-settings-contract';

/** Safe probes run at dispatch; installers are reachable only through explicit repair. */
export function registerRuntimeGate(bb: BbPluginApi) {
  const client = bb.hosts.experimental_client({ contract: browserContract, experimental_signals: runtimeSignals });
  const probes = new Map<string, Promise<RuntimeView>>(), jobs = new Map<string, Promise<RuntimeView>>();
  const abort = new AbortController(); bb.onDispose(() => abort.abort());
  let admission: ((context: MessageDispatchHookContext) => Promise<MessageDispatchHookDecision>) | undefined;
  bb.onDispose(client.experimental_onSignal('runtimeProgress', ({ hostId, payload }) => {
    bb.realtime.publish('runtime-preparation-changed', { hostId, progress: payload });
    // Signals report operation progress, never grant readiness to another provider.
    bb.experimental_hooks.recheck('message.dispatch');
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
    })().finally(() => { jobs.delete(key); bb.realtime.publish('runtime-preparation-changed', { hostId }); bb.experimental_hooks.recheck('message.dispatch'); });
    jobs.set(key, job); return job;
  };
  bb.experimental_hooks.on('message.dispatch', async context => {
    const admit = async (): Promise<MessageDispatchHookDecision> => admission ? admission(context) : { action: 'proceed' };
    const provider = context.thread.providerId;
    if (!supportsConnection(provider) || !context.host || context.attempt === 'join-turn') return admit();
    try {
      const view = await inspect(context.host.id, { provider, action: 'dispatch', hooks: true });
      if (view.status === 'ready') return admit();
      return { action: 'reject', message: `${view.message} Открой настройки плагина svaib → «Подготовка компьютера», выбери этот компьютер и ${provider}, затем нажми «Подготовить / Повторить».` };
    } catch {
      return { action: 'reject', message: 'Не удалось проверить компьютер исполнения. Открой настройки плагина svaib → «Подготовка компьютера» и повтори безопасную проверку. Установка запускается кнопкой «Подготовить / Повторить».' };
    }
  });
  for (const provider of connectionProviders) bb.providers.experimental_contributeEnv(provider, async ({ hostId }) => {
    const view = await inspect(hostId, { provider, action: 'dispatch', hooks: true });
    if (view.status !== 'ready' || !view.python) return [];
    return [{ name: 'SVAIB_PYTHON', value: view.python, reason: 'Проверенный Python для хуков svaib' },
      ...((provider === 'claude-code' || provider === 'acp-claude-kimi') && view.bash
        ? [{ name: 'CLAUDE_CODE_GIT_BASH_PATH', value: view.bash, reason: 'Проверенный Git Bash для Claude Code' }] : []),
      ...(view.path ? [{ name: 'PATH', value: view.path, reason: 'Проверенный запуск хуков svaib' }] : [])];
  });
  bb.rpc.register(runtimeSettingsContract, {
    runtimeHosts: async () => {
      const [config, hosts] = await Promise.all([bb.sdk.system.config(), bb.sdk.hosts.list()]);
      return { primaryHostId: config.primaryHostId, hosts: hosts.map(h => ({ id: h.id, name: h.name })) };
    },
    runtimeStatus: ({ hostId, context }) => inspect(hostId, context),
    runtimeRepair: ({ hostId, context, portableNode }) => prepare(hostId, context, portableNode),
    runtimeCancelPreparation: ({ hostId }) => client.call('runtimeCancel', null, { hostId, timeoutMs: 15_000 }),
  });
  return {
    setAdmissionGuard(guard: NonNullable<typeof admission>) { admission = guard; },
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
