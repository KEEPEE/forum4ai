/**
 * S5 read REST routes (F4AI-11) — built on `pool.query()` (EOSE/timeout
 * with deduplication by id):
 *
 *  - GET /topics          — the topic tree (30020, LWW per address)
 *  - GET /topics/:slug    — topic detail + children + the last N threads
 *  - GET /threads/:id     — root event + reply tree (NIP-10 resolution)
 *  - GET /feed?kinds=&limit= — latest root posts (1020/1021/1022)
 *  - GET /recent?kinds=&limit=&authors= — the last N events of any of the
 *      allowed kinds (F4AI-12, S6: the basis for MCP `forum_search`,
 *      because /feed knows only the feed kinds 1020–1022 and we also look for 1023)
 *
 * Verifying events coming from a relay: by default **we run shared
 * `verifyFull` for every event read** (signature + recomputed NIP-01 hash) and
 * drop the invalid ones — relays (ours with the policy and strfry) do verify
 * the signature on write, but the gateway does not blindly trust one relay;
 * optionally with `verify: false` (tests/dev) the verification is skipped and
 * we rely on the relay + pool dedup.
 *
 * Counts (`thread_count`, `topic_count`, `reply_count`) are always computed
 * from the events just fetched, not from any cache.
 */
import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { Event } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';

import { ALLOWED_KINDS, KINDS, verifyFull } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';

import { GATEWAY_PHASE } from './app.js';
import { aggregateThreadRating, type ThreadRatingBody } from './reputation.js';
import {
  applyThreadActivity,
  buildReplyTree,
  buildTopicTree,
  countThreadsByTopicAddress,
  lwwByAddress,
  resolveRootId,
  sortFeedDesc,
  topicSlug,
  type TopicNode,
} from './read-model.js';

/** TVár poolu, ktorú čítacie route potrebujú — `RelayPool` ju spĺňa. */
export interface ReadPool {
  query(filters: Filter[], opts?: { timeoutMs?: number }): Promise<Event[]>;
}

export interface ReadRouteOptions {
  pool: ReadPool;
  /** default true — shared `verifyFull` nad každým eventom z relaya */
  verify?: boolean;
  /** timeout jedného `pool.query()`, default 5000 ms */
  queryTimeoutMs?: number;
  /** default a strop pre `limit` parameter, defaulty 20 / 100 */
  defaultLimit?: number;
  maxLimit?: number;
  logger?: (line: string) => void;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const ID_RE = /^[0-9a-f]{64}$/;

/** kindy, ktoré môžu byť rootom vlákna na čítanie (S5: 1020/1021/1022/1023) */
const READABLE_ROOT_KINDS: ReadonlySet<number> = new Set<number>([
  KINDS.QUESTION,
  KINDS.IDEA_CALL,
  KINDS.COLLAB_CALL,
  KINDS.POST,
]);

/** filter pre koreňové príspevky domovskej feedu */
const FEED_KINDS: readonly number[] = [KINDS.QUESTION, KINDS.IDEA_CALL, KINDS.COLLAB_CALL];

/**
 * Default kindy `GET /recent` (F4AI-12): o 1023 navyše oproti /feed, lebo
 * MCP `forum_search` chce odpovede tiež. `kinds=` parameter tu smie niesť
 * **hociktorný** kind zo shared registry (nie len tieto), na rozdiel od
 * /feed ktoré je zámerne obmedzené na koreňové príspevky.
 */
const RECENT_DEFAULT_KINDS: readonly number[] = [
  KINDS.QUESTION,
  KINDS.IDEA_CALL,
  KINDS.COLLAB_CALL,
  KINDS.POST,
];
const RECENT_DEFAULT_LIMIT = 100;
const RECENT_MAX_LIMIT = 1000;

/**
 * A4 (P1): LRU už overených id. `GET /topics` stiahne 2 × 20 okien × 500
 * eventov a každý overí Schnorrovým podpisom; `GET /threads/:id` tie isté
 * opakuje v každom kole expanzie a pri ďalšom požiadavku znova. Podpis
 * sa meniť nemôže — stačí si pamätať, že id už prešlo.
 *
 * Uchovávame len POZITÍVA: neplatný event príde raz a znova ho overiť
 * nie je drahé, kdežto negatíva by zaplavovali cache (útočník pošle
 * 20 000 rôznych neplatných id). `Map` si pamätá poradie vkladania,
 * pri hiti id preregistrujeme — teda LRU, nie FIFO.
 */
export const VERIFIED_CACHE_MAX = 20_000;

class VerifiedIdCache {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private hits = 0;
  private misses = 0;

