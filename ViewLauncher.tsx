import { useCallback, useEffect, useRef, useState } from 'react';
import { experimental_useAppPanel, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { viewRpcContract } from './view-module';

const viewTab = { id: 'svaib-view', context: { kind: 'thread' as const }, availability: 'action' as const };

/** The host keeps visibility hooks mounted even while their segment is hidden. */
export function useViewLauncher({ threadId }: { threadId: string }) {
  const panel = experimental_useAppPanel();
  const rpc = useRpc<typeof viewRpcContract>();
  const handled = useRef<string | null>(null);
  const checkSequence = useRef(0);
  const [available, setAvailable] = useState(false);
  const refresh = useCallback(() => {
    const sequence = ++checkSequence.current;
    void rpc.call('view.binding', { threadId }).then(result => { if (checkSequence.current === sequence) setAvailable(result.ok && !!result.value.viewId); })
      .catch(() => { if (checkSequence.current === sequence) setAvailable(false); });
  }, [rpc, threadId]);
  const present = useCallback((requestId: string) => {
    if (handled.current === requestId) return;
    handled.current = requestId;
    let opened = false;
    try { opened = panel.openTab({ tab: viewTab }); } catch { /* host refused */ }
    void rpc.call('view.presented', { threadId, requestId, opened }).catch(() => {});
  }, [panel, rpc, threadId]);
  useRealtime('view-open-requested', payload => {
    const request = payload as { threadId?: unknown; requestId?: unknown } | null;
    if (request?.threadId === threadId && typeof request.requestId === 'string') { ++checkSequence.current; setAvailable(true); present(request.requestId); }
  });
  useRealtime('view-changed', payload => { if ((payload as { threadId?: string })?.threadId === threadId) refresh(); });
  useRealtime('account-changed', refresh);
  useEffect(() => {
    let alive = true;
    setAvailable(false); refresh();
    void rpc.call('view.presentation', { threadId }).then(({ requestId }) => { if (alive && requestId) { ++checkSequence.current; setAvailable(true); present(requestId); } }).catch(() => {});
    return () => { alive = false; ++checkSequence.current; };
  }, [rpc, threadId, present, refresh]);
  return available;
}

export function ViewLauncher() {
  const panel = experimental_useAppPanel();
  return <button type="button" onClick={() => panel.openTab({ tab: viewTab })}>Конструктор</button>;
}
