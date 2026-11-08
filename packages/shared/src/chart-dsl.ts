/**
 * Chart DSL v1 — validator of the chart language for ```chart fences (design
 * Q3 „Rich content", forum4Ai publish-ready campaign, Phase 3b).
 *
 * Why a custom JSON DSL and not chart.js/recharts: charts come from text
 * that anyone writes (an LLM too). We need deterministic output, clean PDF
 * printing, theming via CSS variables (`var(--chart-N)`, the DSL carries no
 * colors) and a small attack surface. JSON (not YAML), because indentation
 * errors are the most common way LLMs break structured text.
 *
 * DSL (example):
 * ```json
 * {
 *   "v": 1,
 *   "type": "line",
 *   "x": { "label": "RPS", "scale": "linear" },
 *   "y": { "label": "p95", "unit": "ms", "scale": "log" },
 *   "series": [
 *     { "name": "relay", "data": [[100, 4.1], [200, 5.3]], "err": [0.4, 0.9] },
 *     { "name": "gateway", "data": [4.2, 6.1] }
 *   ]
 * }
 * ```
 *
 * Two allowed shapes of `series[i].data`:
 *  - **flat** `(number | null)[]` — consecutive points (index = x coordinate,
 *    or position in `x.categories`); `null` is a gap,
 *  - **pairs** `[x, y | null][]` — explicit x (number; with
 *    `x.scale: "time"` also an ISO string/date); y may be `null` = gap.
 * All series in a chart must use the SAME shape (otherwise the points cannot
 * be compared on a shared axis).
 *
 * Strictness (deliberate — gateway/MCP lint adopts it in Phase 4):
 *  - unknown keys at any level = error (no silent ignoring),
 *  - `v` must be exactly `1`,
 *  - all numbers must be finite (JSON `NaN` does not exist, but `1e999`
 *    parses to `Infinity` → we reject it),
 *  - a non-positive value must not pass through a `log` axis,
 *  - caps: JSON ≤ 16 KB, ≤ 12 series, ≤ 2000 points total, ≤ 2000 categories.
 *
 * `validateChartDsl(json)` is a pure function without I/O — the UI calls it at
 * render time (a broken chart shows an error box with the source, never an
 * empty space), and the gateway and MCP lint can use it to verify before
 * publish.
 */

/** maximálna veľkosť JSON tela ```chart zárezu (bajty UTF-8) */
export const CHART_DSL_MAX_JSON_BYTES = 16 * 1024;
/** maximálny počet sérií v jednom grafe */
export const CHART_DSL_MAX_SERIES = 12;
/** maximálny súčet bodov naprieč sériami */
export const CHART_DSL_MAX_POINTS = 2000;
/** maximálny počet kategórií na kategóriovej osi */
export const CHART_DSL_MAX_CATEGORIES = 2000;
/** dĺžkové stropy textových polí (kópia pre UI aj gateway — jeden zdroj) */
export const CHART_DSL_MAX_LABEL_CHARS = 200;
export const CHART_DSL_MAX_NAME_CHARS = 120;
export const CHART_DSL_MAX_UNIT_CHARS = 40;

export const CHART_TYPES = ['line', 'area', 'bar', 'stacked-bar', 'scatter'] as const;
export const CHART_SCALES = ['linear', 'log', 'time'] as const;

export type ChartType = (typeof CHART_TYPES)[number];
export type ChartScale = (typeof CHART_SCALES)[number];

/** bod v dvojicovom tvare: `[x, y]`, x number|ISO string, y number|null */
export type ChartPointPair = [number | string, number | null];
/** jeden prvok `series[i].data` */
export type ChartPoint = number | null | ChartPointPair;

export interface ChartAxisX {
  label?: string;
  scale?: ChartScale;
  /** prítomnosť kategórií = kategóriová os (ploché dáta po indexoch) */
  categories?: string[];
}

export interface ChartAxisY {
  label?: string;
  /** jednotka zobrazená za popiskom osy, napr. "ms" */
  unit?: string;
  scale?: ChartScale;
  min?: number;
  max?: number;
}

export interface ChartSeries {
  name: string;
  data: ChartPoint[];
  /** chybové úsečky; dĺžka = dĺžka `data`, `null` = bez chyby na bode */
  err?: (number | null)[];
}

export interface ChartDsl {
  v: 1;
  type: ChartType;
  title?: string;
  caption?: string;
  x?: ChartAxisX;
  y?: ChartAxisY;
  series: ChartSeries[];
}

