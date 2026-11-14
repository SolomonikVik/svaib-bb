import { useMemo } from 'react';
import type { MetricPreferences } from 'bb-plugin-svaib-screen-pilot/metrics';
import { useUserPreferences } from './UserPreferences';

export function useMetricPreferences(scope: string, expectedAccountId?: string | null) {
  const personal = useUserPreferences();
  const owner = expectedAccountId === undefined ? personal?.snapshot?.accountId : expectedAccountId;
  const own = !!owner && personal?.snapshot?.accountId === owner;
  const values = own ? personal.snapshot!.preferences.metricViews : undefined;
  const update = personal?.update, verified = personal?.verified;
  const preferences = useMemo<MetricPreferences | undefined>(() => {
    if (!personal || !scope || (verified && !owner)) return undefined;
    if (!owner || !own || !verified || !values || !update) return { ready: false, read: () => undefined, write: () => {} };
    const key = (id: string) => JSON.stringify([scope, id]);
    return { read: id => values[key(id)], write: (id, changes) => {
      return update({ metricView: { key: key(id), ...changes } }, owner).catch(() => {});
    } };
  }, [scope, owner, own, verified, values, update, !!personal]);
  return { preferences, error: own || !personal?.snapshot ? personal?.error : '' };
}
