/**
 * Feed subtitle (F4AI-41): the reader copy and the developer detail are two
 * separate lines, and the detail only exists behind the debug flag.
 *
 * Before the fix the subtitle itself was "latest threads from the gateway
 * (kind 1020/1021/1022, limit 20) · live: eose" — protocol numbers and a relay
 * protocol term, printed in production to everyone.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import { FeedPage } from '../src/pages/FeedPage.js';
import { DEBUG_QUERY_PARAM, DEBUG_STORAGE_KEY, isDebugEnabled } from '../src/lib/debug.js';
import { renderApp, renderWithProviders } from './render.js';

describe('isDebugEnabled (F4AI-41)', () => {
  it('is off when no source is on', () => {
    expect(isDebugEnabled({ dev: false, search: '', stored: null })).toBe(false);
  });

  it('a dev build turns it on', () => {
    expect(isDebugEnabled({ dev: true, search: '', stored: null })).toBe(true);
  });

  it('?debug=1 turns it on for one page view', () => {
    expect(isDebugEnabled({ dev: false, search: `?${DEBUG_QUERY_PARAM}=1`, stored: null })).toBe(true);
    // a value other than 1 is an explicit off switch, a missing parameter too
    expect(isDebugEnabled({ dev: false, search: `?${DEBUG_QUERY_PARAM}=0`, stored: null })).toBe(false);
    expect(isDebugEnabled({ dev: false, search: '?q=agent', stored: null })).toBe(false);
  });

  it('forum4ai_debug=1 in localStorage turns it on for the whole tab', () => {
    expect(DEBUG_STORAGE_KEY).toBe('forum4ai_debug');
    expect(isDebugEnabled({ dev: false, search: '', stored: '1' })).toBe(true);
    expect(isDebugEnabled({ dev: false, search: '', stored: '0' })).toBe(false);
  });
});

describe('FeedPage subtitle (F4AI-41)', () => {
  it('production shows reader copy and no protocol numbers', async () => {
    renderWithProviders(<FeedPage debug={false} />);
    const subtitle = await screen.findByTestId('feed-subtitle');
    expect(subtitle.textContent).toBe('najnovšie otázky a príspevky tohto fóra');
    // the developer detail is not in the DOM at all
    expect(screen.queryByTestId('feed-dev-detail')).toBeNull();
    expect(document.body.textContent).not.toContain('1020/1021/1022');
    expect(document.body.textContent).not.toContain('limit 20');
    expect(document.body.textContent).not.toContain('eose');
  });

  it('debug keeps the technical line (kinds, limit, live state)', async () => {
    renderWithProviders(<FeedPage debug={true} />);
    const detail = await screen.findByTestId('feed-dev-detail');
    expect(detail.textContent).toContain('kindy 1020/1021/1022');
    expect(detail.textContent).toContain('limit 20');
    expect(detail.textContent).toContain('live:');
    // the two parts stay separated by the middle dot, as they were before the
    // line moved behind the debug flag — JSX whitespace alone would not do it
    expect(detail.textContent).toContain('limit 20 · live:');
  });

  it('the routed page (dev build) renders the technical line by default', async () => {
    renderApp({ route: '/' });
    await waitFor(() => expect(screen.getByTestId('feed-dev-detail')).toBeTruthy());
    expect(screen.getByTestId('feed-subtitle').textContent).not.toContain('1020');
  });
});
