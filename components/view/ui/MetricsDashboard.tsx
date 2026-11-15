import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { init, use } from 'echarts/core';
import { BarChart, LineChart, CustomChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { DashboardMetric, MetricsDashboard, MetricSeries } from '../src/metrics-model';
import {
  availableYears, axisLabel, buildMetricPlot, deltaTone, formatDelta, formatValue, monthLabel, monthRange,
  statusLabel, summary, reconcileMetricView, metricWindow, metricWindowPeriods, METRIC_SELECTION_KEY, METRIC_VIEW_FIELDS,
  type MetricMode, type MetricPlot, type MetricViewPreference, type MetricWindow,
} from '../src/metrics-view';
import { chartOption, visibleChartTraces, type ChartColors } from '../src/metrics-chart';
import './metrics-dashboard.css';

use([BarChart, LineChart, CustomChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, SVGRenderer]);

const MODES: { id: MetricMode; label: string }[] = [
  { id: 'months', label: 'Месяцы' }, { id: 'year', label: 'Год к году' }, { id: 'current', label: 'Текущий месяц' },
];
const dayLabel = (value: string) => new Date(value.length === 10 ? `${value}T12:00:00Z` : value)
  .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const readLabel = (value: string) => new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function Sparkline({ series }: { series: MetricSeries }) {
  const last = summary(series, 'amount').point;
  const data = useMemo(() => {
    if (!last) return [];
    const byPeriod = new Map(series.points.map(point => [point.period, point]));
    const periods = series.points.map(p => p.period).filter(p => p <= last.period).sort();
    return periods.length ? monthRange(periods[0]!, last.period).slice(-12).map(period => {
      const point = byPeriod.get(period);
      return point?.status === 'in_progress' ? null : point?.value ?? null;
    }) : [];
  }, [series, last?.period]);
  const values = data.filter((value): value is number => value !== null);
  if (!values.length) return <span className="svb-md-spark-empty" />;
  const low = Math.min(...values); const high = Math.max(...values);
  const y = (value: number) => 32 - (value - low) / (high - low || 1) * 26;
  const segments: string[] = [];
  let path = '';
  data.forEach((value, index) => {
    if (value === null) { if (path) segments.push(path); path = ''; return; }
    path += `${path ? ' L' : 'M'}${index / Math.max(1, data.length - 1) * 116 + 2},${y(value)}`;
  });
  if (path) segments.push(path);
  const lastValue = data.at(-1);
  return <svg className="svb-md-spark" viewBox="0 0 120 38" aria-hidden="true">
    <path className="svb-md-spark-rule" d="M2 36 H118" />
    {segments.map((segment, index) => <path key={index} d={segment} />)}
    {lastValue !== null && lastValue !== undefined && <circle cx={data.length === 1 ? 2 : 118} cy={y(lastValue)} r="2.8" />}
  </svg>;
}

function MetricCard({ metric, selected, onSelect, disabled }: { metric: DashboardMetric; selected: boolean; onSelect: () => void; disabled?: boolean }) {
  const series = metric.series.find(item => item.scope === 'total') ?? metric.series[0]!;
  const { point, mom, yoy } = summary(series, metric.kind);
  return <button type="button" disabled={disabled} className={`svb-md-card${selected ? ' is-selected' : ''}`} onClick={onSelect} aria-pressed={selected}>
    <span className="svb-md-card-title">{metric.label}<span aria-hidden="true">↗</span></span>
    <span className="svb-md-card-period">{point ? monthLabel(point.period, true) : 'Нет месячного факта'}{series.scope !== 'total' ? ` · ${series.label}` : ''}</span>
    <span className="svb-md-card-middle"><span className="svb-md-card-number">{formatValue(point?.value ?? null, metric.kind, true)} <small>{metric.unit}</small></span><Sparkline series={series} /></span>
    <span className="svb-md-card-deltas">
      <span><b className={`is-${deltaTone(mom, metric.direction)}`}>{formatDelta(mom)}</b><small>к месяцу</small></span>
      <span><b className={`is-${deltaTone(yoy, metric.direction)}`}>{formatDelta(yoy)}</b><small>год к году</small></span>
    </span>
    {point?.status === 'provisional' && <span className="svb-md-card-status">Предварительно</span>}
  </button>;
}

function chartColors(element: HTMLElement): ChartColors {
  const styles = getComputedStyle(element);
  const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    ink: token('--svb-ink', '#2C3E50'), muted: token('--svb-muted', '#72817f'),
    line: token('--svb-line', '#dfe8e6'), card: token('--svb-card', '#ffffff'), pink: token('--svb-pink', '#FF4D8D'),
    fact: token('--md-fact', '#00B4A6'), past: token('--md-past', '#6B8EAD'),
    colors: [token('--svb-teal', '#008B7F'), token('--md-series-blue', '#4E8CCF'), token('--md-series-gold', '#B18B24'), token('--svb-pink', '#FF4D8D'), token('--md-series-purple', '#9472BB')],
  };
}
function chartVisiblePeriods(chart: ReturnType<typeof init>, periods: string[]) {
  const zoom = (chart.getOption() as { dataZoom?: { start?: number; end?: number; startValue?: number | string; endValue?: number | string }[] }).dataZoom?.[0];
  const index = (value: number | string | undefined, percent: number) => {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
    if (typeof value === 'string' && periods.includes(value)) return periods.indexOf(value);
    return Math.round(percent / 100 * (periods.length - 1));
  };
  const first = Math.max(0, index(zoom?.startValue, zoom?.start ?? 0));
  const last = Math.min(periods.length - 1, index(zoom?.endValue, zoom?.end ?? 100));
  return periods.slice(first, last + 1);
}
function MetricChart({ plot, metric, mode, showGrowth, window: visibleRange, interactionDisabled, onVisiblePeriods }: { plot: MetricPlot; metric: DashboardMetric; mode: MetricMode; showGrowth: boolean; window: MetricWindow | null; interactionDisabled: boolean; onVisiblePeriods: (periods: string[], user: boolean) => void }) {
  const element = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const instance = useRef<ReturnType<typeof init> | null>(null);
  const windowRef = useRef(visibleRange); windowRef.current = visibleRange;
  const reportRef = useRef<(() => void) | null>(null);
  const applying = useRef(false);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    let chart: ReturnType<typeof init> | undefined;
    let frame = 0;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reportRange = (user = false) => {
      if (!chart || chart.isDisposed()) return;
      onVisiblePeriods(chartVisiblePeriods(chart, plot.periods), user && !applying.current);
    };
    const draw = () => {
      if (!chart || chart.isDisposed()) return;
      try {
        applying.current = true;
        chart.setOption(chartOption(plot, metric, mode, chartColors(node), motion.matches, showGrowth, windowRef.current), { notMerge: true });
        chart.resize(); reportRange();
      } catch { setFailed(true); }
      finally { applying.current = false; }
    };
    const zoomed = () => reportRange(true);
    const scheduleDraw = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); };
    const resize = new ResizeObserver(() => { if (chart && !chart.isDisposed()) chart.resize(); });
    const theme = new MutationObserver(scheduleDraw);
    setFailed(false);
    try {
      chart = init(node, undefined, { renderer: 'svg' });
      instance.current = chart; reportRef.current = () => reportRange();
      chart.on('datazoom', zoomed);
      draw(); resize.observe(node);
      // Observe only ancestors: never react to ECharts' own SVG mutations.
      for (let parent: HTMLElement | null = node.parentElement; parent; parent = parent.parentElement) {
        theme.observe(parent, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'] });
      }
      motion.addEventListener('change', scheduleDraw);
    } catch { setFailed(true); }
    return () => {
      cancelAnimationFrame(frame); resize.disconnect(); theme.disconnect(); motion.removeEventListener('change', scheduleDraw); chart?.off('datazoom', zoomed); chart?.dispose(); instance.current = null; reportRef.current = null;
    };
  }, [plot, metric, mode, showGrowth, onVisiblePeriods]);
  useEffect(() => {
    const chart = instance.current;
    if (!chart || chart.isDisposed()) return;
    const periods = metricWindowPeriods(plot.periods, visibleRange);
    if (!periods.length) return;
    applying.current = true;
    try {
      const zoom = (chart.getOption() as { dataZoom?: unknown[] }).dataZoom?.[0];
      if (!zoom && periods.length < plot.periods.length && element.current) {
        // A late preference may add a slider to a short plot. Keep this instance,
        // and never remove an existing slider in the middle of a user's drag.
        const option = chartOption(plot, metric, mode, chartColors(element.current), window.matchMedia('(prefers-reduced-motion: reduce)').matches, showGrowth, visibleRange);
        chart.setOption({ grid: option.grid, dataZoom: option.dataZoom });
      }
      const actual = chartVisiblePeriods(chart, plot.periods);
      // User dataZoom already moved the slider. Echoing it back can replace its
      // drag target; dispatch only for an externally changed calendar window.
      if (actual.length !== periods.length || actual[0] !== periods[0] || actual.at(-1) !== periods.at(-1))
        chart.dispatchAction({ type: 'dataZoom', startValue: periods[0], endValue: periods.at(-1) }, { silent: true });
      reportRef.current?.();
    } catch { setFailed(true); }
    finally { applying.current = false; }
  }, [plot, visibleRange?.from, visibleRange?.to, interactionDisabled]);
  const growth = mode === 'year' && showGrowth;
  const rowCount = new Set(plot.traces.filter(trace => !trace.comparison && !trace.plan).map(trace => trace.seriesId)).size;
  return <div className={`svb-md-chart-wrap${growth ? ' has-growth' : ''}`} tabIndex={growth ? 0 : undefined} aria-label={growth ? 'График с ростом — при узком экране прокручивается горизонтально' : undefined}>
    <div ref={element} inert={interactionDisabled} aria-disabled={interactionDisabled || undefined} className="svb-md-chart" style={growth ? { height: Math.max(325, 230 + rowCount * 18) } : undefined} role="img" aria-label={`${metric.label}. ${MODES.find(item => item.id === mode)?.label}.${growth ? ` Внизу внутри графика — изменение к тому же месяцу прошлого года${metric.kind === 'percent' ? ' в процентных пунктах' : ' в целых процентах'}, строки в порядке легенды.` : ''} Точные значения и источники доступны в режиме «Таблица».`} />
    {failed && <p className="svb-md-chart-error" role="status">График не удалось показать. Числа и источники доступны в таблице.</p>}
  </div>;
}

