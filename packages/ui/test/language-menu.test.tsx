/**
 * The language dropdown as a component (F4AI-43).
 *
 * `test/language-switch.test.tsx` covers the header wiring (translation without
 * a reload, persistence, identity). This file guards the widget itself: the
 * ARIA contract of the menu-button pattern and the keyboard, because those are
 * exactly the parts a visual review cannot see.
 *
 * The item list is asserted against `SUPPORTED_LANGUAGES`, never against a
 * literal `['en','sk']` — adding a language must not require touching this test.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { i18n } from '../src/i18n/index.js';

import { LanguageMenu } from '../src/components/LanguageMenu.js';
import { LANGUAGE_STORAGE_KEY, SUPPORTED_LANGUAGES } from '../src/i18n/config.js';
import { renderWithProviders } from './render.js';

/** the trigger, opened with the keyboard (Enter) — the menu takes focus */
function openWithKeyboard(): { trigger: HTMLElement; menu: HTMLElement } {
  const trigger = screen.getByTestId('lang-menu-button');
  fireEvent.keyDown(trigger, { key: 'Enter' });
  const menu = screen.getByTestId('lang-menu');
  return { trigger, menu };
}

function itemFor(code: string): HTMLElement {
  return screen.getByTestId(`lang-${code}`);
}

describe('LanguageMenu (F4AI-43)', () => {
  it('the trigger shows the current language and the menu lists the registry', () => {
    renderWithProviders(<LanguageMenu />);

    const trigger = screen.getByTestId('lang-menu-button');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // a closed menu is not in the DOM, so `aria-controls` must not point at it
    expect(trigger.getAttribute('aria-controls')).toBeNull();
    // setup renders in sk → the trigger names Slovak, in its own language
    expect(trigger.textContent).toContain('SK');

    fireEvent.click(trigger);
    const items = screen.getAllByRole('menuitemradio');
    expect(items).toHaveLength(SUPPORTED_LANGUAGES.length);
    for (const entry of SUPPORTED_LANGUAGES) {
      const item = itemFor(entry.code);
      expect(item.textContent).toContain(entry.nativeName);
      expect(item.getAttribute('lang')).toBe(entry.code);
      // one-of-N choice → menuitemradio carries the checked state
      expect(item.getAttribute('aria-checked')).toBe(entry.code === 'sk' ? 'true' : 'false');
      // roving highlight, not a tab stop per item
      expect(item.getAttribute('tabindex')).toBe('-1');
    }
    // the two-letter code is decoration: the accessible name is the endonym only,
    // otherwise a screen reader reads "SK" with Slovak pronunciation
    expect(screen.getByRole('menuitemradio', { name: 'slovenčina' })).toBeTruthy();
  });

  it('ArrowUp opens the menu on the LAST item (ARIA APG), ArrowDown on the current one', () => {
    renderWithProviders(<LanguageMenu />);
    const trigger = screen.getByTestId('lang-menu-button');
    const codes = SUPPORTED_LANGUAGES.map((entry) => entry.code);
    const last = codes[codes.length - 1] ?? 'en';

    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(itemFor(last).getAttribute('data-active')).toBe('true');

    fireEvent.keyDown(screen.getByTestId('lang-menu'), { key: 'Escape' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    // sk is the language of the test setup → the menu opens on it
    expect(itemFor('sk').getAttribute('data-active')).toBe('true');
  });

  it('focus leaving the widget closes the menu (no popover stranded over the page)', () => {
    renderWithProviders(<LanguageMenu />);
    const { trigger } = openWithKeyboard();
    const outside = document.createElement('button');
    document.body.append(outside);

    fireEvent.blur(trigger, { relatedTarget: outside });

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('lang-menu')).toBeNull();
    outside.remove();
  });

  it('focus moving INSIDE the widget keeps the menu open', () => {
    renderWithProviders(<LanguageMenu />);
    const { trigger, menu } = openWithKeyboard();

    fireEvent.blur(trigger, { relatedTarget: menu });

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('lang-menu')).toBeTruthy();
  });

  it('Enter opens, focus moves to the menu and aria-activedescendant marks the current language', () => {
    renderWithProviders(<LanguageMenu />);
    const { menu } = openWithKeyboard();

    expect(document.activeElement).toBe(menu);
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.getAttribute('aria-activedescendant')).toBe(itemFor('sk').id);
    expect(itemFor('sk').getAttribute('data-active')).toBe('true');
  });

  it('ArrowUp/ArrowDown move the highlight, aria-activedescendant follows, Enter picks', async () => {
    globalThis.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    renderWithProviders(<LanguageMenu />);
    const { trigger, menu } = openWithKeyboard();

    // from the current language one step down (wraps at the end of the registry)
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    const codes = SUPPORTED_LANGUAGES.map((entry) => entry.code);
    const first = codes[0] ?? 'en';
    const last = codes[codes.length - 1] ?? 'en';
    const afterSk = codes[(codes.indexOf('sk') + 1) % codes.length] ?? first;
    expect(menu.getAttribute('aria-activedescendant')).toBe(itemFor(afterSk).id);
    expect(itemFor(afterSk).getAttribute('data-active')).toBe('true');
    expect(itemFor('sk').getAttribute('data-active')).toBe('false');

    // ArrowUp goes back
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(menu.getAttribute('aria-activedescendant')).toBe(itemFor('sk').id);

    // Home/End jump to the ends of the list
    fireEvent.keyDown(menu, { key: 'End' });
    expect(menu.getAttribute('aria-activedescendant')).toBe(itemFor(last).id);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(menu.getAttribute('aria-activedescendant')).toBe(itemFor(first).id);

    fireEvent.keyDown(menu, { key: 'Enter' });

    await waitFor(() => {
      expect(i18n.resolvedLanguage).toBe('en');
    });
    expect(globalThis.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    // the menu is gone and the focus is back where it started
    expect(screen.queryByTestId('lang-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Escape closes the menu, returns the focus and changes nothing', () => {
    globalThis.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    renderWithProviders(<LanguageMenu />);
    const { trigger, menu } = openWithKeyboard();

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'Escape' });

    expect(screen.queryByTestId('lang-menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    expect(i18n.resolvedLanguage).toBe('sk');
    expect(globalThis.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
  });

  it('Tab closes the menu (an open popover must not float over the next control)', () => {
    renderWithProviders(<LanguageMenu />);
    const { trigger, menu } = openWithKeyboard();

    fireEvent.keyDown(menu, { key: 'Tab' });

    expect(screen.queryByTestId('lang-menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('Space opens the menu and a second click on the trigger closes it', () => {
    renderWithProviders(<LanguageMenu />);
    const trigger = screen.getByTestId('lang-menu-button');

    fireEvent.keyDown(trigger, { key: ' ' });
    expect(screen.getByTestId('lang-menu')).toBeTruthy();

    fireEvent.click(trigger);
    expect(screen.queryByTestId('lang-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('picking the language that is already current only closes the menu', async () => {
    globalThis.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    renderWithProviders(<LanguageMenu />);

    fireEvent.click(screen.getByTestId('lang-menu-button'));
    fireEvent.click(itemFor('sk'));

    await waitFor(() => {
      expect(screen.queryByTestId('lang-menu')).toBeNull();
    });
    expect(i18n.resolvedLanguage).toBe('sk');
    // an explicit choice is still an explicit choice: it is persisted
    expect(globalThis.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('sk');
  });
});
