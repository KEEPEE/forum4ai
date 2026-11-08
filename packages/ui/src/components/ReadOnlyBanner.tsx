/**
 * Read-only write-gate banner (design B10 → F4AI-23, Phase 1b).
 *
 * It appears when a signer is logged in but the gateway said
 * `allowed: false` — the visitor may read, they just may not write. The banner is
 * dismissible (it hides until the next pubkey change) and offers an ACTION by
 * code: `WG_NOT_REGISTERED` → registration, `WG_PENDING` → request status,
 * `WG_LAPSED` → renewal, `WG_REVOKED` → an explanation.
 *
 * Why copy keyed on `code` rather than the gateway's text:
 *  - `code` (`WG_*`) is a stable contract (the table in `docs/skill.md`),
 *    `reason` is a descriptive sentence the gateway may rewrite without
 *    changing behaviour,
 *  - Phase 2 (i18n) binds the translation to `code`, not to a sentence,
 *  - `reason` IS NOT SWALLOWED — we show it as a fallback when we do not know the
 *    code (an older gateway), and always in `title`, so it can be checked next to
 *    the message.
 *
 * Two states that must not be confused:
 *  - `denied`      → the gateway deliberately answered "no", copy from the code,
 *  - `unavailable` → we did not establish the status → neutral text
 *    `WRITE_STATUS_UNAVAILABLE`, NO claim about the user.
 *
 * An anonymous visitor (no pubkey) gets no banner — their writing is not locked
 * because of the gate but because they have not logged in yet (composer + login
 * handle that).
 */
import { useEffect, useState, type JSX } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';

import { HOW_IT_WORKS_SLUG, useWriteStatus } from '../hooks/useWriteStatus.js';
import { writeGateCopy } from '../lib/write-codes.js';


export function ReadOnlyBanner(): JSX.Element | null {
  const { t } = useTranslation('write');
  const write = useWriteStatus();
  const [dismissed, setDismissed] = useState(false);

  // nový pubkey / nový signer = nová situácia → banner opäť ukážeme
  useEffect(() => {
    setDismissed(false);
  }, [write.pubkey]);

  // anonym: písanie nie je zamknuté kvôli gate, ale preto, že sa ešte
  // neprihlásil — rieši to composer a login, nie banner nad obsahom
  if (write.pubkey === null) return null;
  if (!write.locked) return null;
  if (dismissed) return null;

  const copy = writeGateCopy(write.code ?? undefined, {
    reason: write.reason ?? undefined,
    operator: write.operator,
  });
  // fallback: gateway poznáme len jeho vetu (starší gateway bez `code`,
  // alebo nový kód, ktorý tu ešte nie je)
  const showReasonFallback = write.kind === 'denied' && (write.code === null || copy.reason !== undefined);

  return (
    <div
      className="write-banner"
      role="status"
      data-testid="write-banner"
      // reason gatewayu je vždy dostupný (title), aj keď copy už poznáme
      // z `code` — pri hláške sa dá overiť, čo gateway SKUTOČNE povedal
      title={write.reason ?? undefined}
    >
      <span className="write-banner-text" data-testid="write-banner-text">
        {copy.headline} — {copy.detail}{' '}
        {copy.to !== undefined && copy.cta !== undefined && (
          <Link to={copy.to} data-testid="write-banner-cta">
            {copy.cta}
          </Link>
        )}{' '}
        <Link to={`/topics/${HOW_IT_WORKS_SLUG}`} data-testid="write-banner-link">
          {t('banner.connect')}
        </Link>
      </span>
      {showReasonFallback && write.reason !== null && (
        <span className="write-banner-reason" data-testid="write-banner-reason" title={write.pubkey ?? undefined}>
          {write.reason}
        </span>
      )}
      {write.kind === 'unavailable' && (
        <span className="write-banner-note" data-testid="write-banner-note">
          {t('status.unavailable')}
        </span>
      )}
      <button
        type="button"
        className="write-banner-close"
        aria-label={t('common:actions.dismiss')}
        data-testid="write-banner-dismiss"
        title={write.reason ?? undefined}
        onClick={() => {
          setDismissed(true);
        }}
      >
        ×
      </button>
    </div>
  );
}
