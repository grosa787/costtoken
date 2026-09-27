import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Activity, ArrowRight, CalendarDays, Check, ChevronDown, CircleAlert,
  Clock3, Database, Info, LayoutDashboard, Pencil, RefreshCw,
  RotateCcw, Search, Settings2, ShieldCheck, X,
} from 'lucide-react';
import { filterBuckets, makeChartPoints, summarize, type ChartPoint } from './analytics';
import { findRate } from './pricing';
import type { ModelRate, Period, ProviderId, ScanReport, SourceStatus, UsageBucket } from './types';

type Page = 'overview' | 'sources' | 'pricing';
type ChartMetric = 'cost' | 'tokens';

const periods: { id: Period; label: string }[] = [
  { id: 'day', label: 'Сегодня' },
  { id: 'week', label: '7 дней' },
  { id: 'month', label: '30 дней' },
  { id: 'sixMonths', label: '6 месяцев' },
  { id: 'year', label: 'Год' },
  { id: 'all', label: 'Вся история' },
];

const providerMeta: Record<ProviderId, { name: string; short: string; color: string }> = {
  claude: { name: 'Claude Code', short: 'C', color: '#dfaa8b' },
  codex: { name: 'Codex', short: '◎', color: '#a8d8c5' },
  gemini: { name: 'Gemini CLI', short: '✦', color: '#9eb9fa' },
  antigravity: { name: 'Antigravity', short: 'A', color: '#bbafe8' },
  grok: { name: 'Grok', short: '𝕏', color: '#e1e5ee' },
  opencode: { name: 'OpenCode', short: 'O', color: '#b4d3a4' },
  localcode: { name: 'LocalCode', short: 'L', color: '#9ed2da' },
  cursor: { name: 'Cursor', short: '⌘', color: '#d8c7a1' },
};

const emptySummary = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
  estimatedCost: 0,
  unpricedModels: [] as string[],
};

