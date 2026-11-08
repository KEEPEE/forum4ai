/**
 * Testy Headeru (S11, F4AI-17): brand, search box (navigácia na /search?q=),
 * theme toggle (data-theme + perzistencia), zobrazenie npub identity.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes, useSearchParams } from 'react-router';
import type { JSX } from 'react';

import { Header } from '../src/components/Header.js';
import { THEME_STORAGE_KEY } from '../src/lib/theme.js';
import { renderWithProviders } from './render.js';
import { TEST_NPUB } from './fixtures.js';

function SearchProbe(): JSX.Element {
  const [params] = useSearchParams();
  return <div data-testid="search-probe">{params.get('q') ?? '(bez dotazu)'}</div>;
}

function withSearchRoute(): JSX.Element {
  return (
    <>
      <Header />
      <Routes>
        <Route path="/search" element={<SearchProbe />} />
        <Route path="*" element={<div data-testid="elsewhere" />} />
      </Routes>
    </>
  );
}

describe('Header', () => {
  it('zobrazí brand forum4Ai a tagline', () => {
    renderWithProviders(<Header />);
    expect(screen.getByText('forum4Ai')).toBeTruthy();
    expect(screen.getByText('nostr-first ai forum')).toBeTruthy();
  });

  it('search box odovzdá dotaz do route /search?q=', () => {
    renderWithProviders(withSearchRoute(), { route: '/' });
    const input = screen.getByRole('searchbox', { name: /fulltextové vyhľadávanie/i });
    fireEvent.change(input, { target: { value: 'graceful shutdown' } });
    fireEvent.click(screen.getByRole('button', { name: 'spustiť vyhľadávanie' }));
    expect(screen.getByTestId('search-probe').textContent).toBe('graceful shutdown');
  });

  it('prázdny dotaz naviguje na /search bez parametra', () => {
    renderWithProviders(withSearchRoute(), { route: '/' });
    fireEvent.click(screen.getByRole('button', { name: 'spustiť vyhľadávanie' }));
    expect(screen.getByTestId('search-probe').textContent).toBe('(bez dotazu)');
  });

  // Phase 3a: toggle je 3-way switch. `data-testid="theme-toggle"` ostáva na
  // SKUPINE a klik na jej pozadie cykluje témy — pôvodné správanie, len s
  // tromi stavmi (glass-dark → glass-light → nexaverse → glass-dark).
  it('theme toggle prepne data-theme na <html> a perzistuje voľbu', () => {
    renderWithProviders(<Header />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('glass-dark');

    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('glass-light');
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe('glass-light');

    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('nexaverse');
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe('nexaverse');

    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('glass-dark');
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe('glass-dark');
  });

  it('ukáže verejný kľúč skrátený a s označením pozadia (F4AI-23)', () => {
    renderWithProviders(<Header />);
    const chip = screen.getByTestId('identity-npub');
    // chip je tlačidlo v headeri — 62 znakov tam nepatrí
    expect(chip.textContent).toContain('npub1');
    expect(chip.textContent).toContain('…');
    expect(chip.textContent ?? '').not.toContain(TEST_NPUB);
    // celý npub je v `title` (pre kontrolu, nie na kopírovanie)
    expect(chip.getAttribute('title')).toContain(TEST_NPUB);
    // zdroj kľúča je súčasť identity — používáč musí vidieť, ČÍM podpisuje
    expect(screen.getByTestId('identity-source').textContent).toBe('dev nsec');
  });

  it('anonym má tlačidlo „prihlásiť“, nie prázdny chip (F4AI-23)', () => {
    renderWithProviders(<Header />, { nsec: null });
    expect(screen.queryByTestId('identity-npub')).toBeNull();
    fireEvent.click(screen.getByTestId('login-open'));
    // the modal offers the extension path — matched case-insensitively, the
    // tab label is sentence case now (F4AI-41) and the case is not the point
    expect((screen.getByTestId('login-modal').textContent ?? '').toLowerCase()).toContain('nostr');
  });
});
