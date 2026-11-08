/**
 * idea_call lifecycle — PURE functions (F4AI-16, S10), no network/IO.
 *
 * Data (wiki4ai forum4Ai → "Datovy model a synchronizacia", ch. 3.2):
 *  - kind **1021** `thread_root_idea_call` — regular, immutable idea root;
 *    `title` is taken from the first line of `content` or from an optional
 *    `["title", …]` tag (NIP-23 convention), topics from the `t` tags.
 *  - kind **10030** `idea_call_status` — replaceable LWW per author,
 *    `d` tag = **the idea_call id** (1021), content JSON
 *    `{"status": …, "note"?: …, "by"?: <claimant-pubkey>}`; the claiming
 *    pubkey is bound with an `["a", "<pubkey>"]` tag.
 *
 * ── MANAGER DECISION (S10) — canonical status ──────────────────────────────
 * The address of a replaceable 10030 is `kind:pubkey:d`, where `pubkey` is the
 * pubkey of the **PUBLISHER** and `d` is the idea_call id — different pubkeys can
 * therefore have different 10030 for the same idea and they do not replace each
 * other (each author has their own LWW line). The canonical status is therefore
 * only the one published by the **author of the 1021** (pubkey == author idea):
 * they own the idea and are the only authority on its state. 10030 from other
 * pubkeys are **suggestions** — the board counts them in `suggestions_count`
 * and the detail lists them in `suggestions`, but they are NOT the status. The
 * consequence for the claim flow: an agent taking someone else's idea publishes
 * its own 10030 `claimed` (a suggestion) and the author of the 1021 publishes
 * the canonical `claimed` with an `a` tag pointing at that agent.
 *
 * ── State machine (manager decision S10, binding for the implementation) ──
 *   open → claimed → in_progress → review → done
 *   claimed → open                    (releasing a claim)
 *   open|claimed|in_progress|review → cancelled   (from any state except
 *                                                  the final ones)
 *   done, cancelled = FINAL states — no further transition.
 * Wiki note: the sketch in "Datovy model" (ch. 3.2) had
 * `open → claimed → in_progress → delivered → awarded/declined`; the S10
 * manager decision replaces it with the machine above (review/done/
 * cancelled). Reputation/bounty kinds 1034/1035 (`bounty_lock`/
 * `bounty_award`) will build on `done` only in S11+.
 *
 * Determinism (invariant of the whole module):
 *  - ordering of history lists: `created_at ASC, id ASC`;
 *  - LWW winner choice per publisher: highest `(created_at, id)`
 *    (the lexicographically lower id wins on an equal timestamp —
 *    consistent with the indexer/read-model LWW rule);
 *  - board rows: `created_at DESC, id ASC` (newest idea_calls on top,
 *    total order even at the same time).
 */
import { KINDS } from '@forum4ai/shared';
import type { NostrEvent, NostrTag } from '@forum4ai/shared';

import {
  aggregateThreadRating,
  signalRootRef,
  signalTarget,
  type ReputationParams,
  type ThreadRatingBody,
} from './reputation.js';

export const IDEAS_PHASE = 'S10';

// ── statusy a automat ──────────────────────────────────────────────────────

export const IDEA_STATUSES = [
  'open',
  'claimed',
  'in_progress',
  'review',
  'done',
  'cancelled',
] as const;

export type IdeaStatus = (typeof IDEA_STATUSES)[number];

/** stavy, z ktorých sa už nedá nikam ísť */
export const FINAL_IDEA_STATUSES: ReadonlySet<IdeaStatus> = new Set<IdeaStatus>([
  'done',
  'cancelled',
]);

/** susedstvo automatu: from → povolené `to` (ostatné = zakázané) */
const TRANSITIONS: Record<IdeaStatus, readonly IdeaStatus[]> = {
  open: ['claimed', 'cancelled'],
  claimed: ['in_progress', 'open', 'cancelled'],
  in_progress: ['review', 'cancelled'],
  review: ['done', 'cancelled'],
  done: [],
  cancelled: [],
};

export function isIdeaStatus(value: unknown): value is IdeaStatus {
  return typeof value === 'string' && (IDEA_STATUSES as readonly string[]).includes(value);
}

export interface TransitionCheck {
  ok: boolean;
  /** dôvod zamietnutia; null pri úspechu */
  reason: string | null;
}

function okTransition(): TransitionCheck {
  return { ok: true, reason: null };
}

function rejectTransition(reason: string): TransitionCheck {
  return { ok: false, reason };
}

