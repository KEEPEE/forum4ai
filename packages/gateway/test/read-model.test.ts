/**
 * Unit testy read-model (S5) — čistě deterministické funkcie bez siete:
 * LWW deduplikácia, strom topicov (cyklus, orphan, usporiadanie),
 * NIP-10 root resolution (parent retazce, cyklus, hlbka) a assembly
 * stromu odpovedí. Eventy sú syntetické (read-model neoveruje podpisy).
 */
import { describe, expect, it } from 'vitest';
import type { Event } from 'nostr-tools';

import {
  applyThreadActivity,
  buildReplyTree,
  buildTopicTree,
  countThreadsByTopicAddress,
  lwwByAddress,
  resolveRootId,
  sortFeedDesc,
  topicAddress,
  topicParentAddress,
  topicSlug,
  MAX_PARENT_HOPS,
  UNSORTED_SLUG,
} from '../src/read-model.js';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function ev(
  id: string,
  kind: number,
  tags: string[][],
  created_at: number,
  pubkey = PK_A,
  content = '',
): Event {
  return { id: hex(id), pubkey, created_at, kind, tags, content, sig: 'f'.repeat(128) };
}

function topic(id: string, slug: string, created_at: number, parent?: string, pubkey = PK_A): Event {
  const tags: string[][] = [['d', slug]];
  if (parent !== undefined) tags.push(['a', parent]);
  return ev(id, 30020, tags, created_at, pubkey);
}

const addr = (slug: string, pubkey = PK_A): string => `30020:${pubkey}:${slug}`;

describe('topic tag helpers', () => {
  it('topicSlug/topicAddress čítajú d-tag a postavia adresu', () => {
    const t = topic('t1', 'my-topic', 100);
    expect(topicSlug(t)).toBe('my-topic');
    expect(topicAddress(t)).toBe(addr('my-topic'));
  });

  it('topicSlug vráti null pri neplatnom alebo chýbajúcom d-tagu', () => {
    expect(topicSlug(ev('x', 30020, [['d', 'Bad Slug!']], 1))).toBeNull();
    expect(topicSlug(ev('x', 30020, [], 1))).toBeNull();
  });

  it('topicParentAddress číta a-tag a zahodí neplatnú adresu', () => {
    expect(topicParentAddress(topic('t', 'b', 1, addr('a')))).toBe(addr('a'));
    expect(topicParentAddress(topic('t', 'b', 1, '30020:krasak:slug'))).toBeNull();
    expect(topicParentAddress(topic('t', 'b', 1))).toBeNull();
  });
});

describe('lwwByAddress', () => {
  it('novší created_at vyhráva', () => {
    const old = topic('old', 'dupa', 100);
    const fresh = topic('new', 'dupa', 200);
    const lww = lwwByAddress([old, fresh]);
    expect(lww.get(addr('dupa'))?.id).toBe(fresh.id);
  });

  it('pri rovnakom created_at vyhráva lexikograficky nižšie id (NIP-01)', () => {
    const high = ev('ffff', 30020, [['d', 'tie']], 100);
    const low = ev('0000', 30020, [['d', 'tie']], 100);
    const lww = lwwByAddress([high, low]);
    expect(lww.get(addr('tie'))?.id).toBe(low.id);
  });

  it('eventy bez platného d-tagu preskočí', () => {
    const lww = lwwByAddress([ev('x', 30020, [], 1)]);
    expect(lww.size).toBe(0);
  });
});

