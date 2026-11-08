/**
 * Testy Composer publish flow (F4AI-18, S12) — skutočné odoslanie cez
 * `POST /events` (stub `Api.publish` → overíme teliesko a callback):
 *  - `question` (1020): tagy `a` (adresa 30020) + `t` (slug), podpis
 *    overený `verifyEvent`, po úspechu `onPublished` (invalidácia stránky)
 *    a zmazanie polí
 *  - `reply` (1023): práve jeden `e` tag s markerom `root` na `replyTo`
 *  - chyba publishu → inline error s `reasons` z `ApiError`
 *  - kvórum nesplnené → note bez invalidácie
 *  - signing za rozhraním `Signer`: NIP-07 mock (`window.nostr`) aj
 *    nsec fallback — UI ukáže, ktoré pozadie použilo
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';

import { Composer } from '../src/components/Composer.js';
import { ApiError, type Api } from '../src/api/client.js';
import { identityFromNsec } from '../src/nostr/keys.js';
import type { Nip07Provider } from '../src/nostr/signer.js';
import { renderWithProviders } from './render.js';
import { SAMPLE_PUBLISH, TEST_NSEC, TEST_PUBKEY, hexId, stubApi } from './fixtures.js';
import type { NostrEvent } from '@forum4ai/shared';
import type { PublishResponse } from '../src/api/types.js';

const SECRET = identityFromNsec(TEST_NSEC).secretKey;
const TOPIC = { address: `30020:${hexId('c3')}:f4ai18-topic`, slug: 'f4ai18-topic' };
const ROOT_ID = hexId('a1');

function publishedEvent(api: Api): NostrEvent {
  const calls = (api.publish as unknown as { mock: { calls: NostrEvent[][] } }).mock.calls;
  const sent = calls[0]?.[0];
  if (sent === undefined) throw new Error('api.publish nebol zavolaný');
  return sent;
}

/** NIP-07 provider podpisujúci reálnym TEST kľúčom (verifyEvent prejde) */
function makeNip07(): Nip07Provider {
  return {
    getPublicKey: async () => TEST_PUBKEY,
    signEvent: async (event) => {
      const signed = finalizeEvent(
        {
          kind: Number(event['kind']),
          content: String(event['content']),
          tags: event['tags'] as string[][],
          created_at: Number(event['created_at']),
        },
        SECRET,
      );
      return { ...event, id: signed.id, sig: signed.sig };
    },
  };
}

describe('Composer — otázka 1020 z /topics/:slug', () => {
  it('publikuje 1020 s `a`+`t` tagom, validným podpisom a volá onPublished', async () => {
    const api = stubApi();
    const onPublished = vi.fn();
    renderWithProviders(<Composer mode="question" topic={TOPIC} onPublished={onPublished} />, { api });

    fireEvent.change(screen.getByLabelText('nadpis'), { target: { value: 'Ako na FTS5 ranking?' } });
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'použiť trigramy?' } });
    fireEvent.click(screen.getByTestId('composer-submit-btn'));

    await waitFor(() => expect(api.publish).toHaveBeenCalledTimes(1));
    const event = publishedEvent(api);
    expect(event.kind).toBe(1020);
    expect(event.pubkey).toBe(TEST_PUBKEY);
    expect(event.content).toBe('# Ako na FTS5 ranking?\n\npoužiť trigramy?');
    expect(event.tags).toContainEqual(['a', TOPIC.address]);
    expect(event.tags).toContainEqual(['t', TOPIC.slug]);
    expect(verifyEvent(event as unknown as Parameters<typeof verifyEvent>[0])).toBe(true);

    await waitFor(() => expect(onPublished).toHaveBeenCalledTimes(1));
    expect(onPublished.mock.calls[0]?.[1]).toEqual(SAMPLE_PUBLISH);
    const note = await screen.findByTestId('composer-note');
    expect(note.textContent).toContain('quorum met');
    // po úspechu sa polia zmazú (používáč môže písať ďalšiu otázku)
    await waitFor(() => expect((screen.getByLabelText('text') as HTMLTextAreaElement).value).toBe(''));
  });

  it('bez nadpisu nepublikuje a povie prečo (1020 vyžaduje title)', async () => {
    const api = stubApi();
    renderWithProviders(<Composer mode="question" topic={TOPIC} />, { api });
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'len text' } });
    fireEvent.click(screen.getByTestId('composer-submit-btn'));
    const error = await screen.findByTestId('composer-error');
    expect(error.textContent).toContain('vyžaduje nadpis');
    expect(api.publish).not.toHaveBeenCalled();
  });

  it('v question režime nie je select topicu (fixná adresa z page)', async () => {
    renderWithProviders(<Composer mode="question" topic={TOPIC} />);
    await screen.findByTestId('composer-topic-fixed');
    expect(screen.queryByTestId('composer-topic')).toBeNull();
  });
});

