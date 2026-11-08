/**
 * Chart DSL v1 — SVG renderer (Phase 3b, design Q3 "Rich content").
 *
 * Our own SVG renderer instead of a chart library: deterministic output
 * (no randomness, no canvas → clean printing to PDF), theming exclusively
 * through CSS variables (`var(--chart-N)`, `--chart-grid/-axis/-label`) — the chart
 * repaints itself with the theme without a re-render, and a small attack surface.
 *
 * DSL → SVG rules:
 *  - series `i` gets `var(--chart-(i mod 8))` — the DSL carries no colors,
 *  - bar columns (audit 7.5 P1-3): one `<linearGradient>` per series with
 *    `stop-color:var(--chart-N)` (top) → `var(--chart-N-end)` (bottom),
 *    so the gradient repaints with the theme without a re-render; `rx`/`ry`
 *    come from CSS via `--chart-bar-radius` (plus an `rx` attribute for Safari) and
 *    `filter: var(--chart-bar-glow)` is CSS too; the bar width is
 *    capped (~56 in viewBox units),
 *  - grid dashed (P2-7), legend only with several series (P2-8),
 *    chart text in a single font, mono only for numeric ticks (P2-6),
 *  - `null` in the data = a gap (the line breaks, the bar/point is skipped),
 *  - axes + ticks, legend, error bars (`err`), an optional title,
 *  - `viewBox` + `width=100%` → responsive, keeps the aspect ratio,
 *  - tooltip = `<title>` in every point/column (pure SVG, no JS).
 *
 * `renderChart` is a pure function `ChartDsl → React SVG` — it is called only with
 * the output of `validateChartDsl` (shared), so the shapes are guaranteed. Tests
 * check the number of series, the axis labels and `var(--chart-N)` directly on the DOM.
 */
import type { JSX } from 'react';

import type { ChartDsl, ChartPoint, ChartSeries } from '@forum4ai/shared';

/** pevný raster viewBoxu — škáluje sa CSS (.chart-block svg { max-width: 100% }) */
const W = 720;
const H = 400;
const PAD = { top: 30, right: 20, bottom: 54, left: 64 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

const AXIS = 'var(--chart-axis)';
const GRID = 'var(--chart-grid)';
const LABEL = 'var(--chart-label)';

/** séria `i` → jej farebný token (0..7 kanonický index, 8 sérií sa točí) */
export function seriesColor(index: number): string {
  return `var(--chart-${String(index % 8)})`;
}

/** audit 7.5 P1-3: spodok gradientu tyče — token `--chart-N-end` tej istej
    série (hodnoty drží tokens.css pre každú tému, téma prepína live) */
export function seriesEndColor(index: number): string {
  return `var(--chart-${String(index % 8)}-end)`;
}

/**
 * Krátky stabilný hash DSL pre id gradientu. Dve rovnaké DSL na stránke
 * zdieľajú id — neškodné, ich gradienty sú stotožné (rovnaké `url(#…)`
 * namierí na prvý výskyt, ten má rovnaké stop-farby).
 */
function hashDsl(dsl: ChartDsl): string {
  let hash = 5381;
  const text = JSON.stringify(dsl);
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/** strop šírky tyče (viewBox jednotky) — 3 kategórie robili ~105 px dosky */
const BAR_MAX_W = 56;

/** normalizovaný bod: x v jednotkách osi (epoch ms pre `time`), y s medzerou */
interface Point {
  x: number;
  y: number | null;
  err: number | null;
  sx: number;
  sy: number;
}

/** epoch seconds vs milliseconds — heuristika okolo 1e11 (rok ~3365 v s) */
function toTimeMs(value: number | string): number {
  if (typeof value === 'number') return Math.abs(value) < 1e11 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/** surové dáta série → body (index = x pre plochý tvar / kategórie) */
function rawPoints(series: ChartSeries): { x: number; y: number | null; err: number | null }[] {
  return series.data.map((point: ChartPoint, i: number) => {
    const err = series.err?.[i] ?? null;
    if (point === null) return { x: i, y: null, err };
    if (typeof point === 'number') return { x: i, y: point, err };
    const [x, y] = point;
    return { x: typeof x === 'number' ? x : toTimeMs(x), y: y, err };
  });
}

/** "pekné" tiky lineárnej osi: krok 1/2/2.5/5 × 10^n (deterministické) */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    const base = Number.isFinite(min) ? min : 0;
    return [base - 1, base, base + 1];
  }
  const rawStep = (max - min) / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  let step = magnitude * 10;
  for (const c of [1, 2, 2.5, 5, 10]) {
    if (magnitude * c >= rawStep) {
      step = magnitude * c;
      break;
    }
  }
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-9 && ticks.length < 24; v += step) {
    ticks.push(Number(v.toPrecision(12)));
  }
  return ticks.length >= 2 ? ticks : [min, max];
}

