import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { runtimeContextSchema, runtimeViewSchema } from './runtime-contract';

const selection = z.object({ hostId: z.string().min(1), context: runtimeContextSchema }).strict();
export const runtimeSettingsContract = defineRpcContract({
  runtimeHosts: { input: z.null(), output: z.object({ primaryHostId: z.string().nullable(),
    hosts: z.array(z.object({ id: z.string(), name: z.string() }).strict()) }).strict() },
  runtimeStatus: { input: selection, output: runtimeViewSchema },
  runtimeRepair: { input: selection.extend({ portableNode: z.boolean().optional() }).strict(), output: runtimeViewSchema },
  runtimeCancelPreparation: { input: z.object({ hostId: z.string().min(1) }).strict(), output: runtimeViewSchema },
});