function compact(value: number): string {
  return new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function fullNumber(value: number): string {
  return new Intl.NumberFormat('ru-RU').format(value);
}

function money(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
}

function loadOverrides(): ModelRate[] {
  try {
    const raw = JSON.parse(localStorage.getItem('costtoken:rates') || '[]');
    return Array.isArray(raw) ? raw.filter((item) => item && typeof item.model === 'string' && typeof item.provider === 'string') : [];
  } catch {
    return [];
  }
}

function ProviderMark({ id, size = 'normal' }: { id: ProviderId; size?: 'normal' | 'large' }) {
  const meta = providerMeta[id];
  return <span className={`provider-mark ${size}`} style={{ '--provider-color': meta.color } as CSSProperties}>{meta.short}</span>;
}

function StatusBadge({ status }: { status: SourceStatus['status'] }) {
  const labels = { ready: 'Читается', absent: 'Не найден', unsupported: 'Без счетчиков', error: 'Ошибка' };
  return <span className={`status-badge ${status}`}><span className="status-dot" />{labels[status]}</span>;
}

function TrendChart({ points, metric }: { points: ChartPoint[]; metric: ChartMetric }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const width = 840;
  const height = 250;
  const top = 22;
  const bottom = 24;
  const left = 6;
  const right = 6;
  const baseline = height - bottom;
  const values = points.map((point) => metric === 'cost' ? point.estimatedCost : point.totalTokens);
  const maxValue = Math.max(...values, 0);
  const scaleMax = maxValue > 0 ? maxValue * 1.16 : 1;
  const positions = points.map((point, index) => ({
    x: points.length === 1 ? width / 2 : left + index * ((width - left - right) / (points.length - 1)),
    y: baseline - ((metric === 'cost' ? point.estimatedCost : point.totalTokens) / scaleMax) * (baseline - top),
  }));
  const line = positions.map((position, index) => `${index === 0 ? 'M' : 'L'} ${position.x.toFixed(2)} ${position.y.toFixed(2)}`).join(' ');
  const area = positions.length ? `${line} L ${positions.at(-1)!.x} ${baseline} L ${positions[0].x} ${baseline} Z` : '';
  const active = hovered === null ? null : points[hovered];
  const activePosition = hovered === null ? null : positions[hovered];
  const xLabels = points.length <= 7 ? points : points.filter((_, index) => index === 0 || index === points.length - 1 || index % Math.max(1, Math.ceil(points.length / 6)) === 0);

  if (!points.length || (maxValue === 0 && metric === 'cost')) {
    return <div className="chart-empty"><span className="empty-orbit"><Activity size={27} strokeWidth={1.4} /></span><strong>{points.length ? 'Нет оцененной стоимости' : 'Пока нет данных за период'}</strong><p>{points.length ? 'Токены найдены, но для некоторых моделей нужен тариф.' : 'Попробуйте другой период или обновите источники.'}</p></div>;
  }

  return <div className="chart-wrap">
    <div className="chart-value-label">{metric === 'cost' ? money(maxValue) : compact(maxValue)}</div>
    <svg className="trend-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="График использования за выбранный период"
      onMouseMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const x = ((event.clientX - bounds.left) / bounds.width) * width;
        let closest = 0;
        positions.forEach((position, index) => { if (Math.abs(position.x - x) < Math.abs(positions[closest].x - x)) closest = index; });
        setHovered(closest);
      }} onMouseLeave={() => setHovered(null)}>
      <defs>
        <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#9ab8cf" stopOpacity=".14" /><stop offset="100%" stopColor="#9ab8cf" stopOpacity="0" /></linearGradient>
      </defs>
      {[0, 1, 2, 3].map((index) => <line key={index} x1="0" x2={width} y1={top + index * ((baseline - top) / 3)} y2={top + index * ((baseline - top) / 3)} className="chart-grid" />)}
      <path d={area} className="trend-area" fill="url(#chart-fill)" />
      <path d={line} className="trend-line" pathLength={1} fill="none" stroke="#9ab8cf" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {activePosition && <><line x1={activePosition.x} x2={activePosition.x} y1={top} y2={baseline} className="chart-cursor" /><circle cx={activePosition.x} cy={activePosition.y} r="6" fill="#c8ddff" stroke="#406b9f" strokeWidth="3" /></>}
    </svg>
    <div className="chart-axis">{xLabels.map((point) => <span key={point.key}>{point.label}</span>)}</div>
    {active && activePosition && <div className="chart-tooltip" style={{ left: `${Math.max(11, Math.min(82, (activePosition.x / width) * 100))}%` }}><span>{active.label}</span><strong>{metric === 'cost' ? money(active.estimatedCost) : `${fullNumber(active.totalTokens)} токенов`}</strong>{active.unpriced && <small>Есть токены без тарифа</small>}</div>}
  </div>;
}

