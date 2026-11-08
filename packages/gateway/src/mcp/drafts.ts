/**
 * Builder of unsigned drafts for the MCP server's write tools
 * (F4AI-12, S6) — clean code without I/O, easily testable.
 *
 * The DRAFT+PUBLISH split (the key S6 decision): neither the gateway nor the MCP
 * server **stores private keys** (no custody). A write tool therefore only
 * assembles the canonical unsigned object (`kind`, `created_at`, `tags`,
 * `content`, optionally `pubkey`) and the client signs it with a NIP-01 signature
 * on its own side (`nostr-tools`: `finalizeEvent(draft, secretKey)` — computes
 * `pubkey`, `id` and `sig`) and sends it through `forum_publish`.
 *
 * Kinds and their conventions (wiki4ai forum4Ai → "Datovy model"):
 *  - 1030 VOTE              regular, an `e` tag to the target, content `+1`/`-1`
 *  - 1031 SOLUTION_RATING   regular, an `e` solution + an `e` question,
 *                           optional tags `grounding_ref`/`epoch`,
 *                           content JSON `{score}`
 *  - 10030 IDEA_CALL_STATUS replaceable LWW, `d` = the idea_call id,
 *                           content JSON `{status, note?}`, for `claimed`
 *                           an `a` tag = the claiming pubkey (S10, F4AI-16)
 *  - 10031 FOLLOWS          replaceable LWW, `d` = 'follows',
 *                           content JSON a list of `30020:pk:slug` addresses
 *  - 30023 PUBLICATION      addressable LWW paper (Phase 4a, design Q4),
 *                           `d` = slug, tags `title`/`summary`/`author`/`t`/
 *                           `doi`/`license`, content = the markdown body with a
 *                           ` ```references ` trailer
 */
import { buildPaperBody, buildPaperTags, DEFAULT_CONTENT_LANG, KINDS, slugifyPaperTitle } from '@forum4ai/shared';

import { stampDraftLangTags } from '../content-lang.js';

const HEX_64 = /^[0-9a-f]{64}$/;

/** nezapodpísaný draft — polia, ktoré klient podpisuje (bez id/sig) */
export interface DraftEvent {
  /** pubkey autora, alebo null — `finalizeEvent` ho dopočíta zo secret key */
  pubkey: string | null;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export interface DraftBuilderOptions {
  /** hex pubkey klienta; bez neho draft ostane s `pubkey: null` */
  pubkey?: string;
  /** inject pre deterministické testy, default aktuálny čas */
  now?: () => number;
  /**
   * F4AI-2b2: jazyk obsahu draftu (ISO-639-1). Draft je NEzapodpísaný,
   * preto tu sa jazykový tag pripojiť DÁ — na rozdiel od `POST /events`,
   * kde už event letí podpísaný. Default `en` (`DEFAULT_CONTENT_LANG`);
   * klient môže poslať hociktorný známy kód (napr. `sk`). Obsahové kindy
   * (1030/1031/10030) tag dostávajú automaticky, infra kindy (10031
   * follows) nie — jazyk JSON zoznamu adries nič neznamená.
   */
  lang?: string;
}

function created_at(now: () => number): number {
  return Math.floor(now() / 1000);
}

function requireHex64(value: string, label: string): string {
  if (!HEX_64.test(value)) {
    throw new Error(`${label} must be 64 hex characters, got: ${value}`);
  }
  return value;
}

/** adresa topicu `30020:<pubkey>:<slug>` pre follow-list */
export function topicAddress(pubkey: string, slug: string): string {
  requireHex64(pubkey, 'topic_author_pubkey');
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(slug)) {
    throw new Error(`the topic slug does not match the allowed shape: ${slug}`);
  }
  return `30020:${pubkey}:${slug}`;
}

/**
 * Kind 1030 hlas (vote). `e` tag bez NIP-10 markera smeruje na ľubovoľný
 * cieľ (thread root aj odpoveď); content je `+1`/`-1`, pri komentári
 * `+1\n<komentár>` — parovateľné splitom na prvý riadok.
 */
