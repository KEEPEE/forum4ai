/**
 * Language switcher in the header (Phase 2a → F4AI-43 dropdown).
 *
 * Three things are guarded at once, because each breaks on its own:
 *  1. the switcher **translates without a reload** (`i18n.changeLanguage`, not
 *     `location.reload()`) — after the pick the header must speak English,
 *  2. the choice **persists** to `localStorage.forum4ai_lang`, which is the
 *     very key the language detector reads (`config.ts`),
 *  3. switching language **must not destroy the identity** — the npub chip, the
 *     background badge and the `title` with the full key have to survive (the
 *     `header.test.tsx` tests cover that for `sk`, here for `en`).
 *
 * F4AI-43 replaced the EN/SK button pair with a menu, so the flow is now
 * trigger → menu → item. The tests run in SK (`test/setup.ts` keeps `lng: 'sk'`),
 * so the first pick has to be `en` — exactly the opposite of how the app starts
 * in a browser.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { Header } from '../src/components/Header.js';
import { LANGUAGE_STORAGE_KEY, SUPPORTED_LANGUAGES } from '../src/i18n/config.js';
import { renderWithProviders } from './render.js';
import { TEST_NPUB } from './fixtures.js';

describe('language switcher (F4AI-43 dropdown)', () => {
  it('opens the menu, switches to en without a reload, persists and sets <html lang>', async () => {
    globalThis.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    renderWithProviders(<Header />);

    // closed: a trigger that names the current language, no items in the DOM
    const trigger = screen.getByTestId('lang-menu-button');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // WCAG 2.5.3: the accessible name contains the code the button shows, and a
    // closed menu has no `aria-controls` (the id it points at does not exist)
    expect(trigger.getAttribute('aria-label')).toBe('SK — prepnúť jazyk rozhrania (aktuálne slovenčina)');
    expect(trigger.getAttribute('aria-controls')).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger);

    // open: a real menu, one item per registry entry, the current one marked
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(screen.getByTestId('lang-menu').id);
    // the menu is named by the trigger, so the two labels cannot drift apart
    expect(screen.getByTestId('lang-menu').getAttribute('aria-labelledby')).toBe(trigger.id);
    const items = screen.getAllByRole('menuitemradio');
    expect(items).toHaveLength(SUPPORTED_LANGUAGES.length);
    expect(screen.getByTestId('lang-sk').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('lang-en').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('lang-sk').getAttribute('lang')).toBe('sk');

    fireEvent.click(screen.getByTestId('lang-en'));

    // the text is EN …
    await waitFor(() => {
      expect(screen.getByRole('searchbox', { name: /full text search/i })).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'run search' })).toBeTruthy();
    // … the menu closed, focus is back on the trigger, which now says EN
    expect(screen.queryByTestId('lang-menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-label')).toBe('EN — switch interface language (currently English)');
    expect(document.activeElement).toBe(trigger);
    // persistence + `<html lang>`
    expect(globalThis.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    // the identity must survive the language switch
    const chip = screen.getByTestId('identity-npub');
    expect(chip.textContent).toContain('npub1');
    expect(chip.getAttribute('title')).toContain(TEST_NPUB);
    expect(screen.getByTestId('identity-source').textContent).toBe('dev nsec');

    // back to sk — the same contract the other way round
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId('lang-sk'));
    await waitFor(() => {
      expect(screen.getByRole('searchbox', { name: /fulltextové vyhľadávanie/i })).toBeTruthy();
    });
    expect(globalThis.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('sk');
    expect(document.documentElement.getAttribute('lang')).toBe('sk');
  });

  it('a click outside closes the menu without changing the language', () => {
    globalThis.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    renderWithProviders(<Header />);

    const trigger = screen.getByTestId('lang-menu-button');
    fireEvent.click(trigger);
    expect(screen.getByTestId('lang-menu')).toBeTruthy();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByTestId('lang-menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(globalThis.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
  });

  it('an anonymous user sees English "sign in" after the switch (the button is not erased)', async () => {
    globalThis.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    renderWithProviders(<Header />, { nsec: null });
    expect(screen.getByTestId('login-open').textContent).toContain('prihlásiť');

    fireEvent.click(screen.getByTestId('lang-menu-button'));
    fireEvent.click(screen.getByTestId('lang-en'));
    await waitFor(() => {
      expect(screen.getByTestId('login-open').textContent).toContain('sign in');
    });
    fireEvent.click(screen.getByTestId('login-open'));
    expect(screen.getByTestId('login-modal').getAttribute('aria-label')).toBe('sign in');
  });
});
