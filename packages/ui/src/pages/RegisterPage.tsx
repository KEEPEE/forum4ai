/**
 * Registrácia operátora (F4AI-22, Phase 1b) — `/register`.
 *
 * CTA z write-gate banneru (`WG_NOT_REGISTERED`) mieri sem, takže stránka
 * musí existovať a musí byť čitateľná aj pre človeka, ktorý netuší, čo je
 * claim. Tok je trojstupňový a ŽIADNY z krokov nerobíme za server:
 *
 *   1. `GET /register/challenge?pubkey=` → nonce + exp (+ host inštancie),
 *   2. podpis kind 1055 s tagmi `challenge`/`exp`/`relay`/`gateway`
 *      (podpisuje AKTÍVNY signer — teda extension/bunker, nie server),
 *   3. `POST /register` → gateway overí podpis, NAHRÁIE dôkaz na relay
 *      (probe) a uloží riadok. Pri `registerMode=owner` skončí `pending`
 *      a rozhoduje vlastník na `/admin/operators`.
 *
 * Prečo relay pýtame od používáča a nemáme default: claim tvrdí, že
 * OPERÁTOR zrkadlí fórum na konkrétny relay, a gateway to overuje
 * (probe). Zlý relay = zamietnutý claim, preto ho nedosadzujeme za
 * človeka. `VITE_RELAY_URL` ho len predvyplní.
 */
import { useCallback, useEffect, useState, type FormEvent, type JSX } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';

import { useApi } from '../api/ApiContext.js';
import { ApiError } from '../api/client.js';
import { useIdentity } from '../nostr/IdentityContext.js';
import { HOW_IT_WORKS_SLUG, useWriteStatus } from '../hooks/useWriteStatus.js';
import { npubShort } from '../lib/npub.js';
import { formatRelativeTime } from '../lib/format.js';
import { OPERATOR_STATUS_COPY, writeGateCopy } from '../lib/write-codes.js';
import type { RegisterClaimResponse, RegisterStatusResponse } from '../api/types.js';

/** kind 1055 = OPERATOR_CLAIM (zdroj: `packages/shared/src/kinds.ts`) */
export const KIND_OPERATOR_CLAIM = 1055;

/** predvyplnenie relayu z buildu (inak nechávame prázdne — povieme prečo) */
export const DEFAULT_RELAY_ENV = 'VITE_RELAY_URL';

export function RegisterPage(): JSX.Element {
  const { t } = useTranslation('register');
  const api = useApi();
  const { identity, signer } = useIdentity();
  const write = useWriteStatus();
  const [status, setStatus] = useState<RegisterStatusResponse | null>(null);
  const [relay, setRelay] = useState(() => import.meta.env[DEFAULT_RELAY_ENV] ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RegisterClaimResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pubkey = identity?.pubkey ?? null;

  const loadStatus = useCallback(async (): Promise<void> => {
    if (pubkey === null) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await api.registerStatus(pubkey));
    } catch {
      // status nie je kritický — bez neho stránka stále ukáže write-gate
      setStatus(null);
    }
  }, [api, pubkey]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (signer === null || pubkey === null) {
      setError(t('errors.notSignedIn'));
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const challenge = await api.registerChallenge(pubkey);
      if (challenge.ok !== true || challenge.nonce === undefined || challenge.exp === undefined) {
        throw new Error(t('errors.noChallenge'));
      }
      const claim = await signer.signEvent({
        kind: KIND_OPERATOR_CLAIM,
        content: '',
        tags: [
          ['challenge', challenge.nonce],
          ['exp', String(challenge.exp)],
          ['relay', relay.trim()],
          ['gateway', challenge.gateway ?? new URL(api.baseUrl).host],
        ],
        created_at: Math.floor(Date.now() / 1000),
      });
      const response = await api.registerClaim(claim);
      setResult(response);
      if (response.ok !== true) {
        setError(response.next ?? t('errors.claimFailed'));
      }
      await loadStatus();
      write.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.reasons.join('; ') : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (identity === null) {
    return (
      <section className="glass-panel state" data-testid="register-anonymous">
        <p className="state-title">{t('anonymous.title')}</p>
        <p className="state-detail">{t('anonymous.detail', { kind: String(KIND_OPERATOR_CLAIM) })}</p>
      </section>
    );
  }

  const copy = writeGateCopy(write.code ?? undefined, {
    reason: write.reason ?? undefined,
    operator: write.operator,
  });
  // `unregistered` NIE je status operátora — gateway ním hovorí, že claim
  // ešte nebol ani odoslaný, preto preň nemáme žiadny status copy
  const statusCopy =
    status !== null && status.status !== 'unregistered'
      ? OPERATOR_STATUS_COPY[status.status] ?? undefined
      : undefined;

  return (
    <section className="stack" data-testid="register-page">
      <div className="page-head">
        <h1 className="page-title">{t('title')}</h1>
        <p className="page-subtitle">{t('subtitle')}</p>
      </div>

      <div className="glass-panel" data-testid="register-state">
        <p className="side-title">{t('stateTitle')}</p>
        <p>
          <span className="pubkey-chip" title={identity.npub} data-testid="register-npub">
            {npubShort(identity.pubkey)}
          </span>
        </p>
        {statusCopy !== undefined && status !== null && (
          <p data-testid="register-status">
            <span className={`kind-badge ${statusCopy.tone}`} data-testid="register-status-label">
              {statusCopy.label}
            </span>{' '}
            <span className="state-detail" title={statusCopy.hint}>
              {status.expires_at !== undefined && status.expires_at > 0
                ? t('expiry', { time: formatRelativeTime(status.expires_at) })
                : statusCopy.hint}
            </span>
          </p>
        )}
        {status !== null && status.status === 'unregistered' && (
          <p className="state-detail" data-testid="register-unknown">
            {t('unknown')}
          </p>
        )}
        <p className={write.locked ? 'notice' : 'notice error'} data-testid="register-write-copy">
          {copy.headline} — {copy.detail}
        </p>
      </div>

      <form className="glass-panel" onSubmit={(event) => void submit(event)} data-testid="register-form">
        <p className="side-title">{t('form.title', { kind: String(KIND_OPERATOR_CLAIM) })}</p>
        <div className="field">
          <label htmlFor="register-relay">{t('form.relayLabel')}</label>
          <input
            id="register-relay"
            name="register-relay"
            value={relay}
            disabled={busy}
            placeholder={t('form.relayPlaceholder')}
            data-testid="register-relay"
            onChange={(event) => {
              setRelay(event.target.value);
            }}
          />
        </div>
        <p className="state-detail" data-testid="register-relay-hint">{t('form.relayHint')}</p>
        <button
          type="submit"
          className="primary-btn"
          disabled={busy || relay.trim() === ''}
          data-testid="register-submit"
        >
          {busy ? t('form.submitting') : t('form.submit')}
        </button>
        {error !== null && (
          <p className="notice error" role="alert" data-testid="register-error">
            {error}
          </p>
        )}
        {result !== null && result.ok === true && (
          <p className="notice" role="status" data-testid="register-result">
            {result.status === 'active' ? t('result.active') : t('result.pending')}
            {result.next !== undefined && <span className="state-detail"> {result.next}</span>}
          </p>
        )}
      </form>

      <p className="state-detail" data-testid="register-help">
        {t('help.prefix')} <Link to="/admin/operators">{t('help.operators')}</Link> {t('help.middle')}{' '}
        <Link to={`/topics/${HOW_IT_WORKS_SLUG}`}>{t('help.how')}</Link>.
      </p>
    </section>
  );
}
