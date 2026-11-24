import { z } from 'zod/v4';
import manifest from './scaffold-catalog.json';
import { treeConfigSchema, planTree, type TreeConfig } from './scaffold-tree-model';
import { initialTreeConfig } from './scaffold-tree';

// Конструктор хранит только дерево (schemaVersion 2). Прежние сохранённые структуры
// удаляются, а не переводятся (решение 2026-11-20).
export const scaffoldConfigSchema = treeConfigSchema;
export type AnyScaffoldConfig = TreeConfig;
export type ScaffoldConfig = TreeConfig;
export type PlanFile = { path: string; template: string | null; templateSha256: string | null; subject: string; purpose: string };
export type ScaffoldPlan = { schemaVersion: 1; catalogVersion: string; canonSnapshot: string; companyName: string; files: PlanFile[]; directories?: { path: string; subject: string; purpose: string }[]; agentSteps: string[] };
export const scaffoldConfirmationSchema = z.object({ blockId: z.string(), documentRevision: z.number().int().positive(), revision: z.number().int().positive(), at: z.iso.datetime(),
  planHash: z.string(), config: scaffoldConfigSchema, plan: z.object({ schemaVersion: z.literal(1), catalogVersion: z.string(), canonSnapshot: z.string(), companyName: z.string(),
    directories: z.array(z.object({ path: z.string(), subject: z.string(), purpose: z.string() }).strict()).optional(),
    files: z.array(z.object({ path: z.string(), template: z.string().nullable(), templateSha256: z.string().nullable(), subject: z.string(), purpose: z.string() }).strict()), agentSteps: z.array(z.string()) }).strict().nullable() }).strict();
export type ScaffoldConfirmation = z.infer<typeof scaffoldConfirmationSchema>;
export const scaffoldCatalog = { version: manifest.version, canonSnapshot: manifest.canonSnapshot };

export function planScaffold(input: unknown): ScaffoldPlan {
  return planTree(scaffoldConfigSchema.parse(input));
}
export const initialScaffold: ScaffoldConfig = initialTreeConfig('Учебная компания');
