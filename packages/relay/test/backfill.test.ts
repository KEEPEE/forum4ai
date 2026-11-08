/**
 * Phase 6b-deploy: testy backfillu — read-only relay si musí naplniť store
 * z iného relayu, inak by bol (MemoryStore bez disku) prázdny a `REQ` by
 * nemal čo odpovedať.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';

import { startRelayServer } from '../src/server.js';
import type { RunningRelay } from '../src/server.js';
import { backfillOnce, BACKFILL_DEFAULTS } from '../src/backfill.js';
import { DEFAULT_ALLOWED_KINDS } from '../src/policy.js';
import { KINDS } from '@forum4ai/shared';

const SK = generateSecretKey();
const PUBKEY = getPublicKey(SK);
const ROOT_ID = 'e'.repeat(64);

function sign(kind: number, tags: string[][], content: string): Event {
  return finalizeEvent(
    { kind, created_at: Math.floor(Date.now() / 1000), tags, content },
    SK,
  );
}

/** počkaj na EOSE a vráť eventy subsidiacie */
function subscribeToEose(relay: Relay, filters: object[], timeoutMs = 4000): Promise<Event[]> {
  return new Promise((resolve, reject) => {
    const events: Event[] = [];
    const timeout = setTimeout(() => reject(new Error('EOSE neprišlo v timeoute')), timeoutMs);
    relay.subscribe(filters as never, {
      onevent: (event) => events.push(event),
      oneose: () => {
        clearTimeout(timeout);
        resolve(events);
      },
      onclose: (reason) => {
        clearTimeout(timeout);
        reject(new Error(`subscripcia zavretá: ${reason}`));
      },
    });
  });
}

describe('backfill (Phase 6b: read-only relay potrebuje zdroj obsahu)', () => {
  let source: RunningRelay;
  let target: RunningRelay;
  let targetClient: Relay;
  const published: Event[] = [];

  beforeAll(async () => {
    source = await startRelayServer({ port: 0 });
    const sourceClient = await Relay.connect(source.url);
    published.push(
      sign(KINDS.QUESTION, [['d', 'bf-1020']], 'backfill thread 1'),
      sign(KINDS.POST, [['e', ROOT_ID, 'root']], 'backfill post 2'),
      sign(KINDS.TOPIC, [['d', 'bf-topic']], '{"slug":"backfill-topic"}'),
    );
    for (const event of published) await sourceClient.publish(event);
    sourceClient.close();

    target = await startRelayServer({ port: 0, policy: { readOnly: true } });
    targetClient = await Relay.connect(target.url);
  });

  afterAll(async () => {
    targetClient.close();
    await target.close();
    await source.close();
  });

  it('source relay má 3 eventy (kontrola pred backfillom)', async () => {
    const received = await subscribeToEose(await Relay.connect(source.url), [
      { authors: [PUBKEY] },
    ]);
    expect(received.length).toBe(3);
  });

  it('backfill naplní READ-ONLY store a overí podpisy (invalid=0)', async () => {
    const result = await backfillOnce(target.store, {
      url: source.url,
      kinds: [...DEFAULT_ALLOWED_KINDS],
      since: BACKFILL_DEFAULTS.since,
      limit: BACKFILL_DEFAULTS.limit,
      maxPages: 5,
    });
    expect(result.error).toBeUndefined();
    expect(result.scanned).toBe(3);
    expect(result.inserted).toBe(3);
    expect(result.invalid).toBe(0);
    expect(result.duplicate).toBe(0);
    expect(target.store.size).toBe(3);
    expect(result.cursor).toBeGreaterThan(0);
  });

  it('read-only relay po backfille ODPOVEDÁ na REQ (to je ten celý zmysel)', async () => {
    const received = await subscribeToEose(targetClient, [{ authors: [PUBKEY] }]);
    expect(received.map((event) => event.id).sort()).toEqual(published.map((e) => e.id).sort());
  });

  it('klientský EVENT je na read-only relayi stále zamietnutý', async () => {
    const note = sign(KINDS.QUESTION, [['d', 'bf-klient']], 'klient sem nesmie');
    await expect(targetClient.publish(note)).rejects.toThrow(/rejected: read-only relay/);
    expect(target.store.size).toBe(3);
  });

  it('druhý backfill je idempotentný (duplicate, nie duplikáty v store)', async () => {
    const result = await backfillOnce(target.store, {
      url: source.url,
      kinds: [...DEFAULT_ALLOWED_KINDS],
      since: BACKFILL_DEFAULTS.since,
      limit: BACKFILL_DEFAULTS.limit,
      maxPages: 5,
    });
    expect(result.inserted).toBe(0);
    expect(result.duplicate).toBe(3);
    expect(target.store.size).toBe(3);
  });

  it('spätné okná: limit menší ako počet eventov nezanechá dieru', async () => {
    // samostatný zdroj s RÔZNYMI created_at — spätné okná (`until = min-1`)
    // sa posúvajú po časovej osi; pri rovnakých časoch by sa nedali oddeliť
    // (rovnaké obmedzenie má aj windowing v gatewayi, preto `partial` flag).
    const staged = await startRelayServer({ port: 0 });
    const stagedClient = await Relay.connect(staged.url);
    const base = Math.floor(Date.now() / 1000) - 100;
    for (let i = 0; i < 3; i += 1) {
      const event = finalizeEvent(
        {
          kind: KINDS.QUESTION,
          created_at: base + i,
          tags: [['d', `bf-page-${String(i)}`]],
          content: `paginovaný event ${String(i)}`,
        },
        SK,
      );
      await stagedClient.publish(event);
    }
    stagedClient.close();

    const fresh = await startRelayServer({ port: 0, policy: { readOnly: true } });
    try {
      const result = await backfillOnce(fresh.store, {
        url: staged.url,
        kinds: [...DEFAULT_ALLOWED_KINDS],
        since: 0,
        limit: 2, // 3 eventy → potrebné 2 okná
        maxPages: 5,
      });
      expect(result.pages).toBeGreaterThanOrEqual(2);
      expect(result.inserted).toBe(3);
      expect(fresh.store.size).toBe(3);
    } finally {
      await fresh.close();
      await staged.close();
    }
  });

  // Chybová vetva (nepripojiteľný zdroj) je ošetrená try/catchom v
  // `backfillOnce`, ale nedá sa rozumnosne unit-testovať: nostr-tools 2.25
  // má na odmietnutom TCP spojení rekurziu v `onerror` (RangeError: Maximum
  // call stack size exceeded), čo rozhádze vitest. Testujeme ju teda
  // prevádzkovo (relay beží ďalej a hlási `backfill: zlyhalo …`).
});