/**
 * Legálnosť prechodu `from → to` podľa automatu vyššie. Neplatný status
 * (hoc aj neznámy reťazec) → dôvod. Samoprechod (from === to) nie je
 * hran automatu — LWW obnova rovnakého statusu sa automatom neriadi.
 */
export function canTransition(from: string, to: string): TransitionCheck {
  if (!isIdeaStatus(from)) {
    return rejectTransition(`unknown initial status '${String(from)}'`);
  }
  if (!isIdeaStatus(to)) {
    return rejectTransition(`unknown target status '${String(to)}'`);
  }
  if (FINAL_IDEA_STATUSES.has(from)) {
    return rejectTransition(`'${from}' is a final state — no further transition is allowed`);
  }
  if (from === to) {
    return rejectTransition(`'${from}' → '${to}' is not a transition (same state, the automaton has no self-transition)`);
  }
  if (TRANSITIONS[from].includes(to)) return okTransition();
  return rejectTransition(
    `the transition '${from}' → '${to}' is not in the automaton; legal transitions from '${from}': ${TRANSITIONS[from].join(', ')}`,
  );
}

// ── parsovanie 1021 / 10030 ────────────────────────────────────────────────

const HEX_64 = /^[0-9a-f]{64}$/;

function firstTagValue(tags: readonly NostrTag[], name: string): string | null {
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === 'string' && tag[1] !== '') return tag[1];
  }
  return null;
}

/** všetky `t` tagy (topicie): trim, neprazdne, dedup s zachovanim poradia */
function topicTags(tags: readonly NostrTag[]): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const tag of tags) {
    if (tag[0] !== 't') continue;
    const value = typeof tag[1] === 'string' ? tag[1].trim() : '';
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    topics.push(value);
  }
  return topics;
}

export interface ParsedIdeaCall {
  id: string;
  title: string;
  description: string;
  topics: string[];
  /** pubkey autora 1021 — autorita kanonického statusu */
  author: string;
  created_at: number;
}

/** fallback title, keď content je prázdny a `title` tag chýba */
export const UNTITLED_IDEA = '(untitled)';

/**
 * Parse kindu 1021 na pohľad na idea_call. Iný kind → null.
 * Title: `["title", …]` tag má prednosť (NIP-23 konvencia), inak prvý
 * riadok `content`; description: zvyšok contentu za prvým riadkom
 * (pri `title` tagu celý content). Topicie: `t` tagy.
 */
export function parseIdeaCall(event: NostrEvent): ParsedIdeaCall | null {
  if (event.kind !== KINDS.IDEA_CALL) return null;

  const lines = event.content.split(/\r?\n/);
  const firstLine = (lines[0] ?? '').trim();
  const titleTag = firstTagValue(event.tags, 'title');
  const title = titleTag ?? (firstLine !== '' ? firstLine : UNTITLED_IDEA);
  const description =
    titleTag !== null ? event.content.trim() : lines.slice(1).join('\n').trim();

  return {
    id: event.id,
    title,
    description,
    topics: topicTags(event.tags),
    author: event.pubkey,
    created_at: event.created_at,
  };
}

export interface ParsedIdeaStatus {
  /** id 10030 eventu */
  id: string;
  /** pubkey PUBLIKUJÚCEHO 10030 (nie nutne autor idea) */
  publisher: string;
  /** id idea_callu z `d` tagu (povinné, 64-hex) */
  idea_id: string;
  status: IdeaStatus;
  /** claimujúci pubkey z `a` tagu (fallback `by` v JSON contente); inak null */
  claimant: string | null;
  note: string | null;
  /** `epoch` tag (reputačná väzba), null bez neho */
  epoch: string | null;
  created_at: number;
}

/**
 * Parse kindu 10030. null = event nie je čitateľný status: iný kind,
 * chýbajúci/nezrelý `d` tag (nie 64-hex), ne-JSON content, neznámy
 * status. Takéto eventy sa pri zostavovaní boardu IGNORUJU — nemôžu
 * prerušiť kanonický stav myšlienky poškodeným zápisom.
 */
