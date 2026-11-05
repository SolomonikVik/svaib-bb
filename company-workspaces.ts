import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { PluginBbSdk, PluginKvStorage } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import type { CatalogWorkspace, WorkplaceConfig } from './config';
import type { AccountView } from './experiments/account-prototype/contracts';
import { validatePersistentFolder } from './experiments/account-prototype/folder-selection';
import { readScreenCompanyBinding, type PersistentRootValidator, type VerifiedScreenCompany } from './screen-native-context';

export const companySelector = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const companyRowSchema = z.object({ companyId: companySelector, name: z.string(), role: z.enum(['owner', 'member']),
  visible: z.boolean(), ready: z.boolean(), workspaceId: z.string().nullable(), projectName: z.string().nullable(), issue: z.string().nullable(),
  localPath: z.string().nullable(),
}).strict();
export const companyDirectorySchema = z.object({ accountId: z.string().nullable(), companies: z.array(companyRowSchema) }).strict();
export type CompanyDirectory = z.infer<typeof companyDirectorySchema>;
export const targetSchema = z.object({ environmentId: z.string(), projectName: z.string(), path: z.string() }).strict();
export type CompanyTarget = z.infer<typeof targetSchema>;
export const companyWorkspaceRpc = {
  companyDirectory: { input: z.null(), output: companyDirectorySchema },
  companyTargets: { input: z.object({ companyId: companySelector }).strict(), output: z.array(targetSchema) },
  bindCompanyWorkspace: { input: z.object({ companyId: companySelector, environmentId: z.string().min(1).max(256) }).strict(), output: companyDirectorySchema },
  showCompanyTab: { input: z.object({ companyId: companySelector, visible: z.boolean() }).strict(), output: companyDirectorySchema },
};
const bindingSchema = z.object({ environmentId: z.string(), projectId: z.string(), hostId: z.string(), visible: z.boolean(), root: z.string() }).strict();
type Binding = z.infer<typeof bindingSchema>;
const preferencesSchema = z.record(companySelector, bindingSchema);
type AccountPort = { account: { view(): Promise<AccountView> }; epoch(): number;
  verifiedCompany(companyId: string, signal?: AbortSignal): Promise<VerifiedScreenCompany> };
export const companyWorkspaceId = (company: string) => 'company-' + createHash('sha256').update(company).digest('hex').slice(0, 24);
export const isCompanyWorkspace = (id: string) => /^company-[a-f0-9]{24}$/.test(id);
const scopeSchema = z.object({ root: z.string(), hostId: z.string() }).strict();
export type CompanyProfileScope = z.infer<typeof scopeSchema>;
export function matchesCompanyProfileScope(workspace: CatalogWorkspace, scopes: readonly CompanyProfileScope[]) {
  if (workspace.personal || workspace.clientHub || workspace.linkHub) return false;
  let root = workspace.root;
  try { root = realpathSync(root); } catch { /* The declared path still belongs to its claimed company if it is missing. */ }
  return scopes.some(scope => {
    const path = relative(scope.root, root);
    return scope.hostId === workspace.hostId && (path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)));
  });
}

