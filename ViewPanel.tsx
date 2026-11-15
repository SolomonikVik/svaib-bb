import { useEffect, useMemo, useState } from 'react';
import { useRpc, useRealtime, type PluginRpcClient } from '@get-bb/plugin-sdk/app';
import type { viewRpcContract } from './view-module';
import { createViewTransport, ViewTransportError, type ViewBackendPort } from './view-transport';
import { ViewSurface, clearViewSnapshots } from 'bb-plugin-svaib-view-pilot/renderer';
import { useMetricPreferences } from './use-metric-preferences';

type Rpc = PluginRpcClient<typeof viewRpcContract>;
type Reply<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
function unwrap<T>(reply: Reply<T>): T {
  if (reply.ok) return reply.value;
  const error = new ViewTransportError(reply.error.code); error.message = reply.error.message; throw error;
}
/** Browser-only RPC facade. It receives selectors, never account identity or credentials. */
export function viewRpcBackend(rpc: Rpc, threadId: string, viewId: string,
  onError: (error: unknown) => void): ViewBackendPort {
  const selector = { threadId, viewId };
  async function call<T>(pending: Promise<Reply<T>>, signal?: AbortSignal, cancel?: () => void): Promise<T> {
    if (signal?.aborted) { cancel?.(); throw signal.reason; }
    let abort: (() => void) | undefined;
    const canceled = new Promise<never>((_, reject) => {
      if (!signal) return;
      abort = () => { cancel?.(); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const result = unwrap(await Promise.race([pending, canceled]));
      signal?.throwIfAborted(); return result;
    } catch (error) { if (!signal?.aborted) onError(error); throw error; }
    finally { if (abort) signal?.removeEventListener('abort', abort); }
  }
  return {
    get: signal => call(rpc.call('view.get', selector), signal),
    submit: (mutation, signal) => call(rpc.call('view.submit', { ...selector, mutation }), signal),
    update: (mutation, signal) => call(rpc.call('view.update', { ...selector, mutation }), signal),
    confirmScaffold: (mutation, signal) => call(rpc.call('view.confirm', { ...selector, mutation }), signal),
    expandScaffold: (input, signal) => call(rpc.call('view.expand', {...selector, ...input}), signal),
    events: (input, signal) => {
      const pollId = crypto.randomUUID();
      return call(rpc.call('view.events', { ...selector, pollId, ...input, timeoutMs: Math.min(input.timeoutMs, 10000) }), signal,
        () => { void rpc.call('view.cancel', { ...selector, pollId }).catch(() => {}); });
    },
  };
}

export function ViewPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof viewRpcContract>();
  const [viewId, setViewId] = useState<string | null>(null);
  const [verifiedThread, setVerifiedThread] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  useRealtime('view-changed', payload => {
    if ((payload as { threadId?: string })?.threadId === threadId) setReload(value => value + 1);
  });
  useRealtime('account-changed', () => { clearViewSnapshots(); setViewId(null); setVerifiedThread(null); setLoading(true); setReload(value => value + 1); });
  useEffect(() => {
    let live = true;
    setViewId(null); setVerifiedThread(null); setError(''); setLoading(true);
    void rpc.call('view.binding', { threadId }).then(unwrap).then(value => {
      if (!live) return;
      if (!value.viewId) clearViewSnapshots();
      setViewId(value.viewId); setVerifiedThread(threadId);
    }, cause => { if (live) { clearViewSnapshots(); setError(cause instanceof Error ? cause.message : 'Не удалось открыть представление.'); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [rpc, threadId, reload]);
  const transport = useMemo(() => createViewTransport({
    backend: viewRpcBackend(rpc, threadId, viewId ?? 'missing', cause => {
      if (cause instanceof ViewTransportError && ['revision_conflict', 'cursor_expired', 'request_conflict'].includes(cause.code)) return;
      setError(cause instanceof Error ? cause.message : 'Представление недоступно.'); setViewId(null);
    }),
  }), [rpc, threadId, viewId]);
  useEffect(() => () => transport.dispose(), [transport]);
  const metricPreferences = useMetricPreferences(viewId ? 'screen:' + viewId : '');
  if (loading || (viewId && verifiedThread !== threadId)) return <section className="sv-view"><p role="status">Проверяю представление этого разговора…</p></section>;
  if (!viewId) return <section className="sv-view"><p role={error ? 'alert' : 'status'}>{error || 'Попроси партнёра открыть представление в этом разговоре. Он проверит подключение и выбранную компанию.'}</p>
    <button onClick={() => setReload(value => value + 1)}>Повторить проверку</button></section>;
  return <>{metricPreferences.error && <p role="status" className="svb-preferences-note">Настройки вида показателей: {metricPreferences.error}</p>}
    <ViewSurface key={`${threadId}:${viewId}`} cacheKey={`${threadId}:${viewId}`} transport={transport} metricsPreferences={metricPreferences.preferences} /></>;
}
