/**
 * Language menu (F4AI-43) — the dropdown that replaced the EN/SK button pair.
 *
 * Why a menu and not a `<select>`: the switcher has to show a flag, the native
 * name and the current choice, and it has to look like the menus the header
 * already draws (the account menu). A native `<select>` cannot be painted as a
 * themed glass/nexaverse popover, and its option list is drawn by the OS.
 *
 * Accessibility — the WAI-ARIA menu-button pattern with `aria-activedescendant`
 * owned by the menu element (the items are its descendants, which is what the
 * ARIA contract requires; the trigger keeps `aria-expanded`/`aria-controls`):
 *  - trigger: `aria-haspopup="menu"`, `aria-expanded`, and `aria-controls` only
 *    while the menu exists (a dangling id is a contract violation),
 *  - menu: `role="menu"`, `tabIndex={-1}`, labelled by the trigger
 *    (`aria-labelledby`, so the two names cannot drift apart),
 *    `aria-activedescendant` → the highlighted item,
 *  - items: `role="menuitemradio"` + `aria-checked` — the menu picks one of N,
 *    which is what `menuitemradio` announces; `aria-current` would be read
 *    inconsistently inside a menu,
 *  - the highlighted item carries `data-active` (the visible focus ring),
 *  - keys: Enter/Space/ArrowDown open on the current language, ArrowUp opens on
 *    the last one (APG), arrows + Home/End move the highlight, Enter/Space
 *    select, Esc closes and returns focus to the trigger, Tab hands focus back
 *    to the trigger and lets the browser move on, focus leaving the widget
 *    closes the menu,
 *  - every item carries `lang="<code>"`, so a screen reader pronounces the
 *    endonym ("Deutsch") in its own language; the two-letter code is
 *    `aria-hidden` because it would be spelled out in that language,
 *  - the trigger's accessible name contains the code it shows (WCAG 2.5.3
 *    Label in Name — "click EN" has to find this button).
 *
 * The list comes from `SUPPORTED_LANGUAGES` — no language is named here, so a
 * fourth one appears in the menu without touching this file. The flag is an
 * emoji: Windows draws no flag glyphs, which is why the code and the endonym
 * carry the meaning and the flag is `aria-hidden` decoration.
 */
