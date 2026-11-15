/** One-time normalization of persisted references; public contracts accept only View. */
export function upgradeViewReference(raw: unknown, legacy: 'screenId' | 'screen_id', current: 'viewId' | 'view_id'): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !(legacy in raw) || current in raw) return raw;
  const { [legacy]: id, ...rest } = raw as Record<string, unknown>;
  return { ...rest, [current]: id };
}
