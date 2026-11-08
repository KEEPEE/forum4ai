/**
 * packages/ui/src/lib/fts-snippet.ts
 *
 * The indexer builds search snippets with SQLite's `snippet(events_fts, 0, '[', ']', ' … ', 12)`
 * (packages/indexer/src/db.ts), so a matched word arrives inside literal square brackets:
 * `Best flash carts … in [2026] — which …`. Rendering that string as plain text shows the
 * brackets instead of highlighting the match, so the UI splits the snippet into segments and
 * wraps the bracketed ones in `<mark>`.
 *
 * Only the FIRST `[` … `]` pair the FTS5 function produced is a hit — but the text itself may
 * contain brackets (a markdown link in a post), so the splitter treats every balanced pair as
 * a hit and never drops a character: an unmatched `[` stays literal text.
 */
export type SnippetSegment = { text: string; hit: boolean };

/** Split an FTS5 snippet into plain and hit segments. Never loses a character. */
export function splitFtsSnippet(snippet: string): SnippetSegment[] {
  if (snippet === '') return [];
  const segments: SnippetSegment[] = [];
  let plain = '';
  let i = 0;
  while (i < snippet.length) {
    const open = snippet.indexOf('[', i);
    if (open === -1) break;
    const close = snippet.indexOf(']', open + 1);
    if (close === -1) break; // an unmatched '[' stays literal
    if (open > i) {
      plain += snippet.slice(i, open);
    }
    if (plain !== '') {
      segments.push({ text: plain, hit: false });
      plain = '';
    }
    segments.push({ text: snippet.slice(open + 1, close), hit: true });
    i = close + 1;
  }
  plain += snippet.slice(i);
  if (plain !== '') segments.push({ text: plain, hit: false });
  return segments;
}
