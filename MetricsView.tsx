import { useEffect, useMemo, useRef, useState } from 'react';
import { useRpc, useRealtime, useSdk, useBbNavigate, experimental_NewThreadComposer as NewThreadComposer } from '@get-bb/plugin-sdk/app';
import { ViewSurface, clearViewSnapshots, type ViewDiscussion } from 'bb-plugin-svaib-view-pilot/renderer';
import { createViewTransport, ViewTransportError, type ViewBackendPort } from './view-transport';
import type { metricsViewRpcContract } from './metrics-view-module';
import { useMetricPreferences } from './use-metric-preferences';

type Reply<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
function unwrap<T>(reply: Reply<T>): T {
  if (reply.ok) return reply.value;
  const error = new ViewTransportError(reply.error.code); error.message = reply.error.message; throw error;
}
type RefreshContext = { viewId: string; requestId: string; leaseId: string; generation: number; revision: number };
type Preview = { prompt: string; title: string; accountId: string; projectId: string; environmentId: string; rootPath: string; hostId: string; refresh?: RefreshContext };
type Binding = { viewId: string | null; publications?: { id: string; title: string; purpose: string; coverage: string; ready?: boolean }[]; complete?: boolean };

/** BB keeps a reference; the page never stores a second editable copy of the numbers. */
export function MetricsView({ workspaceId, accountId }: { workspaceId: string; accountId: string }) {
  const rpc = useRpc<typeof metricsViewRpcContract>(), sdk = useSdk(), navigate = useBbNavigate();
  const [binding, setBinding] = useState<Binding | null>(null);
  const [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null), [discussion, setDiscussion] = useState<ViewDiscussion | null>(null);
  const [blocked, setBlocked] = useState(false), [sharing, setSharing] = useState(false);
  const [browserUrl, setBrowserUrl] = useState(''), [linkPending, setLinkPending] = useState(false), [linkStatus, setLinkStatus] = useState('');
  const generation = useRef(0), claimRequest = useRef<string | null>(null), launching = useRef(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const tick = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(tick); }, []);
  const [refreshNote, setRefreshNote] = useState(''), [refreshPending, setRefreshPending] = useState(false);
  const selector = useMemo(() => ({ workspaceId, accountId }), [workspaceId, accountId]);
  const reset = () => { ++generation.current; clearViewSnapshots(`metrics:${accountId}:${workspaceId}:`); setBinding(null); setPreview(null); setDiscussion(null); setSharing(false); setBrowserUrl(''); setLinkStatus(''); setLinkPending(false); setError(''); setRefreshNote(''); setRefreshPending(false); claimRequest.current = null; setReload(v => v+1); };
  useRealtime('account-changed', () => { clearViewSnapshots(); reset(); setBlocked(true); });
  useRealtime('workplaces-changed', reset);
  useRealtime('metrics-view-changed', value => { if ((value as { workspaceId?: string })?.workspaceId === workspaceId) reset(); });
  useEffect(() => {
    const current = ++generation.current;
    setBinding(null); setPreview(null); setSharing(false); setBrowserUrl(''); setLinkStatus(''); setLinkPending(false); setError(''); setBlocked(false);
    void rpc.call('metricsView.binding', selector).then(unwrap).then(value => {
      if (generation.current === current) setBinding(value);
    }, cause => { if (generation.current === current) { clearViewSnapshots(); setError(cause.message); } });
    return () => { ++generation.current; clearViewSnapshots(`metrics:${accountId}:${workspaceId}:`); };
  }, [rpc, selector, reload]);
  const viewId = binding?.viewId;
  const metricPreferences = useMetricPreferences(viewId ? 'screen:' + viewId : '', accountId);
  const transport = useMemo(() => {
    const chosen = { ...selector, viewId: viewId ?? 'missing' };
    async function call<T>(pending: Promise<Reply<T>>, signal?: AbortSignal, cancel?: () => void) {
      if (signal?.aborted) { cancel?.(); throw signal.reason; }
      let abort: (() => void) | undefined;
      const canceled = new Promise<never>((_, reject) => {
        if (signal) { abort = () => { cancel?.(); reject(signal.reason); }; signal.addEventListener('abort', abort, { once: true }); }
      });
      try { const value = unwrap(await Promise.race([pending, canceled])); signal?.throwIfAborted(); return value; }
      finally { if (abort) signal?.removeEventListener('abort', abort); }
    }
    const noWrite = async () => { throw new ViewTransportError('read_only'); };
    const backend: ViewBackendPort = {
      get: signal => call(rpc.call('metricsView.get', chosen), signal),
      submit: noWrite, update: noWrite, confirmScaffold: noWrite,
      events: (input, signal) => {
        const pollId = crypto.randomUUID();
        return call(rpc.call('metricsView.events', { ...chosen, ...input, pollId, timeoutMs: Math.min(10000, input.timeoutMs) }), signal,
          () => { void rpc.call('metricsView.cancel', { ...chosen, pollId }).catch(() => {}); });
      },
    };
    return createViewTransport({ backend });
  }, [rpc, selector, viewId]);
  useEffect(() => () => transport.dispose(), [transport]);
  function failure(cause: unknown, fallback: string) {
    const message = cause instanceof Error ? cause.message : fallback;
    if (cause instanceof ViewTransportError && ['permission_denied', 'not_found', 'context_changed', 'view_binding_required'].includes(cause.code)) {
      reset(); setBlocked(true); setError(message);
    } else setError(message);
  }
  async function start(context: ViewDiscussion | null) {
    const current = generation.current; setError(''); claimRequest.current = null; launching.current = false;
    try {
      const result = unwrap(await (context ? rpc.call('metricsView.discuss', { ...selector, context }) : rpc.call('metricsView.prepare', selector)));
      if (current === generation.current) { setDiscussion(context); setPreview(result); }
    } catch (cause) { if (current === generation.current) failure(cause, 'Не удалось подготовить разговор.'); }
  }
  async function requestRefresh() {
    if (!viewId || refreshPending) return;
    const current = generation.current; setRefreshPending(true); setRefreshNote('');
    try {
      const result = unwrap(await rpc.call('metricsView.refresh', { ...selector, viewId, requestId: crypto.randomUUID(), action: 'request' }));
      if (generation.current === current) setRefreshNote(result.refresh.status === 'running'
        ? 'Обновление уже выполняется. Результат появится здесь.' : 'Запрос обновления сохранён. Его увидит редактор представления.');
    } catch (cause) { if (generation.current === current) failure(cause, 'Не удалось запросить обновление.'); }
    finally { if (generation.current === current) setRefreshPending(false); }
  }
  async function selectPublication(id: string) {
    const current = generation.current; setError('');
    try { unwrap(await rpc.call('metricsView.choose', { ...selector, viewId: id })); if (current === generation.current) reset(); }
    catch (cause) { if (current === generation.current) failure(cause, 'Представление недоступно.'); }
  }
  async function useLink(action: 'share' | 'copy' | 'open') {
    if (!viewId || blocked) return;
    const current = generation.current;
    setLinkPending(true); setLinkStatus('');
    try {
      const result = unwrap(await rpc.call('metricsView.browserLink', { ...selector, viewId }));
      if (generation.current !== current) return;
      setBrowserUrl(result.url);
      if (action === 'open') {
        if (!navigate.openUrl(result.url)) { setSharing(true); setLinkStatus('Браузер не открылся. Скопируй ссылку.'); }
      } else if (action === 'copy') {
        try {
          if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
          await navigator.clipboard.writeText(result.url);
          if (generation.current === current) setLinkStatus('Ссылка скопирована.');
        } catch { if (generation.current === current) setLinkStatus('Автоматически скопировать не удалось. Выдели и скопируй ссылку ниже.'); }
      }
    } catch (cause) {
      if (generation.current === current) {
        const message = cause instanceof Error ? cause.message : 'Ссылка недоступна.';
        if (cause instanceof ViewTransportError && ['permission_denied', 'not_found', 'context_changed', 'view_binding_required'].includes(cause.code)) {
          reset(); setBlocked(true); setError(message);
        } else { setBrowserUrl(''); setLinkStatus(message); }
      }
    } finally { if (generation.current === current) setLinkPending(false); }
  }
  return <section className="svb-metrics-view" aria-label="Показатели компании">
    {(!viewId || preview) && <h1 className="svb-metrics-page-title">{preview?.title ?? 'Показатели компании'}</h1>}
    {metricPreferences.error && <p role="status" className="svb-preferences-note">Настройки вида показателей: {metricPreferences.error}</p>}
    {error && <p role="alert">{error}</p>}
    {preview ? <div className="svb-metrics-composer"><button type="button" onClick={() => { setPreview(null); setDiscussion(null); }}>К графикам</button>
      <NewThreadComposer key={`${accountId}:${workspaceId}:${discussion?.metricId ?? 'prepare'}`} defaultProjectId={preview.projectId} defaultEnvironment={{ type: 'reuse', environmentId: preview.environmentId }} initialPrompt={preview.prompt}
        draftKey={`svaib-metrics/${accountId}/${workspaceId}/${discussion?.viewId ?? 'prepare'}/${discussion?.revision ?? 0}/${discussion?.metricId ?? ''}`} layout="document"
        onSubmit={async request => {
          if (launching.current) return;
          launching.current = true;
          try {
          const current = generation.current;
          const next = unwrap(await (discussion ? rpc.call('metricsView.discuss', { ...selector, context: discussion }) : rpc.call('metricsView.prepare', selector)));
          if (current !== generation.current || JSON.stringify([next.accountId, next.projectId, next.environmentId, next.rootPath, next.hostId]) !== JSON.stringify([preview.accountId, preview.projectId, preview.environmentId, preview.rootPath, preview.hostId])) throw new Error('Рабочее место изменилось. Открой обсуждение заново.');
          if (request.projectId !== next.projectId || request.environment.type !== 'reuse' || request.environment.environmentId !== next.environmentId) throw new Error('Выбери постоянную рабочую папку этой компании.');
          let launch = next;
          if (!discussion && viewId) {
            const result = unwrap(await rpc.call('metricsView.refresh', { ...selector, viewId,
              requestId: claimRequest.current ?? (claimRequest.current = crypto.randomUUID()), action: 'claim' }));
            if (current !== generation.current) throw new Error('Подключение изменилось. Открой страницу заново.');
            if (!result.acquired || !result.preview) { setPreview(null); setRefreshNote('Обновление уже выполняется. Результат появится здесь.'); return; }
            launch = result.preview;
          }
          let thread;
          try { thread = await sdk.threads.spawn({ ...request, input: [...request.input, { type: 'text', mentions: [], text: `Проверенный контекст страницы:\n${launch.prompt}` }], title: launch.title, pluginMetadata: { schema: 1, task: 'svaib-metrics', workspaceId, operation: discussion ? 'discuss' : launch.refresh ? 'refresh' : 'prepare', ...(discussion ? { context: discussion } : {}), ...(launch.refresh ? { refresh: launch.refresh } : {}) } }); }
          catch (cause) {
            claimRequest.current = null;
            if (launch.refresh) await rpc.call('metricsView.release', { ...selector, viewId: launch.refresh.viewId, leaseId: launch.refresh.leaseId, requestId: crypto.randomUUID() }).catch(() => {});
            throw cause;
          }
          if (generation.current === current) navigate.toThread(thread.id);
          } catch (cause) { launching.current = false; throw cause; }
        }} />
    </div> : <>
      {refreshNote && <p role="status">{refreshNote}</p>}
      {binding === null ? <p role="status">{blocked ? 'Подключение изменилось.' : error ? 'Показатели недоступны.' : 'Проверяю показатели…'}</p> : viewId ? <ViewSurface key={`${accountId}:${workspaceId}:${viewId}`} embedded cacheKey={`metrics:${accountId}:${workspaceId}:${viewId}`} transport={transport} metricsPreferences={metricPreferences.preferences} onDiscuss={context => void start(context)}
        metricsActions={view => <>
          {view.canEdit ? <button type="button" className="svb-md-primary" disabled={view.refresh?.status === 'running' && (!view.refresh.expiresAt || Date.parse(view.refresh.expiresAt) > now)} onClick={() => void start(null)}>Обновить данные</button>
            : <button type="button" disabled={refreshPending || (view.refresh?.status === 'running' && (!view.refresh.expiresAt || Date.parse(view.refresh.expiresAt) > now))} onClick={() => void requestRefresh()}>Запросить обновление</button>}
          {view.refresh?.status === 'requested' && <span className="svb-metrics-reader-note" role="status">Запрошено обновление данных</span>}
          {view.refresh?.status === 'running' && <span className="svb-metrics-reader-note" role="status">{view.refresh.expiresAt && Date.parse(view.refresh.expiresAt) <= now ? 'Обновление не завершилось. Можно повторить запрос.' : 'Обновляю данные…'}</span>}
          {view.refresh?.status === 'failed' && <span className="svb-metrics-reader-note" role="status">{view.publicationReady === false ? 'Не удалось подготовить показатели.' : 'Не удалось обновить данные. Показан последний успешный снимок.'} {view.refresh.error}</span>}
          <button type="button" aria-expanded={sharing} onClick={() => { const opening = !sharing; setSharing(opening); if (opening) void useLink('share'); }}>Поделиться</button>
          <button type="button" disabled={linkPending} onClick={() => void useLink('open')}>Открыть в браузере</button>
          {sharing && <section className="svb-md-share-panel" aria-label="Поделиться представлением">
            <strong>Ссылка на это представление</strong><p>Коллега откроет актуальную редакцию после входа, если у него есть доступ. Ссылка не меняет права.</p>
            {linkPending && <p role="status">Проверяю ссылку…</p>}
            {browserUrl && <label>Ссылка<input readOnly value={browserUrl} onFocus={event => event.currentTarget.select()} /></label>}
            <button type="button" disabled={linkPending || !browserUrl} onClick={() => void useLink('copy')}>Скопировать ссылку</button>
          </section>}
          {linkStatus && <p role="status" className="svb-metrics-link-status">{linkStatus}</p>}
        </>} /> : binding.publications?.length ? <div className="svb-metrics-publications"><p>Выбери общую публикацию показателей.</p>
        {binding.publications.map(item => <button type="button" key={item.id} onClick={() => void selectPublication(item.id)}><strong>{item.title}</strong><span>{item.purpose} · {item.coverage}{item.ready === false ? ' · Показатели готовятся' : ''}</span></button>)}</div>
        : binding.complete === false ? <p role="status">Список публикаций пока неполон. Повтори проверку перед подготовкой.</p>
        : <p>Показатели ещё не подготовлены. Агент прочитает источники и соберёт графики для этой страницы.</p>}
      {!blocked && binding !== null && !viewId && !error && binding.complete !== false && !binding.publications?.length && <div className="svb-metrics-view-actions"><button type="button" onClick={() => void start(null)}>Подготовить показатели</button></div>}
    </>}
  </section>;
}
