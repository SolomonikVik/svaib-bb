import { z } from 'zod/v4';
import { continuationSchema, continuationInstruction, checkContinuation } from './continuation';
import type { BbNavigate } from '@get-bb/plugin-sdk/app';
import type { PluginAgentConfigurationContext, PluginAgentConfiguration } from '@get-bb/plugin-sdk';
import { HOOK_TOOL } from './hook-bundle';
import { connectionProviders, supportsConnection } from './connection-providers';

export const CONNECTION_SKILL = 'svaib-workplace-connect';
export const START_TOOL = 'svaib_connect_start';
export const BEGIN_TOOL = 'svaib_connect_begin';
export const WAIT_TOOL = 'svaib_connect_wait';
const NATIVE_TOOL = 'svaib_connect_native_start';
export const connectionBindingSchema = z.object({
  projectId: z.string().min(1), environmentId: z.string().min(1),
  hostId: z.string().min(1), providerId: z.enum(connectionProviders),
}).strict();
export type ConnectionBinding = z.infer<typeof connectionBindingSchema>;
export const connectionMetadataSchema = z.object({
  schema: z.literal(1), task: z.literal('svaib-connect'),
  phase: z.enum(['setup', 'verify', 'work']),
  binding: connectionBindingSchema.optional(),
  continuation: continuationSchema.optional(), previousThreadId: z.string().optional(), successorThreadId: z.string().optional(),
  unified: z.boolean().optional(), runId: z.string().optional(), targetHostId: z.string().optional(), verifyExistingOnly: z.boolean().optional(),
  inPlace: z.boolean().optional(),
  workspaceCompanyId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
}).strict();
export const connectionThreadSchema = connectionBindingSchema.extend({ threadId: z.string().min(1) }).strict();
export type ConnectionThread = z.infer<typeof connectionThreadSchema>;

export const SETUP_PROMPT = 'Помоги подключить партнёра svaib в этом рабочем месте BB. Выполни техническую настройку сам; мне оставь подтверждение входа в браузере.';
export const VERIFY_PROMPT = 'Проверь, работает ли подключение партнёра svaib в этом новом разговоре. Ничего не устанавливай и не меняй подключения. Покажи, от чьего имени работает партнёр.';

const NORMAL_WORK_GUIDANCE = 'В обычном разговоре выполняй текущий запрос человека. Успешный whoami и персональная карта дают контекст для работы; сами по себе они не запускают настройку или онбординг. ' +
  'Если сводка показывает незавершённые начальные этапы, коротко подсвети ближайший и продолжай поручение. Если без настройки нельзя выполнить само поручение, объясни зависимость и предложи нужное действие. ' +
  'Оставшиеся рабочие сценарии после начальных этапов не требуют напоминания при каждом старте. ' +
  'При поручении продолжить настройку svaib или шаг кабинета прочитай svaib-workplace-connect; после работающего native MCP — svaib:onboarding. Сохраняй работающие BB, модель, плагины и входы.';
const ACTIVE_ONBOARDING_GUIDANCE = 'Уже порученный онбординг продолжай после каждого ответа до завершения начальных этапов по свежим company marks: connect, space, profile, zone, first-work = done. Фаза BB этого не доказывает. Пауза или смена задачи останавливает путь. Настройку и проверку MCP продолжай здесь; техническое обновление инструментов выполняется средствами харнеса без отдельного этапа svaib.';

const connectionTools = (provider: string) => [START_TOOL, BEGIN_TOOL, WAIT_TOOL,
  ...(provider === 'codex' ? [NATIVE_TOOL, HOOK_TOOL] : [])];

/** Use BB's root composer: BB owns the chat, selection and permissions. */
export function connectionCompose(projectId?: string | null, source?: ConnectionThread): NonNullable<Parameters<BbNavigate['toCompose']>[0]> {
  return {
    ...(projectId ? { projectId } : {}),
    ...(source ? { projectId: source.projectId, environmentId: source.environmentId } : {}),
    initialPrompt: source ? `${VERIFY_PROMPT} Проверь тот же движок и рабочее место, что в @thread:${source.threadId}; если они отличаются, сообщи об этом.` : SETUP_PROMPT,
    focusPrompt: true,
  };
}

