import './browser-runtime';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { Block, View } from '../src/model';
import { ScaffoldEditor, clearScaffoldDrafts, viewErrorMessage } from './ScaffoldEditor';
import './view.css';
import MetricsDashboardPanel, { type MetricDiscussion, type MetricPreferences } from './MetricsDashboard';

export type ViewDiscussion = MetricDiscussion & { viewId: string; revision: number; blockId: string };

echarts.use([BarChart, GridComponent, TooltipComponent, LegendComponent, SVGRenderer]);
type ChartBlock = Extract<Block, { type: 'chart' }>;
const number = (value: number | null | undefined) => value == null ? 'Нет данных' : value.toLocaleString('ru-RU');

function Chart({ block }: { block: ChartBlock }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: 'svg' });
    chart.setOption({
      color: ['#22988d', '#d977a9'],
      grid: { left: 48, right: 16, top: 48, bottom: 35 },
      tooltip: { trigger: 'axis', renderMode: 'richText' },
      legend: { top: 8, textStyle: { color: '#52647a' } },
      xAxis: { type: 'category', data: block.points.map(point => point.label), axisLabel: { color: '#52647a', hideOverlap: true } },
      yAxis: { type: 'value', axisLabel: { color: '#52647a' } },
      series: [
        { name: 'Факт', type: 'bar', data: block.points.map(point => point.value), barMaxWidth: 30 },
        { name: 'План', type: 'bar', data: block.points.map(point => point.plan ?? null), barMaxWidth: 30 },
      ],
    });
    const resize = new ResizeObserver(() => chart.resize()); resize.observe(ref.current);
    return () => { resize.disconnect(); chart.dispose(); };
  }, [block]);
  return <>
    <div ref={ref} className="view-chart" role="img" aria-label={`${block.title}. Факт и план; значения в таблице ниже.`} />
    <details><summary>Таблица значений · {block.unit}</summary><div className="view-table-scroll"><table>
      <caption>{block.title}</caption><thead><tr><th>Период</th><th>Факт</th><th>План</th></tr></thead>
      <tbody>{block.points.map((point, index) => <tr key={index}><td>{point.label}</td><td>{number(point.value)}</td><td>{number(point.plan)}</td></tr>)}</tbody>
    </table></div></details>
    <p className="view-source">{block.source.title} · проверено {new Date(block.verifiedAt).toLocaleString('ru-RU')}<br /><code>{block.source.ref}</code></p>
  </>;
}

export type ViewTransport = {
  load(): Promise<View>;
  submit(input: { id: string; requestId: string; expectedRevision: number; selectedIds: string[] }): Promise<{ view: View }>;
  update?(input: { id: string; requestId: string; expectedRevision: number; document: View['document'] }): Promise<{ view: View }>;
  confirmScaffold?(input: { id: string; requestId: string; expectedRevision: number; blockId: string }): Promise<{ view: View }>;
  expandScaffold?(input: { nodeId: string; requestId: string; expectedRevision: number }): Promise<{ view: View }>;
  registerDrain?(drain: () => Promise<void>): () => void;
  subscribe?(invalidate: (view?: View, error?: unknown) => void): () => void;
};

const snapshots = new Map<string, View>();
const SNAPSHOT_LIMIT = 20;
export function clearViewSnapshots(prefix?: string) {
  if (!prefix) { snapshots.clear(); clearScaffoldDrafts(); return; }
  for (const key of snapshots.keys()) if (key.startsWith(prefix)) { snapshots.delete(key); clearScaffoldDrafts(key); }
}
function rememberSnapshot(key: string | undefined, view: View) {
  if (!key) return;
  snapshots.delete(key); snapshots.set(key, view);
  while (snapshots.size > SNAPSHOT_LIMIT) snapshots.delete(snapshots.keys().next().value!);
}

type SurfaceProps = { transport: ViewTransport; invalidate?: number; cacheKey?: string; embedded?: boolean; onDiscuss?: (context: ViewDiscussion) => void; metricsPreferences?: MetricPreferences; metricsActions?: (view: View) => ReactNode };
export function ViewSurface(props: SurfaceProps) {
  if (props.embedded) return <div className="view-embedded"><ViewContent {...props} /></div>;
  return <div className="view-bb-page"><div className="view-frame"><ViewContent {...props} /></div></div>;
}

