import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { kimiHostMethods } from '../kimi-contract';
import { kimiPiHostMethods } from '../kimi-pi-contract';
import { runtimeViewSchema, runtimeContextSchema } from '../runtime-contract';

const hookInput = z.object({ executable: z.string().min(1), cwd: z.string().min(1) }).strict();
const hookReview = z.object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/), hooks: z.array(z.object({
  key: z.string(), currentHash: z.string(), trustStatus: z.string(), command: z.string(), statusMessage: z.string().nullable(), sourcePath: z.string(),
}).strict()).min(1).max(128) }).strict();

export const browserContract = defineRpcContract({
  computerPrepare: { input: z.object({ context: runtimeContextSchema.nullable(), cwd: z.string().nullable(),
    update: z.boolean(), trust: z.boolean() }).strict(), output: runtimeViewSchema },
  harnessMaintain: { input: z.object({ target: z.object({ provider: runtimeContextSchema.shape.provider,
    executable: z.string().min(1), args: z.array(z.string()).max(64).optional(), cwd: z.string().min(1), configRoot: z.string().optional() }).strict(),
    options: z.object({ install: z.boolean(), update: z.boolean(), trust: z.boolean() }).strict() }).strict(),
    output: z.object({ state: z.enum(['installed', 'updated', 'checked', 'unchanged', 'skipped']), message: z.string(), version: z.string().optional(), pluginRoot: z.string().optional() }).strict() },
  runtimePrepare: { input: z.object({ context: runtimeContextSchema.optional(), retry: z.boolean().optional(), portableNode: z.boolean().optional() }).strict(), output: runtimeViewSchema },
  runtimeInspect: { input: runtimeContextSchema.nullable(), output: runtimeViewSchema },
  runtimeCancel: { input: z.null(), output: runtimeViewSchema },
  ...kimiHostMethods,
  ...kimiPiHostMethods,
  automaticHooks: { input: hookInput, output: hookReview.extend({ changed: z.boolean() }).strict() },
  openLogin: {
    input: z.object({ url: z.string().url().refine(value => {
      const url = new URL(value);
      return url.origin === 'https://auth.svaib.com' && !url.username && !url.password;
    }) }).strict(), output: z.null(),
  },
});