export interface ChartDslValidation {
  ok: boolean;
  /** normalizované dáta len pri `ok` (výchozí `scale` doplnené) */
  data?: ChartDsl;
  /** ľudské chyby s cestou (`series[0].data[3]`) — prázdne pri ok */
  errors: string[];
}

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** neznáme kľúče → chyby; `where` je prefix cesty pre čitateľnosť */
function unknownKeysError(obj: Record<string, unknown>, allowed: readonly string[], where: string): string[] {
  const extra = Object.keys(obj).filter((key) => !allowed.includes(key));
  return extra.map((key) => `${where}: unknown key "${key}" (allowed: ${allowed.join(', ')})`);
}

function stringField(
  obj: Record<string, unknown>,
  key: string,
  where: string,
  errors: string[],
  maxChars: number,
  { required = false, nonEmpty = false } = {},
): string | undefined {
  const value = obj[key];
  if (value === undefined) {
    if (required) errors.push(`${where}.${key}: required`);
    return undefined;
  }
  if (typeof value !== 'string') {
    errors.push(`${where}.${key}: must be a string`);
    return undefined;
  }
  if (nonEmpty && value.trim() === '') {
    errors.push(`${where}.${key}: must not be empty`);
    return undefined;
  }
  if (value.length > maxChars) {
    errors.push(`${where}.${key}: longer than ${String(maxChars)} chars`);
    return undefined;
  }
  return value;
}

function scaleField(obj: Record<string, unknown>, key: string, where: string, errors: string[]): ChartScale | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(CHART_SCALES as readonly string[]).includes(value)) {
    errors.push(`${where}.${key}: must be one of ${CHART_SCALES.join(' | ')}`);
    return undefined;
  }
  return value as ChartScale;
}

/** dátumový vstup pre `time` osu: number (epoch s/ms) alebo parse'nuteľný ISO string */
function isTimeValue(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return !Number.isNaN(Date.parse(value));
  return false;
}

/**
 * Overí jednu sériu a vráti (a) chyby a (b) zistený tvar dát
 * ('flat' | 'pair' | 'empty'), aby volajúci zjednotil tvar naprieč sériami.
 */
function validateSeries(
  raw: unknown,
  index: number,
  ctx: { xScale: ChartScale; hasCategories: boolean },
): { errors: string[]; points: number; shape: 'flat' | 'pair' | 'empty'; series?: ChartSeries } {
  const errors: string[] = [];
  const where = `series[${String(index)}]`;
  if (!isRecord(raw)) {
    return { errors: [`${where}: must be an object`], points: 0, shape: 'empty' };
  }
  errors.push(...unknownKeysError(raw, ['name', 'data', 'err'], where));

  const name = stringField(raw, 'name', where, errors, CHART_DSL_MAX_NAME_CHARS, {
    required: true,
    nonEmpty: true,
  });

  const data = raw['data'];
  if (!Array.isArray(data) || data.length === 0) {
    errors.push(`${where}.data: must be a non-empty array of numbers, nulls or [x, y] pairs`);
    return { errors, points: 0, shape: 'empty' };
  }
  if (data.length > CHART_DSL_MAX_POINTS) {
    errors.push(`${where}.data: ${String(data.length)} points exceed the ${String(CHART_DSL_MAX_POINTS)}-point limit`);
  }

  let shape: 'flat' | 'pair' | 'empty' = 'empty';
  let mixed = false;

  for (let i = 0; i < data.length; i += 1) {
    const point = data[i];
    const at = `${where}.data[${String(i)}]`;
    if (point === null || isFiniteNumber(point)) {
      if (shape === 'pair') mixed = true;
      else shape = 'flat';
      continue;
    }
    if (Array.isArray(point)) {
      if (shape === 'flat') mixed = true;
      else shape = 'pair';
      if (point.length !== 2) {
        errors.push(`${at}: pair must have exactly 2 elements [x, y]`);
        continue;
      }
      const [x, y] = point as [unknown, unknown];
      if (ctx.xScale === 'time' ? !isTimeValue(x) : !isFiniteNumber(x)) {
        errors.push(
          ctx.xScale === 'time'
            ? `${at}[0]: time axis needs a finite epoch number or an ISO-8601 string`
            : `${at}[0]: x must be a finite number`,
        );
      }
      if (y !== null && !isFiniteNumber(y)) {
        errors.push(`${at}[1]: y must be a finite number or null`);
      }
      continue;
    }
    errors.push(`${at}: must be a finite number, null or an [x, y] pair`);
  }

  if (mixed) {
    errors.push(`${where}.data: cannot mix plain numbers and [x, y] pairs in one series`);
  }
  if (ctx.hasCategories && shape === 'pair') {
    errors.push(`${where}.data: [x, y] pairs cannot be combined with x.categories`);
  }

  // err: povinná zhoda dĺžky, nezáporné konečné čísla alebo null
  const err = raw['err'];
  let errValues: (number | null)[] | undefined;
  if (err !== undefined) {
    if (!Array.isArray(err)) {
      errors.push(`${where}.err: must be an array of non-negative numbers or nulls`);
    } else if (err.length !== data.length) {
      errors.push(`${where}.err: length ${String(err.length)} must equal data length ${String(data.length)}`);
    } else {
      errValues = [];
      for (let i = 0; i < err.length; i += 1) {
        const value = err[i];
        if (value === null) {
          errValues.push(null);
          continue;
        }
        if (!isFiniteNumber(value) || value < 0) {
          errors.push(`${where}.err[${String(i)}]: must be a non-negative finite number or null`);
          continue;
        }
        errValues.push(value);
      }
    }
  }

  if (errors.length > 0) return { errors, points: data.length, shape };
  if (name === undefined) return { errors: [`${where}.name: required`], points: data.length, shape };

  return {
    errors: [],
    points: data.length,
    shape,
    series: { name, data: data as ChartPoint[], ...(errValues !== undefined ? { err: errValues } : {}) },
  };
}

