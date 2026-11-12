import { z } from 'zod';

/** Presence only: never inspect a credential value to detect an existing native setup. */
export function isPiModelCredentialName(name: string) {
  return /^(?:(?:KIMI|OPENAI|ANTHROPIC|GEMINI|GOOGLE|ZAI|MINIMAX|MISTRAL|GROQ|CEREBRAS|XAI|OPENROUTER|MOONSHOT|DEEPSEEK|NVIDIA|HF|FIREWORKS|TOGETHER|AI_GATEWAY|COPILOT|OPENCODE)_(?:API_KEY|TOKEN|AUTH_TOKEN|OAUTH_TOKEN|GITHUB_TOKEN)|AWS_PROFILE|AWS_ACCESS_KEY_ID|GOOGLE_APPLICATION_CREDENTIALS)$/.test(name);
}

export const kimiPiRegistrationSchema = z.object({
  command: z.string().min(1),
  args: z.tuple([z.string().min(1), z.uuid()]),
  agentDir: z.string().min(1),
}).strict();
export type KimiPiRegistration = z.infer<typeof kimiPiRegistrationSchema>;
export const kimiPiStatusSchema = z.object({
  profile: z.enum(['absent', 'partial', 'ready', 'blocked']),
  registration: kimiPiRegistrationSchema.nullable(),
  needsKey: z.boolean(),
  hasExternalProfile: z.boolean(),
}).strict();
export type KimiPiStatus = z.infer<typeof kimiPiStatusSchema>;
export const nativePiRegistrationSchema = z.object({
  command: z.string().min(1), args: z.array(z.string()).max(16), agentDir: z.string().min(1),
}).strict();
export type NativePiRegistration = z.infer<typeof nativePiRegistrationSchema>;
export const nativePiStatusSchema = z.object({
  installed: z.boolean(), registration: nativePiRegistrationSchema.nullable(),
  profile: z.enum(['absent', 'ready', 'blocked']), hasCredential: z.boolean(), canReplaceKey: z.boolean(),
}).strict();
export type NativePiStatus = z.infer<typeof nativePiStatusSchema>;
const keyInput = z.object({
  apiKey: z.string().max(512).regex(/^sk-kimi-[A-Za-z0-9_-]+$/, 'Нужен ключ из консоли Kimi Code.').optional(),
  replaceKey: z.boolean().optional(), diagnosticId: z.uuid().optional(),
}).strict();
export const kimiPiHostMethods = {
  kimiPiNativePrerequisites: {
    input: z.object({ diagnosticId: z.uuid().optional() }).strict(), output: z.null(),
  },
  kimiPiNativeInspect: { input: z.null(), output: nativePiStatusSchema, experimental_retryable: true },
  kimiPiNativePrepare: { input: keyInput, output: nativePiRegistrationSchema },
  kimiPiInspect: { input: z.null(), output: kimiPiStatusSchema, experimental_retryable: true },
  kimiPiPrepare: {
    input: z.object({
      apiKey: z.string().max(512).regex(/^sk-kimi-[A-Za-z0-9_-]+$/, 'Нужен ключ из консоли Kimi Code.').optional(),
      replaceKey: z.boolean().optional(),
      diagnosticId: z.uuid().optional(),
    }).strict(),
    output: kimiPiRegistrationSchema,
  },
};
