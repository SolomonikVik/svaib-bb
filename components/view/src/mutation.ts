import type { Mutation, View, ViewDocument } from './model';
import { planScaffold } from './scaffold';

export type MutationInput = { id: string; document?: ViewDocument; expectedRevision?: number; selectedIds?: string[]; blockId?: string };

/** Rebuild our exact successful write from its input. Unknown later revisions need a read. */
export function materializeMutation(base: View | null | undefined, input: MutationInput, receipt: Mutation): View | null {
  if (receipt.id !== input.id || receipt.revision !== receipt.appliedRevision) return null;
  if (base && base.id === receipt.id && base.revision >= receipt.revision) return base;
  if (input.expectedRevision !== undefined && (!base || base.id !== input.id || base.revision !== input.expectedRevision)) return null;
  const document = input.document ?? (base?.id === input.id ? base.document : undefined);
  if (!document) return null;
  const view: View = { ...base, id: receipt.id, revision: receipt.revision, updatedAt: receipt.updatedAt,
    canEdit: receipt.canEdit, document, submission: null, scaffoldConfirmation: null };
  if (receipt.event.type === 'submitted') {
    if (!input.selectedIds) return null;
    view.submission = { selectedIds: [...new Set(input.selectedIds)], revision: receipt.appliedRevision, at: receipt.event.at };
  } else if (receipt.event.type === 'scaffold-confirmed') {
    const confirmation = receipt.confirmation;
    const block = document.blocks.find(block => block.id === input.blockId);
    if (!confirmation || !block || block.type !== 'scaffold' || confirmation.blockId !== block.id) return null;
    view.submission = base?.submission ?? null;
    view.scaffoldConfirmation = { ...confirmation, config: block.config,
      plan: block.config.schemaVersion === 2 && block.config.overview ? null : planScaffold(block.config) };
  }
  return view;
}

/** Scope one instance to one authorized account/company/object. Every load still checks access. */
export function createSnapshotReader(read: () => Promise<View>) {
  let snapshot: View | null = null;
  let pending: Promise<View> | null = null;
  let epoch = 0;
  const accept = (next: View) => {
    if (snapshot?.id === next.id && snapshot.revision > next.revision) return snapshot;
    snapshot = next;
    return next;
  };
  return {
    current: () => snapshot,
    accept,
    clear() { snapshot = null; pending = null; ++epoch; },
    load() {
      if (pending) return pending;
      const started = epoch;
      const task = read().then(next => {
        if (started !== epoch) throw Object.assign(new Error('Доступ к представлению изменился.'), { code: 'context_changed' });
        return accept(next);
      });
      pending = task;
      void task.finally(() => { if (pending === task) pending = null; }).catch(() => {});
      return task;
    },
  };
}
