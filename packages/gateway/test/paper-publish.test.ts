/**
 * Testy lintu papiera na `POST /events` a veľkostných stropov (Phase 4a,
 * dizajn Q4).
 *
 * Druhá polovica kontraktu je PORADIE:
 *   signature → write-gate → paper lint → publish.
 * Gateway nesmie nadať 400 s detailmi o obsahu niekomu, koho podpis
 * neplatí (DoS lacným lintom), a nesmie publishnúť papier, ktorý UI nedokáže
 * vyrenderovať (chybajúce reference, neplatný chart DSL). Testy to dokladujú
 * tak, že na zlom podpise a na zamknutom gate nechajú papier ZÁMERNE
 * neplatný — ak by niekto presunul lint skôr, testy padnú.
 *
 * Veľkosť: HTTP obálka (`maxEventBytes`, default 262 144 B) je HRUBÝ strop
 * celého JSONu; per-kind strop obsahu (`MAX_CONTENT_BYTES_BY_KIND`) rieši
 * validátor. 160 KiB papier sa preto do obálky zmestí, ale 40 KiB POST nie.
 */
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import type { Event } from 'nostr-tools';

import { KINDS } from '@forum4ai/shared';

import {
  createGatewayApp,
  MAX_EVENT_BYTES_DEFAULT,
  type GatewayOutbox,
  type GatewayPool,
} from '../src/app.js';
import { WriteGate } from '../src/write-gate.js';
import type { PublishResult, RelayStatus } from '../src/relay-pool.js';

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);

function sign(kind: number, tags: string[][], content: string): Event {
  return finalizeEvent(
    { kind, created_at: Math.floor(Date.now() / 1000), tags, content },
    sk,
  );
}

class MockPool implements GatewayPool {
  publishCalls: Event[] = [];
  results: PublishResult[] = [{ url: 'ws://w1.example/', ok: true, message: 'accepted' }];

  async publish(event: Event): Promise<PublishResult[]> {
    this.publishCalls.push(event);
    return this.results;
  }

  status(): RelayStatus[] {
    return [
      { url: 'ws://w1.example/', connected: true, attempts: 0, nextAttemptAt: 0, lastError: null, lastConnectedAt: 1 },
    ];
  }
}

class MockOutbox implements GatewayOutbox {
  relays = ['ws://w1.example/'];

  async writeRelaysFor(): Promise<string[]> {
    return this.relays;
  }
}

function makeApp(overrides: {
  pool?: MockPool;
  maxEventBytes?: number;
  maxBodyBytes?: number;
  writeGate?: WriteGate;
} = {}) {
  const pool = overrides.pool ?? new MockPool();
  const lines: string[] = [];
  const app = createGatewayApp({
    pool,
    outbox: new MockOutbox(),
    logger: (line) => lines.push(line),
    ...(overrides.maxEventBytes !== undefined ? { maxEventBytes: overrides.maxEventBytes } : {}),
    ...(overrides.maxBodyBytes !== undefined ? { maxBodyBytes: overrides.maxBodyBytes } : {}),
    ...(overrides.writeGate !== undefined ? { writeGate: overrides.writeGate } : {}),
  });
  return { app, pool, lines };
}

