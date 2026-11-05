import { useEffect, useRef, useState } from 'react';
import { useBbNavigate, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './server';
import type { CompanyDirectory, CompanyTarget } from './company-workspaces';
import { lastCompanyWorkspace, rememberCompanyWorkspace } from './company-navigation';

const cachedDirectories = new Map<string, CompanyDirectory>();
let directoryEpoch = 0;
export function clearCompanyDirectories() { directoryEpoch++; cachedDirectories.clear(); }
type Company = CompanyDirectory['companies'][number];
export function CompanyList({ accountId, companies, selectedCompanyId, verified, onSelect, onConnect }: {
  accountId: string;
  companies: { company_id: string; company_name?: string; tenant_name?: string; role?: 'owner' | 'member' }[];
  selectedCompanyId: string;
  verified: boolean;
  onSelect(id: string): Promise<void>;
  onConnect(company: { companyId: string; name: string }): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [directory, setDirectory] = useState(() => cachedDirectories.get(accountId));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState<Company | null>(null);
  const [targets, setTargets] = useState<CompanyTarget[] | null>(null);
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
  const fallback: Company[] = companies.map(c => ({ companyId: c.company_id, name: c.company_name || c.tenant_name || c.company_id,
    role: c.role ?? 'member', visible: false, ready: false, workspaceId: null, projectName: null, localPath: null, issue: null }));
  const rows = directory?.companies ?? fallback;
  const last = lastCompanyWorkspace(accountId);
  return <section className="svaib-companies" aria-labelledby="svaib-companies-title">
    <h2 id="svaib-companies-title">Мои компании</h2>
    <p className="svaib-account-note">Выбери, какие рабочие вкладки держать под рукой.</p>
    <div className="svaib-company-list">{rows.map(c => <div className="svaib-company-row" key={c.companyId}>
      <div><div className="svaib-company-name"><button type="button" className="svaib-company-select" disabled={busy || !verified}
        aria-pressed={selectedCompanyId === c.companyId} onClick={() => void act(() => onSelect(c.companyId))}>{c.name}</button>
        {c.workspaceId && last === c.workspaceId && <span className="svaib-company-badge">Последняя открытая</span>}</div>
        <p className="svaib-account-note">{c.role === 'owner' ? 'Владелец' : 'Участник'} · {c.ready ? `Пространство подключено${c.projectName ? ' · ' + c.projectName : ''}` : c.issue || 'Нужно подключить пространство'}</p>
        {c.localPath && <p className="svaib-account-note svaib-company-path">Папка на этом компьютере: {c.localPath}</p>}
        {c.ready && <button className="svaib-company-path-change" disabled={busy || !verified} onClick={() => void act(async () => {
          setConnecting(c); setTargets(null); setTargetId(''); const found = await rpc.call('companyTargets', { companyId: c.companyId });
          setTargets(found); setTargetId(found[0]?.environmentId ?? '');
        })}>Изменить папку</button>}</div>
      {c.ready ? <><label className="svaib-company-toggle"><input type="checkbox" checked={c.visible} disabled={busy || !verified}
        aria-label={`Показывать вкладку ${c.name}`} onChange={event => { const visible = event.currentTarget.checked;
          void act(async () => { accept(await rpc.call('showCompanyTab', { companyId: c.companyId, visible })); }); }} /><span>Показывать вкладку</span></label>
        <button className="svaib-account-button svaib-company-open" disabled={busy || !verified || !c.visible} onClick={() => void act(async () => {
          await onSelect(c.companyId);
          // Validate again after any cached display, before navigating to local materials.
          const fresh = await rpc.call('companyDirectory'); accept(fresh);
          const target = fresh.companies.find(row => row.companyId === c.companyId && row.ready && row.visible);
          if (!target?.workspaceId) throw new Error('Рабочая вкладка недоступна. Проверь подключение пространства.');
          rememberCompanyWorkspace(accountId, target.workspaceId);
          navigate.toPluginPanel('workplace', { subPath: target.workspaceId });
        })}>Открыть ↗</button></> : <><span className="svaib-account-note">Вкладка не добавлена</span>
        <button className="svaib-account-button" disabled={busy || !verified} onClick={() => void act(async () => {
          setConnecting(c); setTargets(null); setTargetId('');
          const found = await rpc.call('companyTargets', { companyId: c.companyId });
          setTargets(found); setTargetId(found[0]?.environmentId ?? '');
        })}>Подключить пространство</button></>}
    </div>)}</div>
    {!rows.length && <p>Здесь появятся компании, к которым у тебя есть доступ.</p>}
    <p className="svaib-account-note">Видимость вкладок настраивается для тебя в этом BB. Скрытие сохраняет компанию, файлы и разговоры.</p>
    {error && <p role="alert" className="svaib-account-error">{error}</p>}
    {connecting && <div className="svaib-company-connection"><h3>{connecting.name} · пространство</h3>
      {targets === null ? <p role="status">Проверяю подключённые папки…</p> : targets.length ? <>
        <label className="svaib-account-company">Рабочая папка<select value={targetId} disabled={busy} onChange={e => setTargetId(e.currentTarget.value)}>
          {targets.map(t => <option key={t.environmentId} value={t.environmentId}>{t.projectName} · {t.path}</option>)}</select></label>
        <button className="svaib-account-button svaib-account-primary" disabled={busy || !verified} onClick={() => void act(async () => {
          accept(await rpc.call('bindCompanyWorkspace', { companyId: connecting.companyId, environmentId: targetId })); setConnecting(null);
        })}>Добавить вкладку</button></> : <p>Подключённая папка этой компании пока не найдена.</p>}
      <button className="svaib-account-button" disabled={busy || !verified} onClick={() => onConnect(connecting)}>Выбрать папку с партнёром</button>
      <button className="svaib-account-button" disabled={busy} onClick={() => { sequence.current++; setConnecting(null); }}>Закрыть</button>
    </div>}
  </section>;
}