function RateEditor({ model, provider, current, onSave, onClose, onReset, overridden }: {
  model: string; provider: ProviderId; current?: ModelRate; onSave: (rate: ModelRate) => void; onClose: () => void; onReset: () => void; overridden: boolean;
}) {
  const [input, setInput] = useState(current?.input?.toString() ?? '');
  const [output, setOutput] = useState(current?.output?.toString() ?? '');
  const [cacheRead, setCacheRead] = useState(current?.cacheRead?.toString() ?? '');
  const [cacheWrite, setCacheWrite] = useState(current?.cacheWrite?.toString() ?? '');
  const [cacheWrite1h, setCacheWrite1h] = useState(current?.cacheWrite1h?.toString() ?? '');
  const fields = provider === 'claude' ? [input, output, cacheRead, cacheWrite, cacheWrite1h] : [input, output, cacheRead, cacheWrite];
  const valid = fields.every((value) => value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0) && Number(input) > 0 && Number(output) > 0;
  return <div className="modal-backdrop" onMouseDown={onClose} role="presentation"><div className="rate-modal" role="dialog" aria-modal="true" aria-labelledby="rate-title" onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-top"><div><span className="modal-kicker">Тариф за 1 млн токенов</span><h2 id="rate-title">{model}</h2><p>{providerMeta[provider].name} · USD</p></div><button className="icon-button" onClick={onClose} aria-label="Закрыть"><X size={19} /></button></div>
    <div className="rate-fields"><label>Входные<input type="number" min="0" step="any" value={input} onChange={(event) => setInput(event.target.value)} /></label><label>Выходные<input type="number" min="0" step="any" value={output} onChange={(event) => setOutput(event.target.value)} /></label><label>Чтение кэша<input type="number" min="0" step="any" value={cacheRead} onChange={(event) => setCacheRead(event.target.value)} /></label><label>Запись кэша<input type="number" min="0" step="any" value={cacheWrite} onChange={(event) => setCacheWrite(event.target.value)} /></label>{provider === 'claude' && <label>Запись кэша на 1 час<input type="number" min="0" step="any" value={cacheWrite1h} onChange={(event) => setCacheWrite1h(event.target.value)} /></label>}</div>
    <p className="modal-note"><Info size={15} />Сохранение изменит только локальную оценку. Фактический счет провайдера может отличаться.</p>
    <div className="modal-actions">{overridden && <button className="text-button" onClick={onReset}><RotateCcw size={15} />Вернуть тариф</button>}<button className="primary-button" disabled={!valid} onClick={() => onSave({ model, provider, input: Number(input), output: Number(output), cacheRead: Number(cacheRead), cacheWrite: Number(cacheWrite), ...(cacheWrite1h.trim() ? { cacheWrite1h: Number(cacheWrite1h) } : {}) })}><Check size={17} />Сохранить</button></div>
  </div></div>;
}

