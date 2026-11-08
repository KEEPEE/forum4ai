/**
 * Jazykový prepínač v headeri (Phase 2a, dizajn Q2).
 *
 * Strážia sa tu tri veci naraz, lebo každá z nich sa láme sama o sebe:
 *  1. prepínač **prekladá BEZ reloadu** (`i18n.changeLanguage`, nie
 *     `location.reload()`) — po kliku musí header hovoriť po anglicky,
 *  2. voľba sa **perzistuje** do `localStorage.forum4ai_lang`, čo je ten
 *     istý kľúč, z ktorého číta jazyk detector (`config.ts`),
 *  3. prepnutie jazyka **nesmie rozbit identitu** — npub chip, badge
 *     pozadia a `title` s celým kľúčom musia ostať na mieste (testy
 *     `header.test.tsx` to coverujú pre `sk`, tu pre `en`).
 *
 * Test beží nad SK (`test/setup.ts` drží `lng: 'sk'`), takže prvý klik
 * musí byť smer `en` — presne opačne, ako appka štartuje v prehliadači.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { Header } from '../src/components/Header.js';
import { LANGUAGE_STORAGE_KEY } from '../src/i18n/config.js';
import { renderWithProviders } from './render.js';
import { TEST_NPUB } from './fixtures.js';

describe('jazykový prepínač (Phase 2a)', () => {
  it('prepne header do en bez reloadu, perzistuje voľbu a mení <html lang>', async () => {
    globalThis.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    renderWithProviders(<Header />);

    // start je slovensky (test setup) a prepínač to priznáva aria-pressed
    const switcher = screen.getByTestId('lang-switch');
    expect(switcher.getAttribute('aria-label')).toBe('jazyk rozhrania');
    expect(screen.getByTestId('lang-sk').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('lang-en').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('searchbox', { name: /fulltextové vyhľadávanie/i })).toBeTruthy();

    fireEvent.click(screen.getByTestId('lang-en'));

    // text hlavičky je EN …
    await waitFor(() => {
      expect(screen.getByRole('searchbox', { name: /full text search/i })).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'run search' })).toBeTruthy();
    // … a stisk už ukazuje na en
    expect(screen.getByTestId('lang-en').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('lang-sk').getAttribute('aria-pressed')).toBe('false');
    // perzistencia + `<html lang>`
    expect(globalThis.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    // identita musí prežiť prepnutie jazyka
    const chip = screen.getByTestId('identity-npub');
    expect(chip.textContent).toContain('npub1');
    expect(chip.getAttribute('title')).toContain(TEST_NPUB);
    expect(screen.getByTestId('identity-source').textContent).toBe('dev nsec');

    // späť do sk — ten istý kontrakt naopak
    fireEvent.click(screen.getByTestId('lang-sk'));
    await waitFor(() => {
      expect(screen.getByRole('searchbox', { name: /fulltextové vyhľadávanie/i })).toBeTruthy();
    });
    expect(globalThis.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('sk');
    expect(document.documentElement.getAttribute('lang')).toBe('sk');
  });

  it('anonym vidí po prepnutí anglické „sign in‘ (tlačidlo sa nemaže)', async () => {
    globalThis.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    renderWithProviders(<Header />, { nsec: null });
    expect(screen.getByTestId('login-open').textContent).toContain('prihlásiť');

    fireEvent.click(screen.getByTestId('lang-en'));
    await waitFor(() => {
      expect(screen.getByTestId('login-open').textContent).toContain('sign in');
    });
    fireEvent.click(screen.getByTestId('login-open'));
    expect(screen.getByTestId('login-modal').getAttribute('aria-label')).toBe('sign in');
  });
});