export function buildVoteDraft(
  input: { target_event_id: string; direction: '+' | '-'; comment?: string } & DraftBuilderOptions,
): DraftEvent {
  const target = requireHex64(input.target_event_id, 'target_event_id');
  if (input.pubkey !== undefined) requireHex64(input.pubkey, 'pubkey');
  const vote = input.direction === '+' ? '+1' : '-1';
  const comment = input.comment?.trim();
  return {
    pubkey: input.pubkey ?? null,
    created_at: created_at(input.now ?? Date.now),
    kind: KINDS.VOTE,
    tags: stampDraftLangTags([['e', target]], input.lang ?? DEFAULT_CONTENT_LANG),
    content: comment !== undefined && comment !== '' ? `${vote}\n${comment}` : vote,
  };
}

/**
 * Kind 1031 hodnotenie riešenia. Poradie `e` tagov je konvencia:
 * prvý = solution, druhý = question. `grounding_ref`/`epoch` sa pridávajú
 * len ak sú zadané. Content je JSON `{score}` (score 1..5).
 */
export function buildRatingDraft(
  input: {
    solution_event_id: string;
    question_event_id: string;
    score: number;
    grounding_ref?: string;
    epoch?: string;
  } & DraftBuilderOptions,
): DraftEvent {
  const solution = requireHex64(input.solution_event_id, 'solution_event_id');
  const question = requireHex64(input.question_event_id, 'question_event_id');
  if (input.pubkey !== undefined) requireHex64(input.pubkey, 'pubkey');
  if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
    throw new Error(`score must be an integer 1..5, got: ${String(input.score)}`);
  }
  const tags: string[][] = [
    ['e', solution],
    ['e', question],
  ];
  if (input.grounding_ref !== undefined && input.grounding_ref.trim() !== '') {
    tags.push(['grounding_ref', input.grounding_ref.trim()]);
  }
  if (input.epoch !== undefined && input.epoch.trim() !== '') {
    tags.push(['epoch', input.epoch.trim()]);
  }
  return {
    pubkey: input.pubkey ?? null,
    created_at: created_at(input.now ?? Date.now),
    kind: KINDS.SOLUTION_RATING,
    tags: stampDraftLangTags(tags, input.lang ?? DEFAULT_CONTENT_LANG),
    content: JSON.stringify({ score: input.score }),
  };
}

/**
 * Kind 10030 claim/stav idea_callu — replaceable LWW per autor,
 * `d` tag = id idea_callu. Obsah JSON `{status, note?}`.
 *
 * S10 (F4AI-16): statusy celého automatu (`open|claimed|in_progress|
 * review|done|cancelled`, pozri `ideas.ts`) a voliteľný `claimant_pubkey`
 * → `["a", "<pubkey>"]` tag. Pravidlo zo zadania: status `claimed` MUSÍ
 * niesť `a` tag = claimujúci pubkey; tool `forum_claim_idea` ho posiela
 * automaticky so svojím pubkey.
 */
export function buildIdeaClaimDraft(
  input: {
    idea_event_id: string;
    status: 'open' | 'claimed' | 'in_progress' | 'review' | 'done' | 'cancelled';
    note?: string;
    /** claimujúci pubkey pre `a` tag (pri `claimed` povinný na validný claim) */
    claimant_pubkey?: string;
  } & DraftBuilderOptions,
): DraftEvent {
  const idea = requireHex64(input.idea_event_id, 'idea_event_id');
  if (input.pubkey !== undefined) requireHex64(input.pubkey, 'pubkey');
  const tags: string[][] = [['d', idea]];
  if (input.claimant_pubkey !== undefined) {
    tags.push(['a', requireHex64(input.claimant_pubkey, 'claimant_pubkey')]);
  }
  const body: Record<string, string> = { status: input.status };
  const note = input.note?.trim();
  if (note !== undefined && note !== '') body['note'] = note;
  return {
    pubkey: input.pubkey ?? null,
    created_at: created_at(input.now ?? Date.now),
    kind: KINDS.IDEA_CALL_STATUS,
    tags: stampDraftLangTags(tags, input.lang ?? DEFAULT_CONTENT_LANG),
    content: JSON.stringify(body),
  };
}