export function parseIdeaStatus(event: NostrEvent): ParsedIdeaStatus | null {
  if (event.kind !== KINDS.IDEA_CALL_STATUS) return null;

  const ideaId = firstTagValue(event.tags, 'd');
  if (ideaId === null || !HEX_64.test(ideaId)) return null;

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const rawStatus = body['status'];
  if (!isIdeaStatus(rawStatus)) return null;

  // claimant: `a` tag s 64-hex pubkey (adresa `kind:pk:d` sem nepatrí);
  // fallback: JSON pole `by` (skica v "Datovy model" kap. 11)
  let claimant: string | null = null;
  for (const tag of event.tags) {
    if (tag[0] !== 'a') continue;
    const value = typeof tag[1] === 'string' ? tag[1] : '';
    if (HEX_64.test(value)) {
      claimant = value;
      break;
    }
  }
  if (claimant === null && typeof body['by'] === 'string' && HEX_64.test(body['by'])) {
    claimant = body['by'];
  }

  const note = typeof body['note'] === 'string' && body['note'].trim() !== '' ? body['note'].trim() : null;

  let epoch: string | null = firstTagValue(event.tags, 'epoch');
  if (epoch === null && (typeof body['epoch'] === 'string' || typeof body['epoch'] === 'number')) {
    epoch = String(body['epoch']);
  }

  return {
    id: event.id,
    publisher: event.pubkey,
    idea_id: ideaId,
    status: rawStatus,
    claimant,
    note,
    epoch,
    created_at: event.created_at,
  };
}

/**
 * Validácia claimu: status `claimed` MUSÍ niesť `a` tag = claimujúci
 * 64-hex pubkey (bez neho nie je jasné, kto si myšlienku vzal — claim
 * je neúplný). Iné statusy `a` tag nevyžadujú.
 */
export function validateClaim(parsed: ParsedIdeaStatus): TransitionCheck {
  if (parsed.status !== 'claimed') return okTransition();
  if (parsed.claimant === null) {
    return rejectTransition(
      "status 'claimed' requires an a tag with the 64-hex pubkey of the claimant (whoever takes the idea)",
    );
  }
  return okTransition();
}

// ── LWW a kanonický status ─────────────────────────────────────────────────

/**
 * Total order per publikujúci: víťaz = najvyšší `created_at`, pri rovnosti
 * LEXIKOGRAFICKY NIŽŠIE id (zhoda s LWW guardom indexera a read-model).
 */
function lwwWins(a: ParsedIdeaStatus, b: ParsedIdeaStatus): boolean {
  if (a.created_at !== b.created_at) return a.created_at > b.created_at;
  return a.id < b.id;
}

/** LWW zhluk per publikujúci: mapa publisher → víťazný 10030. */
export function latestStatusPerPublisher(
  statuses: readonly ParsedIdeaStatus[],
): Map<string, ParsedIdeaStatus> {
  const winners = new Map<string, ParsedIdeaStatus>();
  for (const status of statuses) {
    const current = winners.get(status.publisher);
    if (current === undefined || lwwWins(status, current)) winners.set(status.publisher, status);
  }
  return winners;
}

/**
 * A10: kanonický status autora NIE je surový LWW winner. História
 * autorových 10030 sa PREHRÁ chronologicky cez automat (`canTransition` +
 * `validateClaim`): nelegálny skok v dostupnej histórii (napr.
 * `done → open`) sa preskočí a status zostáva na poslednom legálnom
 * mieste; `claimed` bez `a` tagu (neúplný claim) sa nezapočíta vôbec.
 * Samoprechod (rovnaký status) je povolený — LWW obnova rovnakého statusu
 * sa automatom neriadi (dokumentované v `canTransition`).
 *
 * PRVÝ event histórie sa akceptuje bez viazania na `open`: 10030 je
 * replaceable (adresa `10030:autor:idea`) a relay aj indexer uchovávajú
 * len POSLEDNÝ stav autora per myšlienka — medzistavy boli nahradené,
 * nie zmazané chybou. Autor je pre svoju líniu autorita; overujeme
 * validitu statusu (už v `parseIdeaStatus`) a úplnosť claimu. Finálne
 * stavy (`done`/`cancelled`) pinujú ďalšie prechody (`canTransition` z
 * finálneho stavu odmietne hocico).
 *
 * Prázdna história / žiadny legálny vstup → null (board zobrazí 'open').
 */
export function replayCanonicalStatus(
  authorStatuses: readonly ParsedIdeaStatus[],
): ParsedIdeaStatus | null {
  let current: ParsedIdeaStatus | null = null;
  for (const status of sortStatusesChronologically(authorStatuses)) {
    if (!validateClaim(status).ok) continue; // neúplný claim = žiadny dôkaz
    if (current === null) {
      current = status; // prvý event: autorita autora (replaceable prunning)
      continue;
    }
    if (status.status === current.status) {
      current = status; // LWW obnova rovnakého statusu
      continue;
    }
    if (!canTransition(current.status, status.status).ok) continue;
    current = status;
  }
  return current;
}

