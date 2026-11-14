import { useCallback, useEffect, useRef, useState } from 'react';
import { useRpc, useRealtime, useRealtimeConnectionState, UrlLink } from '@get-bb/plugin-sdk/app';
import type { kimiRpcContract, KimiView } from './kimi-contract';
import './kimi-setup.css';

export function KimiSetup({ settings = false }: { settings?: boolean }) {
  const rpc = useRpc<typeof kimiRpcContract>();
  const [view, setView] = useState<KimiView | null>(null);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [finishedHere, setFinishedHere] = useState(false);
  const [now, setNow] = useState(Date.now());
  const activeHere = useRef(false);
  const refreshing = useRef(false);
  const connection = useRealtimeConnectionState();
  const revision = useRef(-1);
  const revisionHarness = useRef('claude-code');
  const selectionEpoch = useRef(0);
  const accept = useCallback((next: KimiView) => {
    const harness = next.harness === 'pi' ? `pi/${next.piMode ?? 'native'}` : 'claude-code';
    if (harness === revisionHarness.current && next.revision < revision.current) return;
    revisionHarness.current = harness;
    revision.current = next.revision;
    if (next.phase) activeHere.current = true;
    if (next.stage === 'complete' && activeHere.current) setFinishedHere(true);
    setView(next);
  }, []);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    const epoch = selectionEpoch.current;
    try { const next = await rpc.call('kimiStatus', null); if (epoch === selectionEpoch.current) accept(next); setConnectionError(''); }
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
    const epoch = selectionEpoch.current;
    try { const next = await action(); if (epoch === selectionEpoch.current) accept(next); return true; }
    catch { setError('Не удалось выполнить этот шаг. Проверь подключение к BB и повтори.'); return false; }
    finally { setBusy(false); }
  }
  if (settings && !opened) return <div className="svb-kimi-settings"><button className="svb-text-button" onClick={() => {
    setOpened(true); void act(() => rpc.call('kimiOpen', null));
  }}>Настроить или проверить Kimi</button></div>;
  if (!view) return settings ? <div className="svb-kimi-settings" role="status"><p>{error || 'Проверяю настройку Kimi…'}</p><button onClick={() => { void act(() => rpc.call('kimiOpen', null)); }}>Повторить</button></div> : null;
  if (!settings && view.hidden && !finishedHere) return null;
  const isPi = view.harness === 'pi';
  const isManagedPi = isPi && view.piMode === 'managed';
  const pending = busy || !!view.phase || view.stage === 'installing';
  const elapsed = Math.max(0, Math.floor((now - (view.startedAt ?? now)) / 1000));
  const phaseLabels = ['Устанавливаю компоненты', 'Настраиваю доступ', 'Проверяю ответ Kimi', 'Готово к работе'];
  const phaseIndex = view.stage === 'complete' ? 3 : ['components', 'access', 'check'].indexOf(view.phase ?? '');
  const progress = view.installProgress;
  const progressLabel = progress?.step === 'runtime-install'
    ? progress.runtimeKind === 'portable' ? 'Общий Node.js недоступен. Проверяю резервный способ установки…' : 'Устанавливаю общий Node.js LTS. Подтверди системный запрос Windows, если он появится…'
    : progress?.step === 'runtime-download'
    ? progress.artifact === 'node-checksums' ? 'Получаю контрольные суммы переносимого Node.js…' : 'Скачиваю переносимый Node.js для резервной установки…'
    : progress?.step === 'adapter-install' ? `Скачиваю и устанавливаю ${isPi ? 'Pi' : 'Claude Code'}. На медленном соединении это может занять до 15 минут…`
    : progress?.step === 'runtime-probe' ? progress.component === 'pi' ? 'Проверяю запуск Pi…' : progress.component === 'claude-code' ? 'Проверяю запуск Claude Code…'
      : progress.component === 'adapter' ? 'Проверяю адаптер Kimi…' : 'Проверяю запуск Node.js…' : null;
  const dismiss = (reason: 'declined' | 'other-agent') => {
    setKey(''); void act(() => rpc.call('kimiDismiss', { reason })).then(ok => { if (ok && settings) setOpened(false); });
  };
  const open = () => { void act(() => rpc.call('kimiOpen', null)); };
  return <section className="svb svb-kimi" aria-label="Настройка Kimi" aria-busy={pending}>
    <div className="svb-kimi-heading"><div><span className="svb-kicker">Доступ к модели</span><h2>{view.stage === 'complete' ? (view.automatic ? 'Готово к работе' : 'Kimi отвечает') : isPi ? 'Kimi через Pi' : 'Kimi через Claude Code'}</h2></div>
      {settings && <button className="svb-text-button" disabled={pending} onClick={() => {
        setKey(''); void act(() => rpc.call('kimiDismiss', { reason: 'declined' })).then(ok => { if (ok) setOpened(false); });
      }}>Закрыть</button>}
    </div>
    {(settings || view.stage !== 'complete') && <label>Среда для Kimi<select aria-label="Среда для Kimi" value={view.harness ?? 'claude-code'} disabled={pending} onChange={event => {
      const harness = event.target.value === 'pi' ? 'pi' : 'claude-code';
      selectionEpoch.current++;
      setKey(''); setEditingKey(false); setFinishedHere(false); activeHere.current = false;
      void act(() => rpc.call('kimiSelectHarness', { harness }));
    }}><option value="claude-code">Claude Code</option><option value="pi">Pi</option></select></label>}
    {isManagedPi && <p className="svb-kimi-note">Резервная изолированная установка: отдельные Node и Pi, один компьютер исполнения и полный перезапуск BB. <button className="svb-text-button" disabled={pending} onClick={() => { selectionEpoch.current++; setKey(''); void act(() => rpc.call('kimiSelectPiMode', { mode: 'native' })); }}>Использовать штатный Pi</button></p>}
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
      <p>Открой консоль Kimi Code, нажми «Создать API-ключ» и вставь его сюда. Нужна подписка Kimi Code. {isManagedPi ? 'Резервная установка подготовит отдельный Pi и попросит перезапустить BB.' : isPi ? 'Карточка добавит Kimi в штатный Pi и проверит ответ.' : 'Дальше плагин всё настроит и проверит сам.'}</p>
      <UrlLink href="https://www.kimi.ai/code/console" className="svb-kimi-link">Открыть консоль Kimi Code</UrlLink>
      <label>Ключ Kimi Code<input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} placeholder="sk-kimi-…" required pattern="sk-kimi-[A-Za-z0-9_-]+" disabled={pending} /></label>
      <p className="svb-kimi-note">Ключ сохраняется в закрытом файле профиля на этом компьютере. В разговор и настройки провайдера он не попадёт.</p>
      <button className="svb-primary-button" disabled={pending || !key.trim()}>Продолжить</button>
    </form>}
    {(view.phase || view.stage === 'complete' && view.automatic) && <div className="svb-kimi-progress" role="status" aria-live="polite">
      <ol>{phaseLabels.map((label, index) => <li key={label} aria-current={index === phaseIndex ? 'step' : undefined} className={index < phaseIndex ? 'done' : ''}>
        <span aria-hidden="true" className={index === phaseIndex && view.phase ? 'svb-kimi-spinner' : ''}>{index < phaseIndex ? '✓' : index + 1}</span>{label}
      </li>)}</ol>
      {view.phase === 'components' && progressLabel && <p>{progressLabel}
        {progress?.downloadBytes !== undefined && <> Получено {(progress.downloadBytes / 1048576).toFixed(1)} МБ{progress.totalBytes ? ` из ${(progress.totalBytes / 1048576).toFixed(1)} МБ` : ''}.</>}
      </p>}
      {view.phase && <p>Подожди здесь — статус обновится автоматически. Прошло {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}.</p>}
      {(connectionError || connection !== 'connected') && <p className="svb-kimi-note">{connectionError || 'Восстанавливаю связь с BB… Статус обновится после подключения.'}</p>}
    </div>}
    {view.stage === 'installing' && !view.phase && <p role="status">Готовлю профиль и устанавливаю компоненты…</p>}
    {view.stage === 'restart' && <>
      <p>Pi подготовлен. Заверши текущие задачи и полностью закрой и открой BB. После запуска нажми «Проверить после перезапуска». Ключ сохранён. Для браузерного BB перезапускается его сервер.</p>
      <button className="svb-primary-button" disabled={pending} onClick={() => { void act(() => rpc.call('kimiStart', {})); }}>Проверить после перезапуска</button>
    </>}
    {view.stage === 'registration' && <>
      {view.manualRegistration ? <>
        <p>Открой Settings → Plugins → ACP providers → Custom agents. Если список пуст, вставь массив ниже. Если записи уже есть, добавь объект Kimi в существующий массив, сохранив остальные записи.</p>
        <details><summary>Данные для добавления провайдера</summary><textarea aria-label="Регистрация Kimi без ключа" readOnly value={view.manualRegistration} rows={8} /></details>
        <button className="svb-primary-button" disabled={pending} onClick={open}>Провайдер добавлен — проверить</button>
      </> : <><button className="svb-primary-button" disabled={pending} onClick={() => { void act(() => rpc.call('kimiStart', {})); }}>Продолжить настройку</button><details><summary>Если компоненты не удаётся скачать</summary><p>Проверь интернет. Если автоматическая подготовка Node.js не работает на этом компьютере, установи Node.js 22+ с npm и повтори настройку.</p><UrlLink href="https://nodejs.org/en/download" className="svb-kimi-link">Скачать Node.js</UrlLink></details></>}
    </>}
    {view.stage === 'verify' && <>
      {!view.phase && <>
        <p>Проверим свежий короткий ответ выбранной модели в BB.</p>
        <button className="svb-primary-button" disabled={pending} onClick={() => { void act(() => rpc.call('kimiRecheck', null)); }}>Повторить проверку</button>
      </>}
      {view.canReplaceKey && !editingKey && <button className="svb-text-button" disabled={pending} onClick={() => setEditingKey(true)}>Исправить ключ</button>}
      {view.canReplaceKey && editingKey && <form onSubmit={event => {
        event.preventDefault(); const apiKey = key.trim(); setKey('');
        void act(() => rpc.call('kimiReplaceKey', { apiKey })).then(ok => { if (ok) setEditingKey(false); });
      }}><label>Новый ключ Kimi Code<input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} required pattern="sk-kimi-[A-Za-z0-9_-]+" /></label><button className="svb-primary-button" disabled={pending || !key.trim()}>Сохранить новый ключ</button></form>}
    </>}
    {isPi && !isManagedPi && ['blocked', 'registration'].includes(view.stage) && <details>
      <summary>Если штатный Pi не запускается</summary>
      <p>Помощник может проверить Node/npm и текущие настройки. Резервный способ ставит отдельные Node и Pi; он рассчитан на один компьютер исполнения и требует полного перезапуска BB.</p>
      <button className="svb-text-button" disabled={pending} onClick={() => {
        selectionEpoch.current++; setKey(''); setEditingKey(false); activeHere.current = false;
        void act(() => rpc.call('kimiSelectPiMode', { mode: 'managed' }));
      }}>Выбрать резервную установку</button>
    </details>}
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
