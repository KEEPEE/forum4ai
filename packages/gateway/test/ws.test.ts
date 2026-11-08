/**
 * Unit testy WS /ws (S5) — protokolová vrstva bez siete: parser správ
 * (`parseClientMessage`, `validateFilter`) a `WsSession` nad mock poolom
 * (REQ → EVENT/EOSE doručovanie, CLOSE → unsubscribe, limity, NOTICE).
 */
import { describe, expect, it } from 'vitest';
import type { Event } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';

import {
  WsSession,
  parseClientMessage,
  validateFilter,
  WS_MAX_SUBSCRIPTIONS,
  ConnectionBudget,
  WS_MAX_CONNECTIONS_PER_IP_DEFAULT,
  WS_MAX_FILTER_LIMIT,
  WS_MAX_FILTERS,
  type WsPool,
  type WsServerMessage,
} from '../src/ws.js';

function ev(id: string): Event {
  return {
    id,
    pubkey: 'a'.repeat(64),
    created_at: 1_700_000_000,
    kind: 30020,
    tags: [],
    content: 'x',
    sig: 'b'.repeat(128),
  };
}

// ── parser ────────────────────────────────────────────────────────────────

describe('parseClientMessage', () => {
  it('REQ s jedným filtrom', () => {
    const msg = parseClientMessage(JSON.stringify(['REQ', 'sub-1', { kinds: [30020] }]));
    expect(msg).toEqual({ type: 'req', subId: 'sub-1', filters: [{ kinds: [30020] }] });
  });

  it('REQ s viacerými filtrmi', () => {
    const msg = parseClientMessage(
      JSON.stringify(['REQ', 's', { kinds: [1020] }, { authors: ['a'.repeat(64)] }]),
    );
    expect(msg.type).toBe('req');
    if (msg.type === 'req') expect(msg.filters).toHaveLength(2);
  });

  it('REQ s prázdny filter {} je povolený (match-všetko)', () => {
    const msg = parseClientMessage(JSON.stringify(['REQ', 's', {}]));
    expect(msg.type).toBe('req');
  });

  it('CLOSE', () => {
    expect(parseClientMessage(JSON.stringify(['CLOSE', 'sub-1']))).toEqual({
      type: 'close',
      subId: 'sub-1',
    });
  });

  it('neplatný JSON → invalid', () => {
    const msg = parseClientMessage('{to nie je json');
    expect(msg.type).toBe('invalid');
  });

  it('nepoleová správa → invalid', () => {
    expect(parseClientMessage('{"a":1}').type).toBe('invalid');
    expect(parseClientMessage('[]').type).toBe('invalid');
    expect(parseClientMessage('["REQ"]').type).toBe('invalid');
  });

  it('neznámy verb → invalid', () => {
    const msg = parseClientMessage(JSON.stringify(['EVENT', 's', {}]));
    expect(msg.type).toBe('invalid');
    if (msg.type === 'invalid') expect(msg.reason).toMatch(/REQ\/CLOSE/);
  });

  it('sub_id musí byť neprázdny retazec do 64 znakov', () => {
    expect(parseClientMessage(JSON.stringify(['REQ', '', { kinds: [1] }])).type).toBe('invalid');
    expect(parseClientMessage(JSON.stringify(['REQ', 42, { kinds: [1] }])).type).toBe('invalid');
    expect(
      parseClientMessage(JSON.stringify(['REQ', 'x'.repeat(65), { kinds: [1] }])).type,
    ).toBe('invalid');
  });

  it('REQ bez filtra → invalid', () => {
    expect(parseClientMessage(JSON.stringify(['REQ', 's'])).type).toBe('invalid');
  });

  it('neplatný filter → invalid s dôvodom', () => {
    const msg = parseClientMessage(JSON.stringify(['REQ', 's', { kinds: ['abc'] }]));
    expect(msg.type).toBe('invalid');
    if (msg.type === 'invalid') expect(msg.reason).toMatch(/kinds/);
  });
});

