/**
 * Federation REST routes (Phase 6a).
 *
 *   GET  /fed/events        the PUBLIC read interface for peers —
 *                           `GET <gateway>/fed/events?since=&limit=&kinds=`
 *                           is the second half of the PULL (the first is the
 *                           engine). It returns LOCAL content (relay pool)
 *                           ordered ASC by `created_at` and trimmed to the
 *                           OLDEST `limit` events — the cursor `next_since`
 *                           then moves forward without gaps (had we trimmed to
 *                           the newest, older events would never have arrived).
 *   GET  /fed/topics        the roots of REMOTE trees per upstream — the basis
 *                           for the "Network" section (6b UI). The local
 *                           `GET /topics` is not mixed with it: trees are never
 *                           merged (Q5).
 *   GET  /fed/state         NIP-98 owner: checkpoint, queue length, last error,
 *                           last success, dead letters.
 *   POST /fed/resync/:id    NIP-98 owner: reset the cursor to 0 (the next PULL
 *                           reads the whole history; the per-id dedup holds, so
 *                           a resync does not duplicate).
 *
 * The authorization of `state`/`resync` is THIS SAME validator as
 * `POST /register/approve` and `GET /register/pending` (`owner-auth.ts`) —
 * 503 without an owner key, 401 for an invalid token, 403 if somebody else
 * signed. `/fed/events` and `/fed/topics` are public: remote events are public
 * data and a read-only relay is the premise of the design (Q5).
 */
import type { Hono } from 'hono';
import type { Context } from 'hono';
import { getPublicKey } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';

import { FED_SYNC_KINDS, NETWORK_ROOT_SLUG, verifyFull } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';

import { GATEWAY_PHASE } from '../app.js';
import { ownerAuthBody, verifyOwnerAuthorization } from '../owner-auth.js';
import type { FedEngine } from './engine.js';

/** TVár poolu, ktorú potrebuje `/fed/events` (`RelayPool` ho spĺňa). */
export interface FedReadPool {
  query(filters: Filter[], opts?: { timeoutMs?: number }): Promise<Event[]>;
}

export interface FedRouteOptions {
  engine: FedEngine;
  /** null = bez relaya (test len fed.db) → `/fed/events` vráti 503 */
  pool: FedReadPool | null;
  /** surová `GATEWAY_OWNER_SK_HEX` (prázdna = owner route nie sú dostupné) */
  ownerSkHex: string;
  /** default 5000 ms */
  queryTimeoutMs?: number;
  logger?: (line: string) => void;
}

/** strop jednej strany `/fed/events` (relay cca 500/filter — A12) */
export const FED_EVENTS_LIMIT_MAX = 500;
export const FED_EVENTS_LIMIT_DEFAULT = 200;

const HEX64 = /^[0-9a-f]{64}$/;

function ownerPubkeyOf(skHex: string): string {
  const trimmed = skHex.trim();
  if (!HEX64.test(trimmed)) return '';
  return getPublicKey(Uint8Array.from(Buffer.from(trimmed, 'hex'))).toLowerCase();
}

/** kánonická 7-pole kópia (nostr-tools Event má Symboly a navyše polia) */
function canonical(event: Event): NostrEvent {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: (event.tags ?? []).map((tag) => [...tag]) as NostrEvent['tags'],
    content: event.content,
    sig: event.sig,
  };
}

