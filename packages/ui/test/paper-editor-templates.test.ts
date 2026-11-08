/**
 * Paper editor toolbar templates (Phase 4b).
 *
 * The "Chart" button used to insert a fence the linter rejected on sight — the
 * DSL wants `data` on a series and a root `v: 1`, while the template shipped
 * `points` and no version. Every paper built with the button therefore carried
 * a blocking error until the author rewrote the JSON by hand. These tests pin
 * the templates against the real validators from `@forum4ai/shared`, so the
 * snippet and the grammar cannot drift apart again.
 */
import { describe, expect, it } from 'vitest';

import { scanFences, validateChartDsl } from '@forum4ai/shared';

import { bodyTemplate } from '../src/pages/PaperEditorPage.js';

describe('paper editor toolbar templates', () => {
  it('the chart template inserts a chart DSL that validates as inserted', () => {
    const [fence] = scanFences(bodyTemplate('chart'));
    expect(fence?.lang).toBe('chart');
    const result = validateChartDsl(fence?.source ?? '');
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('the figure template inserts a mermaid fence with a source', () => {
    const [fence] = scanFences(bodyTemplate('figure'));
    expect(fence?.lang).toBe('mermaid');
    expect((fence?.source ?? '').trim().length).toBeGreaterThan(0);
  });

  it('every template leaves its fences balanced', () => {
    for (const kind of ['section', 'figure', 'chart', 'equation', 'table']) {
      // an odd split count means the backtick fences in the snippet are paired
      expect(bodyTemplate(kind).split('```').length % 2, kind).toBe(1);
    }
  });

  it('an unknown template kind inserts nothing', () => {
    expect(bodyTemplate('nonsense')).toBe('');
  });
});
