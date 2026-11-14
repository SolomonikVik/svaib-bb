import { useCallback, useEffect, useRef, useState } from 'react';
import { useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { runtimeSettingsContract } from './runtime-settings-contract';
import { runtimeProgressSchema, type RuntimeContext, type RuntimeView } from './runtime-contract';
import './kimi-setup.css';

const providers = [['codex', 'Codex'], ['claude-code', 'Claude Code'], ['acp-claude-kimi', 'Kimi (Claude Code)'], ['pi', 'Pi']] as const;
/** This surface needs neither a model nor a svaib login. Opening only probes. */
export function RuntimePreparation() {
  const rpc = useRpc<typeof runtimeSettingsContract>();
  const [hosts, setHosts] = useState<{ id: string; name: string }[]>([]);
  const [hostId, setHostId] = useState('');
  const [provider, setProvider] = useState<RuntimeContext['provider']>('codex');
  const [action, setAction] = useState<'dispatch' | 'install'>('dispatch');
  const [view, setView] = useState<RuntimeView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [portableNode, setPortableNode] = useState(false);
  const epoch = useRef(0), running = useRef(false);
  useEffect(() => {
    let live = true;
    rpc.call('runtimeHosts', null).then(result => {
      if (!live) return;
      setHosts(result.hosts); setHostId(result.primaryHostId ?? result.hosts[0]?.id ?? '');
    }, () => { if (live) setError('Не удалось получить компьютеры BB. Повтори открытие настроек.'); });
    return () => { live = false; epoch.current++; };
  }, [rpc]);
  const refresh = useCallback(async () => {
    if (!hostId) return;
    const current = epoch.current;
    try {
      const next = await rpc.call('runtimeStatus', { hostId, context: { provider, action, hooks: true } });
      if (current === epoch.current) { setView(next); setError(''); }
    } catch { if (current === epoch.current) setError('Безопасная проверка недоступна. Подключи компьютер и повтори.'); }
  }, [rpc, hostId, provider, action]);
  useEffect(() => { epoch.current++; setView(null); setError(''); void refresh(); }, [refresh]);
  useRealtime('runtime-preparation-changed', (event: unknown) => {
    if (!event || typeof event !== 'object' || !('hostId' in event) || event.hostId !== hostId) return;
    const result = runtimeProgressSchema.safeParse('progress' in event ? event.progress : null);
    if (running.current && result.success && result.data.context?.provider === provider && result.data.context.action === action) setProgress(result.data.message);
    if (!running.current) void refresh();
  });
  useEffect(() => {
    const focus = () => { if (!running.current) void refresh(); };
    window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus);
  }, [refresh]);
  async function repair() {
    if (!hostId || running.current) return;
    running.current = true; setBusy(true); setError(''); setProgress('Проверяю компоненты перед подготовкой…');
    const current = ++epoch.current;
    try {
      const next = await rpc.call('runtimeRepair', { hostId, context: { provider, action, hooks: true }, portableNode });
      if (current === epoch.current) setView(next);
    } catch { if (current === epoch.current) setError('Подготовка прервана. Проверь компьютер и нажми «Проверить»; повтор установки запускается явно.'); }
    finally { running.current = false; setBusy(false); }
  }
  async function cancel() {
    const current = epoch.current;
    try { const next = await rpc.call('runtimeCancelPreparation', { hostId }); if (current === epoch.current) setView(next); }
    catch { if (current === epoch.current) setError('Не удалось подтвердить отмену. Проверь подключение компьютера.'); }
  }
  return <section className="svb svb-kimi-settings" aria-label="Подготовка компьютера">
    <h3>Подготовка компьютера</h3>
    <p>Проверка компонентов для выбранного агента. Кнопка подготовки устанавливает недостающее; Windows может запросить разрешение.</p>
    <label>Компьютер<select aria-label="Компьютер подготовки" value={hostId} disabled={busy} onChange={e => setHostId(e.target.value)}>
      {!hosts.length && <option value="">Нет подключённых компьютеров</option>}
      {hosts.map(host => <option key={host.id} value={host.id}>{host.name}</option>)}
    </select></label>
    <label>Сценарий<select aria-label="Сценарий подготовки" value={provider} disabled={busy} onChange={e => setProvider(e.target.value as RuntimeContext['provider'])}>
      {providers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
    </select></label>
    <label>Действие<select aria-label="Действие подготовки" value={action} disabled={busy} onChange={e => setAction(e.target.value as 'dispatch' | 'install')}>
      <option value="dispatch">Обычный запуск</option><option value="install">Компоненты установщика</option>
    </select></label>
    <p role="status">{busy ? progress : view?.message || 'Проверяю компоненты…'}</p>
    {view?.missing?.length ? <p>Не выполнено: {view.missing.map(key => ({ python: 'Python для хуков', bash: 'Git Bash', node: 'Node.js', npm: 'npm', bb: 'BB CLI', launcher: 'запуск выбранного агента' })[key]).join(', ')}.</p> : null}
    {view?.operationError && <p>Последняя подготовка: {view.operationError}</p>}
    {error && <p role="alert">{error}</p>}
    {view?.platform === 'win32' && action === 'install' && <label><input type="checkbox" checked={portableNode} disabled={busy} onChange={e => setPortableNode(e.target.checked)} />Переносимый Node, если он потребуется установщику</label>}
    <div className="svb-kimi-actions">
      <button disabled={!hostId || busy} onClick={() => void refresh()}>Проверить</button>
      <button disabled={!hostId || busy} onClick={() => void repair()}>Подготовить / Повторить</button>
      {busy && <button onClick={() => void cancel()}>Отменить подготовку</button>}
    </div>
  </section>;
}
