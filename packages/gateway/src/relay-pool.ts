/**
 * RelayPool — manages connections to a list of NIP-01 relays for the gateway
 * (F4AI-10).
 *
 * Built on the `nostr-tools` `Relay` class (not a custom websocket): the pool
 * keeps per-relay state, takes care of reconnecting with exponential backoff
 * and jitter (nostr-tools `enableReconnect` is deliberately switched off so the
 * reconnect is ours — otherwise we would have no health status and no managed
 * resubscriptions), fans subscriptions out over all relays with deduplication
 * by `id` and re-subscribes the subs after a connection is restored.
 *
 * `publish()` collects per-relay results (OK/NOK) — it does not judge the quorum
 * here, that is the job of `quorum.ts` / the route.
 */
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';
import type { Event } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';
import { normalizeURL } from 'nostr-tools/utils';
import WebSocket from 'ws';

/**
 * Node WebSocket implementácia pre nostr-tools (dokumentovaný postup).
 *
 * DÔVOD, prečo `ws` a nie natívny `globalThis.WebSocket`: pri zlyhaní
 * spojenia (ECONNREFUSED) volá nostr-tools v `ws.onerror` `ws.close()`,
 * čo undici implementácia natívneho WebSocketu vyhodí ako ďalší `error`
 * event → rekurzia až po stack overflow a PÁD procesu. S balíkom `ws`
 * sa spojenie len čistě odmietne (`connection failed`) a gateway beží
 * ďalej — mŕtvy relay v zozname ho nezabije. Overené na mŕtvej adrese
 * ws://127.0.0.1:18999.
 */
useWebSocketImplementation(WebSocket);

/** Minimálna tvár nostr-tools `Relay` — umožňuje mocknúť pool v unit testoch. */
export interface SubscriptionLike {
  close(reason?: string): void;
}

export type SubscribeHandlers = {
  onevent?: (event: Event) => void;
  oneose?: () => void;
  onclose?: (reason: string) => void;
};

export interface RelayLike {
  readonly url: string;
  readonly connected: boolean;
  onclose: (() => void) | null;
  publish(event: Event): Promise<string>;
  subscribe(filters: Filter[], params: SubscribeHandlers & { id?: string }): SubscriptionLike;
  close(): void;
}

/** Fábrica na vytvorenie+connect relaya; default používa nostr-tools `Relay`. */
export type RelayConnector = (url: string) => Promise<RelayLike>;

export interface RelayStatus {
  url: string;
  /** F4AI-38: false = len na čítanie (objavený relay) */
  write?: boolean;
  /** F4AI-38: pridaný discovery, nie konfiguráciou */
  discovered?: boolean;
  connected: boolean;
  /** počet neúspešných pokusov o spojenie od posledného úspechu */
  attempts: number;
  /** kedy (ms epoch) sa smie pokúšať znova; 0 = okamžite */
  nextAttemptAt: number;
  lastError: string | null;
  lastConnectedAt: number | null;
}

export interface PublishResult {
  url: string;
  ok: boolean;
  /** OK správa relaya ('accepted: …') alebo dôvod zlyhania/NOK */
  message: string;
}

export interface RelayPoolOptions {
  /** počiatočný zoznam relayov (normalizujú sa `normalizeURL`) */
  urls: string[];
  connectTimeoutMs?: number;
  publishTimeoutMs?: number;
  eoseTimeoutMs?: number;
  /** default 500 ms — testy používajú malú hodnotu */
  initialBackoffMs?: number;
  /** default 60 000 ms */
  maxBackoffMs?: number;
  /** injectable pre unit testy (mock relaye bez siete) */
  connector?: RelayConnector;
  /** injectable hodiny (default Date.now) */
  now?: () => number;
  /** injectable jitter 0..1 (default Math.random) */
  random?: () => number;
  /**
   * A2 (P0): log pre detaily, ktoré klient nesmie vidieť — chyby cudzích
   * relays sa do odpovedí vracajú sanitizované (`TRANSIENT_FAILURE_MESSAGE`),
   * ale prevádzkovo ich potrebujeme.
   */
  logger?: (line: string) => void;
  /**
   * A2 (SSRF): publish na write relays MIMO poolu (z NIP-65 outboxu
   * autora) sa robí krátkodobým spojením, ktoré sa NIKDY nepridáva do
   * `managed` — bez reconnect backoffu, bez `query()`/`subscribe`
   * fan-outu, bez rastu `this.urls`. `false` úplne vypne publishovanie
   * na cudzie relays (všetko len do poolu). Default `true`.
   */
  publishAuthorRelays?: boolean;
  /**
   * F4AI-38: ako sa lišiace relaye objavené z `/nodes` zúčastňujú na
   * ČÍTANÍ. Default `failover` — configured relaye sú zdroj pravdy a cudzie
   * slúžia len keď žiadny konfigurovaný nie je pripojený. `always` =
   * fan-out do celej siete, `never` = objavy sú výhradne publish-cieľ.
   * Bez objavených relayov je rozdiel nulový (žiadna zmena správania).
   */
  discoveredReads?: 'never' | 'failover' | 'always';
}

