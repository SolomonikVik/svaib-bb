import { useEffect, useMemo, useRef, useState } from 'react';
import { useRpc, useRealtime, useSdk, useBbNavigate, experimental_NewThreadComposer as NewThreadComposer } from '@get-bb/plugin-sdk/app';
import { ScreenSurface, clearScreenSnapshots, type ScreenDiscussion } from 'bb-plugin-svaib-screen-pilot/renderer';
import { createScreenTransport, ScreenTransportError, type ScreenBackendPort } from './screen-transport';
import type { metricsScreenRpcContract } from './metrics-screen-module';

type Reply<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
function unwrap<T>(reply: Reply<T>): T {
  if (reply.ok) return reply.value;
  const error = new ScreenTransportError(reply.error.code); error.message = reply.error.message; throw error;
}
type Preview = { prompt: string; title: string; accountId: string; projectId: string; environmentId: string; rootPath: string; hostId: string };

/** BB keeps a reference; the page never stores a second editable copy of the numbers. */
export function MetricsScreen({ workspaceId, accountId }: { workspaceId: string; accountId: string }) {
  const rpc = useRpc<typeof metricsScreenRpcContract>(), sdk = useSdk(), navigate = useBbNavigate();
  const [binding, setBinding] = useState<{ screenId: string | null } | null>(null);
  const [inputId, setInputId] = useState(''), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null), [discussion, setDiscussion] = useState<ScreenDiscussion | null>(null);
  const [editing, setEditing] = useState(false), [blocked, setBlocked] = useState(false);
  const generation = useRef(0);
  const selector = useMemo(() => ({ workspaceId, accountId }), [workspaceId, accountId]);
  const reset = () => { ++generation.current; clearScreenSnapshots(`metrics:${accountId}:${workspaceId}:`); setBinding(null); setPreview(null); setDiscussion(null); setError(''); setReload(v => v+1); };
  useRealtime('account-changed', () => { clearScreenSnapshots(); reset(); setBlocked(true); });
  useRealtime('workplaces-changed', reset);
  useRealtime('metrics-screen-changed', value => { if ((value as { workspaceId?: string })?.workspaceId === workspaceId) reset(); });
  useEffect(() => {
    const current = ++generation.current;
    setBinding(null); setPreview(null); setError(''); setBlocked(false);
    void rpc.call('metricsScreen.binding', selector).then(unwrap).then(value => {
      if (generation.current === current) setBinding(value);
    }, cause => { if (generation.current === current) { clearScreenSnapshots(); setError(cause.message); } });
    return () => { ++generation.current; clearScreenSnapshots(`metrics:${accountId}:${workspaceId}:`); };
  }, [rpc, selector, reload]);
  const screenId = binding?.screenId;
  const transport = useMemo(() => {
    const chosen = { ...selector, screenId: screenId ?? 'missing' };
    async function call<T>(pending: Promise<Reply<T>>, signal?: AbortSignal, cancel?: () => void) {
      if (signal?.aborted) { cancel?.(); throw signal.reason; }
      let abort: (() => void) | undefined;
      const canceled = new Promise<never>((_, reject) => {
        if (signal) { abort = () => { cancel?.(); reject(signal.reason); }; signal.addEventListener('abort', abort, { once: true }); }
      });
      try { const value = unwrap(await Promise.race([pending, canceled])); signal?.throwIfAborted(); return value; }
      finally { if (abort) signal?.removeEventListener('abort', abort); }
    }
    const noWrite = async () => { throw new ScreenTransportError('read_only'); };
    const backend: ScreenBackendPort = {
      get: signal => call(rpc.call('metricsScreen.get', chosen), signal),
      submit: noWrite, update: noWrite, confirmScaffold: noWrite,
      events: (input, signal) => {
        const pollId = crypto.randomUUID();
        return call(rpc.call('metricsScreen.events', { ...chosen, ...input, pollId, timeoutMs: Math.min(10000, input.timeoutMs) }), signal,
          () => { void rpc.call('metricsScreen.cancel', { ...chosen, pollId }).catch(() => {}); });
      },
    };
    return createScreenTransport({ backend });
  }, [rpc, selector, screenId]);
  useEffect(() => () => transport.dispose(), [transport]);
  async function start(context: ScreenDiscussion | null) {
    const current = generation.current; setError('');
    try {
      const result = unwrap(await (context ? rpc.call('metricsScreen.discuss', { ...selector, context }) : rpc.call('metricsScreen.prepare', selector)));
      if (current === generation.current) { setDiscussion(context); setPreview(result); }
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : 'Не удалось подготовить разговор.'); }
  }
  return <section className="svb-metrics-screen" aria-label="Показатели компании">
    {error && <p role="alert">{error}</p>}
    {preview ? <div className="svb-metrics-composer"><button type="button" onClick={() => { setPreview(null); setDiscussion(null); }}>К графикам</button><h3>{preview.title}</h3>
      <NewThreadComposer key={`${accountId}:${workspaceId}:${discussion?.metricId ?? 'prepare'}`} defaultProjectId={preview.projectId} defaultEnvironment={{ type: 'reuse', environmentId: preview.environmentId }} initialPrompt={preview.prompt}
        draftKey={`svaib-metrics/${accountId}/${workspaceId}/${discussion?.screenId ?? 'prepare'}/${discussion?.revision ?? 0}/${discussion?.metricId ?? ''}`} layout="document"
        onSubmit={async request => {
          const current = generation.current;
          const next = unwrap(await (discussion ? rpc.call('metricsScreen.discuss', { ...selector, context: discussion }) : rpc.call('metricsScreen.prepare', selector)));
          if (current !== generation.current || JSON.stringify([next.accountId, next.projectId, next.environmentId, next.rootPath, next.hostId]) !== JSON.stringify([preview.accountId, preview.projectId, preview.environmentId, preview.rootPath, preview.hostId])) throw new Error('Рабочее место изменилось. Открой обсуждение заново.');
          if (request.projectId !== next.projectId || request.environment.type !== 'reuse' || request.environment.environmentId !== next.environmentId) throw new Error('Выбери постоянную рабочую папку этой компании.');
          const thread = await sdk.threads.spawn({ ...request, input: [...request.input, { type: 'text', mentions: [], text: `Проверенный контекст страницы:\n${next.prompt}` }], title: next.title, pluginMetadata: { schema: 1, task: 'svaib-metrics', workspaceId, operation: discussion ? 'discuss' : 'prepare', ...(discussion ? { context: discussion } : {}) } });
          if (generation.current === current) navigate.toThread(thread.id);
        }} />
    </div> : <>
      {binding === null ? <p role="status">{blocked ? 'Подключение изменилось.' : error ? 'Показатели недоступны.' : 'Проверяю показатели…'}</p> : screenId ? <ScreenSurface key={`${accountId}:${workspaceId}:${screenId}`} embedded cacheKey={`metrics:${accountId}:${workspaceId}:${screenId}`} transport={transport} onDiscuss={context => void start(context)} /> : <p>Показатели ещё не подготовлены. Партнёр прочитает источники и соберёт графики для этой страницы.</p>}
      {!blocked && <div className="svb-metrics-screen-actions"><button type="button" onClick={() => void start(null)}>{screenId ? 'Обновить из источников' : 'Подготовить показатели'}</button><button type="button" onClick={() => setEditing(value => !value)}>Выбрать Screen</button></div>}
      {editing && <form onSubmit={async event => {
        event.preventDefault(); const current = generation.current; setError('');
        try { unwrap(await rpc.call('metricsScreen.pin', { ...selector, screenId: inputId.trim() })); if (current === generation.current) { setEditing(false); reset(); } }
        catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : 'Не удалось закрепить Screen.'); }
      }}><label>Screen ID <input value={inputId} onChange={event => setInputId(event.target.value)} required pattern="[a-z0-9][a-z0-9-]{0,79}" /></label><button type="submit">Закрепить на этой странице</button></form>}
      <p className="svb-md-snapshot-note">Общий серверный Screen. Перечитывание экрана показывает сохранённые данные; источники обновляет партнёр.</p>
    </>}
  </section>;
}
