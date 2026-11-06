import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const kimiCheckMetadataSchema = z.object({ kimiSetup: z.literal(1), kimiCheck: z.uuid().optional() }).strict();

export const kimiAgentSchema = z.object({
  id: z.literal('claude-kimi'), displayName: z.literal('Kimi (CC)'), command: z.string().min(1), args: z.array(z.string()).length(1),
  modelCli: z.object({ listArgs: z.array(z.string()).length(2), primaryModels: z.array(z.enum(['k3.1-pro', 'k3.1-pro[1m]'])).length(1) }).strict().optional(),
  nativeSkillRoots: z.object({ user: z.array(z.string()), project: z.array(z.object({ path: z.string(), recursive: z.literal(true), ancestors: z.literal(true) }).strict()) }).strict(),
}).strict();
export type KimiAgent = z.infer<typeof kimiAgentSchema>;
const key = z.string().max(512).regex(/^sk-kimi-[A-Za-z0-9_-]+$/, 'Нужен ключ из консоли Kimi Code.');
export const kimiHostStatusSchema = z.object({
  nodeReady: z.boolean(), nodeVersion: z.string().nullable(),
  profile: z.enum(['absent', 'partial', 'ready', 'blocked']), agent: kimiAgentSchema.nullable(),
}).strict();
export const kimiHostMethods = {
  kimiInspect: { input: z.null(), output: kimiHostStatusSchema, experimental_retryable: true },
  kimiPrepare: { input: z.object({ apiKey: key.optional() }).strict(), output: kimiAgentSchema },
  kimiReplaceKey: { input: z.object({ apiKey: key }).strict(), output: z.null() },
};
export const kimiViewSchema = z.object({
  revision: z.number().int().nonnegative(),
  canReplaceKey: z.boolean(),
  hidden: z.boolean(), stage: z.enum(['intro', 'node', 'key', 'installing', 'registration', 'verify', 'complete', 'blocked']),
  message: z.string(), hostId: z.string(), testThreadId: z.string().nullable(),
  verifyModel: z.string().nullable().default(null), manualRegistration: z.string().nullable(),
  keyChangedAt: z.number().nullable().default(null),
  phase: z.enum(['components', 'access', 'check']).nullable().default(null),
  startedAt: z.number().nullable().default(null),
  checkToken: z.string().nullable().default(null),
  checkStartedAt: z.number().nullable().default(null),
  catalogVersion: z.number().int().nonnegative().default(0),
  automatic: z.boolean().default(false),
  ownedTestThreadId: z.string().nullable().default(null),
}).strict();
export type KimiView = z.infer<typeof kimiViewSchema>;
export const kimiRpcContract = defineRpcContract({
  kimiStatus: { input: z.null(), output: kimiViewSchema },
  kimiOpen: { input: z.null(), output: kimiViewSchema },
  kimiStart: { input: z.object({ apiKey: key.optional() }).strict(), output: kimiViewSchema },
  kimiDismiss: { input: z.object({ reason: z.enum(['declined', 'other-agent']) }).strict(), output: kimiViewSchema },
  kimiTestStarted: { input: z.object({ threadId: z.string().min(1).max(100) }).strict(), output: kimiViewSchema },
  kimiCheckResponse: { input: z.null(), output: kimiViewSchema },
  kimiRecheck: { input: z.null(), output: kimiViewSchema },
  kimiReplaceKey: { input: z.object({ apiKey: key }).strict(), output: kimiViewSchema },
});
