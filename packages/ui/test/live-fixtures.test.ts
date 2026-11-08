/**
 * Testy live fixture (F4AI-18, S12) — kontrolujú, že stiahnuté odpovede
 * live gateway držia kontrakt typov z `src/api/types.ts` a že testy na
 * nich postavené majú čo testovať (vnorený strom, rating agregát s
 * `accepted`, topic s `a` tagovanými vláknami, strom s deťmi).
 *
 * Ak gateway niekedy zmení shape, tieto testy zlyhajú SKÔR, než kompo-
 * nentové testy — a povedia, ktorý endpoint sa zmenil.
 */
import { describe, expect, it } from 'vitest';

import {
  LIVE_ACCEPTED_ROOT_ID,
  LIVE_IDEAS,
  LIVE_IDEA_CLAIMANT,
  LIVE_IDEA_DETAIL,
  LIVE_IDEA_ID,
  LIVE_NESTED_CHILD_ID,
  LIVE_NESTED_REPLY_ID,
  LIVE_NESTED_ROOT_ID,
  LIVE_REPUTATION,
  LIVE_REPUTATION_PUBKEY,
  LIVE_TOPIC_ADDRESS,
  LIVE_TOPIC_DETAIL,
  LIVE_TOPIC_SLUG,
  LIVE_TOPICS,
  LIVE_THREAD_ACCEPTED,
  LIVE_THREAD_NESTED,
} from './fixtures/live.js';

const HEX64 = /^[0-9a-f]{64}$/;

describe('live fixture — GET /threads/:id (nested)', () => {
  it('root je 1020 s 64-hex id a reply_count sedí s stromom', () => {
    expect(LIVE_THREAD_NESTED.root.kind).toBe(1020);
    expect(LIVE_NESTED_ROOT_ID).toMatch(HEX64);
    const count = (nodes: { children: unknown[] }[]): number =>
      nodes.reduce((sum, n) => sum + 1 + count(n.children as { children: unknown[] }[]), 0);
    expect(count(LIVE_THREAD_NESTED.replies)).toBe(LIVE_THREAD_NESTED.reply_count);
  });

  it('strom je vnorený: 1023 → 1023 v `children` (buildReplyTree shape)', () => {
    const rootReply = LIVE_THREAD_NESTED.replies[0];
    expect(rootReply?.kind).toBe(1023);
    expect(rootReply?.parent).toBe(LIVE_NESTED_ROOT_ID);
    expect(rootReply?.children.length).toBeGreaterThan(0);
    const child = rootReply?.children[0];
    expect(child?.kind).toBe(1023);
    expect(child?.parent).toBe(LIVE_NESTED_REPLY_ID);
    expect(LIVE_NESTED_CHILD_ID).toMatch(HEX64);
  });

  it('odpovede majú práve jeden `e` tag s markerom root (L2 pravidlo)', () => {
    const walk = (nodes: typeof LIVE_THREAD_NESTED.replies): void => {
      for (const node of nodes) {
        const roots = node.tags.filter((tag) => tag[0] === 'e' && tag[2] === 'root');
        expect(roots).toHaveLength(1);
        walk(node.children);
      }
    };
    walk(LIVE_THREAD_NESTED.replies);
  });
});

describe('live fixture — GET /threads/:id (rating + accepted)', () => {
  it('rating agregát má count>0, mean15 a accepted flag z 1032', () => {
    expect(LIVE_THREAD_ACCEPTED.root.id).toBe(LIVE_ACCEPTED_ROOT_ID);
    expect(LIVE_THREAD_ACCEPTED.rating.count).toBeGreaterThan(0);
    expect(LIVE_THREAD_ACCEPTED.rating.mean15).toBeGreaterThan(0);
    expect(LIVE_THREAD_ACCEPTED.rating.accepted).toBe(true);
    expect(LIVE_THREAD_ACCEPTED.rating.accepted_count).toBeGreaterThanOrEqual(1);
    // RatingAggregate polia (camelCase `weightTotal`/`weightRaw`, snake `n_eff`)
    expect(LIVE_THREAD_ACCEPTED.rating).toHaveProperty('weightTotal');
    expect(LIVE_THREAD_ACCEPTED.rating).toHaveProperty('weightRaw');
    expect(LIVE_THREAD_ACCEPTED.rating).toHaveProperty('n_eff');
    expect(LIVE_THREAD_ACCEPTED.rating).toHaveProperty('wilson');
  });

  it('nested fixture rating má count 0 a accepted false (hraničný stav pre UI)', () => {
    expect(LIVE_THREAD_NESTED.rating.count).toBe(0);
    expect(LIVE_THREAD_NESTED.rating.accepted).toBe(false);
  });
});

