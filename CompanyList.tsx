import { useEffect, useRef, useState } from 'react';
import { useBbNavigate, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './server';
import type { CompanyDirectory, CompanyTarget } from './company-workspaces';
import { lastCompanyWorkspace, rememberCompanyWorkspace } from './company-navigation';

const cachedDirectories = new Map<string, CompanyDirectory>();
let directoryEpoch = 0;
export function clearCompanyDirectories() { directoryEpoch++; cachedDirectories.clear(); }
type Company = CompanyDirectory['companies'][number];
export function CompanyList({ accountId, companies, selectedCompanyId, verified, onConnect }: {
  accountId: string;
  companies: { company_id: string; company_name?: string; tenant_name?: string; role?: 'owner' | 'member' }[];
  selectedCompanyId: string;
  verified: boolean;
  onConnect(company: { companyId: string; name: string }, target?: CompanyTarget): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [directory, setDirectory] = useState(() => cachedDirectories.get(accountId));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState<Company | null>(null);
  const [targets, setTargets] = useState<CompanyTarget[]>([]);
  const [targetId, setTargetId] = useState('');
  const sequence = useRef(0);
  const cacheEpoch = useRef(directoryEpoch);
  function accept(result: CompanyDirectory) {
    if (cacheEpoch.current !== directoryEpoch) return;
    if (result.accountId !== accountId) { clearCompanyDirectories(); setDirectory(undefined); throw new Error('Аккаунт изменился. Обнови кабинет.'); }
    cachedDirectories.set(accountId, result);
    if (cachedDirectories.size > 4) cachedDirectories.delete(cachedDirectories.keys().next().value!);
    setDirectory(result);
  }
  useEffect(() => {
    const request = ++sequence.current;
    void rpc.call('companyDirectory').then(result => { if (request === sequence.current) accept(result); })
      .catch(() => { if (request === sequence.current) setError('Не удалось обновить рабочие вкладки. Повтори обновление.'); });
    return () => { sequence.current++; };
  }, [rpc, accountId]);
  useRealtime('account-changed', () => { clearCompanyDirectories(); sequence.current++; setDirectory(undefined); });
  useRealtime('workplaces-changed', () => {
    const request = ++sequence.current;
    void rpc.call('companyDirectory').then(result => { if (request === sequence.current) accept(result); }).catch(() => {});
  });
  async function act(task: () => Promise<void>) {
    setBusy(true); setError('');
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить вкладку.'); }
    finally { setBusy(false); }
  }
  async function useFolder(company: Company, target: CompanyTarget) {
    accept(await rpc.call('bindCompanyWorkspace', { companyId: company.companyId, environmentId: target.environmentId }));
    setConnecting(null);
    onConnect(company, target);
  }
  async function chooseFolder(company: Company) {
    setConnecting(null);
    const found = await rpc.call('companyTargets', { companyId: company.companyId });
    if (!found.length) { onConnect(company); return; }
    if (found.length === 1) { await useFolder(company, found[0]); return; }
    setTargets(found); setTargetId(found[0].environmentId); setConnecting(company);
  }
  const fallback: Company[] = companies.map(c => ({ companyId: c.company_id, name: c.company_name || c.tenant_name || c.company_id,
    role: c.role ?? 'member', visible: false, ready: false, workspaceId: null, projectName: null, localPath: null, issue: null }));
  const rows = directory?.companies ?? fallback;
  const last = lastCompanyWorkspace(accountId);
  return <section className="svaib-companies" aria-labelledby="svaib-companies-title">
    <h2 id="svaib-companies-title">Мои компании</h2>
    <p className="svaib-account-note">Компания выбирается выше. Папка нужна только для работы с её файлами на этом компьютере.</p>
    <div className="svaib-company-list">{rows.map(c => <div className="svaib-company-row" role="group" aria-label={c.name} key={c.companyId}>
      <div><div className="svaib-company-name"><span>{c.name}</span>
        {selectedCompanyId === c.companyId && <span className="svaib-company-badge">Выбрана</span>}
        {c.workspaceId && last === c.workspaceId && <span className="svaib-company-badge">Последняя открытая</span>}</div>
        <p className="svaib-account-note">{c.role === 'owner' ? 'Владелец' : 'Участник'} · {c.ready ? `Пространство подключено${c.projectName ? ' · ' + c.projectName : ''}` : c.issue || 'Папка на этом компьютере не выбрана'}</p>
        {c.localPath && <p className="svaib-account-note svaib-company-path">Папка на этом компьютере: {c.localPath}</p>}
        {c.ready && <button className="svaib-company-path-change" disabled={busy || !verified}
          onClick={() => void act(() => chooseFolder(c))}>Изменить папку</button>}</div>
      {c.ready ? <><label className="svaib-company-toggle"><input type="checkbox" checked={c.visible} disabled={busy || !verified}
        aria-label={`Показывать вкладку ${c.name}`} onChange={event => { const visible = event.currentTarget.checked;
          void act(async () => { accept(await rpc.call('showCompanyTab', { companyId: c.companyId, visible })); }); }} /><span>Показывать вкладку</span></label>
        <button className="svaib-account-button svaib-company-open" disabled={busy || !verified || !c.visible} onClick={() => void act(async () => {
          // Validate again after any cached display, before navigating to local materials.
          const fresh = await rpc.call('companyDirectory'); accept(fresh);
          const target = fresh.companies.find(row => row.companyId === c.companyId && row.ready && row.visible);
          if (!target?.workspaceId) throw new Error('Рабочая вкладка недоступна. Проверь подключение пространства.');
          rememberCompanyWorkspace(accountId, target.workspaceId);
          navigate.toPluginPanel('workplace', { subPath: target.workspaceId });
        })}>Открыть ↗</button></> : <><span className="svaib-account-note">Вкладка не добавлена</span>
        <button className="svaib-account-button" disabled={busy || !verified}
          onClick={() => void act(() => chooseFolder(c))}>Выбрать папку</button></>}
      {connecting?.companyId === c.companyId && <div className="svaib-company-connection">
        <label className="svaib-account-company">Папка компании<select value={targetId} disabled={busy} onChange={e => setTargetId(e.currentTarget.value)}>
          {targets.map(t => <option key={t.environmentId} value={t.environmentId}>{t.projectName} · {t.path}</option>)}</select></label>
        <button className="svaib-account-button" disabled={busy || !verified} onClick={() => void act(async () => {
          const target = targets.find(t => t.environmentId === targetId);
          if (target) await useFolder(c, target);
        })}>Использовать папку</button>
        <button className="svaib-account-button" disabled={busy || !verified} onClick={() => { setConnecting(null); onConnect(c); }}>Найти другую с агентом</button>
      </div>}
    </div>)}</div>
    {!rows.length && <p>Здесь появятся компании, к которым у тебя есть доступ.</p>}
    <p className="svaib-account-note">Видимость вкладок настраивается для тебя в этом BB. Скрытие сохраняет компанию, файлы и разговоры.</p>
    {error && <p role="alert" className="svaib-account-error">{error}</p>}
  </section>;
}
