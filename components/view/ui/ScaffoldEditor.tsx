import { useEffect, useRef, useState } from 'react';
import type { Block, View } from '../src/model';
import type { ViewTransport } from './ViewRenderer';
import { treeConfigSchema, scaffoldVisibilityPolicy, type TreeConfig } from '../src/scaffold-tree-model';
import { toTreeConfig } from './scaffold-tree';
import manifest from '../src/scaffold-catalog.json';
import source from './scaffold-source.json';
import './scaffold-site.css';
import type { ScaffoldFrameMessage } from './raw';
import { z } from 'zod/v4';

const html = source.replace('__VIEW_TEMPLATES__', JSON.stringify(manifest.templates.map(item => item.path)).replaceAll('<', '\\u003c'))
  .replace('__VIEW_VISIBILITY_POLICY__', JSON.stringify(scaffoldVisibilityPolicy).replaceAll('<', '\\u003c'));
const uiSchema = z.object({ selectedId: z.string().max(200), openIds: z.array(z.string().max(200)).max(5000),
  controlGroups: z.record(z.string(), z.boolean()) }).strict();
type UiState = z.infer<typeof uiSchema>;
export function viewErrorMessage(cause: unknown) {
  const error = cause as { code?: string; message?: string };
  if (error?.code === 'not_found') return 'Представление удалено или больше недоступно. Попроси агента проверить доступное представление.';
  if (['permission_denied', 'unauthorized', 'context_changed'].includes(error?.code ?? ''))
    return 'Доступ к представлению изменился. Проверь вход и попроси агента открыть доступное представление.';
  if (['revision_conflict', 'request_conflict'].includes(error?.code ?? '') || /ревизи[яи]|revision_conflict|CAS/i.test(error?.message ?? ''))
    return 'Состояние представления изменилось. Обсуди с агентом актуальные изменения и повтори передачу.';
  return error?.message || 'Не удалось обратиться к View. Попробуй ещё раз.';
}
type SavedDraft = { draft: TreeConfig; base: string; revision: number; ui?: UiState };
const drafts = new Map<string, SavedDraft>();
const draftOwners = new Map<string, symbol>();
export function clearScaffoldDrafts(cacheKey?: string) {
  if (!cacheKey) { drafts.clear(); draftOwners.clear(); return; }
  for (const key of drafts.keys()) if (key.startsWith(`${cacheKey}:`)) { drafts.delete(key); draftOwners.delete(key); }
  for (const key of draftOwners.keys()) if (key.startsWith(`${cacheKey}:`)) draftOwners.delete(key);
}
function saveDraft(key: string | undefined, owner: symbol, value: SavedDraft) {
  if (!key || draftOwners.get(key) !== owner) return;
  drafts.delete(key); drafts.set(key, value);
  while (drafts.size > 20) { const oldest = drafts.keys().next().value!; drafts.delete(oldest); draftOwners.delete(oldest); }
}
type Props = { block: Extract<Block, { type: 'scaffold' }>; view: View; transport: ViewTransport; receive(view: View): void; cacheKey?: string };
export function ScaffoldEditor(props: Props) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(650);
  const [conflict, setConflict] = useState(false);
  const latest = useRef(props); latest.current = props;
  const server = useRef(props.view);
  if (props.view.revision > server.current.revision) server.current = props.view;
  const saved = props.view.canEdit === true && props.cacheKey ? drafts.get(props.cacheKey) : undefined;
  const owner = useRef(Symbol('view-draft'));
  const draft = useRef<TreeConfig>(saved?.draft ?? toTreeConfig(props.block.config));
  const base = useRef(saved?.base ?? JSON.stringify(toTreeConfig(props.block.config)));
  const revision = useRef(saved?.revision ?? props.view.revision);
  const ui = useRef<UiState | undefined>(saved?.ui);
  const busy = useRef(false);
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ready = useRef(false);
  function post(message: unknown) { iframe.current?.contentWindow?.postMessage(message, '*'); }
  function remember() { if (latest.current.view.canEdit === true) saveDraft(props.cacheKey, owner.current, { draft: draft.current, base: base.current, revision: revision.current, ui: ui.current }); }
  function initializeFrame(config: TreeConfig) { post({ type: 'view-init', config, ui: ui.current, readOnly: latest.current.view.canEdit !== true, expandable: Boolean(latest.current.transport.expandScaffold) }); }
  useEffect(() => { if (props.cacheKey) { draftOwners.set(props.cacheKey, owner.current); remember(); } }, [props.cacheKey]);
  useEffect(() => {
    const incoming = toTreeConfig(props.block.config);
    const clean = JSON.stringify(draft.current) === base.current;
    if (props.view.canEdit !== true || clean || JSON.stringify(draft.current) === JSON.stringify(incoming)) {
      const changed = base.current !== JSON.stringify(incoming);
      draft.current = incoming; base.current = JSON.stringify(incoming); revision.current = props.view.revision;
      remember();
      if (ready.current && (changed || props.view.canEdit !== true)) initializeFrame(incoming);
      setConflict(false);
    } else if (!saving.current && props.view.revision !== revision.current) setConflict(true);
    if (ready.current) post({ type: 'view-access', readOnly: props.view.canEdit !== true });
  }, [props.block.config, props.view.revision, props.view.canEdit]);
  useEffect(() => {
    let alive = true;
    async function saveDraftToServer() {
      if (saving.current) { await saving.current; return; }
      const current = latest.current;
      if (current.view.canEdit !== true || !current.transport.update || JSON.stringify(draft.current) === base.current) return;
      if (server.current.revision !== revision.current) { if (alive) setConflict(true); throw new Error('Структура изменилась в другом месте.'); }
      const config = draft.current;
      const snapshot = server.current;
      const operation = (async () => {
        const result = await current.transport.update!({ id: snapshot.id, requestId: crypto.randomUUID(), expectedRevision: revision.current,
          document: { ...snapshot.document, blocks: snapshot.document.blocks.map(item => item.id === current.block.id ? { ...current.block, config } : item) } });
        const newer = server.current.revision > result.view.revision;
        if (!newer) server.current = result.view;
        base.current = JSON.stringify(config); revision.current = result.view.revision; remember();
        if (newer && alive) setConflict(true);
        if (alive) current.receive(result.view);
      })();
      saving.current = operation;
      try { await operation; } finally { saving.current = null; }
    }
    function scheduleSave() {
      if (latest.current.view.canEdit !== true || !latest.current.transport.update) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void saveDraftToServer().then(() => {
          if (alive && JSON.stringify(draft.current) !== base.current && server.current.revision === revision.current) scheduleSave();
        }).catch(async () => {
          if (!alive) return;
          post({ type: 'view-status', message: 'Не удалось сохранить изменения. Черновик сохранён в этом окне.' });
          try { const current = await latest.current.transport.load(); if (alive) latest.current.receive(current); } catch { /* Keep the local draft. */ }
        });
      }, 400);
    }
    async function flushDraft() {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (latest.current.view.canEdit !== true || !latest.current.transport.update) return;
      while (latest.current.view.canEdit === true && (JSON.stringify(draft.current) !== base.current || saving.current)) await saveDraftToServer();
    }
    const unregisterDrain = latest.current.transport.registerDrain?.(flushDraft);
    async function expand(nodeId: unknown) {
      if (typeof nodeId !== 'string' || busy.current || latest.current.view.canEdit !== true || !latest.current.transport.expandScaffold) return;
      const target = draft.current.tree.find(node => node.id === nodeId);
      if (target?.type !== 'folder' || !target.note.startsWith('Не загружено.')) return;
      busy.current = true; post({type:'view-status', busy:true, message:'Читаю папку…'});
      try {
        await flushDraft();
        const current = latest.current;
        const result = await current.transport.expandScaffold!({nodeId, requestId:crypto.randomUUID(), expectedRevision:revision.current});
        if (!alive) return;
        const block = result.view.document.blocks.find(item => item.id === current.block.id);
        if (block?.type !== 'scaffold') throw new Error('Ветка недоступна.');
        server.current = result.view; revision.current = result.view.revision;
        draft.current = toTreeConfig(block.config); base.current = JSON.stringify(draft.current); remember();
        current.receive(result.view); initializeFrame(draft.current);
        post({type:'view-status',message:''});
      } catch (cause) {
        if (alive) post({type:'view-status',message:viewErrorMessage(cause)});
      } finally {busy.current = false; if (alive) post({type:'view-status',busy:false});}
    }
    async function handoff(raw: unknown) {
      if (latest.current.view.canEdit !== true || busy.current) return;
      const parsed = treeConfigSchema.safeParse(raw);
      if (!parsed.success) { post({ type: 'view-status', message: parsed.error.issues[0].message }); return; }
      busy.current = true; post({ type: 'view-status', busy: true, message: '' });
      try {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        draft.current = parsed.data; remember();
        if (!latest.current.transport.update || !latest.current.transport.confirmScaffold) throw new Error('Передача структуры не поддерживается этим подключением.');
        while (latest.current.view.canEdit === true && (JSON.stringify(draft.current) !== base.current || saving.current)) await saveDraftToServer();
        if (latest.current.view.canEdit !== true) return;
        const current = latest.current;
        const confirmed = await current.transport.confirmScaffold!({ id: current.view.id, requestId: crypto.randomUUID(), expectedRevision: revision.current, blockId: current.block.id });
        if (!alive) return;
        server.current = confirmed.view; revision.current = confirmed.view.revision; remember(); current.receive(confirmed.view);
        post({ type: 'view-status', message: 'Структура передана агенту. Если он не продолжил, напишите «Забери структуру».' });
      } catch (cause) {
        if (alive) {
          post({ type: 'view-status', message: viewErrorMessage(cause) });
          try { const current = await latest.current.transport.load(); if (alive) latest.current.receive(current); } catch { /* Keep the draft when refresh fails. */ }
        }
      } finally { busy.current = false; if (alive) post({ type: 'view-status', busy: false }); }
    }
    function listener(event: MessageEvent) {
      if (event.source !== iframe.current?.contentWindow) return;
      const data = event.data as ScaffoldFrameMessage;
      if (data?.type === 'view-resize' && typeof data.height === 'number' && Number.isFinite(data.height) && data.height > 0 && data.height <= 1_000_000) setHeight(Math.ceil(data.height));
      if (data?.type === 'view-ready') { ready.current = true; initializeFrame(draft.current); }
      if (data?.type === 'view-change' && latest.current.view.canEdit === true) {
        const parsed = treeConfigSchema.safeParse(data.config);
        if (parsed.success) { draft.current = parsed.data; remember(); scheduleSave(); }
      }
      if (data?.type === 'view-ui') { const parsed = uiSchema.safeParse(data.ui); if (parsed.success) { ui.current = parsed.data; remember(); } }
      if (data?.type === 'view-handoff') void handoff(data.config);
      if (data?.type === 'view-expand') void expand(data.nodeId);
    }
    window.addEventListener('message', listener);
    if (JSON.stringify(draft.current) !== base.current && latest.current.view.revision === revision.current) scheduleSave();
    return () => {
      alive = false; ready.current = false;
      window.removeEventListener('message', listener);
      unregisterDrain?.();
      void flushDraft().catch(() => { /* The local cache retains an unsaved draft. */ });
    };
  }, []);
  function acceptServerVersion() {
    const current = latest.current;
    const incoming = toTreeConfig(current.block.config);
    draft.current = incoming; base.current = JSON.stringify(incoming); revision.current = current.view.revision;
    remember(); setConflict(false); initializeFrame(incoming);
  }
  return <>{conflict && props.view.canEdit === true && <div role="alert"><p>Структура изменилась в другом месте. Твой черновик сохранён. Обсуди с агентом актуальные изменения перед передачей.</p><button type="button" onClick={acceptServerVersion}>Открыть актуальную версию и отбросить черновик</button></div>}<iframe ref={iframe} className="view-constructor-frame" style={{ height }} title="Конструктор каркаса" sandbox="allow-scripts" onLoad={() => { if (!ready.current) { ready.current = true; initializeFrame(draft.current); } }} srcDoc={html} /></>;
}
