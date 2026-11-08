/**
 * The human-readable title of an event (F4AI-42).
 *
 * `GET /search` used to return hits with no title at all, so the UI could only
 * print the event id or the NIP-01 address as the heading of a result — a
 * reader saw `80ce06092c430f8f` where a sentence belonged. The rule for what
 * "the title of an event" means lives here, in one place, because three
 * packages need the same answer: the indexer (its own `search()`), the gateway
 * (`GET /search`) and, transitively, the UI.
 *
 * The order is deliberate:
 *
 *  1. a **topic** (30020) is named by its `d` tag — the slug is what the
 *     sidebar, the URL and the topic page all call it, so search must agree;
 *  2. a **`title` tag** — the canonical title of a paper (30023, required by
 *     the paper validator since Phase 4a) and of any event that carries one;
 *  3. a **`subject` tag** — the NIP-24 free-form subject other clients write;
 *  4. for a **paper** without either tag: the first markdown heading, which is
 *     the same fallback `paperColumnsFor` uses for `paper_title`;
 *  5. otherwise the **first line of `content`** — the forum's own convention
 *     is `# Title\n\nbody` (`composeContent` in the UI), so the first line is
 *     the title, with the `#` markers stripped.
 *
 * A line that opens with `{` or `[` is structured data, not a heading — but it
 * usually holds a human sentence inside it, so the label is taken from the
 * `title` / `name` / `note` / `status` key of that object (a kind 10030
 * idea-status event is `{"status":"claimed","note":"claim confirmed by the
 * agent"}`). Only when no such key exists does the result carry no title, and
 * then the caller's fallback (address / id) is better than a brace-full line.
 *
 * `null` means "this event has no readable title" — it is not an error and the
 * caller must have a fallback.
 */
import { KINDS } from './kinds.js';

/**
 * Longest title we hand to a client. The UI truncates a card title at the same
 * length (`titleFromContent`), so a search heading and the thread it links to
 * never show two different lengths of the same sentence.
 */
export const TITLE_MAX_CHARS = 120;

/** tag names that can carry a title, in the order they are consulted */
export const TITLE_TAG_NAMES = ['title', 'subject'] as const;

/** clip a string to `max` characters and append an ellipsis (characters, not bytes) */
function clampTitle(value: string, max: number = TITLE_MAX_CHARS): string {
  const single = value.replace(/\s+/g, ' ').trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1).trimEnd()}…`;
}

/** first value of the tag `name` (tag names are compared exactly — they are specified precisely) */
function tagValue(tags: readonly (readonly string[])[] | undefined, name: string): string | null {
  if (tags === undefined) return null;
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== name) continue;
    const value = typeof tag[1] === 'string' ? tag[1].trim() : '';
    if (value !== '') return value;
  }
  return null;
}

/**
 * The first markdown heading (`# …`) outside a code fence — the same meaning as
 * `firstMarkdownHeading` in `packages/indexer/src/papers.ts`, clipped to our
 * length. The duplication is deliberate: `paper_title` has its own 300-character
 * contract and the indexer guards it with its own test.
 */
function firstMarkdownHeading(content: string): string | null {
  let inFence = false;
  for (const line of content.split('\n')) {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    const text = heading?.[1]?.trim();
    if (text !== undefined && text !== '') return text;
  }
  return null;
}

/** structured data is not a title: `{"status":"claimed"}` must not become a heading */
function looksStructured(line: string): boolean {
  return line.startsWith('{') || line.startsWith('[');
}

/**
 * Keys a JSON body may carry a human label under, most specific first. A kind
 * 10030 idea-status event is `{…,"note":"claim confirmed by the agent"}` — the
 * sentence is in there, it is only wrapped in braces.
 */
export const STRUCTURED_TITLE_KEYS = ['title', 'name', 'note', 'status'] as const;

/**
 * Pull a human string out of a structured body. `JSON.parse` first: it is the
 * only thing that turns `\"`, `\n` and `\uXXXX` back into text. The regular
 * expression is the fallback for a body the gateway cut off at its
 * 400-character head — that cannot parse and the label is still in it. The
 * first key that holds a non-empty string wins.
 */
function titleFromStructured(line: string): string | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of STRUCTURED_TITLE_KEYS) {
        const value = record[key];
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
      }
    }
  } catch {
    /* the head of a long body — the key scan below still finds the label */
  }
  for (const key of STRUCTURED_TITLE_KEYS) {
    // the closing quote is optional at end of input: a value the gateway cut
    // off at its 400-character head has none, and it is still the label
    const match = new RegExp(`"${key}"\\s*:\\s*"([^"]{1,200})(?:"|$)`).exec(line);
    const value = match?.[1]?.trim();
    if (value !== undefined && value !== '') return value;
  }
  return null;
}

/** first non-empty line of content with the leading `#` markers removed */
function firstContentLine(content: string): string | null {
  for (const line of content.split('\n')) {
    const text = line.replace(/^#+\s*/, '').trim();
    if (text === '') continue;
    return looksStructured(text) ? titleFromStructured(text) : text;
  }
  return null;
}

/** what the title may be derived from — the fields a search row really has */
export interface EventTitleSource {
  kind: number;
  content: string;
  /**
   * Event tags — the parsed `tags_json` of an index row, or the `tags` of a
   * live event. Plain string arrays are accepted because only the first two
   * positions of a tag are ever read, which keeps `NostrEvent['tags']` and a
   * loosely typed `string[][]` (the MCP local scan) both usable here.
   */
  tags?: readonly (readonly string[])[];
}

/**
 * The title of one event, or `null` when the event has none. Never throws: an
 * index row with a missing content or malformed tags yields `null`, which the
 * caller renders as its fallback (address / id).
 */
export function eventTitle(source: EventTitleSource): string | null {
  const content = typeof source.content === 'string' ? source.content : '';
  const tags = Array.isArray(source.tags) ? source.tags : undefined;

  // 1. a topic is its slug — `d` is the identifier the whole UI navigates by
  if (source.kind === KINDS.TOPIC) {
    const slug = tagValue(tags, 'd');
    if (slug !== null) return clampTitle(slug);
  }

  // 2./3. an explicit title tag beats anything derived from the body
  for (const name of TITLE_TAG_NAMES) {
    const value = tagValue(tags, name);
    if (value !== null) return clampTitle(value);
  }

  // 4. a legacy paper without a title tag: its first markdown heading
  if (source.kind === KINDS.PUBLICATION) {
    const heading = firstMarkdownHeading(content);
    if (heading !== null) return clampTitle(heading);
  }

  // 5. the forum convention: the first line of content is the title
  const line = firstContentLine(content);
  return line === null ? null : clampTitle(line);
}