describe('buildTopicTree', () => {
  it('zostaví strom a zotriedi created_at asc, slug asc (rekurzívne)', () => {
    const events = [
      topic('r1', 'root-one', 100),
      topic('r2', 'root-two', 120),
      topic('c-b', 'child-b', 150, addr('root-one')),
      topic('c-a', 'child-a', 200, addr('root-one')),
      topic('g', 'grand', 300, addr('child-a')),
    ];
    const tree = buildTopicTree(events);
    expect(tree.issues).toEqual([]);
    expect(tree.topic_count).toBe(5);
    expect(tree.roots.map((n) => n.slug)).toEqual(['root-one', 'root-two']);
    const rootOne = tree.roots[0] as (typeof tree.roots)[number];
    expect(rootOne.children.map((n) => n.slug)).toEqual(['child-b', 'child-a']);
    const childA = rootOne.children[1] as (typeof rootOne.children)[number];
    expect(childA.children.map((n) => n.slug)).toEqual(['grand']);
  });

  it('LWW: staršia verzia topicu sa v strome neobjaví', () => {
    const events = [topic('old', 'dupa', 100), topic('new', 'dupa', 200)];
    const tree = buildTopicTree(events);
    expect(tree.topic_count).toBe(1);
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]?.event_id).toBe(hex('new'));
  });

  it('orphan topic ide pod unsorted a eviduje sa v issues', () => {
    const events = [
      topic('r', 'root', 100),
      topic('o', 'orphan', 150, addr('neexistuje')),
    ];
    const tree = buildTopicTree(events);
    expect(tree.roots.map((n) => n.slug)).toEqual(['root', UNSORTED_SLUG]);
    const unsorted = tree.roots[1] as (typeof tree.roots)[number];
    expect(unsorted.address).toBeNull();
    expect(unsorted.children.map((n) => n.slug)).toEqual(['orphan']);
    expect(tree.issues.join(' ')).toMatch(/orphan topic orphan/);
  });

  it('cyklus A->B->A: členovia idú pod unsorted, issues eviduje cyklus', () => {
    const events = [
      topic('a', 'aa', 100, addr('bb')),
      topic('b', 'bb', 110, addr('aa')),
      topic('c', 'cc', 120, addr('aa')), // dieťa cyklického člena → sploštené pod unsorted
      topic('r', 'root', 90),
    ];
    const tree = buildTopicTree(events);
    expect(tree.roots.map((n) => n.slug)).toEqual(['root', UNSORTED_SLUG]);
    const unsorted = tree.roots[1] as (typeof tree.roots)[number];
    expect(unsorted.children.map((n) => n.slug)).toEqual(['aa', 'bb', 'cc']);
    expect(tree.issues.join(' ')).toMatch(/cycle/);
  });

  it('seba-rodič je cyklus', () => {
    const events = [topic('s', 'self', 100, addr('self'))];
    const tree = buildTopicTree(events);
    expect(tree.roots.map((n) => n.slug)).toEqual([UNSORTED_SLUG]);
    expect(tree.issues.join(' ')).toMatch(/cycle/);
  });

  it('čistý les nemá unsorted uzol', () => {
    const tree = buildTopicTree([topic('r', 'root', 100)]);
    expect(tree.roots.map((n) => n.slug)).toEqual(['root']);
    expect(tree.issues).toEqual([]);
  });
});

describe('countThreadsByTopicAddress + applyThreadActivity', () => {
  function thread(id: string, topicAddr: string | undefined, kind = 1020): Event {
    const tags: string[][] = [];
    if (topicAddr !== undefined) tags.push(['a', topicAddr]);
    return ev(id, kind, tags, 500);
  }

  it('počíta len validné adresy; duplicitný a-tag v jednom eventu započíta raz', () => {
    const counts = countThreadsByTopicAddress([
      thread('t1', addr('x')),
      thread('t2', addr('x')),
      thread('t3', undefined), // bez a-tagu nikam nepatrí
      thread('t4', '30020::bad'), // neplatná forma
      ev('t5', 1020, [['a', addr('y')], ['a', addr('y')]], 500), // duplicitný tag
    ]);
    expect(counts.get(addr('x'))).toBe(2);
    expect(counts.get(addr('y'))).toBe(1);
    expect(counts.size).toBe(2);
  });

  it('thread_count = vlastné + descendants; korene podľa aktivity; unsorted posledný', () => {
    const tree = buildTopicTree([
      topic('r1', 'bohaty', 100),
      topic('rc', 'bohaty-pod', 110, addr('bohaty')),
      topic('r2', 'prazdny-novy', 300),
      topic('r3', 'prazdny-stary', 200),
      topic('o', 'sirotok', 150, addr('neexistuje')),
    ]);
    applyThreadActivity(
      tree,
      countThreadsByTopicAddress([
        thread('t1', addr('bohaty')),
        thread('t2', addr('bohaty-pod')), // descendant → započíta sa aj 'bohaty'
        thread('t3', addr('sirotok')), // pod unsorted
      ]),
    );
    // 2 nite > 0; pri zhode 0 rozhoduje novší created_at (300 pred 200)
    expect(tree.roots.map((n) => n.slug)).toEqual([
      'bohaty',
      'prazdny-novy',
      'prazdny-stary',
      UNSORTED_SLUG,
    ]);
    expect(tree.roots.map((n) => n.thread_count)).toEqual([2, 0, 0, 1]);
    const bohaty = tree.roots[0] as (typeof tree.roots)[number];
    expect(bohaty.children.map((n) => n.slug)).toEqual(['bohaty-pod']);
    expect(bohaty.children[0]?.thread_count).toBe(1);
  });

  it('bez applyThreadActivity pole thread_count neexistuje (backward compat)', () => {
    const tree = buildTopicTree([topic('r', 'root', 100)]);
    expect(tree.roots[0]).not.toHaveProperty('thread_count');
  });
});

