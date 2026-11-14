import type { PluginKvStorage } from '@get-bb/plugin-sdk';
import type { AccountView } from './experiments/account-prototype/contracts';
import { defaultUserPreferences, preferencesUpdateSchema, userPreferencesSchema, type PreferencesView } from './user-preferences-contract';
import { z } from 'zod';

const storedSchema = z.object({ schema: z.literal(1), revision: z.number().int().nonnegative(), preferences: userPreferencesSchema }).strict();
type AccountPort = { account: { view(): Promise<AccountView> }; epoch(): number };

/** Personal display choices. Neither workspace IDs nor these values authorize access. */
export function createUserPreferences(options: { kv: PluginKvStorage; account: AccountPort; kimiHidden?(): Promise<boolean> }) {
  const queues = new Map<string, Promise<unknown>>();
  const key = (id: string) => 'workplace:user-preferences:' + id;
  function unchanged(epoch: number) { if (epoch !== options.account.epoch()) throw new Error('Подключение изменилось. Обнови кабинет.'); }
  async function principal() {
    const epoch = options.account.epoch();
    const view = await options.account.account.view();
    unchanged(epoch);
    if (view.state === 'error') throw new Error('Не удалось проверить аккаунт для личных настроек.');
    return { id: view.state === 'connected' ? view.me?.account_id ?? null : null, epoch };
  }
  async function read(id: string) {
    const raw = await options.kv.get(key(id));
    if (raw !== undefined) return storedSchema.parse(raw);
    const preferences = defaultUserPreferences();
    // Carry forward the existing offer dismissal, without changing the host setup.
    if (options.kimiHidden) preferences.panels.kimi = !(await options.kimiHidden());
    return { schema: 1 as const, revision: 0, preferences };
  }
  return {
    async get(): Promise<PreferencesView> {
      const owner = await principal();
      if (!owner.id) return { accountId: null, revision: 0, preferences: defaultUserPreferences() };
      const stored = await read(owner.id); unchanged(owner.epoch);
      return { accountId: owner.id, revision: stored.revision, preferences: stored.preferences };
    },
    async update(raw: unknown): Promise<PreferencesView> {
      const input = preferencesUpdateSchema.parse(raw), owner = await principal();
      if (!owner.id || owner.id !== input.expectedAccountId) throw new Error('Аккаунт изменился. Обнови кабинет перед сохранением настроек.');
      const id = owner.id, previous = queues.get(id) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(async () => {
        const fresh = await principal();
        if (fresh.id !== id || fresh.epoch !== owner.epoch) throw new Error('Аккаунт изменился. Обнови кабинет.');
        const stored = await read(id); unchanged(owner.epoch);
        if (stored.revision !== input.expectedRevision) throw new Error('Настройки уже изменены в другом окне. Обнови их и повтори действие.');
        const { metricView, panels, ...patch } = input.patch;
        const preferences = { ...stored.preferences, ...patch, panels: { ...stored.preferences.panels, ...panels }, metricViews: { ...stored.preferences.metricViews } };
        if (metricView) {
          const { key: viewKey, ...changes } = metricView;
          const view = { ...(preferences.metricViews[viewKey] ?? { table: false, showPlan: false }), ...changes };
          delete preferences.metricViews[viewKey];
          preferences.metricViews[viewKey] = view;
          const keys = Object.keys(preferences.metricViews);
          for (const old of keys.slice(0, Math.max(0, keys.length - 128))) delete preferences.metricViews[old];
        }
        const saved = storedSchema.parse({ schema: 1, revision: stored.revision + 1, preferences });
        unchanged(owner.epoch);
        await options.kv.set(key(id), saved);
        unchanged(owner.epoch);
        return { accountId: id, revision: saved.revision, preferences: saved.preferences };
      });
      queues.set(id, next);
      try { return await next; } finally { if (queues.get(id) === next) queues.delete(id); }
    },
  };
}
