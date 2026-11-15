import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createSchema, updateSchema, submitSchema, confirmScaffoldSchema, documentSchema, idSchema } from './model';
import { checkOverviewUpdate } from './scaffold-tree-model';
import { planScaffold } from './scaffold';
import type { View, ViewEvent, Mutation, EventPage } from './model';

export class Refusal extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
type Receipt = { fingerprint: string; event: ViewEvent };
type Entry = { view: View; events: ViewEvent[]; receipts: Record<string, Receipt> };
type State = { schemaVersion: 1; entries: Record<string, Entry> };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class ViewStore {
  private state: State = { schemaVersion: 1, entries: {} };
  private queue: Promise<unknown> = Promise.resolve();
  private changes = new EventEmitter();
  private lockOwned = false;
  private closed = false;
  constructor(readonly directory: string) { this.changes.setMaxListeners(100); }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, 'writer.lock');
    try {
      const previous = Number(await readFile(lock, 'utf8'));
      if (!Number.isSafeInteger(previous) || previous <= 0) throw new Error('Некорректный writer.lock. Проверьте каталог состояния.');
      try { process.kill(previous, 0); throw new Refusal('writer_busy', 'Каталог уже открыт другим сервисом.'); }
      catch (error: any) { if (error.code !== 'ESRCH') throw error; }
      await unlink(lock);
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const handle = await open(lock, 'wx', 0o600);
    await handle.writeFile(String(process.pid)); await handle.close(); this.lockOwned = true;
    try {
      const raw: State = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'));
      if (raw.schemaVersion !== 1 || !raw.entries || typeof raw.entries !== 'object') throw new Error('Неподдерживаемый формат состояния.');
      for (const [id, entry] of Object.entries(raw.entries)) {
        idSchema.parse(id); documentSchema.parse(entry.view.document);
        if (entry.view.id !== id || !Number.isSafeInteger(entry.view.revision) || !Array.isArray(entry.events)) throw new Error('Повреждено состояние представления.');
        entry.view.canEdit = true;
      }
      this.state = raw;
    } catch (error: any) {
      if (error.code !== 'ENOENT') { await this.close(); throw error; }
    }
    return this;
  }

  private entry(id: string, state = this.state) {
    idSchema.parse(id);
    const entry = Object.hasOwn(state.entries, id) ? state.entries[id] : undefined;
    if (!entry) throw new Refusal('not_found', 'Представление не найдено.', 404);
    return entry;
  }
  get(id: string): View { return structuredClone(this.entry(id).view); }
  snapshot(id: string) {
    const entry = this.entry(id);
    return { view: structuredClone(entry.view), cursor: entry.events.at(-1)?.seq ?? 0 };
  }
  list(): View[] { return Object.values(this.state.entries).map(entry => structuredClone(entry.view)); }

  private async save(state: State) {
    const temp = join(this.directory, `state-${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(state)); await handle.sync(); await handle.close();
      await rename(temp, join(this.directory, 'state.json'));
    } catch (error) { await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); throw error; }
  }

  private mutate(input: unknown, kind: ViewEvent['type']): Promise<Mutation> {
    const task = async () => {
      if (this.closed) throw new Refusal('closed', 'Сервис остановлен.', 503);
      const data = kind === 'created' ? createSchema.parse(input) : kind === 'updated' ? updateSchema.parse(input) : kind === 'scaffold-confirmed' ? confirmScaffoldSchema.parse(input) : submitSchema.parse(input);
      const fingerprint = digest({ kind, data });
      const existing = Object.hasOwn(this.state.entries, data.id) ? this.state.entries[data.id] : undefined;
      const receipt = existing && Object.hasOwn(existing.receipts, data.requestId) ? existing.receipts[data.requestId] : undefined;
      if (existing && receipt) {
        if (receipt.fingerprint !== fingerprint) throw new Refusal('request_conflict', 'Ключ повтора уже использован для другого действия.');
        return this.receipt(existing.view, receipt.event, true);
      }
      if (kind === 'created' && existing) throw new Refusal('already_exists', 'Представление уже существует.');
      if (kind === 'created' && 'onlyIfEmpty' in data && data.onlyIfEmpty && Object.values(this.state.entries).some(entry =>
        entry.view.document.blocks.length === 1 && entry.view.document.blocks[0].type === 'scaffold')) {
        throw new Refusal('view_discovery_changed', 'Появилось подходящее представление. Перечитайте список и используйте его.');
      }
      if (kind !== 'created' && !existing) throw new Refusal('not_found', 'Представление не найдено.', 404);
      if ('expectedRevision' in data) {
        if (!existing) throw new Refusal('not_found', 'Представление не найдено.', 404);
        if (existing.view.revision !== data.expectedRevision) throw new Refusal('revision_conflict', 'Представление изменилось. Перечитайте его и согласуйте актуальные изменения.');
      }
      if (kind === 'updated' && existing && 'document' in data) {
        const overview = (document: View['document']) => {
          const block = document.blocks.length === 1 ? document.blocks[0] : undefined;
          return block?.type === 'scaffold' && block.config.schemaVersion === 2 && block.config.overview ? block : undefined;
        };
        const before = overview(existing.view.document), after = overview(data.document);
        if ('refreshOverview' in data && data.refreshOverview) {
          if (!after || after.config.schemaVersion !== 2 || !after.config.overview?.capturedAt) throw new Refusal('invalid_overview', 'Обновление требует нового снимка папки.');
        } else if (before || after) {
          if (!before || !after || before.id !== after.id) throw new Refusal('overview_immutable', 'Нельзя заменить режим обзора.');
          try { checkOverviewUpdate(before.config as any, after.config as any); }
          catch { throw new Refusal('overview_locked_path', 'Нельзя изменить границы обзора или закрытую ветку.'); }
        }
      }
      if (kind === 'created' && Object.keys(this.state.entries).length >= 30) throw new Refusal('limit', 'Лимит локального пилота: 30 представлений.', 422);
      const next = structuredClone(this.state);
      const at = new Date().toISOString();
      const revision = (existing?.view.revision ?? 0) + 1;
      let confirmation: View['scaffoldConfirmation'] = null;
      if ('blockId' in data) {
        const block = existing?.view.document.blocks.find(block => block.id === data.blockId);
        if (!block || block.type !== 'scaffold') throw new Refusal('unknown_scaffold', 'Компонент конструктора не найден.', 422);
        const plan = block.config.schemaVersion === 2 && block.config.overview ? null : planScaffold(block.config);
        confirmation = { blockId: data.blockId, documentRevision: existing!.view.revision, revision, at,
          planHash: digest({ config: block.config, plan }), config: structuredClone(block.config), plan };
      }
      let selectedIds: string[] | undefined;
      if ('selectedIds' in data) {
        if (!existing) throw new Refusal('not_found', 'Представление не найдено.', 404);
        if (!existing.view.document.blocks.some(block => block.type === 'tasks')) {
          throw new Refusal('wrong_view_kind', 'В этом представлении нет компонента задач.', 422);
        }
        const available = new Set(existing.view.document.blocks.flatMap(block => block.type === 'tasks' ? block.items.map(item => item.id) : []));
        selectedIds = [...new Set(data.selectedIds)];
        if (selectedIds.some(id => !available.has(id))) throw new Refusal('unknown_item', 'В выборе есть задача, которой уже нет в представлении.', 422);
      }
      const event: ViewEvent = { seq: (existing?.events.at(-1)?.seq ?? 0) + 1, type: kind, revision, at,
        ...(selectedIds ? { selectedIds } : {}), ...(confirmation ? { confirmation } : {}) };
      const view: View = { id: data.id, revision, updatedAt: at, canEdit: true,
        document: 'document' in data ? data.document : this.entry(data.id).view.document,
        submission: selectedIds ? { selectedIds, revision, at } : kind === 'scaffold-confirmed' ? existing!.view.submission : null,
        scaffoldConfirmation: confirmation };
      const events = [...(existing?.events ?? []), event].slice(-512);
      const receipts = { ...(existing?.receipts ?? {}), [data.requestId]: { fingerprint, event } };
      const bySequence = Object.keys(receipts).sort((a, b) => receipts[a].event.seq - receipts[b].event.seq);
      for (const key of bySequence.slice(0, -512)) delete receipts[key];
      next.entries[data.id] = { view, events, receipts };
      await this.save(next); this.state = next;
      this.changes.emit('changed', data.id);
      return this.receipt(view, event, false);
    };
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  private receipt(view: View, event: ViewEvent, replayed: boolean): Mutation {
    const { seq, type, revision, at } = event;
    const confirmation = event.confirmation;
    return { id: view.id, revision: view.revision, updatedAt: view.updatedAt, canEdit: view.canEdit === true,
      event: { seq, type, revision, at }, appliedRevision: revision, replayed,
      ...(confirmation ? { confirmation: { blockId: confirmation.blockId, documentRevision: confirmation.documentRevision,
        revision: confirmation.revision, at: confirmation.at, planHash: confirmation.planHash } } : {}) };
  }
  create(input: unknown) { return this.mutate(input, 'created'); }
  update(input: unknown) { return this.mutate(input, 'updated'); }
  submit(input: unknown) { return this.mutate(input, 'submitted'); }
  confirmScaffold(input: unknown) { return this.mutate(input, 'scaffold-confirmed'); }

  events(id: string, after: number): EventPage {
    const entry = this.entry(id);
    if (!Number.isSafeInteger(after) || after < 0 || after > (entry.events.at(-1)?.seq ?? 0)) throw new Refusal('invalid_cursor', 'Некорректный курсор событий.', 422);
    if (after > 0 && after < entry.events[0].seq - 1) throw new Refusal('cursor_expired', 'История курсора истекла. Перечитайте представление и события с нуля.');
    const historyStart = entry.events[0]?.seq ?? 0;
    const events = structuredClone(entry.events.filter(event => event.seq > after));
    return { events, cursor: entry.events.at(-1)?.seq ?? 0, ...(events.length ? { view: structuredClone(entry.view) } : {}),
      historyStart, truncated: after < historyStart - 1 };
  }
  subscribe(listener: (id: string) => void) {
    this.changes.on('changed', listener);
    return () => { this.changes.off('changed', listener); };
  }
  async wait(id: string, after: number, timeoutMs: number, signal?: AbortSignal): Promise<EventPage> {
    const initial = this.events(id, after);
    if (initial.events.length || timeoutMs === 0) return initial;
    const bounded = Math.min(Math.max(timeoutMs, 0), 45000);
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(this.events(id, after));
      };
      const unsubscribe = this.subscribe(changedId => { if (changedId === id) finish(); });
      const abort = () => finish(new Refusal('cancelled', 'Ожидание отменено.', 499));
      const timer = setTimeout(() => finish(), bounded);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else if (this.events(id, after).events.length) finish();
    });
  }
  async close() {
    this.closed = true; await this.queue;
    if (this.lockOwned) { await unlink(join(this.directory, 'writer.lock')); this.lockOwned = false; }
    this.changes.removeAllListeners();
  }
}