/** tiky log osi: celé mocniny 10 v rozsahu */
function logTicks(min: number, max: number): number[] {
  const lo = Math.floor(Math.log10(Math.max(min, Number.MIN_VALUE)));
  const hi = Math.ceil(Math.log10(Math.max(max, 1)));
  const ticks: number[] = [];
  for (let e = lo; e <= hi && ticks.length < 12; e += 1) ticks.push(10 ** e);
  return ticks.length >= 2 ? ticks : [min, max];
}

/** krátky popisek tiku (bez 0.30000000000000004) */
export function formatTick(value: number, scale: 'linear' | 'log' | 'time'): string {
  if (scale === 'time') {
    const d = new Date(toTimeMs(value));
    return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
  }
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e6 || abs < 1e-3) return value.toExponential(1);
  const decimals = abs >= 100 ? 0 : abs >= 1 ? 1 : 2;
  return value.toFixed(decimals).replace(/\.0$/, '');
}

interface YScale {
  to: (v: number) => number;
  ticks: number[];
  min: number;
  max: number;
}

function makeYScale(dsl: ChartDsl, values: number[]): YScale {
  const scale = dsl.y?.scale ?? 'linear';
  const finite = values.filter((v) => Number.isFinite(v));
  let min = dsl.y?.min ?? (finite.length > 0 ? Math.min(...finite) : 0);
  let max = dsl.y?.max ?? (finite.length > 0 ? Math.max(...finite) : 1);
  if (scale !== 'log' && dsl.y?.min === undefined) min = Math.min(min, 0);
  if (min >= max) max = min + 1;
  if (scale === 'log') {
    if (min <= 0) min = finite.filter((v) => v > 0).sort((a, b) => a - b)[0] ?? 1;
    if (max <= min) max = min * 10;
    const lo = Math.log10(min);
    const hi = Math.log10(max);
    return {
      min,
      max,
      to: (v) => PAD.top + PLOT_H - ((Math.log10(Math.max(v, min)) - lo) / (hi - lo)) * PLOT_H,
      ticks: logTicks(min, max),
    };
  }
  return {
    min,
    max,
    to: (v) => PAD.top + PLOT_H - ((Math.max(Math.min(v, max), min) - min) / (max - min)) * PLOT_H,
    ticks: niceTicks(min, max),
  };
}

type XScale = {
  to: (valueOrIndex: number) => number;
  ticks: { pos: number; label: string }[];
  band: number;
  isBand: boolean;
};

function makeXScale(dsl: ChartDsl, raw: { x: number; y: number | null; err: number | null }[][], isStacked: boolean): XScale {
  const categories = dsl.x?.categories ?? [];
  if (categories.length > 0) {
    const band = PLOT_W / categories.length;
    const stride = Math.max(1, Math.ceil(categories.length / 12));
    return {
      band,
      isBand: true,
      to: (i) => PAD.left + band * i + band / 2,
      ticks: categories.map((label, i) => ({ pos: PAD.left + band * i + band / 2, label })).filter((_, i) => i % stride === 0),
    };
  }
  const scale = dsl.x?.scale ?? 'linear';
  const xs = raw.flat().map((p) => p.x).filter((v) => Number.isFinite(v));
  let min = xs.length > 0 ? Math.min(...xs) : 0;
  let max = xs.length > 0 ? Math.max(...xs) : 1;
  if (min >= max) {
    min -= 0.5;
    max += 0.5;
  }
  if (scale === 'log') {
    if (min <= 0) min = 1;
    if (max <= min) max = min * 10;
    const lo = Math.log10(min);
    const hi = Math.log10(max);
    return {
      band: isStacked ? PLOT_W / Math.max(xs.length, 1) : 0,
      isBand: false,
      to: (v) => PAD.left + ((Math.log10(Math.max(v, min)) - lo) / (hi - lo)) * PLOT_W,
      ticks: logTicks(min, max).map((v) => ({ pos: PAD.left + ((Math.log10(Math.max(v, min)) - lo) / (hi - lo)) * PLOT_W, label: formatTick(v, scale) })),
    };
  }
  const span = max - min;
  return {
    band: isStacked ? PLOT_W / Math.max(xs.length, 1) : 0,
    isBand: false,
    to: (v) => PAD.left + ((Math.max(Math.min(v, max), min) - min) / span) * PLOT_W,
    ticks: niceTicks(min, max, 6).map((v) => ({ pos: PAD.left + ((Math.max(Math.min(v, max), min) - min) / span) * PLOT_W, label: formatTick(v, scale) })),
  };
}

