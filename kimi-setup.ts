import { randomUUID } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { browserContract } from './experiments/account-prototype/browser-contract';
import { kimiRpcContract, kimiViewSchema, type KimiAgent, type KimiView } from './kimi-contract';

const PROVIDER = 'acp-claude-kimi';
const SETTINGS_PLUGIN = 'provider-acp';
const PREFERRED_MODEL = 'k3.1-pro';
async function bounded<T>(work: Promise<T>, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('BB timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Owns only local Kimi UI state. It never reads/writes svaib onboarding marks. */
export async function registerKimiSetup(bb: BbPluginApi, hostId: string | null) {
  const client = bb.hosts.experimental_client({ contract: browserContract });
  const storageKey = 'kimi-setup:v1:' + (hostId ?? 'unavailable');
  const saved = kimiViewSchema.safeParse(await bb.storage.kv.get(storageKey));
  let view: KimiView = saved.success ? saved.data : {
    revision: 0, canReplaceKey: false, hidden: false, stage: 'intro', message: '', hostId: hostId ?? '', testThreadId: null, verifyModel: null, manualRegistration: null, keyChangedAt: null,
    phase: null, startedAt: null, checkToken: null, checkStartedAt: null, catalogVersion: 0, automatic: false, ownedTestThreadId: null,
  };
  let job: Promise<void> | null = null;
  let starting: Promise<KimiView> | null = null;
  let replacing = false;
  let disposed = false;
  const abort = new AbortController();
  let verificationTimer: ReturnType<typeof setTimeout> | null = null;
  let checking = false;
  bb.onDispose(() => { disposed = true; abort.abort(); if (verificationTimer) clearTimeout(verificationTimer); });
  const occupied = () => !!job || !!starting || replacing;
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
    return { hostId, signal: abort.signal, timeoutMs: 600_000 };
  }
  async function agents() {
    const current = await bounded(bb.sdk.plugins.getSettings({ pluginId: SETTINGS_PLUGIN }));
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
      try { return (await bounded(bb.sdk.providers.list({ hostId: hostId ?? '' }))).some(provider => provider.id === PROVIDER); }
      catch { return false; }
    }
  }
  function sameRegistration(current: Record<string, unknown> | undefined, agent: KimiAgent) {
    return !!current && current.command === agent.command && JSON.stringify(current.args) === JSON.stringify(agent.args);
  }
  /** Only seed models confirmed by this host's provider catalog. */
  async function resolveVerifyModel(): Promise<string | null> {
    if (!hostId) return null;
    try {
      const catalog = await bounded(bb.sdk.providers.models({ hostId, providerId: PROVIDER }));
      if (catalog.modelLoadError || !catalog.providers.some(provider => provider.id === PROVIDER && provider.available)) return null;
      const models = catalog.models.filter(model => !model.routeProviderId || model.routeProviderId === PROVIDER);
      return (models.find(model => model.id === PREFERRED_MODEL) ?? models.find(model => model.id === 'k3.1-pro[1m]') ?? models.find(model => model.isDefault) ?? models[0])?.id ?? null;
    } catch { return null; }
  }
  async function inspect() {
    if (await hasProvider()) {
      const verifyModel = await resolveVerifyModel();
      const patch: Partial<KimiView> = { stage: 'verify', phase: null, verifyModel,
        message: verifyModel ? 'Kimi уже добавлен. Проверим ответ в обычном разговоре BB.' : 'Не удалось получить модели Kimi. Проверь, что компьютер BB подключён, и повтори проверку.', canReplaceKey: false };
      try {
        const status = await client.call('kimiInspect', null, target());
        patch.canReplaceKey = !!status.agent && sameRegistration((await agents()).find(item => item.id === 'claude-kimi'), status.agent);
      } catch { /* Ownership must be confirmed before offering replacement. */ }
      return save(patch);
    }
    const status = await client.call('kimiInspect', null, target());
    return save({ stage: status.profile === 'blocked' ? 'blocked'
      : status.profile === 'absent' ? 'key' : 'registration',
    message: status.profile === 'blocked' ? 'Папка настройки изменена. Существующие файлы сохранены; нужна помощь партнёра.' : '',
    canReplaceKey: false, verifyModel: null, phase: null,
    });
  }
  async function writeRegistration(agent: KimiAgent) {
    const list = await agents();
    if (disposed) return false;
    const existing = list.find(item => item.id === agent.id);
    const knownCli = existing && [ 'k3.1-pro[1m]', 'k3.1-pro' ].some(model =>
      JSON.stringify(existing.modelCli) === JSON.stringify({ listArgs: [agent.args[0], '--list-models'], primaryModels: [model] }));
    if (!existing || sameRegistration(existing, agent) && knownCli) {
      const updated = list.map(item => {
        if (item !== existing) return item;
        const { modelCli: _generatedCli, ...preserved } = item;
        return preserved;
      });
      await bb.sdk.plugins.updateSettings({ pluginId: SETTINGS_PLUGIN, values: { customAgents: JSON.stringify(existing ? updated : [...list, agent]) } });
    }
    const actual = (await agents()).find(item => item.id === agent.id);
    if (!actual) throw new Error('Registration not saved');
    return sameRegistration(actual, agent);
  }
  async function register(agent: KimiAgent) {
    try {
      const owned = await writeRegistration(agent);
      return save({ stage: 'verify', message: '', manualRegistration: null, verifyModel: await resolveVerifyModel(),
        canReplaceKey: owned, ...(owned ? { catalogVersion: 1 } : {}) });
    } catch {
      return save({ stage: 'registration', message: 'Профиль готов. В этой версии BB добавь провайдера через настройки ACP.', manualRegistration: JSON.stringify([agent], null, 2) });
    }
  }
  async function start(apiKey?: string) {
    if (job || replacing) return snapshot();
    if (await hasProvider()) {
      const status = await client.call('kimiInspect', null, target());
      const current = (await agents()).find(item => item.id === 'claude-kimi');
      await save({ hidden: false, stage: 'installing', automatic: true, phase: 'access', startedAt: Date.now(), message: '' });
      const run = async () => {
        try {
          if (status.agent && sameRegistration(current, status.agent)) {
            const upgraded = await client.call('kimiPrepare', {}, target());
            await register(upgraded);
          } else await save({ stage: 'verify', canReplaceKey: false, verifyModel: await resolveVerifyModel() });
          if (view.stage === 'verify') await beginAutomaticCheck();
          else await save({ phase: null });
        } catch { await save({ stage: 'registration', phase: null, message: 'Не удалось подготовить профиль. Существующие файлы сохранены; повтори настройку или обратись к партнёру.' }); }
      };
      job = run().finally(() => { job = null; }); void job.catch(() => {});
      return snapshot();
    }
    const status = await client.call('kimiInspect', null, target());
    if (status.profile === 'blocked' || status.profile === 'absent' && !apiKey) return inspect();
    await save({ hidden: false, stage: 'installing', message: '', manualRegistration: null, phase: 'components', startedAt: Date.now(), automatic: true });
    // The key exists only in this call's memory and host RPC, never KV, settings,
    // a terminal, a model request, command argv, or the returned view.
    const run = async () => {
      try {
        const agent = await client.call('kimiPrepare', { ...(apiKey ? { apiKey } : {}) }, target());
        apiKey = undefined;
        if (!disposed) {
          await save({ canReplaceKey: true, phase: 'access' });
          await register(agent);
          if (view.stage === 'verify') await beginAutomaticCheck();
          else await save({ phase: null });
        }
      } catch {
        apiKey = undefined;
        if (!disposed) await save({ stage: 'registration', phase: null, message: 'Не удалось завершить настройку. Проверь интернет и нажми «Продолжить настройку». Сохранённый профиль не перезаписывается.' });
      }
    };
    job = run().finally(() => { job = null; });
    void job.catch(() => {});
    return snapshot();
  }
  function launch(apiKey?: string) {
    if (starting) return starting;
    starting = start(apiKey).finally(() => { starting = null; });
    return starting;
  }
  async function checkedThread(threadId: string, requireHost = true) {
    const thread = await bounded(bb.sdk.threads.get({ threadId }));
    if (thread.deletedAt) throw Object.assign(new Error('Thread deleted'), { status: 404 });
    if (thread.providerId !== PROVIDER || thread.originPluginId !== bb.pluginId) throw new Error('Открой проверочный разговор Kimi из настройщика.');
    if (!thread.environmentId && !requireHost) return thread;
    if (!thread.environmentId) throw new Error('Проверка ещё запускается.');
    const environment = await bounded(bb.sdk.environments.get({ environmentId: thread.environmentId }));
    if (environment.hostId !== hostId) throw new Error('Проверка запущена на другом компьютере.');
    return thread;
  }
  async function recoverOwnCheck() {
    const token = view.checkToken;
    if (!token || view.ownedTestThreadId) return;
    const rows = await bounded(bb.sdk.threads.list({ originPluginId: bb.pluginId, includeHidden: true, limit: 200 }));
    if (!rows.length) return;
    const metadata = await bounded(bb.sdk.threads.experimental_listPluginMetadata({ pluginId: bb.pluginId, threadIds: rows.map(row => row.id) }));
    const match = metadata.threads.find(row => row.metadata.kimiCheck === token);
    if (!match || view.checkToken !== token || view.ownedTestThreadId) return;
    await checkedThread(match.threadId, false);
    if (view.checkToken === token && !view.ownedTestThreadId) await save({ testThreadId: match.threadId, ownedTestThreadId: match.threadId });
  }
  async function cleanOwnCheck(completedOnly = true) {
    const id = view.ownedTestThreadId;
    if (!id || completedOnly && view.stage !== 'complete') return true;
    try {
      await checkedThread(id);
      await bb.sdk.threads.stop({ threadId: id });
      await bb.sdk.threads.delete({ threadId: id, childThreadsConfirmed: false });
      if (view.ownedTestThreadId === id) await save({ ownedTestThreadId: null, checkToken: null, ...(view.testThreadId === id ? { testThreadId: null } : {}) });
      return true;
    } catch (error) {
      if ((error as { status?: number }).status === 404 || (error as { code?: string }).code === 'NOT_FOUND') {
        if (view.ownedTestThreadId === id) await save({ ownedTestThreadId: null, checkToken: null, ...(view.testThreadId === id ? { testThreadId: null } : {}) }); return true;
      }
      return false;
    }
  }
  async function failAutomaticCheck(message: string, testId: string) {
    await save({ phase: null, message });
    if (view.ownedTestThreadId === testId) {
      try { await checkedThread(testId); await bb.sdk.threads.stop({ threadId: testId }); } catch { /* Retry keeps the owned ID for cleanup. */ }
    }
  }
  function watchAutomaticCheck() {
    if (verificationTimer) clearTimeout(verificationTimer);
    if (disposed || !view.automatic || view.phase !== 'check' || !view.testThreadId) return;
    const testId = view.testThreadId; const keyVersion = view.keyChangedAt; const startedAt = view.checkStartedAt ?? view.startedAt;
    const current = () => !disposed && view.testThreadId === testId && view.keyChangedAt === keyVersion && view.phase === 'check';
    verificationTimer = setTimeout(async () => {
      if (disposed) return;
      if (checking) { watchAutomaticCheck(); return; }
      checking = true;
      try {
        const next = await checkResponse(true);
        if (next.stage === 'complete' || view.stage === 'complete') return;
        if (!current()) return;
        const thread = await checkedThread(testId);
        if (!current()) return;
        if (thread.status === 'error' || thread.status === 'idle' || Date.now() - (startedAt ?? 0) > 240_000) {
          await failAutomaticCheck('Kimi не подтвердила проверочный ответ. Проверь ключ и доступ к модели, затем повтори проверку.', testId);
          return;
        }
      } catch {
        if (current() && Date.now() - (startedAt ?? 0) > 240_000) {
          await failAutomaticCheck('Не удалось дождаться ответа Kimi. Проверь подключение и повтори проверку.', testId); return;
        }
      } finally { checking = false; }
      if (current()) watchAutomaticCheck();
    }, 1500);
    verificationTimer.unref?.();
  }
  async function beginAutomaticCheck() {
    if (disposed) return;
    if (view.checkToken && !view.ownedTestThreadId) await recoverOwnCheck();
    if (view.ownedTestThreadId && view.testThreadId === view.ownedTestThreadId) {
      await save({ phase: 'check' }); watchAutomaticCheck(); return;
    }
    await save({ phase: 'check', stage: 'verify', checkStartedAt: Date.now(), checkToken: randomUUID(), message: '', testThreadId: null });
    try {
      const model = view.verifyModel;
      if (!model || !hostId) throw new Error('model-unavailable');
      const personal = (await bounded(bb.sdk.projects.list({ includePersonal: true }))).find(project => project.kind === 'personal');
      if (disposed) return;
      if (!personal) throw new Error('personal-project-unavailable');
      const thread = await bb.sdk.threads.spawn({
        projectId: personal.id,
        providerId: PROVIDER, model, reasoningLevel: 'high', permissionMode: 'accept-edits',
        title: 'Проверка Kimi', visibility: 'hidden',
        environment: { type: 'host', hostId, workspace: { type: 'personal' } },
        input: [{ type: 'text', text: 'Ответь ровно KIMI_READY. Не используй инструменты, не читай и не меняй файлы.', mentions: [] }],
        pluginMetadata: { kimiSetup: 1, kimiCheck: view.checkToken },
      });
      await save({ testThreadId: thread.id, ownedTestThreadId: thread.id });
      watchAutomaticCheck();
    } catch {
      try { await recoverOwnCheck(); } catch { /* Retry retains the nonce for recovery. */ }
      if (view.ownedTestThreadId) watchAutomaticCheck();
      else await save({ phase: null, message: 'Не удалось запустить проверку Kimi. Проверь подключение к BB и повтори.' });
    }
  }
  async function checkResponse(quiet = false) {
    const testId = view.testThreadId;
    const keyVersion = view.keyChangedAt;
    const current = () => !replacing && (!occupied() || view.automatic && view.phase === 'check') && view.keyChangedAt === keyVersion && view.testThreadId === testId && view.stage === 'verify' && !view.hidden;
    const pending = (message: string) => quiet || !current() ? Promise.resolve(snapshot()) : save({ message });
    if (!view.testThreadId) return pending('Сначала отправь проверочный запрос Kimi.');
    try {
      const thread = await checkedThread(view.testThreadId);
      if (thread.status !== 'idle') return pending('Ответ ещё не получен. Проверь разговор и повтори проверку.');
      const { output } = await bounded(bb.sdk.threads.output({ threadId: thread.id }));
      if (!current()) return snapshot();
      if (output?.trim() !== 'KIMI_READY') return pending('Проверочный ответ не подтверждён. Открой разговор и проверь результат.');
      await save({ stage: 'complete', hidden: true, phase: null, message: 'Готово к работе', manualRegistration: null });
      await cleanOwnCheck();
      return snapshot();
    } catch { return pending('Не удалось проверить ответ. Открой разговор Kimi и повтори.'); }
  }
  bb.events.on('thread.idle', async ({ thread }) => {
    if (!disposed && !view.hidden && view.stage === 'verify' && thread.id === view.testThreadId) await checkResponse();
  });
  bb.rpc.register(kimiRpcContract, {
    kimiStatus: async () => {
      if (view.stage === 'complete' && view.ownedTestThreadId) await cleanOwnCheck();
      if (!view.hidden && view.stage === 'verify' && view.testThreadId) return checkResponse(true);
      if (view.stage === 'installing' && !occupied() && !view.hidden) {
        try { if (view.automatic) return await launch(); return await inspect(); }
        catch { return save({ stage: 'registration', phase: null, message: 'Подключи компьютер BB и продолжи настройку.' }); }
      }
      return snapshot();
    },
    kimiOpen: async () => {
      if (view.stage === 'complete') return snapshot();
      await save({ hidden: false });
      if (occupied()) return snapshot();
      if (view.automatic && view.phase === 'check' && view.testThreadId) { watchAutomaticCheck(); return snapshot(); }
      try { if (view.automatic) return await launch(); return await inspect(); }
      catch { return save({ stage: 'blocked', message: 'Не удалось связаться с компьютером BB. Проверь подключение и повтори.' }); }
    },
    kimiStart: ({ apiKey }) => launch(apiKey),
    kimiDismiss: async ({ reason }) => {
      if (occupied()) throw new Error('Дождись завершения текущего шага.');
      return save({ hidden: true, message: reason === 'other-agent' ? 'Выбран другой агент.' : '' });
    },
    kimiTestStarted: async ({ threadId }) => {
      if (occupied()) throw new Error('Дождись завершения текущего шага.');
      const keyChangedAt = view.keyChangedAt;
      const thread = await checkedThread(threadId, false);
      // Recheck after I/O: a replacement may have begun or finished meanwhile.
      if (occupied() || view.keyChangedAt !== keyChangedAt) throw new Error('Настройка изменилась. Отправь новый проверочный запрос.');
      if (keyChangedAt !== null && thread.createdAt <= keyChangedAt) throw new Error('Разговор создан до замены ключа. Отправь новый проверочный запрос.');
      await save({ stage: 'verify', testThreadId: threadId, message: '' });
      return checkResponse();
    },
    kimiCheckResponse: () => checkResponse(),
    kimiRecheck: () => {
      if (occupied()) return Promise.resolve(snapshot());
      const run = async () => {
        try { await recoverOwnCheck(); } catch { return save({ phase: null, message: 'Не удалось восстановить предыдущую проверку. Подключи BB и повтори.' }); }
        if (!await cleanOwnCheck(false)) return save({ phase: null, message: 'Не удалось завершить предыдущую проверку. Подключи компьютер BB и повтори.' });
        await save({ hidden: false, stage: 'intro', testThreadId: null, ownedTestThreadId: null, checkToken: null, message: '', phase: null, automatic: true });
        return start();
      };
      starting = run().finally(() => { starting = null; }); return starting;
    },
    kimiReplaceKey: async ({ apiKey }) => {
      if (!view.canReplaceKey || occupied()) throw new Error('Этот профиль не принадлежит настройщику.');
      replacing = true;
      try {
        const status = await client.call('kimiInspect', null, target());
        const current = (await agents()).find(item => item.id === 'claude-kimi');
        if (!status.agent || !sameRegistration(current, status.agent)) throw new Error('Регистрация Kimi изменилась. Существующее подключение сохранено.');
        // The installing interlude keeps checkResponse off: a late reply of the
        // old key must not complete setup while the key is being replaced.
        await recoverOwnCheck();
        if (!await cleanOwnCheck(false)) throw new Error('cleanup-pending');
        await save({ hidden: false, stage: 'installing', phase: 'access', startedAt: Date.now(), message: '' });
        await client.call('kimiReplaceKey', { apiKey }, target());
        const keyChangedAt = Date.now();
        await save({ stage: 'verify', phase: null, hidden: false, testThreadId: null, ownedTestThreadId: null, keyChangedAt, verifyModel: view.verifyModel ?? await resolveVerifyModel(), message: view.automatic ? '' : 'Ключ обновлён. Отправь новый проверочный запрос.' });
        if (view.automatic) { await save({ startedAt: Date.now() }); await beginAutomaticCheck(); }
        return snapshot();
      } catch (error) {
        if (view.stage === 'installing') await save({ stage: 'verify', phase: null, message: 'Не удалось подтвердить замену ключа. Проверь подключение к BB и повтори.' });
        throw error;
      } finally { replacing = false; }
    },
  });
  const needsResume = view.stage === 'complete' && view.catalogVersion < 1 && view.canReplaceKey
    || view.automatic && (view.phase === 'check' || view.stage === 'installing');
  if (needsResume) bb.background.service('kimi-resume', {
    async start(signal) {
      if (signal.aborted || disposed) return;
      // Host calls are forbidden during factory registration. Services start
      // only once BB has registered the plugin and its host entry.
      if (view.stage === 'complete' && view.catalogVersion < 1 && view.canReplaceKey) {
        // Upgrade generated 0.4.2 metadata without another model request or reinstall.
        job = (async () => {
          try {
            const status = await client.call('kimiInspect', null, target());
            if (!status.agent || !sameRegistration((await agents()).find(item => item.id === 'claude-kimi'), status.agent)) return;
            const agent = await client.call('kimiPrepare', {}, target());
            if (await writeRegistration(agent)) await save({ automatic: true, catalogVersion: 1, message: 'Готово к работе' });
          } catch { bb.log.warn('Не удалось обновить настройки моделей Kimi. Работающее подключение сохранено; повтори проверку в настройках плагина.'); }
        })().finally(() => { job = null; }); void job.catch(() => {});
      }
      else if (view.automatic && view.phase === 'check' && view.testThreadId) watchAutomaticCheck();
      else if (view.automatic && view.phase === 'check') {
        job = (async () => {
          try { await recoverOwnCheck(); } catch { /* Visible retry below. */ }
          if (view.ownedTestThreadId) watchAutomaticCheck();
          else await save({ phase: null, message: 'Проверка прервалась при перезапуске BB. Повтори проверку.' });
        })().finally(() => { job = null; }); void job.catch(() => {});
      }
      else if (view.automatic && view.stage === 'installing') await launch();
      await starting;
      await job;
      if (!signal.aborted) await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  });
  return { settled: async () => { await starting; await job; } };
}