function MetricTable({ plot, metric, mode }: { plot: MetricPlot; metric: DashboardMetric; mode: MetricMode }) {
  return <div className="svb-md-table-scroll" tabIndex={0} aria-label="Таблица показателя — горизонтальная прокрутка">
    <table className="svb-md-table">
      <caption>{metric.label}, {metric.unit}. Пропуск — нет данных, не ноль. Источник значения раскрывается в ячейке.</caption>
      <thead><tr><th scope="col">{mode === 'current' ? 'Дата' : 'Месяц'}</th>{plot.traces.map(trace => <th key={trace.id} scope="col">{trace.label}</th>)}</tr></thead>
      <tbody>{plot.periods.map((period, index) => <tr key={period}>
        <th scope="row">{mode === 'current' ? dayLabel(period) : mode === 'year' ? axisLabel(period, mode) : monthLabel(period)}</th>
        {plot.traces.map(trace => {
          const point = trace.points[index]!;
          return <td key={trace.id}><details className="svb-md-cell-detail"><summary>
            <span>{formatValue(point.value, metric.kind)}</span>
            <small>{trace.plan ? 'План' : mode === 'current' && point.value !== null ? 'За день' : statusLabel(point.status)}</small>
          </summary><div>{point.period}<br />{point.sourceRef || 'Адрес ячейки не указан для отсутствующего значения.'}</div></details></td>;
        })}
      </tr>)}</tbody>
    </table>
  </div>;
}

