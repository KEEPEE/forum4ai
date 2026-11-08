/**
 * Testy Composeru (S11, F4AI-17): polia, výber topicu z `GET /topics`,
 * NIP-01 podpis na mieste (overený `verifyEvent` z nostr-tools) a ukážkový
 * publish na gateway cez stub klienta. Žiadna sieť — signing je čistá
 * funkcia, publish ide cez injectnutý `Api`.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { verifyEvent } from 'nostr-tools/pure';

import { Composer, MOCK_REPLY_ROOT_ID } from '../src/components/Composer.js';
import { renderWithProviders } from './render.js';
import { ApiError } from '../src/api/client.js';
import { TEST_NPUB, TEST_PUBKEY, WRITE_STATUS_DENIED, stubApi } from './fixtures.js';
import type { NostrEvent } from '@forum4ai/shared';

function signedEventFromDom(): NostrEvent {
  const pre = document.querySelector('[data-testid="composer-signed-event"] pre');
  expect(pre).toBeTruthy();
  return JSON.parse(String(pre?.textContent)) as NostrEvent;
}

describe('Composer', () => {
  it('má polia nadpis/text a select topicu naplnený z gateway', async () => {
    renderWithProviders(<Composer />);
    expect(screen.getByLabelText('nadpis')).toBeTruthy();
    expect(screen.getByLabelText('text')).toBeTruthy();
    const select = (await screen.findByTestId('composer-topic')) as HTMLSelectElement;
    const options = Array.from(select.options).map((option) => option.value);
    expect(options).toContain('');
    expect(options).toContain(`30020:${'c3'.repeat(32)}:rust`);
    expect(select.textContent).toContain('rust-tokio');
  });

  it('podepíše 1023 s platným podpisom a práve jedným root markerom', async () => {
    renderWithProviders(<Composer />);
    fireEvent.change(screen.getByLabelText('nadpis'), { target: { value: 'Titulok' } });
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'telo odpovede' } });
    fireEvent.click(screen.getByTestId('composer-sign-btn'));

    await screen.findByTestId('composer-signed-event');
    const event = signedEventFromDom();
    expect(event.kind).toBe(1023);
    expect(event.pubkey).toBe(TEST_PUBKEY);
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.content).toBe('# Titulok\n\ntelo odpovede');
    expect(event.tags.filter((tag) => tag[0] === 'e' && tag[2] === 'root')).toHaveLength(1);
    expect(event.tags[0]?.[1]).toBe(MOCK_REPLY_ROOT_ID);
    expect(verifyEvent(event as unknown as Parameters<typeof verifyEvent>[0])).toBe(true);
  });

  // ── regression A11 ───────────────────────────────────────────────────────
  it('po podpise úprava textu zneplatní náhľad aj tlačidlo publish', async () => {
    renderWithProviders(<Composer />);
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'povodny text' } });
    fireEvent.click(screen.getByTestId('composer-sign-btn'));
    await screen.findByTestId('composer-signed-event');
    expect(screen.getByTestId('composer-publish-btn').hasAttribute('disabled')).toBe(false);

    // A11: podpis je snapshot — po úprave vstupu nesmie ostať pohnuteľný
    // "pošli na gateway" so STARÝM eventom
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'zmeneny text' } });
    expect(screen.queryByTestId('composer-signed-event')).toBeNull();
    expect(screen.getByTestId('composer-publish-btn').hasAttribute('disabled')).toBe(true);

    // ani nadpis/topic nesmú nechat stale podpis
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'dalsi text' } });
    fireEvent.click(screen.getByTestId('composer-sign-btn'));
    await screen.findByTestId('composer-signed-event');
    fireEvent.change(screen.getByLabelText('nadpis'), { target: { value: 'iny nadpis' } });
    expect(screen.queryByTestId('composer-signed-event')).toBeNull();
  });

  // ── regression C1 ────────────────────────────────────────────────────────
  it('parentId pridá parent marker, root marker ostáva na replyTo (práve jeden)', async () => {
    const realRoot = 'a1'.padEnd(64, '0');
    const answerId = 'b2'.padEnd(64, '0');
    renderWithProviders(<Composer replyTo={realRoot} parentId={answerId} />);
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'odpoved na odpoved' } });
    fireEvent.click(screen.getByTestId('composer-sign-btn'));
    await screen.findByTestId('composer-signed-event');
    const event = signedEventFromDom();
    const rootMarkers = event.tags.filter((tag) => tag[0] === 'e' && tag[2] === 'root');
    expect(rootMarkers).toEqual([['e', realRoot, 'root']]);
    expect(event.tags).toContainEqual(['e', answerId, 'parent']);
    expect(verifyEvent(event as unknown as Parameters<typeof verifyEvent>[0])).toBe(true);
  });

  it('po výbere topicu pridá `a` a `t` tag (väzba na topic)', async () => {    renderWithProviders(<Composer />);
    await screen.findByTestId('composer-topic');
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'text s topicom' } });
    fireEvent.change(screen.getByTestId('composer-topic'), {
      target: { value: `30020:${'c3'.repeat(32)}:rust` },
    });
    fireEvent.click(screen.getByTestId('composer-sign-btn'));
    await screen.findByTestId('composer-signed-event');
    const event = signedEventFromDom();
    expect(event.tags).toContainEqual(['a', `30020:${'c3'.repeat(32)}:rust`]);
    expect(event.tags).toContainEqual(['t', 'rust']);
  });

  it('bez textu nepodpíše a povie prečo', async () => {
    renderWithProviders(<Composer />);
    fireEvent.click(screen.getByTestId('composer-sign-btn'));
    const error = await screen.findByTestId('composer-error');
    expect(error.textContent).toContain('text odpovede je povinný');
    expect(screen.queryByTestId('composer-signed-event')).toBeNull();
  });

  it('po podpisu odovzdá event na gateway a ukáže výsledok publishu', async () => {
    const api = stubApi();
    renderWithProviders(<Composer />, { api });
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'odpoved' } });
    fireEvent.click(screen.getByTestId('composer-sign-btn'));
    await screen.findByTestId('composer-signed-event');

    const publishButton = screen.getByTestId('composer-publish-btn') as HTMLButtonElement;
    expect(publishButton.disabled).toBe(false);
    fireEvent.click(publishButton);

    await waitFor(() => {
      expect(api.publish).toHaveBeenCalledTimes(1);
    });
    const sent = (api.publish as unknown as { mock: { calls: NostrEvent[][] } }).mock.calls[0]?.[0];
    expect(sent?.kind).toBe(1023);
    expect(sent?.sig).toMatch(/^[0-9a-f]{128}$/);
    const note = await screen.findByTestId('composer-note');
    expect(note.textContent).toContain('quorum met');
  });

  it('pred podpisom je publish tlačidlo zablokované', () => {
    renderWithProviders(<Composer />);
    expect((screen.getByTestId('composer-publish-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('ukáže skrátený npub a POZADIE podpisovateľa (F4AI-23)', () => {
    renderWithProviders(<Composer />);
    const identityLine = screen.getByTestId('composer-identity');
    // skrátené, nie plných 62 znakov — header/composer nemajú byt výveska
    expect(identityLine.textContent).toContain('npub1');
    expect(identityLine.textContent).toContain('…');
    expect(identityLine.textContent ?? '').not.toContain(TEST_NPUB);
    // celý npub je v `title` (človek si ho overí, kopírovať sa nedá omylom)
    expect(identityLine.querySelector('code')?.getAttribute('title')).toBe(TEST_NPUB);
    // F4AI-23: zdroj kľúča je viditeľný — nie je jedno, či podpisuje
    // extension, bunker alebo vložený nsec
    expect(screen.getByTestId('composer-signer').textContent).toBe('dev nsec');
  });

  it('anonym má výzvu na prihlásenie, nie „identita nedostupná“ (F4AI-24)', () => {
    renderWithProviders(<Composer />, { nsec: null });
    expect(screen.queryByTestId('composer-identity')).toBeNull();
    const notice = screen.getByTestId('composer-anonymous');
    expect(notice.textContent).toContain('prihlás');
    // žiadne tvrdenie o chybe — anonym je platný stav
    expect(notice.className).not.toContain('error');
  });

  it('„odpojiť“ z relácie urobí anonyma (F4AI-23)', () => {
    renderWithProviders(<Composer />);
    expect(screen.getByTestId('composer-identity').textContent).toMatch(/npub1/);
    fireEvent.click(screen.getByTestId('composer-reset-btn'));
    // disconnect NESMÍ obnovovať bootstrap — žiadne auto-keygen, žiadne
    // tiché „a je zase prihlásený“
    expect(screen.getByTestId('composer-anonymous').textContent).toContain('prihlás');
    expect(screen.queryByTestId('composer-identity')).toBeNull();
  });

  // ── write-gate (dizajn B10) ──────────────────────────────────────────────
  it('zamkne polia aj tlačidlá, keď gateway povedal allowed=false', async () => {
    renderWithProviders(<Composer />, { api: stubApi({ writeStatus: async () => WRITE_STATUS_DENIED }) });

    await screen.findByTestId('composer-locked');
    const textarea = screen.getByLabelText('text') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(textarea.title).toContain('pubkey is not in the operator list');
    expect((screen.getByTestId('composer-submit-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('composer-sign-btn') as HTMLButtonElement).disabled).toBe(true);
    // „nová identita“ zostáva prístupná — správa kľúča nie je zápis do fóra
    expect((screen.getByTestId('composer-reset-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('403 od gatewayu: slovenský reason z telieska ide do error riadku', async () => {
    // presný tvar telieska z `gateway/src/app.ts` (write-gate 403)
    const reason =
      'pubkey f9308a01… is not a registered operator/agent (pubkey is not in the operator list); ' +
      'writing is only for instances that mirror the forum — registration: /api/register';
    const api = stubApi({
      publish: async () => {
        throw new ApiError('write not allowed (403) na /events', 403, { ok: false, error: 'write not allowed', reasons: [reason] }, '/events');
      },
    });
    renderWithProviders(<Composer />, { api });

    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'pokus odpovede' } });
    fireEvent.click(screen.getByTestId('composer-submit-btn'));

    const error = await screen.findByTestId('composer-error');
    // B10: reason sa NESMIE prehltnúť — používáč musí vidieť, čo povedal server
    expect(error.textContent).toContain('is not a registered operator/agent');
    expect(error.textContent).toContain('registration: /api/register');
  });
});

describe('Composer — toolbar formátovania (Phase 3b)', () => {
  it('tlačidlo diagram vloží ```mermaid šablónu do textu', () => {
    renderWithProviders(<Composer />);
    const textarea = screen.getByLabelText('text') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'pred' } });
    fireEvent.click(screen.getByTestId('toolbar-mermaid'));
    expect(textarea.value).toContain('```mermaid');
    expect(textarea.value).toContain('graph TD');
    expect(textarea.value.startsWith('pred')).toBe(true);
  });

  it('tlačidlo graf vloží ```chart šablónu s platným JSON (v:1)', () => {
    renderWithProviders(<Composer />);
    const textarea = screen.getByLabelText('text') as HTMLTextAreaElement;
    fireEvent.click(screen.getByTestId('toolbar-chart'));
    expect(textarea.value).toContain('```chart');
    const json = textarea.value.replace('```chart', '').replace('```', '').trim();
    expect(() => JSON.parse(json)).not.toThrow();
    expect((JSON.parse(json) as { v: number }).v).toBe(1);
  });

  it('tlačidlo matematika vloží $$ blok', () => {
    renderWithProviders(<Composer />);
    const textarea = screen.getByLabelText('text') as HTMLTextAreaElement;
    fireEvent.click(screen.getByTestId('toolbar-math'));
    expect(textarea.value).toContain('$$');
  });

  it('napoveda formátovania je collapsible a hovorí o markdown + limite 8', () => {
    renderWithProviders(<Composer />);
    const help = screen.getByTestId('composer-help');
    expect(help.tagName).toBe('DETAILS');
    expect(help.hasAttribute('open')).toBe(false);
    fireEvent.click(screen.getByText('napoveda k formátovaniu'));
    expect(help.hasAttribute('open')).toBe(true);
    const body = help.querySelector('.composer-help-body');
    expect(body?.textContent).toContain('markdown');
    expect(body?.textContent).toContain('8');
  });

  it('vklad šablóny zmaze neplatný podpis (snapshot nesmie zostať po úprave)', async () => {
    renderWithProviders(<Composer />);
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'pokus' } });
    fireEvent.click(screen.getByTestId('composer-sign-btn'));
    await screen.findByTestId('composer-signed-event');
    fireEvent.click(screen.getByTestId('toolbar-math'));
    expect(document.querySelector('[data-testid="composer-signed-event"]')).toBeNull();
  });
});
