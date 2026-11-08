/**
 * Testy Chart DSL v1 validátora (Phase 3b, dizajn Q3).
 *
 * Validátor je jeden zdroj pravdy pre tri miesta: UI render (chybový box),
 * gateway lint a MCP lint (Phase 4, kind 30023 paper bodies). Preto tvrdé
 * testy na všetky typy, oba tvary dát, oba zmysly osí, medzery, err bar-y,
 * všetky stropy a každú triedu skazenej shémy — vrátane `NaN`/`Infinity`,
 * neznámych kľúčov a `v !== 1`.
 */
import { describe, expect, it } from 'vitest';

import {
  CHART_DSL_MAX_JSON_BYTES,
  CHART_DSL_MAX_POINTS,
  CHART_DSL_MAX_SERIES,
  validateChartDsl,
} from '../src/index.js';
import type { ChartDsl } from '../src/index.js';

/** helper: parsni a validuj objekt priamo (JSON.stringify obchádza JSON chyby) */
function check(value: unknown) {
  return validateChartDsl(JSON.stringify(value));
}

/** skratka: ok + data */
function okData(value: unknown): ChartDsl {
  const result = check(value);
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);
  if (result.data === undefined) throw new Error('data chýba pri ok');
  return result.data;
}

const line = {
  v: 1,
  type: 'line',
  series: [{ name: 'relay', data: [1, 2, 3] }],
};

