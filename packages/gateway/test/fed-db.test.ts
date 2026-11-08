/**
 * Testy `fed.db` (Phase 6a, dizajn Q5) — SQLite stavu federácie, ktorý
 * vlastní GATEWAY (kurzory upstreamov, `remote_events`, push fronta).
 *
 * Testuje SA TU výhradne úložisko (bez siete):
 *  1. `syncUpstreams` prida/aktualizuje/mazú a ZMENA base_url NESMAŽE
 *     kurzor (id je stabilné — inak by každý deploy stiahol celú históriu),
 *  2. `insertRemoteEvent` ukladá kánonickú kópiu BEZ premeny a dedupuje
 *     per id (druhý PULL ten istý event nevynásobí),
 *  3. split-horizon na úrovni úložiska: event, ktorý už leží v
 *     `remote_events`, sa do fronty nedostane vôbec (`skipped-remote`),
 *  4. fronta: `duePushes` rešpektuje backoff okno, `markPushFailure`
 *     rastie po `maxAttempts` do `dead` a mŕtvy list zostáva v audite,
 *  5. kurzor je monotónny a `resetCheckpoint` (resync) je jediná cesta
 *     dozadu,
 *  6. perzistencia: po `close()` + znovuotvorení toho istého súboru je
 *     kurzor aj mŕtve listy stále na mieste (restart procesu).
 *
 * `origin` je tu len reťazec — význam (host gateway URL) strážia testy
 * `fed/config` a `fed-search`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { KINDS } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';

import { FedDb, openFedDb } from '../src/fed/db.js';

const SK = generateSecretKey();
const UP = 'b.example:18081';

/** pevný základ — deterministické id (opakovateľné testy) */
const T0 = 1_730_000_000;

function event(
  kind: number,
  content: string,
  createdAt: number,
  tags: string[][] = [],
): NostrEvent {
  return finalizeEvent({ kind, created_at: createdAt, tags, content }, SK) as unknown as NostrEvent;
}

