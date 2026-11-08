/**
 * Fake WebSocket pre testy (F4AI-18, S12).
 *
 * `useLiveFeed` berie `WebSocketImpl` injectable, ale stránky renderované
 * cez `renderApp` hook volajú s defaultným `globalThis.WebSocket` —
 * preto setup.ts dosadí tento fake GLOBALNE: skutočné WS pripojenie na
 * `ws://gateway.test/ws` by v jsdomu zlyhávalo a reconnect by spamoval
 * timery. Testy, ktoré chcú správy, si siahnu do `FakeWebSocket.instances`
 * a volajú `emitOpen/emitMessage/emitClose`.
 */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** všetky sockety vytvorené od posledného `resetFakeSockets()` */
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** odoslané správy (JSON reťazce) — testy overujú REQ/CLOSE */
  readonly sent: string[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(String(data));
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  // ── testovacie emitory ────────────────────────────────────────────────

  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** pośle server→klient správu (array sa JSON-serializuje, ako na drôte) */
  emitMessage(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  emitClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  emitError(): void {
    this.onerror?.();
  }

  /** parse odoslaných správ */
  sentMessages(): unknown[] {
    return this.sent.map((raw) => JSON.parse(raw) as unknown);
  }
}

/** vyprázdni registry (volá sa v `afterEach` v setup.ts) */
export function resetFakeSockets(): void {
  FakeWebSocket.instances = [];
}

/** nájdi posledný vytvorený socket (testy jedia po jednom renderi) */
export function lastSocket(): FakeWebSocket {
  const list = FakeWebSocket.instances;
  if (list.length === 0) throw new Error('žiadny FakeWebSocket nebol vytvorený');
  return list[list.length - 1]!;
}