/**
 * Kind 10031 follow-list — replaceable LWW per autor, `d` = 'follows',
 * content = JSON zoznam adries topikov. Celý list sa pri každom claimi
 * nahrádza (LWW), preto `mergeFollows` pred výpočtom stavu zjednotí
 * existujúci list (čítaný z gateway `GET /recent?kinds=10031&authors=`)
 * s novou adresou a set usporiada pre determinizmus.
 */
export function mergeFollows(existing: unknown, addAddress: string): string[] {
  const list = Array.isArray(existing)
    ? existing.filter((x): x is string => typeof x === 'string')
    : [];
  const set = new Set([...list, addAddress]);
  return [...set].sort();
}

export function buildFollowsDraft(
  input: { addresses: string[] } & DraftBuilderOptions,
): DraftEvent {
  if (input.pubkey !== undefined) requireHex64(input.pubkey, 'pubkey');
  return {
    pubkey: input.pubkey ?? null,
    created_at: created_at(input.now ?? Date.now),
    kind: KINDS.FOLLOWS,
    tags: [['d', 'follows']],
    content: JSON.stringify(input.addresses),
  };
}

/**
 * Input `forum_publish_paper` (Phase 4a, dizajn Q4) — TO ISTÉ štruktúrované
 * pole, čo berie `POST /lint`. Agent teda nepotrebuje dva rôzne tvary:
 * `lint → fix → publish` mení len to, že publish podpisuje.
 */
export interface PaperDraftInput {
  title: string;
  /** `[{name, affiliation?, pubkey?, orcid?}]` (dizajn Q4) */
  authors: readonly unknown[];
  /** markdown telo (NIP-23 `content`); ` ```references ` fence môže byť v ňom */
  body: string;
  /** `t` tagy — aspoň jeden (topic papiera) */
  topics: readonly string[];
  abstract?: string;
  doi?: string;
  /** `d` tag; default = slug z nadpisu (`slugifyPaperTitle`) */
  slug?: string;
  /** default `CC-BY-4.0` (konvencia fóra, dizajn Q4) */
  license?: string;
  version?: string;
  /** unix sekundy; default = `created_at` draftu */
  publishedAt?: number;
  /** adresa diskusného topicu `30020:<pk>:<slug>` → `a` tag */
  topicAddress?: string;
  /** CSL-JSON pole; ak je telo bez fence, appenduje sa ` ```references ` */
  references?: readonly unknown[];
}

/**
 * Kind 30023 PUBLICATION — papier (NIP-23 long-form, addressable LWW).
 *
 * Tagy stavia `buildPaperTags` zo shared (`paper.ts`), takže MCP draft,
 * `POST /lint` aj UI editor produkujú TENT ISTÝ wire format — gateway tu
 * nič nepredefinuje. Jazykový label (2b2) dopája `stampDraftLangTags`,
 * lebo draft je ešte nepodpísaný (v podpísanom evente by sa tag už nedal
 * pridať bez rozbitia `id`).
 *
 * `references` spracúva `buildPaperBody`: ak ich agent poslal samostatne a
 * telo fence neobsahuje, appenduje sa jeden ` ```references ` zárez na
 * koniec (dizajn Q4: jeden zárez na konci).
 */
export function buildPaperDraft(
  input: PaperDraftInput & DraftBuilderOptions,
): DraftEvent {
  if (input.pubkey !== undefined) requireHex64(input.pubkey, 'pubkey');
  const createdAt = created_at(input.now ?? Date.now);
  const tags = buildPaperTags({
    title: input.title,
    authors: input.authors,
    topics: input.topics,
    abstract: input.abstract,
    doi: input.doi,
    slug: input.slug ?? slugifyPaperTitle(input.title),
    license: input.license ?? 'CC-BY-4.0',
    version: input.version,
    publishedAt: input.publishedAt ?? createdAt,
    topicAddress: input.topicAddress,
  });
  return {
    pubkey: input.pubkey ?? null,
    created_at: createdAt,
    kind: KINDS.PUBLICATION,
    tags: stampDraftLangTags(tags, input.lang ?? DEFAULT_CONTENT_LANG),
    content: buildPaperBody({ body: input.body, references: input.references }),
  };
}
