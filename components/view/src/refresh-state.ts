import type { View } from './model';

export function refreshState(refresh: View['refresh'], now = Date.now()) {
  const running = refresh?.status === 'running';
  const expiresAt = running ? Date.parse(refresh.expiresAt ?? '') : NaN;
  const expired = running && (!Number.isFinite(expiresAt) || expiresAt <= now);
  return { active: refresh?.status === 'requested' || (running && !expired), expired,
    deadline: running && !expired ? expiresAt : null };
}
