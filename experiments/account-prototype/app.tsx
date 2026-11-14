import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { definePluginApp, useBbNavigate, useRpc, useRealtime } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './account-module';
import { accountIdentity, hasCompanyMembership, type AccountView, type OnboardingView } from './contracts';
import type { PluginNavPanelProps } from '@get-bb/plugin-sdk/app';
import type { ConnectFlowView } from './connect-flow';
import catalog from './onboarding-catalog.json';
import { PartnerSetup } from './PartnerSetup';
import { OnboardingJourney } from './OnboardingJourney';
import { setupSteps, setupTasks } from './onboarding-start';
import { nextOnboardingStages } from './onboarding-stages';
import { cacheCabinetSnapshot, clearCabinetSnapshots, readCabinetSnapshot } from './cabinet-cache';
import { CompanyList, clearCompanyDirectories } from '../../CompanyList';
import { clearWorkplaceOverview, readWorkplaceOverview } from '../../workplace-ui-cache';
import './app.css';
import '../../cabinet.css';
import { UserSettings } from '../../UserSettings';
import { useUserPreferences } from '../../UserPreferences';
import './onboarding-journey.css';

const progressCache = new Map<string, OnboardingView>();

export function AccountPage({ production = false, preparationPanels, workspaces = [] }: { production?: boolean; preparationPanels?: ReactNode; workspaces?: { id: string; name: string }[] } = {}) {
  const rpc = useRpc<typeof rpcContract>();
  const personal = useUserPreferences();
  const navigate = useBbNavigate();
  const [cached] = useState(() => readCabinetSnapshot(production));
  const [view, setView] = useState<AccountView | null>(cached?.view ?? null);
  const [connection, setConnection] = useState<ConnectFlowView | null>(null);
  const [comparison, setComparison] = useState<'unknown' | 'match' | 'mismatch'>('unknown');
  const [nativeHost, setNativeHost] = useState<string | null>(null);
  const [progress, setProgress] = useState<OnboardingView | null>(cached?.progress ?? null);
  const [accountProgress, setAccountProgress] = useState<OnboardingView | null>(cached?.accountProgress ?? null);
  const [selectionLoaded, setSelectionLoaded] = useState(Boolean(cached));
  const [refreshing, setRefreshing] = useState(true);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [companyId, setCompanyId] = useState(cached?.companyId ?? '');
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
      const [account, flow, native] = await Promise.all([rpc.call('status', null), rpc.call('connectionStatus').catch(() => null),
        rpc.call('compareNativeAccount').catch(() => ({ status: 'unknown' as const, observedAt: null, hostId: null }))]);
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
      setComparison(native.status);
      setNativeHost(native.hostId);
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
        setView(account); setConnection(flow);
        setError('Компания недоступна в этом подключении. Выбери доступную компанию и повтори.');
        return;
      }
      setView(selected.me && !selected.me.display_name && account.me?.display_name
        ? { ...selected, me: { ...selected.me, display_name: account.me.display_name } } : selected);
      setConnection(flow); setError(flow ? '' : 'Не удалось загрузить статус настройки. Обнови страницу или начни обычный разговор в BB.');
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
    if (view?.state !== 'waiting' && (nativeHost || !['setup', 'verify', 'cabinet'].includes(connection?.stage ?? ''))) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [view?.state, connection?.stage, nativeHost, refresh]);
  async function act(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Действие не завершено. Повтори обновление.'); }
    finally { setBusy(false); }
  }
  function continueJourney(stepId?: string) {
    const company = companies.find(item => item.company_id === companyId);
    const choice = company ? ` Моя компания: ${company.company_name || company.tenant_name || (view?.me?.tenant_id === company.company_id && view.me.tenant_name) || company.company_id} (ID: ${company.company_id}).` : '';
    const task = setupTasks.find(item => item.id === stepId);
    const stageTitle = task?.title || catalog.stages.find(item => item.id === stepId)?.title;
    const stage = stageTitle ? ` Хочу продолжить: «${stageTitle}».` : '';
    const marks = progress?.status === 'available' ? progress.onboarding.marks : {};
    const firstWork = stepId === 'first-work' && marks['user.profile']?.state === 'done' &&
      marks['user.zone']?.state === 'done' && marks['user.first-work']?.state !== 'done';
    const prompt = firstWork ? 'Профиль и зона ответственности уже подготовлены. Помоги перейти к первой полезной задаче с партнёром svaib.' : task?.prompt;
    navigate.toCompose({ initialPrompt: `${prompt || 'Помоги продолжить настройку svaib.'}${stage}${choice} Продолжим в папке текущего проекта.`, focusPrompt: false });
  }
  const setup = setupSteps({ accountReady: view?.state === 'connected', companySelected: !!companyId,
    accountProgress, progress });
  const setupComplete = setup.every(step => step.state === 'done');
  const next = progress?.status === 'available' ? nextOnboardingStages(catalog, progress.onboarding, progress.role) : null;
  const selectedCompanyName = companies.find(c => c.company_id === companyId)?.company_name || companies.find(c => c.company_id === companyId)?.tenant_name || companyId;
  const displayName = view?.me?.display_name || view?.me?.subject_id;
  const initials = (displayName || 's').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  return <div className="svaib-account-viewport"><main className="svaib-account" aria-label="Мой svaib">
    {preparationPanels && <div className="svaib-account-preparation">{preparationPanels}</div>}
    <section className="svaib-account-identity" aria-label="Аккаунт svaib">
      <div className="svaib-account-section-heading"><p className="svaib-account-eyebrow">{production ? 'Личный кабинет' : 'Тестовый контур · Staging'}</p>
        {refreshing && view && <span className="svaib-account-note" role="status">Обновляю данные…</span>}
      </div>
      <div className="svaib-account-person"><span className="svaib-account-avatar" aria-hidden="true">{initials}</span><div>
        <h1>{displayName || (view?.state === 'signed-out' ? 'Твой аккаунт svaib' : 'Мой svaib')}</h1>
        <p className="svaib-account-note">{view?.state === 'connected' ? 'Аккаунт svaib подключён' : view?.state === 'waiting' ? 'Заверши вход в открывшемся браузере.' : view?.state === 'signed-out' ? 'Войди, чтобы работать с партнёром и своими компаниями.' : 'Проверяю подключение…'}</p>
      </div></div>
      {view?.me && <div className="svaib-account-identity-detail">
        {hasCompanyMembership(view.me)
          ? <p>{view.me.tenant_name || view.me.tenant_id} · {view.me.role === 'owner' ? 'Владелец' : 'Участник'}</p>
          : <p>Компания ещё не выбрана.</p>}
        {comparison === 'match' && <p className="svaib-account-note" role="status">Последний вход партнёра и кабинет: один аккаунт.</p>}
        {comparison === 'mismatch' && <p className="svaib-account-error" role="alert">В кабинете и у партнёра разные аккаунты. Чтобы сверить их, войди в нужный аккаунт.</p>}
        {!production && companies.length > 0 && <label className="svaib-account-company">Компания<select value={companyId} disabled={busy || !verified} onChange={event => { const next = event.currentTarget.value; void act(async () => { await rpc.call('selectCompany', { company_id: next || null }); setVerified(false); setProgress(null); setCompanyId(next); }); }}>
          <option value="">Аккаунт без выбранной компании</option>
          {companies.map(company => <option key={company.company_id} value={company.company_id}>{company.company_name || company.tenant_name || (view.me?.tenant_id === company.company_id && view.me.tenant_name) || company.company_id}</option>)}
        </select></label>}
      </div>}
      {view?.message && <p role="status" className="svaib-account-note">{view.message}</p>}
      {view?.state === 'waiting' && connection?.stage !== 'cabinet' && <div className="svaib-account-login">
        <p>Подтверди вход в уже открытом браузере или отмени незавершённый вход.</p>
        <button className="svaib-account-button" disabled={busy} onClick={() => void act(async () => { await rpc.call('cancelLogin'); await refresh(); })}>Отменить вход</button>
      </div>}
      {error && <p role="alert" className="svaib-account-error">{error}</p>}
    </section>
    {view?.state === 'signed-out' ? <section className="svaib-journey"><h2>Начало работы</h2><p className="svaib-account-note">Войди в svaib, чтобы продолжить настройку и выбрать компанию.</p>
      <button className="svaib-journey-action" disabled={busy} onClick={() => void act(async () => { await rpc.call('startCabinetLogin'); await refresh(); })}>Войти в svaib</button></section> :
    view?.state === 'waiting' ? <section className="svaib-journey"><h2>Начало работы</h2><p role="status" className="svaib-account-note">После входа здесь появятся шаги для работы с партнёром.</p></section> :
    !selectionLoaded || !progress ? <section className="svaib-journey"><h2>Начало работы</h2><p role="status" className="svaib-account-note">Проверяю этапы…</p></section> : progress.status === 'unavailable' ?
      <section className="svaib-journey"><h2>Начало работы</h2>
        <p role="status" className="svaib-account-note">Не удалось загрузить этапы. Можно продолжить работу с партнёром.</p>
        <button type="button" className="svaib-journey-action" onClick={() => continueJourney()}>Продолжить</button>
      </section> :
      <OnboardingJourney setup={setup} setupComplete={setupComplete} busy={busy || !verified}
        showNextSteps={personal?.snapshot?.accountId === view?.me?.account_id ? personal?.snapshot?.preferences.showNextSteps : true}
        contextLabel={companyId ? `Компания: ${selectedCompanyName}` : undefined}
        nextSteps={next?.stages.map(stage => ({ id: stage.id, title: stage.title, state: stage.state ?? 'next' })) ?? []}
        stagesAvailable={next?.status === 'available'} onContinue={continueJourney} />}
    {production && view?.me?.account_id ? <CompanyList key={view.me.account_id} accountId={view.me.account_id} companies={companies}
      selectedCompanyId={companyId} verified={verified} onSelect={async id => {
        await rpc.call('selectCompany', { company_id: id });
        if (id !== companyId) { setVerified(false); setProgress(null); setCompanyId(id); }
      }} onConnect={company => navigate.toCompose({ initialPrompt: `Помоги подключить компанию и подготовить её пространство svaib. Компания: ${company.name} (ID: ${company.companyId}). Сохрани готовые входы, материалы и уже пройденные этапы. Помоги выбрать постоянную рабочую папку и проверь её перед добавлением вкладки.`, focusPrompt: false })} />
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

export function AccountRouter({ subPath, production = false, preparationPanels, workspaces }: PluginNavPanelProps & { production?: boolean; preparationPanels?: ReactNode; workspaces?: { id: string; name: string }[] }) {
  const match = /^(connect|verify)(?:\/(thr_[a-z0-9]+))?$/.exec(subPath);
  if (!match) return <AccountPage production={production} preparationPanels={preparationPanels} workspaces={workspaces} />;
  if (match[1] === 'verify' && !match[2]) return <AccountPage production={production} preparationPanels={preparationPanels} workspaces={workspaces} />;
  return <PartnerSetup key={subPath} production={production} phase={match[1] === 'verify' ? 'verify' : match[2] ? 'chat' : 'setup'} threadId={match[2]} />;
}
