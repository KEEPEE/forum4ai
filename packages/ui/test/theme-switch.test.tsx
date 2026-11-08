/**
 * 3-way theme switcher (Phase 3a).
 *
 * Stráži tri veci, ktoré by inak rozbitá téma pokazila mlčky:
 *  1. **cyklus** `glass-dark → glass-light → nexaverse → glass-dark`
 *     (poradie drží `THEME_ORDER`, header ho nesmie hardcodovať),
 *  2. **perzistencia** pod kľúčom `forum4ai_theme` + `<html data-theme>`,
 *     vrátane záchrany LEGACY hodnôt z Phase 1 (`dark`/`light`) — používáč
 *     s uloženou voľbou z predchádzajúcej fázy nesmie spadnúť do defaultu,
 *  3. **pred-paint script** v `index.html`: bez neho appka naskočí v
 *     defaultnej téme a po boote modulu blesne prepnutie.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';

import { Header } from '../src/components/Header.js';
import {
  DEFAULT_THEME,
  THEME_ORDER,
  THEME_STORAGE_KEY,
  applyTheme,
  isThemeName,
  nextTheme,
  normalizeTheme,
  readTheme,
} from '../src/lib/theme.js';
import { renderWithProviders } from './render.js';

const here = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = resolve(here, '..', 'index.html');

/** memory `localStorage` — test nesmie závisieť od jsdom úložiska */
function memoryStorage(initial: Record<string, string> = {}): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('lib/theme — 3 témy (Phase 3a)', () => {
  it('default je glass-dark a poradie je glass-dark → glass-light → nexaverse', () => {
    expect(DEFAULT_THEME).toBe('glass-dark');
    expect(THEME_ORDER).toEqual(['glass-dark', 'glass-light', 'nexaverse']);
  });

  it('cyklus prejde všetky tri témy a vráti sa na začiatok', () => {
    expect(nextTheme('glass-dark')).toBe('glass-light');
    expect(nextTheme('glass-light')).toBe('nexaverse');
    expect(nextTheme('nexaverse')).toBe('glass-dark');
  });

  it('legacy hodnoty z Phase 1 sa mapujú, neznáma hodnota padne na default', () => {
    expect(normalizeTheme('dark')).toBe('glass-dark');
    expect(normalizeTheme('light')).toBe('glass-light');
    expect(normalizeTheme('midnight')).toBe(DEFAULT_THEME);
    expect(normalizeTheme(null)).toBe(DEFAULT_THEME);
    expect(isThemeName('nexaverse')).toBe(true);
    expect(isThemeName('dark')).toBe(false);
  });

  it('readTheme číta kľúč forum4ai_theme a normalizuje ho', () => {
    expect(readTheme(memoryStorage({ [THEME_STORAGE_KEY]: 'nexaverse' }))).toBe('nexaverse');
    expect(readTheme(memoryStorage({ [THEME_STORAGE_KEY]: 'light' }))).toBe('glass-light');
    // prázdne úložisko ANI chyba nesmú hodiť — vždy platná téma
    expect(readTheme(memoryStorage())).toBe(DEFAULT_THEME);
    expect(readTheme({ getItem: () => { throw new Error('private mode'); }, setItem: () => undefined })).toBe(DEFAULT_THEME);
  });

  it('applyTheme píše data-theme na <html> aj kľúč do úložiska', () => {
    const storage = memoryStorage();
    applyTheme('nexaverse', document, storage);
    expect(document.documentElement.getAttribute('data-theme')).toBe('nexaverse');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('nexaverse');
    // legacy hodnota sa normalizeje pred zápisom, aby sa staré meno nevrátilo
    applyTheme('dark' as never, document, storage);
    expect(document.documentElement.getAttribute('data-theme')).toBe('glass-dark');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('glass-dark');
  });
});

describe('Header — segmentový prepínač tém', () => {
  it('nakreslí 3 segmenty a označí aktívny (aria-pressed)', () => {
    renderWithProviders(<Header />);
    for (const name of THEME_ORDER) {
      const segment = screen.getByTestId(`theme-${name}`);
      expect(segment.getAttribute('aria-pressed')).toBe(String(name === DEFAULT_THEME));
    }
    // skupina nese staré testid — klik na ňu je pôvodný toggle
    expect(screen.getByTestId('theme-toggle').getAttribute('role')).toBe('group');
  });

  it('klik na segment nastaví tému a perzistuje ju (nexaverse)', () => {
    renderWithProviders(<Header />);
    fireEvent.click(screen.getByTestId('theme-nexaverse'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('nexaverse');
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe('nexaverse');
    expect(screen.getByTestId('theme-nexaverse').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('theme-glass-dark').getAttribute('aria-pressed')).toBe('false');
  });

  it('klik na pozadie skupiny cykluje dokola (staré správanie toggle)', () => {
    renderWithProviders(<Header />);
    const group = screen.getByTestId('theme-toggle');
    const seen: (string | null)[] = [];
    for (let step = 0; step < THEME_ORDER.length; step += 1) {
      fireEvent.click(group);
      seen.push(document.documentElement.getAttribute('data-theme'));
    }
    expect(seen).toEqual(['glass-light', 'nexaverse', 'glass-dark']);
  });

  it('uložená legacy voľba („light“) sa pri renderi záchranne prepne na glass-light', () => {
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    renderWithProviders(<Header />);
    expect(screen.getByTestId('theme-glass-light').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('index.html — téma pred prvým paintom', () => {
  const html = existsSync(INDEX_HTML) ? readFileSync(INDEX_HTML, 'utf8') : '';

  it('default v HTML je glass-dark a kľúč sedí s lib/theme', () => {
    expect(html).toContain('data-theme="glass-dark"');
    expect(html).toContain(`'${THEME_STORAGE_KEY}'`);
  });

  it('inline script pozna všetky tri témy aj legacy mapovanie', () => {
    for (const name of THEME_ORDER) {
      expect(html, `index.html nevie o téme ${name}`).toContain(`'${name}'`);
    }
    // bez legacy mapovania by používáč z Phase 1 spadol na default
    expect(html).toContain("dark: 'glass-dark'");
    expect(html).toContain("light: 'glass-light'");
    // a bez nastavenia atribútu by sa téma vôbec nepoužila
    expect(html).toContain("setAttribute('data-theme'");
  });
});