describe('validateFilter', () => {
  it('platné filtre prejdú', () => {
    const ok: Filter[] = [
      {},
      { ids: ['a'.repeat(64)] },
      { kinds: [1020, 30020], since: 1, until: 2, limit: 10 },
      { '#e': ['a'.repeat(64)], '#a': ['30020:x:y'], '#d': ['slug'] },
      { '#tag': ['hodnota'] },
    ];
    for (const filter of ok) expect(validateFilter(filter, 'f')).toBeNull();
  });

  it('nepoznaný kľúč odmietne', () => {
    expect(validateFilter({ blabot: 1 }, 'f')).toMatch(/unknown filter key/);
  });

  it('zlé typy odmietne', () => {
    expect(validateFilter({ ids: 'x' }, 'f')).toMatch(/ids/);
    expect(validateFilter({ kinds: [1.5] }, 'f')).toMatch(/kinds/);
    expect(validateFilter({ limit: '10' }, 'f')).toMatch(/limit/);
    expect(validateFilter({ '#e': 'x' }, 'f')).toMatch(/#e/);
    expect(validateFilter(null, 'f')).toMatch(/JSON object/);
    expect(validateFilter([], 'f')).toMatch(/JSON object/);
  });
});

// ── session ───────────────────────────────────────────────────────────────

interface MockSub {
  filters: Filter[];
  onEvent: (event: Event, relayUrl: string) => void;
  onEose: (() => void) | undefined;
  unsubscribed: boolean;
}

class MockWsPool implements WsPool {
  readonly subs: MockSub[] = [];
  subscribeCalls = 0;

  subscribe(
    filters: Filter[],
    callback: (event: Event, relayUrl: string) => void,
    opts?: { onEose?: () => void },
  ): () => void {
    this.subscribeCalls += 1;
    const sub: MockSub = {
      filters,
      onEvent: callback,
      onEose: opts?.onEose,
      unsubscribed: false,
    };
    this.subs.push(sub);
    return () => {
      sub.unsubscribed = true;
    };
  }

  emit(subIndex: number, event: Event): void {
    this.subs[subIndex]?.onEvent(event, 'ws://mock/');
  }

  emitEose(subIndex: number): void {
    this.subs[subIndex]?.onEose?.();
  }
}

function makeSession(limits?: { maxSubscriptions: number }): {
  session: WsSession;
  pool: MockWsPool;
  sent: WsServerMessage[];
} {
  const pool = new MockWsPool();
  const sent: WsServerMessage[] = [];
  const session = new WsSession((message) => sent.push(message), pool, limits);
  return { session, pool, sent };
}

const REQ = (subId: string, filter: unknown = { kinds: [30020] }): string =>
  JSON.stringify(['REQ', subId, filter]);

describe('WsSession', () => {
  it('REQ → EVENT a EOSE doručené s správnym sub_id', () => {
    const { session, pool, sent } = makeSession();
    session.handleMessage(REQ('s1'));
    expect(pool.subs).toHaveLength(1);
    // A3 (P0): aj filter bez `limit`u dostane explicitný strop — relay by
    // inokedy ticho orezol match-all dopyt na svoj vlastný max_limit
    expect(pool.subs[0]?.filters).toEqual([{ kinds: [30020], limit: WS_MAX_FILTER_LIMIT }]);

    pool.emit(0, ev('e1'));
    pool.emitEose(0);
    expect(sent).toEqual([
      ['EVENT', 's1', expect.objectContaining({ id: 'e1' })],
      ['EOSE', 's1'],
    ]);
  });

  it('synchronný onEose pri subscribe sa nestratí (registračný order bug)', () => {
    const pool = new MockWsPool();
    // pool zavolá onEose hneď v tele subscribe() — ako skutočný pool bez relayov
    const eagerPool: WsPool = {
      subscribe: (filters, cb, opts) => {
        const unsub = pool.subscribe(filters, cb, opts);
        opts?.onEose?.();
        return unsub;
      },
    };
    const sent: WsServerMessage[] = [];
    const session = new WsSession((m) => sent.push(m), eagerPool);
    session.handleMessage(REQ('s1'));
    expect(sent).toEqual([['EOSE', 's1']]);
  });

  it('CLOSE unsubscribe a ďalšie eventy sa nepošlú', () => {
    const { session, pool, sent } = makeSession();
    session.handleMessage(REQ('s1'));
    session.handleMessage(JSON.stringify(['CLOSE', 's1']));
    expect(pool.subs[0]?.unsubscribed).toBe(true);
    expect(session.subscriptionCount).toBe(0);

    pool.emit(0, ev('e1'));
    pool.emitEose(0);
    expect(sent).toEqual([]);
  });

  it('CLOSE neznámeho sub_id je idempotentný bez NOTICE', () => {
    const { session, sent } = makeSession();
    session.handleMessage(JSON.stringify(['CLOSE', 'nic']));
    expect(sent).toEqual([]);
  });

  it('po CLOSE možno použiť ten istý sub_id znova', () => {
    const { session, pool, sent } = makeSession();
    session.handleMessage(REQ('s1'));
    session.handleMessage(JSON.stringify(['CLOSE', 's1']));
    session.handleMessage(REQ('s1'));
    expect(pool.subs).toHaveLength(2);
    pool.emitEose(1);
    expect(sent).toEqual([['EOSE', 's1']]);
  });

  it('duplicitný sub_id → NOTICE a žiadne duplicitné subscribe', () => {
    const { session, pool, sent } = makeSession();
    session.handleMessage(REQ('s1'));
    session.handleMessage(REQ('s1'));
    expect(pool.subscribeCalls).toBe(1);
    expect(sent).toEqual([['NOTICE', expect.stringContaining('already exists')] as WsServerMessage]);
  });

  it('limit 5 subscriptionov: 6. REQ → NOTICE, subscribe volané 5x', () => {
    const { session, pool, sent } = makeSession();
    for (let i = 0; i < WS_MAX_SUBSCRIPTIONS + 1; i += 1) {
      session.handleMessage(REQ(`s${String(i)}`));
    }
    expect(pool.subscribeCalls).toBe(WS_MAX_SUBSCRIPTIONS);
    expect(session.subscriptionCount).toBe(WS_MAX_SUBSCRIPTIONS);
    const last = sent[sent.length - 1];
    expect(last?.[0]).toBe('NOTICE');
    expect(String(last?.[1])).toMatch(/limit/);
  });

  it('limit je nastaviteľný', () => {
    const { session, pool } = makeSession({ maxSubscriptions: 1 });
    session.handleMessage(REQ('a'));
    session.handleMessage(REQ('b'));
    expect(pool.subscribeCalls).toBe(1);
  });

  it('neplatná správa → NOTICE, session beďalej', () => {
    const { session, sent } = makeSession();
    session.handleMessage('blbost');
    expect(sent).toEqual([['NOTICE', expect.stringContaining('invalid JSON')]]);
    session.handleMessage(REQ('s1'));
    expect(session.subscriptionCount).toBe(1);
  });

  it('closeAll zruší všetky subs a ďalšie správy ignoruje', () => {
    const { session, pool, sent } = makeSession();
    session.handleMessage(REQ('s1'));
    session.handleMessage(REQ('s2'));
    session.closeAll();
    expect(pool.subs.every((s) => s.unsubscribed)).toBe(true);
    expect(session.subscriptionCount).toBe(0);

    session.handleMessage(REQ('s3'));
    expect(pool.subscribeCalls).toBe(2);
    expect(sent).toEqual([]);
  });

  it('event z jedného subu sa nedostane do druhého', () => {
    const { session, pool, sent } = makeSession();
    session.handleMessage(REQ('s1', { kinds: [1020] }));
    session.handleMessage(REQ('s2', { kinds: [30020] }));
    pool.emit(1, ev('e-x'));
    expect(sent).toEqual([['EVENT', 's2', expect.objectContaining({ id: 'e-x' })]]);
  });

  // ── regression C3 ────────────────────────────────────────────────────────

  it('limit filtra sa crpi na max_limit (match-all { } nesiahne cely store)', () => {
    const { session, pool } = makeSession();
    session.handleMessage(REQ('s1', { limit: 1_000_000 }));
    expect(pool.subs[0]?.filters).toEqual([{ limit: WS_MAX_FILTER_LIMIT }]);
    // nizsi limit sa nesaha
    session.handleMessage(REQ('s2', { kinds: [1020], limit: 10 }));
    expect(pool.subs[1]?.filters).toEqual([{ kinds: [1020], limit: 10 }]);
  });

  it('REQ s viac filtrami nad stropom → NOTICE (C3)', () => {
    const { session, pool, sent } = makeSession();
    const many = ['REQ', 's1', ...Array.from({ length: WS_MAX_FILTERS + 1 }, () => ({ kinds: [1020] }))];
    session.handleMessage(JSON.stringify(many));
    expect(sent).toEqual([['NOTICE', expect.stringContaining(`the maximum is ${String(WS_MAX_FILTERS)}`)]]);
    expect(pool.subscribeCalls).toBe(0);
    // presny strop prejde
    const exact = ['REQ', 's2', ...Array.from({ length: WS_MAX_FILTERS }, () => ({ kinds: [1020] }))];
    session.handleMessage(JSON.stringify(exact));
    expect(pool.subscribeCalls).toBe(1);
  });
});

// ── A3 (P0, security review): rozpočet WS spojení na IP ─────────────────────

describe('ConnectionBudget — maxConnectionsPerIp (A3, P0)', () => {
  it('štandardný strop 4: 4 povolené, 5. zamietnutá s dôvodom', () => {
    const budget = new ConnectionBudget();
    for (let i = 0; i < WS_MAX_CONNECTIONS_PER_IP_DEFAULT; i += 1) {
      expect(budget.acquire('203.0.113.7').ok, `spojenie ${String(i)}`).toBe(true);
    }
    const fifth = budget.acquire('203.0.113.7');
    expect(fifth.ok).toBe(false);
    if (!fifth.ok) {
      expect(fifth.reason).toContain('max_connections_per_ip');
      expect(fifth.reason).toContain('203.0.113.7');
    }
    expect(budget.countFor('203.0.113.7')).toBe(WS_MAX_CONNECTIONS_PER_IP_DEFAULT);
    expect(budget.total).toBe(WS_MAX_CONNECTIONS_PER_IP_DEFAULT);
  });

  it('zamietnuté spojenie NEZAPočíta (inak by sa rozpočet neúmyselne čerpal)', () => {
    const budget = new ConnectionBudget({ maxPerIp: 1 });
    expect(budget.acquire('1.1.1.1').ok).toBe(true);
    for (let i = 0; i < 5; i += 1) expect(budget.acquire('1.1.1.1').ok).toBe(false);
    expect(budget.countFor('1.1.1.1')).toBe(1);
    expect(budget.total).toBe(1);
  });

  it('iný klient (IP) má vlastný rozpočet — read-only návštevníkov to neobmedzí', () => {
    const budget = new ConnectionBudget({ maxPerIp: 2 });
    expect(budget.acquire('10.0.0.1').ok).toBe(true);
    expect(budget.acquire('10.0.0.1').ok).toBe(true);
    expect(budget.acquire('10.0.0.1').ok).toBe(false);
    expect(budget.acquire('10.0.0.2').ok).toBe(true);
  });

  it('release uvoľní miesto; double-release nezvýši záporný počet', () => {
    const budget = new ConnectionBudget({ maxPerIp: 1 });
    expect(budget.acquire('10.0.0.1').ok).toBe(true);
    expect(budget.acquire('10.0.0.1').ok).toBe(false);
    budget.release('10.0.0.1');
    expect(budget.countFor('10.0.0.1')).toBe(0);
    expect(budget.total).toBe(0);
    budget.release('10.0.0.1');
    expect(budget.total).toBe(0);
    expect(budget.acquire('10.0.0.1').ok).toBe(true);
  });

  it('globálny strop maxTotal má prednosť a pri zamietnutí nepoškodí IP kľúč', () => {
    const budget = new ConnectionBudget({ maxPerIp: 10, maxTotal: 2 });
    expect(budget.acquire('10.0.0.1').ok).toBe(true);
    expect(budget.acquire('10.0.0.2').ok).toBe(true);
    const denied = budget.acquire('10.0.0.3');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toContain('max_connections 2');
    expect(budget.countFor('10.0.0.3')).toBe(0);
    expect(budget.total).toBe(2);
  });

  it('maxPerIp=0 a maxTotal=0 = neobmedzene (žiadne zamietnutia)', () => {
    const budget = new ConnectionBudget({ maxPerIp: 0, maxTotal: 0 });
    for (let i = 0; i < 100; i += 1) expect(budget.acquire('9.9.9.9').ok).toBe(true);
    expect(budget.total).toBe(100);
  });

  it('kľúče IP majú LRU strop (rotujúce IPv6 nezaplnia pamäť)', () => {
    const budget = new ConnectionBudget({ maxPerIp: 5, maxKeys: 10 });
    for (let i = 0; i < 200; i += 1) budget.acquire(`2001:db8:${String(i)}::`);
    expect(budget.countFor('2001:db8:0::')).toBe(0);
    expect(budget.countFor('2001:db8:199::')).toBe(1);
    // uvoľnenie neexistujúceho kľúča je bezpečné
    budget.release('2001:db8:0::');
  });

  it('default konštanty zodpovedajú dokumentácii (4 na IP)', () => {
    expect(WS_MAX_CONNECTIONS_PER_IP_DEFAULT).toBe(4);
    const budget = new ConnectionBudget();
    expect(budget.acquire('::1').ok).toBe(true);
  });
});

describe('A3 (P0): filter `limit` sa crpi VŽDY (aj keď chýba)', () => {
  function sessionWithLimits(limits: { maxFilterLimit?: number }) {
    const pool = new MockWsPool();
    const sent: WsServerMessage[] = [];
    const session = new WsSession((message) => sent.push(message), pool, limits);
    return { session, pool, sent };
  }

  it('filter bez `limit`u dostane explicitný strop (relay by inokedy orezal ticho)', () => {
    const { session, pool } = sessionWithLimits({});
    session.handleMessage(REQ('s1', {}));
    expect(pool.subs[0]?.filters).toEqual([{ limit: WS_MAX_FILTER_LIMIT }]);
  });

  it('`limit` nad stropom sa crpi na strop', () => {
    const { session, pool } = sessionWithLimits({});
    session.handleMessage(REQ('s1', { limit: 1_000_000 }));
    expect(pool.subs[0]?.filters).toEqual([{ limit: WS_MAX_FILTER_LIMIT }]);
  });

  it('`limit` pod stropom sa ponecháva (klient vie, čo chce)', () => {
    const { session, pool } = sessionWithLimits({});
    session.handleMessage(REQ('s1', { limit: 5 }));
    expect(pool.subs[0]?.filters).toEqual([{ limit: 5 }]);
  });

  it('`limit` 0 a záporný sa crpia na strop (nie sú platný dopyt)', () => {
    const { session, pool } = sessionWithLimits({});
    session.handleMessage(REQ('s1', { limit: 0 }));
    session.handleMessage(REQ('s2', { limit: -10 }));
    expect(pool.subs[0]?.filters).toEqual([{ limit: WS_MAX_FILTER_LIMIT }]);
    expect(pool.subs[1]?.filters).toEqual([{ limit: WS_MAX_FILTER_LIMIT }]);
  });

  it('rešpektuje nastavený maxFilterLimit (inštancia s nižším stropom relaye)', () => {
    const { session, pool } = sessionWithLimits({ maxFilterLimit: 50 });
    session.handleMessage(REQ('s1', {}));
    session.handleMessage(REQ('s2', { limit: 500 }));
    expect(pool.subs[0]?.filters).toEqual([{ limit: 50 }]);
    expect(pool.subs[1]?.filters).toEqual([{ limit: 50 }]);
  });

  it('crpienie sa dotkne KAŽDÉHO filtra REQu (nie len prvého)', () => {
    const { session, pool } = sessionWithLimits({});
    session.handleMessage(
      JSON.stringify(['REQ', 's1', { kinds: [30020] }, { authors: ['a'.repeat(64)] }, { limit: 3 }]),
    );
    expect(pool.subs[0]?.filters).toEqual([
      { kinds: [30020], limit: WS_MAX_FILTER_LIMIT },
      { authors: ['a'.repeat(64)], limit: WS_MAX_FILTER_LIMIT },
      { limit: 3 },
    ]);
  });
});
