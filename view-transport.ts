/** Shared gateway protocol adapters for the composed BB View module. */
import { z } from 'zod/v4';
import type { ViewTransport } from 'bb-plugin-svaib-view-pilot/renderer';
import {
  confirmScaffoldSchema, idSchema, viewSchema, submitSchema, updateSchema,
  eventPageSchema, mutationSchema, type View, type ViewEvent, type Mutation,
} from 'bb-plugin-svaib-view-pilot/model';
import { materializeMutation } from 'bb-plugin-svaib-view-pilot/mutation';

const contextSchema = z.object({
  account_id: z.string().min(1).max(256), company_id: z.string().min(1).max(64),
  subject_id: z.string().min(1).max(256), thread_id: z.string().min(1).max(256),
  environment_id: z.string().min(1).max(256), host_id: z.string().min(1).max(256),
}).strict();
export type ViewContext = z.infer<typeof contextSchema>;
export type ViewBinding = ViewContext & { view_id: string };
type Submit = Parameters<ViewTransport['submit']>[0];
type Update = Parameters<NonNullable<ViewTransport['update']>>[0];
type Confirm = Parameters<NonNullable<ViewTransport['confirmScaffold']>>[0];
export type Snapshot = { view: View; cursor: number };
export type Events = { view?: View; cursor: number; events: ViewEvent[]; historyStart: number; truncated: boolean };
type Operation = 'view_get' | 'view_submit' | 'view_update' | 'view_scaffold_confirm' | 'view_events';

export class ViewTransportError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ViewTransportError'; }
}

/** Backend/RPC boundary. This facade never exposes credentials or identity to the UI. */
export interface ViewBackendPort {
  get(signal?: AbortSignal): Promise<Snapshot>;
  submit(input: Submit, signal?: AbortSignal): Promise<Mutation>;
  update(input: Update, signal?: AbortSignal): Promise<Mutation>;
  confirmScaffold(input: Confirm, signal?: AbortSignal): Promise<Mutation>;
  expandScaffold?(input: Parameters<NonNullable<ViewTransport['expandScaffold']>>[0], signal?: AbortSignal): Promise<{ view: View }>;
  events(input: { after: number; timeoutMs: number }, signal?: AbortSignal): Promise<Events>;
}

export const viewSnapshotSchema = z.object({ view: viewSchema, cursor: z.number().int().positive() }).strict();
export const viewEventsSchema = eventPageSchema;
export const viewMutationSchema = mutationSchema;
const eventInput = z.object({ after: z.number().int().nonnegative(),
  timeoutMs: z.number().int().min(0).max(45000) }).strict();

/** Backend only. Binding/provider must come from native BB and verified svaib context.
 * callMcp must select the server-side grant for expectedContext, or refuse if it changed;
 * it returns the MCP SDK tools/call result (not a JSON-RPC envelope). No new OAuth here.
 * Re-reading is a local fence; gateway /mcp remains the authority for current rights.
 */
