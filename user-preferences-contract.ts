import { z } from 'zod';

const workspaceId = z.string().min(1).max(128);
export const startupSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('last') }).strict(),
  z.object({ kind: z.literal('cabinet') }).strict(),
  z.object({ kind: z.literal('workspace'), workspaceId }).strict(),
]);
const metricId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/)
  .refine(value => value.length === 7 || (!Number.isNaN(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value));
const metricWindowSchema = z.object({ from: period, to: period }).strict()
  .refine(window => window.from.length === window.to.length && window.from <= window.to);
export const metricViewSchema = z.object({ table: z.boolean(), showPlan: z.boolean(),
  mode: z.enum(['months', 'year', 'current']).optional(), year: z.string().regex(/^\d{4}$/).optional(),
  scope: z.enum(['total', 'unit']).optional(), seriesIds: z.array(metricId).max(50).refine(ids => new Set(ids).size === ids.length).optional(),
  showGrowth: z.boolean().optional(), window: metricWindowSchema.nullable().optional(), selectedMetricId: metricId.optional(),
}).strict();
/** Leave room below BB's 256 KiB JSON value limit, including the whole stored envelope. */
export const USER_PREFERENCES_BYTE_BUDGET = 240 * 1024;
const metricKey = z.string().min(1).max(512).refine(key => !['__proto__', 'constructor', 'prototype'].includes(key));
export type MetricViewPreference = z.infer<typeof metricViewSchema>;
export const userPreferencesSchema = z.object({
  startup: startupSchema,
  workspaceOrder: z.array(workspaceId).max(128).refine(ids => new Set(ids).size === ids.length, 'Вкладки не должны повторяться.'),
  showNextSteps: z.boolean(),
  panels: z.object({ runtime: z.boolean(), kimi: z.boolean() }).strict(),
  lastWorkspaceId: workspaceId.nullable(),
  metricViews: z.record(metricKey, metricViewSchema).refine(views => Object.keys(views).length <= 128),
}).strict();
export type UserPreferences = z.infer<typeof userPreferencesSchema>;
export const defaultUserPreferences = (): UserPreferences => ({ startup: { kind: 'last' }, workspaceOrder: [], showNextSteps: true,
  panels: { runtime: true, kimi: true }, lastWorkspaceId: null, metricViews: {} });
export const preferencesViewSchema = z.object({ accountId: z.string().min(1).max(256).nullable(), revision: z.number().int().nonnegative(), preferences: userPreferencesSchema }).strict();
export type PreferencesView = z.infer<typeof preferencesViewSchema>;
export const preferencePatchSchema = z.object({
  startup: startupSchema.optional(),
  workspaceOrder: userPreferencesSchema.shape.workspaceOrder.optional(),
  showNextSteps: z.boolean().optional(),
  panels: userPreferencesSchema.shape.panels.partial().optional(),
  lastWorkspaceId: workspaceId.nullable().optional(),
  metricView: metricViewSchema.partial().extend({ key: metricKey }).strict()
    .refine(view => Object.entries(view).some(([field, value]) => field !== 'key' && value !== undefined)).optional(),
}).strict().refine(patch => Object.keys(patch).length > 0);
export type PreferencePatch = z.infer<typeof preferencePatchSchema>;
export const preferencesUpdateSchema = z.object({ expectedAccountId: z.string().min(1).max(256), expectedRevision: z.number().int().nonnegative(), patch: preferencePatchSchema }).strict();
export const userPreferencesRpc = {
  userPreferences: { input: z.null(), output: preferencesViewSchema },
  updateUserPreferences: { input: preferencesUpdateSchema, output: preferencesViewSchema },
};

export function orderWorkspaces<T extends { id: string }>(workspaces: readonly T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return workspaces.map((item, index) => ({ item, index })).sort((a, b) =>
    (rank.get(a.item.id) ?? order.length) - (rank.get(b.item.id) ?? order.length) || a.index - b.index).map(row => row.item);
}

/** An explicit URL always wins. Preferences cannot make an unavailable workspace accessible. */
export function startupRoute(subPath: string, workspaces: readonly { id: string; companyId?: string }[], preferences: UserPreferences, windowLast: string | null): string {
  if (subPath) return subPath;
  const available = (id: string | null) => id && workspaces.some(item => item.id === id) ? id : null;
  if (preferences.startup.kind === 'cabinet') return 'settings/account';
  if (preferences.startup.kind === 'workspace') return available(preferences.startup.workspaceId) || 'settings/account';
  return available(preferences.lastWorkspaceId) || available(windowLast) || workspaces.find(item => !item.companyId)?.id || 'settings/account';
}
