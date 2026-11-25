import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { definePluginApp, useBbContext, useBbNavigate, useRpc, useRealtime } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './account-module';
import { accountIdentity, hasCompanyMembership, type AccountView, type OnboardingView } from './contracts';
import type { PluginNavPanelProps } from '@get-bb/plugin-sdk/app';
import catalog from './onboarding-catalog.json';
import { HARNESS_SOURCE } from '../harness-source';
import { OnboardingJourney } from './OnboardingJourney';
import { setupSteps, setupTasks } from './onboarding-start';
import { nextOnboardingStages } from './onboarding-stages';
import { cacheCabinetSnapshot, clearCabinetSnapshots, readCabinetSnapshot } from './cabinet-cache';
import { CompanyList, clearCompanyDirectories } from '../CompanyList';
import { clearWorkplaceOverview, readWorkplaceOverview } from '../workplace-ui-cache';
import './app.css';
import '../cabinet.css';
import { UserSettings } from '../UserSettings';
import { useUserPreferences } from '../UserPreferences';
import './onboarding-journey.css';

const installHint = `Если скилла onboarding нет, источник — ${HARNESS_SOURCE} (Claude Code/Codex — svaib@svaib, Pi — Git-пакет).`;
const progressCache = new Map<string, OnboardingView>();

