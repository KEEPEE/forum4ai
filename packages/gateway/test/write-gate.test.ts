/**
 * Unit testy write-gate (A1 zo security reviewu, dizajn B9, P0).
 *
 * Dve vrstvy: čistá rozhodovacia logika `WriteGate` (bez siete) a
 * napojenie na `POST /events` (403 s dôvodom v `enforce`, len log v
 * `log`, žiadna zmena v `off`).
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import type { Event } from 'nostr-tools';

import { KINDS } from '@forum4ai/shared';

import {
  WriteGate,
  parseWriteAllowlist,
  parseWriteGateMode,
  writeGateReason,
  REGISTER_HINT,
} from '../src/write-gate.js';
import type { OperatorSource, OperatorStatus } from '../src/write-gate.js';
import { createGatewayApp } from '../src/app.js';
import type { GatewayPool, GatewayOutbox } from '../src/app.js';

const SK = generateSecretKey();
const PK = getPublicKey(SK);
const SK_AGENT = generateSecretKey();
const PK_AGENT = getPublicKey(SK_AGENT);
const SK_OTHER = generateSecretKey();
const PK_OTHER = getPublicKey(SK_OTHER);

function sign(kind: number, content = 'test', tags: string[][] = []): Event {
  return finalizeEvent({ kind, created_at: Math.floor(Date.now() / 1000), tags, content }, SK);
}

/** pool, ktorý si pamätá publikované eventy (žiadna skutočná sieť) */
class RecordingPool implements GatewayPool {
  readonly published: Event[] = [];
  async publish(event: Event): Promise<{ url: string; ok: boolean; message: string }[]> {
    this.published.push(event);
    return [{ url: 'ws://relay.test:8080', ok: true, message: 'OK accepted' }];
  }
  status() {
    return [
      {
        url: 'ws://relay.test:8080',
        connected: true,
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        lastConnectedAt: 0,
      },
    ];
  }
}

const outbox: GatewayOutbox = {
  async writeRelaysFor() {
    return ['ws://relay.test:8080'];
  },
};

function makeApp(options: Parameters<typeof createGatewayApp>[0]): Hono {
  return createGatewayApp({ logger: () => undefined, ...options });
}

describe('write-gate: parse env', () => {
  it('režim default off a neznáma hodnota = off (preklep nespustí blockovanie)', () => {
    expect(parseWriteGateMode(undefined)).toBe('off');
    expect(parseWriteGateMode('')).toBe('off');
    expect(parseWriteGateMode('ENFORCE')).toBe('enforce');
    expect(parseWriteGateMode(' log ')).toBe('log');
    expect(parseWriteGateMode('enforces')).toBe('off');
  });

  it('allowlist toleruje čiarku, medzeru, nové riadky a VEĽKÉ hex; neplatné zahodí', () => {
    const list = parseWriteAllowlist(
      `${PK.toUpperCase()}, ${PK_AGENT}\n  zz, ${'a'.repeat(63)}, ${'b'.repeat(64)}  `,
    );
    expect(list.has(PK)).toBe(true);
    expect(list.has(PK_AGENT)).toBe(true);
    expect(list.has('b'.repeat(64))).toBe(true);
    expect(list.size).toBe(3);
    expect(parseWriteAllowlist(undefined).size).toBe(0);
  });
});

