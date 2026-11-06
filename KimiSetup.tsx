import { useCallback, useEffect, useRef, useState } from 'react';
import { useRpc, useRealtime, useRealtimeConnectionState, useSdk, useBbNavigate, UrlLink, experimental_NewThreadComposer as NewThreadComposer } from '@get-bb/plugin-sdk/app';
import type { kimiRpcContract, KimiView } from './kimi-contract';
import './kimi-setup.css';

type PendingBinding = { threadId: string; keyChangedAt: number | null };
// No prompt or key is stored here. Keep the created ID across navigation/reload,
// even when the RPC that would save it on the server is unavailable.
const pendingBindings = new Map<string, PendingBinding>();
const bindingKey = (hostId: string) => `svaib-kimi-binding/${hostId}`;
function rememberBinding(hostId: string, binding: PendingBinding | null) {
  if (binding) pendingBindings.set(hostId, binding); else pendingBindings.delete(hostId);
  try {
    if (binding) window.localStorage.setItem(bindingKey(hostId), JSON.stringify(binding));
    else window.localStorage.removeItem(bindingKey(hostId));
  } catch { /* In-memory recovery still survives component remounts. */ }
}
function restoreBinding(view: KimiView): PendingBinding | null {
  let binding = pendingBindings.get(view.hostId) ?? null;
  try {
    const stored = JSON.parse(window.localStorage.getItem(bindingKey(view.hostId)) ?? 'null');
    binding = stored && typeof stored.threadId === 'string' && (stored.keyChangedAt === null || typeof stored.keyChangedAt === 'number') ? stored : null;
  } catch { /* Storage can be unavailable in restricted browsers. */ }
  if (binding && (binding.keyChangedAt !== view.keyChangedAt || view.testThreadId || view.stage === 'complete')) {
    rememberBinding(view.hostId, null); return null;
  }
  return binding;
}

