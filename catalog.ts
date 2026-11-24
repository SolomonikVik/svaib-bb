import type { WorkplaceConfig, CatalogWorkspace, CatalogAction } from './config';
import type { ActionContext, AspectId, AspectItem, WorkspaceAspect } from './types';
export type { CatalogWorkspace } from './config';
export const STANDARD_RULES = 'Запуск кнопки не заменяет согласия на действия, для которых оно требуется. Отправка сообщений, приглашений и публикация — по явной просьбе пользователя.';
export const READ_ONLY_RULES = 'Только чтение. Покажи результат в этом разговоре. Ничего не записывай, не отправляй и не публикуй. При необходимости используй временные файлы вне пространства.';
export function actionRules(workspace: CatalogWorkspace, selected: CatalogAction, context: ActionContext = {}): string {
  if (selected.mode === 'draft-only') {
    if (selected.effect) throw new Error('Режим draft-only нельзя совмещать с effect.');
    return READ_ONLY_RULES;
  }
  if (selected.effect === 'personal-assistant') {
    if (!workspace.personal || context.aspectId !== undefined || context.itemId !== undefined) throw new Error('Личный ассистент доступен только в личном пространстве без бизнес-контекста.');
    return `Личный ассистент: используй его инструкцию в пределах запроса. Настройки рабочего места и других пространств не меняй. ${STANDARD_RULES}`;
  }
  if (selected.effect !== 'metrics-refresh') return STANDARD_RULES;
  if (!workspace.metricsDashboard || workspace.personal || workspace.linkHub || context.itemId || (context.aspectId && context.aspectId !== 'metrics')) throw new Error('Обновление графиков разрешено только для всего ракурса metrics с готовым снимком.');
  return `Обнови только metricsDashboard вкладки ${workspace.id}. Прочитай источники и подготовь JSON во временном файле вне пространства. Для записи используй только команду:\nbb svaib-workplace apply-metrics --workspace ${workspace.metricsUpdateWorkspaceId ?? workspace.id} --file <абсолютный-путь-к-JSON> --expected-snapshot ${workspace.metricsDashboard.preparedAt}\nПри конфликте перечитай снимок. Сохрани ID показателей, серий и URL источников. Пустые значения оставь пустыми, план отличай от факта, незакрытый месяц пометь. Даты проверки ставь по фактическому чтению источников.`;
}
export function getWorkspace(config: WorkplaceConfig, id: string): CatalogWorkspace {
  const workspace = config.workspaces.find(w => w.id === id);
  if (!workspace) throw new Error('Неизвестное пространство.');
  return workspace;
}
export function getAction(workspace: CatalogWorkspace, id: string): CatalogAction {
  const action = workspace.actions.find(a => a.id === id);
  if (!action) throw new Error('Такого действия нет в выбранном пространстве.');
  return action;
}
export const ASPECT_TITLES: Record<AspectId, string> = {
  strategy: 'Стратегия', metrics: 'Цели и показатели', team: 'Команда', finance: 'Финансы',
  projects: 'Проекты', processes: 'Процессы', rhythm: 'Ритм управления',
};
/** Resolve identifiers against the operator-owned profile, never client-supplied labels or paths. */
export function resolveActionContext(workspace: CatalogWorkspace, selected: CatalogAction, context: ActionContext = {}): { aspect?: WorkspaceAspect; item?: AspectItem } {
  if ((workspace.personal || workspace.clientHub) && (context.aspectId !== undefined || context.itemId !== undefined)) throw new Error('Это представление не принимает бизнес-контекст ракурса или объекта.');
  if (context.itemId && !context.aspectId) throw new Error('Для объекта нужно указать ракурс.');
  if (!context.aspectId) return {};
  const aspect = workspace.aspects?.find(a => a.id === context.aspectId);
  // A known aspect without a prepared snapshot can still offer a relevant partner action.
  const relevant = selected.aspectIds?.includes(context.aspectId) ?? false;
  if (!aspect && !relevant) throw new Error('Ракурс отсутствует в выбранном пространстве.');
  if (context.itemId) {
    const item = aspect?.items.find(i => i.id === context.itemId);
    if (!item) throw new Error('Объект отсутствует в выбранном ракурсе.');
    // Team objects are not implicitly departments. A department review needs
    // an explicit object/action link instead of inheriting the whole team lens.
    const needsExplicitItem = selected.skill?.replace(/^svaib:/, '') === 'team-unit-review';
    if (!item.actionIds.includes(selected.id) && (!relevant || needsExplicitItem)) throw new Error('Действие не связано с выбранным объектом.');
    return { aspect, item };
  }
  if (!aspect?.actionIds.includes(selected.id) && !relevant) throw new Error('Действие не связано с выбранным ракурсом.');
  return { aspect };
}
export function actionContextText(workspace: CatalogWorkspace, selected: CatalogAction, context: ActionContext = {}): string {
  const { aspect, item } = resolveActionContext(workspace, selected, context);
  if (!context.aspectId) return '';
  const fields = item ? [
    `Объект: ${item.title} (${item.id})`, `Содержание: ${item.summary}`,
    ...([['Роль', item.role], ['Ответственность', item.responsibility], ['Ответственный', item.owner], ['Состояние', item.status],
      ['Значение', item.value], ['Цель / план', item.target], ['Период', item.period]] as const)
      .flatMap(([label, value]) => value ? [`${label}: ${value}`] : []),
  ] : [];
  return [
    `Ракурс: ${ASPECT_TITLES[context.aspectId]}`,
    `Подготовленный снимок: ${aspect?.snapshotAt ?? workspace.snapshotAt}`,
    ...(aspect?.summary ? [`Состояние ракурса: ${aspect.summary}`] : []), ...fields,
  ].join('\n');
}
/** The editable composer names the task, not internal routes or the full prepared snapshot. */
export function contextualPreviewText(workspace: CatalogWorkspace, selected: CatalogAction, context: ActionContext = {}): string {
  const { item } = resolveActionContext(workspace, selected, context);
  if (!context.aspectId) return '';
  return [
    `Ракурс: ${ASPECT_TITLES[context.aspectId]}`,
    ...(item ? [`Объект: ${item.title}`, ...(item.period ? [`Период: ${item.period}`] : [])] : []),
  ].join('\n');
}
export function actionSources(workspace: CatalogWorkspace, selected: CatalogAction, context: ActionContext = {}) {
  const { aspect, item } = resolveActionContext(workspace, selected, context);
  return [...new Set([...selected.sourceIds, ...(aspect?.sourceIds ?? []), ...(item?.sourceIds ?? [])])].map(id => {
    const source = workspace.sources.find(s => s.id === id);
    if (!source) throw new Error('В маршруте действия отсутствует источник.');
    return source;
  });
}
export function actionPrompt(workspace: CatalogWorkspace, selected: CatalogAction, context: ActionContext = {}): string {
  if (selected.available === false) throw new Error(selected.unavailableReason ?? 'Необходимый скилл недоступен.');
  const sources = actionSources(workspace, selected, context);
  const selection = actionContextText(workspace, selected, context);
  const instructions = [
    actionRules(workspace, selected, context),
    `Пространство: ${workspace.name}\nКорень: ${workspace.root}`,
    selection && `Данные выбранного объекта:\n${selection}`,
    selected.method,
    sources.length && `Источники:\n${sources.map(source => `- ${source.title}: ${source.path}`).join('\n')}`,
    workspace.planner && `Не обращайся к API планировщика ${workspace.planner.url}: даже чтение может менять данные.`,
  ].filter(Boolean).join('\n\n');
  if (instructions.length > 4096) throw new Error('Инструкция действия превышает лимит SDK 4096; сократи текст, не обрезай автоматически.');
  return instructions;
}
export function validateInstructions(config: WorkplaceConfig) {
  for (const w of config.workspaces) for (const a of w.actions) actionPrompt(w, a);
}