interface ManagedRelay {
  url: string;
  relay: RelayLike | null;
  connecting: Promise<void> | null;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  lastConnectedAt: number | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** true po cielenom close() — potlačí reconnect */
  closing: boolean;
  /**
   * F4AI-38: smie sa na tomto relayi zapisovať. `false` majú objavy z
   * `/nodes` (cudzie relaye, ktoré len čítame) — `publish()` ich vynechá,
   * pokiaľ ich volajúci explicitovne nemenuje.
   */
  write: boolean;
  /** F4AI-38: pridali sme ho automatickým discovery (nie konfiguráciou) */
  discovered: boolean;
  /** ms epoch pridania (discovery má odhadovať stalosť) */
  addedAt: number;
}

interface PoolSubscription {
  seq: number;
  filters: Filter[];
  callback: (event: Event, relayUrl: string) => void;
  /** volané najviac raz: všetky práve pripojené relaye dali EOSE/zavreli */
  onEose: (() => void) | null;
  /** deduplikácia naprieč relaymi — prvý, kto event doručí, vyhráva */
  seen: Set<string>;
  /** per-relay aktívne subs (kľúč = url + per-sub id, kvôli resubscripcii) */
  active: Map<string, SubscriptionLike>;
  /** relaye, na ktorých je sub práve pripojený / ktoré už poslali EOSE */
  attached: Set<string>;
  eosed: Set<string>;
  eoseFired: boolean;
  removed: boolean;
}

/**
 * A2 (P0): jediná chyba, ktorú klient uvidí zlyhanie cudzieho relaya.
 * Text chyby (\`connect ECONNREFUSED 10.0.0.5:6379\`) prezrádza
 * vnútornú adresu aj port — s outbox eventom by z toho bol port-scanner.
 */
export const TRANSIENT_FAILURE_MESSAGE = 'transient: failed';

const DEFAULTS = {
  connectTimeoutMs: 5_000,
  publishTimeoutMs: 5_000,
  eoseTimeoutMs: 5_000,
  initialBackoffMs: 500,
  maxBackoffMs: 60_000,
} as const;

/**
 * Strop deduplikačnej množiny jednej subscripcie. `Set` si pamätá poradie
 * vkladania, takže pri prekročení hodia najstaršie id — dlhá subscripcia
 * tak nerastie do nekonečna (udalost, ktorú by sme teoreticky dostali
 * druhýkrát až po 10 000 eventoch, len zopakujeme doručenie).
 */
const MAX_SEEN_IDS = 10_000;

function rememberSeen(seen: Set<string>, id: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > MAX_SEEN_IDS) {
    const oldest = seen.values().next();
    if (!oldest.done) seen.delete(oldest.value);
  }
  return true;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * Normalizácia URL relaya; neplatná URL → null (namiesto hodu).
 *
 * A2 (SSRF): `normalizeURL` z nostr-tools 2.x NEkontroluje schému —
 * `http://…` ticho prepíše na `ws://…` a `ftp://…` pustí ďalej. Pool
 * preto explicitne vyžaduje `ws:`/`wss:`; ostatné schémy zahadzujeme,
 * aby event z dát autora (NIP-65 30002) nemohol priviesť gateway na
 * ľubovoľnú adresu (http/ftp/…).
 */
