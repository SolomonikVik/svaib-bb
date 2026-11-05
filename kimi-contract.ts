import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const kimiAgentSchema = z.object({
  id: z.literal('claude-kimi'), displayName: z.literal('Kimi (CC)'), command: z.string().min(1), args: z.array(z.string()).length(1),
  modelCli: z.object({ listArgs: z.array(z.string()).length(2), primaryModels: z.tuple([z.literal('k3.1-pro[1m]')]) }).strict(),
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
  message: z.string(), hostId: z.string(), testThreadId: z.string().nullable(), manualRegistration: z.string().nullable(),
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
