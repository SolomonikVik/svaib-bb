import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { AccountController } from './account';
import { accountViewSchema, onboardingViewSchema } from './contracts';
import { SvaibApi } from './api';
import { OAuthConnection, productionOAuth, type OAuthEndpoints, type SessionStore } from './oauth';
import { SvaibMcp } from './mcp';
import type { Fetcher } from './http';
import { browserContract } from './browser-contract';
import { createHookConsent } from './hook-consent';
import { HOOK_TOOL } from './hook-bundle';
import { supportsConnection } from './connection-providers';
import { createJourneyContinuation, journeyInputSchema, journeyOutputSchema, type JourneyCompanyFolder } from './journey-continuation';

export const rpcContract = defineRpcContract({
  onboardingProgress: { input: z.object({ company_id: z.string().min(1).max(64).nullable() }).strict(), output: onboardingViewSchema },
  selectedCompany: { input: z.null(), output: z.object({ company_id: z.string().nullable() }).strict() },
  selectCompany: { input: z.object({ company_id: z.string().min(1).max(64).nullable() }).strict(), output: z.null() },
  status: { input: z.object({ company_id: z.string().min(1).max(64) }).strict().nullable(), output: accountViewSchema },
  continueJourney: { input: journeyInputSchema, output: journeyOutputSchema },
  beginLogin: { input: z.null(), output: z.object({ authorizationUrl: z.string().url() }).strict() },
  startCabinetLogin: { input: z.null(), output: z.null() },
  cancelLogin: { input: z.null(), output: z.null() },
  logout: { input: z.null(), output: z.object({ revoked: z.boolean() }).strict() },
  setWorkspaceCard: {
    input: z.object({ enabled: z.boolean(), expectedRevision: z.number().int().nonnegative(), company_id: z.string().min(1).max(64).optional() }).strict(),
    output: accountViewSchema,
  },
});

export interface AccountModuleOptions {
  sessionStore: SessionStore;
  oauthEndpoints?: OAuthEndpoints;
  apiBase?: string;
  fetcher?: Fetcher;
  companyFolder?: JourneyCompanyFolder;
}
export type AccountModuleApi = Pick<BbPluginApi,
  'pluginId' | 'realtime' | 'onDispose' | 'hosts' | 'sdk' | 'server' | 'storage' | 'agents' | 'events' | 'rpc' | 'ui'>;

/** Cabinet module: cabinet OAuth, account/company data, Codex hook consent and the visible continue prompt. */
export async function registerAccountModule(bb: AccountModuleApi, options: AccountModuleOptions) {
  const endpoints = options.oauthEndpoints ?? productionOAuth();
  const apiBase = options.apiBase ?? 'https://api.svaib.com';
  if (apiBase !== new URL(endpoints.resource).origin) throw new Error('resource_api_mismatch');
  const fetcher = options.fetcher ?? fetch;
  const changed = () => bb.realtime.publish('account-changed', null);
  const oauth = new OAuthConnection(options.sessionStore, changed, fetcher, endpoints);
  bb.onDispose(() => oauth.dispose());
  const account = new AccountController(oauth, new SvaibApi(fetcher, apiBase), new SvaibMcp(fetcher, endpoints.resource));
  if (endpoints.resource !== 'https://api.svaib.com/mcp' || apiBase !== 'https://api.svaib.com') throw new Error('production_resource_required');
  const browser = bb.hosts.experimental_client({ contract: browserContract });
  const reviewHooks = createHookConsent(bb);
  bb.agents.registerTool({ name: HOOK_TOOL, description: 'Проверяет и автоматически подключает все хуки установленного svaib@svaib в текущем Codex; другие плагины не изменяются.',
    parameters: z.object({}).strict(),
    execute: async (_, ctx) => JSON.stringify(await reviewHooks(ctx)) });
  let disposed = false;
  bb.onDispose(() => { disposed = true; });
  const continueJourney = createJourneyContinuation({ sdk: bb.sdk, account: id => account.view(id),
    epoch: () => oauth.epoch, companyFolder: options.companyFolder });
  bb.events.on('thread.idle', async ({ thread }) => {
    if (disposed || thread.status !== 'idle' || thread.deletedAt || !thread.environmentId) return;
    // Native MCP can update account/membership progress in any ordinary chat.
    // Idle only invalidates the shared cabinet; fresh server data decides stages.
    if (!supportsConnection(thread.providerId) ||
        (await account.view()).state !== 'connected' || disposed) return;
    bb.realtime.publish('onboarding-invalidated', null);
  });
  bb.rpc.register(rpcContract, {
    onboardingProgress: input => input.company_id ? account.companyOnboarding(input.company_id) : account.onboarding(),
    selectedCompany: async () => {
      const view = await account.view();
      const id = view.me?.account_id;
      if (!id || view.state !== 'connected') return { company_id: null };
      const saved = await bb.storage.kv.get<string>('cabinet:company:' + id);
      return { company_id: typeof saved === 'string' && view.me?.companies?.some(c => c.company_id === saved) ? saved : null };
    },
    selectCompany: async ({ company_id }) => {
      const view = await account.view();
      const id = view.me?.account_id;
      if (!id || view.state !== 'connected') throw new Error('Войди в аккаунт, чтобы выбрать компанию.');
      if (company_id && !view.me?.companies?.some(c => c.company_id === company_id)) throw new Error('Компания недоступна этому аккаунту.');
      await bb.storage.kv.set('cabinet:company:' + id, company_id);
      return null;
    },
    status: input => account.view(input?.company_id),
    continueJourney,
    beginLogin: () => {
      if (!endpoints.clientId?.trim() && !endpoints.registration) throw new Error('Сначала укажи OAuth client ID тестового контура в настройках плагина и перезагрузи его.');
      return oauth.begin();
    },
    startCabinetLogin: async () => {
      const { primaryHostId } = await bb.sdk.system.config();
      if (!primaryHostId) throw new Error('Не удалось найти компьютер для входа.');
      const { authorizationUrl } = await oauth.begin();
      try { await browser.call('openLogin', { url: authorizationUrl }, { hostId: primaryHostId }); }
      catch (error) { oauth.cancel(); throw error; }
      return null;
    },
    cancelLogin: () => { oauth.cancel(); return null; },
    logout: () => oauth.logout(),
    setWorkspaceCard: async ({ enabled, expectedRevision, company_id }) => {
      const view = await account.workspaceCard(enabled, expectedRevision, company_id);
      changed(); return view;
    },
  });
  return {
    account, epoch: () => oauth.epoch,
    verifiedCompany: account.verifiedCompany.bind(account),
    callMcpForContext: account.callMcpForContext.bind(account),
  };
}