  constructor(private readonly max: number = VERIFIED_CACHE_MAX) {}

  get size(): number {
    return this.seen.size;
  }

  get stats(): { size: number; hits: number; misses: number } {
    return { size: this.seen.size, hits: this.hits, misses: this.misses };
  }

  has(id: string): boolean {
    if (!this.seen.has(id)) {
      this.misses += 1;
      return false;
    }
    this.hits += 1;
    // LRU: hit posunie id na koniec fronty poradia
    const at = this.order.indexOf(id);
    if (at >= 0) {
      this.order.splice(at, 1);
      this.order.push(id);
    }
    return true;
  }

  add(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.order.push(id);
    while (this.order.length > this.max) {
      const oldest = this.order.shift();
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}

/**
 * A4 (P1): expanzia odpovedí v `GET /threads/:id` chodí po `#e` frontier.
 * Bez chunkov by filter niesol tisíce id (vlákno s 5 000 odpoveďami),
 * čo je obrovský REQ — relay/strfry ho môže odmietnuť alebo ním vyzerujeme
 * rozpočet spojenia. 100 id na dopyt je kompromis: 50 kôl × 100 = 5 000
 * id, pričom jeden REQ je malý a rýchly.
 */
export const FRONTIER_CHUNK = 100;

/** rozdeľ pole po `size` kusoch (zachová poradie, prázdne pole → prázdny výstup) */
export function chunkIds<T>(items: readonly T[], size: number): T[][] {
  const chunkSize = size > 0 ? size : FRONTIER_CHUNK;
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    out.push(items.slice(i, i + chunkSize));
  }
  return out;
}

/** kánonický pohľad na event pre JSON odpovede (7 polí, bez symbolov) */
export function eventSummary(event: Event): Record<string, unknown> {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  };
}

function parseLimit(
  c: Context,
  raw: string | undefined,
  fallback: number,
  max: number,
): { value: number } | { error: string } {
  if (raw === undefined || raw.trim() === '') return { value: fallback };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    return { error: `limit must be an integer 1..${String(max)}` };
  }
  return { value };
}

