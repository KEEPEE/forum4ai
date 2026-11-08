/**
 * Unit testy RelayPool — bez siete. Pool dostane `connector`, ktorý
 * vracia fake relaye (tvár `RelayLike`), takže reconnect, backoff,
 * publish výsledky a subscribe fan-out testujeme deterministicky.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Event } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';

import {
  DEFAULT_DEV_RELAY_URLS,
  RelayPool,
  TRANSIENT_FAILURE_MESSAGE,
  normalizeRelayUrl,
  parseRelayUrls,
  type RelayConnector,
  type RelayLike,
  type SubscribeHandlers,
  type SubscriptionLike,
} from '../src/relay-pool.js';

const URL_A = 'ws://relay-a.example';
const URL_B = 'ws://relay-b.example';

function ev(id: string, kind = 1020): Event {
  return {
    id,
    pubkey: 'a'.repeat(64),
    created_at: 1_700_000_000,
    kind,
    tags: [],
    content: 'test',
    sig: 'b'.repeat(128),
  };
}

class FakeRelay implements RelayLike {
  readonly url: string;
  connected = true;
  closed = false;
  onclose: (() => void) | null = null;
  readonly subs: { key: string; filters: Filter[]; handlers: SubscribeHandlers }[] = [];
  private readonly publishImpl: (event: Event) => Promise<string>;

  constructor(url: string, publishImpl?: (event: Event) => Promise<string>) {
    this.url = url;
    this.publishImpl = publishImpl ?? (async () => 'accepted: event uložený');
  }

  async publish(event: Event): Promise<string> {
    if (!this.connected) throw new Error('Tried to send message on a closed connection');
    return this.publishImpl(event);
  }

  subscribe(filters: Filter[], params: SubscribeHandlers & { id?: string }): SubscriptionLike {
    const entry = { key: params.id ?? `sub-${String(this.subs.length)}`, filters, handlers: params };
    this.subs.push(entry);
    return {
      close: () => {
        const i = this.subs.indexOf(entry);
        if (i >= 0) this.subs.splice(i, 1);
      },
    };
  }

  close(): void {
    this.closed = true;
    this.connected = false;
  }

  /** simulácia tvrdého uzavretia spojenia (WS padol → nostr-tools privolá onclose) */
  hardClose(): void {
    this.connected = false;
    this.onclose?.();
  }

  emitEvent(event: Event): void {
    for (const sub of [...this.subs]) sub.handlers.onevent?.(event);
  }

  emitEose(): void {
    for (const sub of [...this.subs]) sub.handlers.oneose?.();
  }

  /** per-sub close: skutočný relay privolá onclose kažnej subs pri zániku spojenia */
  emitSubClose(reason = 'connection closed'): void {
    for (const sub of [...this.subs]) {
      const i = this.subs.indexOf(sub);
      if (i >= 0) this.subs.splice(i, 1);
      sub.handlers.onclose?.(reason);
    }
  }
}