import { useEffect, useId, useRef, useState, type FocusEvent, type JSX, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { DEFAULT_LANG, SUPPORTED_LANGUAGES, changeAppLanguage, languageByCode } from '../i18n/index.js';

/** index of the current UI language in the registry (unknown code → default) */
function indexOfLang(code: string | undefined): number {
  const resolved = languageByCode(code)?.code ?? DEFAULT_LANG;
  const index = SUPPORTED_LANGUAGES.findIndex((entry) => entry.code === resolved);
  return index < 0 ? 0 : index;
}

export function LanguageMenu(): JSX.Element {
  const { t, i18n: messages } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // a locale chunk that fails to load must not be silent (F4AI-43 review)
  const [failed, setFailed] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const triggerId = `${uid}-lang-button`;
  const menuId = `${uid}-lang-menu`;
  const itemIds = SUPPORTED_LANGUAGES.map((_, index) => `${uid}-lang-item-${String(index)}`);
  const count = SUPPORTED_LANGUAGES.length;

  const current = SUPPORTED_LANGUAGES[indexOfLang(messages.resolvedLanguage ?? messages.language)] ?? SUPPORTED_LANGUAGES[0];
  const currentCode = current?.code ?? DEFAULT_LANG;

  // focus moves INTO the menu (it owns aria-activedescendant), so the highlight
  // is reachable without making every item a tab stop
  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  // a click anywhere outside closes the menu; `pointerdown` (not `click`) so it
  // is already gone when the clicked control takes focus
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const node = wrapRef.current;
      if (node !== null && event.target instanceof Node && !node.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  /** @param fromEnd ArrowUp opens a menu at its last item, per the ARIA APG */
  function openMenu(fromEnd = false): void {
    setFailed(null);
    setActive(fromEnd ? count - 1 : indexOfLang(messages.resolvedLanguage ?? messages.language));
    setOpen(true);
  }

  function closeMenu(returnFocus: boolean): void {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function pick(index: number): void {
    const entry = SUPPORTED_LANGUAGES[index];
    if (entry === undefined) return;
    closeMenu(true);
    // `changeAppLanguage` = switch without a reload + persist to
    // `localStorage.forum4ai_lang` + `<html lang>` (the detector's own key)
    changeAppLanguage(entry.code, messages).catch(() => {
      setFailed(entry.code);
    });
  }

  function step(from: number, delta: number): void {
    setActive((from + delta + count) % count);
  }

  /** focus leaving the widget by any route we do not handle closes the menu.
   *  React's `onBlur` is the focusout equivalent (it bubbles out of the
   *  subtree), and unlike `onFocusOut` it is actually delivered in jsdom. */
  function onFocusOut(event: FocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget;
    const node = wrapRef.current;
    if (!open || node === null) return;
    if (next instanceof Node && node.contains(next)) return;
    setOpen(false);
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      // Enter/Space would also fire the button's `click`, which only toggles
      // the menu shut again — take the key over before the browser does
      event.preventDefault();
      openMenu();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(true);
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeMenu(true);
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        step(active, 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        step(active, -1);
        return;
      case 'Home':
        event.preventDefault();
        setActive(0);
        return;
      case 'End':
        event.preventDefault();
        setActive(count - 1);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        pick(active);
        return;
      case 'Escape':
        event.preventDefault();
        closeMenu(true);
        return;
      case 'Tab':
        // give the browser a live element to move on from: the menu is about to
        // be unmounted, and a focused node that disappears strands focus on body
        triggerRef.current?.focus();
        setOpen(false);
        return;
      default:
    }
  }

  return (
    <div className="lang-menu-wrap" ref={wrapRef} data-testid="lang-switch" onBlur={onFocusOut}>
      <button
        type="button"
        id={triggerId}
        ref={triggerRef}
        className="lang-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${currentCode.toUpperCase()} — ${t('header.languageCurrent', { name: current?.nativeName ?? currentCode })}`}
        data-testid="lang-menu-button"
        onKeyDown={onTriggerKeyDown}
        onClick={() => {
          if (open) closeMenu(true);
          else openMenu();
        }}
      >
        <span className="lang-flag" aria-hidden="true">
          {current?.flag}
        </span>
        <span className="lang-code">{currentCode.toUpperCase()}</span>
        <span className="lang-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div
          className="lang-menu glass-panel"
          id={menuId}
          ref={menuRef}
          role="menu"
          tabIndex={-1}
          aria-labelledby={triggerId}
          aria-activedescendant={itemIds[active] ?? itemIds[0]}
          data-testid="lang-menu"
          onKeyDown={onMenuKeyDown}
        >
          {SUPPORTED_LANGUAGES.map((entry, index) => (
            <button
              key={entry.code}
              type="button"
              id={itemIds[index]}
              role="menuitemradio"
              lang={entry.code}
              tabIndex={-1}
              className="lang-menu-item"
              data-active={index === active}
              aria-checked={entry.code === currentCode}
              title={entry.englishName}
              data-testid={`lang-${entry.code}`}
              onClick={() => {
                pick(index);
              }}
              onPointerEnter={() => {
                setActive(index);
              }}
            >
              <span className="lang-flag" aria-hidden="true">
                {entry.flag}
              </span>
              <span className="lang-name">{entry.nativeName}</span>
              <span className="lang-code" aria-hidden="true">
                {entry.code.toUpperCase()}
              </span>
              <span className="lang-check" aria-hidden="true">
                {entry.code === currentCode ? '✓' : ''}
              </span>
            </button>
          ))}
        </div>
      )}

      {failed !== null && (
        <span className="lang-failed" role="status" data-testid="lang-failed">
          {t('header.languageFailed', { name: failed.toUpperCase() })}
        </span>
      )}
    </div>
  );
}
