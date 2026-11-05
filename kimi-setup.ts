import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { browserContract } from './experiments/account-prototype/browser-contract';
import { kimiRpcContract, kimiViewSchema, type KimiAgent, type KimiView } from './kimi-contract';

const PROVIDER = 'acp-claude-kimi';
const SETTINGS_PLUGIN = 'provider-acp';

/** Owns only local Kimi UI state. It never reads/writes svaib onboarding marks. */
export async function registerKimiSetup(bb: BbPluginApi, hostId: string | null) {
  const client = bb.hosts.experimental_client({ contract: browserContract });
  const storageKey = 'kimi-setup:v1:' + (hostId ?? 'unavailable');
  const saved = kimiViewSchema.safeParse(await bb.storage.kv.get(storageKey));
  let view: KimiView = saved.success ? saved.data : {
    revision: 0, canReplaceKey: false, hidden: false, stage: 'intro', message: '', hostId: hostId ?? '', testThreadId: null, manualRegistration: null,
  };
  let job: Promise<void> | null = null;
  let starting: Promise<KimiView> | null = null;
  let disposed = false;
  const abort = new AbortController();
  bb.onDispose(() => { disposed = true; abort.abort(); });
  const snapshot = () => ({ ...view });
  async function save(patch: Partial<KimiView>) {
    if (disposed) return snapshot();
    view = { ...view, ...patch, revision: view.revision + 1 };
    await bb.storage.kv.set(storageKey, view);
    bb.realtime.publish('kimi-setup-changed', null);
    return snapshot();
  }
  function target() {
    if (!hostId) throw new Error('Компьютер BB недоступен. Подключи его и повтори настройку.');
    return { hostId, signal: abort.signal, timeoutMs: 240_000 };
  }
  async function agents() {
    const current = await bb.sdk.plugins.getSettings({ pluginId: SETTINGS_PLUGIN });
    if (!current.schema.customAgents || current.schema.customAgents.type !== 'string') throw new Error('ACP settings unavailable');
    const raw = current.values.customAgents ?? '[]';
    if (typeof raw !== 'string') throw new Error('Invalid ACP settings');
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list) || list.length > 200 || list.some(x => !x || typeof x !== 'object')) throw new Error('Invalid ACP settings');
    return list as Record<string, unknown>[];
  }
  async function hasProvider() {
    try { return (await agents()).some(agent => agent.id === 'claude-kimi'); }
    catch {
      try { return (await bb.sdk.providers.list({ hostId: hostId ?? '' })).some(provider => provider.id === PROVIDER); }
      catch { return false; }
    }
  }
  async function inspect() {
    if (await hasProvider()) return save({ stage: 'verify', message: 'Kimi уже добавлен. Проверим ответ в обычном разговоре BB.' });
    const status = await client.call('kimiInspect', null, target());
    return save({ stage: !status.nodeReady ? 'node' : status.profile === 'blocked' ? 'blocked'
      : status.profile === 'absent' ? 'key' : 'registration',
    message: status.profile === 'blocked' ? 'Папка настройки изменена. Существующие файлы сохранены; нужна помощь партнёра.' : '',
    });
  }
  async function register(agent: KimiAgent) {
    try {
      // Read immediately before writing. Only this field is patched; other
      // providers and plugin settings are retained, existing Kimi is never replaced.
      const list = await agents();
      if (disposed) return snapshot();
      const existing = list.find(item => item.id === agent.id);
      if (!existing) {
        await bb.sdk.plugins.updateSettings({ pluginId: SETTINGS_PLUGIN, values: { customAgents: JSON.stringify([...list, agent]) } });
      }
      const actual = await agents();
      if (!actual.some(item => item.id === agent.id)) throw new Error('Registration not saved');
      return save({ stage: 'verify', message: '', manualRegistration: null,
        canReplaceKey: !existing || existing.command === agent.command && JSON.stringify(existing.args) === JSON.stringify(agent.args) });
    } catch {
      return save({ stage: 'registration', message: 'Профиль готов. В этой версии BB добавь провайдера через настройки ACP.', manualRegistration: JSON.stringify([agent], null, 2) });
    }
  }
  async function start(apiKey?: string) {
    if (job) return snapshot();
    if (await hasProvider()) return save({ stage: 'verify', hidden: false, message: 'Существующее подключение сохранено. Проверим ответ Kimi.' });
    const status = await client.call('kimiInspect', null, target());
    if (!status.nodeReady || status.profile === 'blocked' || status.profile === 'absent' && !apiKey) return inspect();
    await save({ hidden: false, stage: 'installing', message: '', manualRegistration: null });
    // The key exists only in this call's memory and host RPC, never KV, settings,
    // a terminal, a model request, command argv, or the returned view.
    const run = async () => {
      try {
        const agent = status.agent ?? await client.call('kimiPrepare', { ...(apiKey ? { apiKey } : {}) }, target());
        apiKey = undefined;
        if (!disposed) { await save({ canReplaceKey: true }); await register(agent); }
      } catch {
        apiKey = undefined;
        if (!disposed) await save({ stage: 'registration', message: 'Не удалось завершить настройку. Проверь интернет и нажми «Продолжить настройку». Сохранённый профиль не перезаписывается.' });
      }
    };
    job = run().finally(() => { job = null; });
    void job.catch(() => {});
    return snapshot();
  }
  async function checkedThread(threadId: string, requireHost = true) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.providerId !== PROVIDER || thread.originPluginId !== bb.pluginId || thread.deletedAt) throw new Error('Открой проверочный разговор Kimi из настройщика.');
    if (!thread.environmentId && !requireHost) return thread;
    if (!thread.environmentId) throw new Error('Проверка ещё запускается.');
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (environment.hostId !== hostId) throw new Error('Проверка запущена на другом компьютере.');
    return thread;
  }
  async function checkResponse(quiet = false) {
    const testId = view.testThreadId;
    const current = () => view.testThreadId === testId && view.stage === 'verify' && !view.hidden;
    const pending = (message: string) => quiet || !current() ? Promise.resolve(snapshot()) : save({ message });
    if (!view.testThreadId) return pending('Сначала отправь проверочный запрос Kimi.');
    try {
      const thread = await checkedThread(view.testThreadId);
      if (thread.status !== 'idle') return pending('Ответ ещё не получен. Проверь разговор и повтори проверку.');
      const { output } = await bb.sdk.threads.output({ threadId: thread.id });
      if (!current()) return snapshot();
      if (output?.trim() !== 'KIMI_READY') return pending('Проверочный ответ не подтверждён. Открой разговор и проверь результат.');
      return save({ stage: 'complete', hidden: true, message: '', manualRegistration: null });
    } catch { return pending('Не удалось проверить ответ. Открой разговор Kimi и повтори.'); }
  }
  bb.events.on('thread.idle', async ({ thread }) => {
    if (!disposed && !view.hidden && view.stage === 'verify' && thread.id === view.testThreadId) await checkResponse();
  });
  bb.rpc.register(kimiRpcContract, {
    kimiStatus: async () => {
      if (!view.hidden && view.stage === 'verify' && view.testThreadId) return checkResponse(true);
      if (view.stage === 'installing' && !job && !view.hidden) {
        try { return await inspect(); }
        catch { return save({ stage: 'registration', message: 'Подключи компьютер BB и продолжи настройку.' }); }
      }
      return snapshot();
    },
    kimiOpen: async () => {
      if (view.stage === 'complete') return snapshot();
      await save({ hidden: false });
      if (job) return snapshot();
      try { return await inspect(); }
      catch { return save({ stage: 'blocked', message: 'Не удалось связаться с компьютером BB. Проверь подключение и повтори.' }); }
    },
    kimiStart: ({ apiKey }) => {
      if (starting) return starting;
      starting = start(apiKey).finally(() => { starting = null; });
      return starting;
    },
    kimiDismiss: async ({ reason }) => {
      if (job || starting) throw new Error('Дождись завершения текущего шага.');
      return save({ hidden: true, message: reason === 'other-agent' ? 'Выбран другой агент.' : '' });
    },
    kimiTestStarted: async ({ threadId }) => {
      await checkedThread(threadId, false);
      await save({ stage: 'verify', testThreadId: threadId, message: '' });
      return checkResponse();
    },
    kimiCheckResponse: () => checkResponse(),
    kimiRecheck: async () => {
      if (job || starting) return snapshot();
      await save({ hidden: false, stage: 'intro', testThreadId: null, message: '' });
      return inspect();
    },
    kimiReplaceKey: async ({ apiKey }) => {
      if (!view.canReplaceKey || job || starting) throw new Error('Этот профиль не принадлежит настройщику.');
      const status = await client.call('kimiInspect', null, target());
      const current = (await agents()).find(item => item.id === 'claude-kimi');
      if (!status.agent || current?.command !== status.agent.command || JSON.stringify(current.args) !== JSON.stringify(status.agent.args)) throw new Error('Регистрация Kimi изменилась. Существующее подключение сохранено.');
      await save({ stage: 'verify', hidden: false, testThreadId: null, message: '' });
      await client.call('kimiReplaceKey', { apiKey }, target());
      return save({ stage: 'verify', testThreadId: null, message: 'Ключ обновлён. Отправь новый проверочный запрос.' });
    },
  });
  return { settled: async () => { await job; } };
}
