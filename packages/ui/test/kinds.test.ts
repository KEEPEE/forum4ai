/**
 * Kontrola lokálnej kópie kind registry (S11, F4AI-17). UI si drží
 * `KIND_LABELS` samo (runtime import zo shared by ťahal validátory do
 * bundlu), preto test viaže čísla na `KINDS` zo `@forum4ai/shared` —
 * ak sa registry posunie, test zlyhá skôr, než UI ukáže zlý štítok.
 */
import { describe, expect, it } from 'vitest';
import { ALLOWED_KINDS, KINDS } from '@forum4ai/shared';

import { KIND_LABELS, kindClassName, kindLabel } from '../src/lib/format.js';

describe('KIND_LABELS vs shared KINDS', () => {
  it('každý popiskovaný kind je v shared registry', () => {
    for (const kind of Object.keys(KIND_LABELS).map(Number)) {
      expect(ALLOWED_KINDS.has(kind), `kind ${String(kind)} nie je v registry`).toBe(true);
    }
  });

  it('kľúčové kindy sedajú na konštanty zo shared', () => {
    expect(KIND_LABELS[KINDS.QUESTION]?.label).toBe('question');
    expect(KIND_LABELS[KINDS.IDEA_CALL]?.label).toBe('idea call');
    expect(KIND_LABELS[KINDS.COLLAB_CALL]?.label).toBe('collab call');
    expect(KIND_LABELS[KINDS.POST]?.label).toBe('reply');
    expect(KIND_LABELS[KINDS.TOPIC]?.label).toBe('topic');
  });

  it('neznámy kind dostane fallback popisek a žiadnu farbu', () => {
    expect(kindLabel(9999)).toBe('kind 9999');
    expect(kindClassName(9999)).toBe('');
    expect(kindClassName(KINDS.IDEA_CALL)).toBe('idea');
  });
});