/** Personal BB preferences; membership and folder bindings are checked independently on every read. */
export function createCompanyWorkspaces(options: { sdk: PluginBbSdk; kv: PluginKvStorage; account: AccountPort;
  legacy(): Promise<WorkplaceConfig>; validateRoot?: PersistentRootValidator; onClaimed?(ids: string[]): void;
  onScopesChanged?(scopes: CompanyProfileScope[]): void }) {
  const { sdk, kv, account } = options;
  const key = (id: string) => 'workplace:companies:' + id;
  const queues = new Map<string, Promise<unknown>>();
  const claimsKey = 'workplace:company-profile-claims';
  const scopesKey = 'workplace:company-profile-scopes';
  async function claimedScopes(): Promise<CompanyProfileScope[]> {
    const value = await kv.get(scopesKey);
    return value === undefined ? [] : z.array(scopeSchema).parse(value);
  }
  async function claimedLegacyIds(): Promise<string[]> {
    const value = await kv.get(claimsKey);
    return value === undefined ? [] : z.array(z.string()).parse(value);
  }
  async function principal() {
    const epoch = account.epoch();
    const view = await account.account.view();
    if (epoch !== account.epoch()) throw new Error('Подключение изменилось. Обнови кабинет.');
    if (view.state === 'error') throw new Error('Не удалось проверить доступ к компаниям. Повтори обновление.');
    return { id: view.state === 'connected' ? view.me?.account_id ?? null : null,
      companies: view.state === 'connected' ? view.me?.companies ?? [] : [], epoch };
  }
  function unchanged(epoch: number) {
    if (account.epoch() !== epoch) throw new Error('Подключение изменилось. Обнови кабинет.');
  }
  async function preferences(id: string) {
    const raw = await kv.get(key(id));
    return raw === undefined ? {} : preferencesSchema.parse(raw);
  }
  async function checked(companyId: string, environmentId: string, expected?: Binding) {
    const epoch = account.epoch();
    const member = await account.verifiedCompany(companyId);
    const environment = await sdk.environments.get({ environmentId });
    const [system, project] = await Promise.all([sdk.system.config(), sdk.projects.get({ projectId: environment.projectId })]);
    if (environment.id !== environmentId || project.id !== environment.projectId || environment.status !== 'ready' || environment.workspaceProvisionType !== 'unmanaged' ||
        environment.hostId !== system.primaryHostId || !environment.path || project.kind !== 'standard' ||
        !project.sources.some(s => s.type === 'local_path' && s.projectId === project.id && s.hostId === environment.hostId && s.path === environment.path)) {
      throw new Error('Выбери постоянную локальную папку компании в обычном проекте BB.');
    }
    if (options.validateRoot) await options.validateRoot(environment.path, environment.hostId, environment);
    else await validatePersistentFolder(sdk, environment.hostId, environment, environment.path);
    const binding = await readScreenCompanyBinding(environment.path);
    if (binding.companyId !== companyId || binding.realRoot !== environment.path || (expected && (expected.root !== binding.realRoot ||
        expected.projectId !== project.id || expected.hostId !== environment.hostId)))
      throw new Error('Эта папка привязана к другой компании или была изменена. Проверь подключение пространства.');
    unchanged(epoch);
    if (member.epoch !== epoch) throw new Error('Подключение изменилось. Обнови кабинет.');
    return { environment, project, root: binding.realRoot, member };
  }
  async function materialize(companyId: string, name: string, binding: Binding) {
    const verified = await checked(companyId, binding.environmentId, binding);
    const { environment, project, root } = verified;
    const legacy = await options.legacy();
    const candidates = legacy.workspaces.filter(w => !w.personal && !w.linkHub && !w.clientHub &&
      w.projectId === project.id && w.environmentId === environment.id && w.hostId === environment.hostId && w.root === root);
    const prepared = candidates.length === 1 ? candidates[0] : undefined;
    const sources: CatalogWorkspace['sources'] = [];
    // Bounded canonical entry points only. Their contents are read on explicit document/action selection.
    for (const [id, title, path] of [['overview', 'Обзор компании', '01_company/01_overview.md'],
      ['goal', 'Цель компании', '01_company/01_strategic/goal.md'], ['active', 'Текущая работа', '01_company/02_active.md'],
      ['decisions', 'Решения компании', '01_company/05_decisions.md'], ['map', 'Карта пространства', 'README.md']]) {
      try { if ((await lstat(join(root, path))).isFile() && await realpath(join(root, path)) === join(root, path)) sources.push({ id, title, path: join(root, path) }); }
      catch { /* Missing source is an empty state, not an invented document. */ }
    }
    unchanged(verified.member.epoch);
    const workspace: CatalogWorkspace = { ...(prepared ?? {
      eyebrow: 'Рабочее место компании', description: 'Материалы компании и работа с партнёром.',
      goalLabel: 'Куда идём', goal: 'Сводка ещё не подготовлена. Начни с материалов компании или вопроса партнёру.',
      snapshotAt: '', sources, signals: [], actions: [{ id: 'partner', title: 'Обсудить с партнёром',
        description: 'Задать вопрос по материалам компании.', icon: 'MessageSquare', prompt: 'Помоги разобраться с моим вопросом по компании.',
        method: 'Начни с инструкций и карты выбранного пространства. Поднимай только нужные материалы.', sourceIds: [] }],
    }), ...(prepared ? { metricsUpdateWorkspaceId: prepared.id } : {}), id: companyWorkspaceId(companyId), name, companyId, root, projectId: project.id, environmentId: environment.id, hostId: environment.hostId };
    return { workspace, legacyId: prepared?.id, projectName: project.name, member: verified.member };
  }
  async function catalog(): Promise<{ accountId: string | null; companies: CompanyDirectory['companies'];
    workspaces: { workspace: CatalogWorkspace; visible: boolean; member: VerifiedScreenCompany }[]; replaced: string[] }> {
    const p = await principal();
    const [claimedIds, scopes, legacy] = await Promise.all([claimedLegacyIds(), claimedScopes(), options.legacy()]);
    const claimed = [...new Set([...claimedIds, ...legacy.workspaces.filter(w => matchesCompanyProfileScope(w, scopes)).map(w => w.id)])];
    if (!p.id) return { accountId: null, companies: [], workspaces: [], replaced: claimed };
    const prefs = await preferences(p.id);
    const workspaces: { workspace: CatalogWorkspace; visible: boolean; member: VerifiedScreenCompany }[] = [];
    const replaced: string[] = [...claimed];
    const companies = await Promise.all(p.companies.map(async c => {
      const binding = prefs[c.company_id];
      const base = { companyId: c.company_id, name: c.company_name || c.tenant_name || c.company_id, role: c.role ?? 'member' as const,
        visible: false, ready: false, workspaceId: null, projectName: null, localPath: null, issue: null };
      if (!binding) return base;
      try {
        const built = await materialize(c.company_id, base.name, binding);
        if (built.member.account_id !== p.id) throw new Error('account_changed');
        workspaces.push({ workspace: built.workspace, visible: binding.visible, member: built.member });
        if (built.legacyId && !replaced.includes(built.legacyId)) replaced.push(built.legacyId);
        return { ...base, visible: binding.visible, ready: true, workspaceId: built.workspace.id, projectName: built.projectName, localPath: built.workspace.root };
      } catch {
        return { ...base, issue: 'Подключение пространства нужно проверить.' };
      }
    }));
    unchanged(p.epoch);
    return { accountId: p.id, companies, workspaces, replaced };
  }
  async function targets(companyId: string): Promise<CompanyTarget[]> {
    const p = await principal();
    if (!p.id || !p.companies.some(c => c.company_id === companyId)) throw new Error('Компания недоступна этому аккаунту.');
    const hostId = (await sdk.system.config()).primaryHostId;
    if (!hostId) return [];
    const result: CompanyTarget[] = [];
    // Only registered ready environments; no filesystem traversal or guessed project IDs.
    for (let offset = 0; ; offset += 100) {
      const environments = await sdk.environments.list({ hostId, status: 'ready', limit: 100, offset });
      for (const env of environments) {
        if (env.workspaceProvisionType !== 'unmanaged') continue;
        try { const target = await checked(companyId, env.id); result.push({ environmentId: env.id, projectName: target.project.name, path: target.root }); }
        catch { /* An unrelated or invalid environment is not offered for this company. */ }
      }
      if (environments.length < 100) break;
    }
    unchanged(p.epoch);
    return result;
  }
  async function update(companyId: string, edit: (previous: Binding | undefined) => Promise<Binding>) {
    const p = await principal();
    if (!p.id || !p.companies.some(c => c.company_id === companyId)) throw new Error('Компания недоступна этому аккаунту.');
    const id = p.id;
    const job = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      unchanged(p.epoch);
      const prefs = await preferences(id);
      const value = await edit(prefs[companyId]);
      unchanged(p.epoch);
      const scopes = await claimedScopes();
      if (!scopes.some(s => s.root === value.root && s.hostId === value.hostId)) {
        const next = [...scopes, { root: value.root, hostId: value.hostId }];
        await kv.set(scopesKey, next);
        options.onScopesChanged?.(next);
      }
      // Once a local profile is adopted by a company it must never reappear as
      // an unscoped legacy tab after logout, revoked membership, or a broken folder.
      const legacy = await options.legacy();
      const adopted = legacy.workspaces.filter(w => !w.personal && !w.clientHub && !w.linkHub &&
        w.root === value.root && w.projectId === value.projectId && w.environmentId === value.environmentId && w.hostId === value.hostId);
      if (adopted.length) {
        const claimed = await claimedLegacyIds();
        const next = [...new Set([...claimed, ...adopted.map(w => w.id)])];
        await kv.set(claimsKey, next);
        options.onClaimed?.(next);
      }
      unchanged(p.epoch);
      await kv.set(key(id), { ...prefs, [companyId]: value });
      unchanged(p.epoch);
    });
    queues.set(id, job);
    try { await job; } finally { if (queues.get(id) === job) queues.delete(id); }
    return directory();
  }
  async function directory(): Promise<CompanyDirectory> { const { accountId, companies } = await catalog(); return { accountId, companies }; }
  return { catalog, directory, targets, claimedLegacyIds, claimedScopes,
    threadWorkspace: async (workspaceId: string, environmentId: string) => {
      const p = await principal();
      const c = p.companies.find(c => companyWorkspaceId(c.company_id) === workspaceId);
      if (!p.id || !c) throw new Error('Компания недоступна этому аккаунту.');
      const checkedTarget = await checked(c.company_id, environmentId);
      const built = await materialize(c.company_id, c.company_name || c.tenant_name || c.company_id, {
        environmentId, projectId: checkedTarget.project.id, hostId: checkedTarget.environment.hostId, root: checkedTarget.root, visible: true,
      });
      unchanged(p.epoch);
      if (built.member.account_id !== p.id) throw new Error('Подключение изменилось.');
      return built.workspace;
    },
    bind: (companyId: string, environmentId: string) => update(companyId, async () => {
      const verified = await checked(companyId, environmentId);
      return { environmentId, projectId: verified.project.id, hostId: verified.environment.hostId, root: verified.root, visible: true };
    }),
    show: (companyId: string, visible: boolean) => update(companyId, async previous => {
      if (!previous) throw new Error('Сначала подключи пространство компании.');
      await checked(companyId, previous.environmentId, previous);
      return { ...previous, visible };
    }),
  };
}