export type MetricDiscussion = {
  metricId: string; metricLabel: string; mode: MetricMode; year: string;
  periods: string[]; seriesIds: string[]; showPlan: boolean;
};

export type { MetricViewPreference } from '../src/metrics-view';
/** The host owns persistence and identity; this renderer only reads display choices. */
export type MetricPreferences = { identity?: string; ready?: boolean; read(metricId: string): MetricViewPreference | undefined; write(metricId: string, changes: Partial<MetricViewPreference>): void | Promise<void> };
const equalChoice = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function useMetricView(metric: DashboardMetric, preferences?: MetricPreferences) {
  const saved = preferences?.read(metric.id);
  const savedKey = JSON.stringify(saved);
  const [local, setLocal] = useState(() => reconcileMetricView(metric, saved));
  const current = useRef(local), metricRef = useRef(metric), preferencesRef = useRef(preferences);
  const identity = useRef(preferences?.identity), previousSaved = useRef(saved && structuredClone(saved));
  const dirty = useRef(new Map<keyof MetricViewPreference, unknown>());
  const view = reconcileMetricView(metric, local);
  current.current = view; metricRef.current = metric; preferencesRef.current = preferences;
  useEffect(() => {
    const changedOwner = identity.current !== preferences?.identity;
    if (changedOwner) { identity.current = preferences?.identity; dirty.current.clear(); }
    const previousRecord = previousSaved.current;
    setLocal(previous => {
      const next: Partial<MetricViewPreference> = changedOwner ? {} : { ...previous };
      for (const field of METRIC_VIEW_FIELDS) {
        if (dirty.current.has(field) && equalChoice(saved?.[field], dirty.current.get(field))) dirty.current.delete(field);
        if (saved?.[field] !== undefined && !dirty.current.has(field) && (changedOwner || !equalChoice(saved[field], previousRecord?.[field])))
          Object.assign(next, { [field]: saved[field] });
      }
      const reconciled = reconcileMetricView(metric, next);
      return equalChoice(previous, reconciled) ? previous : reconciled;
    });
    previousSaved.current = saved && structuredClone(saved);
  }, [preferences?.identity, savedKey]);
  useEffect(() => { setLocal(previous => { const next = reconcileMetricView(metric, previous); return equalChoice(previous, next) ? previous : next; }); }, [metric]);
  const choose = useCallback((changes: Partial<MetricViewPreference>) => {
    const next = reconcileMetricView(metricRef.current, { ...current.current, ...changes });
    current.current = next; setLocal(next);
    const host = preferencesRef.current;
    if (host) {
      for (const field of Object.keys(changes) as (keyof MetricViewPreference)[]) dirty.current.set(field, structuredClone(changes[field]));
      void Promise.resolve(host.write(metricRef.current.id, changes)).catch(() => {});
    }
  }, []);
  return { view, choose };
}