describe('write-gate: rozhodovacia logika', () => {
  it('off pustí hocikoho a hlási to v dôvode', () => {
    const gate = new WriteGate({ mode: 'off' });
    const decision = gate.check(PK_OTHER);
    expect(decision.ok).toBe(true);
    expect(decision.reason).toContain('is off');
    expect(gate.enabled).toBe(false);
  });

  it('bootstrap allowlist platí bez zdroja operátorov', () => {
    const gate = new WriteGate({ mode: 'enforce', allow: [PK] });
    expect(gate.check(PK)).toMatchObject({ ok: true, via: 'bootstrap', operator: PK });
    expect(gate.check(PK_OTHER).ok).toBe(false);
  });

  it('allowlist je case-insensitive (hex z env môže byť veľký)', () => {
    const gate = new WriteGate({ mode: 'enforce', allow: [PK.toUpperCase()] });
    expect(gate.check(PK).ok).toBe(true);
  });

  /** fiktívny zdroj operátorov — P1 ho dodá `OperatorsDb` */
  function source(
    operators: Record<string, OperatorStatus>,
    agents: Record<string, string> = {},
  ): OperatorSource {
    return {
      operatorStatus: (pubkey) => operators[pubkey] ?? null,
      agentOf: (pubkey) => (agents[pubkey] !== undefined ? { operator: agents[pubkey]! } : null),
    };
  }

  it('aktívny operátor prejde, pending/lapsed/revoked nie (s dôvodom)', () => {
    const gate = new WriteGate({
      mode: 'enforce',
      source: source({
        [PK]: 'active',
        [PK_AGENT]: 'pending',
        [PK_OTHER]: 'lapsed',
      }),
    });
    expect(gate.check(PK)).toMatchObject({ ok: true, via: 'operator' });
    const pending = gate.check(PK_AGENT);
    expect(pending.ok).toBe(false);
    expect(pending.reason).toContain('approval');
    expect(gate.check(PK_OTHER).reason).toContain('lapsed');
    const unknown = gate.check('c'.repeat(64));
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toContain('is not in the operator list');
  });

  it('agent aktívneho operátora prejde a dedí jeho kľúč (per-operátor limit)', () => {
    const gate = new WriteGate({
      mode: 'enforce',
      source: source({ [PK]: 'active' }, { [PK_AGENT]: PK }),
    });
    const decision = gate.check(PK_AGENT);
    expect(decision).toMatchObject({ ok: true, via: 'agent', operator: PK });
  });

  it('agent neaktívneho operátora prejsť nemôže (revoked operátor = agenti taktiež)', () => {
    const gate = new WriteGate({
      mode: 'enforce',
      source: source({ [PK]: 'revoked' }, { [PK_AGENT]: PK }),
    });
    const decision = gate.check(PK_AGENT);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain('is not active');
  });

  it('status() má tvar pre GET /write-status (allowed, reason, code, via, operator)', () => {
    const gate = new WriteGate({ mode: 'enforce', allow: [PK] });
    expect(gate.status(PK)).toEqual({
      allowed: true,
      reason: expect.any(String),
      code: 'WG_BOOTSTRAP',
      via: 'bootstrap',
      operator: PK,
    });
    expect(gate.status(PK_OTHER).allowed).toBe(false);
  });

  /**
   * F4AI-23: `code` je stabilný API kontrakt — text `reason` sa mení (Phase 2
   * jazyk UI), kód NIE. Testuje SA EXAKTNE každá vetva rozhodnutia, lebo
   * práve na kódoch visuje UI (zámok composeru) aj `forum_whoami`.
   */
  it('code: WG_GATE_OFF / WG_BOOTSTRAP / WG_OPERATOR / WG_AGENT a stavové kódy', () => {
    expect(new WriteGate({ mode: 'off' }).check(PK_OTHER).code).toBe('WG_GATE_OFF');
    expect(new WriteGate({ mode: 'enforce', allow: [PK] }).check(PK).code).toBe('WG_BOOTSTRAP');

    const gate = new WriteGate({
      mode: 'enforce',
      source: source({
        [PK]: 'active',
        [PK_AGENT]: 'pending',
        [PK_OTHER]: 'lapsed',
      }),
    });
    expect(gate.check(PK).code).toBe('WG_OPERATOR');
    expect(gate.check(PK_AGENT).code).toBe('WG_PENDING');
    expect(gate.check(PK_OTHER).code).toBe('WG_LAPSED');
    expect(gate.check('c'.repeat(64)).code).toBe('WG_NOT_REGISTERED');
    expect(
      new WriteGate({ mode: 'enforce', source: source({ [PK]: 'revoked' }) }).check(PK).code,
    ).toBe('WG_REVOKED');

    // agent aktívneho operátora smie, agent NEaktívneho dedí jeho status
    expect(
      new WriteGate({ mode: 'enforce', source: source({ [PK]: 'active' }, { [PK_AGENT]: PK }) })
        .check(PK_AGENT)
        .code,
    ).toBe('WG_AGENT');
    const orphan = new WriteGate({
      mode: 'enforce',
      source: source({ [PK]: 'revoked' }, { [PK_AGENT]: PK }),
    });
    // agent NIE je revoked — revoked je jeho operátor, preto vlastný kód
    // (UI by inak hlásil agentovi, že on sám zrušil registráciu)
    expect(orphan.check(PK_AGENT).code).toBe('WG_AGENT_OPERATOR_INACTIVE');
    expect(orphan.check(PK_AGENT).reason).toContain('is not active');
  });

  it('403 dôvod obsahuje pubkey a odkaz na registráciu', () => {
    const gate = new WriteGate({ mode: 'enforce' });
    const reason = writeGateReason(PK_OTHER, gate.check(PK_OTHER));
    expect(reason).toContain(`${PK_OTHER.slice(0, 8)}…`);
    expect(reason).toContain(REGISTER_HINT);
    expect(reason).toMatch(/registration/i);
  });
});

