/**
 * `useLiveFeed` — live updates over the gateway WS `/ws` (F4AI-18, S12).
 *
 * Protocol (source of truth: `packages/gateway/src/ws.ts`):
 *   client → server   `["REQ", sub_id, filter…]` | `["CLOSE", sub_id]`
 *   server → client   `["EVENT", sub_id, event]` | `["EOSE", sub_id]`
 *                     `["NOTICE", text]`
 * Max 5 subscriptions per connection; a duplicate `sub_id` → NOTICE. That is why the
 * hook keeps ONE sub per connection and resends REQ after a reconnect.
 *
 * Hook behaviour:
 *  - filter `{ kinds: [1020,1023], since: <teraz> }` (+ `#e` for a thread,
 *    `+ #a` for a topic): we set `since` to the time the page opened, so the live
 *    layer does NOT GET a backlog (we already have the data from REST), only new events;
 *  - on a new EVENT (kind in `kinds`) it calls `onEvent` — a debounce (default
 *    250 ms) merges a burst (a relay sends several events at once) into a single
 *    invalidation, so the page does one refetch;
 *  - reconnect with exponential backoff (base 500 ms → cap 30 s),
 *    the attempt counter resets after a successful `open`;
 *  - `WebSocketImpl` is injectable: tests supply a fake socket (jsdom 30
 *    does have `WebSocket`, but we do not want a real WS connection in tests);
 *    if there is no constructor at all, the status is `unsupported` and the hook
 *    does not touch the network.
 */
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';

import { useApi } from '../api/ApiContext.js';
import type { EventSummary } from '../api/types.js';
import { t } from '../i18n/text.js';

/** default kindy live vrstvy: nové otázky (1020) a odpovede (1023) */
export const LIVE_DEFAULT_KINDS: readonly number[] = [1020, 1023];

export const LIVE_BACKOFF_BASE_MS = 500;
export const LIVE_BACKOFF_MAX_MS = 30_000;
export const LIVE_DEBOUNCE_MS = 250;

export type LiveStatus = 'idle' | 'connecting' | 'open' | 'eose' | 'closed' | 'error' | 'unsupported';

export interface UseLiveFeedOptions {
  /** topic slug — filterujeme client-side (`t` tag alebo slug z `a` tagu) */
  topicSlug?: string | null;
  /** adresa topicu `30020:<pubkey>:<slug>` — filter `#a` priamo na relayi */
  topicAddress?: string | null;
  /** id rootu vlákna — filter `#e` (nové odpovede 1023) */
  threadId?: string | null;
  /** default `[1020, 1023]` */
  kinds?: readonly number[];
  /** volané (debounced) pri každom novom eventy — invalidácia dát stránky */
  onEvent?: (event: EventSummary) => void;
  /** default `gatewayWsUrl(api.baseUrl)` */
  url?: string;
  /** injectable konštruktor (testy: fake socket) */
  WebSocketImpl?: LiveWebSocketConstructor;
  debounceMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** false = žiadne spojenie (status `idle`) */
  enabled?: boolean;
}

export interface LiveFeedState {
  status: LiveStatus;
  /** počet doručených EVENT správ za životnosť hooku */
  events: number;
  lastEventId: string | null;
  /** posledná NOTICE / doprava chyba (zobrazíme nenápadne, stránka funguje) */
  error: string | null;
}

/** minimálna tvár WebSocketu, ktorú hook potrebuje (fake socket to istí) */
export interface LiveWebSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface LiveWebSocketConstructor {
  new (url: string): LiveWebSocket;
  readonly OPEN: number;
}

/** REST base URL → WS URL (`http→ws`, `https→wss`), gateway cesta je `/ws` */
export function gatewayWsUrl(baseUrl: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}/ws`;
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}/ws`;
  return `${trimmed}/ws`; // už ws:// alebo wss://
}

/** NIP-01 filter pre REQ — tvár overuje `validateFilter` na gateway (ws.ts) */
export function buildLiveFilter(
  options: Pick<UseLiveFeedOptions, 'topicSlug' | 'topicAddress' | 'threadId' | 'kinds'>,
  sinceSeconds: number,
): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    kinds: [...(options.kinds ?? LIVE_DEFAULT_KINDS)],
    since: sinceSeconds,
  };
  if (options.threadId) filter['#e'] = [options.threadId];
  else if (options.topicAddress) filter['#a'] = [options.topicAddress];
  return filter;
}

/** client-side zhoda pre `topicSlug` (relay filter vie `#a` len na celú adresu) */
export function matchesTopicSlug(event: EventSummary, slug: string): boolean {
  for (const tag of event.tags) {
    if (tag[0] === 't' && tag[1] === slug) return true;
    if (tag[0] === 'a' && typeof tag[1] === 'string') {
      const parts = tag[1].split(':');
      if (parts.length === 3 && parts[2] === slug) return true;
    }
  }
  return false;
}

let subCounter = 0;

/**
 * Pripojí sa na `/ws`, pošle REQ a na EVENT zavolá `onEvent`. Vracia stav
 * spojenia pre indikátor v UI. `onEvent` držíme v ref, aby jeho nová
 * identita pri každom renderi nenadväzovala nové spojenie.
 */
