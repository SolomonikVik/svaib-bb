import { z } from 'zod';
import type { PluginBbSdk } from '@get-bb/plugin-sdk';
import { accountIdentity, type AccountView } from './contracts';
import { supportsConnection } from './connection-providers';

export const journeyInputSchema = z.object({
  accountId: z.string().min(1), companyId: z.string().nullable(),
  currentThreadId: z.string().regex(/^thr_[a-z0-9]+$/).nullable(),
  prompt: z.string().trim().min(1).max(1500),
}).strict();
export const journeyOutputSchema = z.object({ kind: z.literal('compose'), initialPrompt: z.string(),
  projectId: z.string().optional(), environmentId: z.string().optional() }).strict();
type Input = z.infer<typeof journeyInputSchema>;
type ComposeFolder = { projectId: string; environmentId: string };
export type JourneyCompanyFolder = (accountId: string, companyId: string, currentEnvironmentId?: string) => Promise<ComposeFolder | undefined>;

/** The person sends the request themselves: one editable prompt in the native composer. */
export function createJourneyContinuation(d: {
  sdk: PluginBbSdk;
  account(companyId?: string): Promise<AccountView>;
  epoch(): number;
  companyFolder?: JourneyCompanyFolder;
}) {
  return async (raw: Input): Promise<z.infer<typeof journeyOutputSchema>> => {
    const input = journeyInputSchema.parse(raw), epoch = d.epoch();
    const account = await d.account(input.companyId ?? undefined);
    const valid = () => { if (epoch !== d.epoch()) throw new Error('Аккаунт изменился. Повтори продолжение.'); };
    valid();
    if (account.state !== 'connected' || !account.me || accountIdentity(account.me) !== input.accountId ||
        (input.companyId && (account.me.context !== 'company' || account.me.tenant_id !== input.companyId)))
      throw new Error('Аккаунт или компания недоступны. Обнови кабинет.');
    async function currentFolder(): Promise<ComposeFolder | undefined> {
      if (!input.currentThreadId) return;
      try {
        const thread = await d.sdk.threads.get({ threadId: input.currentThreadId });
        if (!thread || thread.deletedAt || thread.archivedAt || !thread.environmentId ||
            !supportsConnection(thread.providerId) || ['stopping', 'error'].includes(thread.status)) return;
        const environment = await d.sdk.environments.get({ environmentId: thread.environmentId });
        const primaryHost = (await d.sdk.system.config()).primaryHostId;
        if (environment.id !== thread.environmentId || environment.projectId !== thread.projectId ||
            environment.hostId !== primaryHost || environment.status !== 'ready') return;
        const after = await d.sdk.threads.get({ threadId: input.currentThreadId });
        if (!after.deletedAt && !after.archivedAt && after.environmentId === environment.id && after.projectId === environment.projectId)
          return { projectId: thread.projectId, environmentId: environment.id };
      } catch { /* The ordinary composer can open without a suggested folder. */ }
    }
    let folder = await currentFolder();
    valid();
    if (input.companyId) {
      folder = await d.companyFolder?.(input.accountId, input.companyId, folder?.environmentId);
      valid();
    }
    return { kind: 'compose', initialPrompt: input.prompt, ...folder };
  };
}
