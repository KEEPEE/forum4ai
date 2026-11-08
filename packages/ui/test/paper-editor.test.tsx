/**
 * PaperEditor `/write-paper` (Phase 4b).
 *
 * Testuje tri veci, ktoré robia z editora nástroj a nie formulár:
 *  1. **live lint** — debounce ~600 ms → `POST /lint`; chyby blokujú
 *     publikovanie, varovania nie; copy je locale veta podľa kódu;
 *  2. **wire kontrakt** — podpisový event má 5-prvkové `author` tagy,
 *     `p` markery spoluautorov, NIP-32 `L`/`l` ŠTÍTKY PRED podpisom
 *     (podpísaný event sa nedoplní) a ` ```references ` zárez PRÁVE RAZ
 *     na koncie teľa (`buildPaperBody`);
 *  3. **koncept** — `localStorage` draft sa ukladá, obnovuje a zahadzuje.
 *
 * Signer je dev nsec (`TEST_NSEC`), podpis je deterministický a event
 * overujeme reálnym `verifyEvent`.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { verifyEvent } from 'nostr-tools/pure';
import { beforeEach, describe, expect, it } from 'vitest';

import { PAPER_DRAFT_KEY, PaperEditorPage } from '../src/pages/PaperEditorPage.js';
import { ApiError } from '../src/api/client.js';
import { renderApp, renderWithProviders } from './render.js';
import {
  COAUTHOR_PUBKEY,
  SAMPLE_PAPER_LINT_ERRORS,
  SAMPLE_PAPER_LINT_OK,
  SAMPLE_PAPER_LINT_WARNINGS,
  TEST_NSEC,
  TEST_PUBKEY,
  WRITE_STATUS_DENIED,
  SAMPLE_PUBLISH,
  stubApi,
} from './fixtures.js';
import type { NostrEvent, NostrTag } from '@forum4ai/shared';

const text = (node: Element | null | undefined): string => node?.textContent ?? '';

/** vyplň pole a počkaj, kým sa draft prepíše do stavu (lint debounce) */
function fill(testid: string, value: string): void {
  fireEvent.change(screen.getByTestId(testid), { target: { value } });
}

function fillBasics(): void {
  fill('field-title', 'Negentropy Replication of Gated Nostr Forums');
  fill('author-name', 'Jana Novakova');
  fill('author-affiliation', 'Comenius University');
  fill('author-orcid', '0000-0002-1825-0097');
  fill('field-abstract', 'We replicate gated nostr forums with negentropy sets.');
  fill('field-topics', 'distributed-systems, nostr');
  fill('field-body', '## Introduction\n\nThe stack is in @fig:arch and we cite [@novak2026].\n');
  fill(
    'field-references',
    '[{"id":"novak2026","type":"article-journal","title":"Negentropy Replication","author":[{"family":"Novakova","given":"Jana"}],"issued":{"date-parts":[[2026]]},"container-title":"Journal of Replicated Sets","DOI":"10.5281/zenodo.1234567"}]',
  );
}

beforeEach(() => {
  window.localStorage.removeItem(PAPER_DRAFT_KEY);
});