/** spojité úseky čiary (pri `null` sa preruší) — pole pozícií segmentov */
function segmentsOf(points: Point[]): Point[][] {
  const segments: Point[][] = [];
  let current: Point[] = [];
  for (const p of points) {
    if (p.y === null) {
      if (current.length >= 2) segments.push(current);
      current = [];
      continue;
    }
    current.push(p);
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}

function pathOf(segment: Point[], close: number | null): string {
  const parts = segment.map((p, i) => `${String(i === 0 ? 'M' : 'L')}${p.sx.toFixed(2)} ${p.sy.toFixed(2)}`);
  if (close === null || segment.length === 0) return parts.join(' ');
  const first = segment[0] as Point;
  const last = segment[segment.length - 1] as Point;
  return `${parts.join(' ')} L${last.sx.toFixed(2)} ${close.toFixed(2)} L${first.sx.toFixed(2)} ${close.toFixed(2)} Z`;
}

/** dolná hranica y pre nulu baseline (0 ak rozsah siaha pod nulu) */
function baselineOf(ys: YScale): number {
  if (ys.min > 0) return ys.to(ys.min);
  return ys.to(Math.min(0, ys.max));
}

/**
 * Vykresli validovaný Chart DSL do SVG. `dsl` MUSÍ prísť z
 * `validateChartDsl` — tvary sú garantované, render nič nevaliduje.
 */
export function renderChart(dsl: ChartDsl): JSX.Element {
  const isStacked = dsl.type === 'stacked-bar';
  const isBar = dsl.type === 'bar' || isStacked;
  const uid = hashDsl(dsl);
  const gradientId = (i: number): string => `f4ai-cg-${uid}-${String(i)}`;
  const rawPerSeries = dsl.series.map((s) => rawPoints(s));
  const allY = rawPerSeries.flat().flatMap((p) => (p.y === null ? [] : [p.y]));

  // stack: kumulatívne spodky/spršky po indexoch (null = 0 v stacku)
  const stackBottom: number[] = [];
  const stackTop: number[] = [];
  if (isStacked) {
    const length = Math.max(...rawPerSeries.map((p) => p.length), 0);
    for (let i = 0; i < length; i += 1) {
      let acc = 0;
      for (const series of rawPerSeries) {
        stackBottom.push(acc);
        const v = series[i]?.y ?? 0;
        acc += Number.isFinite(v) ? v : 0;
        stackTop.push(acc);
      }
    }
  }
  const ys = makeYScale(dsl, isStacked ? [...stackTop, ...stackBottom, ...allY] : allY);
  const xs = makeXScale(dsl, rawPerSeries, isStacked);

  const positioned: Point[][] = rawPerSeries.map((series) =>
    series.map((p, i) => ({
      ...p,
      sx: xs.isBand || dsl.x?.categories !== undefined ? xs.to(i) : xs.to(p.x),
      sy: p.y === null ? baselineOf(ys) : ys.to(p.y),
    })),
  );

  const baseline = baselineOf(ys);
  const marks: JSX.Element[] = [];

  positioned.forEach((series, si) => {
    const color = seriesColor(si);
    const name = dsl.series[si]?.name ?? '';
    const group = xs.isBand ? xs.band : (xs.band > 0 ? xs.band : PLOT_W / Math.max(series.length, 1));

    if (isBar) {
      // P1-3: gradient `url(#…)` namiesto flat fill; `rx` atribút držíme
      // pre Safari (geometrické CSS nepodporuje), sklon+glon rieši
      // `.chart-block rect[data-bar]` v components.css z tokenov
      const barFill = `url(#${gradientId(si)})`;
      const barW = Math.min(
        BAR_MAX_W,
        isStacked ? Math.max(2, group * 0.72) : Math.max(2, (group * 0.72) / positioned.length),
      );
      const offset = isStacked ? 0 : (si - (positioned.length - 1) / 2) * barW;
      series.forEach((p, i) => {
        if (p.y === null) return;
        const top = isStacked ? ys.to(stackTop[si * series.length + i] ?? 0) : p.sy;
        const bottom = isStacked ? ys.to(stackBottom[si * series.length + i] ?? 0) : baseline;
        marks.push(
          <rect
            key={`bar-${String(si)}-${String(i)}`}
            data-bar="1"
            x={p.sx + offset - barW / 2}
            y={Math.min(top, bottom)}
            width={barW}
            height={Math.max(0.5, Math.abs(bottom - top))}
            fill={barFill}
            fillOpacity={0.85}
            rx={6}
            ry={6}
          >
            <title>{`${name}: ${String(p.y)}`}</title>
          </rect>,
        );
      });
      return;
    }

    if (dsl.type === 'area') {
      for (const [k, seg] of segmentsOf(series).entries()) {
        marks.push(<path key={`area-${String(si)}-${String(k)}`} d={pathOf(seg, baseline)} fill={color} fillOpacity={0.18} stroke="none" />);
      }
    }
    for (const [k, seg] of segmentsOf(series).entries()) {
      marks.push(<path key={`line-${String(si)}-${String(k)}`} d={pathOf(seg, null)} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />);
    }
    series.forEach((p, i) => {
      if (p.y === null) return;
      if (dsl.type === 'scatter') {
        marks.push(
          <circle key={`dot-${String(si)}-${String(i)}`} cx={p.sx} cy={p.sy} r={3.5} fill={color} fillOpacity={0.9}>
            <title>{`${name}: ${String(p.y)}`}</title>
          </circle>,
        );
        if (p.err !== null) {
          marks.push(errorBar(name, p, ys, color, i, si));
        }
        return;
      }
      marks.push(
        <circle key={`dot-${String(si)}-${String(i)}`} cx={p.sx} cy={p.sy} r={2.6} fill={color}>
          <title>{`${name}: ${String(p.y)}`}</title>
        </circle>,
      );
      if (p.err !== null) {
        marks.push(errorBar(name, p, ys, color, i, si));
      }
    });
  });

  const yScaleLabel = dsl.y?.unit !== undefined && dsl.y.label !== undefined
    ? `${dsl.y.label} [${dsl.y.unit}]`
    : (dsl.y?.label ?? dsl.y?.unit);

  // P2-6: text grafu jedným fontom (body), monospace len číselné/datové
  // tiky — kategórie sú slová, tie idú body fontom ako zvyšok textu
  const hasCategories = (dsl.x?.categories?.length ?? 0) > 0;
  const xTickFont = hasCategories ? 'var(--font-body)' : 'var(--font-mono)';

  return (
    <svg
      viewBox={`0 0 ${String(W)} ${String(H)}`}
      width="100%"
      role="img"
      aria-label={dsl.title ?? 'chart'}
      data-testid="chart-svg"
      data-chart-type={dsl.type}
      data-series={String(dsl.series.length)}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block' }}
    >
      {isBar && (
        // P1-3: jeden gradient na sériu — `style` istuje var() rezolúciu
        // (Safari), `stopColor` atribút drží čitateľnú hodnotu pre testy
        // a fallback; gradient je zvislý (vrch série → spodok --end)
        <defs>
          {dsl.series.map((_, i) => (
            <linearGradient key={`grad-${String(i)}`} id={gradientId(i)} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={seriesColor(i)} style={{ stopColor: seriesColor(i) }} />
              <stop offset="100%" stopColor={seriesEndColor(i)} style={{ stopColor: seriesEndColor(i) }} />
            </linearGradient>
          ))}
        </defs>
      )}
      {dsl.title !== undefined && (
        <text x={PAD.left} y={18} fill={LABEL} fontSize={13} fontFamily="var(--font-body)">
          {dsl.title}
        </text>
      )}
      {ys.ticks.map((t, i) => (
        <g key={`grid-${String(i)}`}>
          {/* P2-7: mriežka čiarkovane, aby nekonkerovala osiam a dátam */}
          <line x1={PAD.left} y1={ys.to(t)} x2={PAD.left + PLOT_W} y2={ys.to(t)} stroke={GRID} strokeWidth={1} strokeDasharray="3 4" />
          <text x={PAD.left - 10} y={ys.to(t) + 4} textAnchor="end" fill={LABEL} fontSize={11} fontFamily="var(--font-mono)">
            {formatTick(t, dsl.y?.scale ?? 'linear')}
          </text>
        </g>
      ))}
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + PLOT_H} stroke={AXIS} strokeWidth={1.2} />
      <line x1={PAD.left} y1={PAD.top + PLOT_H} x2={PAD.left + PLOT_W} y2={PAD.top + PLOT_H} stroke={AXIS} strokeWidth={1.2} />
      {xs.ticks.map((t, i) => (
        <g key={`xt-${String(i)}`}>
          <line x1={t.pos} y1={PAD.top + PLOT_H} x2={t.pos} y2={PAD.top + PLOT_H + 5} stroke={AXIS} />
          <text x={t.pos} y={PAD.top + PLOT_H + 20} textAnchor="middle" fill={LABEL} fontSize={11} fontFamily={xTickFont}>
            {t.label}
          </text>
        </g>
      ))}
      {marks}
      {/* P2-8: legenda pri jednej sérii nič nehovorí — mizne */}
      {dsl.series.length > 1 &&
        dsl.series.map((s, i) => {
          const label = s.name.length > 18 ? `${s.name.slice(0, 17)}…` : s.name;
          const x = PAD.left + i * 150;
          return (
            <g key={`legend-${String(i)}`}>
              <rect x={x} y={H - 16} width={10} height={10} rx={2} fill={seriesColor(i)} />
              <text x={x + 15} y={H - 7} fill={LABEL} fontSize={11} fontFamily="var(--font-body)">
                {label}
              </text>
            </g>
          );
        })}
      {dsl.x?.label !== undefined && dsl.x.label !== '' && (
        <text x={PAD.left + PLOT_W / 2} y={PAD.top + PLOT_H + 40} textAnchor="middle" fill={LABEL} fontSize={11} fontFamily="var(--font-body)" data-testid="chart-x-label">
          {dsl.x.label}
        </text>
      )}
      {yScaleLabel !== undefined && yScaleLabel !== '' && (
        <text
          x={16}
          y={PAD.top + PLOT_H / 2}
          textAnchor="middle"
          fill={LABEL}
          fontSize={11}
          fontFamily="var(--font-body)"
          data-testid="chart-y-label"
          transform={`rotate(-90 16 ${String(PAD.top + PLOT_H / 2)})`}
        >
          {yScaleLabel}
        </text>
      )}
    </svg>
  );
}

/** chybová úsečka s vrchmi (err bar) okolo bodu `p` */
function errorBar(name: string, p: Point, ys: YScale, color: string, i: number, si: number): JSX.Element {
  const err = p.err ?? 0;
  const top = ys.to(Math.min(p.y === null ? ys.max : p.y + err, ys.max));
  const bottom = ys.to(Math.max(p.y === null ? ys.min : p.y - err, ys.min));
  return (
    <g key={`err-${String(si)}-${String(i)}`} stroke={color} strokeWidth={1.4} opacity={0.85}>
      <line x1={p.sx} y1={top} x2={p.sx} y2={bottom} />
      <line x1={p.sx - 4} y1={top} x2={p.sx + 4} y2={top} />
      <line x1={p.sx - 4} y1={bottom} x2={p.sx + 4} y2={bottom} />
      <title>{`${name}: ±${String(err)}`}</title>
    </g>
  );
}
