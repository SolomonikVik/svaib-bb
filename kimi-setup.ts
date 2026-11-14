import { createKimiPiSupport } from './kimi-pi-support';
import { randomUUID } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { browserContract } from './experiments/account-prototype/browser-contract';
import { kimiRpcContract, kimiViewSchema, type KimiAgent, type KimiView } from './kimi-contract';
import { kimiDiagnostics, kimiDiagnosticSignals, kimiStep, kimiErrorFields, kimiVersion, type KimiDiagnostic } from './kimi-diagnostics';

const SETTINGS_PLUGIN = 'provider-acp';
const PREFERRED_MODEL = 'k3.1-pro';
const CATALOG_VERSION = 4;
const CATALOG_TTL = 24 * 60 * 60 * 1000;
async function bounded<T>(work: Promise<T>, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('BB timeout'), { name: 'TimeoutError' })), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Owns only local Kimi UI state. It never reads/writes svaib onboarding marks. */
async function createKimiSetup(bb: BbPluginApi, hostId: string | null, harness: 'claude-code' | 'pi', pi: Awaited<ReturnType<typeof createKimiPiSupport>>, diagnostics: { write: (event: KimiDiagnostic) => void; routes: Map<string, (event: KimiDiagnostic) => void> }, piMode: 'native' | 'managed' = 'native') {
  const isPi = harness === 'pi';
  const nativePi = isPi && piMode === 'native';
  const PROVIDER = isPi ? 'pi' : 'acp-claude-kimi';
  const client = bb.hosts.experimental_client({ contract: browserContract, experimental_signals: kimiDiagnosticSignals });
  const writeDiagnostic = diagnostics.write;
  const log = kimiDiagnostics(randomUUID(), 'backend', writeDiagnostic);
  let environmentSnapshot: Promise<void> | undefined;
  function logEnvironment() {
    return environmentSnapshot ??= Promise.allSettled([
      (async () => {
        const version = kimiVersion((await bounded(bb.sdk.system.version(), 2000)).currentVersion);
        if (version) log('environment', 'success', { component: 'bb', version });
      })(),
      (async () => {
        const plugin = (await bounded(bb.sdk.plugins.list(), 2000)).plugins.find(item => item.id === bb.pluginId);
        const version = kimiVersion(plugin?.version);
        const sdkVersion = kimiVersion(plugin?.app.bundle?.sdkVersion);
        if (version) log('environment', 'success', { component: 'plugin', version, ...(sdkVersion ? { sdkVersion } : {}) });
      })(),
    ]).then(() => {});
  }
  let activePreparation: string | null = null;
  const receiveProgress = (entry: KimiDiagnostic) => {
    if (entry.diagnosticId !== activePreparation || view.stage !== 'installing' || view.phase !== 'components') return;
    if (!['runtime-install', 'runtime-download', 'adapter-install', 'runtime-probe'].includes(entry.step) || !['start', 'progress', 'success', 'fallback'].includes(entry.outcome)) return;
    // Progress belongs only to the current explicit operation.
    view = { ...view, revision: view.revision + 1, installProgress: {
      step: entry.step as 'runtime-install' | 'runtime-download' | 'adapter-install' | 'runtime-probe',
      ...(entry.runtimeKind ? { runtimeKind: entry.runtimeKind } : {}),
      ...(entry.component && ['node', 'adapter', 'claude-code', 'pi'].includes(entry.component) ? { component: entry.component as 'node' | 'adapter' | 'claude-code' | 'pi' } : {}),
      ...(entry.artifact ? { artifact: entry.artifact } : {}),
      ...(entry.downloadBytes !== undefined ? { downloadBytes: entry.downloadBytes } : {}),
      ...(entry.totalBytes ? { totalBytes: entry.totalBytes } : {}),
    } };
    bb.realtime.publish('kimi-setup-changed', null);
  };
  const storageKey = (nativePi ? 'kimi-pi-native-setup:v1:' : isPi ? 'kimi-pi-setup:v1:' : 'kimi-setup:v1:') + (hostId ?? 'unavailable');
  const saved = kimiViewSchema.safeParse(await bb.storage.kv.get(storageKey));
  // Saved check IDs and phases are legacy cleanup candidates, never resumable work.
  const legacyCleanup = saved.success ? saved.data.ownedTestThreadId ?? saved.data.testThreadId : null;
  let view: KimiView = {
    harness, piMode, revision: saved.success ? saved.data.revision : 0,
    canReplaceKey: saved.success ? saved.data.canReplaceKey : false,
    registrationGeneration: saved.success ? saved.data.registrationGeneration ?? null : null,
    stopUnconfirmed: saved.success ? saved.data.stopUnconfirmed ?? saved.data.phase === 'check' : false,
    hidden: saved.success ? saved.data.hidden : false, stage: 'intro', message: saved.success && saved.data.stopUnconfirmed ? 'Предыдущий запрос мог продолжиться: BB не подтвердил остановку. Следующее нажатие «Повторить» создаст один новый запрос.' : '', hostId: hostId ?? '',
    testThreadId: null, verifyModel: null, manualRegistration: saved.success ? saved.data.manualRegistration : null,
    keyChangedAt: saved.success ? saved.data.keyChangedAt : null, phase: null, startedAt: null,
    checkToken: null, checkStartedAt: null, automatic: false, ownedTestThreadId: null,
    catalogVersion: saved.success ? saved.data.catalogVersion : 0,
    catalogCheckedAt: saved.success ? saved.data.catalogCheckedAt : null,
    installProgress: null,
  };
  let job: Promise<void> | null = null;
  let starting: Promise<KimiView> | null = null;
  let replacing = false;
  let disposed = false;
  const abort = new AbortController();
  let verificationTimer: ReturnType<typeof setTimeout> | null = null;
  let checking = false;
  type Attempt = { nonce: string; generation: number; keyVersion: number | null; startedAt: number; model: string; threadId: string | null };
  let generation = 0;
  let attempt: Attempt | null = null;
  let verificationStart: Promise<void> | null = null;
  let stopWarning = '';
  let legacySwept = false;
  bb.onDispose(async () => { const previous = attempt; attempt = null; disposed = true; abort.abort(); if (verificationTimer) clearTimeout(verificationTimer);
    if (previous?.threadId) await cleanupOwnedCheck(previous.threadId).catch(() => {}); });
  const occupied = () => !!job || !!starting || replacing;
  const snapshot = () => {
    const warning = 'Предыдущий запрос мог продолжиться: BB не подтвердил остановку. Следующее нажатие «Повторить» создаст один новый запрос.';
    return { ...view, ...(!attempt && view.stopUnconfirmed ? { message: view.message.includes('мог продолжиться') || !view.message ? warning : `${view.message} ${warning}` } : {}) };
  };
  async function save(patch: Partial<KimiView>) {
    if (disposed) return snapshot();
    const changed = patch.stage !== undefined && patch.stage !== view.stage || patch.phase !== undefined && patch.phase !== view.phase;
    view = { ...view, ...(patch.phase !== undefined || patch.stage !== undefined ? { installProgress: null } : {}), ...patch, revision: view.revision + 1 };
    await bb.storage.kv.set(storageKey, { ...view, stage: 'intro', phase: null, startedAt: null, automatic: false, testThreadId: null, ownedTestThreadId: null, checkToken: null, checkStartedAt: null, installProgress: null });
    if (changed) log('state', 'success', { stage: view.stage, phase: view.phase });
    bb.realtime.publish('kimi-setup-changed', null);
    return snapshot();
  }
  function target() {
    if (!hostId) throw new Error('Компьютер BB недоступен. Подключи его и повтори настройку.');
    return { hostId, signal: abort.signal, timeoutMs: 35 * 60_000 };
  }
  async function hostMutation<T>(step: 'prepare' | 'key-replace', reason: KimiDiagnostic['reason'], work: (diagnosticId: string) => Promise<T>) {
    const diagnosticId = randomUUID();
    const operationLog = kimiDiagnostics(diagnosticId, 'backend', writeDiagnostic);
    operationLog(step, 'start', { reason });
    await logEnvironment();
    const started = Date.now();
    activePreparation = diagnosticId; diagnostics.routes.set(diagnosticId, receiveProgress);
    try { const result = await work(diagnosticId); operationLog(step, 'success', { elapsedMs: Date.now() - started }); return result; }
    catch (error) { operationLog(step, 'failure', { reason: abort.signal.aborted ? 'cancelled' : 'failed', elapsedMs: Date.now() - started, ...kimiErrorFields(error) }); throw error; }
    finally { diagnostics.routes.delete(diagnosticId); if (activePreparation === diagnosticId) activePreparation = null; }
  }
  const prepareProfile = (apiKey: string | undefined, reason: KimiDiagnostic['reason']) => hostMutation('prepare', reason,
    diagnosticId => client.call('kimiPrepare', { ...(apiKey ? { apiKey } : {}), diagnosticId }, target()));
  const preparePi = (apiKey: string | undefined, replaceKey = false) => hostMutation(replaceKey ? 'key-replace' : 'prepare', replaceKey ? 'key-change' : 'setup',
    diagnosticId => client.call('kimiPiPrepare', { ...(apiKey ? { apiKey } : {}), replaceKey, diagnosticId }, target()));
  const prepareNativePi = (apiKey: string | undefined, replaceKey = false) => hostMutation(replaceKey ? 'key-replace' : 'prepare', replaceKey ? 'key-change' : 'setup',
    diagnosticId => client.call('kimiPiNativePrepare', { ...(apiKey ? { apiKey } : {}), replaceKey, diagnosticId }, target()));
  async function inspectNativePi() {
    try { await pi.nativePreflight(); }
    catch (error) {
      // An existing custom launch may already work. It can be verified, but its
      // hidden profile must never be guessed or mutated by this card.
      const verifyModel = await resolveVerifyModel();
      if (verifyModel) return save({ stage: 'verify', phase: null, verifyModel, canReplaceKey: false,
        message: 'Kimi уже доступна через настроенный Pi. Проверим ответ в BB.' });
      return save({ stage: 'blocked', phase: null, canReplaceKey: false, message: piFailure(error) });
    }
    const status = await client.call('kimiPiNativeInspect', null, target());
    if (status.profile === 'blocked') return save({ stage: 'blocked', phase: null, canReplaceKey: false,
      message: 'Не удалось безопасно продолжить с этим Pi или его профилем. Помощник проверит версию, запуск и настройки; существующие файлы сохранены.' });
    if (!status.installed) return save({ stage: 'registration', phase: null, canReplaceKey: false, automatic: false,
      message: 'Сначала установим штатный Pi через BB на этом компьютере. Затем карточка запросит ключ Kimi Code.' });
    if (status.needsRepair) return save({ stage: 'registration', phase: null, verifyModel: null, canReplaceKey: status.canReplaceKey, automatic: false,
      message: 'Настройки Kimi в собственном профиле Pi повреждены или не завершены. Нажми «Продолжить настройку»: восстановим подключение с сохранением действующего входа и других настроек.' });
    if (status.hasCredential || await pi.nativeEnvironmentCredential()) {
      const verifyModel = await resolveVerifyModel();
      return save({ stage: 'verify', phase: null, verifyModel, canReplaceKey: status.canReplaceKey,
        message: verifyModel ? 'Kimi уже настроена в штатном Pi. Проверим ответ в BB.' : 'Pi установлен. Не удалось подтвердить каталог Kimi — проверь доступ и повтори проверку.' });
    }
    return save({ stage: 'key', phase: null, verifyModel: null, canReplaceKey: false, automatic: false, message: '' });
  }
  async function startNativePi(apiKey?: string) {
    try { await pi.nativePreflight(); } catch { return inspectNativePi(); }
    const status = await client.call('kimiPiNativeInspect', null, target());
    if (status.profile === 'blocked') return inspectNativePi();
    const environmentCredential = await pi.nativeEnvironmentCredential();
    if (status.installed && !apiKey && !status.hasCredential && !environmentCredential) return inspectNativePi();
    await save({ hidden: false, stage: 'installing', phase: status.installed ? 'access' : 'components',
      automatic: true, startedAt: Date.now(), message: '' });
    job = (async () => {
      try {
        let current = status;
        if (!current.installed) {
          await hostMutation('prepare', 'setup', diagnosticId => client.call('kimiPiNativePrerequisites', { diagnosticId }, target()));
          await pi.installNative();
          current = await client.call('kimiPiNativeInspect', null, target());
          if (!current.installed || current.profile === 'blocked') throw new Error('PI_NATIVE_INSTALL_FAILED');
        }
        if (!apiKey && !current.hasCredential && !environmentCredential) {
          await save({ stage: 'key', phase: null, automatic: false, message: 'Pi установлен. Введи ключ Kimi Code.' }); return;
        }
        await save({ phase: 'access' });
        if (!environmentCredential || current.needsRepair) await prepareNativePi(apiKey);
        apiKey = undefined;
        current = await client.call('kimiPiNativeInspect', null, target());
        const verifyModel = await resolveVerifyModel(true);
        await save({ stage: 'verify', verifyModel, canReplaceKey: current.canReplaceKey });
        if (!verifyModel) { await save({ phase: null, message: 'Pi подготовлен. BB пока не подтвердил каталог Kimi. Проверь доступ и повтори проверку; новую установку начинать не нужно.' }); return; }
        await beginAutomaticCheck();
      } catch (error) {
        apiKey = undefined;
        if (!disposed) await save({ stage: 'registration', phase: null, message: piFailure(error) });
      }
    })().finally(() => { job = null; });
    void job.catch(() => {}); return snapshot();
  }
  async function replaceNativePiKey(apiKey: string) {
    if (!view.canReplaceKey || occupied()) throw new Error('Ключ не принадлежит настройщику.');
    replacing = true;
    try {
      await repairRequirements();
      await pi.nativePreflight();
      const status = await client.call('kimiPiNativeInspect', null, target());
      if (!status.canReplaceKey) throw new Error('PI_NATIVE_PROFILE_CHANGED');
      await invalidateCheck();
      await save({ hidden: false, stage: 'installing', phase: 'access', automatic: true, startedAt: Date.now(),
        keyChangedAt: Date.now(), testThreadId: null, verifyModel: null, message: '' });
      await prepareNativePi(apiKey, true);
      const verifyModel = await resolveVerifyModel(true);
      await save({ stage: 'verify', verifyModel, keyChangedAt: Date.now() });
      if (verifyModel) await beginAutomaticCheck();
      else await save({ phase: null, message: 'Ключ сохранён. Не удалось подтвердить каталог Kimi — повтори проверку.' });
      return snapshot();
    } catch (error) { return save({ stage: 'verify', phase: null, message: piFailure(error) }); }
    finally { replacing = false; }
  }
  function piFailure(error: unknown) {
    const code = error instanceof Error ? error.message : '';
    return code === 'PI_FOREIGN_ENV' ? 'В BB уже задан собственный запуск или профиль Pi. Настройки сохранены. Продолжи по справке Pi с помощником.'
      : code === 'PI_UNSUPPORTED' ? 'В этой версии BB автоматическая настройка Pi недоступна. Обнови BB или продолжи по ручной справке с помощником.'
      : code === 'PI_WRONG_HOST' ? 'Компьютер настройки изменился. Подключи исходный компьютер BB и повтори.'
      : code === 'PI_MULTIPLE_HOSTS' ? 'В BB подключено несколько компьютеров. Автоматическая настройка Pi рассчитана на один; помощник проведёт ручную настройку на выбранном компьютере, сохранив остальные.'
      : code === 'PI_NATIVE_INSTALL_FAILED' || code === 'PI_NATIVE_INSTALL_UNAVAILABLE' ? 'BB не подтвердил запуск штатного Pi после установки. Повтори проверку; если Pi не запускается, помощник проверит Node/npm или поможет выбрать резервную установку.'
      : code === 'PI_NATIVE_PROFILE_CHANGED' ? 'Настройки Kimi изменились после нашей записи. Существующий ключ сохранён; нужна помощь партнёра.'
      : 'Не удалось подготовить Pi. Настройки сохранены. Нажми «Продолжить настройку»; при повторной ошибке попроси помощника проверить журнал.';
  }
  async function inspectPi() {
    if (!pi.supported) return save({ stage: 'blocked', phase: null, message: piFailure(new Error('PI_UNSUPPORTED')) });
    const status = await client.call('kimiPiInspect', null, target());
    const external = status.hasExternalProfile || await pi.hasExternalCredentials();
    if (status.profile === 'blocked') return save({ stage: 'blocked', phase: null, canReplaceKey: false,
      message: 'Профиль Pi изменён. Существующие файлы сохранены; нужна помощь партнёра.' });
    if (status.profile === 'ready' && status.registration) {
      await pi.preflight();
      // Read-only inspection never activates or rewrites provider settings.
    }
    const verifyModel = external || status.profile === 'ready' ? await resolveVerifyModel() : null;
    if (verifyModel && (!pi.owned() || !status.needsKey)) return save({ stage: 'verify', phase: null, verifyModel,
      canReplaceKey: pi.owned(), message: 'Kimi уже доступна через Pi. Проверим ответ в BB.' });
    if (!pi.owned() && external) return save({ stage: 'blocked', phase: null, canReplaceKey: false,
      message: 'В Pi уже есть настройки. Они сохранены. Помощник поможет добавить Kimi в существующий профиль по справке Pi.' });
    await pi.preflight();
    return save({ stage: status.needsKey || status.profile === 'absent' ? 'key' : 'registration', phase: null,
      canReplaceKey: pi.owned(), verifyModel: null, message: '' });
  }
  async function startPi(apiKey?: string) {
    const status = await client.call('kimiPiInspect', null, target());
    if (status.profile === 'blocked') return inspectPi();
    if (!pi.owned() && (status.hasExternalProfile || await pi.hasExternalCredentials())) {
      const verifyModel = await resolveVerifyModel();
      if (!verifyModel) return inspectPi();
      await save({ hidden: false, stage: 'verify', automatic: true, verifyModel, startedAt: Date.now(), message: '' });
      await beginAutomaticCheck(); return snapshot();
    }
    if (!apiKey && (status.needsKey || status.profile === 'absent')) return inspectPi();
    await save({ hidden: false, stage: 'installing', phase: 'components', automatic: true, startedAt: Date.now(), message: '' });
    job = (async () => {
      try {
        await pi.preflight();
        const registration = await preparePi(apiKey);
        apiKey = undefined;
        await save({ phase: 'access' });
        if ((await pi.activate(registration)).changed) {
          await save({ stage: 'restart', phase: null, canReplaceKey: true, message: '' }); return;
        }
        const verifyModel = await resolveVerifyModel();
        await save({ stage: 'verify', verifyModel, canReplaceKey: true });
        if (!verifyModel) { await save({ phase: null, message: 'Не удалось получить модели Kimi. После первого подключения нужен полный перезапуск BB. Если он уже выполнен, проверь ключ и доступ к модели.' }); return; }
        await beginAutomaticCheck();
      } catch (error) {
        apiKey = undefined;
        if (!disposed) await save({ stage: 'registration', phase: null, message: piFailure(error) });
      }
    })().finally(() => { job = null; });
    void job.catch(() => {}); return snapshot();
  }
  async function replacePiKey(apiKey: string) {
    if (!pi.owned() || !view.canReplaceKey || occupied()) throw new Error('Этот профиль не принадлежит настройщику.');
    replacing = true;
    try {
      await repairRequirements();
      await pi.preflight();
      await invalidateCheck();
      await save({ hidden: false, stage: 'installing', phase: 'access', automatic: true, startedAt: Date.now(),
        keyChangedAt: Date.now(), testThreadId: null, verifyModel: null, message: '' });
      await pi.activate(await preparePi(apiKey, true));
      await save({ stage: 'verify', verifyModel: await resolveVerifyModel(), keyChangedAt: Date.now() });
      await beginAutomaticCheck();
      return snapshot();
    } catch (error) {
      await save({ stage: 'verify', phase: null, message: piFailure(error) });
      return snapshot();
    } finally { replacing = false; }
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
  function ownsRegistration(current: Record<string, unknown> | undefined, agent: KimiAgent) {
    return sameRegistration(current, agent) || !!view.registrationGeneration && (current?.env as Record<string, string> | undefined)?.SVAIB_KIMI_CATALOG_GENERATION === view.registrationGeneration;
  }
  function sameRegistration(current: Record<string, unknown> | undefined, agent: KimiAgent) {
    return !!current && current.command === agent.command && JSON.stringify(current.args) === JSON.stringify(agent.args);
  }
  /** Only seed models confirmed by this host's provider catalog. */
  async function resolveVerifyModel(waitForNativeRefresh = false): Promise<string | null> {
    if (!hostId) return null;
    await logEnvironment();
    const started = Date.now(); log('bb-discovery', 'start');
    let operation: 'host-inspect' | 'settings-read' | 'provider-models' = 'host-inspect';
    try {
      if (isPi) {
        const query = { hostId, providerId: 'pi', preferCached: false, signal: abort.signal };
        // BB0.48.1 first returns a cached empty catalog while its refresh runs.
        // Keep the visible step active instead of asking for another install/key.
        const attempts = nativePi && waitForNativeRefresh ? 46 : 6;
        const deadline = Date.now() + (nativePi && waitForNativeRefresh ? 75_000 : 15_000);
        for (let attempt = 0; attempt < attempts && Date.now() < deadline; attempt++) {
          if (disposed) return null;
          const catalog = await bounded(bb.sdk.providers.models(query), Math.min(8000, deadline - Date.now()));
          const available = !catalog.modelLoadError && catalog.providers.some(provider => provider.id === 'pi' && provider.available);
          const models = available ? catalog.models.filter(model => model.id.startsWith('kimi-coding/')) : [];
          const model = (models.find(model => model.id === 'kimi-coding/k3.1-pro') ?? models.find(model => model.isDefault) ?? models[0])?.id;
          if (model) { log('bb-discovery', 'success', { modelCount: models.length, elapsedMs: Date.now() - started }); return model; }
          if (attempt < attempts - 1) await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', finish); resolve(); };
            const timer = setTimeout(finish, 1500);
            abort.signal.addEventListener('abort', finish, { once: true });
            if (abort.signal.aborted) finish();
          });
        }
        log('bb-discovery', 'failure', { reason: 'unavailable', elapsedMs: Date.now() - started });
        return null;
      }
      const status = await client.call('kimiInspect', null, target());
      operation = 'settings-read';
      const owned = status.agent && sameRegistration((await agents()).find(item => item.id === 'claude-kimi'), status.agent);
      // Keep the modern freshness request. A variable also typechecks against
      // the older SDK, which ignores the additional property at runtime.
      const query = { hostId, providerId: PROVIDER, preferCached: false };
      operation = 'provider-models';
      const catalog = await bounded(bb.sdk.providers.models(query));
      if (catalog.modelLoadError || !catalog.providers.some(provider => provider.id === PROVIDER && provider.available)) {
        log('bb-discovery', 'failure', { reason: 'unavailable', operation, elapsedMs: Date.now() - started,
          ...(catalog.modelLoadError ? { providerErrorCode: catalog.modelLoadError.code, ...kimiErrorFields(catalog.modelLoadError) } : {}) }); return null;
      }
      const allowed = status.verifyModels && owned
        ? new Set(status.verifyModels) : null;
      const models = catalog.models.filter(model => (!model.routeProviderId || model.routeProviderId === PROVIDER) && (!allowed || allowed.has(model.id)));
      const selected = (models.find(model => model.id === PREFERRED_MODEL) ?? models.find(model => model.id === 'k3.1-pro[1m]') ?? models.find(model => model.isDefault) ?? models[0])?.id ?? null;
      log('bb-discovery', selected ? 'success' : 'failure', { modelCount: models.length, elapsedMs: Date.now() - started });
      return selected;
    } catch (error) { log('bb-discovery', 'failure', { reason: 'failed', operation, elapsedMs: Date.now() - started, ...kimiErrorFields(error) }); return null; }
  }
  async function inspect() {
    if (isPi) return nativePi ? inspectNativePi() : inspectPi();
    const status = await client.call('kimiInspect', null, target());
    const providerExists = await hasProvider();
    if (status.profile === 'partial' && status.needsKey && (!providerExists || status.agent && ownsRegistration((await agents()).find(item => item.id === 'claude-kimi'), status.agent))) {
      return save({ stage: 'key', phase: null, verifyModel: null, canReplaceKey: false,
        message: 'Ключ Kimi отсутствует или повреждён. Введи новый ключ; настройки профиля сохранятся.' });
    }
    if (providerExists) {
      const verifyModel = await resolveVerifyModel();
      const patch: Partial<KimiView> = { stage: 'verify', phase: null, verifyModel,
        message: verifyModel ? 'Kimi уже добавлен. Проверим ответ в обычном разговоре BB.' : 'Не удалось получить модели Kimi. Проверь, что компьютер BB подключён, и повтори проверку.', canReplaceKey: false };
      try {
        patch.canReplaceKey = !!status.agent && ownsRegistration((await agents()).find(item => item.id === 'claude-kimi'), status.agent);
      } catch { /* Ownership must be confirmed before offering replacement. */ }
      return save(patch);
    }
    return save({ stage: status.profile === 'blocked' ? 'blocked'
      : status.profile === 'absent' || status.needsKey ? 'key' : 'registration',
    message: status.profile === 'blocked' ? 'Папка настройки изменена. Существующие файлы сохранены; нужна помощь партнёра.' : '',
    canReplaceKey: false, verifyModel: null, phase: null,
    });
  }
  let pendingRegistrationGeneration: string | null = null;
  function manualGenerationFor(agent: KimiAgent): string | undefined {
    try {
      const manual = JSON.parse(view.manualRegistration ?? 'null')?.[0];
      const generation = manual?.env?.SVAIB_KIMI_CATALOG_GENERATION;
      if (sameRegistration(manual, agent) && typeof generation === 'string' && /^[a-f0-9-]{36}$/.test(generation)) return generation;
    } catch { /* Only a matching manual registration can complete the fallback. */ }
    return undefined;
  }
  async function writeRegistration(agent: KimiAgent, phase: (operation: KimiDiagnostic['operation']) => void = () => {}) {
    phase('settings-read');
    const list = await agents();
    if (disposed) return false;
    const existing = list.find(item => item.id === agent.id);
    const knownCli = existing && [ 'k3.1-pro[1m]', 'k3.1-pro' ].some(model =>
      JSON.stringify(existing.modelCli) === JSON.stringify({ listArgs: [agent.args[0], '--list-models'], primaryModels: [model] }));
    if (existing && !ownsRegistration(existing, agent)) return false;
    // Both BB's server cache and ACP's minute-long discovery cache key on the
    // registered launch environment. An inert generation invalidates both after
    // a profile mutation, on BB 0.48.1 as well as current BB. Preserve all user
    // fields/environment variables and never change the command or model choice.
    const manualGeneration = manualGenerationFor(agent);
    const generation = manualGeneration ?? randomUUID();
    pendingRegistrationGeneration = generation;
    if (manualGeneration && !knownCli && (existing?.env as Record<string, string> | undefined)?.SVAIB_KIMI_CATALOG_GENERATION === generation) return true;
    const { modelCli, ...preserved } = existing ?? agent;
    const updated = {
      ...preserved, command: agent.command, args: agent.args, ...(!knownCli && modelCli ? { modelCli } : {}),
      env: { ...((existing?.env ?? {}) as Record<string, string>), SVAIB_KIMI_CATALOG_GENERATION: generation },
    };
    phase('settings-write');
    await bb.sdk.plugins.updateSettings({ pluginId: SETTINGS_PLUGIN,
      values: { customAgents: JSON.stringify(existing ? list.map(item => item === existing ? updated : item) : [...list, updated]) } });
    phase('settings-readback');
    const actual = (await agents()).find(item => item.id === agent.id);
    phase('registration-verify');
    if (!actual) throw new Error('Registration not saved');
    const confirmed = sameRegistration(actual, agent)
      && (actual.env as Record<string, string> | undefined)?.SVAIB_KIMI_CATALOG_GENERATION === generation;
    if (confirmed) await save({ registrationGeneration: generation });
    return confirmed;
  }

  async function register(agent: KimiAgent) {
    pendingRegistrationGeneration = null;
    log('registration', 'start');
    let operation: KimiDiagnostic['operation'] = 'settings-read';
    try {
      const owned = await writeRegistration(agent, value => { operation = value; });
      log('registration', owned ? 'success' : 'skipped', owned ? {} : { reason: 'foreign-profile' });
      return save({ stage: 'verify', message: '', manualRegistration: null, verifyModel: await resolveVerifyModel(),
        canReplaceKey: owned, ...(owned ? { catalogVersion: CATALOG_VERSION, catalogCheckedAt: Date.now() } : {}) });
    } catch (error) {
      log('registration', 'failure', { reason: 'failed', operation, ...kimiErrorFields(error) });
      const manualAgent = pendingRegistrationGeneration
        ? { ...agent, env: { SVAIB_KIMI_CATALOG_GENERATION: pendingRegistrationGeneration } } : agent;
      return save({ stage: 'registration', message: 'Профиль готов. В этой версии BB добавь провайдера через настройки ACP.', manualRegistration: JSON.stringify([manualAgent], null, 2) });
    }
  }
  async function repairRequirements() {
    const runtime = await client.call('runtimePrepare', { context: { provider: PROVIDER, action: 'setup', hooks: true }, retry: true }, target());
    if (runtime.status !== 'ready') throw new Error(runtime.message);
  }
  async function start(apiKey?: string) {
    if (job || replacing) return snapshot();
    // Explicit card action shares settings/CLI repair. Setup checks hooks;
    // the profile adapter repairs its own launcher afterwards.
    try { await repairRequirements(); }
    catch (error) { return save({ stage: 'registration', phase: null, message: error instanceof Error ? error.message : 'Не удалось подготовить компьютер.' }); }
    if (isPi) return nativePi ? startNativePi(apiKey) : startPi(apiKey);
    if (await hasProvider()) {
      const status = await client.call('kimiInspect', null, target());
      const current = (await agents()).find(item => item.id === 'claude-kimi');
      if (status.needsKey && !apiKey && status.agent && ownsRegistration(current, status.agent)) return inspect();
      await save({ hidden: false, stage: 'installing', automatic: true, phase: 'access', startedAt: Date.now(), message: '' });
      const run = async () => {
        try {
          if (status.agent && ownsRegistration(current, status.agent)) {
            const manualGeneration = manualGenerationFor(status.agent);
            const manualApplied = status.profile === 'ready' && manualGeneration && (current?.env as Record<string, string> | undefined)?.SVAIB_KIMI_CATALOG_GENERATION === manualGeneration;
            // Manual registration belongs to the already prepared profile.
            // Mutating it again here would reuse its cache generation for new data.
            if (!manualApplied && view.manualRegistration) await save({ manualRegistration: null });
            if (!manualApplied) await save({ phase: 'components' });
            const upgraded = manualApplied ? status.agent : await prepareProfile(apiKey, 'recheck');
            apiKey = undefined;
            await save({ phase: 'access' });
            await register(upgraded);
          } else await save({ stage: 'verify', canReplaceKey: false, verifyModel: await resolveVerifyModel() });
          if (view.stage === 'verify') await beginAutomaticCheck();
          else await save({ phase: null });
        } catch { apiKey = undefined; await save({ stage: 'registration', phase: null, message: 'Не удалось подготовить профиль. Существующие файлы сохранены; повтори настройку или обратись к партнёру.' }); }
      };
      job = run().finally(() => { job = null; }); void job.catch(() => {});
      return snapshot();
    }
    const status = await client.call('kimiInspect', null, target());
    if (status.profile === 'blocked' || (status.profile === 'absent' || status.needsKey) && !apiKey) return inspect();
    await save({ hidden: false, stage: 'installing', message: '', manualRegistration: null, phase: 'components', startedAt: Date.now(), automatic: true });
    // The key exists only in this call's memory and host RPC, never KV, settings,
    // a terminal, a model request, command argv, or the returned view.
    const run = async () => {
      try {
        if (view.manualRegistration) await save({ manualRegistration: null });
        const agent = await prepareProfile(apiKey, 'setup');
        apiKey = undefined;
        if (!disposed) {
          await save({ canReplaceKey: true, phase: 'access' });
          await register(agent);
          if (view.stage === 'verify') await beginAutomaticCheck();
          else await save({ phase: null });
        }
      } catch {
        apiKey = undefined;
        if (!disposed) await save({ stage: 'registration', phase: null, message: 'Не удалось подготовить профиль Kimi. Существующие файлы сохранены. Нажми «Продолжить настройку»; если ошибка повторяется, попроси партнёра проверить журнал настройки.' });
      }
    };
    job = run().finally(() => { job = null; });
    void job.catch(() => {});
    return snapshot();
  }
  function launch(apiKey?: string) {
    if (starting) return starting;
    if (attempt || verificationStart) return Promise.resolve(snapshot());
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
  const currentAttempt = (candidate: Attempt) => !disposed && attempt === candidate && candidate.generation === generation && candidate.keyVersion === view.keyChangedAt;
  async function cleanupOwnedCheck(id: string, legacy = false, cleanupGeneration = generation) {
    let thread;
    try {
      thread = await bounded(checkedThread(id, false), 2000);
      if (legacy) {
        const metadata = await bounded(bb.sdk.threads.experimental_listPluginMetadata({ pluginId: bb.pluginId, threadIds: [id] }), 2000);
        if (!metadata.threads.some(row => row.threadId === id && row.metadata.kimiSetup === 1)) return;
      }
    } catch { return; }
    if ((thread.status === 'idle' || thread.status === 'error') && !attempt && !disposed && cleanupGeneration === generation) await save({ stopUnconfirmed: false });
    if (thread.status !== 'idle' && thread.status !== 'error') {
      try { await bounded(bb.sdk.threads.stop({ threadId: id }), 2000); if (!attempt && !disposed && cleanupGeneration === generation) await save({ stopUnconfirmed: false }); }
      catch (error) {
        stopWarning = 'Предыдущий проверочный запрос мог продолжиться: BB не подтвердил остановку. Следующее нажатие «Повторить» создаст один новый запрос.';
        if (!disposed && !attempt && cleanupGeneration === generation) await save({ message: stopWarning, stopUnconfirmed: true });
        log('cleanup', 'failure', { reason: 'failed', ...kimiErrorFields(error) });
      }
    }
    // Removal of history is independent from both model readiness and stop.
    try { await bounded(bb.sdk.threads.delete({ threadId: id, childThreadsConfirmed: false }), 2000); }
    catch (error) { log('cleanup', 'failure', { reason: 'failed', ...kimiErrorFields(error) }); }
  }
  async function sweepLegacy() {
    if (legacySwept) return; legacySwept = true;
    if (legacyCleanup) await cleanupOwnedCheck(legacyCleanup, true);
  }
  async function invalidateCheck() {
    generation++;
    const previous = attempt; attempt = null;
    if (verificationTimer) clearTimeout(verificationTimer);
    if (previous?.threadId) await cleanupOwnedCheck(previous.threadId);
    await save({ phase: null, testThreadId: null, ownedTestThreadId: null, checkToken: null, checkStartedAt: null });
  }
  async function failAutomaticCheck(message: string, candidate: Attempt) {
    if (!currentAttempt(candidate)) return;
    log('verification', 'failure', { reason: 'unavailable', elapsedMs: Date.now() - candidate.startedAt });
    attempt = null;
    await save({ phase: null, testThreadId: null, ownedTestThreadId: null, checkToken: null, checkStartedAt: null, message });
    if (candidate.threadId) await cleanupOwnedCheck(candidate.threadId);
  }
  function watchAutomaticCheck(candidate = attempt) {
    if (verificationTimer) clearTimeout(verificationTimer);
    if (!candidate || !currentAttempt(candidate) || !candidate.threadId) return;
    verificationTimer = setTimeout(async () => {
      if (!currentAttempt(candidate)) return;
      if (checking) { watchAutomaticCheck(candidate); return; }
      checking = true;
      try {
        await checkResponse(true);
        if (!currentAttempt(candidate)) return;
        const thread = await checkedThread(candidate.threadId!, false);
        if (!currentAttempt(candidate)) return;
        if (thread.status === 'error' || thread.status === 'idle' || Date.now() - candidate.startedAt > 240_000) {
          await failAutomaticCheck('Kimi не подтвердила проверочный ответ. Проверь ключ и доступ к модели, затем повтори проверку.', candidate); return;
        }
      } catch {
        if (currentAttempt(candidate) && Date.now() - candidate.startedAt > 240_000) {
          await failAutomaticCheck('Не удалось дождаться ответа Kimi. Проверь подключение и повтори проверку.', candidate); return;
        }
      } finally { checking = false; }
      if (currentAttempt(candidate)) watchAutomaticCheck(candidate);
    }, 1500);
    verificationTimer.unref?.();
  }
  function beginAutomaticCheck() {
    if (verificationStart) return verificationStart;
    if (attempt || disposed) return Promise.resolve();
    const run = async () => {
      const model = view.verifyModel;
      if (!model || !hostId) { await save({ phase: null, message: 'Не удалось подтвердить каталог Kimi. Повтори проверку.' }); return; }
      const candidate: Attempt = { nonce: randomUUID(), generation: ++generation, keyVersion: view.keyChangedAt, startedAt: Date.now(), model, threadId: null };
      attempt = candidate;
      await save({ phase: 'check', stage: 'verify', automatic: true, checkStartedAt: candidate.startedAt, startedAt: candidate.startedAt, checkToken: candidate.nonce, message: '', testThreadId: null, stopUnconfirmed: true });
      log('verification', 'start');
      try {
        const personal = (await bounded(bb.sdk.projects.list({ includePersonal: true }))).find(project => project.kind === 'personal');
        if (!currentAttempt(candidate)) return;
        if (!personal) throw new Error('personal-project-unavailable');
        const thread = await bounded(bb.sdk.threads.spawn({
          projectId: personal.id, providerId: PROVIDER, model, reasoningLevel: 'high', permissionMode: 'accept-edits',
          title: 'Проверка Kimi', visibility: 'hidden',
          environment: { type: 'host', hostId, workspace: { type: 'personal' } },
          input: [{ type: 'text', text: 'Ответь ровно KIMI_READY. Не используй инструменты, не читай и не меняй файлы.', mentions: [] }],
          pluginMetadata: { kimiSetup: 1, kimiCheck: candidate.nonce },
        }));
        candidate.threadId = thread.id;
        if (!currentAttempt(candidate)) { await cleanupOwnedCheck(thread.id, false, candidate.generation); return; }
        await save({ testThreadId: thread.id, ownedTestThreadId: thread.id });
        watchAutomaticCheck(candidate);
      } catch (error) {
        log('verification', 'failure', { reason: 'failed', ...kimiErrorFields(error) });
        if (!currentAttempt(candidate)) return;
        // Ambiguous spawn is never repeated. Locate only this live action's nonce.
        try {
          const rows = await bounded(bb.sdk.threads.list({ originPluginId: bb.pluginId, includeHidden: true, limit: 200 }), 2000);
          const metadata = await bounded(bb.sdk.threads.experimental_listPluginMetadata({ pluginId: bb.pluginId, threadIds: rows.map(row => row.id) }), 2000);
          const match = metadata.threads.find(row => row.metadata.kimiCheck === candidate.nonce);
          if (match) { await checkedThread(match.threadId, false); candidate.threadId = match.threadId; }
        } catch { /* The uncertainty remains visible; retry is an explicit action. */ }
        if (!currentAttempt(candidate)) return;
        if (candidate.threadId) { await save({ testThreadId: candidate.threadId, ownedTestThreadId: candidate.threadId }); watchAutomaticCheck(candidate); }
        else {
          attempt = null;
          stopWarning = 'BB не подтвердил запуск и остановку предыдущего запроса. Он мог продолжиться. Следующее нажатие «Повторить» создаст один новый запрос.';
          await save({ phase: null, testThreadId: null, ownedTestThreadId: null, message: stopWarning, stopUnconfirmed: true });
        }
      }
    };
    verificationStart = run().finally(() => { verificationStart = null; });
    return verificationStart;
  }
  async function checkResponse(quiet = false) {
    const candidate = attempt;
    const testId = candidate?.threadId;
    const current = () => !replacing && !!candidate && currentAttempt(candidate) && view.stage === 'verify';
    const pending = (message: string) => quiet || !current() ? Promise.resolve(snapshot()) : save({ message });
    if (!candidate || !testId) return pending('Начни новую проверку Kimi.');
    try {
      const thread = await checkedThread(testId);
      if (thread.status !== 'idle') return pending('Ответ ещё не получен. Проверь разговор и повтори проверку.');
      const lastPiRequest = async () => (await bounded(bb.sdk.threads.events.list({ threadId: thread.id,
        types: ['client/thread/start', 'client/turn/start', 'provider/modelFallback'], order: 'desc', limit: '1' })))[0];
      let sentIdentity: { id: string; seq: number } | null = null;
      if (isPi) {
        // Read the model that was sent, not mutable composer defaults or a
        // guessed ThreadResponse field. Pending binding may precede this event.
        const sent = await lastPiRequest();
        const request = sent && (sent.type === 'client/thread/start' || sent.type === 'client/turn/start') ? sent.data.request : null;
        const options = request?.params.options;
        const model = options && typeof options === 'object' && !Array.isArray(options) && 'model' in options ? options.model : null;
        if (model !== candidate.model) {
          return pending('Для проверки выбери указанную модель Kimi в Pi и отправь новый проверочный запрос.');
        }
        sentIdentity = { id: sent!.id, seq: sent!.seq };
        // A turn may have started between the first status and event reads.
        if ((await checkedThread(thread.id)).status !== 'idle') return pending('Ответ ещё не получен. Проверь разговор и повтори проверку.');
      }
      const { output } = await bounded(bb.sdk.threads.output({ threadId: thread.id }));
      if (sentIdentity) {
        const after = await checkedThread(thread.id);
        const latest = await lastPiRequest();
        if (after.status !== 'idle' || latest?.id !== sentIdentity.id || latest?.seq !== sentIdentity.seq) {
          return pending('Проверочный разговор изменился. Дождись ответа и повтори проверку.');
        }
      }
      if (!current()) return snapshot();
      if (output?.trim() !== 'KIMI_READY') {
        if (!quiet) log('verification', 'failure', { reason: 'wrong-response' });
        return pending('Проверочный ответ не подтверждён. Открой разговор и проверь результат.');
      }
      log('verification', 'success', { elapsedMs: Date.now() - candidate.startedAt });
      attempt = null;
      await save({ stage: 'complete', hidden: true, phase: null, testThreadId: null, ownedTestThreadId: null, checkToken: null, checkStartedAt: null, stopUnconfirmed: false, message: 'Готово к работе', manualRegistration: null });
      void cleanupOwnedCheck(testId).catch(() => {});
      return snapshot();
    } catch { return pending('Не удалось проверить ответ. Открой разговор Kimi и повтори.'); }
  }
  bb.events.on('thread.idle', async ({ thread }) => {
    if (!disposed && !view.hidden && view.stage === 'verify' && thread.id === view.testThreadId) await checkResponse();
  });
  const handlers = {
    kimiStatus: async () => snapshot(),
    kimiOpen: async () => {
      if (view.stage === 'complete') return snapshot();
      await save({ hidden: false });
      if (occupied() || attempt) return snapshot();
      try { return await inspect(); }
      catch (error) { return save({ stage: 'blocked', phase: null, message: isPi ? piFailure(error) : 'Не удалось связаться с компьютером BB. Проверь подключение и повтори.' }); }
    },
    kimiStart: ({ apiKey }: { apiKey?: string }) => launch(apiKey),
    kimiDismiss: async ({ reason }: { reason: 'declined' | 'other-agent' }) => {
      if (occupied()) throw new Error('Дождись завершения текущего шага.');
      if (attempt) await invalidateCheck();
      return save({ hidden: true, message: reason === 'other-agent' ? 'Выбран другой агент.' : '' });
    },
    // Legacy frontend bindings cannot attach an old conversation to a new action.
    kimiTestStarted: async (_input: { threadId: string }) => { throw new Error('Начни новую проверку кнопкой «Повторить».'); },
    kimiCheckResponse: () => checkResponse(),
    kimiRecheck: () => {
      if (starting || job || replacing || attempt || verificationStart) return Promise.resolve(snapshot());
      const run = async () => {
        const alreadyWarned = view.stopUnconfirmed;
        await sweepLegacy();
        if (!alreadyWarned && view.stopUnconfirmed) return snapshot();
        await invalidateCheck();
        stopWarning = '';
        await save({ hidden: false, stage: 'intro', message: '', phase: null, automatic: true, stopUnconfirmed: false });
        return start();
      };
      starting = run().finally(() => { starting = null; }); return starting;
    },
    kimiReplaceKey: async ({ apiKey }: { apiKey: string }) => {
      if (isPi) return nativePi ? replaceNativePiKey(apiKey) : replacePiKey(apiKey);
      if (!view.canReplaceKey || occupied()) throw new Error('Этот профиль не принадлежит настройщику.');
      replacing = true;
      try {
        await repairRequirements();
        const status = await client.call('kimiInspect', null, target());
        const current = (await agents()).find(item => item.id === 'claude-kimi');
        if (!status.agent || !ownsRegistration(current, status.agent)) throw new Error('Регистрация Kimi изменилась. Существующее подключение сохранено.');
        // The installing interlude keeps checkResponse off: a late reply of the
        // old key must not complete setup while the key is being replaced.
        await invalidateCheck();
        // An RPC failure cannot prove whether the host committed the new key.
        // Invalidate the old manual binding before crossing that boundary.
        await save({ hidden: false, stage: 'installing', phase: 'access', startedAt: Date.now(),
          keyChangedAt: Date.now(), testThreadId: null, verifyModel: null, message: '' });
        await hostMutation('key-replace', 'key-change', diagnosticId => client.call('kimiReplaceKey', { apiKey, diagnosticId }, target()));
        if (!await writeRegistration(status.agent)) throw new Error('Registration changed');
        const keyChangedAt = Date.now();
        await save({ stage: 'verify', phase: null, hidden: false, testThreadId: null, ownedTestThreadId: null, keyChangedAt, catalogCheckedAt: Date.now(), verifyModel: await resolveVerifyModel(), message: view.automatic ? '' : 'Ключ обновлён. Отправь новый проверочный запрос.' });
        if (view.automatic) { await save({ startedAt: Date.now() }); await beginAutomaticCheck(); }
        return snapshot();
      } catch (error) {
        if (view.stage === 'installing') await save({ stage: 'verify', phase: null, message: 'Не удалось подтвердить замену ключа. Проверь подключение к BB и повтори.' });
        throw error;
      } finally { replacing = false; }
    },
  };
  async function refreshCatalog(reason: 'scheduled' | 'startup' = 'scheduled') {
    if (isPi || disposed || occupied() || attempt || !hostId || !view.canReplaceKey
      || view.catalogCheckedAt !== null && Date.now() - view.catalogCheckedAt < CATALOG_TTL) return;
    job = kimiStep(log, 'refresh', async () => {
      const status = await client.call('kimiInspect', null, target());
      if (status.profile !== 'ready' || !status.agent || !ownsRegistration((await agents()).find(item => item.id === 'claude-kimi'), status.agent)) return;
      const agent = await hostMutation('prepare', reason, diagnosticId => client.call('kimiRefreshCatalog', { diagnosticId }, target()));
      if (!await writeRegistration(agent)) return;
      // A failed BB discovery must remain due for retry, even if host settings succeeded.
      if (!await resolveVerifyModel()) throw new Error('Kimi catalog discovery failed');
      await save({ catalogVersion: CATALOG_VERSION, catalogCheckedAt: Date.now() });
    }).finally(() => { job = null; });
    await job;
  }
  // Hourly inexpensive TTL check; at most one catalog request per day. On a
  // restart after downtime, refresh immediately once the host entry is available.
  if (!isPi) bb.background.schedule('kimi-catalog-refresh', '0 * * * *', () => refreshCatalog('scheduled'));
  if (!isPi) bb.background.service('kimi-catalog-refresh', {
    async start(signal) {
      try { if (!signal.aborted) await refreshCatalog('startup'); }
      catch { bb.log.warn('Не удалось обновить каталог Kimi. Повторим проверку по расписанию.'); }
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  });
  return { handlers, runtime: () => client.call('kimiPiInspect', null, target()),
    nativeRuntime: async () => { await pi.nativePreflight(); return client.call('kimiPiNativeInspect', null, target()); },
    busy: () => occupied() || !!attempt, settled: async () => { await starting; await job; await verificationStart; } };
}

/** One card, independent profiles and ephemeral checks. Existing state stays CC. */
export async function registerKimiSetup(bb: BbPluginApi, hostId: string | null) {
  const write = (event: KimiDiagnostic) => {
    try { const line = '[kimi] ' + JSON.stringify(event); if (event.outcome === 'failure' || event.outcome === 'fallback') bb.log.warn(line); else bb.log.info(line); } catch { /* Diagnostics cannot fail setup. */ }
  };
  const diagnostics = { write, routes: new Map<string, (event: KimiDiagnostic) => void>() };
  const signalClient = bb.hosts.experimental_client({ contract: browserContract, experimental_signals: kimiDiagnosticSignals });
  bb.onDispose(signalClient.experimental_onSignal('kimiDiagnostic', event => {
    if (event.hostId !== hostId) return;
    write(event.payload); diagnostics.routes.get(event.payload.diagnosticId)?.(event.payload);
  }));
  const pi = await createKimiPiSupport(bb, hostId);
  const selectionKey = 'kimi-harness:v1:' + (hostId ?? 'unavailable');
  const modeKey = 'kimi-pi-mode:v1:' + (hostId ?? 'unavailable');
  const savedMode = await bb.storage.kv.get(modeKey);
  // Preserve an earlier explicitly configured isolated installation.
  let piMode: 'native' | 'managed' = savedMode === 'managed' || savedMode == null && pi.owned() ? 'managed' : 'native';
  let selected = await bb.storage.kv.get(selectionKey) === 'pi' ? 'pi' : 'claude-code';
  const cc = await createKimiSetup(bb, hostId, 'claude-code', pi, diagnostics);
  const nativePi = await createKimiSetup(bb, hostId, 'pi', pi, diagnostics, 'native');
  const managedPi = await createKimiSetup(bb, hostId, 'pi', pi, diagnostics, 'managed');
  const current = () => selected === 'pi' ? piMode === 'managed' ? managedPi : nativePi : cc;
  let selecting: Promise<KimiView> | null = null;
  const busy = () => cc.busy() || nativePi.busy() || managedPi.busy();
  const ready = async () => { if (selecting) await selecting; return current().handlers; };
  bb.rpc.register(kimiRpcContract, {
    kimiPiRuntime: async () => await pi.managedActive()
      ? { ...await managedPi.runtime(), mode: 'managed' as const, hostId }
      : { ...await nativePi.nativeRuntime(), mode: 'native' as const, hostId },
    kimiSelectHarness: ({ harness }) => {
      if (selecting) return selecting;
      if (busy()) throw new Error('Дождись завершения текущего шага.');
      selecting = (async () => {
        await bb.storage.kv.set(selectionKey, harness); selected = harness;
        bb.realtime.publish('kimi-setup-changed', null);
        return current().handlers.kimiOpen();
      })().finally(() => { selecting = null; });
      return selecting;
    },
    kimiSelectPiMode: ({ mode }) => {
      if (selecting) return selecting;
      if (busy()) throw new Error('Дождись завершения текущего шага.');
      selecting = (async () => {
        await bb.storage.kv.set(modeKey, mode); piMode = mode;
        await bb.storage.kv.set(selectionKey, 'pi'); selected = 'pi';
        bb.realtime.publish('kimi-setup-changed', null);
        return current().handlers.kimiOpen();
      })().finally(() => { selecting = null; });
      return selecting;
    },
    kimiStatus: async () => (await ready()).kimiStatus(),
    kimiOpen: async () => (await ready()).kimiOpen(),
    kimiStart: async input => (await ready()).kimiStart(input),
    kimiDismiss: async input => (await ready()).kimiDismiss(input),
    kimiTestStarted: async input => (await ready()).kimiTestStarted(input),
    kimiCheckResponse: async () => (await ready()).kimiCheckResponse(),
    kimiRecheck: async () => (await ready()).kimiRecheck(),
    kimiReplaceKey: async input => (await ready()).kimiReplaceKey(input),
  });
  return { settled: async () => { await selecting; await cc.settled(); await nativePi.settled(); await managedPi.settled(); } };
}
