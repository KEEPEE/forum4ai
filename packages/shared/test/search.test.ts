/**
 * Unit testy zdieľaného FTS5 match-query buildera (F4AI-14, S8).
 *
 * Builder sídlil v indexeri, od S8 je v shared — tieto testy sú jeho
 * domovskou sádou. `packages/indexer/test/db.test.ts` ponecháva vlastný
 * test, ktorý dokladuje, že re-export z `@forum4ai/indexer` funguje a
 * správanie je zhodné (jeden zdroj pravdy, dve kontrolné miesta).
 */
import { describe, expect, it } from 'vitest';

import { buildMatchQuery } from '../src/index.js';

describe('buildMatchQuery — bezpečný FTS5 MATCH reťazec', () => {
  it('prázdny vstup a vstupy bez významu vrátia prázdny reťazec', () => {
    expect(buildMatchQuery('')).toBe('');
    expect(buildMatchQuery('   ')).toBe('');
    expect(buildMatchQuery('*')).toBe('');
    // token bez abecedy (')') nie je "bez významu" — uzatvoríme ho ako
    // phrase, FTS5 z neho má prázdnu frázu, nie syntax error
    expect(buildMatchQuery('()')).toBe('"()"');
  });

  it('čisté alfanumerické tokeny necháva voľné a spája ich implicitným AND', () => {
    expect(buildMatchQuery('dva tokeny')).toBe('dva AND tokeny');
    expect(buildMatchQuery('reklamacna')).toBe('reklamacna');
    expect(buildMatchQuery('pod_ciarkou_1')).toBe('pod_ciarkou_1');
  });

  it('prefixový token `slovo*` ostáva prefix, viac hviezdičiek sa oholí', () => {
    expect(buildMatchQuery('databaze*')).toBe('databaze*');
    expect(buildMatchQuery('databaze**')).toBe('databaze*');
  });

  it('diakritiku NEprepisuje — zráža ju tokenizér na oboch stranách', () => {
    // tokenizér `unicode61 remove_diacritics 2` zrazie `ŽIADOSŤ` → `ziadost`
    // pri indexovaní AJ pri dopyte, preto tuosta musí ísť bez prepisu
    // ( diakritické tokeny len uzatvárame, lebo nie sú čisto ASCII )
    expect(buildMatchQuery('ŽIADOSŤ')).toBe('"ŽIADOSŤ"');
    expect(buildMatchQuery('reklamačná')).toBe('"reklamačná"');
  });

  it('kľúčové slová FTS5 uzatvorí, inak z nich sú operátory', () => {
    for (const keyword of ['and', 'or', 'not', 'near', 'AND', 'NOT']) {
      expect(buildMatchQuery(keyword)).toBe(`"${keyword}"`);
    }
    expect(buildMatchQuery('ucet and prevod')).toBe('ucet AND "and" AND prevod');
    expect(buildMatchQuery('účet and prevod')).toBe('"účet" AND "and" AND prevod');
  });

  it('tokeny s FTS5 syntaxou obalí do úvodzoviek a vnútorné úvodzovky zdvojí', () => {
    expect(buildMatchQuery('a:b')).toBe('"a:b"');
    expect(buildMatchQuery('"lww semantika"')).toBe('"""lww" AND "semantika"""');
    expect(buildMatchQuery('reklamačná:')).toBe('"reklamačná:"');
    expect(buildMatchQuery('say "hi"')).toBe('say AND """hi"""');
  });

  it('útočný vstup vždy vráti vyvážené úvodzovky (žiadna holá FTS5 syntaxa)', () => {
    const nasty = ['NEAR / 3', '"', '((((', 'AND OR NOT', 'a"b', '*', 'x:y:z', '"unclosed'];
    for (const input of nasty) {
      const out = buildMatchQuery(input);
      // nevyvážené úvodzovky by FTS5 rozstrelil ako syntax error; reálny
      // parse overujeme na SQLite v `packages/gateway/test/search.test.ts`
      const quotes = (out.match(/"/g) ?? []).length;
      expect(quotes % 2, `${input} → ${out}`).toBe(0);
    }
  });
});
