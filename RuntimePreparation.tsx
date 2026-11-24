import { useCallback, useEffect, useRef, useState } from 'react';
import { useBbContext, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { runtimeSettingsContract } from './runtime-settings-contract';
import { runtimeProgressSchema, type RuntimeView } from './runtime-contract';
import './kimi-setup.css';

const visibilityKey = 'svaib.runtime-preparation.hidden';
/** This surface needs neither a model nor a svaib login. Opening only probes. */
export function RuntimePreparation({ settings = true, cabinetVisible, onVisibilityChange }: { settings?: boolean; cabinetVisible?: boolean; onVisibilityChange?(visible: boolean): Promise<void> }) {
  const rpc = useRpc<typeof runtimeSettingsContract>();
  const { threadId } = useBbContext();
  const [dismissed, setDismissed] = useState(() => { try { return window.localStorage.getItem(visibilityKey) === 'true'; } catch { return false; } });
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [view, setView] = useState<RuntimeView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const epoch = useRef(0), running = useRef(false);
  const refresh = useCallback(async () => {
    const current = epoch.current;
    try {
      const next = await rpc.call('computerStatus', { threadId });
      if (current === epoch.current) { setView(next); setError(''); }
    } catch { if (current === epoch.current) setError('Безопасная проверка недоступна. Подключи компьютер и повтори.'); }
  }, [rpc, threadId]);
  useEffect(() => { epoch.current++; setView(null); setError(''); void refresh(); }, [refresh]);
  useRealtime('runtime-preparation-changed', (event: unknown) => {
    if (!event || typeof event !== 'object' || !('hostId' in event)) return;
    const result = runtimeProgressSchema.safeParse('progress' in event ? event.progress : null);
    if (running.current && result.success) setProgress(result.data.message);
    if (!running.current) void refresh();
  });
  useEffect(() => {
    const focus = () => { if (!running.current) void refresh(); };
    window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus);
  }, [refresh]);
  async function repair() {
    if (running.current) return;
    running.current = true; setBusy(true); setError(''); setProgress('Проверяю компоненты перед подготовкой…');
    const current = ++epoch.current;
    try {
      const next = await rpc.call('computerPrepare', { threadId });
      if (current === epoch.current) setView(next);
    } catch { if (current === epoch.current) setError('Подготовка прервана. Проверь компьютер и нажми «Проверить»; повтор установки запускается явно.'); }
    finally { running.current = false; setBusy(false); }
  }
  async function cancel() {
    const current = epoch.current;
    try { const next = await rpc.call('computerCancel', null); if (current === epoch.current) setView(next); }
    catch { if (current === epoch.current) setError('Не удалось подтвердить отмену. Проверь подключение компьютера.'); }
  }
  const hidden = cabinetVisible === undefined ? dismissed : !cabinetVisible;
  async function setHidden(nextHidden: boolean) {
    setVisibilityBusy(true);
    try {
      if (onVisibilityChange) await onVisibilityChange(!nextHidden);
      setDismissed(nextHidden);
      try { if (nextHidden && !onVisibilityChange) window.localStorage.setItem(visibilityKey, 'true'); else window.localStorage.removeItem(visibilityKey); } catch { /* Browser-only fallback is optional. */ }
    } catch { setError('Не удалось сохранить видимость панели. Повтори действие.'); }
    finally { setVisibilityBusy(false); }
  }
  // Settings always expose the controls. The cabinet stays quiet while a safe
  // probe is pending or the selected launch is ready; dismissal only affects UI.
  if (!settings && (hidden || (!view && !error) || ((view?.status === 'ready' || view?.previouslyPrepared) && !view.installerUncertain && !busy && !error))) return null;
  return <section className="svb svaib-setup-panel svb-runtime" aria-label="Подготовка компьютера" aria-busy={busy}>
    <div className="svaib-setup-panel-heading"><div><span className="svb-kicker">Рабочее место</span><h2>Подготовка компьютера</h2></div>
      {!settings && <button className="svb-text-button" disabled={busy || visibilityBusy} onClick={() => { void setHidden(true); }}>Скрыть</button>}
    </div>
    <p>Проверим компоненты текущего компьютера и исправим недостающее. Windows может запросить разрешение.</p>
    <p role="status" className="svaib-setup-panel-note">{busy ? progress : view?.message || 'Проверяю компоненты…'}</p>
    {view?.missing?.length ? <p>Не выполнено: {view.missing.map(key => ({ python: 'Python для хуков', bash: 'Git Bash', node: 'Node.js', npm: 'npm', bb: 'BB CLI', launcher: 'запуск выбранного агента' })[key]).join(', ')}.</p> : null}
    {view?.operationError && <p>Последняя подготовка: {view.operationError}</p>}
    {error && <p role="alert" className="svaib-setup-panel-error">{error}</p>}
    <div className="svb-kimi-actions">
      <button className="svb-primary-button" disabled={busy} onClick={() => void repair()}>Проверить и подготовить</button>
      {busy && <button className="svb-text-button" onClick={() => void cancel()}>Отменить подготовку</button>}
      {settings && hidden && <button className="svb-text-button" disabled={visibilityBusy} onClick={() => { void setHidden(false); }}>Показывать в кабинете</button>}
    </div>
  </section>;
}