const dir = mkdtempSync(join(tmpdir(), 'f4ai-fed-db-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fed.db — upstreams a kurzory', () => {
  let db: FedDb;

  beforeEach(() => {
    db = openFedDb(':memory:');
  });

  it('syncUpstreams prida nove a mazi tie, co z konfiguracie zmizli', () => {
    const first = db.syncUpstreams([
      { id: 'a.example', baseUrl: 'http://a.example' },
      { id: 'b.example', baseUrl: 'http://b.example' },
    ]);
    expect(first.added).toEqual(['a.example', 'b.example']);
    expect(first.removed).toEqual([]);
    expect(db.listUpstreams().map((row) => row.id)).toEqual(['a.example', 'b.example']);

    const second = db.syncUpstreams([{ id: 'b.example', baseUrl: 'http://b.example' }]);
    expect(second.added).toEqual([]);
    expect(second.removed).toEqual(['a.example']);
    expect(db.listUpstreams().map((row) => row.id)).toEqual(['b.example']);
  });

  it('zmena base_url kurzor NEVYNULUJE (id je stabilne)', () => {
    db.syncUpstreams([{ id: UP, baseUrl: 'http://127.0.0.1:1' }]);
    db.bumpCheckpoint(UP, 1_234);
    const res = db.syncUpstreams([{ id: UP, baseUrl: 'http://127.0.0.1:2' }]);
    expect(res.updated).toEqual([UP]);
    expect(db.getUpstream(UP)?.checkpoint).toBe(1_234);
    expect(db.getUpstream(UP)?.baseUrl).toBe('http://127.0.0.1:2');
  });

  it('mazanie upstreamu zhadzuje aj jeho frontu (zadane mrtve listy nerastu donekonečna)', () => {
    db.syncUpstreams([{ id: UP, baseUrl: 'http://x' }]);
    db.enqueuePush(UP, event(KINDS.POST, 'row', T0));
    expect(db.queueStats(UP).total).toBe(1);
    db.syncUpstreams([]);
    expect(db.queueStats(UP).total).toBe(0);
  });

  it('kurzor je monotonny a resetCheckpoint je jedina cesta dozadu', () => {
    db.syncUpstreams([{ id: UP, baseUrl: 'http://x' }]);
    db.bumpCheckpoint(UP, 100);
    db.bumpCheckpoint(UP, 90); // starsi pull nesmie posunut kurzor spat
    expect(db.getUpstream(UP)?.checkpoint).toBe(100);
    expect(db.resetCheckpoint(UP)).toBe(true);
    expect(db.getUpstream(UP)?.checkpoint).toBe(0);
    // neznamy id = false (route z toho robi 404, nie tichy uspech)
    expect(db.resetCheckpoint('nikto.example')).toBe(false);
  });

  it('recordPullAttempt ok cisti chybu a scitava stiahnute eventy', () => {
    db.syncUpstreams([{ id: UP, baseUrl: 'http://x' }]);
    db.recordPullAttempt(UP, false, 0, 'ECONNREFUSED');
    let row = db.getUpstream(UP);
    expect(row?.lastError).toBe('ECONNREFUSED');
    expect(row?.lastSuccessAt).toBe(0);

    db.recordPullAttempt(UP, true, 7, '');
    row = db.getUpstream(UP);
    expect(row?.lastError).toBe('');
    expect(row?.pulledEvents).toBe(7);
    expect(row?.lastSuccessAt).toBeGreaterThan(0);

    db.recordPullAttempt(UP, true, 3, '');
    expect(db.getUpstream(UP)?.pulledEvents).toBe(10);
  });
});

describe('fed.db — remote_events (kánonická kópia)', () => {
  let db: FedDb;

  beforeEach(() => {
    db = openFedDb(':memory:');
    db.syncUpstreams([{ id: UP, baseUrl: 'http://x' }]);
  });

  it('uloží event bez premeny a dedupuje per id', () => {
    const ev = event(KINDS.POST, 'vlakno z B', T0 + 10, [['a', `30020:${'c'.repeat(64)}:root`]]);
    expect(db.insertRemoteEvent(UP, ev)).toBe(true);
    expect(db.insertRemoteEvent(UP, ev)).toBe(false);
    expect(db.remoteCount(UP)).toBe(1);

    const stored = db.remoteEvents(UP);
    expect(stored).toHaveLength(1);
    // zakázaná premena: podpis, created_at ani pubkey sa neprepisujú.
    // Uložená kópia je KÁNONICKÁ (7 polí) — nostr-tools príznak
    // `Symbol(verified)` v nej nesmie zostať, lebo peer dostáva presne
    // tento JSON a zhoda `id`↔`sig` sa overuje z neho.
    expect(stored[0]).toEqual({
      id: ev.id,
      pubkey: ev.pubkey,
      created_at: ev.created_at,
      kind: ev.kind,
      tags: ev.tags,
      content: ev.content,
      sig: ev.sig,
    });
    expect(stored[0]?.sig).toBe(ev.sig);
    expect(stored[0]?.created_at).toBe(ev.created_at);
  });

  it('prazdny origin znamena self (rovnaka konvencia ako default stlpca indexu)', () => {
    const ev = event(KINDS.POST, 'bez originu', T0 + 11);
    db.insertRemoteEvent('', ev);
    expect(db.remoteCount('self')).toBe(1);
  });

  it('remoteEvents sú ASC podľa created_at a `since` je INKLUZÍVNE', () => {
    db.insertRemoteEvent(UP, event(KINDS.POST, 'treti', T0 + 30));
    db.insertRemoteEvent(UP, event(KINDS.POST, 'prvy', T0 + 10));
    db.insertRemoteEvent(UP, event(KINDS.POST, 'druhy', T0 + 20));
    expect(db.remoteEvents(UP).map((row) => row.content)).toEqual(['prvy', 'druhy', 'treti']);
    expect(db.remoteEvents(UP, { since: T0 + 20 }).map((row) => row.content)).toEqual([
      'druhy',
      'treti',
    ]);
    expect(db.remoteEvents(UP, { limit: 2 }).map((row) => row.content)).toEqual(['prvy', 'druhy']);
  });

  it('remoteRootTopics vráti LEN korene 30020 (bez `a` tagu) — deti ostávajú v tabuľke', () => {
    const root = event(KINDS.TOPIC, 'koren stromu B', T0 + 5, [['d', 'b-root']]);
    const child = event(KINDS.TOPIC, 'dieta', T0 + 6, [
      ['d', 'b-child'],
      ['a', `30020:${root.pubkey}:b-root`],
    ]);
    const post = event(KINDS.POST, 'vlakno', T0 + 7);
    db.insertRemoteEvent(UP, root);
    db.insertRemoteEvent(UP, child);
    db.insertRemoteEvent(UP, post);

    const roots = db.remoteRootTopics(UP);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.slug).toBe('b-root');
    expect(roots[0]?.addr).toBe(`30020:${root.pubkey}:b-root`);
    expect(roots[0]?.parent_addr).toBeNull();
    expect(roots[0]?.origin).toBe(UP);
    // pocet vsetkych vzdialenych topikov pocita aj deti (diag. stromu)
    expect(db.remoteTopicCount(UP)).toBe(2);
  });

  it('hasEvent/hasRemoteEvent rozlíšia cudzí id od toho, čo len tlačíme', () => {
    const remote = event(KINDS.POST, 'cudzi', T0 + 8);
    const mine = event(KINDS.POST, 'domaci', T0 + 9);
    db.insertRemoteEvent(UP, remote);
    db.enqueuePush(UP, mine);

    expect(db.hasRemoteEvent(remote.id)).toBe(true);
    expect(db.hasRemoteEvent(mine.id)).toBe(false);
    expect(db.hasEvent(remote.id)).toBe(true);
    expect(db.hasEvent(mine.id)).toBe(true);
    expect(db.hasEvent('neexistujuce')).toBe(false);
  });
});

