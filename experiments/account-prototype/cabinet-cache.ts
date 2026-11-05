import type { AccountView, OnboardingView } from './contracts';

/** Display cache only. No tokens, permissions, storage, or server writes. */
export interface CabinetSnapshot {
  view: AccountView;
  companyId: string;
  companies: NonNullable<NonNullable<AccountView['me']>['companies']>;
  progress: OnboardingView | null;
  accountProgress: OnboardingView | null;
}
const snapshots = new Map<boolean, CabinetSnapshot>();
export function readCabinetSnapshot(production: boolean): CabinetSnapshot | undefined {
  return snapshots.get(production);
}
export function cacheCabinetSnapshot(production: boolean, snapshot: CabinetSnapshot) {
  if (snapshot.view.state === 'connected' && snapshot.view.me?.account_id) snapshots.set(production, snapshot);
}
export function clearCabinetSnapshots() { snapshots.clear(); }