async function post(app: ReturnType<typeof makeApp>['app'], event: unknown) {
  const res = await app.request('/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const LANG_TAGS = [['L', 'ISO-639-1'], ['l', 'en', 'ISO-639-1']];
/** kind 1023 vyzaduje prave jeden `e` tag s root markerom (shared validator) */
const ROOT: [string, string, string] = ['e', 'a'.repeat(64), 'root'];

const CLEAN_BODY = [
  '## Introduction',
  '',
  'The stack is in @fig:arch and we cite [@novak2026].',
  '',
  '```mermaid fig=arch caption="Replication stack"',
  'flowchart LR; a-->b',
  '```',
  '',
  '```references',
  '[{"id":"novak2026","type":"article-journal","title":"Negentropy sets",' +
    '"author":[{"family":"Novakova","given":"Jana"}],"issued":{"date-parts":[[2026]]}}]',
  '```',
].join('\n');

/** kánonický platný papier (dizajn Q4) — voliteľne s prehákanými tagmi */
function paperEvent(options: { tags?: string[][]; body?: string } = {}): Event {
  const tags =
    options.tags ??
    [
      ['d', 'negentropy-replication'],
      ['title', 'Negentropy Replication of Gated Nostr Forums'],
      ['summary', 'We replicate gated nostr forums with negentropy sets.'],
      ['published_at', '1793836800'],
      ['t', 'distributed-systems'],
      ['author', 'Jana Novakova', 'Comenius University', pubkey, '0000-0002-1825-0097'],
      ['p', pubkey, '', 'author'],
      ['license', 'CC-BY-4.0'],
      ['doi', '10.5281/zenodo.1234567'],
      ...LANG_TAGS,
    ];
  return sign(KINDS.PUBLICATION, tags, options.body ?? CLEAN_BODY);
}

describe('POST /events — lint papiera (30023)', () => {
  it('platný papier → 200 s prázdzymi paper_warnings a publishom', async () => {
    const { app, pool } = makeApp();
    const event = paperEvent();
    const { status, body } = await post(app, event);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.event_id).toBe(event.id);
    expect(body.paper_warnings).toEqual([]);
    expect(body.paper_warning_codes).toEqual([]);
    // jazykový verdikt (2b2) a paper varovania žijú vedľa seba
    expect(body.lang).toBe('en');
    expect(pool.publishCalls).toHaveLength(1);
  });

  it('papier s nekonzistentnymi referenciami → 200 + varovania so kódmi', async () => {
    const { app, pool } = makeApp();
    const body =
      '## Intro\n\nCites [@ghost2020] only.\n\n```references\n[{"id":"novak2026","type":"article-journal","title":"X","author":[{"family":"N","given":"J"}],"issued":{"date-parts":[[2026]]}}]\n```';
    const { status, body: json } = await post(app, paperEvent({ body }));
    expect(status).toBe(200);
    const codes = json.paper_warning_codes as string[];
    expect(codes).toContain('CITE_UNKNOWN');
    expect(codes).toContain('REF_UNCITED');
    expect((json.paper_warnings as string[])[codes.indexOf('CITE_UNKNOWN')]).toContain('ghost2020');
    expect(pool.publishCalls).toHaveLength(1); // varovania NEBLKUJÚ publish
  });

  it('papier bez title tagu → 400 s codes[] a bez publishu', async () => {
    const { app, pool, lines } = makeApp();
    const tags = paperEvent().tags.filter((tag) => tag[0] !== 'title');
    const { status, body } = await post(app, paperEvent({ tags }));
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('paper lint failed');
    const codes = body.codes as string[];
    expect(codes).toContain('PAPER_TITLE_REQUIRED');
    // `reasons[i]` a `codes[i]` sú indexovo zsene (kontrakt 2b1)
    expect(body.reasons).toHaveLength(codes.length);
    expect(String(body.reasons[codes.indexOf('PAPER_TITLE_REQUIRED')])).toContain('title');
    expect(body.errors).toEqual(body.reasons);
    expect(pool.publishCalls).toHaveLength(0);
    expect(lines.join('\n')).toContain('paper lint 400');
  });

  it('neplatny chart DSL v papieri → 400 CHART_INVALID (zdieľany dsl validátor)', async () => {
    const { app, pool } = makeApp();
    const body = '## Intro\n\n```chart\n{"type":"bar"}\n```\n\n```references\n[{"id":"a","type":"article-journal","title":"A","author":[{"family":"A","given":"B"}],"issued":{"date-parts":[[2020]]}}]\n```';
    const { status, body: json } = await post(app, paperEvent({ body }));
    expect(status).toBe(400);
    expect(json.codes).toContain('CHART_INVALID');
    expect(pool.publishCalls).toHaveLength(0);
  });

  it('160 KiB papier sa publishne (per-kind strop obsahu), 40 KiB POST nie', async () => {
    const { app, pool } = makeApp();
    const big = `## Intro\n\n${'x'.repeat(150 * 1024)}\n\n[@novak2026]\n\n\`\`\`references\n[{"id":"novak2026","type":"article-journal","title":"X","author":[{"family":"N","given":"J"}],"issued":{"date-parts":[[2026]]}}]\n\`\`\``;
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(32 * 1024);
    const paper = await post(app, paperEvent({ body: big }));
    expect(paper.status).toBe(200);

    const postEvent = sign(KINDS.POST, [ROOT, ...LANG_TAGS], 'x'.repeat(40 * 1024));
    const tooBig = await post(app, postEvent);
    expect(tooBig.status).toBe(400);
    // bezne validacne 400 NEMA `codes` — kódy (2b1) má len jazyk
    // a paper lint; tu rozhoduje shared validátor
    expect(tooBig.body.error).toBe('invalid event');
    expect(String(tooBig.body.reasons)).toContain('kind 1023');
    expect(String(tooBig.body.reasons)).toContain('larger than 32768');
    expect(pool.publishCalls).toHaveLength(1); // len papier
  });

  it('iny kind sa nelintuje (1023 s [@cite] a bez referencií → 200)', async () => {
    const { app } = makeApp();
    const event = sign(KINDS.QUESTION, [['d', 'q-1'], ...LANG_TAGS], '[@nope] and @fig:x — nie je to papier');
    const { status, body } = await post(app, event);
    expect(status).toBe(200);
    expect(body.paper_warnings).toBeUndefined();
    expect(body.paper_warning_codes).toBeUndefined();
  });
});

describe('POST /events — poradie: podpis → gate → lint', () => {
  it('zlý podpis + zlý papier → 400 o podpise (lint nesmie uniesť neoverený event)', async () => {
    const { app, pool } = makeApp();
    const event = paperEvent();
    const tampered = { ...event, sig: 'f'.repeat(128) };
    const { status, body } = await post(app, tampered);
    expect(status).toBe(400);
    expect(body.error).not.toBe('paper lint failed');
    expect(String(body.reasons).toLowerCase()).toContain('signature');
    expect(pool.publishCalls).toHaveLength(0);
  });

  it('zamknutý write-gate + zlý papier → 403 s WG kódom (gate pred lintom)', async () => {
    const { app, pool } = makeApp({ writeGate: new WriteGate({ mode: 'enforce' }) });
    const tags = paperEvent().tags.filter((tag) => tag[0] !== 'title');
    const { status, body } = await post(app, paperEvent({ tags }));
    expect(status).toBe(403);
    expect(body.error).not.toBe('paper lint failed');
    expect(String(body.code)).toMatch(/^WG_/);
    expect(pool.publishCalls).toHaveLength(0);
  });
});

describe('POST /events — veľkosť obálky (maxEventBytes)', () => {
  it('default 262 144 B: 160 KiB papier prejde, 300 KiB telo → 413', async () => {
    const { app } = makeApp();
    expect(MAX_EVENT_BYTES_DEFAULT).toBe(262_144);

    const big = 'x'.repeat(150 * 1024);
    expect(Buffer.byteLength(big, 'utf8')).toBeLessThan(160 * 1024);
    expect((await post(app, paperEvent({ body: big }))).status).toBe(200);

    const huge = sign(KINDS.POST, [ROOT, ...LANG_TAGS], 'x'.repeat(300 * 1024));
    const res = await post(app, huge);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('payload too large');
    expect(String(res.body.reasons)).toContain('262144');
  });

  it('options.maxEventBytes rešpektuje a deprecated maxBodyBytes je alias', async () => {
    const event = sign(KINDS.POST, [ROOT, ...LANG_TAGS], 'x'.repeat(4 * 1024));

    const viaNew = makeApp({ maxEventBytes: 2_000 });
    expect((await post(viaNew.app, event)).status).toBe(413);

    const viaAlias = makeApp({ maxBodyBytes: 2_000 });
    const res = await post(viaAlias.app, event);
    expect(res.status).toBe(413);
    expect(String(res.body.reasons)).toContain('2000');

    const roomy = makeApp({ maxEventBytes: 100_000 });
    expect((await post(roomy.app, event)).status).toBe(200);
  });

  it('Content-Length nad stropom → 413 skôr, než sa telo prečíta', async () => {
    const { app, pool } = makeApp({ maxEventBytes: 4_000 });
    const res = await app.request('/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '99999' },
      body: JSON.stringify(sign(KINDS.POST, [ROOT, ...LANG_TAGS], 'short')),
    });
    expect(res.status).toBe(413);
    expect(pool.publishCalls).toHaveLength(0);
  });
});
