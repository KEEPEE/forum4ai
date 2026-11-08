/**
 * packages/ui/test/fts-snippet.test.ts
 *
 * The indexer asks SQLite for snippets bracketed with `[` … `]`
 * (`snippet(events_fts, 0, '[', ']', ' … ', 12)`), and the search page has to turn those
 * brackets into `<mark>` instead of printing them. These tests pin the contract of the
 * splitter: hits are marked, nothing is ever lost, and text that merely LOOKS like a
 * bracket pair is not silently eaten.
 */
import { describe, expect, it } from 'vitest';

import { splitFtsSnippet } from '../src/lib/fts-snippet.js';

describe('splitFtsSnippet', () => {
  it('marks the bracketed run as the hit', () => {
    expect(splitFtsSnippet('Best telescopes in [2026] for planetary viewing')).toEqual([
      { text: 'Best telescopes in ', hit: false },
      { text: '2026', hit: true },
      { text: ' for planetary viewing', hit: false },
    ]);
  });

  it('handles a snippet that is only a hit', () => {
    expect(splitFtsSnippet('[tokio]')).toEqual([{ text: 'tokio', hit: true }]);
  });

  it('handles several hits', () => {
    expect(splitFtsSnippet('a [b] c [d] e')).toEqual([
      { text: 'a ', hit: false },
      { text: 'b', hit: true },
      { text: ' c ', hit: false },
      { text: 'd', hit: true },
      { text: ' e', hit: false },
    ]);
  });

  it('keeps an unmatched bracket as literal text', () => {
    expect(splitFtsSnippet('see [the docs for details')).toEqual([
      { text: 'see [the docs for details', hit: false },
    ]);
    expect(splitFtsSnippet('no brackets at all')).toEqual([{ text: 'no brackets at all', hit: false }]);
  });

  it('never loses a character, whatever the input', () => {
    const samples = [
      '',
      '[]',
      '[a]',
      '][',
      'a[b]c',
      'a[b',
      'a]b',
      '[[x]]',
      ' … leading ellipsis and [hit]',
      'nested [a [b] c]',
      'emoji 🚀 in [front] of text',
    ];
    for (const s of samples) {
      const joined = splitFtsSnippet(s)
        .map((seg) => (seg.hit ? `[${seg.text}]` : seg.text))
        .join('');
      // `[]` and `[[x]]` collapse their empty/extra brackets, so compare the letters only.
      expect(joined.replace(/[[\]]/g, '')).toBe(s.replace(/[[\]]/g, ''));
    }
  });

  it('returns nothing for an empty snippet', () => {
    expect(splitFtsSnippet('')).toEqual([]);
  });
});