describe('validateChartDsl — kladné prípady', () => {
  it('akceptuje minimálny line graf a vráti normalizované dáta', () => {
    const data = okData(line);
    expect(data.v).toBe(1);
    expect(data.type).toBe('line');
    expect(data.series[0]?.name).toBe('relay');
    expect(data.series[0]?.data).toEqual([1, 2, 3]);
  });

  it('akceptuje všetkých 5 typov grafu', () => {
    for (const type of ['line', 'area', 'bar', 'stacked-bar', 'scatter'] as const) {
      const data = okData({ ...line, type });
      expect(data.type).toBe(type);
    }
  });

  it('akceptuje category os s kategóriami a plochými dátami', () => {
    const data = okData({
      v: 1,
      type: 'bar',
      x: { label: 'Týždeň', categories: ['W1', 'W2', 'W3'] },
      y: { label: 'RPS', unit: 'req/s' },
      series: [
        { name: 'a', data: [1, 2, 3] },
        { name: 'b', data: [4, 5, 6] },
      ],
    });
    expect(data.x?.categories).toEqual(['W1', 'W2', 'W3']);
    expect(data.y?.unit).toBe('req/s');
  });

  it('akceptuje [x, y] dvojice na lineárnej osi', () => {
    const data = okData({
      v: 1,
      type: 'scatter',
      x: { label: 'RPS', scale: 'linear' },
      y: { label: 'p95', unit: 'ms' },
      series: [{ name: 'relay', data: [[100, 4.1], [200, 5.3], [400, 9.2]] }],
    });
    expect(data.series[0]?.data[0]).toEqual([100, 4.1]);
  });

  it('akceptuje log os (y) s kladnými hodnotami', () => {
    const data = okData({
      v: 1,
      type: 'line',
      y: { label: 'latency', scale: 'log' },
      series: [{ name: 'p99', data: [1, 10, 100, 1000] }],
    });
    expect(data.y?.scale).toBe('log');
  });

  it('akceptuje log os (x) s [x, y] dátami', () => {
    okData({
      v: 1,
      type: 'line',
      x: { scale: 'log' },
      series: [{ name: 'a', data: [[1, 2], [10, 3], [100, 5]] }],
    });
  });

  it('akceptuje time os s ISO dátumami', () => {
    const data = okData({
      v: 1,
      type: 'line',
      x: { scale: 'time' },
      series: [{ name: 'a', data: [['2026-01-01', 1], ['2026-02-01', 4]] }],
    });
    expect(data.x?.scale).toBe('time');
  });

  it('akceptuje time os s epoch sekundami aj milisekundami', () => {
    okData({
      v: 1,
      type: 'line',
      x: { scale: 'time' },
      series: [
        { name: 's', data: [[1_735_689_600, 1], [1_767_225_600, 3]] },
        { name: 'ms', data: [[1_735_689_600_000, 2], [1_767_225_600_000, 5]] },
      ],
    });
  });

  it('akceptuje null medzery v plochých dátach', () => {
    const data = okData({ v: 1, type: 'line', series: [{ name: 'a', data: [1, null, 3, null] }] });
    expect(data.series[0]?.data).toEqual([1, null, 3, null]);
  });

  it('akceptuje null y v [x, y] dvojiciach', () => {
    okData({ v: 1, type: 'line', series: [{ name: 'a', data: [[1, null], [2, 3]] }] });
  });

  it('akceptuje err úsečky zarovnané s dátami', () => {
    const data = okData({
      v: 1,
      type: 'line',
      series: [{ name: 'a', data: [10, 20, 30], err: [0.5, null, 1.2] }],
    });
    expect(data.series[0]?.err).toEqual([0.5, null, 1.2]);
  });

  it('akceptuje title a caption', () => {
    const data = okData({ ...line, title: 'Latency', caption: 'p95 za rok' });
    expect(data.title).toBe('Latency');
    expect(data.caption).toBe('p95 za rok');
  });

  it('akceptuje y.min a y.max', () => {
    const data = okData({ ...line, y: { min: 0, max: 100 } });
    expect(data.y?.min).toBe(0);
    expect(data.y?.max).toBe(100);
  });

  it('akceptuje 12 sérií a 2000 bodov (stropy práve na hranici)', () => {
    const series = Array.from({ length: CHART_DSL_MAX_SERIES }, (_, i) => ({
      name: `s${String(i)}`,
      data: Array.from({ length: Math.floor(CHART_DSL_MAX_POINTS / CHART_DSL_MAX_SERIES) }, (_, j) => j),
    }));
    expect(check({ v: 1, type: 'line', series }).ok).toBe(true);
  });

  it('nevráti `data` pri chybe a nechá errors nepraždné', () => {
    const result = check({ v: 2, type: 'line', series: [{ name: 'a', data: [1] }] });
    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('validateChartDsl — skazene vstupy', () => {
  it('zamietne neplatný JSON', () => {
    const result = validateChartDsl('{ "v": 1, ');
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('invalid JSON');
  });

  it('zamietne JSON pole namiesto objektu', () => {
    expect(validateChartDsl('[1,2,3]').errors[0]).toContain('root must be a JSON object');
  });

  it('zamietne v !== 1', () => {
    for (const v of [0, 2, '1', null, undefined]) {
      const result = check({ ...line, v });
      expect(result.ok, `v=${String(v)}`).toBe(false);
      expect(result.errors.some((e) => e.includes('root.v'))).toBe(true);
    }
  });

  it('zamietne neznámy typ grafu', () => {
    const result = check({ ...line, type: 'pie' });
    expect(result.errors.some((e) => e.includes('root.type'))).toBe(true);
  });

  it('zamietne chýbajúci typ', () => {
    const result = check({ v: 1, series: [{ name: 'a', data: [1] }] });
    expect(result.errors.some((e) => e.includes('root.type'))).toBe(true);
  });

  it('zamietne neznámy kľúč na root-e', () => {
    const result = check({ ...line, colors: ['red'] });
    expect(result.errors.some((e) => e.includes('unknown key "colors"'))).toBe(true);
  });

  it('zamietne neznámy kľúč na osi x', () => {
    const result = check({ ...line, x: { label: 'a', grid: true } });
    expect(result.errors.some((e) => e.includes('root.x: unknown key "grid"'))).toBe(true);
  });

  it('zamietne neznámy kľúč na sérii', () => {
    const result = check({ v: 1, type: 'line', series: [{ name: 'a', data: [1], color: '#f00' }] });
    expect(result.errors.some((e) => e.includes('series[0]: unknown key "color"'))).toBe(true);
  });

  it('zamietne prázdne series a series mimo pole', () => {
    expect(check({ v: 1, type: 'line', series: [] }).errors.some((e) => e.includes('root.series'))).toBe(true);
    expect(check({ v: 1, type: 'line', series: 'x' }).errors.some((e) => e.includes('root.series'))).toBe(true);
  });

  it('zamietne 13 sérií', () => {
    const series = Array.from({ length: CHART_DSL_MAX_SERIES + 1 }, (_, i) => ({ name: `s${String(i)}`, data: [1] }));
    const result = check({ v: 1, type: 'line', series });
    expect(result.errors.some((e) => e.includes('series limit') || e.includes('exceed'))).toBe(true);
  });

  it('zamietne > 2000 bodov spolu', () => {
    const series = [
      { name: 'a', data: Array.from({ length: 1500 }, (_, i) => i) },
      { name: 'b', data: Array.from({ length: 1500 }, (_, i) => i) },
    ];
    const result = check({ v: 1, type: 'line', series });
    expect(result.errors.some((e) => e.includes('points in total exceed'))).toBe(true);
  });

  it('zamietne prázdnu sériu dát', () => {
    expect(check({ v: 1, type: 'line', series: [{ name: 'a', data: [] }] }).ok).toBe(false);
  });

  it('zamietne prázdne meno série', () => {
    const result = check({ v: 1, type: 'line', series: [{ name: '  ', data: [1] }] });
    expect(result.errors.some((e) => e.includes('series[0].name'))).toBe(true);
  });

  it('zamietne reťazec v dátach', () => {
    const result = check({ v: 1, type: 'line', series: [{ name: 'a', data: ['1', 2] }] });
    expect(result.errors.some((e) => e.includes('series[0].data[0]'))).toBe(true);
  });

  it('zamietne Infinity a -Infinity (JSON ich parsí na number)', () => {
    const result = validateChartDsl('{"v":1,"type":"line","series":[{"name":"a","data":[1e999,2]}]}');
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('data[0]'))).toBe(true);
  });

  it('zamietne NaN cez 0/0 nie je v JSON — skontrolujeme -1e999', () => {
    const result = validateChartDsl('{"v":1,"type":"line","series":[{"name":"a","data":[-1e999]}]}');
    expect(result.ok).toBe(false);
  });

  it('zamietne miešanie čísel a dvojíc v jednej sérii', () => {
    const result = check({ v: 1, type: 'line', series: [{ name: 'a', data: [1, [2, 3]] }] });
    expect(result.errors.some((e) => e.includes('cannot mix'))).toBe(true);
  });

  it('zamietne rôzne tvary dát medzi sériami', () => {
    const result = check({
      v: 1,
      type: 'line',
      series: [
        { name: 'a', data: [1, 2] },
        { name: 'b', data: [[1, 2], [3, 4]] },
      ],
    });
    expect(result.errors.some((e) => e.includes('same data shape'))).toBe(true);
  });

  it('zamietne dvojicu so zlým počtom prvkov', () => {
    const result = check({ v: 1, type: 'line', series: [{ name: 'a', data: [[1, 2, 3]] }] });
    expect(result.errors.some((e) => e.includes('exactly 2 elements'))).toBe(true);
  });

  it('zamietne [x, y] dvojice pri category osi', () => {
    const result = check({
      v: 1,
      type: 'bar',
      x: { categories: ['a', 'b'] },
      series: [{ name: 'a', data: [[1, 2], [3, 4]] }],
    });
    expect(result.errors.some((e) => e.includes('cannot be combined with x.categories'))).toBe(true);
  });

  it('zamietne nečíselné x na lineárnej osi', () => {
    const result = check({ v: 1, type: 'line', series: [{ name: 'a', data: [['jan', 2]] }] });
    expect(result.errors.some((e) => e.includes('[0]'))).toBe(true);
  });

  it('zamietne neparsnuteľný dátum na time osi', () => {
    const result = check({
      v: 1,
      type: 'line',
      x: { scale: 'time' },
      series: [{ name: 'a', data: [['polovica januara', 2]] }],
    });
    expect(result.errors.some((e) => e.includes('time axis'))).toBe(true);
  });

  it('zamietne nekladné hodnoty na log osi y', () => {
    const result = check({ v: 1, type: 'line', y: { scale: 'log' }, series: [{ name: 'a', data: [1, 0, 3] }] });
    expect(result.errors.some((e) => e.includes('y values must be > 0'))).toBe(true);
  });

  it('zamietne nekladné x na log osi x', () => {
    const result = check({
      v: 1,
      type: 'line',
      x: { scale: 'log' },
      series: [{ name: 'a', data: [[1, 2], [-5, 3]] }],
    });
    expect(result.errors.some((e) => e.includes('x values must be > 0'))).toBe(true);
  });

  it('zamietne neplatnú hodnotu scale', () => {
    const result = check({ ...line, y: { scale: 'sqrt' } });
    expect(result.errors.some((e) => e.includes('root.y.scale'))).toBe(true);
  });

  it('zamietne min >= max na osi y', () => {
    const result = check({ ...line, y: { min: 10, max: 5 } });
    expect(result.errors.some((e) => e.includes('min must be lower than max'))).toBe(true);
  });

  it('zamietne err s nesúladom dĺžky', () => {
    const result = check({ v: 1, type: 'line', series: [{ name: 'a', data: [1, 2, 3], err: [0.1] }] });
    expect(result.errors.some((e) => e.includes('err: length'))).toBe(true);
  });

  it('zamietne zápornú err hodnotu', () => {
    const result = check({ v: 1, type: 'line', series: [{ name: 'a', data: [1, 2], err: [0.1, -2] }] });
    expect(result.errors.some((e) => e.includes('err[1]'))).toBe(true);
  });

  it('zamietne prázdne categories a categories mimo pole', () => {
    expect(check({ ...line, x: { categories: [] } }).errors.some((e) => e.includes('categories'))).toBe(true);
    expect(check({ ...line, x: { categories: 'abc' } }).errors.some((e) => e.includes('categories'))).toBe(true);
  });

  it('zamietne categories s necudzím prvkom', () => {
    const result = check({ ...line, x: { categories: ['a', 3] } });
    expect(result.errors.some((e) => e.includes('every category'))).toBe(true);
  });

  it('zamietne x/y mimo objektu', () => {
    expect(check({ ...line, x: 'oops' }).errors.some((e) => e.includes('root.x'))).toBe(true);
    expect(check({ ...line, y: 5 }).errors.some((e) => e.includes('root.y'))).toBe(true);
  });

  it('zamietne JSON väčší ako 16 KB', () => {
    const big = {
      v: 1,
      type: 'line',
      series: [{ name: 'a', data: Array.from({ length: 4000 }, (_, i) => i)}],
      caption: 'x'.repeat(2000),
    };
    const json = JSON.stringify(big);
    expect(json.length).toBeGreaterThan(CHART_DSL_MAX_JSON_BYTES);
    const result = validateChartDsl(json);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('bytes');
  });

  it('akceptuje JSON tesne pod 16 KB', () => {
    const data = Array.from({ length: 900 }, (_, i) => i);
    const json = JSON.stringify({ v: 1, type: 'line', series: [{ name: 'a', data }] });
    expect(json.length).toBeLessThan(CHART_DSL_MAX_JSON_BYTES);
    expect(validateChartDsl(json).ok).toBe(true);
  });

  it('zbiera viac chýb naraz (žiadne skoré vrátenie po prvej)', () => {
    const result = check({ v: 3, type: 'nope', series: [] });
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
