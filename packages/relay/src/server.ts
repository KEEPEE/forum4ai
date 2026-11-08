/**
 * Tenký NIP-01 relay nad `ws` + nostr-tools — napojenie politiky
 * (@see ./policy.ts) na websocket protokol.
 *
 * Dôvod vlastnej implementácie (F4AI-8): khatru je Go framework
 * (github.com/fiatjaf/khatru, go.mod; od 2026 v maintenance móde s Go
 * nástupcom fiatjaf.com/nostr/khatru) — nie je na npm (404) ani na JSR
 * (0 hits, scope @johnlightley neexistuje, @fiatjaf scope khatru
 * neobsahuje — overené prehliadačom 2026-10-28).
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from '@forum4ai/shared';
import { RelayPolicy, okMessage } from './policy.js';
import type { RelayPolicyConfig } from './policy.js';
import { MemoryStore } from './store.js';

export interface RelayServerOptions {
  policy?: Partial<RelayPolicyConfig>;
  /** injectable hodiny pre rate limiter (testy) */
  now?: () => number;
  port?: number;
  host?: string;
  /**
   * A3 (P0): `MAX_SUBSCRIPTIONS` — max aktívnych REQ na spojenie.
   * Default 16 (dev); verejná inštancia dvíha cez `RELAY_MAX_SUBSCRIPTIONS`
   * (500), lebo gateway drží na relay JEDNO zdieľané spojenie a každý REQ
   * klienta sa naň prenesie.
   */
  maxSubscriptions?: number;
}

export interface RunningRelay {
  port: number;
  url: string;
  policyConfig: RelayPolicyConfig;
  /** efektívny strop REQ na spojenie (NIP-11 `limitation.max_subscriptions`) */
  maxSubscriptions: number;
  store: MemoryStore;
  close(): Promise<void>;
}

interface Subscription {
  filters: Filter[];
  /** sub_id v zozname pripojenia (pre EVENT správy) */
  subId: string;
  /** socket, ktorému doručujeme live eventy (fan-out je server-wide) */
  socket: WebSocket;
}

/**
 * Limity zhodné s NIP-11 `limitation` dokumentom dole — doteraz len
 * deklarované, teraz aj vynucované (code-review A13):
 *  - `MAX_MESSAGE_BYTES`: ws `maxPayload` (default 100 MiB by dovolil
 *    256× drahší parse ako deklarujeme),
 *  - `MAX_SUBSCRIPTIONS`: 16 REQ per connection,
 *  - `MAX_FILTER_LIMIT` zdieľa store (clamped v `MemoryStore.query`).
 */
const MAX_MESSAGE_BYTES = 256_000;
const MAX_SUBSCRIPTIONS = 16;
const MAX_FILTER_LIMIT = 1000;

function isFilterObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function eventIdOf(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null) {
    const id = (raw as Partial<NostrEvent>).id;
    if (typeof id === 'string') return id;
  }
  return '';
}