describe('PaperEditorPage — live lint', () => {
  it('po zmene vstupu zavolá POST /lint so štruktúrovaným vstupom', async () => {
    const api = stubApi();
    renderApp({ api, route: '/write-paper', nsec: TEST_NSEC });
    fillBasics();
    fill('field-lang', 'en');

    await waitFor(() => expect(api.lintPaper).toHaveBeenCalled(), { timeout: 2500 });
    const input = (api.lintPaper as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(input.title).toBe('Negentropy Replication of Gated Nostr Forums');
    expect(input.authors).toEqual([
      { name: 'Jana Novakova', affiliation: 'Comenius University', orcid: '0000-0002-1825-0097' },
    ]);
    expect(input.topics).toEqual(['distributed-systems', 'nostr']);
    expect(input.lang).toBe('en');
    expect(input.abstract).toBe('We replicate gated nostr forums with negentropy sets.');
    expect((input.references as unknown[]).length).toBe(1);
    expect(input.body).toContain('@fig:arch');
  });

  it('select jazyka odlíši „auto" od doslovnej voľby rovnakej s jazykom rozhrania', () => {
    // bez popisku ukáže select pri EN rozhraní dve položky «en» — človek
    // nepozná, ktorá je auto a ktorá explicitný výber
    renderApp({ api: stubApi(), route: '/write-paper', nsec: TEST_NSEC });
    const select = screen.getByTestId('field-lang') as HTMLSelectElement;
    const labels = [...select.options].map((option) => option.textContent ?? '');
    expect(select.options[0]?.value).toBe('');
    // testy renderujú v SK → auto voľba píše jazyk rozhrania v popisku
    expect(labels[0]).toContain('auto');
    expect(labels[0]).toContain('sk');
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('debounce: rýchle za sebou idúce zmeny spustia len jednu kontrolu', async () => {
    const api = stubApi();
    renderApp({ api, route: '/write-paper', nsec: TEST_NSEC });
    fill('field-title', 'A');
    fill('field-title', 'AB');
    fill('field-title', 'ABC');
    await waitFor(() => expect(api.lintPaper).toHaveBeenCalled(), { timeout: 2500 });
    const calls = (api.lintPaper as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    expect(calls).toBe(1);
  });

  it('prázdny editor nelinntuje (žiadne PAPER_TITLE_REQUIRED hneď od začiatku)', async () => {
    const api = stubApi();
    renderApp({ api, route: '/write-paper', nsec: TEST_NSEC });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(api.lintPaper).not.toHaveBeenCalled();
  });

  it('chyby blokujú publikovanie a copy je locale veta podľa kódu', async () => {
    const api = stubApi({ lintPaper: async () => SAMPLE_PAPER_LINT_ERRORS });
    renderApp({ api, route: '/write-paper', nsec: TEST_NSEC });
    fill('field-title', 'Bez topicu');
    fill('author-name', 'Jana Novakova');

    await waitFor(() => expect(screen.getByTestId('lint-errors')).toBeTruthy(), { timeout: 2500 });
    expect(text(screen.getByTestId('lint-errors'))).toContain('Papier nemá názov.');
    expect(text(screen.getByTestId('lint-errors'))).toContain('Papier nemá topic.');
    // veta gatewaya nie je finálny text UI
    expect(text(screen.getByTestId('lint-errors'))).not.toContain('paper requires');
    expect((screen.getByTestId('publish-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(text(screen.getByTestId('editor-lint'))).toContain('Pred publikovaním opravte chyby.');
  });

  it('varovania publikovanie neblokujú', async () => {
    const api = stubApi({ lintPaper: async () => SAMPLE_PAPER_LINT_WARNINGS });
    renderApp({ api, route: '/write-paper', nsec: TEST_NSEC });
    fillBasics();

    await waitFor(() => expect(screen.getByTestId('lint-warnings')).toBeTruthy(), { timeout: 2500 });
    expect(text(screen.getByTestId('lint-warnings'))).toContain('Papier nemá sekciu referencií.');
    expect(text(screen.getByTestId('lint-warnings'))).toContain('Citovaný kľúč nie je v referenciách.');
    expect(screen.queryByTestId('lint-errors')).toBeNull();
    await waitFor(() => expect((screen.getByTestId('publish-btn') as HTMLButtonElement).disabled).toBe(false));
  });

  it('čistý lint ukáže zelenú noticu', async () => {
    const api = stubApi({ lintPaper: async () => SAMPLE_PAPER_LINT_OK });
    renderApp({ api, route: '/write-paper', nsec: TEST_NSEC });
    fillBasics();
    await waitFor(() => expect(screen.getByTestId('lint-clean')).toBeTruthy(), { timeout: 2500 });
    expect(text(screen.getByTestId('lint-clean'))).toContain('lint prešiel');
  });

  it('neplatné JSON referencií sa nahlási lokálne a blokuje publish', async () => {
    const api = stubApi({ lintPaper: async () => SAMPLE_PAPER_LINT_OK });
    renderApp({ api, route: '/write-paper', nsec: TEST_NSEC });
    fillBasics();
    fill('field-references', '{ not json');
    await waitFor(() => expect(screen.getByTestId('references-invalid')).toBeTruthy());
    expect(text(screen.getByTestId('references-invalid'))).toContain('Referencie nie sú platné JSON pole.');
    expect((screen.getByTestId('publish-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('bez mena autora a bez názvu sa nelpublikuje (lokálna kontrola pred podpisom)', async () => {
    const api = stubApi({ lintPaper: async () => SAMPLE_PAPER_LINT_OK });
    renderApp({ api, route: '/write-paper', nsec: TEST_NSEC });
    fill('field-body', 'len telo');
    await waitFor(() => expect((screen.getByTestId('publish-btn') as HTMLButtonElement).disabled).toBe(true));
    expect(text(screen.getByTestId('title-required'))).toContain('Vyžaduje sa názov.');
    fill('field-title', 'Už aj názov');
    expect(text(screen.getByTestId('field-authors'))).toContain('Vyžaduje sa aspoň jeden autor s menom.');
  });
});

describe('PaperEditorPage — podpis a wire kontrakt', () => {
  it('podpíše kind 30023 s 5-prvkovými author tagmi, p markerom a L/l pred podpisom', async () => {
    const api = stubApi({ lintPaper: async () => SAMPLE_PAPER_LINT_OK });
    renderApp({ api, route: '/write-paper', nsec: TEST_NSEC });
    fillBasics();
    fill('author-pubkey', COAUTHOR_PUBKEY);
    fill('field-lang', 'en');
    fill('field-doi', 'https://doi.org/10.5281/zenodo.1234567');
    fill('field-version', 'v1');

    await waitFor(() => expect((screen.getByTestId('publish-btn') as HTMLButtonElement).disabled).toBe(false), {
      timeout: 2500,
    });
    fireEvent.click(screen.getByTestId('publish-btn'));

    await waitFor(() => expect(api.publish).toHaveBeenCalledTimes(1), { timeout: 2500 });
    const event = (api.publish as unknown as { mock: { calls: NostrEvent[][] } }).mock.calls[0]?.[0] as NostrEvent;

    expect(event.kind).toBe(30023);
    expect(event.pubkey).toBe(TEST_PUBKEY);
    // podpis musí sedieť — inak by relay event zahodil
    expect(verifyEvent(event)).toBe(true);

    const tag = (name: string): NostrTag[] => event.tags.filter((t) => t[0] === name) as NostrTag[];
    expect(tag('title')[0]?.[1]).toBe('Negentropy Replication of Gated Nostr Forums');
    expect(tag('d')[0]?.[1]).toBe('negentropy-replication-of-gated-nostr-forums');
    expect(tag('summary')[0]?.[1]).toBe('We replicate gated nostr forums with negentropy sets.');
    expect(tag('t').map((t) => t[1])).toEqual(['distributed-systems', 'nostr']);
    // `author` tag má VŽDY 5 prvkov (vynechané = prázdny reťazec)
    expect(tag('author')).toEqual([
      ['author', 'Jana Novakova', 'Comenius University', COAUTHOR_PUBKEY, '0000-0002-1825-0097'],
    ]);
    expect(tag('p')).toEqual([['p', COAUTHOR_PUBKEY, '', 'author']]);
    expect(tag('doi')[0]?.[1]).toBe('10.5281/zenodo.1234567');
    expect(tag('version')[0]?.[1]).toBe('v1');
    expect(tag('license')[0]?.[1]).toBe('CC-BY-4.0');
    expect(tag('published_at').length).toBe(1);
    // NIP-32 label MUSÍ byť v podpísanom evente (2b2)
    expect(tag('L')).toEqual([['L', 'ISO-639-1']]);
    expect(tag('l')).toEqual([['l', 'en', 'ISO-639-1']]);
  });

  it('references fence je v content PRÁVE RAZ a na koncie teľa', async () => {
    const api = stubApi({ lintPaper: async () => SAMPLE_PAPER_LINT_OK });
    renderApp({ api, route: '/write-paper', nsec: TEST_NSEC });
    fillBasics();
    await waitFor(() => expect((screen.getByTestId('publish-btn') as HTMLButtonElement).disabled).toBe(false), {
      timeout: 2500,
    });
    fireEvent.click(screen.getByTestId('publish-btn'));
    await waitFor(() => expect(api.publish).toHaveBeenCalledTimes(1), { timeout: 2500 });

    const event = (api.publish as unknown as { mock: { calls: NostrEvent[][] } }).mock.calls[0]?.[0] as NostrEvent;
    const fences = event.content.match(/```references/g) ?? [];
    expect(fences).toHaveLength(1);
    const at = event.content.indexOf('```references');
    expect(at).toBeGreaterThan(event.content.indexOf('The stack is in @fig:arch'));
    expect(event.content.slice(at)).toContain('"id": "novak2026"');
    expect(event.content.trimEnd().endsWith('```')).toBe(true);
  });

  it('po úspešnom publishi odíde na /paper/:id a zmaže koncept', async () => {
    const api = stubApi({ lintPaper: async () => SAMPLE_PAPER_LINT_OK });
    renderApp({ api, route: '/write-paper', nsec: TEST_NSEC });
    fillBasics();
    await waitFor(() => expect((screen.getByTestId('publish-btn') as HTMLButtonElement).disabled).toBe(false), {
      timeout: 2500,
    });
    fireEvent.click(screen.getByTestId('publish-btn'));

    // presmerovanie na detail (stub vracia fixture detail, testid sedí)
    await waitFor(() => expect(screen.getByTestId('paper-page')).toBeTruthy(), { timeout: 2500 });
    expect(api.paper).toHaveBeenCalledWith(SAMPLE_PUBLISH.event_id);
    expect(window.localStorage.getItem(PAPER_DRAFT_KEY)).toBeNull();
  });

  it('400 s kódmi lintu od gatewaya sa ukáže ako lokálne copy', async () => {
    const api = stubApi({
      lintPaper: async () => SAMPLE_PAPER_LINT_OK,
      publish: async () => {
        throw new ApiError(
          'paper lint failed',
          400,
          {
            ok: false,
            error: 'paper lint failed',
            codes: ['PAPER_DOI_INVALID'],
            errors: ['doi must look like 10.x/y'],
            reasons: ['doi must look like 10.x/y'],
            code: 'PAPER_DOI_INVALID',
          },
          '/events',
        );
      },
    });
    renderApp({ api, route: '/write-paper', nsec: TEST_NSEC });
    fillBasics();
    await waitFor(() => expect((screen.getByTestId('publish-btn') as HTMLButtonElement).disabled).toBe(false), {
      timeout: 2500,
    });
    fireEvent.click(screen.getByTestId('publish-btn'));
    await waitFor(() => expect(screen.getByTestId('publish-error')).toBeTruthy(), { timeout: 2500 });
    expect(text(screen.getByTestId('publish-codes'))).toContain('DOI je neplatné.');
  });
});

describe('PaperEditorPage — gating, koncept, toolbar', () => {
  it('anonym vidí výzvu na prihlásenie a nemôže publikovať', async () => {
    renderApp({ api: stubApi(), route: '/write-paper', nsec: null });
    await waitFor(() => expect(screen.getByTestId('editor-signin')).toBeTruthy());
    expect(text(screen.getByTestId('editor-signin'))).toContain('Prihláste sa na podpis');
    expect((screen.getByTestId('publish-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('zamknutý write-gate sa oznámi pri tlačidle', async () => {
    const api = stubApi({
      lintPaper: async () => SAMPLE_PAPER_LINT_OK,
      writeStatus: async () => WRITE_STATUS_DENIED,
    });
    renderApp({ api, route: '/write-paper', nsec: TEST_NSEC });
    fillBasics();
    await waitFor(() => expect(screen.getByTestId('gate-locked')).toBeTruthy(), { timeout: 2500 });
    expect(text(screen.getByTestId('gate-locked'))).toContain('Zápis je pre váš kľúč zamknutý');
    expect((screen.getByTestId('publish-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('koncept sa ukladá do localStorage a po návrate sa obnoví', async () => {
    const api = stubApi({ lintPaper: async () => SAMPLE_PAPER_LINT_OK });
    const view = renderApp({ api, route: '/write-paper', nsec: TEST_NSEC });
    fill('field-title', 'Rozpísaný papier');
    fill('author-name', 'Jana Novakova');

    await waitFor(() => expect(window.localStorage.getItem(PAPER_DRAFT_KEY)).toBeTruthy(), { timeout: 2500 });
    const saved = JSON.parse(window.localStorage.getItem(PAPER_DRAFT_KEY) ?? '{}') as { title: string };
    expect(saved.title).toBe('Rozpísaný papier');

    view.unmount();
    renderApp({ api: stubApi({ lintPaper: async () => SAMPLE_PAPER_LINT_OK }), route: '/write-paper', nsec: TEST_NSEC });
    await waitFor(() => expect((screen.getByTestId('field-title') as HTMLInputElement).value).toBe('Rozpísaný papier'));
    expect(text(screen.getByTestId('editor-note'))).toContain('Obnovený posledný koncept.');
  });

  it('„zahodiť koncept“ vymaže localStorage a vyprázdni formulár', async () => {
    renderApp({ api: stubApi({ lintPaper: async () => SAMPLE_PAPER_LINT_OK }), route: '/write-paper', nsec: TEST_NSEC });
    fill('field-title', 'Do koncepta');
    await waitFor(() => expect(window.localStorage.getItem(PAPER_DRAFT_KEY)).toBeTruthy(), { timeout: 2500 });
    fireEvent.click(screen.getByTestId('draft-clear'));
    await waitFor(() => expect(window.localStorage.getItem(PAPER_DRAFT_KEY)).toBeNull());
    expect((screen.getByTestId('field-title') as HTMLInputElement).value).toBe('');
    expect(text(screen.getByTestId('editor-note'))).toContain('Koncept zahodený.');
  });

  it('toolbar vloží šablony do teľa na pozíciu kurzora', async () => {
    renderApp({ api: stubApi({ lintPaper: async () => SAMPLE_PAPER_LINT_OK }), route: '/write-paper', nsec: TEST_NSEC });
    const body = screen.getByTestId('field-body') as HTMLTextAreaElement;
    fireEvent.click(screen.getByTestId('tool-equation'));
    expect(body.value).toContain('$$ L = \\sum_{i} d_i $$ {#eq:latency}');
    fireEvent.click(screen.getByTestId('tool-table'));
    expect(body.value).toContain('Table:  {#tbl:results}');
    fireEvent.click(screen.getByTestId('tool-figure'));
    expect(body.value).toContain('```mermaid fig=');
    fireEvent.click(screen.getByTestId('tool-chart'));
    expect(body.value).toContain('```chart fig=');
    fireEvent.click(screen.getByTestId('tool-section'));
    expect(body.value).toContain('## ');
  });

  it('tlačidlo referencie vloží CSL šablonu len do prázdneho poľa', async () => {
    renderApp({ api: stubApi({ lintPaper: async () => SAMPLE_PAPER_LINT_OK }), route: '/write-paper', nsec: TEST_NSEC });
    const refs = screen.getByTestId('field-references') as HTMLTextAreaElement;
    fireEvent.click(screen.getByTestId('tool-references'));
    expect(refs.value).toContain('"id": "novak2026"');
    const before = refs.value;
    fireEvent.click(screen.getByTestId('tool-references'));
    expect(refs.value).toBe(before);
  });

  it('pridanie a odstránenie autora mení repeater', async () => {
    renderApp({ api: stubApi({ lintPaper: async () => SAMPLE_PAPER_LINT_OK }), route: '/write-paper', nsec: TEST_NSEC });
    fireEvent.click(screen.getByTestId('author-add'));
    expect(screen.getAllByTestId('author-fields')).toHaveLength(2);
    fireEvent.click(within(screen.getAllByTestId('author-fields')[1] as HTMLElement).getByTestId('author-remove'));
    expect(screen.getAllByTestId('author-fields')).toHaveLength(1);
  });

  it('editor sa dá vykresliť aj bez `App` layoutu (renderWithProviders)', async () => {
    renderWithProviders(<PaperEditorPage />, { api: stubApi(), nsec: TEST_NSEC });
    await waitFor(() => expect(screen.getByTestId('paper-editor')).toBeTruthy());
  });
});
