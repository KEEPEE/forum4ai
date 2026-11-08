/**
 * Locale-aware formatting (F4AI-43).
 *
 * German reads `3,25` and `08.11.2026`; English reads `3.25` and `8 Nov 2026`.
 * Both used to be hardcoded (`toFixed`, `toISOString`), which is exactly the
 * kind of thing a translation cannot fix — so the formats now come from `Intl`
 * with the BCP-47 tag of the registry entry (`de` → `de-DE`).
 *
 * The suite runs in `sk` (`test/setup.ts`); the German assertions switch the
 * language and `afterEach` switches it back.
 */
import { describe, expect, it } from 'vitest';

import { i18n } from '../src/i18n/index.js';
import { currentIntlLocale } from '../src/i18n/text.js';
import { formatAbsoluteTime, formatPercent, formatRelativeTime, formatScore } from '../src/lib/format.js';

/** 2026-11-08T13:51:00Z — far enough in the past that the relative path ends */
const TS = 1794145860;

describe('locale-aware formatting (F4AI-43)', () => {
  it('the Intl locale follows the interface language', async () => {
    expect(currentIntlLocale()).toBe('sk-SK');
    await i18n.changeLanguage('de');
    expect(currentIntlLocale()).toBe('de-DE');
    await i18n.changeLanguage('en');
    expect(currentIntlLocale()).toBe('en-GB');
  });

  it('numbers use the decimal separator of the language', async () => {
    await i18n.changeLanguage('de');
    expect(formatScore(3.25)).toBe('3,25');
    expect(formatPercent(0.855)).toMatch(/^85,5\s?%$/);

    await i18n.changeLanguage('en');
    expect(formatScore(3.25)).toBe('3.25');
    expect(formatPercent(0.855)).toBe('85.5%');
  });

  it('dates use the date pattern of the language and keep the UTC marker', async () => {
    await i18n.changeLanguage('de');
    expect(formatAbsoluteTime(TS)).toBe('08.11.2026, 13:51 UTC');
    // an older post (30+ days) falls back to a plain date, still German
    expect(formatRelativeTime(TS, new Date('2027-01-15T00:00:00Z').getTime())).toBe('08.11.2026');

    await i18n.changeLanguage('en');
    expect(formatAbsoluteTime(TS)).toBe('8 Nov 2026, 13:51 UTC');
    expect(formatRelativeTime(TS, new Date('2027-01-15T00:00:00Z').getTime())).toBe('8 Nov 2026');
  });

  it('relative time is translated, not formatted (de)', async () => {
    await i18n.changeLanguage('de');
    // `formatRelativeTime(unixSeconds, nowMs)` — the first argument is SECONDS
    const nowMs = new Date('2026-11-08T14:00:00Z').getTime();
    const now = Math.floor(nowMs / 1000);
    expect(formatRelativeTime(now - 30, nowMs)).toBe('gerade eben');
    expect(formatRelativeTime(now - 5 * 60, nowMs)).toBe('vor 5 Min.');
    expect(formatRelativeTime(now - 3 * 3600, nowMs)).toBe('vor 3 Std.');
    expect(formatRelativeTime(now - 4 * 24 * 3600, nowMs)).toBe('vor 4 T.');
  });
});
