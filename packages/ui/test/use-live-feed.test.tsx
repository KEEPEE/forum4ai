/**
 * Testy `useLiveFeed` (F4AI-18, S12) — protokol WS /ws (REQ/CLOSE/EOSE,
 * tvary overené `parseClientMessage`om v `packages/gateway/src/ws.ts`)
 * na FAKE sockete (`test/fake-ws.ts`, injectnutý cez `WebSocketImpl`).
 *
 * Overáva sa: REQ s filterom po otvorení, invalidácia dát na EVENT
 * (debounced), filter kindov + client-side topic slug, EOSE/NOTICE stavy,
 * CLOSE pri unmounte, reconnect s exponenciálnym backoffom a stav
 * `unsupported` bez WebSocketu.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';

import {
  buildLiveFilter,
  gatewayWsUrl,
  useLiveFeed,
  type LiveWebSocketConstructor,
  type UseLiveFeedOptions,
} from '../src/hooks/useLiveFeed.js';
import { FakeWebSocket, lastSocket, resetFakeSockets } from './fake-ws.js';
import { renderWithProviders } from './render.js';
import { QUESTION_EVENT, hexId } from './fixtures.js';
import type { EventSummary } from '../src/api/types.js';

const Ctor = FakeWebSocket as unknown as LiveWebSocketConstructor;

function Probe(options: Partial<UseLiveFeedOptions> = {}) {
  const state = useLiveFeed({ WebSocketImpl: Ctor, debounceMs: 0, ...options });
  return <div data-testid="live-state">{JSON.stringify(state)}</div>;
}

function readState(): { status: string; events: number; lastEventId: string | null; error: string | null } {
  return JSON.parse(String(screen.getByTestId('live-state').textContent)) as {
    status: string;
    events: number;
    lastEventId: string | null;
    error: string | null;
  };
}

function eventMessage(event: EventSummary): ['EVENT', string, EventSummary] {
  return ['EVENT', 'sub-1', event];
}

afterEach(() => {
  resetFakeSockets();
  vi.useRealTimers();
});

describe('gatewayWsUrl + buildLiveFilter (čisté funkcie)', () => {
  it('mapuje http→ws, https→wss a ponechá ws://', () => {
    expect(gatewayWsUrl('http://127.0.0.1:18081')).toBe('ws://127.0.0.1:18081/ws');
    expect(gatewayWsUrl('https://forum.example/')).toBe('wss://forum.example/ws');
    expect(gatewayWsUrl('ws://relay.test:7777')).toBe('ws://relay.test:7777/ws');
  });

  it('filter má kinds+since a `#e` pre vlákno / `#a` pre topic', () => {
    const thread = buildLiveFilter({ threadId: hexId('a1') }, 100);
    expect(thread['kinds']).toEqual([1020, 1023]);
    expect(thread['since']).toBe(100);
    expect(thread['#e']).toEqual([hexId('a1')]);
    const topic = buildLiveFilter({ topicAddress: `30020:${hexId('c3')}:rust`, kinds: [1020] }, 100);
    expect(topic['#a']).toEqual([`30020:${hexId('c3')}:rust`]);
    expect(topic['kinds']).toEqual([1020]);
    expect(topic['#e']).toBeUndefined();
  });
});

describe('useLiveFeed — REQ protokol a invalidácia', () => {
  it('po otvorení pošle REQ s sub_id a filterom na URL gateway', async () => {
    renderWithProviders(<Probe />);
    const socket = lastSocket();
    expect(socket.url).toBe('ws://gateway.test/ws');

    act(() => {
      socket.emitOpen();
    });
    const [verb, subId, filter] = socket.sentMessages()[0] as [string, string, Record<string, unknown>];
    expect(verb).toBe('REQ');
    expect(typeof subId).toBe('string');
    expect(subId.length).toBeGreaterThan(0);
    expect(subId.length).toBeLessThanOrEqual(64);
    expect(filter['kinds']).toEqual([1020, 1023]);
    expect(Number(filter['since'])).toBeGreaterThan(0);
    await waitFor(() => expect(readState().status).toBe('open'));
  });

  it('EVENT spustí onEvent (invalidáciu) a zvýši počítadlo', async () => {
    const onEvent = vi.fn();
    renderWithProviders(<Probe onEvent={onEvent} />);
    const socket = lastSocket();
    act(() => {
      socket.emitOpen();
      socket.emitMessage(eventMessage(QUESTION_EVENT));
    });
    await waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(onEvent.mock.calls[0]?.[0].id).toBe(QUESTION_EVENT.id);
    await waitFor(() => expect(readState().events).toBe(1));
    expect(readState().lastEventId).toBe(QUESTION_EVENT.id);
  });

  it('EVENT mimo kindov ignoruje (feed s kinds [1020] sa neprebuří z 1023)', async () => {
    const onEvent = vi.fn();
    renderWithProviders(<Probe kinds={[1020]} onEvent={onEvent} />);
    const socket = lastSocket();
    act(() => {
      socket.emitOpen();
      socket.emitMessage(eventMessage({ ...QUESTION_EVENT, kind: 1023 }));
    });
    await waitFor(() => expect(readState().status).toBe('open'));
    expect(onEvent).not.toHaveBeenCalled();
    expect(readState().events).toBe(0);
  });

  it('topicSlug filtruje client-side (t/a tag) a burst zlúči do jednej invalidácie', async () => {
    const onEvent = vi.fn();
    renderWithProviders(<Probe topicSlug="rust" onEvent={onEvent} />);
    const socket = lastSocket();
    act(() => {
      socket.emitOpen();
      socket.emitMessage(eventMessage({ ...QUESTION_EVENT, tags: [['t', 'ai']] })); // cudzí topic → zahodený
      socket.emitMessage(eventMessage({ ...QUESTION_EVENT, tags: [['t', 'rust']] }));
      socket.emitMessage(
        eventMessage({ ...QUESTION_EVENT, id: hexId('d9'), tags: [['a', `30020:${hexId('c3')}:rust`]] }),
      );
    });
    // debounce zlúči burst 2 zhodných eventov na JEDNO volanie (stránka urobí
    // jeden refetch) — počet doručených EVENTov sa však počíta všetky
    await waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect((onEvent.mock.calls[0]?.[0] as EventSummary).id).toBe(hexId('d9'));
    await waitFor(() => expect(readState().events).toBe(2));
  });

  it('EOSE stav `eose`, NOTICE uloží chybovú vetu', async () => {
    renderWithProviders(<Probe />);
    const socket = lastSocket();
    act(() => {
      socket.emitOpen();
      socket.emitMessage(['EOSE', 'sub-1']);
      socket.emitMessage(['NOTICE', 'limit subscriptionov 5 dosiahnuty']);
    });
    await waitFor(() => expect(readState().status).toBe('eose'));
    expect(readState().error).toContain('limit subscriptionov');
  });

  it('pri unmounte pošle CLOSE a zatvorí socket', async () => {
    const result = renderWithProviders(<Probe />);
    const socket = lastSocket();
    act(() => {
      socket.emitOpen();
    });
    result.unmount();
    expect(socket.sentMessages().some((msg) => Array.isArray(msg) && msg[0] === 'CLOSE')).toBe(true);
    expect(socket.closed).toBe(true);
  });
});

describe('useLiveFeed — reconnect a unsupported', () => {
  it('po close sa reconnectuje s backoffom 500 ms, potom 1000 ms', async () => {
    vi.useFakeTimers();
    renderWithProviders(<Probe backoffBaseMs={500} backoffMaxMs={10_000} />);
    expect(FakeWebSocket.instances).toHaveLength(1);

    const first = lastSocket();
    act(() => {
      first.emitOpen();
      first.emitClose();
    });
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);

    const second = lastSocket();
    act(() => {
      second.emitClose();
    });
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  // ── regression B5 ────────────────────────────────────────────────────────
  it('reconnect si drží PÔVODNÝ since anchor (eventy z výpadku nezmiznú)', async () => {
    vi.useFakeTimers();
    renderWithProviders(<Probe backoffBaseMs={500} backoffMaxMs={10_000} />);
    const first = lastSocket();
    act(() => {
      first.emitOpen();
      first.emitClose();
    });
    // fake timery posúvajú aj Date.now — 2 s výpadok by bez B5 fixu
    // posunul since o 2 s dopredu a eventy z okna navždy zmizli
    act(() => {
      vi.advanceTimersByTime(2001);
    });
    const second = lastSocket();
    act(() => {
      second.emitOpen();
    });

    const reqOf = (socket: ReturnType<typeof lastSocket>): Record<string, unknown> => {
      const msg = socket.sentMessages().find((m) => Array.isArray(m) && m[0] === 'REQ') as
        | [string, string, Record<string, unknown>]
        | undefined;
      expect(msg).toBeTruthy();
      return msg?.[2] as Record<string, unknown>;
    };
    const sinceFirst = Number(reqOf(first)['since']);
    const sinceSecond = Number(reqOf(second)['since']);
    expect(sinceSecond).toBe(sinceFirst);
    vi.useRealTimers();
  });

  it('bez WebSocketu je status `unsupported` a žiadne volanie', async () => {    const saved = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
    delete (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
    try {
      renderWithProviders(
        <Probe WebSocketImpl={undefined as unknown as LiveWebSocketConstructor} />,
      );
      // Probe dostal undefined → hook sa padne na global, ktorý sme práve zmazali
      await waitFor(() => expect(readState().status).toBe('unsupported'));
      expect(readState().error).toContain('WebSocket');
    } finally {
      (globalThis as unknown as { WebSocket?: unknown }).WebSocket = saved;
    }
  });

  it('enabled: false žiadne spojenie (status idle)', async () => {
    renderWithProviders(<Probe enabled={false} />);
    await waitFor(() => expect(readState().status).toBe('idle'));
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
