import { RuntimePreparation } from './RuntimePreparation';
import { KimiSetup } from './KimiSetup';
import { useUserPreferences } from './UserPreferences';

export function PersonalRuntimePreparation({ settings = false, accountId }: { settings?: boolean; accountId?: string | null }) {
  const personal = useUserPreferences(), owner = accountId === undefined ? personal?.snapshot?.accountId : accountId;
  const own = !!owner && personal?.snapshot?.accountId === owner;
  if (!settings && (owner === undefined || (owner && !own && !personal?.error))) return null;
  return <RuntimePreparation settings={settings} cabinetVisible={own ? personal.snapshot!.preferences.panels.runtime : undefined}
    onVisibilityChange={owner !== null ? async visible => {
      if (!owner || !personal || !own || !personal.verified) throw new Error('Личные настройки пока недоступны. Повтори обновление.');
      await personal.update({ panels: { runtime: visible } }, owner);
    } : undefined} />;
}
export function PersonalKimiSetup({ settings = false, accountId }: { settings?: boolean; accountId?: string | null }) {
  const personal = useUserPreferences(), owner = accountId === undefined ? personal?.snapshot?.accountId : accountId;
  const own = !!owner && personal?.snapshot?.accountId === owner;
  if (!settings && (owner === undefined || (owner && !own && !personal?.error))) return null;
  return <KimiSetup settings={settings} cabinetVisible={own ? personal.snapshot!.preferences.panels.kimi : undefined}
    onVisibilityChange={owner !== null ? async visible => {
      if (!owner || !personal || !own || !personal.verified) throw new Error('Личные настройки пока недоступны. Повтори обновление.');
      await personal.update({ panels: { kimi: visible } }, owner);
    } : undefined} />;
}
