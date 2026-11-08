/**
 * Helpery pre idea_call board a detail (F4AI-19, S13) — ČISTé funkcie,
 * žiadny React, žiadna sieť (testované v `test/ideas-lib.test.ts`).
 *
 * ── KÓPIA automatu z gateway ─────────────────────────────────────────────
 * Pravidlá prechodov sú KÓPIOU `canTransition` + `TRANSITIONS` z
 * `packages/gateway/src/ideas.ts` (rozhodnutie manažéra S10):
 *
 *   open → claimed → in_progress → review → done
 *   claimed → open                    (uvolenie claimu)
 *   open|claimed|in_progress|review → cancelled
 *   done, cancelled = FINÁLNE stavy — žiadny ďalší prechod.
 *
 * UI potrebuje tú istú logiku client-side, aby vedelo ZOBRAZIŤ disabled
 * tlačidlo Claim skôr, než pošle nelegálny 10030 (gateway by ho prijal —
 * LWW per publikujúci — ale kanonický status by zostal zmätený). Pri
 * zmene automatu v gateway sa mení aj táto kópia; testy prechodového
 * stola držia obe strany (gateway `ideas.test.ts`, UI `ideas-lib.test.ts`).
 *
 * ── ROZHODNUTIE S13: single status + 'všetky' ────────────────────────────
 * Status filter je JEDEN status alebo 'všetky' (nie viacnásobný). Dôvod:
 * `GET /ideas` (ideas-routes.ts `parseBoardParams`) akceptuje presne jeden
 * `status` parameter — viacnásobný výber by vyžadoval N paralelných
 * requestov alebo client-side zjednotenie N strán, čo je pri F1 objeme
 * dát zbytočná zložitosť. URL `?status=<status>` je preto priamočiara
 * mapa na gateway parameter a zdieľateľný odkaz.
 *
 * ── ROZHODNUTIE S13 (F1 heuristic): author kind filter client-side ──────
 * `GET /ideas` nepodporuje server-side filter "autori = agenti/ľudia"
 * (index neuchováva 30027 agent_card index). F1 heuristika: row je
 * AGENT, ak má v `topics` (t-tagy 1021) tag `agent` — presne tento tag
 * pridáva modal "publikujem ako agent" (a agenti v S15 doplnia 30027).
 * Filter beží client-side nad stránkou resultov; produkcia/S15 ho doplní
 * server-side (join na 30027).
 */
import type { IdeaRow, IdeaStatus, ThreadRating } from '../api/types.js';
import { t } from '../i18n/text.js';
import { DEFAULT_CONTENT_LANG, langTags } from './lang.js';

/** stavový automat — zhoda s `gateway/src/ideas.ts` `IDEA_STATUSES` */
export const IDEA_STATUSES: readonly IdeaStatus[] = [
  'open',
  'claimed',
  'in_progress',
  'review',
  'done',
  'cancelled',
];

/** popisky statusov pre UI (slovenské labely pill-ov) */
export const IDEA_STATUS_LABELS: Record<IdeaStatus, string> = {
  open: 'open',
  claimed: 'claimed',
  in_progress: 'in progress',
  review: 'review',
  done: 'done',
  cancelled: 'cancelled',
};

/** finálne stavy — zhoda s `FINAL_IDEA_STATUSES` v gateway */
export const FINAL_IDEA_STATUSES: ReadonlySet<IdeaStatus> = new Set<IdeaStatus>([
  'done',
  'cancelled',
]);

/** susedstvo automatu `from → povolené to` — kópia gateway `TRANSITIONS` */
const TRANSITIONS: Record<IdeaStatus, readonly IdeaStatus[]> = {
  open: ['claimed', 'cancelled'],
  claimed: ['in_progress', 'open', 'cancelled'],
  in_progress: ['review', 'cancelled'],
  review: ['done', 'cancelled'],
  done: [],
  cancelled: [],
};

export function isIdeaStatus(value: unknown): value is IdeaStatus {
  return (
    typeof value === 'string' && (IDEA_STATUSES as readonly string[]).includes(value)
  );
}

export interface TransitionCheck {
  ok: boolean;
  /** dôvod zamietnutia; null pri úspechu (pre tooltip disabled tlačidla) */
  reason: string | null;
}

/**
 * Legálnosť prechodu `from → to` — kópia `canTransition` z gateway
 * (`packages/gateway/src/ideas.ts`). Samoprechod nie je hran (LWW
 * obnova rovnakého statusu sa automatom neriadi).
 */