describe('resolveRootId (NIP-10)', () => {
  const ROOT = hex('root');

  function byId(...events: Event[]): Map<string, Event> {
    return new Map(events.map((e) => [e.id, e]));
  }

  it('root marker vráti priamo root', () => {
    const post = ev('p', 1023, [['e', ROOT, 'root']], 1);
    expect(resolveRootId(post, byId(post))).toBe(ROOT);
  });

  it('parent retazka k eventu s root markerom → root', () => {
    const r1 = ev('r1', 1023, [['e', ROOT, 'root'], ['e', hex('q'), 'parent']], 1);
    const r2 = ev('r2', 1023, [['e', hex('r1'), 'parent']], 2);
    expect(resolveRootId(r2, byId(r1, r2))).toBe(ROOT);
  });

  it('parent retazka k thread-root kindu (1020) → jeho id', () => {
    const q = ev('q', 1020, [], 1);
    const r1 = ev('r1', 1023, [['e', hex('q'), 'parent']], 2);
    expect(resolveRootId(r1, byId(q, r1))).toBe(q.id);
  });

  it('event bez markerov je sám sebou', () => {
    const solo = ev('solo', 1023, [], 1);
    expect(resolveRootId(solo, byId(solo))).toBe(solo.id);
  });

  it('cyklus v parent retazci → null', () => {
    const a = ev('a', 1023, [['e', hex('b'), 'parent']], 1);
    const b = ev('b', 1023, [['e', hex('a'), 'parent']], 2);
    expect(resolveRootId(a, byId(a, b))).toBeNull();
  });

  it('neznamy parent → null', () => {
    const orphan = ev('o', 1023, [['e', hex('nic'), 'parent']], 1);
    expect(resolveRootId(orphan, byId(orphan))).toBeNull();
  });

  it('retazka dlhšia ako limit → null', () => {
    // c0 má root marker; cN odkazuje na c(N-1). Resolution potrebuje N-1 krokov,
    // takže c50 ešte prejde (49. hop), c51 už narazí na limit 50.
    const chain: Event[] = [];
    for (let i = 0; i <= MAX_PARENT_HOPS + 1; i += 1) {
      const tags: string[][] = i === 0 ? [['e', hex('root'), 'root']] : [['e', hex(`c${String(i - 1)}`), 'parent']];
      chain.push(ev(`c${String(i)}`, 1023, tags, i));
    }
    const map = byId(...chain);
    const tooDeep = chain[MAX_PARENT_HOPS + 1] as Event;
    expect(resolveRootId(tooDeep, map)).toBeNull();
    const justFits = chain[MAX_PARENT_HOPS] as Event;
    expect(resolveRootId(justFits, map)).toBe(hex('root'));
  });
});

describe('buildReplyTree', () => {
  const ROOT_EVENT = ev('root', 1020, [], 10, PK_B, 'otazka');

  it('priame odpovede zotriedi created_at asc, id asc', () => {
    const r2 = ev('r2', 1023, [['e', ROOT_EVENT.id, 'root']], 20);
    const r1 = ev('r1', 1023, [['e', ROOT_EVENT.id, 'root']], 15);
    const r1b = ev('1111', 1023, [['e', ROOT_EVENT.id, 'root']], 15);
    const tree = buildReplyTree(ROOT_EVENT, [r2, r1, r1b]);
    expect(tree.root.id).toBe(ROOT_EVENT.id);
    expect(tree.root.children.map((n) => n.id)).toEqual([r1b.id, r1.id, r2.id]);
    expect(tree.replies).toHaveLength(3);
  });

  it('parent marker zavesí odpoved pod odpoved', () => {
    const r1 = ev('r1', 1023, [['e', ROOT_EVENT.id, 'root']], 15);
    const r2 = ev('r2', 1023, [['e', ROOT_EVENT.id, 'root'], ['e', r1.id, 'parent']], 20);
    const tree = buildReplyTree(ROOT_EVENT, [r1, r2]);
    expect(tree.root.children.map((n) => n.id)).toEqual([r1.id]);
    const r1Node = tree.root.children[0] as (typeof tree.root.children)[number];
    expect(r1Node.children.map((n) => n.id)).toEqual([r2.id]);
  });

  it('parent marker mimo vlákna → priamo pod root', () => {
    const r = ev('r', 1023, [['e', ROOT_EVENT.id, 'root'], ['e', hex('cudzí'), 'parent']], 15);
    const tree = buildReplyTree(ROOT_EVENT, [r]);
    expect(tree.root.children.map((n) => n.id)).toEqual([r.id]);
  });

  it('cyklus medzi odpovedami → obe pod root + issue', () => {
    const a = ev('a', 1023, [['e', hex('b'), 'parent']], 15);
    const b = ev('b', 1023, [['e', hex('a'), 'parent']], 16);
    const tree = buildReplyTree(ROOT_EVENT, [a, b]);
    expect(tree.root.children.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(tree.issues.join(' ')).toMatch(/cycle/);
  });
});

describe('sortFeedDesc', () => {
  it('created_at desc, pri rovnosti id asc', () => {
    const a = ev('a', 1020, [], 100);
    const b = ev('b', 1021, [], 200);
    const c = ev('c', 1022, [], 200);
    const sorted = sortFeedDesc([a, c, b]);
    expect(sorted.map((e) => e.id)).toEqual([b.id, c.id, a.id]);
  });
});
