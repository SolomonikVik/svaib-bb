import { defaultUserPreferences, orderWorkspaces, type PreferencePatch } from './user-preferences-contract';
import { useUserPreferences } from './UserPreferences';

export function UserSettings({ accountId, verified, workspaces }: { accountId: string; verified: boolean; workspaces: { id: string; name: string }[] }) {
  const context = useUserPreferences();
  const own = context?.snapshot?.accountId === accountId;
  const preferences = own ? context!.snapshot!.preferences : defaultUserPreferences();
  const disabled = !verified || !own || !context?.verified || context.saving;
  const ordered = orderWorkspaces(workspaces, preferences.workspaceOrder);
  function save(patch: PreferencePatch) { if (!disabled) void context!.update(patch, accountId).catch(() => {}); }
  function move(index: number, direction: -1 | 1) {
    const ids = ordered.map(item => item.id), target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    const available = new Set(ids);
    save({ workspaceOrder: [...ids, ...preferences.workspaceOrder.filter(id => !available.has(id))].slice(0, 128) });
  }
  const startup = preferences.startup;
  const startupValue = startup.kind === 'workspace' ? 'workspace:' + startup.workspaceId : startup.kind;
  const missingStartup = startup.kind === 'workspace' && !workspaces.some(item => item.id === startup.workspaceId);
  return <div className="svaib-user-settings">
    <fieldset disabled={disabled}>
      <label className="svaib-account-company">При открытии svaib<select aria-label="При открытии svaib" value={startupValue} onChange={event => {
        const value = event.currentTarget.value;
        save({ startup: value === 'last' || value === 'cabinet' ? { kind: value } : { kind: 'workspace', workspaceId: value.slice('workspace:'.length) } });
      }}>
        <option value="last">Последняя рабочая вкладка</option><option value="cabinet">Личный кабинет</option>
        {workspaces.map(item => <option key={item.id} value={'workspace:' + item.id}>{item.name}</option>)}
        {missingStartup && <option value={startupValue}>Выбранная вкладка сейчас недоступна</option>}
      </select></label>
      {missingStartup && <p className="svaib-account-note">Пока вкладка недоступна, будет открываться личный кабинет.</p>}
      <div className="svaib-user-setting-group"><h3>Порядок рабочих вкладок</h3>
        <p className="svaib-account-note">Часто используемые — первыми. Видимость вкладок меняется в «Мои компании».</p>
        {ordered.length ? <ol className="svaib-tab-order">{ordered.map((item, index) => <li key={item.id}><span>{item.name}</span><div>
          <button type="button" className="svaib-account-button" aria-label={`Поднять вкладку ${item.name}`} disabled={disabled || index === 0} onClick={() => move(index, -1)}>↑</button>
          <button type="button" className="svaib-account-button" aria-label={`Опустить вкладку ${item.name}`} disabled={disabled || index === ordered.length - 1} onClick={() => move(index, 1)}>↓</button>
        </div></li>)}</ol> : <p className="svaib-account-note">Здесь появятся подключённые рабочие вкладки.</p>}
      </div>
      <div className="svaib-user-setting-group"><label className="svaib-account-toggle"><input type="checkbox" checked={preferences.showNextSteps} onChange={event => save({ showNextSteps: event.currentTarget.checked })} />Показывать следующие шаги освоения</label>
        <p className="svaib-account-note svaib-toggle-note">После завершения начальной подготовки. Пройденные этапы сохраняются.</p>
      </div>
      <div className="svaib-user-setting-group"><h3>Временные панели в кабинете</h3>
        <label className="svaib-account-toggle"><input type="checkbox" checked={preferences.panels.runtime} onChange={event => save({ panels: { runtime: event.currentTarget.checked } })} />Подготовка компьютера</label>
        <label className="svaib-account-toggle"><input type="checkbox" checked={preferences.panels.kimi} onChange={event => save({ panels: { kimi: event.currentTarget.checked } })} />Настройка Kimi</label>
        <p className="svaib-account-note">Включённые панели появляются только при необходимости. Из настроек плагина их можно открыть всегда.</p>
      </div>
    </fieldset>
    {context?.error && <p role="alert" className="svaib-account-error">{context.error}</p>}
    {!context?.verified && !context?.saving && <button type="button" className="svaib-account-button" onClick={() => { void context?.refresh(); }}>Обновить личные настройки</button>}
    <p className="svaib-account-note" role="status">{context?.saving ? 'Сохраняю…' : own && context?.verified ? 'Настройки сохраняются для твоего аккаунта в этом BB.' : 'Проверяю личные настройки…'}</p>
  </div>;
}