export function canTransition(from: string, to: string): TransitionCheck {
  // dôvody sú text, teda v locale (`forum:ideas.transition.*`) — volajú sa
  // až pri overovaní prechodu, takže jazyk sa mení bez reloadu
  if (!isIdeaStatus(from)) return { ok: false, reason: t('forum:ideas.transition.unknownFrom', { from: String(from) }) };
  if (!isIdeaStatus(to)) return { ok: false, reason: t('forum:ideas.transition.unknownTo', { to: String(to) }) };
  if (FINAL_IDEA_STATUSES.has(from)) {
    return { ok: false, reason: t('forum:ideas.transition.final', { from }) };
  }
  if (from === to) {
    return { ok: false, reason: t('forum:ideas.transition.same', { from, to }) };
  }
  if (TRANSITIONS[from].includes(to)) return { ok: true, reason: null };
  return {
    ok: false,
    reason: t('forum:ideas.transition.notInAutomaton', {
      from,
      to,
      legal: TRANSITIONS[from].join(', ') || '—',
    }),
  };
}

// ── filtre boardu ─────────────────────────────────────────────────────────

/** filter "kto" — ľudia/agenti (F1 heuristic, client-side) */
export type AuthorKindFilter = 'all' | 'agents' | 'humans';

/** plný stav filtrov boardu (mapa na URL query — viď IdeasPage) */
export interface IdeaFilterState {
  /** jeden status alebo 'all' (rozhodnutie S13, higher) */
  status: IdeaStatus | 'all';
  /** presná hodnota `t` tagu (server-side filter, case-insensitive) */
  topic: string;
  /** author kind heuristika (client-side) */
  who: AuthorKindFilter;
  /** presný pubkey autora (client-side, odkaz z /agents/:pubkey) */
  author: string;
}

export const DEFAULT_FILTERS: IdeaFilterState = {
  status: 'all',
  topic: '',
  who: 'all',
  author: '',
};

/**
 * F1 heuristika "je to agent": row má medzi topic t-tagmi tag `agent`
 * (veľkosť písmen nezávisí). Server-side 30027 join príde až v S15.
 */
export function isAgentIdea(row: Pick<IdeaRow, 'topics'>): boolean {
  return row.topics.some((topic) => topic.trim().toLowerCase() === 'agent');
}

/**
 * Client-side dofilter po serveri (status + topic už aplikoval gateway).
 * `who` používa `isAgentIdea`, `author` presnú zhodu pubkey.
 */
export function filterIdeasClientSide(
  rows: readonly IdeaRow[],
  filters: Pick<IdeaFilterState, 'who' | 'author'>,
): IdeaRow[] {
  return rows.filter((row) => {
    if (filters.who === 'agents' && !isAgentIdea(row)) return false;
    if (filters.who === 'humans' && isAgentIdea(row)) return false;
    if (filters.author !== '' && row.author !== filters.author) return false;
    return true;
  });
}

/**
 * Parsovanie filtrov z URL query (zdieľateľné odkazy). Neznáme/bohaprázdne
 * hodnoty padajú na default — odkaz sa nikdy nerozpadne na 500.
 */
export function filtersFromParams(params: URLSearchParams): IdeaFilterState {
  const rawStatus = params.get('status') ?? '';
  const status: IdeaFilterState['status'] = isIdeaStatus(rawStatus) ? rawStatus : 'all';
  const rawWho = params.get('who') ?? 'all';
  const who: AuthorKindFilter =
    rawWho === 'agents' || rawWho === 'humans' ? rawWho : 'all';
  const rawAuthor = (params.get('author') ?? '').trim().toLowerCase();
  const author = /^[0-9a-f]{64}$/.test(rawAuthor) ? rawAuthor : '';
  return {
    status,
    topic: params.get('topic') ?? '',
    who,
    author,
  };
}

/** opačný smer: stav filtrov → URL query (prázdne defaulty vynechávame) */
export function filtersToParams(filters: IdeaFilterState): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.topic !== '') params.set('topic', filters.topic);
  if (filters.who !== 'all') params.set('who', filters.who);
  if (filters.author !== '') params.set('author', filters.author);
  return params;
}

// ── zobrazenie ────────────────────────────────────────────────────────────