describe('write-gate na POST /events', () => {
  it('off: zápis prejde a pool dostane event (rovnaké ako pred zavedením gate)', async () => {
    const pool = new RecordingPool();
    const app = makeApp({ pool, outbox, writeGate: new WriteGate({ mode: 'off' }) });
    const res = await app.request('/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sign(KINDS.QUESTION, 'otázka')),
    });
    expect(res.status).toBe(200);
    expect(pool.published).toHaveLength(1);
  });

  it('enforce: neregistrovaný pubkey → 403 s `write not allowed` a dôvodom, pool nevola', async () => {
    const pool = new RecordingPool();
    const app = makeApp({ pool, outbox, writeGate: new WriteGate({ mode: 'enforce' }) });
    const res = await app.request('/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sign(KINDS.QUESTION, 'otázka')),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      code: string;
      reasons: string[];
    };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('write not allowed');
    // F4AI-23: 403 nesie aj stabilný kód — UI/MCP na ňom rozhodujú
    expect(body.code).toBe('WG_NOT_REGISTERED');
    expect(body.reasons[0]).toContain(REGISTER_HINT);
    expect(pool.published).toHaveLength(0);
  });

  it('enforce: bootstrap allowlist a aktívny operátor prejdú', async () => {
    const pool = new RecordingPool();
    const gate = new WriteGate({
      mode: 'enforce',
      allow: [PK],
      source: {
        operatorStatus: (pubkey) => (pubkey === PK_OTHER ? 'active' : null),
        agentOf: () => null,
      },
    });
    const app = makeApp({ pool, outbox, writeGate: gate });
    for (const event of [sign(KINDS.QUESTION, 'a'), sign(KINDS.QUESTION, 'b')]) {
      const res = await app.request('/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });
      expect(res.status).toBe(200);
    }
    expect(pool.published).toHaveLength(2);
  });

  it('log: odmietnutie sa IBA zapíše, request prejde na publish', async () => {
    const lines: string[] = [];
    const pool = new RecordingPool();
    const app = makeApp({
      pool,
      outbox,
      logger: (line) => lines.push(line),
      writeGate: new WriteGate({ mode: 'log' }),
    });
    const res = await app.request('/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sign(KINDS.QUESTION, 'otázka')),
    });
    expect(res.status).toBe(200);
    expect(pool.published).toHaveLength(1);
    expect(lines.join('\n')).toContain('write-gate[log]');
  });

  it('gate sa pýta AŽ po overení podpisu — zlý podpis je 400, nie 403', async () => {
    const pool = new RecordingPool();
    const app = makeApp({ pool, outbox, writeGate: new WriteGate({ mode: 'enforce' }) });
    const event = { ...sign(KINDS.QUESTION, 'otázka'), sig: 'f'.repeat(128) };
    const res = await app.request('/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    expect(res.status).toBe(400);
  });

  it('403 nesie CORS hlavičky (UI inak chybu nevidí)', async () => {
    const pool = new RecordingPool();
    const app = makeApp({
      pool,
      outbox,
      corsOrigin: 'https://aiforum.myhood.sk',
      writeGate: new WriteGate({ mode: 'enforce' }),
    });
    const res = await app.request('/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://aiforum.myhood.sk' },
      body: JSON.stringify(sign(KINDS.QUESTION, 'otázka')),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://aiforum.myhood.sk');
  });
});