export function registerFedRoutes(app: Hono, options: FedRouteOptions): void {
  const queryTimeoutMs = options.queryTimeoutMs ?? 5_000;
  const ownerSkHex = options.ownerSkHex.trim();
  const ownerPubkey = ownerPubkeyOf(ownerSkHex);
  const log = options.logger ?? (() => undefined);

  /** NIP-98 owner kontrola bez tela (GET) */
  async function ownerGet(
    c: Context,
  ): Promise<{ ok: true; pubkey: string } | { ok: false; response: Response }> {
    const auth = await verifyOwnerAuthorization({
      header: c.req.header('authorization'),
      url: c.req.url,
      method: 'GET',
      ownerSkHex,
      ownerPubkey,
    });
    if (!auth.ok) return { ok: false, response: c.json(ownerAuthBody(auth.failure), auth.failure.status) };
    return { ok: true, pubkey: auth.pubkey };
  }

  // ── GET /fed/events (verejné čítacie rozhranie pre peers) ───────────────
  app.get('/fed/events', async (c) => {
    if (options.pool === null) {
      return c.json(
        {
          ok: false,
          error: 'relay pool unavailable',
          code: 'RELAY_UNAVAILABLE',
          reasons: ['this gateway has no relay pool to read from'],
        },
        503,
      );
    }

    const rawSince = c.req.query('since');
    let since = 0;
    if (rawSince !== undefined && rawSince.trim() !== '') {
      const parsed = Number(rawSince);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return c.json(
          { ok: false, error: 'invalid since', reasons: ['since must be a unix timestamp in seconds >= 0'] },
          400,
        );
      }
      since = parsed;
    }

    const rawLimit = c.req.query('limit');
    let limit = FED_EVENTS_LIMIT_DEFAULT;
    if (rawLimit !== undefined && rawLimit.trim() !== '') {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > FED_EVENTS_LIMIT_MAX) {
        return c.json(
          {
            ok: false,
            error: 'invalid limit',
            reasons: [`limit must be an integer 1..${String(FED_EVENTS_LIMIT_MAX)}`],
          },
          400,
        );
      }
      limit = parsed;
    }

    const rawKinds = c.req.query('kinds');
    let kinds: number[] = [...FED_SYNC_KINDS];
    if (rawKinds !== undefined && rawKinds.trim() !== '') {
      const parsed: number[] = [];
      const bad: string[] = [];
      for (const part of rawKinds.split(',')) {
        const value = Number(part.trim());
        if (Number.isInteger(value) && value >= 0) {
          if (!parsed.includes(value)) parsed.push(value);
        } else {
          bad.push(part.trim());
        }
      }
      if (bad.length > 0) {
        return c.json(
          { ok: false, error: 'invalid kinds', reasons: [`kinds must be integers (bad: ${bad.join(', ')})`] },
          400,
        );
      }
      kinds = parsed;
    }

    const filter: Filter = { kinds, since, limit: FED_EVENTS_LIMIT_MAX };
    // bez počiatočnej hodnoty: catch vracia 503, takže za try/catch je
    // `fetched` vždy priradený (a eslint by inak hlásil zbytočnú asignáciu)
    let fetched: Event[];
    try {
      fetched = await options.pool.query([filter], { timeoutMs: queryTimeoutMs });
    } catch (error) {
      log(`[fed] /fed/events query failed: ${error instanceof Error ? error.message : String(error)}`);
      return c.json(
        {
          ok: false,
          error: 'relay query failed',
          code: 'RELAY_UNAVAILABLE',
          reasons: [error instanceof Error ? error.message : String(error)],
        },
        503,
      );
    }

    // podpis overujeme TU, nie na peerovi: peer by inak dostal odpad,
    // ktorý by mu zapol remote_events a index (a my sme ho neoverili)
    const seen = new Set<string>();
    const events: NostrEvent[] = [];
    for (const event of fetched) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      if (!verifyFull(event as unknown as NostrEvent)) continue;
      events.push(canonical(event));
    }
    // ASC + orezať na najSTARŠÍCH: peer posúva kurzor na maximum stránky
    // a číta INKLUZÍVNE s dedupom per id. Keby sme orezali na najnovšie,
    // staršie eventy nad limitom by sa k peerovi nikdy nedostali.
    events.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
    const page = events.slice(0, limit);
    const last = page[page.length - 1];

    return c.json({
      ok: true,
      phase: GATEWAY_PHASE,
      since,
      limit,
      kinds,
      count: page.length,
      // ASC kurzor: najvyšší created_at v stránke (peer číta INKLUZÍVNE
      // a dedupuje per id, takže sa žiadny event nestratí ani nezdvojnásobí)
      next_since: last !== undefined ? last.created_at : since,
      events: page,
      // A12: relay ticho reže filter na svoj strop — pohľad je skrátený
      ...(fetched.length >= FED_EVENTS_LIMIT_MAX ? { partial: true } : {}),
    });
  });

  // ── GET /fed/topics (sekcia „Network") ──────────────────────────────────
  app.get('/fed/topics', (c) => {
    const limitRaw = c.req.query('limit');
    let limit = 50;
    if (limitRaw !== undefined && limitRaw.trim() !== '') {
      const parsed = Number(limitRaw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
        return c.json({ ok: false, error: 'invalid limit', reasons: ['limit must be an integer 1..200'] }, 400);
      }
      limit = parsed;
    }
    const upstreams = options.engine.remoteTopics(limit).map((entry) => ({
      id: entry.id,
      base_url: entry.base_url,
      topic_count: entry.topic_count,
      roots: entry.roots.map((row) => ({
        id: row.id,
        address: row.addr,
        slug: row.slug,
        pubkey: row.pubkey,
        kind: row.kind,
        created_at: row.created_at,
        content: row.content,
        origin: row.origin,
      })),
    }));
    return c.json({
      ok: true,
      phase: GATEWAY_PHASE,
      // UI (6b) kreslí tieto stromy pod sekciou Network — nikdy nie ako
      // deti domáceho koreňa (`INSTANCE_ROOT_TOPIC`)
      section: NETWORK_ROOT_SLUG,
      count: upstreams.reduce((sum, entry) => sum + entry.roots.length, 0),
      upstreams,
    });
  });

  // ── GET /fed/state (owner) ──────────────────────────────────────────────
  app.get('/fed/state', async (c) => {
    const auth = await ownerGet(c);
    if (!auth.ok) return auth.response;
    return c.json({
      ok: true,
      phase: GATEWAY_PHASE,
      owner: ownerPubkey,
      federation: {
        enabled: options.engine.enabled,
        ...options.engine.params,
        upstreams: options.engine.state(),
      },
    });
  });

  // ── POST /fed/resync/:id (owner) ────────────────────────────────────────
  app.post('/fed/resync/:id', async (c) => {
    const rawBody = await c.req.text();
    const auth = await verifyOwnerAuthorization({
      header: c.req.header('authorization'),
      url: c.req.url,
      method: 'POST',
      rawBody,
      ownerSkHex,
      ownerPubkey,
    });
    if (!auth.ok) return c.json(ownerAuthBody(auth.failure), auth.failure.status);

    const id = decodeURIComponent(c.req.param('id') ?? '').trim().toLowerCase();
    if (id === '') {
      return c.json({ ok: false, error: 'invalid id', reasons: ['upstream id must not be empty'] }, 400);
    }
    if (!options.engine.resync(id)) {
      const known = options.engine
        .listUpstreams()
        .map((upstream) => upstream.id)
        .join(', ');
      return c.json(
        {
          ok: false,
          error: 'unknown upstream',
          code: 'UPSTREAM_NOT_FOUND',
          reasons: [
            `no upstream ${JSON.stringify(id)} is configured (known: ${known === '' ? 'none' : known})`,
          ],
        },
        404,
      );
    }
    log(`[fed] resync ${id} (owner ${auth.ok ? auth.pubkey.slice(0, 8) : '?'}…)`);
    return c.json({ ok: true, phase: GATEWAY_PHASE, id, checkpoint: 0 });
  });
}
