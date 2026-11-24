import { createHash } from 'node:crypto';
import { z } from 'zod';
import { idSchema, requestIdSchema, type View, type ViewDocument } from './model';
import { ViewClient } from './client';
import { Refusal } from './store';
import { initialTreeConfig } from './scaffold-tree';
import { materializeMutation } from './mutation';

export const openSchema = z.object({
  id: idSchema,
  preset: z.literal('space-setup').optional(),
  create: z.object({ requestId: requestIdSchema, companyName: z.string().trim().min(1).max(100) }).strict().optional(),
}).strict();
export const resultSchema = z.object({ id: idSchema }).strict();

// This factory has no company examples, local paths, credentials or filesystem effects.
export function spaceSetupDocument(companyName: string): ViewDocument {
  const config = initialTreeConfig(companyName);
  return { schemaVersion: 1, title: 'Настройка пространства',
    description: 'Согласуйте первоначальный каркас пространства и передайте структуру агенту.',
    layout: 'stack', blocks: [{ id: 'space-setup', type: 'scaffold', version: 1,
      title: 'Первый каркас пространства', config }] };
}

function scaffold(view: View) {
  const blocks = view.document.blocks;
  if (blocks.length !== 1 || blocks[0].type !== 'scaffold') {
    return null;
  }
  return blocks[0];
}

function describe(client: ViewClient, view: View, cursor: number) {
  const block = scaffold(view);
  return { id: view.id, revision: view.revision, cursor,
    status: view.scaffoldConfirmation ? 'confirmed' as const : view.submission ? 'submitted' as const : 'pending' as const,
    browserUrl: `${client.base}/?view=${encodeURIComponent(view.id)}`,
    ...(block ? { catalogVersion: block.config.catalogVersion, canonSnapshot: block.config.canonSnapshot } : {}),
    applicationStatus: 'not-tracked' as const };
}

export async function openView(client: ViewClient, input: unknown) {
  const data = openSchema.parse(input);
  let replayed: boolean | null = null;
  let created: View | null = null;
  let createdCursor = 0;
  if (data.create) {
    const input = { id: data.id, requestId: data.create.requestId, document: spaceSetupDocument(data.create.companyName) };
    const result = await client.create(input);
    replayed = result.replayed;
    created = materializeMutation(null, input, result); createdCursor = result.event.seq;
  }
  const { view, cursor } = created ? { view: created, cursor: createdCursor } : await client.snapshot(data.id);
  return { ...describe(client, view, cursor), mode: data.create ? 'create' as const : 'resume' as const,
    replayed, view };
}

export async function viewResult(client: ViewClient, input: unknown) {
  const { id } = resultSchema.parse(input);
  const { view, cursor } = await client.snapshot(id);
  const block = scaffold(view);
  const descriptor = { ...describe(client, view, cursor), view,
    intent: block?.config ?? null, submission: view.submission };
  const confirmation = view.scaffoldConfirmation;
  if (!confirmation) return { ...descriptor, confirmation: null };
  const confirmedBlock = view.document.blocks.find(item => item.type === 'scaffold' && item.id === confirmation.blockId);
  if (!confirmedBlock || confirmedBlock.type !== 'scaffold')
    throw new Refusal('invalid_confirmation', 'Переданное намерение не соответствует текущему представлению. Нужна проверка состояния.');
  const hash = createHash('sha256').update(JSON.stringify({ config: confirmedBlock.config, plan: confirmation.plan })).digest('hex');
  if (confirmation.revision !== view.revision ||
      confirmation.planHash !== hash || JSON.stringify(confirmation.config) !== JSON.stringify(confirmedBlock.config) ||
      (confirmedBlock.config.schemaVersion === 2 && confirmedBlock.config.overview && confirmation.plan !== null)) {
    throw new Refusal('invalid_confirmation', 'Подтверждение не соответствует текущему каркасу. Нужна проверка состояния.');
  }
  return { ...descriptor, confirmation };
}