function SelectedMetric({ metric, onDiscuss, preferences }: { metric: DashboardMetric; onDiscuss?: (context: MetricDiscussion) => void; preferences?: MetricPreferences }) {
  const preferencesLoading = preferences?.ready === false;
  const { view, choose } = useMetricView(metric, preferences);
  const { mode, table, scope, year, showPlan, showGrowth, seriesIds: selectedUnits } = view;
  const years = availableYears(metric);
  const scoped = metric.series.filter(series => series.scope === scope);
  const selected = scoped.filter(series => scope === 'total' || selectedUnits.includes(series.id));
  const idsKey = selected.map(series => series.id).join(',');
  const plot = useMemo(() => buildMetricPlot(metric, idsKey.split(',').filter(Boolean), mode, year, showPlan), [metric, idsKey, mode, year, showPlan]);
  const [visibleWindow, setVisibleWindow] = useState<{ plot: MetricPlot; periods: string[] } | null>(null);
  const windowRef = useRef(view.window); windowRef.current = view.window;
  const choicesReady = useRef(!preferencesLoading); choicesReady.current = !preferencesLoading;
  const captureWindow = useCallback((periods: string[], user: boolean) => {
    setVisibleWindow(current => current?.plot === plot && equalChoice(current.periods, periods) ? current : { plot, periods });
    if (user && choicesReady.current && periods.length) {
      const window = periods.length === plot.periods.length ? null : metricWindow(plot.periods, { from: periods[0]!, to: periods.at(-1)! });
      if (!equalChoice(windowRef.current, window)) choose({ window });
    }
  }, [plot, choose]);
  const discussionPeriods = table ? plot.periods : visibleWindow?.plot === plot ? visibleWindow.periods : metricWindowPeriods(plot.periods, view.window);
  const hasValues = plot.traces.some(trace => trace.points.some(point => point.value !== null));
  const hasPlan = mode !== 'current' && selected.some(series => series.plan?.some(point => point.value !== null && (mode !== 'year' || point.period.startsWith(year))));
  const hasTotals = metric.series.some(series => series.scope === 'total');
  const hasUnits = metric.series.some(series => series.scope === 'unit');
  const operational = metric.operational;
  const operationalSelected = operational?.series.filter(series => selected.some(item => item.id === series.id)) ?? [];
  const headingId = useId();
  const toggleUnit = (id: string) => choose({ seriesIds: selectedUnits.includes(id)
    ? selectedUnits.length > 1 ? selectedUnits.filter(item => item !== id) : selectedUnits : [...selectedUnits, id] });
  const pointStatuses = new Set(plot.traces.filter(trace => !trace.plan).flatMap(trace => trace.points.filter(point => point.value !== null).map(point => point.status)));
  const single = selected.length === 1;
  const legendTraces = table ? plot.traces : visibleChartTraces(plot, mode);
  const visibleFacts = plot.traces.filter(trace => !trace.plan && !trace.comparison).map(trace => ({
    trace, point: trace.points.filter(point => point.value !== null && discussionPeriods.includes(point.period)).at(-1),
  }));

  return <section className="svb-md-explorer" aria-labelledby={headingId}>
    <header className="svb-md-explorer-head"><div><span className="svb-md-overline">Динамика бизнеса</span><h3 id={headingId}>{metric.label}</h3></div><span className="svb-md-unit">{metric.unit}</span></header>
    <div className="svb-md-mode-row">
      <div className="svb-md-segments" role="group" aria-label="Период представления">{MODES.map(item => <button key={item.id} type="button" disabled={preferencesLoading} aria-pressed={mode === item.id} onClick={() => choose({ mode: item.id, window: null })}>{item.label}</button>)}</div>
      <div className="svb-md-view-switch" role="group" aria-label="Вид представления"><button type="button" disabled={preferencesLoading} aria-pressed={!table} onClick={() => choose({ table: false })}>График</button><button type="button" disabled={preferencesLoading} aria-pressed={table} onClick={() => choose({ table: true })}>Таблица</button></div>
    </div>
    <div className="svb-md-filter-row">
      {hasTotals && hasUnits ? <div className="svb-md-scope" role="group" aria-label="Охват показателя"><button type="button" disabled={preferencesLoading} aria-pressed={scope === 'total'} onClick={() => choose({ scope: 'total' })}>Весь бизнес</button><button type="button" disabled={preferencesLoading} aria-pressed={scope === 'unit'} onClick={() => choose({ scope: 'unit' })}>По точкам</button></div> : <span className="svb-md-scope-label">{scope === 'total' ? scoped[0]?.label || 'Весь бизнес' : 'По точкам'}</span>}
      {mode === 'year' && <label className="svb-md-year">Год <select disabled={preferencesLoading} value={year} onChange={event => choose({ year: event.target.value, window: null })}>{(years.length ? years : [year]).map(value => <option key={value} value={value}>{value}</option>)}</select><span>к {Number(year) - 1}</span></label>}
      {hasPlan && (table || mode !== 'year' || selected.length === 1) && <label className="svb-md-plan"><input type="checkbox" disabled={preferencesLoading} checked={showPlan} onChange={event => choose({ showPlan: event.target.checked })} />План</label>}
      {mode === 'year' && !table && <label className="svb-md-growth" title="Изменение к тому же месяцу прошлого года; неполные периоды не сравниваются"><input type="checkbox" disabled={preferencesLoading} checked={showGrowth} onChange={event => choose({ showGrowth: event.target.checked })} />Рост</label>}
    </div>
    {preferencesLoading && <p role="status" className="svb-md-snapshot-note">Вид можно изменить после загрузки личных настроек.</p>}
    {scope === 'unit' && <div className="svb-md-unit-picks" role="group" aria-label="Точки на графике">{scoped.map((series, index) => <button type="button" key={series.id} disabled={preferencesLoading} aria-pressed={selectedUnits.includes(series.id)} onClick={() => toggleUnit(series.id)}><i className={`svb-md-dot svb-md-color-${index % 5}`} />{series.label}</button>)}</div>}
    {mode !== 'current' && <div className="svb-md-current-values" aria-label="Последние значения в выбранном периоде">{visibleFacts.map(({ trace, point }) => <div key={trace.id}>
      <span>{trace.label} · {point ? monthLabel(point.period, true) : 'Нет данных за выбранный период'}</span>
      <strong>{formatValue(point?.value ?? null, metric.kind, true)} <small>{metric.unit}</small></strong>
      {point && <span>{statusLabel(point.status)}</span>}
    </div>)}</div>}
    {mode === 'current' && operational && <>
      <div className="svb-md-operational-head"><span>{monthLabel(operational.period, true)}</span><span className="svb-md-badge">Неполный месяц · по {dayLabel(operational.through)}</span></div>
      <div className="svb-md-mtd-grid">{operationalSelected.map(series => <div key={series.id}><span>{series.label}</span><strong>{formatValue(series.value, metric.kind)} <small>{metric.unit}</small></strong><span>{metric.kind === 'percent' ? 'Значение на дату среза' : 'С начала месяца по дату среза'}</span><details><summary>Источник значения</summary><p>{series.sourceRef || 'Не указан'}</p></details></div>)}</div>
      <p className="svb-md-operational-note">{operational.note}</p>
    </>}
    {hasValues ? <>
      <div className="svb-md-legend" aria-label="Легенда">{legendTraces.map(trace => {
        const index = scoped.findIndex(series => series.id === trace.seriesId);
        const color = trace.plan ? 'svb-md-color-3' : single ? trace.comparison ? 'svb-md-color-past' : 'svb-md-color-fact' : `svb-md-color-${Math.max(0, index) % 5}`;
        const bar = single && (mode === 'year' || metric.kind !== 'percent') && !trace.comparison && !trace.plan;
        return <span key={trace.id}><i className={`svb-md-legend-line ${color}${trace.plan ? ' is-dashed' : ''}${bar ? ' is-bar' : ''}`} />{trace.label}</span>;
      })}</div>
      {table ? <MetricTable plot={plot} metric={metric} mode={mode} /> : <MetricChart plot={plot} metric={metric} mode={mode} showGrowth={showGrowth} window={view.window} interactionDisabled={preferencesLoading} onVisiblePeriods={captureWindow} />}
      <div className="svb-md-chart-notes">
        {pointStatuses.has('provisional') && <span>Предварительные значения: закрытие месяца не подтверждено.</span>}
        {pointStatuses.has('in_progress') && <span>Неполный период отмечен светлее; с полным месяцем не сравнивается.</span>}
        <span>{mode === 'current' ? 'Каждая точка — отдельный день, не накопленная сумма.' : 'Разрыв ряда — нет данных. Значения не заменяются нулями.'}</span>
        {metric.kind === 'percent' && <span>Изменение долей — в процентных пунктах; доли не суммируются.</span>}
      </div>
    </> : <div className="svb-md-empty" role="status"><span aria-hidden="true">◌</span><strong>{mode === 'current' ? operational ? 'Дневной ряд пока не подключён' : 'Оперативного среза пока нет' : 'Для этого периода нет значений'}</strong><p>{mode === 'current' ? operational ? 'Выше — доступное значение на дату среза. Его нельзя достоверно разложить по дням.' : 'Месячная история остаётся в соседних режимах. Текущий месяц не подменяется нулём или последним полным месяцем.' : 'Выбери другой год или точку. Пропуски в источнике остаются пропусками.'}</p>{table && plot.periods.length > 0 && <MetricTable plot={plot} metric={metric} mode={mode} />}</div>}
    <footer className="svb-md-source"><span>Ваши фильтры не меняют данные коллег.</span>
      {onDiscuss && <button type="button" className="svb-md-refresh" onClick={() => onDiscuss({ metricId: metric.id, metricLabel: metric.label, mode, year, periods: discussionPeriods, seriesIds: selected.map(series => series.id), showPlan })}>Обсудить</button>}
    </footer>
  </section>;
}

