import { useCallback, useEffect, useState } from 'react';
import { useRpc, useRealtime, useSdk, useBbNavigate, UrlLink, experimental_NewThreadComposer as NewThreadComposer } from '@get-bb/plugin-sdk/app';
import type { kimiRpcContract, KimiView } from './kimi-contract';
import './kimi-setup.css';

export function KimiSetup({ settings = false }: { settings?: boolean }) {
  const rpc = useRpc<typeof kimiRpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [view, setView] = useState<KimiView | null>(null);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const [error, setError] = useState('');
  const accept = (next: KimiView) => setView(previous => !previous || next.revision >= previous.revision ? next : previous);
  const refresh = useCallback(async () => {
    try { const next = await rpc.call('kimiStatus', null); setView(previous => !previous || next.revision >= previous.revision ? next : previous); }
    catch { /* A disconnected plugin must not block the cabinet. */ }
  }, [rpc]);
  useEffect(() => { void refresh(); }, [refresh]);
  useRealtime('kimi-setup-changed', refresh);
  useEffect(() => {
    if (view?.stage !== 'installing') return;
    const timer = setInterval(() => { void refresh(); }, 1500);
    return () => clearInterval(timer);
  }, [view?.stage, refresh]);
  async function act(action: () => Promise<KimiView>) {
    setBusy(true); setError('');
    try { accept(await action()); return true; }
    catch { setError('Не удалось выполнить этот шаг. Проверь подключение к BB и повтори.'); return false; }
    finally { setBusy(false); }
  }
  if (settings && !opened) return <div className="svb-kimi-settings"><button className="svb-text-button" onClick={() => {
    setOpened(true); void act(() => rpc.call('kimiOpen', null));
  }}>Настроить или проверить Kimi</button></div>;
  if (!view) return settings ? <div className="svb-kimi-settings" role="status"><p>{error || 'Проверяю настройку Kimi…'}</p><button onClick={() => { void act(() => rpc.call('kimiOpen', null)); }}>Повторить</button></div> : null;
  if (!settings && view.hidden) return null;
  const pending = busy || view.stage === 'installing';
  const dismiss = (reason: 'declined' | 'other-agent') => {
    setKey(''); void act(() => rpc.call('kimiDismiss', { reason })).then(ok => { if (ok && settings) setOpened(false); });
  };
  const open = () => { void act(() => rpc.call('kimiOpen', null)); };
  return <section className="svb svb-kimi" aria-label="Настройка Kimi" aria-busy={pending}>
    <div className="svb-kimi-heading"><div><span className="svb-kicker">Доступ к модели</span><h2>{view.stage === 'complete' ? 'Kimi отвечает' : 'Kimi через Claude Code'}</h2></div>
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
      <p>Нужна подписка Kimi Code и ключ из её консоли. Плагин подготовит отдельный профиль и добавит Kimi в BB.</p>
      <UrlLink href="https://www.kimi.com/code/console" className="svb-kimi-link">Открыть консоль Kimi Code</UrlLink>
      <label>Ключ Kimi Code<input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} placeholder="sk-kimi-…" required pattern="sk-kimi-[A-Za-z0-9_-]+" disabled={pending} /></label>
      <p className="svb-kimi-note">Ключ сохраняется в закрытом файле профиля на этом компьютере. В разговор и настройки провайдера он не попадёт.</p>
      <button className="svb-primary-button" disabled={pending || !key.trim()}>Подготовить подключение</button>
    </form>}
    {view.stage === 'installing' && <p role="status">Готовлю профиль и устанавливаю компоненты. Можно уйти с этой страницы и вернуться — текущий шаг сохранится.</p>}
    {view.stage === 'registration' && <>
      {view.manualRegistration ? <>
        <p>Открой Settings → Plugins → ACP providers → Custom agents. Если список пуст, вставь массив ниже. Если записи уже есть, добавь объект Kimi в существующий массив, сохранив остальные записи.</p>
        <details><summary>Данные для добавления провайдера</summary><textarea aria-label="Регистрация Kimi без ключа" readOnly value={view.manualRegistration} rows={8} /></details>
        <button className="svb-primary-button" disabled={pending} onClick={open}>Провайдер добавлен — проверить</button>
      </> : <button className="svb-primary-button" disabled={pending} onClick={() => { void act(() => rpc.call('kimiStart', {})); }}>Продолжить настройку</button>}
    </>}
    {view.stage === 'verify' && <>
      <p>Отправь короткий запрос через Kimi. Проверка подтвердит ответ модели; подключение svaib продолжится отдельно.</p>
      {view.testThreadId ? <div className="svb-kimi-actions">
        <button className="svb-text-button" onClick={() => navigate.toThread(view.testThreadId!)}>Открыть проверочный разговор</button>
        <button className="svb-primary-button" disabled={pending} onClick={() => { void act(() => rpc.call('kimiCheckResponse', null)); }}>Проверить ответ</button>
      </div> : <NewThreadComposer defaultProviderId="acp-claude-kimi" defaultModel="k3.1-pro[1m]" defaultPermissionMode="accept-edits"
        defaultEnvironment={{ type: 'host', hostId: view.hostId, workspace: { type: 'unmanaged', path: null } }}
        initialPrompt="Ответь ровно KIMI_READY. Не используй инструменты, не читай и не меняй файлы."
        draftKey={`svaib-kimi-check/${view.hostId}`} layout="document" onSubmit={async request => {
          if (request.providerId !== 'acp-claude-kimi') throw new Error('Для этой проверки выбери Kimi (CC). Другого агента можно сохранить кнопкой ниже.');
          const environment = request.environment;
          const host = environment.type === 'host' ? environment.hostId : environment.type === 'reuse'
            ? (await sdk.environments.get({ environmentId: environment.environmentId })).hostId : null;
          if (host !== view.hostId) throw new Error('Выбери компьютер, на котором только что настроен Kimi.');
          const result = await sdk.threads.spawn({ ...request, title: 'Проверка Kimi', pluginMetadata: { kimiSetup: 1 } });
          if (!await act(() => rpc.call('kimiTestStarted', { threadId: result.id }))) throw new Error('Разговор создан, но его проверка не сохранилась. Не отправляй запрос повторно; открой «Проверка Kimi» в списке разговоров.');
          navigate.toThread(result.id);
        }} />}
      {view.canReplaceKey && !editingKey && <button className="svb-text-button" onClick={() => setEditingKey(true)}>Исправить ключ</button>}
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
