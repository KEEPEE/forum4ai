/**
 * Témy UI (S11, F4AI-17 → Phase 3a).
 *
 * Phase 1–2 mali dve témy (`dark` / `light`) postavené na tokenoch Nexaverse
 * tm-603. Phase 3a pridáva tretiu a menuje identity tak, aby meno zodpovedalo
 * vizuálnemu jazyku:
 *
 *   glass-dark   DEFAULT — deep-forest glassmorphismus, emerald + gold
 *                (TemplateMo 607 „Glass Admin")
 *   glass-light  svetlá varianta tej istej identity
 *   nexaverse    neon cyan / magenta / purple (TemplateMo 603)
 *
 * Názvy tém sú KANONICKÉ identity — `data-theme` na `<html>` ich posiela
 * priamo do `tokens.css`, kde každá téma predefinuje rovnakú sadu tokenov.
 * Staré hodnoty (`dark`, `light`) sa pri čítaní stále akceptujú a mapujú,
 * aby používáč, ktorý má v `localStorage` voľbu z Phase 1, nenabehol do
 * defaultu — a aby inline script v `index.html` nepadal k defaultu.
 */
export type ThemeName = 'glass-dark' | 'glass-light' | 'nexaverse';

/** kľúč v `localStorage` (oddelene od `forum4ai_nsec`, aby reset identity
    nemazal voľbu témy) */
export const THEME_STORAGE_KEY = 'forum4ai_theme';

/** default = glass-dark (emerald + gold), nie nexaverse: forum sa číta cez
    deň a deep-forest je čitateľnejší než neon */
export const DEFAULT_THEME: ThemeName = 'glass-dark';

/** poradie prepínania — segmentovaný switch v headeri aj klik na skupinu
    idú podľa tohto poľa (jeden zdroj pravdy pre cyklus tém) */
export const THEME_ORDER: readonly ThemeName[] = ['glass-dark', 'glass-light', 'nexaverse'];

/** technické názvy tém — nie UI copy, preto nie sú v i18n: sú to mená
    vizuálnych jazykov (ako „Nexaverse"), nie preložiteľné frázy */
export const THEME_LABELS: Record<ThemeName, string> = {
  'glass-dark': 'glass dark',
  'glass-light': 'glass light',
  nexaverse: 'nexaverse',
};

/** ikony segmentov: mesiac / slnko / neonová hviezda */
export const THEME_ICONS: Record<ThemeName, string> = {
  'glass-dark': '☾',
  'glass-light': '☀',
  nexaverse: '✦',
};

/** staré hodnoty → kanonická téma (záchrana uložených volieb z Phase 1) */
const LEGACY_THEMES: Record<string, ThemeName> = {
  dark: 'glass-dark',
  light: 'glass-light',
};

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** je reťazec platná téma? — rovnakú kontrolu má aj inline script v
    `index.html`, ktorý nemôže importovať, preto je tam minimálna kópia */
export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && (THEME_ORDER as readonly string[]).includes(value);
}

/** normalizuje uloženú aj legacy hodnotu; neznáma hodnota = default */
export function normalizeTheme(value: unknown): ThemeName {
  if (isThemeName(value)) return value;
  if (typeof value === 'string') {
    const legacy = LEGACY_THEMES[value];
    if (legacy !== undefined) return legacy;
  }
  return DEFAULT_THEME;
}

export function readTheme(storage?: ThemeStorage | null): ThemeName {
  try {
    const stored = (storage ?? globalThis.localStorage)?.getItem(THEME_STORAGE_KEY);
    return normalizeTheme(stored);
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme: ThemeName, doc: Document = document, storage?: ThemeStorage | null): void {
  const resolved = normalizeTheme(theme);
  doc.documentElement.setAttribute('data-theme', resolved);
  try {
    (storage ?? globalThis.localStorage)?.setItem(THEME_STORAGE_KEY, resolved);
  } catch {
    /* súkromný režim: tému len aplikujeme, neperzistujeme */
  }
}

/** cyklus v poradí `THEME_ORDER` (glass-dark → glass-light → nexaverse → …) */
export function nextTheme(current: ThemeName): ThemeName {
  const index = THEME_ORDER.indexOf(normalizeTheme(current));
  return THEME_ORDER[(index + 1) % THEME_ORDER.length] ?? DEFAULT_THEME;
}
