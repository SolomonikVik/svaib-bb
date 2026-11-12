import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { browserContract } from './experiments/account-prototype/browser-contract';
import { connectionProviders, supportsConnection } from './experiments/account-prototype/connection-providers';
import { runtimeSignals, type RuntimeView } from './runtime-contract';

/** Dispatch is the supported checkpoint after initialization and before a model runs.
 * No host RPC is called while the plugin factory is registering its surfaces. */
export function registerRuntimeGate(bb: BbPluginApi) {
  const client = bb.hosts.experimental_client({ contract: browserContract, experimental_signals: runtimeSignals });
  const state = new Map<string, RuntimeView>(), jobs = new Map<string, Promise<RuntimeView>>();
  const verified = new Set<string>();
  const abort = new AbortController(); bb.onDispose(() => abort.abort());
  bb.onDispose(client.experimental_onSignal('runtimeProgress', ({ hostId, payload }) => {
    const old = state.get(hostId); state.set(hostId, { ...old, ...payload });
    bb.experimental_hooks.recheck('message.dispatch');
  }));
  const inspect = async (hostId: string) => {
    let view = state.get(hostId);
    if (!view) { view = await client.call('runtimeInspect', null, { hostId, signal: abort.signal, timeoutMs: 4000 }); state.set(hostId, view); }
    return view;
  };
  const prepare = (hostId: string, input: { retry?: boolean; portableNode?: boolean } = {}) => {
    const pending = jobs.get(hostId); if (pending) return pending;
    state.set(hostId, { platform: 'win32', status: 'preparing', step: 'probe', message: 'Подготавливаю Python, Git Bash, Node.js, npm и BB до запуска модели.' });
    const job = client.call('runtimePrepare', input, { hostId, signal: abort.signal, timeoutMs: 35 * 60_000 })
      .catch((): RuntimeView => ({ platform: 'win32', status: 'failed', step: 'host', message: 'Подготовка компьютера прервана. Проверь его подключение. Повтор: bb svaib-workplace runtime prepare --retry.' }))
      .then(view => { state.set(hostId, view); if (view.status === 'ready') verified.add(hostId); return view; })
      .finally(() => { jobs.delete(hostId); if (state.get(hostId)?.status !== 'preparing') bb.experimental_hooks.recheck('message.dispatch'); });
    jobs.set(hostId, job); return job;
  };
  bb.experimental_hooks.on('message.dispatch', async context => {
    if (!supportsConnection(context.thread.providerId) || !context.host || context.attempt === 'join-turn') return { action: 'proceed' };
    let view: RuntimeView;
    try { view = await inspect(context.host.id); }
    catch { return { action: 'reject', message: 'Не удалось проверить компьютер перед запуском svaib. Подключи компьютер исполнения и повтори отправку.' }; }
    if (view.platform !== 'win32' || (view.status === 'ready' && verified.has(context.host.id))) return { action: 'proceed' };
    if (view.status === 'failed') return { action: 'reject', message: view.message };
    if (!jobs.has(context.host.id)) void prepare(context.host.id);
    return { action: 'wait', reason: view.status === 'idle' ? 'Подготавливаю компьютер до запуска svaib.' : view.message,
      ...(view.status === 'preparing' ? { sendAt: Date.now() + 5000 } : {}) };
  });
  for (const provider of connectionProviders) bb.providers.experimental_contributeEnv(provider, async ({ hostId }) => {
    const view = await inspect(hostId);
    if (view.platform !== 'win32' || view.status !== 'ready' || !view.python) return [];
    return [{ name: 'SVAIB_PYTHON', value: view.python, reason: 'Проверенный Python для хуков svaib' },
      ...(view.bash ? [{ name: 'CLAUDE_CODE_GIT_BASH_PATH', value: view.bash, reason: 'Проверенный Git Bash для Claude Code' }] : []),
      ...(view.path ? [{ name: 'PATH', value: view.path, reason: 'Проверенные компоненты компьютера исполнения' }] : [])];
  });
  return {
    commands: [{ name: 'runtime', summary: 'Проверить, повторить или отменить подготовку компьютера', usage: 'bb svaib-workplace runtime status|prepare|cancel [--retry] [--portable-node] [--host <id>]' }],
    async run(argv: string[], signal?: AbortSignal) {
      try {
        const args = [...argv], action = args.shift(); let hostId: string | null = null, retry = false, portableNode = false;
        while (args.length) { const flag = args.shift(); if (flag === '--host') { hostId = args.shift() ?? null; if (!hostId) throw new Error('Укажи компьютер после --host.'); }
          else if (flag === '--retry') retry = true; else if (flag === '--portable-node') portableNode = true; else throw new Error('Неизвестный параметр подготовки.'); }
        hostId ??= (await bb.sdk.system.config()).primaryHostId;
        if (!hostId || !['status', 'prepare', 'cancel'].includes(action ?? '')) throw new Error('bb svaib-workplace runtime status|prepare|cancel [--retry] [--portable-node] [--host <id>]');
        const cancel = () => { void client.call('runtimeCancel', null, { hostId: hostId!, timeoutMs: 15_000 }).catch(() => {}); };
        signal?.throwIfAborted(); if (action === 'prepare') signal?.addEventListener('abort', cancel, { once: true });
        try {
          const view = action === 'status' ? await client.call('runtimeInspect', null, { hostId }) : action === 'cancel'
            ? await client.call('runtimeCancel', null, { hostId, timeoutMs: 15_000 }) : await prepare(hostId, { retry, portableNode });
          return { exitCode: view.status === 'failed' ? 1 : 0, stdout: JSON.stringify(view, null, 2) };
        } finally { signal?.removeEventListener('abort', cancel); }
      } catch (error) { return { exitCode: 1, stderr: error instanceof Error ? error.message : 'Подготовка недоступна.' }; }
    } };
}
