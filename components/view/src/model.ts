import { z } from 'zod/v4';
import { metricsDashboardSchema } from './metrics-model';
import { scaffoldConfigSchema, scaffoldConfirmationSchema, scaffoldCatalog, type ScaffoldConfirmation } from './scaffold';

export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const text = z.string().min(1).max(2000);
const source = z.object({ title: text, ref: z.string().max(1000) }).strict();
const task = z.object({
  id: idSchema, title: text, owner: text, status: z.enum(['active', 'backlog', 'done']), source,
}).strict();
export const blockSchema = z.discriminatedUnion('type', [
  z.object({ id: idSchema, type: z.literal('note'), version: z.literal(1), title: text, text }).strict(),
  z.object({ id: idSchema, type: z.literal('tasks'), version: z.literal(1), title: text,
    items: z.array(task).max(200) }).strict(),
  z.object({ id: idSchema, type: z.literal('scaffold'), version: z.literal(1), title: text, config: scaffoldConfigSchema }).strict(),
  z.object({ id: idSchema, type: z.literal('metrics'), version: z.literal(1), title: text, data: metricsDashboardSchema }).strict(),
  z.object({ id: idSchema, type: z.literal('chart'), version: z.literal(1), title: text,
    unit: z.string().max(40), source, verifiedAt: z.iso.datetime(),
    points: z.array(z.object({ label: text, value: z.number().finite().nullable(),
      plan: z.number().finite().nullable().optional() }).strict()).min(1).max(60),
  }).strict(),
]);
export const documentSchema = z.object({
  schemaVersion: z.literal(1), title: text, description: text,
  layout: z.enum(['stack', 'columns']), blocks: z.array(blockSchema).max(20),
}).strict().superRefine((document, ctx) => {
  const blockIds = document.blocks.map(block => block.id);
  const taskIds = document.blocks.flatMap(block => block.type === 'tasks' ? block.items.map(task => task.id) : []);
  if (new Set(blockIds).size !== blockIds.length || new Set(taskIds).size !== taskIds.length) {
    ctx.addIssue({ code: 'custom', message: 'ID компонентов и задач должны быть уникальны в представлении.' });
  }
  if (document.blocks.some(block => block.type === 'scaffold' && block.config.schemaVersion === 2 && block.config.overview) &&
      (document.blocks.length !== 1 || document.blocks[0].type !== 'scaffold')) {
    ctx.addIssue({ code: 'custom', message: 'Обзор должен быть единственным компонентом представления.' });
  }
});
export type ViewDocument = z.infer<typeof documentSchema>;
export type Block = z.infer<typeof blockSchema>;
export const requestIdSchema = z.string().regex(/^[a-zA-Z0-9-]{1,100}$/);
export const createSchema = z.object({ id: idSchema, requestId: requestIdSchema, document: documentSchema,
  onlyIfEmpty: z.boolean().optional() }).strict();
export const updateSchema = z.object({ id: idSchema, requestId: requestIdSchema,
  expectedRevision: z.number().int().positive(), document: documentSchema,
  refreshOverview: z.literal(true).optional() }).strict();
export const submitSchema = z.object({ id: idSchema, requestId: requestIdSchema,
  expectedRevision: z.number().int().positive(), selectedIds: z.array(idSchema).max(200) }).strict();
export const confirmScaffoldSchema = z.object({ id: idSchema, requestId: requestIdSchema, expectedRevision: z.number().int().positive(), blockId: idSchema }).strict();
export type ViewEvent = { seq: number; type: 'created' | 'updated' | 'submitted' | 'scaffold-confirmed' | 'cleared';
  revision: number; at: string; selectedIds?: string[]; confirmation?: ScaffoldConfirmation };
export const publicationSchema = z.object({ sourceKey: z.string().min(1).max(200), definitionKey: z.string().min(1).max(200),
  coverageKey: z.string().min(1).max(200), purpose: z.string().min(1).max(200), coverage: z.string().min(1).max(200),
  audience: z.discriminatedUnion('kind', [z.object({ kind: z.literal('company') }).strict(),
    z.object({ kind: z.literal('members'), members: z.array(z.string().min(1).max(200)).min(1).max(100) }).strict()]) }).strict();