/** chronologické triedenie (created_at ASC, id ASC) — mutuje kopiu */
export function sortStatusesChronologically(
  statuses: readonly ParsedIdeaStatus[],
): ParsedIdeaStatus[] {
  return [...statuses].sort((a, b) =>
    a.created_at !== b.created_at
      ? a.created_at - b.created_at
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0,
  );
}

// ── zostavenie boardu / detailu ────────────────────────────────────────────

export interface IdeaStatusEntry {
  id: string;
  publisher: string;
  status: IdeaStatus;
  claimant: string | null;
  note: string | null;
  epoch: string | null;
  created_at: number;
}

export interface IdeaRow {
  id: string;
  title: string;
  description: string;
  topics: string[];
  author: string;
  created_at: number;
  /** kanonický status (10030 autora), alebo 'open' keď autor nič nepublikoval */
  status: IdeaStatus;
  /** claimant kanonického statusu (pre `claimed` povinný; inak null) */
  claimant: string | null;
  /** všetky čitateľné 10030 AUTORA (v DB ich drží LWW), created_at ASC */
  status_history: IdeaStatusEntry[];
  /** počet LWW víťazov 10030 od iných pubkey ako autor */
  suggestions_count: number;
  /** rating agregát 1031/1032 viazaný na id idea (null = bez ratingových dát) */
  rating: ThreadRatingBody | null;
}

export interface IdeaDetail extends IdeaRow {
  /** LWW víťazi 10030 od iných pubkey (chronologicky) — NIE kanonický status */
  suggestions: IdeaStatusEntry[];
}

function toEntry(parsed: ParsedIdeaStatus): IdeaStatusEntry {
  return {
    id: parsed.id,
    publisher: parsed.publisher,
    status: parsed.status,
    claimant: parsed.claimant,
    note: parsed.note,
    epoch: parsed.epoch,
    created_at: parsed.created_at,
  };
}

interface IdeaView {
  row: IdeaRow;
  suggestions: IdeaStatusEntry[];
}

/**
 * Pohľad na jednu myšlienku zo všetkých jej čitateľných 10030. `ratings`
 * a `accepted` sú voliteľné ratingové podklady (agregát pomocou
 * `aggregateThreadRating` z S9 — 1031/1032 viazané na id idea).
 */
function buildIdeaView(
  idea: ParsedIdeaCall,
  statuses: readonly ParsedIdeaStatus[],
  ratings: readonly NostrEvent[] | undefined,
  accepted: readonly NostrEvent[] | undefined,
  params?: ReputationParams,
): IdeaView {
  const winners = latestStatusPerPublisher(statuses);
  const suggestions = sortStatusesChronologically(
    [...winners.values()].filter((status) => status.publisher !== idea.author),
  );
  // A10: kanonický status = replay histórie autora cez automat, nie
  // surový LWW winner (ten by vedel napr. `done` z nelegálneho skoku)
  const canonical = replayCanonicalStatus(
    statuses.filter((status) => status.publisher === idea.author),
  );

  const row: IdeaRow = {
    id: idea.id,
    title: idea.title,
    description: idea.description,
    topics: idea.topics,
    author: idea.author,
    created_at: idea.created_at,
    // ROZHODNUTIE MANAŽERA: kanonický = len 10030 autora; bez neho 'open'
    status: canonical?.status ?? 'open',
    claimant: canonical?.claimant ?? null,
    status_history: sortStatusesChronologically(
      statuses.filter((status) => status.publisher === idea.author),
    ).map(toEntry),
    suggestions_count: suggestions.length,
    rating:
      ratings !== undefined && accepted !== undefined
        ? aggregateThreadRating(idea.id, ratings, accepted, params)
        : null,
  };
  return { row, suggestions };
}

/**
 * Zostaví board: jeden row na každý čitateľný 1021. Statusy bez
 * zodpovedajúceho 1021 (suggestions pre zmazanú/cudzí root) sa
 * ignorujú. Triedenie `created_at DESC, id ASC` (total order).
 */
