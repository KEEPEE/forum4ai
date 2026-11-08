/**
 * Unit testy REST klienta (S11, F4AI-17) — žiadna sieť: `createApi`
 * dostane injectnutý `fetch`, takže testujeme URL, query, spracovanie
 * chýb a timeout. (Stránky testujú cez stub `Api`, tento súbor testuje
 * samotnú vrstvu, ktorá ten stub v produkcii nahrádza.)
 */
import { describe, expect, it, vi } from 'vitest';

import { ApiError, buildQuery, createApi, DEFAULT_GATEWAY_URL, gatewayBaseUrl, type FetchLike } from '../src/api/client.js';
import { jsonFetch, SAMPLE_FEED, SAMPLE_PUBLISH, SAMPLE_TOPICS } from './fixtures.js';

describe('gatewayBaseUrl', () => {
  it('použije defaultnú adresu gateway, keď env neexistuje', () => {
    expect(gatewayBaseUrl({})).toBe(DEFAULT_GATEWAY_URL);
    expect(DEFAULT_GATEWAY_URL).toBe('http://127.0.0.1:18081');
  });

  it('rešpektuje VITE_GATEWAY_URL a oreže koncové lomítko', () => {
    expect(gatewayBaseUrl({ VITE_GATEWAY_URL: 'http://10.0.0.5:3001/' })).toBe('http://10.0.0.5:3001');
  });

  it('ignoruje prázdnu hodnotu env premennej', () => {
    expect(gatewayBaseUrl({ VITE_GATEWAY_URL: '   ' })).toBe(DEFAULT_GATEWAY_URL);
  });
});

describe('buildQuery', () => {
  it('spája polia čiarkou a vynecháva undefined', () => {
    expect(buildQuery({ kinds: [1020, 1021], limit: 5, authors: undefined })).toBe('?kinds=1020%2C1021&limit=5');
  });

  it('vráti prázdny reťazec pre prázdny objekt', () => {
    expect(buildQuery({})).toBe('');
    expect(buildQuery(undefined)).toBe('');
  });

  it('kóduje medzery v dotaze', () => {
    expect(buildQuery({ q: 'graceful shutdown' })).toBe('?q=graceful+shutdown');
  });
});

describe('createApi — cesty a metódy', () => {
  it('volá GET /topics na kompletnej URL', async () => {
    const fetchMock = jsonFetch(200, SAMPLE_TOPICS);
    const api = createApi({ baseUrl: 'http://gateway.test', fetch: fetchMock });
    const result = await api.topics();
    expect(fetchMock).toHaveBeenCalledWith('http://gateway.test/topics', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result.topic_count).toBe(3);
  });

  it('ostrihne koncové lomítko z baseUrl', async () => {
    const fetchMock = jsonFetch(200, SAMPLE_FEED);
    const api = createApi({ baseUrl: 'http://gateway.test/', fetch: fetchMock });
    await api.feed({ limit: 5 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://gateway.test/feed?limit=5');
  });

  it('predá filter kinds a limit do query /feed', async () => {
    const fetchMock = jsonFetch(200, SAMPLE_FEED);
    const api = createApi({ baseUrl: 'http://gateway.test', fetch: fetchMock });
    await api.feed({ kinds: [1020, 1021], limit: 3 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://gateway.test/feed?kinds=1020%2C1021&limit=3');
  });

  it('escapuje parametre cesty (slug, id, pubkey)', async () => {
    const fetchMock = jsonFetch(200, SAMPLE_TOPICS);
    const api = createApi({ baseUrl: 'http://gateway.test', fetch: fetchMock });
    await api.topic('rust-tokio');
    await api.thread('a'.repeat(64));
    await api.reputation('b'.repeat(64), 'voter');
    const urls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(urls[0]).toBe('http://gateway.test/topics/rust-tokio');
    expect(urls[1]).toBe(`http://gateway.test/threads/${'a'.repeat(64)}`);
    expect(urls[2]).toBe(`http://gateway.test/reputation/${'b'.repeat(64)}?domain=voter`);
  });

  it('POST /events odosiela kánonický event s content-type', async () => {
    const fetchMock = jsonFetch(200, SAMPLE_PUBLISH);
    const api = createApi({ baseUrl: 'http://gateway.test', fetch: fetchMock });
    const event = {
      id: 'c'.repeat(64),
      pubkey: 'd'.repeat(64),
      created_at: 1700000000,
      kind: 1023,
      tags: [['e', 'e'.repeat(64), 'root']],
      content: 'odpoved',
      sig: 'f'.repeat(128),
    };
    const result = await api.publish(event);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toMatchObject({ kind: 1023, id: event.id });
    expect(result.quorum_met).toBe(true);
  });
});

describe('createApi — spracovanie chýb', () => {
  it('400 validácia → ApiError s code z telesa a reasons', async () => {
    const api = createApi({
      baseUrl: 'http://gateway.test',
      fetch: jsonFetch(400, { ok: false, error: 'invalid slug', reasons: ['slug nezodpovedá povolenému tvaru'] }),
    });
    const error = await api.topic('Rust!').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).code).toBe('invalid slug');
    expect((error as ApiError).reasons).toEqual(['slug nezodpovedá povolenému tvaru']);
  });

  it('503 index unavailable → status 503 a reason', async () => {
    const api = createApi({
      baseUrl: 'http://gateway.test',
      fetch: jsonFetch(503, { ok: false, error: 'index unavailable', reason: 'GATEWAY_INDEX_DB nenastavená', path: '/db/index.sqlite' }),
    });
    const error = await api.search({ q: 'x' }).catch((err: unknown) => err);
    expect((error as ApiError).status).toBe(503);
    expect((error as ApiError).code).toBe('index unavailable');
    expect((error as ApiError).reasons).toEqual(['GATEWAY_INDEX_DB nenastavená']);
  });

  it('404 bez `reasons` → aspoň `error`', async () => {
    const api = createApi({ baseUrl: 'http://gateway.test', fetch: jsonFetch(404, { ok: false, error: 'topic not found', slug: 'x' }) });
    const error = await api.topic('x').catch((err: unknown) => err);
    expect((error as ApiError).reasons).toEqual(['topic not found']);
  });

  it('zlyhanie siete → status 0 a hláška „gateway nedostupný“', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as FetchLike;
    const api = createApi({ baseUrl: 'http://gateway.test', fetch: failing });
    const error = await api.feed().catch((err: unknown) => err);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).message).toContain('gateway nedostupný');
  });

  it('ne-JSON úspešná odpoveď → ApiError (očakávali sme JSON)', async () => {
    const api = createApi({ baseUrl: 'http://gateway.test', fetch: jsonFetch(200, '<html>proxy error</html>') });
    const error = await api.topics().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain('očakávali sme JSON');
  });

  it('timeout preruší request a nahlási status 0', async () => {
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    ) as unknown as FetchLike;
    const api = createApi({ baseUrl: 'http://gateway.test', fetch: hanging, timeoutMs: 25 });
    const error = await api.topics().catch((err: unknown) => err);
    expect((error as ApiError).status).toBe(0);
    expect(hanging).toHaveBeenCalled();
  });
});