describe('fed.db — push fronta so split-horizon a backoffom', () => {
  let db: FedDb;
  /** fiktívne hodiny: test riadi čas backoffu sám */
  let clock = 1_000;

  beforeEach(() => {
    clock = 1_000;
    db = new FedDb({ path: ':memory:', now: () => clock });
    db.syncUpstreams([{ id: UP, baseUrl: 'http://x' }]);
  });

  it('enqueuePush: queued → skipped-known (dedup per id a upstream)', () => {
    const ev = event(KINDS.POST, 'domaci', T0);
    expect(db.enqueuePush(UP, ev)).toBe('queued');
    expect(db.enqueuePush(UP, ev)).toBe('skipped-known');
    expect(db.queueStats(UP)).toMatchObject({ pending: 1, total: 1 });
  });

  it('split-horizon: event stiahnutý od NIEKOD sa do fronty nedostane', () => {
    const remote = event(KINDS.POST, 'cudzi od B', T0);
    db.insertRemoteEvent(UP, remote);
    expect(db.enqueuePush(UP, remote)).toBe('skipped-remote');
    expect(db.queueStats(UP).total).toBe(0);
  });

  it('duePushes pustí len položky s vypršaným backoffom', () => {
    const ev = event(KINDS.POST, 'fronta', T0);
    db.enqueuePush(UP, ev);
    expect(db.duePushes(UP, 10, clock)).toHaveLength(1);

    // zlyhanie → ďalší pokus až o 2000 ms
    db.markPushFailure(UP, ev.id, 'boom', clock + 2_000, 12);
    expect(db.duePushes(UP, 10, clock)).toHaveLength(0);
    expect(db.duePushes(UP, 10, clock + 1_999)).toHaveLength(0);
    expect(db.duePushes(UP, 10, clock + 2_000)).toHaveLength(1);
    expect(db.queueStats(UP, clock)).toMatchObject({ pending: 1, due: 0 });
    expect(db.queueStats(UP, clock + 2_000)).toMatchObject({ pending: 1, due: 1 });
  });

  it('markPushFailure rastie po maxAttempts do dead a mŕtvy list zostáva', () => {
    const ev = event(KINDS.POST, 'umrie', T0);
    db.enqueuePush(UP, ev);

    const verdicts: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      clock += 1_000;
      verdicts.push(db.markPushFailure(UP, ev.id, `fail ${String(attempt)}`, clock, 3));
    }
    expect(verdicts).toEqual(['retry', 'retry', 'dead']);

    const row = db.getQueueRow(UP, ev.id);
    expect(row?.status).toBe('dead');
    expect(row?.attempts).toBe(3);
    // dead už nie je due (inak by kolečko brúsilo mŕtve položky donekonečna)
    expect(row?.nextAttemptAt).toBe(0);
    expect(db.duePushes(UP, 10, clock + 10_000)).toHaveLength(0);
    expect(db.deadLetters(UP)).toHaveLength(1);
    expect(db.deadLetters(UP)[0]?.lastError).toBe('fail 2');
    expect(db.queueStats(UP)).toMatchObject({ dead: 1, pending: 0, done: 0 });
  });

  it('markPushSent označí done a vymaže chybu', () => {
    const ev = event(KINDS.POST, 'dosiel', T0);
    db.enqueuePush(UP, ev);
    db.markPushFailure(UP, ev.id, 'prvy zlyhal', clock + 500, 12);
    db.markPushSent(UP, ev.id);
    const row = db.getQueueRow(UP, ev.id);
    expect(row?.status).toBe('done');
    expect(row?.lastError).toBe('');
    expect(row?.sentAt).toBe(clock);
    expect(db.queueStats(UP)).toMatchObject({ done: 1, pending: 0, due: 0 });
  });

  it('pruneDone maže LEN staré done (mŕtve listy ostávajú auditom)', () => {
    const old = event(KINDS.POST, 'stary done', T0);
    const fresh = event(KINDS.POST, 'cerstvy done', T0 + 1);
    const dead = event(KINDS.POST, 'mrtvy', T0 + 2);
    db.enqueuePush(UP, old);
    db.enqueuePush(UP, fresh);
    db.enqueuePush(UP, dead);
    db.markPushSent(UP, old.id); // sent_at = 1_000
    clock = 90_000;
    db.markPushSent(UP, fresh.id); // sent_at = 90_000
    db.markPushFailure(UP, dead.id, 'smola', 0, 1);

    clock = 100_000;
    const removed = db.pruneDone(50_000); // keep 50 s → `old` (sent_at 1000) vypadne
    expect(removed).toBe(1);
    expect(db.getQueueRow(UP, old.id)).toBeNull();
    expect(db.getQueueRow(UP, fresh.id)?.status).toBe('done');
    expect(db.getQueueRow(UP, dead.id)?.status).toBe('dead');
  });

  it('meta kurzory (kľúč/hodnota) prepisujú, nie duplikujú', () => {
    db.setMeta('k', '1');
    db.setMeta('k', '2');
    expect(db.getMeta('k')).toBe('2');
    expect(db.getMeta('nic')).toBeNull();
  });
});

describe('fed.db — perzistencia cez restart procesu', () => {
  it('kurzor, remote eventy a mŕtve listy prežijú close + znovuotvorenie súboru', () => {
    const path = join(dir, 'restart.db');
    const first = openFedDb(path);
    first.syncUpstreams([{ id: UP, baseUrl: 'http://x' }]);
    first.bumpCheckpoint(UP, 4_242);
    const remote = event(KINDS.POST, 'prezije restart', T0 + 12);
    first.insertRemoteEvent(UP, remote);
    const doomed = event(KINDS.POST, 'mrtvy list', T0 + 13);
    first.enqueuePush(UP, doomed);
    first.markPushFailure(UP, doomed.id, 'upstream je mŕtvy', 0, 1);
    first.close();

    const second = openFedDb(path);
    expect(second.getUpstream(UP)?.checkpoint).toBe(4_242);
    expect(second.remoteEvents(UP).map((row) => row.id)).toEqual([remote.id]);
    expect(second.deadLetters(UP).map((row) => row.eventId)).toEqual([doomed.id]);
    second.close();
  });
});
