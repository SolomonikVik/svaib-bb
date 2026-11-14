import { z } from 'zod';

/** A requirement belongs to an operation, never to the whole execution host. */
export const runtimeContextSchema = z.object({
  provider: z.enum(['codex', 'claude-code', 'acp-claude-kimi', 'pi']),
  action: z.enum(['dispatch', 'setup', 'install', 'cli']),
  executable: z.string().min(1).optional(), args: z.array(z.string()).max(64).optional(),
  hooks: z.boolean().optional(),
}).strict();
export type RuntimeContext = z.infer<typeof runtimeContextSchema>;
export const runtimeRequirementSchema = z.enum(['python', 'bash', 'node', 'npm', 'bb', 'launcher']);
export type RuntimeRequirement = z.infer<typeof runtimeRequirementSchema>;
export function requirementsFor(context: RuntimeContext | null = null, platform = 'win32'): RuntimeRequirement[] {
  // A missing context is the old explicit general-computer preparation action.
  if (!context) return platform === 'win32' ? ['python', 'bash', 'node', 'npm', 'bb'] : ['python'];
  const requirements: RuntimeRequirement[] = context.hooks === false || (context.action === 'cli' && context.hooks !== true) ? [] : ['python'];
  if (platform === 'win32' && context.action !== 'cli' && ['claude-code', 'acp-claude-kimi'].includes(context.provider)) requirements.push('bash');
  // Non-Windows managed installers obtain their own runtime; native BB Pi
  // installs use BB's toolchain rather than a system npm.
  if (context.action === 'install' && platform === 'win32') requirements.push('node', 'npm');
  if (context.action === 'cli') requirements.push('bb');
  // Setup prepares prerequisites before the owned profile/registration is repaired.
  // Requiring its old launcher here would prevent rebuilding a broken profile.
  if (context.action === 'dispatch') requirements.push('launcher');
  return requirements;
}
export const runtimeViewSchema = z.object({ platform: z.string(), status: z.enum(['idle', 'preparing', 'ready', 'failed']),
  step: z.string(), message: z.string(), python: z.string().optional(), git: z.string().optional(), bash: z.string().optional(),
  node: z.string().optional(), npmCli: z.string().optional(), path: z.string().optional(),
  versions: z.record(z.string(), z.string()).optional(), context: runtimeContextSchema.optional(),
  requirements: z.array(runtimeRequirementSchema).optional(), missing: z.array(runtimeRequirementSchema).optional(),
  operationError: z.string().optional(), installerUncertain: z.boolean().optional(),
}).strict();
export type RuntimeView = z.infer<typeof runtimeViewSchema>;
export const runtimeProgressSchema = runtimeViewSchema.pick({ platform: true, status: true, step: true, message: true, context: true });
export const runtimeSignals = { runtimeProgress: { payload: runtimeProgressSchema } };