export const refreshSchema = z.object({ status: z.enum(['requested', 'running', 'succeeded', 'failed']), generation: z.number().int().positive(),
  requestedAt: z.iso.datetime(), expiresAt: z.iso.datetime().optional(), completedAt: z.iso.datetime().optional(), error: z.string().max(500).optional(), leaseId: z.string().optional() }).strict();
export const metricsPublishSchema = z.object({ id: idSchema, requestId: requestIdSchema, document: documentSchema, publication: publicationSchema }).strict();
export const metricsReserveSchema = z.object({ id: idSchema, requestId: requestIdSchema, publication: publicationSchema }).strict();
export const metricsRefreshSchema = z.object({ id: idSchema, requestId: requestIdSchema, action: z.enum(['request', 'claim', 'complete', 'fail']),
  leaseId: z.string().max(200).optional(), expectedRevision: z.number().int().positive().optional(), document: documentSchema.optional(), error: z.string().min(1).max(500).optional() }).strict();
export type View = { id: string; revision: number; document: ViewDocument; canEdit?: boolean;
  updatedAt: string; submission: { selectedIds: string[]; revision: number; at: string } | null; scaffoldConfirmation?: ScaffoldConfirmation | null;
  publication?: z.infer<typeof publicationSchema> | null; publicationReady?: boolean; refresh?: z.infer<typeof refreshSchema> | null };
export const viewSchema = z.object({ id: idSchema, revision: z.number().int().positive(), document: documentSchema, canEdit: z.boolean().default(false),
  updatedAt: z.iso.datetime(), submission: z.object({ selectedIds: z.array(idSchema), revision: z.number().int().positive(), at: z.iso.datetime() }).nullable(), scaffoldConfirmation: scaffoldConfirmationSchema.nullable().optional(),
  publication: publicationSchema.nullable().optional(), publicationReady: z.boolean().optional(), refresh: refreshSchema.nullable().optional() }).strict();
export const eventReceiptSchema = z.object({ seq: z.number().int().positive(), type: z.enum(['created', 'updated', 'submitted', 'scaffold-confirmed', 'cleared']),
  revision: z.number().int().positive(), at: z.iso.datetime() }).strict();
export const mutationSchema = z.object({ id: idSchema, revision: z.number().int().positive(), appliedRevision: z.number().int().positive(), updatedAt: z.iso.datetime(),
  canEdit: z.boolean(), event: eventReceiptSchema, replayed: z.boolean(),
  confirmation: scaffoldConfirmationSchema.omit({ config: true, plan: true }).optional() }).strict();
export type Mutation = z.infer<typeof mutationSchema>;
export const eventSchema = eventReceiptSchema.extend({ selectedIds: z.array(idSchema).optional(), confirmation: scaffoldConfirmationSchema.optional() });
export const eventPageSchema = z.object({ events: z.array(eventSchema), cursor: z.number().int().nonnegative(), view: viewSchema.optional(),
  historyStart: z.number().int().nonnegative(), truncated: z.boolean() }).strict();
export type EventPage = Omit<z.infer<typeof eventPageSchema>, 'view'> & { view?: View };

export const catalog = {
  schemaVersion: 1,
  metricsDashboardVersion: 1,
  overviewVersion: 1,
  overviewRefreshVersion: 1,
  components: [
    { type: 'note', version: 1, description: 'Текстовое пояснение' },
    { type: 'tasks', version: 1, description: 'Задачи, локальный фильтр и выбор для передачи агенту' },
    { type: 'metrics', version: 1, description: 'Панель показателей: месяцы/годы, факт/план, несколько серий, оперативный срез, статусы и источники; metricsDashboardVersion=1' },
    { type: 'chart', version: 1, description: 'График факт/план; пропуск не подменяется нулём; таблица значений' },
    { type: 'scaffold', version: 1, description: 'Конструктор каркаса, семантический JSON и подтверждение конкретной ревизии структуры' },
  ],
  scaffold: scaffoldCatalog,
  documentSchema: z.toJSONSchema(documentSchema, { unrepresentable: 'any' }),
};