export function registerReadRoutes(app: Hono, options: ReadRouteOptions): void {
  const { pool } = options;
  const verify = options.verify ?? true;
  const queryTimeoutMs = options.queryTimeoutMs ?? 5_000;
  const defaultLimit = options.defaultLimit ?? 20;
  const maxLimit = options.maxLimit ?? 100;
  const logger = options.logger ?? ((line: string) => console.log(line));

  /**
   * A4 (P1): LRU overených id — zdieľané všetkými čítacími route tohto
   * gatewaya (rovnaké eventy sa opakujú v /topics, /feed aj v expanzii
   * vlákien, a to isté pri ďalšom požiadavku).
   */
  const verified = new VerifiedIdCache();

  /** stiahne eventy a (voliteľne) zahodí tie, čo neprešli shared verifyFull */
  async function fetchVerified(filters: Filter[]): Promise<Event[]> {
    const events = await pool.query(filters, { timeoutMs: queryTimeoutMs });
    if (!verify) return events;
    // nostr-tools `Event` a shared `NostrEvent` sú štrukturálne takmer
    // totožné (líšia sa len v tuple type tags) — overujeme shared verifyFull
    return events.filter((event) => {
      if (verified.has(event.id)) return true;
      const ok = verifyFull(event as unknown as NostrEvent);
      if (ok) verified.add(event.id);
      return ok;
    });
  }

  /**
   * A12: relay (strfry `maxFilterLimit` default 500) TICHO oreže filter
   * bez `limit`u na svoj strop — bez windowingu by čítanie vrátilo
   * neuplný pohľad, ktorý vyzerá ako úplný. Toto volá dopyt po OKNÁCH
   * (`until` = min created_at predchádzajúcej okná), kým okno neprinesie
   * menej ako `cap` eventov. Ak narazíme na strop stránok, vrátime
   * `partial: true` — klient vie, že ide o skrátený pohľad.
   */
  const RELAY_PAGE_CAP = 500;
  async function fetchVerifiedWindowed(
    base: Omit<Filter, 'limit'>,
    maxPages = 20,
  ): Promise<{ events: Event[]; partial: boolean }> {
    const all: Event[] = [];
    const seen = new Set<string>();
    let until: number | undefined;
    let partial = false;
    for (let page = 0; page < maxPages; page += 1) {
      const filter = {
        ...base,
        ...(until !== undefined ? { until } : {}),
        limit: RELAY_PAGE_CAP,
      } as Filter;
      const batch = await fetchVerified([filter]);
      let fresh = 0;
      let minTs = Number.POSITIVE_INFINITY;
      for (const event of batch) {
        if (!seen.has(event.id)) {
          seen.add(event.id);
          all.push(event);
          fresh += 1;
        }
        if (event.created_at < minTs) minTs = event.created_at;
      }
      if (batch.length < RELAY_PAGE_CAP) break; // neuplná strana = koniec
      if (fresh === 0) {
        partial = true; // plná strana samých duplicítov — ďalšie okno nepomôže
        break;
      }
      until = minTs - 1;
      if (page === maxPages - 1) partial = true; // vyčerpali sme rozpočet okien
    }
    return { events: all, partial };
  }

  // ── GET /topics ─────────────────────────────────────────────────────────
  // Strom topicov zoradený podľa AKTIVITY: korene s viac nitiťami
  // (vlastnými + v descendants) vyššie, pri rovnakom počte novší
  // `created_at`. Junk testovacie topiky bez nití tak klesnú pod vycurenú
  // hierarchiu. `thread_count` je additívne pole uzla — shape ostáva
  // backward compatible (UI `api/types.ts` TopicNode).
  app.get('/topics', async (c) => {
    // dva windowované dopyty: topiky (30020) + koreňové nite
    // (1020/1021/1022) pre počty; A12 — okná cez `until`, aby sme sa
    // nedostali pod tichý strop relayu (500/filter)
    const topicRes = await fetchVerifiedWindowed({ kinds: [KINDS.TOPIC] });
    const threadRes = await fetchVerifiedWindowed({ kinds: [...FEED_KINDS] });
    const events = [...topicRes.events, ...threadRes.events];
    const topicEvents = events.filter((event) => event.kind === KINDS.TOPIC);
    const threadEvents = events.filter((event) => FEED_KINDS.includes(event.kind));
    const tree = buildTopicTree(topicEvents);
    applyThreadActivity(tree, countThreadsByTopicAddress(threadEvents));
    return c.json({
      phase: GATEWAY_PHASE,
      topic_count: tree.topic_count,
      topics: tree.roots,
      issues: tree.issues,
      // A12: additívny flag — pohľad bol skrátený stropom relayu/okien
      ...(topicRes.partial || threadRes.partial ? { partial: true } : {}),
    });
  });

  // ── GET /topics/:slug ───────────────────────────────────────────────────
  app.get('/topics/:slug', async (c) => {
    const slug = c.req.param('slug');
    if (!SLUG_RE.test(slug)) {
      return c.json({ ok: false, error: 'invalid slug', reasons: ['the slug does not match the allowed shape'] }, 400);
    }
    const limit = parseLimit(c, c.req.query('limit'), defaultLimit, maxLimit);
    if ('error' in limit) {
      return c.json({ ok: false, error: 'invalid limit', reasons: [limit.error] }, 400);
    }

    // všetky topicy: potrebujeme ich pre deti aj pre výber koreňa slugu
    // (A12: windowované čítanie — strop relayu nesmie ticho rezať hierarchiu)
    const topicFetch = await fetchVerifiedWindowed({ kinds: [KINDS.TOPIC] });
    const topicEvents = topicFetch.events;
    const lww = lwwByAddress(topicEvents);

    // A8: viac autorov môže mať rovnaký slug — koreňom je PRVÝ (najstarší)
    // created_at, teda kurátorská definícia; kto slug neskôr "ukradne"
    // vlastným 30020, ten definíciu neprepíše. Pri rovnosti created_at
    // rozhoduje lexikograficky nižšie id (deterministické).
    let target: Event | null = null;
    for (const event of lww.values()) {
      if (topicSlug(event) !== slug) continue;
      if (
        target === null ||
        event.created_at < target.created_at ||
        (event.created_at === target.created_at && event.id < target.id)
      ) {
        target = event;
      }
    }
    if (target === null) {
      return c.json({ ok: false, error: 'topic not found', slug }, 404);
    }
    const targetAddress = `30020:${target.pubkey}:${slug}`;

    const tree = buildTopicTree(topicEvents);
    const findNode = (nodes: TopicNode[]): TopicNode | null => {
      for (const node of nodes) {
        if (node.address === targetAddress) return node;
        const found = findNode(node.children);
        if (found !== null) return found;
      }
      return null;
    };

    // koreňové nite: 1020/1021/1022. Stiahneme ich bez `#a` filtra a
    // filtrovanie robíme lokálne (rovnaká semantika: `a` tag == adresa
    // topicu) — potrebujeme ich naraz pre počty aktivitu celého podstroma
    // (`applyThreadActivity` → deti zoradené rovnako ako pri /topics)
    const threadFetch = await fetchVerifiedWindowed({ kinds: [...FEED_KINDS] });
    const threadEvents = threadFetch.events;
    applyThreadActivity(tree, countThreadsByTopicAddress(threadEvents));
    const node = findNode(tree.roots);
    const sorted = sortFeedDesc(
      threadEvents.filter((event) =>
        event.tags.some((tag) => tag[0] === 'a' && tag[1] === targetAddress),
      ),
    );

    return c.json({
      topic: node ?? {
        // syntetický uzol, ak by strom uzol nenájde (cyklus/orphan → unsorted)
        slug,
        address: targetAddress,
        pubkey: target.pubkey,
        event_id: target.id,
        created_at: target.created_at,
        content: target.content,
        parent: null,
        children: [],
        thread_count: countThreadsByTopicAddress(threadEvents).get(targetAddress) ?? 0,
      },
      children: node?.children ?? [],
      threads: sorted.slice(0, limit.value).map(eventSummary),
      thread_count: sorted.length,
      limit: limit.value,
      issues: tree.issues,
      ...(topicFetch.partial || threadFetch.partial ? { partial: true } : {}),
    });
  });

  // ── GET /threads/:id ────────────────────────────────────────────────────
  app.get('/threads/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID_RE.test(id)) {
      return c.json({ ok: false, error: 'invalid id', reasons: ['id must be 64 hex characters'] }, 400);
    }

    const found = await fetchVerified([{ ids: [id] }]);
    const root = found.find((event) => event.id === id) ?? null;
    if (root === null || !READABLE_ROOT_KINDS.has(root.kind)) {
      return c.json({ ok: false, error: 'thread root not found', id }, 404);
    }

    // expanzia kandidátov: 1023 s `e` tagom na root, potom iteratívne
    // nasledujeme odpovede, ktoré referencujú už známe id (parent-only
    // markery bez root markera). Max. 50 kôl, inak acyklicky nedosiahnuteľné.
    const byId = new Map<string, Event>([[root.id, root]]);
    let frontier = [root.id];
    let repliesPartial = false;
    for (let round = 0; round < 50 && frontier.length > 0; round += 1) {
      // A12: aj expanzia odpovedí ide oknami — vlákno s >500 odpoveďami
      // neskončí pri tichom strope relayu.
      // A4 (P1): frontier rozdeľujeme po ≤100 id, aby jeden REQ nebol
      // filter s tisíckami id (obrovská request správa, pomalý index
      // `#e` a risk, že relay filter odmietne).
      const candidates: Event[] = [];
      for (const chunk of chunkIds(frontier, FRONTIER_CHUNK)) {
        const chunkFetch = await fetchVerifiedWindowed({ kinds: [KINDS.POST], '#e': chunk });
        if (chunkFetch.partial) repliesPartial = true;
        candidates.push(...chunkFetch.events);
      }
      const fresh: Event[] = [];
      for (const event of candidates) {
        if (!byId.has(event.id)) {
          byId.set(event.id, event);
          fresh.push(event);
        }
      }
      frontier = fresh.map((event) => event.id);
    }

    // zaradíme len odpovede, ktorých root sa deterministicky odvodí na tento root
    const replies: Event[] = [];
    const unresolved: string[] = [];
    for (const event of byId.values()) {
      if (event.id === root.id || event.kind !== KINDS.POST) continue;
      const resolved = resolveRootId(event, byId);
      if (resolved === root.id) replies.push(event);
      else if (resolved === null) unresolved.push(event.id);
      // resolved === iný root → patrí do iného vlákna (mention), vynechá sa
    }

    const tree = buildReplyTree(root, replies);
    if (unresolved.length > 0) {
      logger(`thread ${id}: ${String(unresolved.length)} replies without a derivable root (cycle/unknown parent), skipped`);
    }

    // F4AI-15 (S9): rating agregát koreňa — 1031 solution_rating viazané na
    // vlákno (vážený priemer + Wilson + Kish n_eff, stropy agent/cluster/op)
    // a `accepted` flag z 1032. Additívne pole `rating`, nič sme nemazali —
    // backward compatible. Zlyhanie dopytu rating neshodí thread: pri chybe
    // vrátime rating s count 0 a `note`.
    let rating: ThreadRatingBody & { note?: string };
    try {
      const ratingEvents = await fetchVerified([
        { kinds: [KINDS.SOLUTION_RATING, KINDS.ACCEPTED_SOLUTION], '#e': [root.id] },
      ]);
      rating = aggregateThreadRating(
        root.id,
        ratingEvents.filter((event) => event.kind === KINDS.SOLUTION_RATING) as unknown as NostrEvent[],
        ratingEvents.filter((event) => event.kind === KINDS.ACCEPTED_SOLUTION) as unknown as NostrEvent[],
        undefined,
        // A6: accepted=true len ke 1032 podpísal autor koreňa (otázky)
        root.pubkey,
      );
    } catch (err) {
      logger(`thread ${id}: rating aggregate failed (${String(err)}), returning empty rating`);
      rating = Object.assign(aggregateThreadRating(root.id, [], []), {
        note: 'rating query failed',
      });
    }

    return c.json({
      root: eventSummary(root),
      // strom: priame odpovede pod rootom, zanožené deti v `children`
      replies: tree.root.children,
      reply_count: tree.replies.length,
      // F4AI-15: agregát hodnotení koreňa (additívne, S9)
      rating,
      issues: tree.issues,
      // A12: additívny flag — strom bol skrátený stropom relayu/okien
      ...(repliesPartial ? { partial: true } : {}),
    });
  });

  // ── GET /feed ───────────────────────────────────────────────────────────
  app.get('/feed', async (c) => {
    const rawKinds = c.req.query('kinds');
    let kinds: number[] = [...FEED_KINDS];
    if (rawKinds !== undefined && rawKinds.trim() !== '') {
      const parsed: number[] = [];
      const bad: string[] = [];
      for (const part of rawKinds.split(',')) {
        const value = Number(part.trim());
        if (Number.isInteger(value) && (FEED_KINDS as readonly number[]).includes(value)) {
          if (!parsed.includes(value)) parsed.push(value);
        } else {
          bad.push(part.trim());
        }
      }
      if (bad.length > 0) {
        return c.json(
          { ok: false, error: 'invalid kinds', reasons: [`only ${FEED_KINDS.join(', ')} are allowed (bad: ${bad.join(', ')})`] },
          400,
        );
      }
      kinds = parsed;
    }
    const limit = parseLimit(c, c.req.query('limit'), defaultLimit, maxLimit);
    if ('error' in limit) {
      return c.json({ ok: false, error: 'invalid limit', reasons: [limit.error] }, 400);
    }

    // relaye vracajú own latest `limit` eventov; po zlúčení a deduplikácii
    // (pool) zotriedime a ostrihneme — výsledok je korektných N posledných
    const events = await fetchVerified([{ kinds, limit: limit.value }]);
    const sorted = sortFeedDesc(events).slice(0, limit.value);

    return c.json({
      phase: GATEWAY_PHASE,
      kinds,
      limit: limit.value,
      count: sorted.length,
      items: sorted.map(eventSummary),
    });
  });

  // ── GET /recent ─────────────────────────────────────────────────────────
  // F4AI-12 (S6): podklad pre MCP `forum_search` — na rozdiel od /feed tu
  // smie byť hociktorý kind zo shared registry a strop limitu je 1000
  // (search chce stiahnuť posledných ~500 eventov a matchovať lokálne).
  // Voliteľný `authors=` (čiarka, 64-hex) filtruje per-author — MCP
  // `forum_follow` takto číta aktuálny follow-list autora (kind 10031).
  app.get('/recent', async (c) => {
    const rawKinds = c.req.query('kinds');
    let kinds: number[] = [...RECENT_DEFAULT_KINDS];
    if (rawKinds !== undefined && rawKinds.trim() !== '') {
      const parsed: number[] = [];
      const bad: string[] = [];
      for (const part of rawKinds.split(',')) {
        const value = Number(part.trim());
        if (Number.isInteger(value) && ALLOWED_KINDS.has(value)) {
          if (!parsed.includes(value)) parsed.push(value);
        } else {
          bad.push(part.trim());
        }
      }
      if (bad.length > 0) {
        return c.json(
          {
            ok: false,
            error: 'invalid kinds',
            reasons: [`kinds must be in the shared forum4ai registry (bad: ${bad.join(', ')})`],
          },
          400,
        );
      }
      kinds = parsed;
    }

    const rawAuthors = c.req.query('authors');
    const authors: string[] = [];
    if (rawAuthors !== undefined && rawAuthors.trim() !== '') {
      const badAuthors: string[] = [];
      for (const part of rawAuthors.split(',')) {
        const value = part.trim();
        if (ID_RE.test(value)) {
          if (!authors.includes(value)) authors.push(value);
        } else {
          badAuthors.push(value);
        }
      }
      if (badAuthors.length > 0) {
        return c.json(
          {
            ok: false,
            error: 'invalid authors',
            reasons: [`authors must be 64-hex pubkeys (bad: ${badAuthors.join(', ')})`],
          },
          400,
        );
      }
    }

    const limit = parseLimit(c, c.req.query('limit'), RECENT_DEFAULT_LIMIT, RECENT_MAX_LIMIT);
    if ('error' in limit) {
      return c.json({ ok: false, error: 'invalid limit', reasons: [limit.error] }, 400);
    }

    const filter: Filter = { kinds, limit: limit.value };
    if (authors.length > 0) filter.authors = authors;

    const events = await fetchVerified([filter]);
    const sorted = sortFeedDesc(events).slice(0, limit.value);

    return c.json({
      phase: GATEWAY_PHASE,
      kinds,
      ...(authors.length > 0 ? { authors } : {}),
      limit: limit.value,
      count: sorted.length,
      items: sorted.map(eventSummary),
    });
  });
}