/** úryvok popisu karty (s13: 3-riadkový clamp v CSS, tu striháme text) */
export function ideaExcerpt(description: string, max = 180): string {
  const text = description.trim().replace(/\s+/g, ' ');
  if (text === '') return '(bez popisu)';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Text rating badgeu `★ 4.20 (3)` — `mean15` je agregát 0..5 z
 * `reputation.ts` (1031), `count` počet hodnotení. Bez ratingových dát
 * (null / count 0) vráti null — badge sa nezobrazí.
 *
 * Shape overené curlom na live `GET /ideas` (S10 row): `rating` je
 * agregát `{ count, mean, mean15, n_eff, wilson, weightTotal, weightRaw,
 * epoch, accepted, accepted_count }` alebo null.
 */
export function ratingBadgeText(rating: ThreadRating | null): string | null {
  if (rating === null || rating.count === 0) return null;
  return `★ ${rating.mean15.toFixed(2)} (${String(rating.count)})`;
}

// ── stavové eventy (drafty) ───────────────────────────────────────────────

/**
 * Draft novej idey kind 1021. Title ide do `["title", …]` tagu (NIP-23
 * konvencia — `parseIdeaCall` v gateway uprednostňuje tag pred prvým
 * riadkom), topics do `t` tagov. `asAgent` pridá `t` tag `agent`
 * (F1 heuristika author-kind filtru).
 *
 * F4AI-2b2: draft nesie NIP-32 jazykový label (`["L","ISO-639-1"]` +
 * `["l",<kod>,"ISO-639-1"]`). UI ho pripája už TU, lebo podpis prebieha
 * až v `signeri` — po podpise sa tag pridať nedá (rozbil by `id`/`sig`).
 * Jazyk volá volajúci (jazyk rozhrania), default je `en`.
 */
export function buildNewIdeaTemplate(input: {
  title: string;
  text: string;
  topics: string[];
  asAgent: boolean;
  createdAt: number;
  lang?: string;
}): { kind: number; content: string; tags: string[][]; created_at: number } {
  const topics = input.topics
    .map((topic) => topic.trim().toLowerCase().replace(/\s+/g, '-'))
    .filter((topic) => topic !== '');
  const tags: string[][] = [['title', input.title.trim()]];
  for (const topic of topics) tags.push(['t', topic]);
  if (input.asAgent && !topics.includes('agent')) tags.push(['t', 'agent']);
  tags.push(...langTags(input.lang ?? DEFAULT_CONTENT_LANG));
  return { kind: 1021, content: input.text.trim(), tags, created_at: input.createdAt };
}

/**
 * Draft 10030 `claimed` — claim myšlienky. `d` = id idey (1021),
 * `a` = claimujúci pubkey (gateway `parseIdeaStatus` hľadá 64-hex v `a`
 * tagu, fallback `by` v JSON). Content je JSON `{status, note?}`.
 *
 * F4AI-2b2: aj tento draft nesie NIP-32 label — note je ľudský text,
 * takže jazyk má význam (index ho dokáže filtrovať).
 */
export function buildClaimTemplate(input: {
  ideaId: string;
  claimant: string;
  note?: string;
  createdAt: number;
  lang?: string;
}): { kind: number; content: string; tags: string[][]; created_at: number } {
  const body: Record<string, string> = { status: 'claimed' };
  if (input.note !== undefined && input.note.trim() !== '') body['note'] = input.note.trim();
  return {
    kind: 10030,
    content: JSON.stringify(body),
    tags: [
      ['d', input.ideaId],
      ['a', input.claimant],
      ...langTags(input.lang ?? DEFAULT_CONTENT_LANG),
    ],
    created_at: input.createdAt,
  };
}

/**
 * Návrh claimu od inej osoby (suggestion) → claimant, ktorého má autor
 * potvrdiť: LWW víťaz medzi suggestions so statusom `claimed`
 * (posledný `created_at`, pri rovnosti najnižšie id — order LWW v
 * gateway). Žiadny → null.
 */
export function latestClaimSuggestion(
  suggestions: readonly { status: string; claimant: string | null; created_at: number; id: string }[],
): string | null {
  let best: { created_at: number; id: string; claimant: string } | null = null;
  for (const s of suggestions) {
    if (s.status !== 'claimed' || s.claimant === null) continue;
    if (
      best === null ||
      s.created_at > best.created_at ||
      (s.created_at === best.created_at && s.id < best.id)
    ) {
      best = { created_at: s.created_at, id: s.id, claimant: s.claimant };
    }
  }
  return best?.claimant ?? null;
}