export function connectionConfiguration(context: PluginAgentConfigurationContext, pluginId: string): PluginAgentConfiguration {
  const empty = { tools: [], skills: [] };
  if (!supportsConnection(context.provider.id)) return empty;
  // Native BB conversations discover the skill through its description.
  // The explicit start tool captures the current source; availability starts nothing.
  const metadata = connectionMetadataSchema.safeParse(context.pluginMetadata);
  if ((context.origin.pluginId !== pluginId || context.origin.kind !== null) && (!metadata.success || !metadata.data.inPlace))
    return { tools: connectionTools(context.provider.id), skills: [CONNECTION_SKILL], instructions: NORMAL_WORK_GUIDANCE + ' ' + ACTIVE_ONBOARDING_GUIDANCE };
  const unsupported = { ...empty, skills: [CONNECTION_SKILL], instructions: 'Служебная привязка BB-подключения недоступна или не совпадает с текущим разговором. Не управляй прежним OAuth-процессом и не переноси его данные. Это не запрещает явно порученную настройку native MCP в фактическом текущем рабочем месте по скиллу svaib-workplace-connect. Проверь реальный CLI, профиль и сохранённый вход; отдельный flow или проверочный разговор для этого не нужен.' };
  if (!metadata.success) return unsupported;
  if (metadata.data.successorThreadId) return { ...unsupported, instructions: unsupported.instructions + ` У прежнего подключения есть разговор @thread:${metadata.data.successorThreadId}; это источник истории, а не обязательный переход. Явно порученную настройку native MCP продолжай здесь.` };
  const prior = metadata.data.binding;
  if (metadata.data.inPlace && prior && prior.environmentId !== context.environment.id &&
      prior.projectId === context.project.id && prior.hostId === context.host.id && prior.providerId === context.provider.id &&
      (!metadata.data.continuation || (metadata.data.continuation.sourceProjectId === prior.projectId &&
        (!metadata.data.continuation.sourceEnvironmentId || metadata.data.continuation.sourceEnvironmentId === prior.environmentId)))) return {
    tools: connectionTools(context.provider.id), skills: [CONNECTION_SKILL],
    instructions: 'BB переключил этот разговор в другую папку. Перед продолжением вызови svaib_connect_start с уже известным поручением: backend проверит фактическую среду и границу компании и обновит привязку здесь. Не повторяй OAuth, не открывай новый разговор и не вызывай Screen до этой проверки. ' +
      continuationInstruction(metadata.data.continuation, metadata.data.previousThreadId),
  };
  if (metadata.data.phase === 'work') return { tools: connectionTools(context.provider.id), skills: [CONNECTION_SKILL], instructions:
    NORMAL_WORK_GUIDANCE + ' ' + ACTIVE_ONBOARDING_GUIDANCE + ' ' + continuationInstruction(metadata.data.continuation, metadata.data.previousThreadId) };
  if (metadata.data.continuation) {
    try { checkContinuation(metadata.data.continuation, context.project.id, context.environment.id); }
    catch { return { ...unsupported, instructions: unsupported.instructions + ' Сохранённый пакет поручения относится к другой среде: не используй его как выбор компании, папки или разрешение на запись. Текущее явное поручение человека сохраняется.' }; }
  }
  if (metadata.data.targetHostId && metadata.data.targetHostId !== context.host.id) return unsupported;
  const actual = { projectId: context.project.id, environmentId: context.environment.id,
    hostId: context.host.id, providerId: context.provider.id };
  const expected = metadata.data.binding;
  if (metadata.data.phase === 'verify' && (!expected || Object.keys(actual).some(key =>
    actual[key as keyof typeof actual] !== expected[key as keyof ConnectionBinding]))) return unsupported;
  const workspaceNote = metadata.data.continuation?.data.scope === 'onboarding'
    ? context.environment.workspaceProvisionType === 'personal'
      ? 'Это временная служебная папка BB, а не выбранная пользователем постоянная папка организации. Не предлагай размещать в ней материалы компании: BB может удалить её после удаления или архивирования всех связанных разговоров. Постоянную папку человек выбирает в штатном новом разговоре BB через No project → New project или существующий проект и оставляет Project checkout. Git не нужен. '
      : 'Папка проекта BB сама по себе не подтверждает, что пользователь выбрал её для пространства организации. Учитывай уже подтверждённый выбор; иначе уточни его. '
    : '';
  if (metadata.data.unified) return {
    tools: [BEGIN_TOOL, WAIT_TOOL, ...(context.provider.id === 'codex' ? [NATIVE_TOOL, HOOK_TOOL] : [])], skills: [CONNECTION_SKILL],
    instructions: `Единое подключение svaib уже запущено пользователем. Рабочее место: ${JSON.stringify(actual)}. Прочитай скилл ${CONNECTION_SKILL}. ${continuationInstruction(metadata.data.continuation, metadata.data.previousThreadId)} ` +
      `Ты уже в разговоре подключения: не вызывай svaib_connect_start или RPC connect и не направляй пользователя в этот же разговор. Продолжай текущий этап здесь. Ошибка запуска хука требует диагностики, а не нового разговора или повторного OAuth. ` +
      `Для проверки используй настоящий MCP svaib whoami этого разговора; уже полученный свежий успешный ответ повторно не запрашивай. Если он работает, сохрани вход и продолжай исходное поручение здесь. ` +
      `При несовпадении аккаунтов сообщи пользователю, но не останавливай работу. Сохрани уже работающий вход MCP. ` +
      (metadata.data.verifyExistingOnly ? 'Проверяй только существующие входы; новый OAuth не запускай. ' : '') +
      `Если MCP недоступен, следуй справке скилла; кабинет и MCP настраиваются отдельно. Компания, Screen и запись файлов проверяются отдельно. ${ACTIVE_ONBOARDING_GUIDANCE} ${workspaceNote}`
  };
  return unsupported;
}