export default function App() {
  const [page, setPage] = useState<Page>('overview');
  const [report, setReport] = useState<ScanReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('month');
  const [provider, setProvider] = useState<ProviderId | 'all'>('all');
  const [metric, setMetric] = useState<ChartMetric>('cost');
  const [overrides, setOverrides] = useState<ModelRate[]>(loadOverrides);
  const [editing, setEditing] = useState<{ model: string; provider: ProviderId } | null>(null);
  const [search, setSearch] = useState('');
  const scanInFlight = useRef(false);

  const refresh = useCallback(async (first = false) => {
    if (scanInFlight.current) return;
    scanInFlight.current = true;
    if (first) setLoading(true); else setRefreshing(true);
    try {
      const next = await invoke<ScanReport>('scan_usage');
      setReport(next);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
      setRefreshing(false);
      scanInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const scoped = useMemo(() => filterBuckets(report?.buckets ?? [], period, provider, new Date()), [report, period, provider]);
  const summary = useMemo(() => report ? summarize(scoped, overrides) : emptySummary, [report, scoped, overrides]);
  const points = useMemo(() => makeChartPoints(scoped, period, overrides), [scoped, period, overrides]);
  const tokenOnly = summary.unpricedModels.length > 0 && summary.estimatedCost === 0 && summary.totalTokens > 0;
  const sources = report?.sources ?? [];
  const activeSources = sources.filter((source) => source.status === 'ready').length;
  const cacheShare = summary.totalTokens ? (summary.cacheReadTokens / (summary.inputTokens + summary.cacheReadTokens + summary.cacheWriteTokens)) * 100 : 0;
  const providerRows = useMemo(() => {
    const ids = [...new Set(scoped.map((bucket) => bucket.provider))];
    return ids.map((id) => {
      const buckets = scoped.filter((bucket) => bucket.provider === id);
      return { id, ...summarize(buckets, overrides) };
    }).sort((a, b) => b.estimatedCost - a.estimatedCost || b.totalTokens - a.totalTokens);
  }, [scoped, overrides]);
  const modelRows = useMemo(() => {
    const byModel = new Map<string, UsageBucket[]>();
    for (const bucket of report?.buckets ?? []) {
      const key = `${bucket.provider}::${bucket.model}`;
      const modelBuckets = byModel.get(key);
      if (modelBuckets) modelBuckets.push(bucket);
      else byModel.set(key, [bucket]);
    }
    return [...byModel.entries()].map(([key, buckets]) => {
      const split = key.indexOf('::');
      return { provider: key.slice(0, split) as ProviderId, model: key.slice(split + 2), ...summarize(buckets, overrides) };
    }).filter((item) => `${item.model} ${providerMeta[item.provider]?.name ?? ''}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.totalTokens - a.totalTokens);
  }, [report, overrides, search]);

  const saveRate = (rate: ModelRate) => {
    const next = [...overrides.filter((item) => !(item.model === rate.model && item.provider === rate.provider)), rate];
    setOverrides(next);
    localStorage.setItem('costtoken:rates', JSON.stringify(next));
    setEditing(null);
  };
  const resetRate = () => {
    if (!editing) return;
    const next = overrides.filter((item) => !(item.model === editing.model && item.provider === editing.provider));
    setOverrides(next);
    localStorage.setItem('costtoken:rates', JSON.stringify(next));
    setEditing(null);
  };

  useEffect(() => {
    if (tokenOnly) setMetric('tokens');
  }, [tokenOnly]);

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="window-drag" data-tauri-drag-region />
      <div className="brand"><div className="brand-symbol"><span /></div><div><strong>CostToken</strong><small>Локальная аналитика</small></div></div>
      <nav className="side-nav" aria-label="Разделы">
        <button className={page === 'overview' ? 'active' : ''} onClick={() => setPage('overview')}><LayoutDashboard size={18} />Обзор</button>
        <button className={page === 'sources' ? 'active' : ''} onClick={() => setPage('sources')}><Database size={18} />Источники<span className="nav-count">{activeSources}</span></button>
        <button className={page === 'pricing' ? 'active' : ''} onClick={() => setPage('pricing')}><Settings2 size={18} />Тарифы</button>
      </nav>
      <div className="sidebar-bottom"><ShieldCheck size={15} /><span>Данные остаются на Mac</span></div>
    </aside>

    <main className="main-pane">
      <header className="topbar" data-tauri-drag-region><div className="topbar-context">CostToken <span className="context-separator">/</span> {page === 'overview' ? 'Обзор' : page === 'sources' ? 'Источники' : 'Тарифы'}</div><div className="topbar-actions"><span className="update-label"><span className="live-dot" />{report ? `Обновлено ${new Date(report.scannedAt * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : 'Чтение журналов'}</span><button className={`icon-button refresh-button ${refreshing ? 'spinning' : ''}`} aria-label="Обновить данные" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={17} /></button></div></header>

      {error && <div className="error-banner"><CircleAlert size={17} /><span>Не удалось обновить данные: {error}</span><button onClick={() => void refresh()}>Повторить</button></div>}

      {page === 'overview' && <div className="content overview-page">
        <div className="page-heading overview-heading">
          <div>
            <h1>Расход токенов</h1>
            <p>Локальная история использования AI-агентов на этом Mac.</p>
          </div>
          <div className="toolbar-controls">
            <label className="provider-select">
              <span>Агент</span>
              <select aria-label="Агент" value={provider} onChange={(event) => setProvider(event.target.value as ProviderId | 'all')}>
                <option value="all">Все агенты</option>
                {sources.filter((source) => source.status === 'ready').map((source) => <option key={source.id} value={source.id}>{providerMeta[source.id].name}</option>)}
              </select>
              <ChevronDown size={14} />
            </label>
            <div className="period-control" role="group" aria-label="Период">
              {periods.map((option) => <button key={option.id} className={period === option.id ? 'selected' : ''} onClick={() => setPeriod(option.id)}>{option.label}</button>)}
            </div>
          </div>
        </div>

        <section className="overview-lead">
          <div className="lead-amount">
            <div className="lead-label">{tokenOnly ? 'Использовано токенов' : 'Оценка по API-тарифам'}{!tokenOnly && <Info size={14} />}</div>
            <strong>{loading ? '—' : tokenOnly ? compact(summary.totalTokens) : money(summary.estimatedCost)}</strong>
            <p>{tokenOnly ? 'Стоимость для этих моделей неизвестна. Расход показан в токенах.' : 'Эквивалентная стоимость по доступным журналам. Фактический счет по подписке может отличаться.'}</p>
          </div>
          <div className="lead-facts">
            <div><span>Всего токенов</span><strong>{loading ? '—' : compact(summary.totalTokens)}</strong></div>
            <div><span>Чтение кэша</span><strong>{loading ? '—' : compact(summary.cacheReadTokens)}</strong></div>
            <div><span>Доля кэша во входе</span><strong>{loading ? '—' : `${Math.round(cacheShare || 0)}%`}</strong></div>
          </div>
        </section>

        <section className="flow-strip" aria-label="Разбивка токенов">
          <div><span>Входные</span><strong>{loading ? '—' : fullNumber(summary.inputTokens)}</strong><small>без кэша</small></div>
          <div><span>Выходные</span><strong>{loading ? '—' : fullNumber(summary.outputTokens)}</strong><small>включая reasoning</small></div>
          <div><span>Кэш прочитан</span><strong>{loading ? '—' : fullNumber(summary.cacheReadTokens)}</strong><small>повторный контекст</small></div>
          <div><span>Кэш записан</span><strong>{loading ? '—' : fullNumber(summary.cacheWriteTokens)}</strong><small>новый контекст</small></div>
        </section>

        <section className="chart-panel"><div className="panel-heading"><div><h2>Динамика</h2><p>Как менялось использование во времени</p></div><div className="metric-switch" role="group" aria-label="Показатель графика"><button className={metric === 'cost' ? 'selected' : ''} onClick={() => setMetric('cost')}>Стоимость</button><button className={metric === 'tokens' ? 'selected' : ''} onClick={() => setMetric('tokens')}>Токены</button></div></div>{loading ? <div className="chart-loading"><span /></div> : <TrendChart points={points} metric={metric} />}</section>

        <div className="lower-grid"><section className="agents-panel"><div className="panel-heading"><div><h2>Агенты</h2><p>Вклад в выбранный период</p></div><button className="subtle-link" onClick={() => setPage('sources')}>Все источники <ArrowRight size={15} /></button></div>{loading ? <div className="list-placeholder">Сканирование локальных журналов…</div> : providerRows.length ? <div className="agent-list">{providerRows.map((row) => <button key={row.id} className="agent-row" onClick={() => setProvider(row.id)}><ProviderMark id={row.id} /><span className="agent-main"><strong>{providerMeta[row.id].name}</strong><small>{compact(row.totalTokens)} токенов</small></span><span className="agent-amount">{row.unpricedModels.length > 0 && row.estimatedCost === 0 ? `${compact(row.totalTokens)} ток.` : money(row.estimatedCost)}<ChevronDown size={15} /></span></button>)}</div> : <div className="list-placeholder">У этого периода нет записей.</div>}</section><section className="cache-panel"><div className="panel-heading"><div><h2>Работа кэша</h2><p>Сколько контекста использовано повторно</p></div><span className="cache-icon"><Database size={19} /></span></div><div className="cache-stat"><strong>{Math.round(cacheShare || 0)}%</strong><span>входного потока пришло из кэша</span></div><div className="cache-meter"><span style={{ width: `${Math.min(100, Math.max(0, cacheShare || 0))}%` }} /></div><div className="cache-details"><div><span>Прочитано</span><strong>{compact(summary.cacheReadTokens)}</strong></div><div><span>Записано</span><strong>{compact(summary.cacheWriteTokens)}</strong></div></div></section></div>
      </div>}

      {page === 'sources' && <div className="content inner-page">
        <div className="page-heading simple">
          <div><h1>Источники</h1><p>Счетчики из локальных файлов и баз данных установленных агентов.</p></div>
          <button className="outline-button" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={16} />Обновить</button>
        </div>
        <div className="source-note"><ShieldCheck size={17} />Только чтение. Запросы, ответы и ключи доступа не попадают в отчет.</div>
        <div className="source-list">
          <div className="source-list-head"><span>Агент</span><span>Состояние</span><span>Записей</span><span>Файлов</span></div>
          {sources.map((source) => <div key={source.id} className="source-list-row">
            <div className="source-identity"><ProviderMark id={source.id} /><div><strong>{providerMeta[source.id].name}</strong>{source.status !== 'ready' && <small>{source.detail}</small>}</div></div>
            <StatusBadge status={source.status} />
            <span className="source-number">{fullNumber(source.eventCount)}</span>
            <span className="source-number">{fullNumber(source.fileCount)}</span>
          </div>)}
          {loading && <div className="list-placeholder">Проверяю папки агентов…</div>}
        </div>
      </div>}

      {page === 'pricing' && <div className="content inner-page"><div className="page-heading simple"><div><h1>Тарифы моделей</h1><p>Оценка по публичным API-ценам. Вы можете уточнить любую ставку.</p></div><span className="price-date"><CalendarDays size={16} />Цены проверены 27.09.2026</span></div><div className="pricing-context"><Info size={16} /><span>Стоимость по API-тарифам служит ориентиром. Подписки и фактический счет провайдера могут отличаться.</span></div><div className="pricing-table-panel"><div className="pricing-toolbar"><h2>Обнаруженные модели <span>{modelRows.length}</span></h2><label className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти модель" /></label></div><div className="pricing-table-wrap"><table className="pricing-table"><thead><tr><th>Модель</th><th>Вход</th><th>Выход</th><th>Кэш чтение</th><th>Кэш запись</th><th>Токенов</th><th>Оценка</th><th /></tr></thead><tbody>{modelRows.map((row) => { const rate = findRate(row.provider, row.model, overrides); const overridden = overrides.some((item) => item.provider === row.provider && item.model === row.model); return <tr key={`${row.provider}:${row.model}`}><td><span className="model-name"><ProviderMark id={row.provider} /><span><strong>{row.model}</strong><small>{providerMeta[row.provider].name}{overridden ? ' · свой тариф' : ''}</small></span></span></td><td>{rate ? `$${rate.input}` : '—'}</td><td>{rate ? `$${rate.output}` : '—'}</td><td>{rate ? `$${rate.cacheRead}` : '—'}</td><td>{rate ? `$${rate.cacheWrite}` : '—'}</td><td>{fullNumber(row.totalTokens)}</td><td>{rate ? money(row.estimatedCost) : '—'}</td><td><button className="edit-rate" aria-label={`Изменить тариф ${row.model}`} onClick={() => setEditing({ model: row.model, provider: row.provider })}><Pencil size={16} /></button></td></tr>; })}</tbody></table>{!modelRows.length && <div className="list-placeholder">{search ? 'Модели не найдены.' : 'Модели появятся после сканирования.'}</div>}</div></div><p className="pricing-footnote"><Clock3 size={15} />Расчет не учитывает доплаты за длинный контекст, быстрый режим, инструменты, хранение кэша и изменение цены в прошлом.</p></div>}
    </main>
    {editing && <RateEditor key={`${editing.provider}:${editing.model}`} model={editing.model} provider={editing.provider} current={findRate(editing.provider, editing.model, overrides)} overridden={overrides.some((item) => item.provider === editing.provider && item.model === editing.model)} onSave={saveRate} onReset={resetRate} onClose={() => setEditing(null)} />}
  </div>;
}