/** factory, ktorý si pamätá vytvorené relaye (prvý = created[0], …) */
function factory(
  make: (url: string, index: number) => Promise<RelayLike> = async (url) => new FakeRelay(url),
): { connector: RelayConnector; created: RelayLike[] } {
  const created: RelayLike[] = [];
  return {
    created,
    connector: async (url) => {
      const relay = await make(url, created.length);
      created.push(relay);
      return relay;
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Počka na splnenie podmienky (poll, strop `timeoutMs`).
 *
 * Prečo nie pevné `sleep(80)`: backoff timery poolu sú reálne `setTimeout`
 * (5/10/20 ms), ale pri vyťaženom event loop-e (paralelné vitest workere)
 * sa timer mešá aj o desiatky ms → pevné okno bolo **flaky**. Pevné spanie
 * je preto schedulerová citlivosť, nie citlivosť assertu. Tento helper
 * ponecháva všetky asserty presne rovnaké (len posunie okamih merania) a
 * pri skutočnej regresii padne po 2 s s jasnou správou.
 */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
  what = 'podmienka',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitUntil: ${what} nebola splnená do ${String(timeoutMs)}ms`);
    }
    await sleep(5);
  }
}

let pool: RelayPool | null = null;
afterEach(() => {
  pool?.close();
  pool = null;
});

describe('normalizácia a parse relay URL', () => {
  it('normalizeRelayUrl kanonizuje a pri neplatnej URL vráti null', () => {
    expect(normalizeRelayUrl('ws://relay.example/')).toBe('ws://relay.example/');
    expect(normalizeRelayUrl('ws://relay.example')).toBe('ws://relay.example/');
    expect(normalizeRelayUrl('this is not a url')).toBeNull();
  });

  // regression A2 (SSRF): nostr-tools `normalizeURL` NErieši schému —
  // http ticho prepíše na ws a ftp pustí; pool musí akceptovať len ws/wss
  it('normalizeRelayUrl odmietne nows schémy (A2 SSRF)', () => {
    expect(normalizeRelayUrl('wss://relay.example')).toBe('wss://relay.example/');
    expect(normalizeRelayUrl('http://relay.example')).toBeNull();
    expect(normalizeRelayUrl('https://relay.example')).toBeNull();
    expect(normalizeRelayUrl('ftp://relay.example')).toBeNull();
    expect(normalizeRelayUrl('ws://169.254.169.254/latest/meta-data')).toBe(
      'ws://169.254.169.254/latest/meta-data',
    );
    expect(parseRelayUrls('http://evil.example, ws://good.example', [])).toEqual([
      'ws://good.example/',
    ]);
  });

  it('parseRelayUrls delí čiarkou aj medzerou, deduplikuje a fallbackuje', () => {
    expect(parseRelayUrls(`${URL_A}, ${URL_B}`, [...DEFAULT_DEV_RELAY_URLS])).toEqual([
      `${URL_A}/`,
      `${URL_B}/`,
    ]);
    expect(parseRelayUrls(`${URL_A} ${URL_A}`, [URL_B])).toEqual([`${URL_A}/`]);
    expect(parseRelayUrls('   ', [URL_B])).toEqual([`${URL_B}/`]);
    expect(parseRelayUrls(undefined, [...DEFAULT_DEV_RELAY_URLS])).toEqual([
      'ws://127.0.0.1:18080/',
      'ws://127.0.0.1:18008/',
    ]);
  });

  it('default dev relaye sú dve (náš relay s politikou + strfry)', () => {
    expect(DEFAULT_DEV_RELAY_URLS).toEqual([
      'ws://127.0.0.1:18080',
      'ws://127.0.0.1:18008',
    ]);
  });
});

describe('connect, health status a reconnect s backoffom', () => {
  it('connectAll pripojí všetky relaye a status sedí', async () => {
    const f = factory();
    pool = new RelayPool({ urls: [URL_A, URL_B], connector: f.connector });

    const statuses = await pool.connectAll();
    expect(statuses).toHaveLength(2);
    expect(statuses.every((s) => s.connected)).toBe(true);
    expect(pool.readyRelays().sort()).toEqual([`${URL_A}/`, `${URL_B}/`]);
    for (const status of statuses) {
      expect(status.attempts).toBe(0);
      expect(status.lastError).toBeNull();
      expect(status.lastConnectedAt).toBeGreaterThan(0);
    }
  });

  it('neúspešný connect → attempts, backoff okno a automatický retry', async () => {
    let calls = 0;
    pool = new RelayPool({
      urls: [URL_A],
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      random: () => 0.5, // jitter 1.0 → deterministické oneskorenie
      connector: async (url) => {
        calls += 1;
        if (calls < 3) throw new Error('ECONNREFUSED');
        return new FakeRelay(url);
      },
    });

    const attemptStartedAt = Date.now();
    const [first] = await pool.connectAll();
    expect(first?.connected).toBe(false);
    expect(first?.attempts).toBe(1);
    expect(first?.lastError).toBe('ECONNREFUSED');
    // Backoff okno sa MUSÍ otvoriť až v budúcnosti. Referenčný bod je
    // okamih snahy, nie `Date.now()` namerané až po `await` — pri
    // initialBackoffMs 5 ms by porovnanie s živými hodinami hádzalo mincu
    // (okno sa stihne zavrieť skôr, než test dočíta riadok). Asserty
    // ostávajú prísne: okno je v budúcnosti a neprekročí maxBackoff×jitter.
    const windowMs = (first?.nextAttemptAt ?? 0) - attemptStartedAt;
    expect(windowMs).toBeGreaterThan(0);
    expect(windowMs).toBeLessThanOrEqual(20);

    // pool si naplánoval retry sám — za backoff oknom sa MUSÍ pripojiť.
    // Poll s 2 s stropom (nie pevné sleep(80)): asserty ostávajú prísne,
    // elasticita je len v okamihu merania → žiadna schedulerová flakiness.
    const retryPool = pool;
    await waitUntil(
      () => retryPool.status()[0]?.connected === true,
      2_000,
      'relay sa po backoffe automaticky pripojil',
    );
    const [after] = pool.status();
    expect(after?.connected).toBe(true);
    expect(after?.attempts).toBe(0);
    expect(after?.lastError).toBeNull();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('backoff je exponenciálny a orezaný na maxBackoffMs', async () => {
    let nowMs = 1_000_000;
    pool = new RelayPool({
      urls: [URL_A],
      initialBackoffMs: 100,
      maxBackoffMs: 400,
      random: () => 0.5,
      now: () => nowMs,
      connector: async () => {
        throw new Error('down');
      },
    });

    const delays: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      await pool.ensure(URL_A);
      const [status] = pool.status();
      delays.push((status?.nextAttemptAt ?? 0) - nowMs);
      nowMs += 10_000; // preskoč backoff okno, ďalšie ensure prebehne
    }
    // 100 → 200 → 400 → strop 400 → 400
    expect(delays).toEqual([100, 200, 400, 400, 400]);
  });

  it('hard-close spustí reconnect a resubscripciu na novom spojení', async () => {
    const f = factory();
    pool = new RelayPool({
      urls: [URL_A],
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      random: () => 0.5,
      connector: f.connector,
    });
    await pool.connectAll();

    const received: { id: string; relayUrl: string }[] = [];
    pool.subscribe([{ kinds: [1020] }], (event, relayUrl) => {
      received.push({ id: event.id, relayUrl });
    });
    expect((f.created[0] as FakeRelay).subs).toHaveLength(1);

    // spojenie padne → pool naplánuje retry
    (f.created[0] as FakeRelay).hardClose();
    // opäť poll namiesto pevného sleep(80) — reconnect + resubscripcia
    // musia prebehnúť do 2 s, inak je to regulárna regresia
    await waitUntil(
      () => {
        if (f.created.length < 2) return false;
        const latest = f.created[f.created.length - 1] as FakeRelay;
        return latest.connected && latest.subs.length === 1;
      },
      2_000,
      'reconnect a resubscripcia na novom spojení',
    );

    expect(f.created.length).toBeGreaterThanOrEqual(2);
    const fresh = f.created[f.created.length - 1] as FakeRelay;
    expect(fresh.connected).toBe(true);
    // sub sa musel prihlásiť znova na novom spojení
    expect(fresh.subs).toHaveLength(1);

    fresh.emitEvent(ev('c'.repeat(64)));
    expect(received).toEqual([{ id: 'c'.repeat(64), relayUrl: `${URL_A}/` }]);
  });

  it('close() zastaví ďalšie reconnecty', async () => {
    let calls = 0;
    pool = new RelayPool({
      urls: [URL_A],
      initialBackoffMs: 5,
      connector: async (url) => {
        calls += 1;
        return new FakeRelay(url);
      },
    });
    await pool.connectAll();
    expect(calls).toBe(1);

    pool.close();
    pool = null;
    await sleep(40);
    expect(calls).toBe(1);
  });
});

describe('publish — per-relay výsledky', () => {
  it('zhromaždí OK aj NOK bez hodu a v poradí cieľového zoznamu', async () => {
    pool = new RelayPool({
      urls: [URL_B, URL_A],
      connector: async (url) =>
        new FakeRelay(url, async (event) => {
          if (url.startsWith('ws://relay-b')) return Promise.reject(new Error('rejected: kind 4'));
          return `accepted: ${event.id.slice(0, 4)}`;
        }),
    });
    await pool.connectAll();

    const results = await pool.publish(ev('d'.repeat(64)));
    expect(results).toEqual([
      { url: `${URL_B}/`, ok: false, message: 'rejected: kind 4' },
      { url: `${URL_A}/`, ok: true, message: 'accepted: dddd' },
    ]);
  });

  // regression A2: publish na relay MIMO poolu (write relay autora z 30002)
  // sa robí krátkodobým spojením — pool sa NESMIE rozšíriť (žiadny
  // reconnect backoff, žiadny query/subscribe fan-out na cudzú URL)
  it('publish na relay mimo poolu: transientné spojenie, pool nerastie, domáce relaye tiež dostanú event', async () => {
    const f = factory();
    pool = new RelayPool({ urls: [URL_A], connector: f.connector });
    await pool.connectAll();

    const results = await pool.publish(ev('e'.repeat(64)), [URL_B]);
    // A2 pravidlo 1: konfigurované relays poolu sú VŽDY medzi cieľmi
    expect(results.map((r) => r.url)).toEqual([`${URL_B}/`, `${URL_A}/`]);
    expect(results.every((r) => r.ok)).toBe(true);
    // A2 pravidlo 2: cudzia URL sa do poolu NEDOSTANE
    expect(pool.urls).toEqual([`${URL_A}/`]);
    expect(pool.status().map((s) => s.url)).toEqual([`${URL_A}/`]);
    // ale transientné spojenie vzniklo a publish prebehol
    expect(f.created.map((r) => r.url)).toContain(`${URL_B}/`);
  });

  it('publishAuthorRelays=false: cudzie write relays sa preskočia, pool ostáva jediný cieľ', async () => {
    const f = factory();
    pool = new RelayPool({ urls: [URL_A], connector: f.connector, publishAuthorRelays: false });
    await pool.connectAll();

    const results = await pool.publish(ev('a'.repeat(64)), [URL_B]);
    expect(results).toEqual([
      { url: `${URL_B}/`, ok: false, message: 'skipped: relay mimo poolu' },
      { url: `${URL_A}/`, ok: true, message: 'accepted: event uložený' },
    ]);
    expect(f.created.map((r) => r.url)).not.toContain(`${URL_B}/`);
  });

  it('transientný publish zlyhanie → ok:false s dôvodom, pool ostáva čistý', async () => {
    pool = new RelayPool({
      urls: [URL_A],
      connector: async (url) => {
        if (url === `${URL_B}/`) throw new Error('ECONNREFUSED');
        return new FakeRelay(url);
      },
    });
    await pool.connectAll();

    const results = await pool.publish(ev('b'.repeat(64)), [URL_B]);
    const foreign = results.find((r) => r.url === `${URL_B}/`);
    expect(foreign?.ok).toBe(false);
    // A2 (P0): klient UVIDÍ len konštantný dôvod — text chyby cudzieho
    // relaya obsahuje host:port, čo je port-scanner do vnútornej siete
    expect(foreign?.message).toBe(TRANSIENT_FAILURE_MESSAGE);
    expect(foreign?.message).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|:1\d{4}/);
    expect(pool.urls).toEqual([`${URL_A}/`]);
  });

  it('nedostupný relay (backoff okno) → ok:false s dôvodom, nie hod', async () => {
    let first = true;
    pool = new RelayPool({
      urls: [URL_A],
      initialBackoffMs: 10_000,
      random: () => 0.5,
      connector: async (url) => {
        if (first) {
          first = false;
          throw new Error('ECONNREFUSED');
        }
        return new FakeRelay(url);
      },
    });
    await pool.connectAll();

    const results = await pool.publish(ev('f'.repeat(64)));
    expect(results).toEqual([
      { url: `${URL_A}/`, ok: false, message: 'not connected (ECONNREFUSED)' },
    ]);
  });
});

describe('subscribe fan-out a query', () => {
  it('fan-out doručí každý unikátny event práve raz (deduplikácia id)', async () => {
    const f = factory();
    pool = new RelayPool({ urls: [URL_A, URL_B], connector: f.connector });
    await pool.connectAll();

    const seen: string[] = [];
    const unsubscribe = pool.subscribe([{ kinds: [1020] }], (event) => {
      seen.push(event.id);
    });

    const relays = f.created as FakeRelay[];
    expect(relays).toHaveLength(2);
    const shared = ev('1'.repeat(64));
    for (const relay of relays) relay.emitEvent(shared);
    relays[1]?.emitEvent(shared); // duplikát z druhého relaya
    relays[1]?.emitEvent(ev('2'.repeat(64)));

    expect(seen.sort()).toEqual(['1'.repeat(64), '2'.repeat(64)]);

    // unsubscribe odhlási všetky subs
    unsubscribe();
    for (const relay of relays) expect(relay.subs).toHaveLength(0);
    relays[0]?.emitEvent(ev('3'.repeat(64)));
    expect(seen).toHaveLength(2);
  });

  it('query zozbiera eventy z všetkých relayov po EOSE a deduplikuje', async () => {
    const f = factory();
    pool = new RelayPool({ urls: [URL_A, URL_B], connector: f.connector });
    await pool.connectAll();

    const relays = f.created as FakeRelay[];
    const promise = pool.query([{ kinds: [1020] }], { timeoutMs: 500 });
    // query je async — subscripcie musia byť vytvorené pred emitnutím
    await sleep(5);

    relays[0]?.emitEvent(ev('4'.repeat(64)));
    relays[1]?.emitEvent(ev('4'.repeat(64))); // duplikát
    relays[1]?.emitEvent(ev('5'.repeat(64)));
    relays[0]?.emitEose();
    relays[1]?.emitEose();

    const events = await promise;
    expect(events.map((e) => e.id).sort()).toEqual(['4'.repeat(64), '5'.repeat(64)]);
    // po dokončení query musia byť subs zavreté
    for (const relay of relays) expect(relay.subs).toHaveLength(0);
  });

  it('query bez spojených relayov vráti prázdne pole a neprekročí timeout', async () => {
    pool = new RelayPool({
      urls: [URL_A],
      initialBackoffMs: 10_000,
      random: () => 0.5,
      connector: async () => {
        throw new Error('down');
      },
    });
    await pool.connectAll();

    const started = Date.now();
    const events = await pool.query([{ kinds: [1020] }], { timeoutMs: 50 });
    expect(events).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('subscribe s onEose (S5 WS)', () => {
  it('onEose sa zavolá raz, keď všetky relaye dajú EOSE', async () => {
    const f = factory();
    pool = new RelayPool({ urls: [URL_A, URL_B], connector: f.connector });
    await pool.connectAll();

    let eoseCount = 0;
    pool.subscribe([{ kinds: [1020] }], () => undefined, { onEose: () => { eoseCount += 1; } });

    const relays = f.created as FakeRelay[];
    relays[0]?.emitEose();
    expect(eoseCount).toBe(0); // druhý relay ešte nedokončil
    relays[1]?.emitEose();
    expect(eoseCount).toBe(1);
    relays[0]?.emitEose(); // duplicitný EOSE → žiadne druhé zavolanie
    expect(eoseCount).toBe(1);
  });

  it('onEose ihneď, keď nie je pripojený žiadny relay (nič sa nedá čakať)', async () => {
    pool = new RelayPool({
      urls: [URL_A],
      initialBackoffMs: 10_000,
      random: () => 0.5,
      connector: async () => {
        throw new Error('down');
      },
    });
    await pool.connectAll();

    let eoseCount = 0;
    pool.subscribe([{ kinds: [1020] }], () => undefined, { onEose: () => { eoseCount += 1; } });
    expect(eoseCount).toBe(1);
  });

  it('onEose sa nezavolá po unsubscribe', async () => {
    const f = factory();
    pool = new RelayPool({ urls: [URL_A], connector: f.connector });
    await pool.connectAll();

    let eoseCount = 0;
    const unsubscribe = pool.subscribe([{ kinds: [1020] }], () => undefined, {
      onEose: () => { eoseCount += 1; },
    });
    unsubscribe();

    (f.created[0] as FakeRelay)?.emitEose();
    expect(eoseCount).toBe(0);
  });

  it('relay, ktorý zomrie pred EOSE, nepblokuje EOSE zvyšných', async () => {
    const f = factory();
    pool = new RelayPool({ urls: [URL_A, URL_B], connector: f.connector });
    await pool.connectAll();

    let eoseCount = 0;
    pool.subscribe([{ kinds: [1020] }], () => undefined, { onEose: () => { eoseCount += 1; } });

    const relays = f.created as FakeRelay[];
    relays[1]?.emitSubClose(); // B zomrel bez EOSE
    relays[0]?.emitEose(); // A dokončil → attached={A}, eosed={A}
    expect(eoseCount).toBe(1);
  });

  it('bez onEose volieb sa staré správanie nemení (subscribe 2 parametre)', async () => {
    const f = factory();
    pool = new RelayPool({ urls: [URL_A], connector: f.connector });
    await pool.connectAll();

    const seen: string[] = [];
    pool.subscribe([{ kinds: [1020] }], (event) => { seen.push(event.id); });
    (f.created[0] as FakeRelay)?.emitEvent(ev('9'.repeat(64)));
    (f.created[0] as FakeRelay)?.emitEose();
    expect(seen).toEqual(['9'.repeat(64)]);
  });
});