/**
 * Validuj JSON reťazec ako Chart DSL v1. Vracia `{ ok, data?, errors[] }`;
 * `errors` sú vždy nepraždné pri `ok: false` a prázdne pri `ok: true`.
 */
export function validateChartDsl(json: string): ChartDslValidation {
  const errors: string[] = [];

  if (encoder.encode(json).length > CHART_DSL_MAX_JSON_BYTES) {
    return {
      ok: false,
      errors: [`chart fence exceeds ${String(CHART_DSL_MAX_JSON_BYTES)} bytes (limit)`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`invalid JSON: ${reason}`] };
  }

  if (!isRecord(parsed)) {
    return { ok: false, errors: ['root must be a JSON object'] };
  }
  errors.push(...unknownKeysError(parsed, ['v', 'type', 'title', 'caption', 'x', 'y', 'series'], 'root'));

  if (parsed['v'] !== 1) {
    errors.push(`root.v: must be exactly 1 (got ${JSON.stringify(parsed['v']) ?? 'undefined'})`);
  }

  const rawType = parsed['type'];
  let type: ChartType | undefined;
  if (typeof rawType !== 'string' || !(CHART_TYPES as readonly string[]).includes(rawType)) {
    errors.push(`root.type: must be one of ${CHART_TYPES.join(' | ')}`);
  } else {
    type = rawType as ChartType;
  }

  const title = stringField(parsed, 'title', 'root', errors, CHART_DSL_MAX_LABEL_CHARS);
  const caption = stringField(parsed, 'caption', 'root', errors, CHART_DSL_MAX_LABEL_CHARS);

  // osi — x: label/scale/categories, y: label/unit/scale/min/max
  let xScale: ChartScale = 'linear';
  let hasCategories = false;
  let xAxis: ChartAxisX | undefined;
  const rawX = parsed['x'];
  if (rawX !== undefined) {
    if (!isRecord(rawX)) {
      errors.push('root.x: must be an object');
    } else {
      errors.push(...unknownKeysError(rawX, ['label', 'scale', 'categories'], 'root.x'));
      const label = stringField(rawX, 'label', 'root.x', errors, CHART_DSL_MAX_LABEL_CHARS);
      const scale = scaleField(rawX, 'scale', 'root.x', errors);
      if (scale !== undefined) xScale = scale;
      const categories = rawX['categories'];
      let categoryList: string[] | undefined;
      if (categories !== undefined) {
        if (!Array.isArray(categories) || categories.length === 0) {
          errors.push('root.x.categories: must be a non-empty array of strings');
        } else if (categories.length > CHART_DSL_MAX_CATEGORIES) {
          errors.push(`root.x.categories: more than ${String(CHART_DSL_MAX_CATEGORIES)} entries`);
        } else if (!categories.every((item) => typeof item === 'string' && item !== '')) {
          errors.push('root.x.categories: every category must be a non-empty string');
        } else {
          categoryList = categories as string[];
          hasCategories = true;
        }
      }
      xAxis = {
        ...(label !== undefined ? { label } : {}),
        ...(scale !== undefined ? { scale } : {}),
        ...(categoryList !== undefined ? { categories: categoryList } : {}),
      };
    }
  }

  let yScale: ChartScale = 'linear';
  let yAxis: ChartAxisY | undefined;
  const rawY = parsed['y'];
  if (rawY !== undefined) {
    if (!isRecord(rawY)) {
      errors.push('root.y: must be an object');
    } else {
      errors.push(...unknownKeysError(rawY, ['label', 'unit', 'scale', 'min', 'max'], 'root.y'));
      const label = stringField(rawY, 'label', 'root.y', errors, CHART_DSL_MAX_LABEL_CHARS);
      const unit = stringField(rawY, 'unit', 'root.y', errors, CHART_DSL_MAX_UNIT_CHARS);
      const scale = scaleField(rawY, 'scale', 'root.y', errors);
      if (scale !== undefined) yScale = scale;
      let min: number | undefined;
      let max: number | undefined;
      if (rawY['min'] !== undefined) {
        if (isFiniteNumber(rawY['min'])) min = rawY['min'];
        else errors.push('root.y.min: must be a finite number');
      }
      if (rawY['max'] !== undefined) {
        if (isFiniteNumber(rawY['max'])) max = rawY['max'];
        else errors.push('root.y.max: must be a finite number');
      }
      if (min !== undefined && max !== undefined && min >= max) {
        errors.push('root.y: min must be lower than max');
      }
      yAxis = {
        ...(label !== undefined ? { label } : {}),
        ...(unit !== undefined ? { unit } : {}),
        ...(scale !== undefined ? { scale } : {}),
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
      };
    }
  }

  const rawSeries = parsed['series'];
  const series: ChartSeries[] = [];
  let totalPoints = 0;
  let commonShape: 'flat' | 'pair' | 'empty' = 'empty';
  if (!Array.isArray(rawSeries) || rawSeries.length === 0) {
    errors.push('root.series: must be a non-empty array of series objects');
  } else {
    if (rawSeries.length > CHART_DSL_MAX_SERIES) {
      errors.push(`root.series: ${String(rawSeries.length)} series exceed the ${String(CHART_DSL_MAX_SERIES)}-series limit`);
    }
    for (let i = 0; i < rawSeries.length; i += 1) {
      const result = validateSeries(rawSeries[i], i, { xScale, hasCategories });
      errors.push(...result.errors);
      totalPoints += result.points;
      if (result.shape !== 'empty') {
        if (commonShape !== 'empty' && commonShape !== result.shape) {
          errors.push(`series[${String(i)}].data: all series must use the same data shape (found ${commonShape} and ${result.shape})`);
        } else {
          commonShape = result.shape;
        }
      }
      if (result.series !== undefined) series.push(result.series);
    }
    if (totalPoints > CHART_DSL_MAX_POINTS) {
      errors.push(`root.series: ${String(totalPoints)} points in total exceed the ${String(CHART_DSL_MAX_POINTS)}-point limit`);
    }
  }

  // log osy: všetky konečné hodnoty na osi musia byť kladné
  if (errors.length === 0) {
    if (xScale === 'log') {
      const xs =
        commonShape === 'pair'
          ? series.flatMap((s) => s.data.flatMap((p) => (Array.isArray(p) && typeof p[0] === 'number' ? [p[0]] : [])))
          : series.flatMap((s) => s.data.flatMap((p) => (typeof p === 'number' ? [p] : [])));
      if (xs.some((v) => v <= 0)) errors.push('root.x.scale "log": all x values must be > 0');
    }
    if (yScale === 'log') {
      const ys = series.flatMap((s) =>
        s.data.flatMap((p) => {
          if (p === null) return [];
          if (Array.isArray(p)) return typeof p[1] === 'number' ? [p[1]] : [];
          return [p];
        }),
      );
      if (ys.some((v) => v <= 0)) errors.push('root.y.scale "log": all y values must be > 0');
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const data: ChartDsl = {
    v: 1,
    type: type as ChartType,
    ...(title !== undefined ? { title } : {}),
    ...(caption !== undefined ? { caption } : {}),
    ...(xAxis !== undefined && Object.keys(xAxis).length > 0 ? { x: xAxis } : {}),
    ...(yAxis !== undefined && Object.keys(yAxis).length > 0 ? { y: yAxis } : {}),
    series,
  };
  return { ok: true, data, errors: [] };
}
