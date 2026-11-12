import { z } from 'zod';
export const runtimeViewSchema = z.object({ platform: z.string(), status: z.enum(['idle', 'preparing', 'ready', 'failed']),
  step: z.string(), message: z.string(), python: z.string().optional(), git: z.string().optional(), bash: z.string().optional(),
  node: z.string().optional(), npmCli: z.string().optional(), path: z.string().optional(),
  versions: z.record(z.string(), z.string()).optional() }).strict();
export type RuntimeView = z.infer<typeof runtimeViewSchema>;
export const runtimeProgressSchema = runtimeViewSchema.pick({ platform: true, status: true, step: true, message: true });
export const runtimeSignals = { runtimeProgress: { payload: runtimeProgressSchema } };