export function useLiveFeed(options: UseLiveFeedOptions = {}): LiveFeedState {
  const api = useApi();
  const {
    topicSlug = null,
    topicAddress = null,
    threadId = null,
    kinds = LIVE_DEFAULT_KINDS,
    url,
    WebSocketImpl,
    debounceMs = LIVE_DEBOUNCE_MS,
    backoffBaseMs = LIVE_BACKOFF_BASE_MS,
    backoffMaxMs = LIVE_BACKOFF_MAX_MS,
    enabled = true,
  } = options;

  const [state, setState] = useState<LiveFeedState>({
    status: enabled ? 'connecting' : 'idle',
    events: 0,
    lastEventId: null,
    error: null,
  });

  const onEventRef: MutableRefObject<((event: EventSummary) => void) | undefined> = useRef(options.onEvent);
  onEventRef.current = options.onEvent;

  const wsUrl = useMemo(() => url ?? gatewayWsUrl(api.baseUrl), [url, api.baseUrl]);
  const kindsKey = kinds.join(',');

  useEffect(() => {
    if (!enabled) {
      setState((prev) => ({ ...prev, status: 'idle' }));
      return;
    }
    const Ctor = WebSocketImpl ?? (globalThis as { WebSocket?: LiveWebSocketConstructor }).WebSocket;
    if (Ctor === undefined || Ctor === null) {
      setState((prev) => ({ ...prev, status: 'unsupported', error: t('forum:live.unsupported') }));
      return;
    }

    let disposed = false;
    let socket: LiveWebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const pending: { event: EventSummary | null } = { event: null };

    const subId = `f4ai-live-${String(++subCounter)}`;
    const kindSet = new Set<number>(kinds);
    // B5: `since` kotvíme JEDNOKRAT pri behu efektu (otvorenie / skok na
    // iný topic). Kým sme boli offline (reconnect s backoffom až 30 s),
    // opätovné volanie `Date.now()` v connect() by posunulo anchor
    // dopredu a eventy z výpadku by navždy zmizli.
    const sinceSeconds = Math.floor(Date.now() / 1000);

    const clearTimers = (): void => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };

    const handleEvent = (raw: unknown): void => {
      if (raw === null || typeof raw !== 'object') return;
      const event = raw as EventSummary;
      if (typeof event.kind !== 'number' || !kindSet.has(event.kind)) return;
      if (typeof event.id !== 'string') return;
      if (topicSlug !== null && !matchesTopicSlug(event, topicSlug)) return;
      setState((prev) => ({ ...prev, events: prev.events + 1, lastEventId: event.id }));
      pending.event = event;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        const ev = pending.event;
        pending.event = null;
        if (ev !== null && !disposed) onEventRef.current?.(ev);
      }, debounceMs);
    };

    const handleMessage = (data: unknown): void => {
      let text: string;
      if (typeof data === 'string') text = data;
      else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(data));
      else if (ArrayBuffer.isView(data)) text = new TextDecoder().decode(data as Uint8Array);
      else return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        setState((prev) => ({ ...prev, error: t('forum:live.badJson') }));
        return;
      }
      if (!Array.isArray(parsed) || parsed.length < 2 || typeof parsed[1] !== 'string') return;
      const verb = parsed[0];
      if (verb === 'EVENT' && parsed.length >= 3) handleEvent(parsed[2]);
      else if (verb === 'EOSE') setState((prev) => ({ ...prev, status: 'eose' }));
      else if (verb === 'NOTICE') setState((prev) => ({ ...prev, error: String(parsed[1]) }));
    };

    const connect = (): void => {
      if (disposed) return;
      setState((prev) => ({ ...prev, status: 'connecting' }));
      const filter = buildLiveFilter({ topicSlug, topicAddress, threadId, kinds }, sinceSeconds);
      try {
        socket = new Ctor(wsUrl);
      } catch (err) {
        setState((prev) => ({ ...prev, status: 'error', error: err instanceof Error ? err.message : String(err) }));
        return;
      }
      socket.onopen = () => {
        if (disposed) return;
        attempt = 0;
        setState((prev) => ({ ...prev, status: 'open', error: null }));
        socket?.send(JSON.stringify(['REQ', subId, filter]));
      };
      socket.onmessage = (message) => handleMessage(message.data);
      socket.onerror = () => {
        if (!disposed) setState((prev) => ({ ...prev, status: 'error', error: 'ws spojenie zlyhalo' }));
      };
      socket.onclose = () => {
        if (disposed) return;
        setState((prev) => ({ ...prev, status: 'closed' }));
        const delay = Math.min(backoffBaseMs * 2 ** attempt, backoffMaxMs);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      clearTimers();
      if (socket !== null) {
        try {
          if (socket.readyState === (Ctor.OPEN ?? 1)) socket.send(JSON.stringify(['CLOSE', subId]));
          socket.close();
        } catch {
          /* už zavreté */
        }
      }
    };
    // `kindsKey` stabilizuje pole kindov; `onEvent` je v ref (vid vyššie)
  }, [enabled, wsUrl, subIdKey(topicSlug, topicAddress, threadId), kindsKey, WebSocketImpl, debounceMs, backoffBaseMs, backoffMaxMs]);

  return state;
}

/** stabilný kľúč pre filter — mení sa len pri skoku na iný topic/vlákno */
function subIdKey(topicSlug: string | null, topicAddress: string | null, threadId: string | null): string {
  return `${threadId ?? ''}|${topicAddress ?? ''}|${topicSlug ?? ''}`;
}