export function createViewBackend(options: {
  binding: ViewBinding;
  readTrustedContext(signal: AbortSignal): Promise<unknown>;
  callMcp(request: { name: Operation; arguments: Record<string, unknown> },
    options: { expectedContext: Readonly<ViewContext>; signal: AbortSignal }): Promise<unknown>;
}): ViewBackendPort & { dispose(): void } {
  const binding = contextSchema.extend({ view_id: idSchema }).strict().parse(options.binding);
  const { view_id: id, ...identity } = binding;
  const expectedContext = Object.freeze(identity);
  const lifetime = new AbortController();
  async function check(signal: AbortSignal) {
    signal.throwIfAborted();
    const parsed = contextSchema.safeParse(await options.readTrustedContext(signal));
    signal.throwIfAborted();
    if (!parsed.success || (Object.keys(expectedContext) as (keyof ViewContext)[])
      .some(key => parsed.data[key] !== expectedContext[key])) throw new ViewTransportError('context_changed');
  }
  async function call(name: Operation, args: Record<string, unknown>, signal?: AbortSignal) {
    const active = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    await check(active);
    const result = await options.callMcp({ name, arguments: { ...args, id, company_id: expectedContext.company_id } },
      { expectedContext, signal: active });
    await check(active);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ViewTransportError('invalid_response');
    const envelope = result as { isError?: unknown; structuredContent?: unknown };
    if (envelope.isError === true) {
      const error = z.object({ reason: z.string().regex(/^[a-z_]{1,80}$/) }).safeParse(envelope.structuredContent);
      throw new ViewTransportError(error.success ? error.data.reason : 'mcp_error');
    }
    if (envelope.isError !== false && envelope.isError !== undefined) throw new ViewTransportError('invalid_response');
    return envelope.structuredContent;
  }
  function snapshot(value: unknown): Snapshot {
    const parsed = viewSnapshotSchema.safeParse(value);
    if (!parsed.success || parsed.data.view.id !== id || parsed.data.cursor !== parsed.data.view.revision)
      throw new ViewTransportError('invalid_response');
    return parsed.data;
  }
  async function mutate(name: Operation, input: Submit | Update | Confirm, schema: { parse(value: unknown): Record<string, unknown> }, signal?: AbortSignal) {
    let parsed: Record<string, unknown>;
    try { parsed = schema.parse(input); } catch { throw new ViewTransportError('invalid_arguments'); }
    if (parsed.id !== id) throw new ViewTransportError('invalid_arguments');
    // Structural parse port keeps canonical schemas independent of package-local Zod versions.
    const result = viewMutationSchema.safeParse(await call(name, parsed, signal));
    if (!result.success || result.data.id !== id || result.data.appliedRevision !== result.data.event.revision ||
      result.data.event.seq !== result.data.appliedRevision || result.data.appliedRevision > result.data.revision)
      throw new ViewTransportError('invalid_response');
    return result.data;
  }
  return {
    get: async signal => snapshot(await call('view_get', {}, signal)),
    submit: (input, signal) => mutate('view_submit', input, submitSchema, signal),
    update: (input, signal) => mutate('view_update', input, updateSchema, signal),
    confirmScaffold: (input, signal) => mutate('view_scaffold_confirm', input, confirmScaffoldSchema, signal),
    events: async (input, signal) => {
      const checked = eventInput.safeParse(input);
      if (!checked.success) throw new ViewTransportError('invalid_arguments');
      const parsed = viewEventsSchema.safeParse(await call('view_events', checked.data, signal));
      if (!parsed.success) throw new ViewTransportError('invalid_response');
      if (parsed.data.view) snapshot({ view: parsed.data.view, cursor: parsed.data.cursor });
      if ((parsed.data.events.length > 0) !== Boolean(parsed.data.view)) throw new ViewTransportError('invalid_response');
      if (parsed.data.cursor < input.after || parsed.data.historyStart > parsed.data.cursor ||
        parsed.data.events.some((event, i, all) => event.seq <= input.after || event.seq > parsed.data.cursor ||
          event.revision !== event.seq || (i > 0 && all[i - 1].seq >= event.seq)))
        throw new ViewTransportError('invalid_response');
      return parsed.data as Events;
    },
    dispose: () => lifetime.abort(),
  };
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Frontend only: backend is an injected RPC facade. No context/provider/token here.
 * The eventual RPC wiring must propagate cancellation or bound requests to its lifecycle.
 */
export function createViewTransport(options: {
  backend: ViewBackendPort;
  onError?(error: unknown): void;
}): ViewTransport & { dispose(): void } {
  const lifetime = new AbortController();
  const subscriptions = new Set<AbortController>();
  let drain: (() => Promise<void>) | undefined;
  let closing = false;
  const backend = options.backend;
  let latest: View | undefined;
  let pendingRead: Promise<View> | undefined;
  function remember(view: View): View {
    if (!latest || view.revision >= latest.revision) latest = view;
    return latest;
  }
  function read(signal: AbortSignal): Promise<View> {
    if (!pendingRead) pendingRead = backend.get(signal).then(value => remember(value.view)).finally(() => { pendingRead = undefined; });
    return pendingRead;
  }
  async function mutate(input: Submit | Update | Confirm, run: (signal: AbortSignal) => Promise<Mutation>) {
    return request(async signal => {
      const base = latest;
      const receipt = await run(signal);
      const materialized = base ? materializeMutation(base, input, receipt) : null;
      signal.throwIfAborted();
      const view = materialized ? remember(materialized) : await read(signal);
      return { view };
    });
  }
  async function request<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    lifetime.signal.throwIfAborted();
    const result = await run(lifetime.signal);
    lifetime.signal.throwIfAborted();
    return result;
  }
  return {
    registerDrain(callback) {
      if (closing) throw new ViewTransportError('closed');
      drain = callback;
      return () => { if (drain === callback) drain = undefined; };
    },
    load: () => request(read),
    submit: input => mutate(input, signal => backend.submit(input, signal)),
    update: input => mutate(input, signal => backend.update(input, signal)),
    confirmScaffold: input => mutate(input, signal => backend.confirmScaffold(input, signal)),
    ...(backend.expandScaffold ? {expandScaffold: (input: Parameters<NonNullable<ViewTransport['expandScaffold']>>[0]) => request(signal => backend.expandScaffold!(input, signal))} : {}),
    subscribe(invalidate) {
      lifetime.signal.throwIfAborted();
      const controller = new AbortController(); subscriptions.add(controller);
      const signal = AbortSignal.any([lifetime.signal, controller.signal]);
      const notify = (view?: View, error?: unknown) => { if (!signal.aborted) invalidate(view, error); };
      void (async () => {
        let cursor: number | undefined;
        while (!signal.aborted) {
          try {
            if (cursor === undefined) { const view = latest ?? await read(signal); cursor = view.revision; notify(view); }
            const page = await backend.events({ after: cursor, timeoutMs: 45000 }, signal);
            signal.throwIfAborted();
            if (page.view) { const before = latest?.revision ?? 0; const view = remember(page.view); if (view.revision > before) notify(view); }
            else if (page.cursor > cursor || page.truncated) { const view = await read(signal); notify(view); }
            cursor = page.cursor;
          } catch (error) {
            if (signal.aborted) return;
            if (error instanceof ViewTransportError && error.code === 'cursor_expired') { cursor = undefined; latest = undefined; continue; }
            latest = undefined;
            options.onError?.(error);
            if (error instanceof ViewTransportError) { notify(undefined, error); return; }
            cursor = undefined;
          }
          // Also prevents a busy loop if an upstream transport returns empty pages immediately.
          await delay(250, signal);
        }
      })().catch(error => { if (!signal.aborted) options.onError?.(error); })
        .finally(() => subscriptions.delete(controller));
      return () => { controller.abort(); subscriptions.delete(controller); };
    },
    dispose() {
      if (closing) return;
      closing = true;
      for (const controller of subscriptions) controller.abort(); subscriptions.clear();
      if (!drain) { lifetime.abort(); return; }
      const timeout = setTimeout(() => lifetime.abort(), 15000);
      try {
        void Promise.resolve(drain()).catch(() => {}).finally(() => { clearTimeout(timeout); lifetime.abort(); });
      } catch { clearTimeout(timeout); lifetime.abort(); }
    },
  };
}