export function KimiSetup({ settings = false }: { settings?: boolean }) {
  const rpc = useRpc<typeof kimiRpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [view, setView] = useState<KimiView | null>(null);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const [binding, setBinding] = useState<PendingBinding | null>(null);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [finishedHere, setFinishedHere] = useState(false);
  const [now, setNow] = useState(Date.now());
  const activeHere = useRef(false);
  const refreshing = useRef(false);
  const connection = useRealtimeConnectionState();
  const revision = useRef(-1);
  const accept = useCallback((next: KimiView) => {
    if (next.revision < revision.current) return;
    revision.current = next.revision;
    if (next.phase) activeHere.current = true;
    if (next.stage === 'complete' && activeHere.current) setFinishedHere(true);
    setBinding(restoreBinding(next));
    setView(next);
  }, []);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try { accept(await rpc.call('kimiStatus', null)); setConnectionError(''); }
    catch { setConnectionError('Связь с BB потеряна. Восстанавливаю статус настройки…'); }
    finally { refreshing.current = false; }
  }, [rpc, accept]);
  useEffect(() => { void refresh(); }, [refresh, connection]);
  useEffect(() => {
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [refresh]);
  useRealtime('kimi-setup-changed', refresh);
  useEffect(() => {
    if (!view?.phase && view?.stage !== 'installing') return;
    const timer = setInterval(() => { setNow(Date.now()); void refresh(); }, 1500);
    return () => clearInterval(timer);
  }, [view?.stage, view?.phase, refresh]);
  async function act(action: () => Promise<KimiView>) {
    setBusy(true); setError('');
    try { accept(await action()); return true; }
    catch { setError('Не удалось выполнить этот шаг. Проверь подключение к BB и повтори.'); return false; }
    finally { setBusy(false); }
  }
  const openThread = (threadId: string) => {
    try { navigate.toThread(threadId); }
    catch { setError('Разговор создан. Открой «Проверка Kimi» в списке разговоров.'); }
  };
  const retryBinding = async () => {
    const threadId = binding?.threadId;
    if (!threadId || busy) return;
    setBusy(true); setError('');
    try { accept(await rpc.call('kimiTestStarted', { threadId })); }
    catch { setError('Всё ещё не удалось сохранить проверку. Проверь подключение к BB и повтори ещё раз.'); return; }
    finally { setBusy(false); }
    openThread(threadId);
  };
  if (settings && !opened) return <div className="svb-kimi-settings"><button className="svb-text-button" onClick={() => {
    setOpened(true); void act(() => rpc.call('kimiOpen', null));
  }}>Настроить или проверить Kimi</button></div>;
  if (!view) return settings ? <div className="svb-kimi-settings" role="status"><p>{error || 'Проверяю настройку Kimi…'}</p><button onClick={() => { void act(() => rpc.call('kimiOpen', null)); }}>Повторить</button></div> : null;
  if (!settings && view.hidden && !finishedHere) return null;
  const pending = busy || !!view.phase || view.stage === 'installing';
  const elapsed = Math.max(0, Math.floor((now - (view.startedAt ?? now)) / 1000));
  const phaseLabels = ['Устанавливаю компоненты', 'Настраиваю доступ', 'Проверяю ответ Kimi', 'Готово к работе'];
  const phaseIndex = view.stage === 'complete' ? 3 : ['components', 'access', 'check'].indexOf(view.phase ?? '');
  const dismiss = (reason: 'declined' | 'other-agent') => {
    setKey(''); void act(() => rpc.call('kimiDismiss', { reason })).then(ok => { if (ok && settings) setOpened(false); });
  };
  const open = () => { void act(() => rpc.call('kimiOpen', null)); };
  return <section className="svb svb-kimi" aria-label="Настройка Kimi" aria-busy={pending}>
    <div className="svb-kimi-heading"><div><span className="svb-kicker">Доступ к модели</span><h2>{view.stage === 'complete' ? (view.automatic ? 'Готово к работе' : 'Kimi отвечает') : 'Kimi через Claude Code'}</h2></div>
      {settings && <button className="svb-text-button" disabled={pending} onClick={() => {
        setKey(''); void act(() => rpc.call('kimiDismiss', { reason: 'declined' })).then(ok => { if (ok) setOpened(false); });
      }}>Закрыть</button>}
    </div>
    {view.stage === 'intro' && <>
      <p>Подключи Kimi к BB. Работающий агент для настройки не нужен. Если уже пользуешься другим агентом, можно продолжить с ним.</p>
      <button className="svb-primary-button" disabled={pending} onClick={open}>Настроить Kimi</button>
    </>}
    {view.stage === 'node' && <>
      <p>Для запуска Kimi нужен Node.js 22 или новее на компьютере, где работает BB. Установи его с npm, затем вернись сюда.</p>
      <UrlLink href="https://nodejs.org/en/download" className="svb-kimi-link">Скачать Node.js</UrlLink>
      <button className="svb-primary-button" disabled={pending} onClick={open}>Проверить установку</button>
    </>}
    {view.stage === 'key' && <form onSubmit={event => {
      event.preventDefault(); const apiKey = key.trim(); setKey(''); void act(() => rpc.call('kimiStart', { apiKey }));
    }}>
      <p>Открой консоль Kimi Code, нажми «Создать API-ключ» и вставь его сюда. Нужна подписка Kimi Code. Дальше плагин всё настроит и проверит сам.</p>
      <UrlLink href="https://www.kimi.com/code/console" className="svb-kimi-link">Открыть консоль Kimi Code</UrlLink>
      <label>Ключ Kimi Code<input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} placeholder="sk-kimi-…" required pattern="sk-kimi-[A-Za-z0-9_-]+" disabled={pending} /></label>
      <p className="svb-kimi-note">Ключ сохраняется в закрытом файле профиля на этом компьютере. В разговор и настройки провайдера он не попадёт.</p>
      <button className="svb-primary-button" disabled={pending || !key.trim()}>Продолжить</button>
    </form>}
    {(view.phase || view.stage === 'complete' && view.automatic) && <div className="svb-kimi-progress" role="status" aria-live="polite">
      <ol>{phaseLabels.map((label, index) => <li key={label} aria-current={index === phaseIndex ? 'step' : undefined} className={index < phaseIndex ? 'done' : ''}>
        <span aria-hidden="true" className={index === phaseIndex && view.phase ? 'svb-kimi-spinner' : ''}>{index < phaseIndex ? '✓' : index + 1}</span>{label}
      </li>)}</ol>
      {view.phase && <p>Подожди здесь — статус обновится автоматически. Прошло {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}.</p>}
      {(connectionError || connection !== 'connected') && <p className="svb-kimi-note">{connectionError || 'Восстанавливаю связь с BB… Статус обновится после подключения.'}</p>}
    </div>}
    {view.stage === 'installing' && !view.phase && <p role="status">Готовлю профиль и устанавливаю компоненты…</p>}
    {view.stage === 'registration' && <>
      {view.manualRegistration ? <>
        <p>Открой Settings → Plugins → ACP providers → Custom agents. Если список пуст, вставь массив ниже. Если записи уже есть, добавь объект Kimi в существующий массив, сохранив остальные записи.</p>
        <details><summary>Данные для добавления провайдера</summary><textarea aria-label="Регистрация Kimi без ключа" readOnly value={view.manualRegistration} rows={8} /></details>
        <button className="svb-primary-button" disabled={pending} onClick={open}>Провайдер добавлен — проверить</button>
      </> : <><button className="svb-primary-button" disabled={pending} onClick={() => { void act(() => rpc.call('kimiStart', {})); }}>Продолжить настройку</button><details><summary>Если компоненты не удаётся скачать</summary><p>Проверь интернет. Если автоматическая подготовка Node.js не работает на этом компьютере, установи Node.js 22+ с npm и повтори настройку.</p><UrlLink href="https://nodejs.org/en/download" className="svb-kimi-link">Скачать Node.js</UrlLink></details></>}
    </>}
    {view.stage === 'verify' && <>
      {view.automatic ? <>{!view.phase && <button className="svb-primary-button" disabled={pending} onClick={() => { void act(() => rpc.call('kimiRecheck', null)); }}>Повторить проверку</button>}</> : <>
      <p>Отправь короткий запрос через Kimi. Проверка запустится на компьютере, где настроен Kimi.</p>
      {view.testThreadId ? <div className="svb-kimi-actions">
          <button className="svb-text-button" onClick={() => openThread(view.testThreadId!)}>Открыть проверочный разговор</button>
          <button className="svb-primary-button" disabled={pending} onClick={() => { void act(() => rpc.call('kimiCheckResponse', null)); }}>Проверить ответ</button>
          <button className="svb-text-button" disabled={pending} onClick={() => { void act(() => rpc.call('kimiRecheck', null)); }}>Начать новую проверку</button>
        </div>
      : binding ? <div className="svb-kimi-actions" role="status">
          <p className="svb-kimi-note">Разговор «Проверка Kimi» создан, но проверка не сохранилась. Не отправляй запрос повторно.</p>
          <button className="svb-text-button" onClick={() => openThread(binding.threadId)}>Открыть проверочный разговор</button>
          <button className="svb-primary-button" disabled={pending} onClick={retryBinding}>Повторить сохранение</button>
        </div>
      : view.verifyModel ? <NewThreadComposer defaultProviderId="acp-claude-kimi" defaultModel={view.verifyModel} defaultPermissionMode="accept-edits"
        defaultEnvironment={{ type: 'host', hostId: view.hostId, workspace: { type: 'unmanaged', path: null } }}
        initialPrompt="Ответь ровно KIMI_READY. Не используй инструменты, не читай и не меняй файлы."
        draftKey={`svaib-kimi-check/${view.hostId}`} layout="document" onSubmit={async request => {
          // BB swallows errors thrown out of onSubmit, so every failure is also
          // written to the visible status line before it is rethrown.
          if (submitting.current || restoreBinding(view)) return;
          submitting.current = true; setBusy(true); setError('');
          let failure = 'Не удалось создать проверочный разговор. Проверь подключение к BB и повтори отправку.';
          try {
            let result;
            try {
              if (request.providerId !== 'acp-claude-kimi') { failure = 'Для этой проверки выбери Kimi (CC). Другого агента можно сохранить кнопкой ниже.'; throw new Error('wrong-provider'); }
              if (!view.hostId) { failure = 'Компьютер настройки недоступен. Повтори проверку подключения к BB.'; throw new Error('missing-host'); }
              // This is a check of the configured Kimi profile, so its host is
              // fixed even when the shared composer restores a project default.
              result = await sdk.threads.spawn({ ...request,
                environment: { type: 'host', hostId: view.hostId, workspace: { type: 'unmanaged', path: null } },
                title: 'Проверка Kimi', pluginMetadata: { kimiSetup: 1 } });
            } catch (error) { setError(failure); throw error; }
            const pendingBinding = { threadId: result.id, keyChangedAt: view.keyChangedAt };
            rememberBinding(view.hostId, pendingBinding); setBinding(pendingBinding);
            try { accept(await rpc.call('kimiTestStarted', { threadId: result.id })); }
            catch { return; }
            openThread(result.id);
          } finally { submitting.current = false; setBusy(false); }
        }} />
      : <div className="svb-kimi-actions" role="status">
          <p className="svb-kimi-note">Не удалось получить модели Kimi. Проверь, что компьютер BB подключён.</p>
          <button className="svb-primary-button" disabled={pending} onClick={open}>Повторить проверку</button>
        </div>}
      </>}
      {view.canReplaceKey && !editingKey && <button className="svb-text-button" disabled={pending} onClick={() => setEditingKey(true)}>Исправить ключ</button>}
      {view.canReplaceKey && editingKey && <form onSubmit={event => {
        event.preventDefault(); const apiKey = key.trim(); setKey('');
        void act(() => rpc.call('kimiReplaceKey', { apiKey })).then(ok => { if (ok) setEditingKey(false); });
      }}><label>Новый ключ Kimi Code<input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} required pattern="sk-kimi-[A-Za-z0-9_-]+" /></label><button className="svb-primary-button" disabled={pending || !key.trim()}>Сохранить новый ключ</button></form>}
    </>}
    {view.stage === 'blocked' && <button className="svb-text-button" disabled={pending} onClick={open}>Повторить проверку</button>}
    {view.stage === 'complete' && <><p>Ответ модели проверен. Можно продолжать работу с партнёром svaib.</p>
      <button className="svb-text-button" disabled={pending} onClick={() => { void act(() => rpc.call('kimiRecheck', null)); }}>Проверить ещё раз</button></>}
    {(view.message || error) && <p role="status" className="svb-kimi-note">{error || view.message}</p>}
    {view.stage !== 'complete' && <div className="svb-kimi-footer">
      <button className="svb-text-button" disabled={pending} onClick={() => dismiss('other-agent')}>У меня уже есть другой агент</button>
      <button className="svb-text-button" disabled={pending} onClick={() => dismiss('declined')}>Не сейчас</button>
    </div>}
  </section>;
}