describe('Composer — odpoveď 1023 a chyby publishu', () => {
  it('reply režim pošle 1023 s práve jedným root markerom na replyTo', async () => {
    const api = stubApi();
    renderWithProviders(<Composer replyTo={ROOT_ID} />, { api });
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'odpoveď' } });
    fireEvent.click(screen.getByTestId('composer-submit-btn'));

    await waitFor(() => expect(api.publish).toHaveBeenCalledTimes(1));
    const event = publishedEvent(api);
    expect(event.kind).toBe(1023);
    const roots = event.tags.filter((tag) => tag[0] === 'e' && tag[2] === 'root');
    expect(roots).toHaveLength(1);
    expect(roots[0]?.[1]).toBe(ROOT_ID);
  });

  it('chyba 400 od gateway → inline error s reasonmi z ApiError', async () => {
    const api = stubApi({
      publish: async () => {
        throw new ApiError(
          'validation failed (400)',
          400,
          { ok: false, error: 'validation failed', reasons: ['post (1023) musí mať práve jeden e tag s markerom root'] },
          '/events',
        );
      },
    });
    renderWithProviders(<Composer replyTo={ROOT_ID} />, { api });
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'odpoveď' } });
    fireEvent.click(screen.getByTestId('composer-submit-btn'));

    const error = await screen.findByTestId('composer-error');
    expect(error.textContent).toContain('práve jeden e tag s markerom root');
    expect(screen.queryByTestId('composer-note')).toBeNull();
  });

  it('kvórum nesplnené (424) → note bez invalidácie a polia ostávajú', async () => {
    const failed: PublishResponse = {
      ok: false,
      event_id: hexId('ee'),
      quorum_met: false,
      results: [{ url: 'ws://relay.test', ok: false, message: 'timeout' }],
      error: 'quorum not met',
    };
    const api = stubApi({ publish: async () => failed });
    const onPublished = vi.fn();
    renderWithProviders(<Composer replyTo={ROOT_ID} onPublished={onPublished} />, { api });
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'odpoveď' } });
    fireEvent.click(screen.getByTestId('composer-submit-btn'));

    const note = await screen.findByTestId('composer-note');
    expect(note.textContent).toContain('kvórum nesplnené');
    expect(onPublished).not.toHaveBeenCalled();
    expect((screen.getByLabelText('text') as HTMLTextAreaElement).value).toBe('odpoveď');
  });
});

describe('Composer — Signer pozadie (NIP-07 vs nsec)', () => {
  it('bez window.nostr podpisuje nsec a UI ukáže `dev nsec`', async () => {
    const api = stubApi();
    renderWithProviders(<Composer replyTo={ROOT_ID} />, { api });
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'odpoveď' } });
    fireEvent.click(screen.getByTestId('composer-submit-btn'));
    await waitFor(() => expect(api.publish).toHaveBeenCalledTimes(1));
    // F4AI-23: UI ukáže LIDSKÝ názov pozadia, nie interný identifikátor
    expect((await screen.findByTestId('composer-signer')).textContent).toBe('dev nsec');
  });

  it('s NIP-07 podpisuje extension a UI ukáže `extension`', async () => {
    const api = stubApi();
    // injectnutý provider + `nsec: null` — v relácii JE len extension,
    // takže podpis nemôže pochádzať z dev kľúča
    renderWithProviders(<Composer replyTo={ROOT_ID} />, { api, nsec: null, nip07: makeNip07() });
    // NIP-07 signer sa pripája async (na rozdiel od predpriadaného kľúča) —
    // tlačidlá sú počas `connecting` zamknuté, preto najprv počkáme
    await screen.findByTestId('composer-identity');
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'odpoveď z extensionu' } });
    fireEvent.click(screen.getByTestId('composer-submit-btn'));

    await waitFor(() => expect(api.publish).toHaveBeenCalledTimes(1));
    expect((await screen.findByTestId('composer-signer')).textContent).toBe('extension');
    const event = publishedEvent(api);
    expect(event.pubkey).toBe(TEST_PUBKEY);
    expect(verifyEvent(event as unknown as Parameters<typeof verifyEvent>[0])).toBe(true);
  });

  it('tlačidlo „podepiš“ zostáva: náhľad 7-pôlového eventu bez siete', async () => {
    const api = stubApi();
    renderWithProviders(<Composer replyTo={ROOT_ID} />, { api });
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'len podpis' } });
    fireEvent.click(screen.getByTestId('composer-sign-btn'));

    await screen.findByTestId('composer-signed-event');
    expect(api.publish).not.toHaveBeenCalled();
    const note = screen.getByTestId('composer-note');
    expect(note.textContent).toContain('(nsec)');
    const pre = document.querySelector('[data-testid="composer-signed-event"] pre');
    const event = JSON.parse(String(pre?.textContent)) as NostrEvent;
    expect(Object.keys(event).sort()).toEqual(['content', 'created_at', 'id', 'kind', 'pubkey', 'sig', 'tags']);
  });
});