export function AccountPage({ production = false, preparationPanels, workspaces = [] }: { production?: boolean; preparationPanels?: ReactNode; workspaces?: { id: string; name: string }[] } = {}) {
  const rpc = useRpc<typeof rpcContract>();
  const personal = useUserPreferences();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const [cached] = useState(() => readCabinetSnapshot(production));
  const [view, setView] = useState<AccountView | null>(cached?.view ?? null);
  const [progress, setProgress] = useState<OnboardingView | null>(cached?.progress ?? null);
  const [accountProgress, setAccountProgress] = useState<OnboardingView | null>(cached?.accountProgress ?? null);
  const [selectionLoaded, setSelectionLoaded] = useState(Boolean(cached));
  const [refreshing, setRefreshing] = useState(true);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const continuing = useRef(false);
  const [companyId, setCompanyId] = useState(cached?.companyId ?? '');
  const currentCompany = useRef(companyId);
  currentCompany.current = companyId;
  const [companies, setCompanies] = useState<NonNullable<NonNullable<AccountView['me']>['companies']>>(cached?.companies ?? []);
  const sequence = useRef(0);
  const currentAccount = useRef<string | null | undefined>(cached?.view.me?.account_id);
  const checkedSelection = useRef(false);
  const lastView = useRef(view);
  lastView.current = view;
  function forget() {
    clearCabinetSnapshots(); clearCompanyDirectories(); clearWorkplaceOverview(); progressCache.clear(); sequence.current++;
    setView(null); setCompanies([]); setProgress(null); setAccountProgress(null);
    setCompanyId(''); setSelectionLoaded(false); setVerified(false);
    currentAccount.current = undefined; checkedSelection.current = false;
  }
  useEffect(() => {
    if (verified && view?.state === 'connected') cacheCabinetSnapshot(production, { view, companyId, companies, progress, accountProgress });
  }, [production, verified, view, companyId, companies, progress, accountProgress]);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    setRefreshing(true);
    try {
      const account = await rpc.call('status', null);
      if (request !== sequence.current) return;
      if (account.state === 'error') throw new Error('account_unavailable');
      const identity = account.state === 'connected' ? account.me?.account_id ?? null : null;
      const changedIdentity = identity !== currentAccount.current;
      const overview = readWorkplaceOverview();
      const memberships = new Set(account.me?.companies?.map(c => c.company_id) ?? []);
      if ((currentAccount.current !== undefined && changedIdentity) ||
          (overview?.accountId !== undefined && (overview.accountId !== identity ||
            overview.workspaces.some(w => w.companyId && !memberships.has(w.companyId))))) clearWorkplaceOverview();
      if (changedIdentity) {
        clearCabinetSnapshots(); clearCompanyDirectories(); progressCache.clear();
        setView(account); setCompanies(account.me?.companies ?? []);
        setProgress(null); setAccountProgress(null); setSelectionLoaded(false); setVerified(false);
      }
      if (changedIdentity || !checkedSelection.current) {
        const saved = identity ? await rpc.call('selectedCompany').catch(() => ({ company_id: changedIdentity ? null : companyId || null })) : { company_id: null };
        if (request !== sequence.current) return;
        currentAccount.current = identity;
        checkedSelection.current = true;
        const next = saved.company_id ?? '';
        setSelectionLoaded(true);
        if (next !== companyId) { setView(account); setProgress(null); setCompanyId(next); return; }
      }
      const selected = companyId ? await rpc.call('status', { company_id: companyId }) : account;
      if (request !== sequence.current) return;
      setCompanies(account.me?.companies ?? []);
      const progressKey = `${identity ?? 'signed-out'}:${companyId}`;
      const cached = identity ? progressCache.get(progressKey) : undefined;
      if (cached) setProgress(cached);
      void rpc.call('onboardingProgress', { company_id: companyId || null }).then(value => {
        if (request === sequence.current) { if (identity && value.status === 'available') { progressCache.set(progressKey, value); if (progressCache.size > 20) progressCache.delete(progressCache.keys().next().value!); } setProgress(value); if (!companyId) setAccountProgress(value); }
      }).catch(() => { if (request === sequence.current) {
        setProgress(previous => previous?.status === 'available' ? previous : { status: 'unavailable', onboarding: null, nextStep: null, role: null });
        setError('Не удалось обновить этапы. Показано последнее загруженное состояние.');
      } });
      if (companyId) void rpc.call('onboardingProgress', { company_id: null }).then(value => {
        if (request === sequence.current) setAccountProgress(value);
      }).catch(() => { /* Retain the same account's last observed progress on a transient failure. */ });
      if (companyId && (!account.me || !selected.me || selected.state !== 'connected' ||
          accountIdentity(account.me) !== accountIdentity(selected.me) || !hasCompanyMembership(selected.me) ||
          selected.me.tenant_id !== companyId)) {
        clearCabinetSnapshots(); clearWorkplaceOverview(); progressCache.delete(progressKey); sequence.current++;
        setProgress(null); setVerified(false); setCompanyId('');
        setView(account);
        setError('Компания недоступна в этом подключении. Выбери доступную компанию и повтори.');
        return;
      }
      setView(selected.me && !selected.me.display_name && account.me?.display_name
        ? { ...selected, me: { ...selected.me, display_name: account.me.display_name } } : selected);
      setVerified(true);
    }
    catch { if (request === sequence.current) {
      if (!lastView.current) { setSelectionLoaded(true); setProgress({ status: 'unavailable', onboarding: null, nextStep: null, role: null }); }
      setVerified(false); setError('Не удалось обновить подключение. Повтори обновление.');
    } }
    finally { if (request === sequence.current) setRefreshing(false); }
  }, [rpc, companyId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => { sequence.current++; }, []);
  useRealtime('account-changed', () => { forget(); void refresh(); });
  useRealtime('onboarding-invalidated', () => { void refresh(); });
  // Account marks can also change outside BB, e.g. in Telegram. Re-read when
  // the person returns to this window, without background polling.
  useEffect(() => {
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);
  // Poll only during the interactive login; this is not an agent or a business-data sync.
  useEffect(() => {
    if (view?.state !== 'waiting') return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [view?.state, refresh]);
  async function act(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Действие не завершено. Повтори обновление.'); }
    finally { setBusy(false); }
  }
  function startLogin() {
    // The OAuth callback listens on the BB server's loopback. A remote
    // client still needs the browser on that host to receive the callback.
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
    // Reserve the tab during the click, before the OAuth registration RPC.
    const tab = local ? window.open('about:blank', '_blank') : null;
    if (tab) tab.opener = null;
    void act(async () => {
      if (local) {
        try {
          const { authorizationUrl } = await rpc.call('beginLogin');
          if (!tab) window.location.assign(authorizationUrl);
          else if (tab.closed) await rpc.call('cancelLogin');
          else tab.location.replace(authorizationUrl);
        } catch (error) {
          tab?.close();
          throw error;
        }
      } else {
        await rpc.call('startCabinetLogin');
      }
      await refresh();
    });
  }
  function continueJourney(stepId?: string) {
    const company = companies.find(item => item.company_id === companyId);
    const choice = company ? ` Моя компания: ${company.company_name || company.tenant_name || (view?.me?.tenant_id === company.company_id && view.me.tenant_name) || company.company_id} (ID: ${company.company_id}).` : '';
    const task = setupTasks.find(item => item.id === stepId);
    const stageTitle = task?.title || catalog.stages.find(item => item.id === stepId)?.title;
    const stage = stageTitle && stepId !== 'space' ? ` Шаг: «${stageTitle}».` : '';
    const marks = progress?.status === 'available' ? progress.onboarding.marks : {};
    const groupStages = task?.stages ?? [];
    const firstWork = stepId === 'first-work' && groupStages.length > 0 &&
      groupStages.slice(0, -1).every(id => marks[id]?.state === 'done') && marks[groupStages.at(-1)!]?.state !== 'done';
    const prompt = firstWork ? 'Профиль и зона ответственности уже подготовлены. Помоги перейти к первой полезной задаче с агентом svaib.'
      : stepId === 'space' ? 'Помоги подключить рабочую папку компании по скиллу onboarding.'
      : task ? 'Продолжи онбординг svaib по установленному скиллу.' : 'Помоги продолжить настройку svaib.';
    const initialPrompt = `${prompt}${stage}${choice} ${installHint}`;
    if (!verified || !view?.me?.account_id) { navigate.toCompose({ initialPrompt, focusPrompt: false }); return; }
    if (continuing.current) return;
    continuing.current = true;
    const accountId = view.me.account_id;
    void act(async () => {
      try {
        const result = await rpc.call('continueJourney', { accountId: view.me!.account_id!, companyId: companyId || null,
          currentThreadId: context.threadId ?? null, prompt: initialPrompt });
        if (currentAccount.current !== accountId || currentCompany.current !== companyId) return;
        const { kind, ...options } = result;
        navigate.toCompose({ ...options, focusPrompt: false });
      } finally { continuing.current = false; }
    });
  }
  const setup = setupSteps({ accountReady: view?.state === 'connected', companySelected: !!companyId,
    accountProgress, progress });
  const setupComplete = setup.every(step => step.state === 'done');
  const next = progress?.status === 'available' ? nextOnboardingStages(catalog, progress.onboarding, progress.role) : null;
  const selectedCompanyName = companies.find(c => c.company_id === companyId)?.company_name || companies.find(c => c.company_id === companyId)?.tenant_name || companyId;
  const displayName = view?.me?.display_name;
  const initials = (displayName || 's').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  return <div className="svaib-account-viewport"><main className="svaib-account" aria-label="Мой svaib">
    {preparationPanels && <div className="svaib-account-preparation">{preparationPanels}</div>}
    <section className="svaib-account-identity" aria-label="Аккаунт svaib">
      <div className="svaib-account-section-heading"><p className="svaib-account-eyebrow">{production ? 'Личный кабинет' : 'Тестовый контур · Staging'}</p>
        {refreshing && view && <span className="svaib-account-note" role="status">Обновляю данные…</span>}
      </div>
      <div className="svaib-account-person"><span className="svaib-account-avatar" aria-hidden="true">{initials}</span><div>
        <h1>{displayName || (view?.state === 'signed-out' ? 'Твой аккаунт svaib' : 'Мой svaib')}</h1>
        <p className="svaib-account-note">{view?.state === 'connected' ? 'Аккаунт svaib подключён' : view?.state === 'waiting' ? 'Заверши вход в открывшемся браузере.' : view?.state === 'signed-out' ? 'Войди, чтобы работать с агентом и своими компаниями.' : 'Проверяю подключение…'}</p>
      </div></div>
      {view?.me && <div className="svaib-account-identity-detail">
        {hasCompanyMembership(view.me)
          ? <p>{view.me.tenant_name || view.me.tenant_id} · {view.me.role === 'owner' ? 'Владелец' : 'Участник'}</p>
          : <p>Компания ещё не выбрана.</p>}
        {companies.length > 0 && <label className="svaib-account-company">Компания<select value={companyId} disabled={busy || !verified} onChange={event => { const next = event.currentTarget.value; void act(async () => { await rpc.call('selectCompany', { company_id: next || null }); setVerified(false); setProgress(null); setCompanyId(next); }); }}>
          <option value="">Аккаунт без выбранной компании</option>
          {companies.map(company => <option key={company.company_id} value={company.company_id}>{company.company_name || company.tenant_name || (view.me?.tenant_id === company.company_id && view.me.tenant_name) || company.company_id}</option>)}
        </select></label>}
      </div>}
      {view?.message && <p role="status" className="svaib-account-note">{view.message}</p>}
      {view?.state === 'waiting' && <div className="svaib-account-login">
        <p>Подтверди вход в уже открытом браузере или отмени незавершённый вход.</p>
        <button className="svaib-account-button" disabled={busy} onClick={() => void act(async () => { await rpc.call('cancelLogin'); await refresh(); })}>Отменить вход</button>
      </div>}
      {error && <p role="alert" className="svaib-account-error">{error}</p>}
    </section>
    {view?.state === 'signed-out' ? <section className="svaib-journey"><h2>Начало работы</h2><p className="svaib-account-note">Войди в svaib, чтобы продолжить настройку и выбрать компанию.</p>
      <button className="svaib-journey-action" disabled={busy} onClick={startLogin}>Войти в svaib</button></section> :
    view?.state === 'waiting' ? <section className="svaib-journey"><h2>Начало работы</h2><p role="status" className="svaib-account-note">После входа здесь появятся шаги для работы с агентом.</p></section> :
    !selectionLoaded || !progress ? <section className="svaib-journey"><h2>Начало работы</h2><p role="status" className="svaib-account-note">Проверяю этапы…</p></section> : progress.status === 'unavailable' ?
      <section className="svaib-journey"><h2>Начало работы</h2>
        <p role="status" className="svaib-account-note">Не удалось загрузить этапы. Можно продолжить работу с агентом.</p>
        <button type="button" className="svaib-journey-action" onClick={() => continueJourney()}>Продолжить</button>
      </section> :
      <OnboardingJourney setup={setup} setupComplete={setupComplete} busy={busy || !verified}
        showNextSteps={personal?.snapshot?.accountId === view?.me?.account_id ? personal?.snapshot?.preferences.showNextSteps : true}
        contextLabel={companyId ? `Компания: ${selectedCompanyName}` : undefined}
        nextSteps={next?.stages.map(stage => ({ id: stage.id, title: stage.title, state: stage.state ?? 'next' })) ?? []}
        stagesAvailable={next?.status === 'available'} onContinue={continueJourney} />}
    {production && view?.me?.account_id ? <CompanyList key={view.me.account_id} accountId={view.me.account_id} companies={companies}
      selectedCompanyId={companyId} verified={verified} onConnect={(company, target) => navigate.toCompose({ initialPrompt: `Помоги выбрать или открыть локальную папку для работы с компанией «${company.name}» (ID: ${company.companyId}). Проверь её привязку по скиллу onboarding. ${installHint}`,
        ...(target ? { projectId: target.projectId, environmentId: target.environmentId } : {}), focusPrompt: false })} />
      : <section className="svaib-companies"><h2>Мои компании</h2><p className="svaib-account-note">{view?.state === 'signed-out' ? 'Твои компании появятся здесь после входа.' : 'Здесь появятся компании, к которым у тебя есть доступ.'}</p></section>}
    <section className="svaib-account-settings" aria-labelledby="svaib-settings-title"><h2 id="svaib-settings-title">Настройки и интерфейс</h2>
      {view?.state === 'connected' && view.me?.account_id ? <UserSettings accountId={view.me.account_id} verified={verified && !busy} workspaces={workspaces} />
        : <p className="svaib-account-note">Личные настройки появятся после входа в svaib.</p>}
      <footer><button className="svaib-account-button" disabled={busy} onClick={() => void act(async () => { await Promise.all([refresh(), personal?.refresh()]); })}>Обновить</button>
        {view && view.state !== 'signed-out' && view.state !== 'waiting' && <button className="svaib-account-button" disabled={busy} onClick={() => void act(async () => {
          forget(); const result = await rpc.call('logout'); await refresh();
          if (!result.revoked) setError('На этом BB подключение удалено. Серверный отзыв не подтверждён.');
        })}>Выйти из кабинета</button>}
      </footer>
    </section>
  </main></div>;
}

export default definePluginApp(app => {
  app.slots.navPanel({ id: 'account', title: 'Мой svaib · прототип', icon: 'UserRound', path: 'account', component: AccountRouter });
});

export function AccountRouter({ production = false, preparationPanels, workspaces }: PluginNavPanelProps & { production?: boolean; preparationPanels?: ReactNode; workspaces?: { id: string; name: string }[] }) {
  return <AccountPage production={production} preparationPanels={preparationPanels} workspaces={workspaces} />;
}