export function normalizeRelayUrl(url: string): string | null {
  try {
    // schému kontrolujeme na VSTUPE — `normalizeURL` vie http prepísať na
    // ws a tak by sa nepovolená schéma dostala cez kontrolu výstupu
    const protocol = new URL(url).protocol;
    if (protocol !== 'ws:' && protocol !== 'wss:') return null;
    const normalized = normalizeURL(url);
    if (!normalized.startsWith('ws://') && !normalized.startsWith('wss://')) return null;
    return normalized;
  } catch {
    return null;
  }
}

/**
 * Parse zoznamu relayov z env premenné (čiarka / medzera / nový riadok
 * ako oddeľovače). Prázdny vstup → fallback defaultov.
 */
export function parseRelayUrls(value: string | undefined, fallback: string[]): string[] {
  const raw = (value ?? '').split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  const source = raw.length > 0 ? raw : fallback;
  const out: string[] = [];
  for (const url of source) {
    const normalized = normalizeRelayUrl(url);
    if (normalized !== null && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * P1 (dizajn B4): jednorazové spojenie na CUDZIE relay pre registračný
 * probe. Na rozdiel od poolu sa tento relay NIKDY nedostane do `managed`
 * — žiadny reconnect, žiadny fan-out, žiadny vplyv na `pool.status()`.
 *
 * SSRF pravidlá (`wss://` + port 443 + DNS na verejnú IP) kontroluje
 * `registration.ts` PRED týmto volaním; tu len držíme tvrdý timeout
 * (dizajn: 5 s) a vypnutý reconnect, aby nám cudzí relay nemohol držať
 * spojenie donekonečna ani nás zaplavovať opätovanými pripojeniami.
 */
export async function connectOneShotRelay(
  url: string,
  timeoutMs: number = DEFAULTS.connectTimeoutMs,
): Promise<RelayLike> {
  const relay = await Relay.connect(url, { timeout: timeoutMs, enableReconnect: false });
  relay.publishTimeout = timeoutMs;
  relay.baseEoseTimeout = timeoutMs;
  return relay;
}

/**
 * Default dev relaye podľa zadania F4AI-10 (náš relay s politikou + strfry).
 */
export const DEFAULT_DEV_RELAY_URLS: readonly string[] = [
  'ws://127.0.0.1:18080',
  'ws://127.0.0.1:18008',
];

export class RelayPool {
  private readonly options: Required<
    Pick<
      RelayPoolOptions,
      'connectTimeoutMs' | 'publishTimeoutMs' | 'eoseTimeoutMs' | 'initialBackoffMs' | 'maxBackoffMs'
    >
  > & {
    connector: RelayConnector;
    now: () => number;
    random: () => number;
    publishAuthorRelays: boolean;
    discoveredReads: 'never' | 'failover' | 'always';
    logger: (line: string) => void;
  };

  private readonly managed = new Map<string, ManagedRelay>();
  private readonly subscriptions = new Set<PoolSubscription>();
  private subSeq = 0;
  private subCounter = 0;
  private closed = false;

  constructor(options: RelayPoolOptions) {
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
    const publishTimeoutMs = options.publishTimeoutMs ?? DEFAULTS.publishTimeoutMs;
    const eoseTimeoutMs = options.eoseTimeoutMs ?? DEFAULTS.eoseTimeoutMs;
    const initialBackoffMs = options.initialBackoffMs ?? DEFAULTS.initialBackoffMs;
    const maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    const now = options.now ?? (() => Date.now());
    const random = options.random ?? (() => Math.random());
    const connector: RelayConnector =
      options.connector ??
      (async (url) => {
        const relay = await Relay.connect(url, {
          timeout: connectTimeoutMs,
          // reconnect riadi pool sám (backoff + status + resubscripcie)
          enableReconnect: false,
        });
        relay.publishTimeout = publishTimeoutMs;
        relay.baseEoseTimeout = eoseTimeoutMs;
        return relay;
      });

    this.options = {
      connectTimeoutMs,
      publishTimeoutMs,
      eoseTimeoutMs,
      initialBackoffMs,
      maxBackoffMs,
      connector,
      now,
      random,
      publishAuthorRelays: options.publishAuthorRelays ?? true,
      discoveredReads: options.discoveredReads ?? 'failover',
      logger: options.logger ?? (() => undefined),
    };

    for (const url of options.urls) this.add(url);
  }

  /** normalizované URL všetkých relayov poolu (v poradí pridávania) */
  get urls(): string[] {
    return [...this.managed.keys()];
  }

  /**
   * Pridá relay do poolu (konštruktor). A2: toto je JEDINÁ cesta, ktorá
   * rozšíri `managed` — publish na cudzie URL pridaná nezvyšuje.
   */
  add(url: string, opts?: { write?: boolean; discovered?: boolean }): string | null {
    const normalized = normalizeRelayUrl(url);
    if (normalized === null || this.closed) return normalized;
    if (!this.managed.has(normalized)) {
      const m = this.addEntry(normalized, opts);
      void this.ensure(m.url);
    }
    return normalized;
  }

  /**
   * F4AI-38: vyhodí relay z poolu — uzavrie spojenie, zruší retry timer a
   * odpojí od neho subs. Discovery musí vedieť aj OBRÁTIŤ (miznúci seed),
   * inak by pool rástol donekonečna a s ním aj reconnect tlak na mŕtvych
   * peerov.
   */
  remove(url: string): boolean {
    const normalized = normalizeRelayUrl(url);
    if (normalized === null) return false;
    const m = this.managed.get(normalized);
    if (m === undefined) return false;
    m.closing = true;
    if (m.retryTimer !== null) {
      clearTimeout(m.retryTimer);
      m.retryTimer = null;
    }
    for (const sub of this.subscriptions) {
      for (const [key, active] of [...sub.active]) {
        if (!key.startsWith(`${normalized}#`)) continue;
        sub.active.delete(key);
        sub.attached.delete(normalized);
        sub.eosed.delete(normalized);
        try {
          active.close('relay removed');
        } catch {
          /* už zavreté */
        }
      }
    }
    try {
      m.relay?.close();
    } catch {
      /* už zavreté */
    }
    m.relay = null;
    this.managed.delete(normalized);
    return true;
  }

  /** URL, na ktoré sa píše (default cieľ `publish()`) */
  writeUrls(): string[] {
    return [...this.managed.values()].filter((m) => m.write).map((m) => m.url);
  }

  /** URL, z ktorých čítame (fan-out `query()` a `subscribe()`) */
  readUrls(): string[] {
    const all = [...this.managed.values()];
    const configured = all.filter((m) => !m.discovered);
    const discovered = all.filter((m) => m.discovered);
    if (discovered.length === 0 || this.options.discoveredReads === 'never') {
      return configured.map((m) => m.url);
    }
    if (this.options.discoveredReads === 'always') return all.map((m) => m.url);
    // failover: cudzie relaye sú záložný zdroj, nie druhé stanovisko
    const configuredReady = configured.some((m) => m.relay?.connected === true);
    return (configuredReady ? configured : all).map((m) => m.url);
  }

  /** URL, ktoré sme dostali konfiguráciou (žiadne discovery) */
  configuredUrls(): string[] {
    return [...this.managed.values()].filter((m) => !m.discovered).map((m) => m.url);
  }

  /** URL pridané discovery (pre diagnostiku a stropy discovery) */
  discoveredUrls(): string[] {
    return [...this.managed.values()].filter((m) => m.discovered).map((m) => m.url);
  }

  status(): RelayStatus[] {
    return [...this.managed.values()].map((m) => ({
      url: m.url,
      write: m.write,
      discovered: m.discovered,
      connected: m.relay?.connected === true,
      attempts: m.attempts,
      nextAttemptAt: m.nextAttemptAt,
      lastError: m.lastError,
      lastConnectedAt: m.lastConnectedAt,
    }));
  }

  /** URL relayov s aktívnym WS spojením */
  readyRelays(): string[] {
    return [...this.managed.values()]
      .filter((m) => m.relay?.connected === true)
      .map((m) => m.url);
  }

  /**
   * Pokusí sa pripojiť všetky relaye (paralelne) a vráti ich status.
   * Zlyhanie nepreháňa — pool beží aj s čiastočne dostupnými relaymi.
   */
  async connectAll(): Promise<RelayStatus[]> {
    await Promise.all([...this.managed.keys()].map((url) => this.ensure(url)));
    return this.status();
  }

  /**
   * Istota, že na `url` existuje spojenie (connectnow alebo rešpektuje
   * backoff okno). Vráti relay-like pri úspechu, inak null.
   *
   * A2: `ensure` UŽ nepridáva neznáme URL do poolu — členom `managed`
   * sa stáva len URL registrované konštruktorm / `add()`. Cudzie URL
   * (write relays z outboxu autora) idú cez `publishTransient`.
   */
  async ensure(url: string): Promise<RelayLike | null> {
    const normalized = normalizeRelayUrl(url);
    if (normalized === null) return null;
    const m = this.managed.get(normalized);
    if (!m) return null;
    if (m.closing || this.closed) return null;
    if (m.relay?.connected) return m.relay;
    if (m.connecting) {
      await m.connecting;
      return m.relay?.connected ? m.relay : null;
    }
    if (this.options.now() < m.nextAttemptAt) return null;

    const attempt = this.attemptConnect(m);
    m.connecting = attempt;
    try {
      await attempt;
    } finally {
      if (m.connecting === attempt) m.connecting = null;
    }
    return m.relay?.connected ? m.relay : null;
  }

  /**
   * Publish na zoznam relayov (default všetky). Nikdy nehádže — vráti
   * per-relay výsledky; kvórum posudzuje volajúci (`evaluateQuorum`).
   *
   * A2 (SSRF / pool pollution), dve pravidlá:
   *  1. Konfigurované relays poolu (`this.urls`) sú VŽDY medzi cieľmi —
   *     aj keď autor má v 30002 len vlastné relays, event sa nesmie
   *     dostať len k nim (inak by ho indexer nikdy nevidel).
   *  2. Cudzie URL (mimo `managed`) sa publikujú KRÁTKODOBÝM spojením
   *     (`publishTransient`) a nikdy sa nepridávajú do poolu — žiadny
   *     reconnect backoff, žiadny query/subscribe fan-out, žiadny
   *     neobmedzený rast `managed`. Vypnuteľné `publishAuthorRelays:false`.
   */
  async publish(event: Event, relays?: string[]): Promise<PublishResult[]> {
    const targets: string[] = [];
    const push = (url: string): void => {
      const normalized = normalizeRelayUrl(url);
      if (normalized !== null && !targets.includes(normalized)) targets.push(normalized);
    };
    // F4AI-38: default sú relaye, na ktoré SME oprávnení písať. Explicitne
    // menované URL sa berú tiež — ale NIKDY z cudzích objavených relayov:
    // `write:false` je prísľub, že cez objavený relay nič nepublishujeme,
    // aj keď si ho volajúci (napr. NIP-65 outbox autora) vypýta sám.
    const writable = (url: string): boolean => this.managed.get(url)?.write !== false;
    for (const url of relays ?? this.writeUrls()) {
      const normalized = normalizeRelayUrl(url);
      if (normalized !== null && !writable(normalized)) continue;
      push(url);
    }
    for (const url of this.writeUrls()) push(url);

    const results: PublishResult[] = [];
    await Promise.all(
      targets.map(async (url) => {
        if (!this.managed.has(url)) {
          if (!this.options.publishAuthorRelays || this.closed) {
            results.push({ url, ok: false, message: 'skipped: relay mimo poolu' });
            return;
          }
          results.push(await this.publishTransient(url, event));
          return;
        }
        const relay = await this.ensure(url);
        if (!relay) {
          const m = this.managed.get(url);
          results.push({
            url,
            ok: false,
            message: m?.lastError ? `not connected (${m.lastError})` : 'not connected',
          });
          return;
        }
        try {
          const message = await relay.publish(event);
          results.push({ url, ok: true, message });
        } catch (err) {
          results.push({ url, ok: false, message: errorMessage(err) });
        }
      }),
    );
    // deterministické poradie podľa cieľového zoznamu
    return targets.map((url) => results.find((r) => r.url === url) ?? { url, ok: false, message: 'not connected' });
  }

  /**
   * Krátkodobé pripojenie na cudzie URL len za účelom publishu; spojnie
   * sa ihneď zatvára a do `managed` sa nedostane nikdy (A2).
   *
   * A2 (P0): klientovi sa vráti LEN konštantný dôvod `transient: failed`.
   * Text chyby cudzieho relaya obsahuje `host:port` (napr.
   * `connect ECONNREFUSED 10.0.0.5:6379`) a `results[].message` ho posiela
   * späť — s outbox eventom (kind 30002, marker `w`) by to bol
   * port-scanner do vnútornej siete zadarmo. Detail ide do logu poolu.
   */
  private async publishTransient(url: string, event: Event): Promise<PublishResult> {
    let relay: RelayLike | null = null;
    try {
      relay = await this.options.connector(url);
      const message = await relay.publish(event);
      return { url, ok: true, message };
    } catch (err) {
      this.options.logger?.(
        `publish transient ${url} zlyhal: ${errorMessage(err)} (klientovi vraciam "${TRANSIENT_FAILURE_MESSAGE}")`,
      );
      return { url, ok: false, message: TRANSIENT_FAILURE_MESSAGE };
    } finally {
      try {
        relay?.close();
      } catch {
        /* už zavreté */
      }
    }
  }

  /**
   * Jednorázový query: subscribe na všetkých connected relayoch, zber
   * eventov (deduplikovaných) pokiaľ všetky nedajú EOSE alebo nevyprší
   * timeout. Vráti to, čo prišlo — nikdy nehádže.
   */
  async query(filters: Filter[], opts?: { timeoutMs?: number }): Promise<Event[]> {
    const timeoutMs = opts?.timeoutMs ?? this.options.eoseTimeoutMs;
    // C2: istota spojení PARALELNE — serialne `await` pridávalo ku každému
    // cold-startu N× connect timeout (mŕtvy relay spomalil KAŽDÉ čítanie)
    // F4AI-38 (P1 review): failover sa rozhoduje AŽ po pripojení konfigurovaných
    // relayov. `readUrls()` sa pýta na `connected`, ktoré je pri cold-starte
    // ešte false — rozhodnúť pred `ensure()` by poslalo čítanie do cudzích
    // relayov aj v prípade, že náš relay len práve vstáva.
    const relays: RelayLike[] = [];
    const configured = this.configuredUrls();
    for (const relay of await Promise.all(configured.map((url) => this.ensure(url)))) {
      if (relay) relays.push(relay);
    }
    if (relays.length === 0 && this.discoveredReadsAllowed()) {
      for (const relay of await Promise.all(this.discoveredUrls().map((url) => this.ensure(url)))) {
        if (relay) relays.push(relay);
      }
    }
    if (relays.length === 0) return [];

    return new Promise<Event[]>((resolve) => {
      const events: Event[] = [];
      const seen = new Set<string>();
      let eoseCount = 0;
      let settled = false;
      const subs: SubscriptionLike[] = [];

      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const sub of subs) {
          try {
            sub.close('query finished');
          } catch {
            /* relay už mohol byť zavretý */
          }
        }
        resolve(events);
      };

      const timer = setTimeout(finish, timeoutMs);
      if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
        (timer as unknown as { unref: () => void }).unref();
      }

      relays.forEach((relay, i) => {
        try {
          subs.push(
            relay.subscribe(filters, {
              id: `f4ai-query-${Date.now().toString(36)}-${String(i)}-${String(this.subCounter++)}`,
              onevent: (event) => {
                if (rememberSeen(seen, event.id)) events.push(event);
              },
              oneose: () => {
                eoseCount += 1;
                if (eoseCount >= relays.length) finish();
              },
              onclose: () => {
                eoseCount += 1;
                if (eoseCount >= relays.length) finish();
              },
            }),
          );
        } catch {
          eoseCount += 1;
          if (eoseCount >= relays.length) finish();
        }
      });
    });
  }

  /**
   * Trvalý fan-out subscribe: `callback` dostane každý unikátny event
   * (deduplikované id) a URL relaya, odkiaľ prišiel. Vráti unsubscribe.
   * Po obnovenom spojení sa sub automaticky obnoví.
   *
   * `opts.onEose` sa zavolá **najviac raz** — keď všetky práve pripojené
   * relaye subs dokončili (EOSE alebo hard-close), resp. okamžite ak nie je
   * pripojený žiadny relay (nič sa nedá čakať). Po reconnecte sa EOSE
   * neopakuje; live eventy doručuje `callback` ďalej. (S5: WS /ws posiela
   * klientovi `["EOSE", sub_id]` práve na tejto báze.)
   */
  subscribe(
    filters: Filter[],
    callback: (event: Event, relayUrl: string) => void,
    opts?: { onEose?: () => void },
  ): () => void {
    const sub: PoolSubscription = {
      seq: this.subSeq++,
      filters,
      callback,
      onEose: opts?.onEose ?? null,
      seen: new Set<string>(),
      active: new Map<string, SubscriptionLike>(),
      attached: new Set<string>(),
      eosed: new Set<string>(),
      eoseFired: false,
      removed: false,
    };
    this.subscriptions.add(sub);
    for (const m of this.managed.values()) this.attachSub(sub, m);
    if (sub.attached.size === 0) this.fireEose(sub);

    return () => {
      if (sub.removed) return;
      sub.removed = true;
      this.subscriptions.delete(sub);
      for (const [key, active] of sub.active) {
        sub.active.delete(key);
        try {
          active.close('unsubscribed');
        } catch {
          /* už zavreté */
        }
      }
    };
  }

  /** cielené zavretie poolu — žiadny ďalší reconnect, všetky subs zrušené */
  close(): void {
    this.closed = true;
    for (const m of this.managed.values()) {
      m.closing = true;
      if (m.retryTimer !== null) {
        clearTimeout(m.retryTimer);
        m.retryTimer = null;
      }
      m.relay?.close();
      m.relay = null;
    }
    for (const sub of this.subscriptions) {
      sub.active.clear();
    }
    this.subscriptions.clear();
  }

  // ── interné ────────────────────────────────────────────────────────────

  private addEntry(
    normalized: string,
    opts?: { write?: boolean; discovered?: boolean },
  ): ManagedRelay {
    const m: ManagedRelay = {
      url: normalized,
      relay: null,
      connecting: null,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      lastConnectedAt: null,
      retryTimer: null,
      closing: false,
      write: opts?.write ?? true,
      discovered: opts?.discovered ?? false,
      addedAt: this.options.now(),
    };
    this.managed.set(normalized, m);
    return m;
  }

  private async attemptConnect(m: ManagedRelay): Promise<void> {
    try {
      const relay = await this.options.connector(m.url);
      if (this.closed || m.closing) {
        relay.close();
        return;
      }
      m.relay = relay;
      m.attempts = 0;
      m.nextAttemptAt = 0;
      m.lastError = null;
      m.lastConnectedAt = this.options.now();
      relay.onclose = () => {
        if (m.closing || this.closed) return;
        // hard-close: zahoď relay a plánuj retry s backoffom; subs sa
        // prihlásia znova pri ďalšom úspešnom pripojení
        if (m.relay === relay) m.relay = null;
        this.scheduleRetry(m);
      };
      this.resubscribe(m);
    } catch (err) {
      m.attempts += 1;
      m.lastError = errorMessage(err);
      m.relay = null;
      this.scheduleRetry(m);
    }
  }

  /** exponenciálny backoff s jitterom ±20 %, strop `maxBackoffMs` */
  private scheduleRetry(m: ManagedRelay): void {
    if (m.closing || this.closed) return;
    if (m.retryTimer !== null) {
      clearTimeout(m.retryTimer);
      m.retryTimer = null;
    }
    // prvá neúspešná snaha → initialBackoffMs, ďalej 2×, strop maxBackoffMs
    // (`attempts` už bol pri zlyhaní zvýšený, preto exponent - 1)
    const exponent = Math.max(0, m.attempts - 1);
    const base = Math.min(
      this.options.initialBackoffMs * 2 ** exponent,
      this.options.maxBackoffMs,
    );
    const jitter = 0.8 + 0.4 * this.options.random();
    const delay = Math.round(base * jitter);
    m.nextAttemptAt = this.options.now() + delay;
    m.retryTimer = setTimeout(() => {
      m.retryTimer = null;
      // **Otvor backoff okno:** timer je sám zdroj oneskorenia, takže
      // okamih jeho zavolania je „už je čas“. Bez tohto kroku sa stalo,
      // že `setTimeout` skočil o ms skôr, než `Date.now()` dosiahlo
      // `nextAttemptAt` (timery nie sú presné na ms), `ensure()` odmietol
      // s „ešte nie“ a **žiadny ďalší timer už nevznikol** — relay by
      // zostal offline navždy a žiadny automatický retry by neprišiel.
      if (this.options.now() < m.nextAttemptAt) m.nextAttemptAt = this.options.now();
      void this.ensure(m.url);
    }, delay);
    if (typeof (m.retryTimer as unknown as { unref?: () => void }).unref === 'function') {
      (m.retryTimer as unknown as { unref: () => void }).unref();
    }
  }

  private attachSub(sub: PoolSubscription, m: ManagedRelay): void {
    const relay = m.relay;
    if (!relay || !relay.connected || sub.removed) return;
    // F4AI-38: lišiace relaye pripájame na subs len v režime, ktorý to
    // pripúšťa (default failover = až keď nie je pripojený žiadny
    // konfigurovaný). Inak by cudzí obsah tiekol do každého čítania.
    if (m.discovered && !this.discoveredReadsAllowed()) return;
    // pri reconnecte odpúšťame starú per-relay subs (onclose ju síl zvyčajne
    // zmazal, ale istota — inak by sa dvakrát registrovala a emitovala)
    for (const [key, active] of sub.active) {
      if (key.startsWith(`${m.url}#`)) {
        sub.active.delete(key);
        sub.attached.delete(m.url);
        try {
          active.close('replaced');
        } catch {
          /* už zavreté */
        }
      }
    }
    const key = `${m.url}#${String(this.subCounter++)}`;
    try {
      const active = relay.subscribe(sub.filters, {
        id: `f4ai-sub-${String(sub.seq)}-${key}`,
        onevent: (event) => {
          if (!rememberSeen(sub.seen, event.id)) return;
          sub.callback(event, m.url);
        },
        oneose: () => {
          // ignoruj oneskorené callbacky za odpútenou (replaced) subs
          if (!sub.active.has(key)) return;
          sub.eosed.add(m.url);
          this.maybeFireEose(sub);
        },
        onclose: () => {
          if (!sub.active.delete(key)) return; // už nahradená/odstránená
          sub.attached.delete(m.url);
          sub.eosed.delete(m.url);
          this.maybeFireEose(sub);
        },
      });
      sub.active.set(key, active);
      sub.attached.add(m.url);
      sub.eosed.delete(m.url);
    } catch {
      // relay práve zomrel — obnoví sa po reconnecte
    }
  }

  /** `true` keď si objavené relaye zaslúžia aj čítacie fan-outy */
  private discoveredReadsAllowed(): boolean {
    if (this.options.discoveredReads === 'always') return true;
    if (this.options.discoveredReads === 'never') return false;
    for (const m of this.managed.values()) {
      if (!m.discovered && m.relay?.connected === true) return false;
    }
    return true;
  }

  private fireEose(sub: PoolSubscription): void {
    if (sub.eoseFired || sub.removed || sub.onEose === null) return;
    sub.eoseFired = true;
    try {
      sub.onEose();
    } catch {
      /* callback nesmie rozhodiť pool */
    }
  }

  /** EOSE, keď všetky práve pripojené relaye subs dokončili */
  private maybeFireEose(sub: PoolSubscription): void {
    if (sub.attached.size > 0 && sub.eosed.size >= sub.attached.size) {
      this.fireEose(sub);
    }
  }

  private resubscribe(m: ManagedRelay): void {
    for (const sub of this.subscriptions) this.attachSub(sub, m);
  }
}
