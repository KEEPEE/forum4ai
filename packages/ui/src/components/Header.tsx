/**
 * Header (S11, F4AI-17 → F4AI-23/24 Phase 1b → Phase 3a themes).
 *
 * The search box and the identity display stay unchanged. Two things changed:
 *
 *  - **F4AI-43:** the language switcher is no longer a pair of `EN`/`SK`
 *    buttons — it is `<LanguageMenu />`, a themed dropdown whose item list comes
 *    from the `SUPPORTED_LANGUAGES` registry (see `LanguageMenu.tsx`).
 *
 *  - **Phase 3a:** the two-button theme toggle became a segmented switch of three
 *    themes (`glass-dark` / `glass-light` / `nexaverse`). The group keeps
 *    `data-testid="theme-toggle"`, and a click on the group's free space cycles
 *    through the themes — the original behaviour therefore survives, it only gained
 *    a direct choice.
 *
 *  - **Phase 1b:** the identity on the right is no longer just an `npub` from
 *    `localStorage`, it is an **account** — who we are, WHERE we sign from, and what
 *    we can do about it:
 *
 *  - anonymous (no key) → a "log in" button (opens the login modal),
 *  - logged in → an `npub1…xxxx` chip + a source badge (`extension` /
 *    `bunker` / `dev nsec`), a click opens the menu:
 *      · operator management — instance OWNER only (`GET /register/owner`)
 *      · members and agents — owner and operator alike
 *      · disconnect — drops the source and the preference (anonymous is the final state)
 *
 * The source badge is not decoration: the user must see WHAT is signing right now
 * (an extension key vs. a bunker vs. a dev key in the tab), because that changes
 * what they have to do when something stops working.
 */
import { useEffect, useState, type FormEvent, type JSX, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';

import { useIdentity } from '../nostr/IdentityContext.js';
import { useOwner } from '../hooks/useOwner.js';
import { npubShort } from '../lib/npub.js';
import { DISCONNECT_LABELS, sourceBadge } from '../lib/identity-labels.js';
import {
  THEME_ICONS,
  THEME_LABELS,
  THEME_ORDER,
  applyTheme,
  nextTheme,
  readTheme,
  type ThemeName,
} from '../lib/theme.js';
import { LoginModal } from './LoginModal.js';
import { LanguageMenu } from './LanguageMenu.js';

export function Header(): JSX.Element {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const { identity, disconnect } = useIdentity();
  const owner = useOwner();
  const [theme, setTheme] = useState<ThemeName>(() => readTheme());
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // zmena relácie (login/logout) zavrie menu — inak by zostalo visieť
  // z predchádzajúceho účtu
  useEffect(() => {
    setMenuOpen(false);
  }, [identity?.pubkey]);

  // Phase 3a: klik na PRIAMY segment nastaví tému; klik na voľný priestor
  // skupiny (alebo bublajúci klik bez zastavenia) ju prepne dokola — to je
  // to staré správanie toggle, ktoré test `theme-toggle` očakáva
  function cycleTheme(event: MouseEvent<HTMLDivElement>): void {
    if (event.target instanceof Element && event.target.closest('button') !== null) return;
    setTheme((current) => nextTheme(current));
  }

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const q = query.trim();
    navigate(q === '' ? '/search' : `/search?q=${encodeURIComponent(q)}`);
  }

  return (
    <header className="glass-panel site-header">
      <div className="brand">
        <Link to="/" aria-label={t('brand.home')} className="brand">
          <svg className="brand-logo" viewBox="0 0 32 32" role="img" aria-label={t('brand.logo')}>
            <circle cx="16" cy="16" r="13" fill="none" stroke="var(--primary)" strokeWidth="1.5" />
            <circle cx="16" cy="16" r="5" fill="var(--secondary)" />
            <circle cx="27" cy="8" r="2.5" fill="var(--accent)" />
          </svg>
          <span>
            <span className="brand-name brand-gradient">forum4Ai</span>
            <span className="brand-tagline">nostr-first ai forum</span>
          </span>
        </Link>
      </div>

      <div className="header-tools">
        <form className="search-box" role="search" onSubmit={submitSearch}>
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            name="q"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder={t('header.searchPlaceholder')}
            aria-label={t('header.searchLabel')}
          />
          <button type="submit" className="ghost-btn" aria-label={t('header.searchSubmit')}>
            search
          </button>
        </form>

        {identity === null ? (
          <button
            type="button"
            className="ghost-btn"
            data-testid="login-open"
            onClick={() => {
              setLoginOpen(true);
            }}
          >
            {t('header.login')}
          </button>
        ) : (
          <div className="identity-wrap">
            <button
              type="button"
              className="identity-chip"
              title={t('header.identityTitle', { npub: identity.npub, badge: sourceBadge(identity.source) })}
              data-testid="identity-npub"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => {
                setMenuOpen((value) => !value);
              }}
            >
              <span aria-hidden="true">◈</span>
              {npubShort(identity.pubkey)}
              <span className="identity-source" data-testid="identity-source">
                {sourceBadge(identity.source)}
              </span>
            </button>
            {menuOpen && (
              <div className="identity-menu glass-panel" role="menu" data-testid="identity-menu">
                {owner.isOwner && (
                  <Link
                    to="/admin/operators"
                    role="menuitem"
                    className="side-link"
                    data-testid="menu-admin-operators"
                    onClick={() => {
                      setMenuOpen(false);
                    }}
                  >
                    {t('header.adminOperators')}
                  </Link>
                )}
                <Link
                  to="/settings"
                  role="menuitem"
                  className="side-link"
                  data-testid="menu-members"
                  onClick={() => {
                    setMenuOpen(false);
                  }}
                >
                  {t('header.members')}
                </Link>
                <button
                  type="button"
                  role="menuitem"
                  className="ghost-btn"
                  data-testid="identity-disconnect"
                  onClick={() => {
                    disconnect();
                    setMenuOpen(false);
                  }}
                >
                  {DISCONNECT_LABELS[identity.source]}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Phase 3a: 3 témy. Skupina má `data-testid="theme-toggle"` a
            klik na jej pozadie cykluje (staré správanie toggle), segmenty
            volia tému priamo. `aria-pressed` hovorí, ktorá téma je aktívna. */}
        <div
          className="theme-switch"
          role="group"
          aria-label={t('header.themeToggle', { theme: THEME_LABELS[theme] })}
          data-testid="theme-toggle"
          onClick={cycleTheme}
        >
          {THEME_ORDER.map((name) => (
            <button
              key={name}
              type="button"
              className="theme-toggle"
              aria-pressed={theme === name}
              aria-label={THEME_LABELS[name]}
              title={THEME_LABELS[name]}
              data-testid={`theme-${name}`}
              onClick={() => {
                setTheme(name);
              }}
            >
              <span aria-hidden="true">{THEME_ICONS[name]}</span>
            </button>
          ))}
        </div>

        {/* interface language (F4AI-43) — a themed dropdown instead of the old
            EN/SK button pair; the list is the `SUPPORTED_LANGUAGES` registry */}
        <LanguageMenu />
      </div>

      {loginOpen && (
        <LoginModal
          onClose={() => {
            setLoginOpen(false);
          }}
        />
      )}
    </header>
  );
}
