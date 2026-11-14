import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './server';
import type { PreferencePatch, PreferencesView } from './user-preferences-contract';

type PreferencesContext = {
  snapshot: PreferencesView | null; verified: boolean; saving: boolean; error: string;
  refresh(): Promise<void>; update(patch: PreferencePatch, expectedAccountId: string): Promise<void>;
};
const Context = createContext<PreferencesContext | null>(null);
export const useUserPreferences = () => useContext(Context);

const legacyRuntimeKey = 'svaib.runtime-preparation.hidden';
const legacyRuntimeOwnerKey = 'svaib.runtime-preparation.migration-owner';
function claimLegacyRuntime(accountId: string, revision: number) {
  try {
    if (window.localStorage.getItem(legacyRuntimeKey) !== 'true') return false;
    const owner = window.localStorage.getItem(legacyRuntimeOwnerKey);
    if (owner && owner !== accountId) return false;
    if (!owner) window.localStorage.setItem(legacyRuntimeOwnerKey, accountId);
    return window.localStorage.getItem(legacyRuntimeOwnerKey) === accountId ? { pending: !!owner || revision === 0 } : null;
  } catch { return false; }
}
function completeLegacyRuntime(accountId: string) {
  try {
    if (window.localStorage.getItem(legacyRuntimeOwnerKey) !== accountId) return;
    window.localStorage.removeItem(legacyRuntimeKey);
    window.localStorage.removeItem(legacyRuntimeOwnerKey);
  } catch { /* Keep the account claim if browser storage is unavailable. */ }
}

function preferenceFields(patch: PreferencePatch) {
  const fields = Object.keys(patch).filter(key => key !== 'panels' && key !== 'metricView');
  for (const key of Object.keys(patch.panels ?? {})) fields.push('panels.' + key);
  if (patch.metricView) {
    for (const field of ['table', 'showPlan'] as const) {
      if (patch.metricView[field] !== undefined) fields.push(JSON.stringify(['metric', patch.metricView.key, field]));
    }
  }
  return fields;
}

export function UserPreferencesProvider({ children }: { children: ReactNode }) {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<PreferencesView | null>(null);
  const [verified, setVerified] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const current = useRef<PreferencesView | null>(null), session = useRef(0), sequence = useRef(0), live = useRef(true);
  const queue = useRef<Promise<unknown>>(Promise.resolve()), pending = useRef(0), refreshPending = useRef(false);
  const writeFailures = useRef(new Map<string, string>());
  const accept = useCallback((value: PreferencesView, saved?: PreferencePatch) => {
    current.current = value; setSnapshot(value); setVerified(true);
    if (saved) for (const field of preferenceFields(saved)) writeFailures.current.delete(field);
    setError(writeFailures.current.values().next().value ?? '');
  }, []);
  const refresh = useCallback(async () => {
    if (pending.current) { refreshPending.current = true; return; }
    const request = ++sequence.current, epoch = session.current;
    setVerified(false);
    try {
      let next = await rpc.call('userPreferences', null);
      // Preserve the previous browser-only dismissal when adopting account settings.
      const legacy = next.accountId && live.current && epoch === session.current && request === sequence.current ? claimLegacyRuntime(next.accountId, next.revision) : null;
      if (next.accountId && legacy) {
        const legacyOwner = next.accountId;
        if (legacy.pending && next.preferences.panels.runtime) {
          try {
            next = await rpc.call('updateUserPreferences', { expectedAccountId: next.accountId, expectedRevision: next.revision, patch: { panels: { runtime: false } } });
          } catch (cause) {
            const fresh = await rpc.call('userPreferences', null);
            if (fresh.accountId !== next.accountId || fresh.revision <= next.revision || fresh.preferences.panels.runtime) throw cause;
            next = fresh;
          }
        }
        completeLegacyRuntime(legacyOwner);
      }
      if (live.current && epoch === session.current && request === sequence.current) accept(next);
    } catch (cause) {
      if (live.current && epoch === session.current && request === sequence.current) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить личные настройки.');
    }
  }, [rpc, accept]);
  useEffect(() => { live.current = true; void refresh(); return () => { live.current = false; session.current++; sequence.current++; }; }, [refresh]);
  useRealtime('account-changed', () => {
    session.current++; sequence.current++; current.current = null;
    writeFailures.current.clear(); setSnapshot(null); setVerified(false); setError(''); void refresh();
  });
  useRealtime('user-preferences-changed', (event: unknown) => {
    if (event && typeof event === 'object' && 'accountId' in event && current.current?.accountId && event.accountId !== current.current.accountId) return;
    void refresh();
  });
  useEffect(() => { const focus = () => { void refresh(); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, [refresh]);
  const update = useCallback((patch: PreferencePatch, expectedAccountId: string) => {
    const epoch = session.current;
    sequence.current++; pending.current++; setSaving(true);
    const task = queue.current.catch(() => {}).then(async () => {
      const latest = current.current;
      if (!latest || latest.accountId !== expectedAccountId || epoch !== session.current) throw new Error('Аккаунт изменился. Обнови кабинет.');
      const next = await rpc.call('updateUserPreferences', { expectedAccountId, expectedRevision: latest.revision, patch });
      if (!live.current || epoch !== session.current) return;
      if (next.accountId !== expectedAccountId) throw new Error('Аккаунт изменился. Обнови кабинет.');
      if (patch.panels?.runtime !== undefined) completeLegacyRuntime(expectedAccountId);
      accept(next, patch);
    }).catch(cause => {
      if (live.current && epoch === session.current) {
        const message = cause instanceof Error ? cause.message : 'Не удалось сохранить настройки.';
        for (const field of preferenceFields(patch)) writeFailures.current.set(field, message);
        setError(writeFailures.current.values().next().value ?? message); setVerified(false); refreshPending.current = true;
      }
      throw cause;
    }).finally(() => {
      pending.current--;
      if (live.current) {
        setSaving(pending.current > 0);
        if (!pending.current && refreshPending.current) { refreshPending.current = false; void refresh(); }
      }
    });
    queue.current = task;
    return task;
  }, [rpc, accept, refresh]);
  return <Context.Provider value={{ snapshot, verified, saving, error, refresh, update }}>{children}</Context.Provider>;
}