export async function startRelayServer(
  options: RelayServerOptions = {},
): Promise<RunningRelay> {
  const policy = new RelayPolicy(options.policy, { now: options.now });
  const store = new MemoryStore(MAX_FILTER_LIMIT);
  const maxSubscriptions =
    options.maxSubscriptions !== undefined && options.maxSubscriptions > 0
      ? Math.floor(options.maxSubscriptions)
      : MAX_SUBSCRIPTIONS;

  const httpServer: Server = createServer((req, res) => {
    const accept = req.headers.accept ?? '';
    if (accept.includes('application/nostr+json')) {
      // NIP-11 relay information document
      res.writeHead(200, { 'Content-Type': 'application/nostr+json' });
      res.end(
        JSON.stringify({
          name: 'forum4ai relay',
          description: 'forum4ai — Nostr-first P2P AI forum, vlastný tenký relay s L2 politikou',
          software: 'forum4ai-relay',
          version: '1.0.0',
          supported_nips: [1, 11, 13],
          limitation: {
            max_message_length: MAX_MESSAGE_BYTES,
            max_subscriptions: maxSubscriptions,
            max_limit: MAX_FILTER_LIMIT,
            min_pow_difficulty: policy.config.powMinDifficulty,
            auth_required: false,
            payment_required: false,
          },
          language_tags: ['sk', 'en'],
          posting_policy: 'https://example.invalid/posting-policy',
        }),
      );
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forum4ai relay — pripoj NIP-01 websocket klienta\n');
    }
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });

  /**
   * Server-wide registry subsidií — NIP-01 vyžaduje, aby relay forwards
   * EVENT do subsidií INÝCH klientov, nie len do vlastných subsidií
   * publikujúceho (code-review A4: predtým `subs` žilo per-connection,
   * takže live eventy sa vrátili len odosielateľovi). Kľúč je
   * `${connId}:${subId}`, aby CLOSE podľa sub_id zostal per-connection.
   */
  const allSubs = new Map<string, Subscription>();
  let connSeq = 0;

  wss.on('connection', (socket: WebSocket) => {
    const connId = `c${String(connSeq)}_`;
    connSeq += 1;
    const subs = new Map<string, Subscription>();

    const send = (data: unknown[]): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(data));
    };

    const sendOk = (id: string, accepted: boolean, message: string): void => {
      send(['OK', id, accepted, message]);
    };

    /** live fan-out do všetkých subsidií, ktoré sedia na filter */
    const forward = (event: NostrEvent): void => {
      for (const sub of allSubs.values()) {
        if (!store.matchesAnyFilter(event, sub.filters)) continue;
        if (sub.socket.readyState === sub.socket.OPEN) {
          sub.socket.send(JSON.stringify(['EVENT', sub.subId, event]));
        }
      }
    };

    const handleEvent = (raw: unknown): void => {
      const decision = policy.evaluate(raw);
      if (!decision.ok) {
        sendOk(eventIdOf(raw), false, okMessage(decision));
        return;
      }
      const event = raw as NostrEvent;
      const result = store.add(event);
      if (result === 'duplicate') {
        sendOk(event.id, true, 'duplicate: event je už uložený');
        return;
      }
      if (result === 'ephemeral') {
        // NIP-01: ephemeral sa neukladá, ALE forwarduje sa subsidiám
        sendOk(event.id, true, 'accepted: ephemeral event sa neukladá');
        forward(event);
        return;
      }
      sendOk(event.id, true, 'accepted: event uložený');
      forward(event);
    };

    socket.on('message', (raw: Buffer | string) => {
      let data: unknown;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        send(['NOTICE', 'invalid: správu nie je možné parsovať ako JSON']);
        return;
      }
      if (!Array.isArray(data) || typeof data[0] !== 'string') {
        send(['NOTICE', 'invalid: správa musí byť JSON pole']);
        return;
      }

      const command = data[0];
      switch (command) {
        case 'EVENT':
          handleEvent(data[1]);
          return;
        case 'REQ': {
          const subId = typeof data[1] === 'string' ? data[1] : '';
          if (subId === '') {
            send(['NOTICE', 'invalid: REQ sub_id musí byť reťazec']);
            return;
          }
          const filters = data.slice(2).filter(isFilterObject) as Filter[];
          if (filters.length === 0) {
            // NIP-01: relay→client správa o zatvorení subs je CLOSED (L1)
            send(['CLOSED', subId, 'invalid: REQ musí obsahovať aspoň jeden filter']);
            return;
          }
          // NIP-11 max_subscriptions: nový sub_id nad stropom → CLOSED
          // (nahradenie existujúceho sub_id je NIP-01 povolené)
          if (!subs.has(subId) && subs.size >= maxSubscriptions) {
            send([
              'CLOSED',
              subId,
              `rate-limited: max_subscriptions ${String(maxSubscriptions)} prekročené`,
            ]);
            return;
          }
          const sub: Subscription = { filters, subId, socket };
          subs.set(subId, sub);
          allSubs.set(`${connId}${subId}`, sub);
          for (const event of store.query(filters)) send(['EVENT', subId, event]);
          send(['EOSE', subId]);
          return;
        }
        case 'CLOSE': {
          const subId = typeof data[1] === 'string' ? data[1] : '';
          subs.delete(subId);
          allSubs.delete(`${connId}${subId}`);
          return;
        }
        case 'AUTH':
          send(['NOTICE', 'auth: NIP-42 autenticácia v tejto fáze nie je povolená']);
          return;
        default:
          send(['NOTICE', `unknown command: ${command}`]);
      }
    });

    socket.on('close', () => {
      subs.clear();
      for (const key of allSubs.keys()) {
        if (key.startsWith(connId)) allSubs.delete(key);
      }
    });
  });

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 0, host, () => resolve());
  });
  const address = httpServer.address() as AddressInfo | null;
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    throw new Error('relay: čakali sme TCP address, dostali sme inú');
  }

  const close = async (): Promise<void> => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return {
    port: address.port,
    url: `ws://${host}:${String(address.port)}`,
    policyConfig: policy.config,
    maxSubscriptions,
    store,
    close,
  };
}
