import type { Overview } from './types';
let overview: Overview | null = null;
let generation = 0;
const listeners = new Set<() => void>();
export const readWorkplaceOverview = () => overview;
export const workplaceOverviewGeneration = () => generation;
export function subscribeWorkplaceInvalidation(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function cacheWorkplaceOverview(value: Overview, expectedGeneration = generation) {
  if (expectedGeneration !== generation) return false;
  overview = value; return true;
}
export function clearWorkplaceOverview() {
  overview = null; generation++;
  for (const listener of listeners) listener();
}