export function assembleIdeaBoard(input: {
  ideas: readonly NostrEvent[];
  statuses: readonly NostrEvent[];
  /** ratingové podklady pre agregát (1031) — bez nich `rating: null` */
  ratings?: readonly NostrEvent[];
  /** akcepty (1032) pre `accepted` flag agregátu */
  accepted?: readonly NostrEvent[];
  params?: ReputationParams;
}): IdeaRow[] {
  const parsedStatuses = input.statuses
    .map((event) => parseIdeaStatus(event))
    .filter((status): status is ParsedIdeaStatus => status !== null);

  // ratingy/akcepty roztriedime raz do nádrží podľa referencií (e tagy,
  // cieľ, root) — aggregateThreadRating aj tak referencie overuje znova
  const ratingByRef = new Map<string, NostrEvent[]>();
  if (input.ratings !== undefined) {
    for (const event of input.ratings) {
      for (const ref of eventRefs(event)) pushBucket(ratingByRef, ref, event);
    }
  }
  const acceptedByRef = new Map<string, NostrEvent[]>();
  if (input.accepted !== undefined) {
    for (const event of input.accepted) {
      for (const ref of eventRefs(event)) pushBucket(acceptedByRef, ref, event);
    }
  }

  const rows: IdeaRow[] = [];
  const seen = new Set<string>();
  for (const raw of input.ideas) {
    const idea = parseIdeaCall(raw);
    if (idea === null || seen.has(idea.id)) continue;
    seen.add(idea.id);
    const forIdea = parsedStatuses.filter((status) => status.idea_id === idea.id);
    const { row } = buildIdeaView(
      idea,
      forIdea,
      input.ratings !== undefined ? (ratingByRef.get(idea.id) ?? []) : undefined,
      input.accepted !== undefined ? (acceptedByRef.get(idea.id) ?? []) : undefined,
      input.params,
    );
    rows.push(row);
  }
  rows.sort((a, b) =>
    a.created_at !== b.created_at
      ? b.created_at - a.created_at
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0,
  );
  return rows;
}

/** detail jednej myšlienky (vrátane `suggestions` pola) */
export function assembleIdeaDetail(
  ideaEvent: NostrEvent,
  statuses: readonly NostrEvent[],
  ratings?: readonly NostrEvent[],
  accepted?: readonly NostrEvent[],
  params?: ReputationParams,
): IdeaDetail | null {
  const idea = parseIdeaCall(ideaEvent);
  if (idea === null) return null;
  const forIdea = statuses
    .map((event) => parseIdeaStatus(event))
    .filter((status): status is ParsedIdeaStatus => status !== null && status.idea_id === idea.id);
  const ratingEvents =
    ratings !== undefined
      ? ratings.filter((event) => eventRefs(event).includes(idea.id))
      : undefined;
  const acceptedEvents =
    accepted !== undefined
      ? accepted.filter((event) => eventRefs(event).includes(idea.id))
      : undefined;
  const { row, suggestions } = buildIdeaView(idea, forIdea, ratingEvents, acceptedEvents, params);
  return { ...row, suggestions };
}

/** všetky id-referencie eventu (e tagy + cieľ + root) — pre roztriedenie ratingov */
function eventRefs(event: NostrEvent): string[] {
  const refs = new Set<string>();
  const target = signalTarget(event.tags);
  if (target !== null) refs.add(target);
  const root = signalRootRef(event.tags);
  if (root !== null) refs.add(root);
  for (const tag of event.tags) {
    if (tag[0] === 'e' && typeof tag[1] === 'string' && tag[1] !== '') refs.add(tag[1]);
  }
  return [...refs];
}

function pushBucket(map: Map<string, NostrEvent[]>, key: string, event: NostrEvent): void {
  const bucket = map.get(key);
  if (bucket !== undefined) bucket.push(event);
  else map.set(key, [event]);
}

// ── filtre boardu (čisté, testované) ───────────────────────────────────────

export interface IdeaBoardFilters {
  status?: IdeaStatus;
  topic?: string;
  /** len idea_cally s `created_at >= since` (unix sekundy) */
  since?: number;
  /** B2: len idea_cally jedného autora (64-hex pubkey, case-insensitive) */
  author?: string;
}

/**
 * Aplikuje filtre na rows. Topic je presné (prázdne pole neignorujeme)
 * porovnanie NEcitlivé na veľkosť písmen — `t` tagy pisujú rôzni autori
 * rôzne. `status=open` tak chytí aj myšlienky bez 10030 (implicitný
 * otvorený stav).
 */
export function filterIdeaRows(rows: readonly IdeaRow[], filters: IdeaBoardFilters): IdeaRow[] {
  return rows.filter((row) => {
    if (filters.status !== undefined && row.status !== filters.status) return false;
    if (filters.since !== undefined && row.created_at < filters.since) return false;
    if (filters.author !== undefined && row.author !== filters.author.toLowerCase()) return false;
    if (filters.topic !== undefined) {
      const needle = filters.topic.toLowerCase();
      if (!row.topics.some((topic) => topic.toLowerCase() === needle)) return false;
    }
    return true;
  });
}