function ViewContent({ transport, invalidate = 0, cacheKey, embedded = false, onDiscuss, metricsPreferences, metricsActions }: SurfaceProps) {
  const cached = cacheKey ? snapshots.get(cacheKey) : undefined;
  const [view, setView] = useState<View | null>(cached ?? null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(cached?.submission?.selectedIds ?? []));
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(false);
  const [verifiedTransport, setVerifiedTransport] = useState<ViewTransport | null>(null);
  const sequence = useRef(0);
  const latest = useRef<View | null>(cached ?? null);
  const alive = useRef(true);
  const writesAllowed = useRef(cached?.canEdit === true);
  const accessEpoch = useRef(0);
  const loadError = useRef(false);
  const pendingLoad = useRef<Promise<void> | null>(null);
  function revoke(cause: unknown) {
    if (!['not_found', 'permission_denied', 'unauthorized', 'context_changed', 'context_unavailable', 'authentication_required', 'metrics_required', 'view_binding_required'].includes((cause as { code?: string })?.code ?? '')) return;
    writesAllowed.current = false; ++accessEpoch.current; ++sequence.current; latest.current = null;
    if (cacheKey) { snapshots.delete(cacheKey); clearScaffoldDrafts(cacheKey); }
    setSelected(new Set()); setView(null); setOnline(false);
  }
  const editorTransport = useMemo(() => {
    const write = async <Input,>(operation: (input: Input) => Promise<{ view: View }>, input: Input) => {
      const epoch = accessEpoch.current;
      const refused = () => Object.assign(new Error('Доступ к представлению изменился.'), { code: 'context_changed' });
      if (!writesAllowed.current) throw refused();
      let result: { view: View };
      try { result = await operation(input); } catch (cause) { if (alive.current && epoch === accessEpoch.current) revoke(cause); throw cause; }
      if (!writesAllowed.current || epoch !== accessEpoch.current) throw refused();
      return result;
    };
    return { ...transport,
      ...(transport.update ? { update: (input: Parameters<NonNullable<ViewTransport['update']>>[0]) => write(value => transport.update!(value), input) } : {}),
      ...(transport.confirmScaffold ? { confirmScaffold: (input: Parameters<NonNullable<ViewTransport['confirmScaffold']>>[0]) => write(value => transport.confirmScaffold!(value), input) } : {}),
      ...(transport.expandScaffold ? { expandScaffold: (input: Parameters<NonNullable<ViewTransport['expandScaffold']>>[0]) => write(value => transport.expandScaffold!(value), input) } : {}),
    };
  }, [transport]);
  function receive(next: View) {
    const previous = latest.current;
    if (previous?.id === next.id && previous.revision > next.revision) return;
    const sharedChoiceChanged = previous?.id !== next.id || previous?.submission?.revision !== next.submission?.revision;
    latest.current = next;
    writesAllowed.current = next.canEdit === true;
    rememberSnapshot(cacheKey, next);
    setView(next); setOnline(true); setVerifiedTransport(transport);
    const ids = new Set(next.document.blocks.flatMap(block => block.type === 'tasks' ? block.items.map(task => task.id) : []));
    setSelected(current => new Set((sharedChoiceChanged || next.canEdit !== true ? next.submission?.selectedIds ?? [] : [...current]).filter(id => ids.has(id))));
  }
  const load = async () => {
    if (pendingLoad.current) return pendingLoad.current;
    const current = ++sequence.current;
    const operation = (async () => { try {
      const next = await transport.load();
      if (!alive.current || current !== sequence.current) return;
      receive(next);
      if (loadError.current) { loadError.current = false; setError(''); }
    } catch (cause) {
      if (alive.current && current === sequence.current) {
        loadError.current = true; setOnline(false); setError(viewErrorMessage(cause));
        revoke(cause);
      }
    } })();
    pendingLoad.current = operation;
    try { await operation; } finally { if (pendingLoad.current === operation) pendingLoad.current = null; }
  };
  useEffect(() => {
    ++accessEpoch.current; pendingLoad.current = null;
    let active = true;
    alive.current = true; latest.current = cached ?? null; writesAllowed.current = cached?.canEdit === true; setView(cached ?? null);
    setSelected(new Set(cached?.submission?.selectedIds ?? [])); loadError.current = false; setError(''); setOnline(false); setVerifiedTransport(null); void load();
    const unsubscribe = transport.subscribe?.((next, cause) => {
      if (!active) return;
      if (cause) { revoke(cause); loadError.current = true; setOnline(false); setError(viewErrorMessage(cause)); }
      if (next) { receive(next); if (loadError.current) { loadError.current = false; setError(''); } }
      else void load();
    });
    return () => { active = false; alive.current = false; ++sequence.current; ++accessEpoch.current; pendingLoad.current = null; unsubscribe?.(); };
  }, [transport]);
  useEffect(() => { if (invalidate) void load(); }, [invalidate]);
  const owners = useMemo(() => view ? [...new Set(view.document.blocks.flatMap(block => block.type === 'tasks' ? block.items.map(task => task.owner) : []))] : [], [view]);
  async function submit() {
    if (!view || view.canEdit !== true || !writesAllowed.current || busy) return;
    setBusy(true); loadError.current = false; setError('');
    const epoch = accessEpoch.current;
    try {
      const result = await transport.submit({ id: view.id, expectedRevision: view.revision, requestId: crypto.randomUUID(), selectedIds: [...selected] });
      if (alive.current && epoch === accessEpoch.current && writesAllowed.current) receive(result.view);
    } catch (cause) { if (alive.current && epoch === accessEpoch.current) { loadError.current = false; setError(viewErrorMessage(cause)); revoke(cause); void load(); } }
    finally { if (alive.current) setBusy(false); }
  }
  if (!view || verifiedTransport !== transport) return <section className="sv-view"><p role="status">{error || 'Открываю представление…'}</p>{error && <button onClick={() => void load()}>Повторить</button>}</section>;
  const onlyBlock = view.document.blocks.length === 1 ? view.document.blocks[0] : null;
  const onlyMetrics = onlyBlock?.type === 'metrics';
  const liveActions = online && verifiedTransport === transport;
  if (view.publication && view.publicationReady === false) return <main className="sv-view sv-view-metrics" data-view-id={view.id} data-revision={view.revision}>
    <h1>{view.document.title}</h1>
    <p role="status">{view.refresh?.status === 'failed' ? 'Первое заполнение не завершено. Можно запросить повторное обновление.' : 'Партнёр готовит показатели. Они появятся здесь после проверки источников.'}</p>
    {liveActions && metricsActions?.(view)}
    {error && <p role="alert" className="view-error">{error}</p>}
  </main>;
  if (onlyBlock?.type === 'scaffold') return <main data-view-id={view.id} data-revision={view.revision}>
    {error && <p role="alert" className="view-error">{error}</p>}
    <ScaffoldEditor block={onlyBlock} view={view} transport={editorTransport} receive={receive} cacheKey={cacheKey && `${cacheKey}:${onlyBlock.id}`} />
  </main>;
  return <main className={`sv-view${onlyMetrics ? ' sv-view-metrics' : ''}`} data-view-id={view.id} data-revision={view.revision}>
    {!embedded && !onlyMetrics && <header className="view-header"><div><span className="view-eyebrow">svaib · View</span><h1>{view.document.title}</h1><p>{view.document.description}</p></div>
      <span className="view-connection">{online ? 'Подключён' : 'Нет связи'}</span></header>}
    {!onlyMetrics && <div className="view-toolbar">{owners.length > 0 && <label>Ответственный <select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Все</option>{owners.map(owner => <option key={owner}>{owner}</option>)}</select></label>}
      <button className="view-secondary" title="Перечитать сохранённое представление; источники обновляет партнёр" onClick={() => { setError(''); void load(); }}>Перечитать представление</button></div>
    }
    {error && <div role="alert" className="view-error">{error}{onlyMetrics && <button className="view-secondary" onClick={() => void load()}>Повторить загрузку</button>}</div>}
    <div className={`view-blocks view-${view.document.layout}`}>
      {view.document.blocks.map(block => <section key={block.id} className={`view-card view-block-${block.type}`} data-block-id={block.id}>{block.type !== 'metrics' && <h2>{block.title}</h2>}
        {block.type === 'metrics' ? <MetricsDashboardPanel data={block.data} embedded={embedded} headingLevel={onlyMetrics ? 1 : 2} actions={liveActions && metricsActions ? metricsActions(view) : undefined} preferences={metricsPreferences ? {
          identity: metricsPreferences.identity && JSON.stringify([metricsPreferences.identity, block.id]), ready: metricsPreferences.ready,
          read: id => metricsPreferences.read(JSON.stringify([block.id, id])), write: (id, changes) => metricsPreferences.write(JSON.stringify([block.id, id]), changes),
        } : undefined} onDiscuss={liveActions && onDiscuss ? context => onDiscuss({ ...context, viewId: view.id, revision: view.revision, blockId: block.id }) : undefined} /> : block.type === 'note' ? <p className="view-note-text">{block.text}</p> : block.type === 'chart' ? <Chart block={block} /> : block.type === 'scaffold' ?
          <ScaffoldEditor block={block} view={view} transport={editorTransport} receive={receive} cacheKey={cacheKey && `${cacheKey}:${block.id}`} /> :
          <ul className="view-tasks">{block.items.filter(task => filter === 'all' || task.owner === filter).map(task => <li key={task.id}>
            <label><input type="checkbox" aria-label={`Выбрать: ${task.title}`} disabled={view.canEdit !== true} checked={selected.has(task.id)} onChange={() => { if (view.canEdit === true) setSelected(previous => { const next = new Set(previous); next.has(task.id) ? next.delete(task.id) : next.add(task.id); return next; }); }} />
              <span><strong>{task.title}</strong><small>{task.owner} · {({ active: 'В работе', backlog: 'Отложено', done: 'Сделано' })[task.status]}</small><small className="view-source">{task.source.title}<br /><code>{task.source.ref}</code></small></span></label>
          </li>)}</ul>}
      </section>)}
    </div>
    {view.document.blocks.some(block => block.type === 'tasks') && <footer className="view-submit"><div><strong>Выбрано: {selected.size}</strong><p>Передаём выбор партнёру. Статусы задач в источниках не меняются.</p></div>
      {view.canEdit === true && <button onClick={() => void submit()} disabled={busy}>{busy ? 'Сохраняю…' : 'Передать выбранное агенту'}</button>}
      {view.submission && <p role="status" className="view-saved">Выбор сохранён: {view.submission.selectedIds.length}. Если агент не продолжил, попросите его забрать результат.</p>}
    </footer>}
  </main>;
}
