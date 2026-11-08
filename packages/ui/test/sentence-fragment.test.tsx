/**
 * F4AI-43: the write-gate headline is quoted in the middle of a longer
 * sentence, so the UI lowers its first letter. A blanket `toLowerCase()` used
 * to do that, which also flattened German noun capitals ("zum schreiben
 * anmelden") — in German a spelling error, not a style choice. The helper must
 * therefore touch exactly one character.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { i18n } from '../src/i18n/index.js';
import { sentenceFragment } from '../src/i18n/text.js';
import { Composer } from '../src/components/Composer.js';
import { renderWithProviders } from './render.js';

describe('sentenceFragment', () => {
  it('lowers the first letter and nothing else', () => {
    expect(sentenceFragment('Sign in to write')).toBe('sign in to write');
    expect(sentenceFragment('Zum Schreiben anmelden')).toBe('zum Schreiben anmelden');
    expect(sentenceFragment('Na zápis sa prihlás')).toBe('na zápis sa prihlás');
    expect(sentenceFragment('MCP a Nostr')).toBe('MCP a Nostr');
    expect(sentenceFragment('NIP-07 signEvent hat keine Signatur geliefert')).toBe(
      'NIP-07 signEvent hat keine Signatur geliefert',
    );
    expect(sentenceFragment('')).toBe('');
  });

  it('the anonymous composer notice keeps German noun capitals', async () => {
    await i18n.changeLanguage('de');
    renderWithProviders(<Composer />, { nsec: null });

    const notice = await screen.findByTestId('composer-anonymous');
    expect(notice.textContent).toContain('zum Schreiben anmelden');
    expect(notice.textContent).not.toContain('zum schreiben');
  });
});