describe('live fixture — GET /topics/:slug a GET /topics', () => {
  it('detail topicu: adresa `30020:<hex>:<slug>` a každé vlákno má `a` tag na adresu', () => {
    expect(LIVE_TOPIC_ADDRESS).toMatch(/^30020:[0-9a-f]{64}:[a-z0-9][a-z0-9.-]*$/);
    expect(LIVE_TOPIC_SLUG).toBe('f4ai11-koren-1793208437023');
    expect(LIVE_TOPIC_DETAIL.threads.length).toBe(LIVE_TOPIC_DETAIL.thread_count);
    for (const thread of LIVE_TOPIC_DETAIL.threads) {
      expect(thread.tags).toContainEqual(['a', LIVE_TOPIC_ADDRESS]);
    }
    expect(LIVE_TOPIC_DETAIL.children.length).toBeGreaterThan(0);
  });

  it('strom topicov: korene majú parent null, dieťa `dbg-pod` ukazuje na adresu `dbg-koren`', () => {
    for (const root of LIVE_TOPICS.topics) {
      expect(root.parent).toBeNull();
    }
    const koren = LIVE_TOPICS.topics.find((node) => node.slug === 'dbg-koren');
    expect(koren?.address).toBeTruthy();
    const pod = koren?.children.find((node) => node.slug === 'dbg-pod');
    expect(pod?.parent).toBe(koren?.address ?? '');
  });
});

/* ===== F4AI-19 (S13): idea_call board + detail + reputation ========== */

describe('live fixture — GET /ideas (board)', () => {
  it('count sedí s items, každý row má 64-hex id/author a platný status automatu', () => {
    expect(LIVE_IDEAS.count).toBe(LIVE_IDEAS.items.length);
    expect(LIVE_IDEAS.items.length).toBeGreaterThan(0);
    const STATUSES = new Set(['open', 'claimed', 'in_progress', 'review', 'done', 'cancelled']);
    for (const item of LIVE_IDEAS.items) {
      expect(item.id).toMatch(HEX64);
      expect(item.author).toMatch(HEX64);
      expect(STATUSES.has(item.status)).toBe(true);
      expect(Array.isArray(item.topics)).toBe(true);
      expect(Array.isArray(item.status_history)).toBe(true);
      expect(typeof item.suggestions_count).toBe('number');
    }
  });

  it('rating agregát je null alebo plný ThreadRating (S10 shape overeny curlom)', () => {
    for (const item of LIVE_IDEAS.items) {
      if (item.rating === null) continue;
      expect(item.rating).toHaveProperty('mean15');
      expect(item.rating).toHaveProperty('n_eff');
      expect(item.rating).toHaveProperty('accepted');
      expect(item.rating).toHaveProperty('accepted_count');
      return;
    }
    // live data majú rating vždy prítomný (agregát s count 0)
    expect(LIVE_IDEAS.items[0]?.rating).not.toBeNull();
  });

  it('claimed rowy majú claimant 64-hex a open rowy null', () => {
    for (const item of LIVE_IDEAS.items) {
      if (item.status === 'claimed') {
        expect(item.claimant, `claimed ${item.id.slice(0, 8)}`).toMatch(HEX64);
      } else if (item.status === 'open') {
        expect(item.claimant).toBeNull();
      }
    }
  });
});

describe('live fixture — GET /ideas/:id (detail so suggestions)', () => {
  it('detail má status_history + suggestions poľa a id/claimant 64-hex', () => {
    expect(LIVE_IDEA_ID).toMatch(HEX64);
    expect(LIVE_IDEA_DETAIL.id).toBe(LIVE_IDEA_ID);
    expect(LIVE_IDEA_DETAIL.status).toBe('claimed');
    expect(LIVE_IDEA_CLAIMANT).toMatch(HEX64);
    expect(LIVE_IDEA_DETAIL.status_history.length).toBeGreaterThan(0);
    expect(LIVE_IDEA_DETAIL.suggestions.length).toBe(LIVE_IDEA_DETAIL.suggestions_count);
  });

  it('history entry má publisher/status/created_at a note text (realny flow S10)', () => {
    const entry = LIVE_IDEA_DETAIL.status_history[0]!;
    expect(entry.publisher).toMatch(HEX64);
    expect(entry.status).toBe('claimed');
    expect(entry.created_at).toBeGreaterThanOrEqual(LIVE_IDEA_DETAIL.created_at);
    expect(entry.note).toBe('potvrdeny claim od agenta');
    const suggestion = LIVE_IDEA_DETAIL.suggestions[0]!;
    expect(suggestion.status).toBe('in_progress');
    expect(suggestion.publisher).toMatch(HEX64);
  });
});

describe('live fixture — GET /reputation/:pubkey', () => {
  it('tri domény s score 0..1, counts a params agregátu (S9 shape)', () => {
    expect(LIVE_REPUTATION_PUBKEY).toMatch(HEX64);
    expect(LIVE_REPUTATION.pubkey).toBe(LIVE_REPUTATION_PUBKEY);
    for (const domain of ['voter', 'author', 'helper'] as const) {
      const score = LIVE_REPUTATION.domains[domain];
      expect(score, domain).toBeDefined();
      expect(score!.score).toBeGreaterThanOrEqual(0);
      expect(score!.score).toBeLessThanOrEqual(1);
      expect(score!.total).toBeGreaterThanOrEqual(score!.positive);
    }
    expect(LIVE_REPUTATION.domains.author?.score).toBeGreaterThan(0);
    expect(LIVE_REPUTATION.domains.author?.total).toBe(1);
    expect(LIVE_REPUTATION.params.z).toBeGreaterThan(0);
    expect(typeof LIVE_REPUTATION.epoch).toBe('number');
    expect(LIVE_REPUTATION.counts.threads_authored).toBeGreaterThan(0);
  });
});