export default function MetricsDashboardPanel({ data, onRefresh, refreshUnavailable, embedded = false, onDiscuss, preferences, actions, headingLevel = 2 }: { data: MetricsDashboard; onRefresh?: () => void; refreshUnavailable?: string; embedded?: boolean; onDiscuss?: (context: MetricDiscussion) => void; preferences?: MetricPreferences; actions?: ReactNode; headingLevel?: 1 | 2 }) {
  const savedSelection = preferences?.read(METRIC_SELECTION_KEY)?.selectedMetricId;
  const [selectedId, setSelectedId] = useState(savedSelection ?? data.metrics[0]?.id ?? '');
  const selected = data.metrics.find(metric => metric.id === selectedId) ?? data.metrics[0];
  const selectionPending = useRef<string | null>(null), selectionIdentity = useRef(preferences?.identity);
  useEffect(() => {
    if (selectionIdentity.current !== preferences?.identity) {
      selectionIdentity.current = preferences?.identity; selectionPending.current = null;
      setSelectedId(savedSelection ?? data.metrics[0]?.id ?? '');
    } else if (savedSelection === selectionPending.current) selectionPending.current = null;
    else if (savedSelection && !selectionPending.current) setSelectedId(savedSelection);
  }, [preferences?.identity, savedSelection]);
  useEffect(() => { if (!data.metrics.some(metric => metric.id === selectedId)) setSelectedId(data.metrics[0]?.id ?? ''); }, [data.metrics]);
  const selectMetric = (id: string) => {
    setSelectedId(id); selectionPending.current = preferences ? id : null;
    void Promise.resolve(preferences?.write(METRIC_SELECTION_KEY, { selectedMetricId: id })).catch(() => {});
  };
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const sources = new Set(data.metrics.map(metric => JSON.stringify([metric.source.title, metric.source.url, metric.source.ref]))).size;
  const verified = [...new Set(data.metrics.map(metric => metric.source.verifiedAt))].sort((a, b) => Date.parse(a) - Date.parse(b));
  if (!selected) return null;
  return <section className={`svb-metrics-dashboard${embedded ? ' is-embedded' : ''}`} aria-label={data.title}>
    <header className="svb-md-heading"><div className="svb-md-subject"><Heading>{data.title}</Heading><p className="svb-md-intro">{data.description}</p></div><div className="svb-md-heading-actions">
      {actions}{onRefresh && <button type="button" className="svb-md-primary" onClick={onRefresh} disabled={!!refreshUnavailable} title={refreshUnavailable || 'Партнёр перечитает источники и обновит графики этой вкладки'}>Обновить данные</button>}
      <details className="svb-md-sources-panel"><summary>Источники и покрытие</summary><div className="svb-md-sources-content">
        <p>Снимок подготовлен {readLabel(data.preparedAt)}. Даты проверки источников указаны отдельно.</p>
        {data.metrics.map(metric => <section key={metric.id}><h3>{metric.label}</h3><p>{metric.description}</p>{metric.source.url ? <a href={metric.source.url} target="_blank" rel="noreferrer">Открыть «{metric.source.title}» ↗</a> : <span>{metric.source.title}</span>}<p>Прочитано {readLabel(metric.source.verifiedAt)}</p>
          {metric.source.ref && <p>Источник: <code>{metric.source.ref}</code></p>}{metric.source.modifiedAt && <p>Источник изменён {readLabel(metric.source.modifiedAt)}. Это дата файла, не подтверждение закрытия месяца.</p>}{metric.note && <p>{metric.note}</p>}
        </section>)}
        {data.notes.map((note, index) => <p key={index}>{note}</p>)}
        <p>Месяц сравнивается только с предыдущим календарным месяцем и тем же месяцем прошлого года. При пропуске, неполном периоде или неположительной базе процент роста не показывается.</p>
      </div></details>
    </div></header>
    <p className="svb-md-freshness"><i aria-hidden="true" /><span>{verified.length === 1 ? `Данные проверены ${readLabel(verified[0]!)}` : `Проверка источников: ${readLabel(verified[0]!)} — ${readLabel(verified.at(-1)!)}`}</span><span>Источников: {sources}</span></p>
    <div className="svb-md-metric-tabs" role="group" aria-label="Выбор показателя">{data.metrics.map(metric => <button key={metric.id} type="button" disabled={preferences?.ready === false} aria-pressed={metric.id === selected.id} onClick={() => selectMetric(metric.id)}>{metric.label}</button>)}</div>
    <SelectedMetric key={`${preferences?.identity ?? ""}:${selected.id}`} metric={selected} onDiscuss={onDiscuss} preferences={preferences} />
    <details className="svb-md-cards-overview"><summary>Сводка показателей</summary><div className="svb-md-cards" aria-label="Сводка показателей">{data.metrics.map(metric => <MetricCard key={metric.id} metric={metric} selected={metric.id === selected.id} disabled={preferences?.ready === false} onSelect={() => selectMetric(metric.id)} />)}</div><p className="svb-md-cards-caption">Последний доступный месячный факт без незавершённых периодов. Пропуски остаются пропусками.</p></details>
  </section>;
}
