import { z } from 'zod';
import { continuationSchema, continuationInstruction, checkContinuation } from './continuation';
import type { BbNavigate } from '@get-bb/plugin-sdk/app';
import type { PluginAgentConfigurationContext, PluginAgentConfiguration } from '@get-bb/plugin-sdk';
import { HOOK_TOOL } from './hook-bundle';
import { connectionProviders, supportsConnection } from './connection-providers';

export const CONNECTION_SKILL = 'svaib-workplace-connect';
export const START_TOOL = 'svaib_connect_start';
export const BEGIN_TOOL = 'svaib_connect_begin';
export const FRESH_TOOL = 'svaib_connect_verify';
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
}).strict();
export const connectionThreadSchema = connectionBindingSchema.extend({ threadId: z.string().min(1) }).strict();
export type ConnectionThread = z.infer<typeof connectionThreadSchema>;

export const SETUP_PROMPT = 'Помоги подключить партнёра svaib в этом рабочем месте BB. Выполни техническую настройку сам; мне оставь подтверждение входа в браузере.';
export const VERIFY_PROMPT = 'Проверь, работает ли подключение партнёра svaib в этом новом разговоре. Ничего не устанавливай и не меняй подключения. Покажи, от чьего имени работает партнёр.';

const ONBOARDING_CONTINUATION_GUIDANCE = 'При продолжении настройки svaib или шага кабинета прочитай svaib-workplace-connect; после работающего native MCP — svaib:onboarding. ' +
  'Восстанови поручение из Telegram, свежего whoami и get_account_setup; прогресс компании читай отдельно с выбранным company_id. Сохраняй работающие BB, модель, плагины и входы. ' +
  'Четыре группы: «Подготовить партнёра» — недостающая установка и проверка хуков; «Войти в svaib» — native MCP, кабинет и данные аккаунта; ' +
  '«Подключить компанию и пространство» — реальная компания, выбранная папка, прежние материалы и проверенные файлы; «Познакомиться и начать работу» — профиль, зона ответственности и первая полезная задача. ' +
  'Веди выбранную группу с первого недостающего действия в пределах поручения. После успешного native whoami прочитай onboarding, проверь плагины и запуск hooks, сразу запиши user.connect с прочитанным expect и проверь ответ. Папка и каркас для этой отметки не нужны. ' +
  'До завершения четырёх групп выбирай первый непройденный этап: user.connect → user.space → user.profile → user.zone → user.first-work; затем действует общий порядок каталога. ' +
  'После результата назови и выполни ближайшее разрешённое действие либо задай один нужный вопрос. При паузе остановись; при продолжении перечитай серверный прогресс: marks важнее сохранённого next_step. ' +
  'user.space сохраняй после чтения созданных файлов, затем переходи к профилю, зоне и первой задаче. Заполнение процесса или стратегии не заменяет знакомства. ' +
  'Если у компании нет user.connect при работающем account-входе, проверь whoami с её company_id и запиши проверенное в её контексте; account-отметка не заменяет этой проверки. ' +
  'ID Screen бери из результата системы; если она не находит существующий Screen, назови ограничение. Подтверждение конструктора не заменяет проверки файлов и не меняет порядок этапов.';

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
  if (context.origin.pluginId !== pluginId || context.origin.kind !== null) return { tools: context.provider.id === 'codex' ? [START_TOOL, HOOK_TOOL] : [START_TOOL], skills: [CONNECTION_SKILL], instructions: ONBOARDING_CONTINUATION_GUIDANCE };
  const metadata = connectionMetadataSchema.safeParse(context.pluginMetadata);
  const unsupported = { ...empty, instructions: 'Настройка подключения недоступна для этого разговора. Верни пользователя к странице «Моё рабочее место». Не меняй подключения и не начинай OAuth.' };
  if (!metadata.success) return unsupported;
  if (metadata.data.successorThreadId) return { ...empty, skills: [CONNECTION_SKILL], instructions: `Подключение уже продолжается в @thread:${metadata.data.successorThreadId}. Дай эту ссылку и помоги по одному действию. Не повторяй вход, установку и не создавай новый разговор.` };
  if (metadata.data.phase === 'work') return { ...empty, skills: [CONNECTION_SKILL], instructions: ONBOARDING_CONTINUATION_GUIDANCE };
  if (metadata.data.continuation) {
    try { checkContinuation(metadata.data.continuation, context.project.id, context.environment.id); }
    catch (error) { return { ...empty, skills: [CONNECTION_SKILL], instructions: error instanceof Error ? error.message : 'Передача недоступна. Вернись к исходному разговору; сохрани входы.' }; }
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
    tools: [...(metadata.data.phase === 'setup' ? [BEGIN_TOOL, FRESH_TOOL, WAIT_TOOL] : [BEGIN_TOOL]), ...(metadata.data.phase === 'setup' && context.provider.id === 'codex' ? [NATIVE_TOOL, HOOK_TOOL] : [])], skills: [CONNECTION_SKILL],
    instructions: `Единое подключение svaib уже запущено пользователем. Рабочее место: ${JSON.stringify(actual)}. Прочитай скилл ${CONNECTION_SKILL}. ${continuationInstruction(metadata.data.continuation, metadata.data.previousThreadId)} ` +
      `Вызови настоящий MCP svaib whoami в этом разговоре. Если он работает, сохрани вход и продолжай исходное поручение. Локальный хук BB передаст идентификатор для необязательной сверки с кабинетом. ` +
      `При несовпадении аккаунтов сообщи пользователю, но не останавливай работу. Сохрани уже работающий вход MCP. ` +
      (metadata.data.phase === 'verify' ? 'В режиме проверки не переустанавливай метод и не запускай MCP OAuth. ' : '') +
      `Если MCP недоступен, следуй справке скилла; кабинет и MCP настраиваются отдельно. Компания, Screen и запись файлов проверяются отдельно. ${workspaceNote}`
  };
  return unsupported;
}
