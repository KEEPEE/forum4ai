/**
 * Login modal (F4AI-23, Phase 1b) — choosing the signing source.
 *
 * Design Q1 (`claude-publish-answer.md`) distinguishes four states and this
 * modal is the only place where the user decides between them:
 *
 *  | source | where the key lives | when |
 *  |---|---|---|
 *  | NIP-07 extension | in the extension (never in the page) | default, recommended |
 *  | NIP-46 bunker    | remote vault; locally only the consumer key | mobile / owner |
 *  | nsec             | `sessionStorage`, while the tab exists | dev ONLY (`VITE_ALLOW_NSEC=true`) |
 *  | anonymous        | none | the state a reader stays in |
 *
 * Deliberate restrictions:
 *  - the `nsec` tab is NOT SHOWN when the build disabled nsec — a production
 *    instance must not even offer pasting a private key into the page,
 *  - after a successful login the modal closes; the state (status/error) is held
 *    by `IdentityProvider`, not local state, so the header sees the result,
 *  - we show errors EXACTLY as the signer described them (in Slovak), because
 *    the reason is decisive for the user (access denied vs. a bad link).
 */
import { useState, type FormEvent, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import { useIdentity } from '../nostr/IdentityContext.js';
import { t as tr } from '../i18n/text.js';

export type LoginTab = 'nip07' | 'bunker' | 'nsec';

/** popisky tabov (gettery → text v aktuálnom jazyku, `auth:tabs.*`) */
export const LOGIN_TAB_LABELS: Record<LoginTab, string> = {
  get nip07(): string {
    return tr('auth:tabs.nip07');
  },
  get bunker(): string {
    return tr('auth:tabs.bunker');
  },
  get nsec(): string {
    return tr('auth:tabs.nsec');
  },
};

export function LoginModal({ onClose }: { onClose: () => void }): JSX.Element {
  const { t } = useTranslation('auth');
  const { connectNip07, connectBunker, connectNsec, nsecAllowed, nip07Available, status, error } = useIdentity();
  const [tab, setTab] = useState<LoginTab>('nip07');
  const [uri, setUri] = useState('');
  const [nsec, setNsec] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const tabs: LoginTab[] = nsecAllowed ? ['nip07', 'bunker', 'nsec'] : ['nip07', 'bunker'];
  const shown = tabs.includes(tab) ? tab : 'nip07';
  const message = localError ?? error;

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setLocalError(null);
    try {
      await action();
      onClose();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (shown === 'nip07') {
      void run(() => connectNip07());
      return;
    }
    if (shown === 'bunker') {
      void run(() => connectBunker(uri));
      return;
    }
    void run(() => connectNsec(nsec));
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t('modal.aria')} data-testid="login-modal">
      <form className="glass-card glass-modal" onSubmit={(event) => submit(event)}>
        <div className="modal-head">
          <p className="side-title">{t('modal.title')}</p>
          <button
            type="button"
            className="modal-close"
            aria-label={t('modal.close')}
            data-testid="login-close"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="composer-tabs" role="tablist" data-testid="login-tabs">
          {tabs.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={shown === value}
              className={shown === value ? 'tab-btn active' : 'tab-btn'}
              data-testid={`login-tab-${value}`}
              onClick={() => {
                setTab(value);
                setLocalError(null);
              }}
            >
              {LOGIN_TAB_LABELS[value]}
            </button>
          ))}
        </div>

        {shown === 'nip07' && (
          <div className="field">
            <p className="page-subtitle" data-testid="login-nip07-hint">
              {nip07Available ? t('nip07.found') : t('nip07.missing')}
            </p>
            <button type="submit" className="primary-btn" disabled={busy} data-testid="login-nip07-btn">
              {busy ? t('busy') : t('nip07.connect')}
            </button>
          </div>
        )}

        {shown === 'bunker' && (
          <>
            <div className="field">
              <label htmlFor="bunker-uri">{t('bunker.label')}</label>
              <input
                id="bunker-uri"
                name="bunker-uri"
                value={uri}
                disabled={busy}
                onChange={(event) => {
                  setUri(event.target.value);
                }}
                placeholder={t('bunker.placeholder')}
                data-testid="login-bunker-uri"
              />
            </div>
            <p className="page-subtitle" data-testid="login-bunker-hint">
              {t('bunker.hint')}
            </p>
            <button
              type="submit"
              className="primary-btn"
              disabled={busy || uri.trim() === ''}
              data-testid="login-bunker-btn"
            >
              {busy ? t('busy') : t('bunker.connect')}
            </button>
          </>
        )}

        {shown === 'nsec' && (
          <>
            <div className="field">
              <label htmlFor="login-nsec">{t('nsec.label')}</label>
              <input
                id="login-nsec"
                name="login-nsec"
                type="password"
                value={nsec}
                disabled={busy}
                onChange={(event) => {
                  setNsec(event.target.value);
                }}
                placeholder={t('nsec.placeholder')}
                data-testid="login-nsec-input"
              />
            </div>
            <p className="page-subtitle" data-testid="login-nsec-hint">
              {t('nsec.hint')}
            </p>
            <button
              type="submit"
              className="primary-btn"
              disabled={busy || nsec.trim() === ''}
              data-testid="login-nsec-btn"
            >
              {busy ? t('busy') : t('nsec.use')}
            </button>
          </>
        )}

        {message !== null && (
          <p className="notice error" role="alert" data-testid="login-error">
            {message}
          </p>
        )}
        {status === 'connecting' && (
          <p className="page-subtitle" data-testid="login-connecting">
            {t('status.connecting')}
          </p>
        )}
      </form>
    </div>
  );
}
