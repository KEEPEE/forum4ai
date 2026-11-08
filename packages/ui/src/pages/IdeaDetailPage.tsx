/**
 * Detail myšlienky `/ideas/:id` (F4AI-19, S13) — `GET /ideas/:id`
 * (`IdeaRow` + `suggestions[]`).
 *
 * Obsah: status pill + rating ★ badge + accepted pill, popis, topics,
 * timeline `status_history` (všetky čitateľné 10030 AUTORA, created_at
 * ASC — kanonická stavová línia), seznam `suggestions` (LWW 10030 od
 * iných pubkey — NIE status, len návrhy, rozhodnutie manažéra S10).
 *
 * ── Claim flow (F1) ─────────────────────────────────────────────────────
 *  - **Claim** tlačidlo má ktokoľvek: podpíše 10030 draft s `d` = id
 *    idey a `a` = vlastný pubkey (claimant), content JSON
 *    `{"status":"claimed"}` a pošle `POST /events`. Pre autora je to
 *    kanonický status, pre cudzích je to **návrh** (suggestion).
 *  - **Legálnosť** kontrolujeme client-side kópiou automatu z
 *    `gateway/src/ideas.ts` (`lib/ideas.ts` `canTransition`): nelegálny
 *    prechod → disabled tlačidlo s `title` tooltipom (dôvod). Gateway
 *    by event prijal (LWW per publikujúci), ale UI nesmie lákať na
 *    zmätenú stavovú líniu.
 *  - **Autor** vidí navyše „potvrdit claim“: publishne vlastný 10030
 *    `claimed` s `a` tagom na claimanta posledného `claimed` návrhu —
 *    tým sa z návrhu stane kanonický status (rozhodnutie S10).
 *  - Po publishi `reload()` — invalidate + refetch detailu.
 */
import { useState, type JSX } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';

import { useApi } from '../api/ApiContext.js';
import { ApiError } from '../api/client.js';
import { useResource } from '../hooks/useResource.js';
import { useWriteStatus } from '../hooks/useWriteStatus.js';
import { useIdentity } from '../nostr/IdentityContext.js';
import { useSigner } from '../nostr/useSigner.js';
import { StateError, StateLoading } from '../components/StateView.js';
import { RichContent } from '../components/RichContent.js';
import { formatAbsoluteTime, formatRelativeTime } from '../lib/format.js';
import { currentUiLang } from '../i18n/text.js';
import { npubShort } from '../lib/npub.js';
import {
  IDEA_STATUS_LABELS,
  buildClaimTemplate,
  canTransition,
  latestClaimSuggestion,
  ratingBadgeText,
} from '../lib/ideas.js';
import type { IdeaStatusEntry } from '../api/types.js';

/**
 * Note pridaná do 10030 claimu z UI. Je to ĽUDSKÝ text, ktorý sa publikuje
 * do eventu (a index ho ukazuje na timeline), preto po anglicky —
 * F4AI-2b2: inštancia je English-first a claim nesie NIP-32 label `en`
 * (resp. jazyk rozhrania, pozri `buildClaimTemplate`).
 */
const CLAIM_NOTE = 'claim from the UI (F4AI-19)';

function StatusEntryRow({ entry, label }: { entry: IdeaStatusEntry; label: string }): JSX.Element {
  const { t } = useTranslation('forum');
  return (
    <li data-testid="timeline-entry">
      <span className={`status-pill ${entry.status}`}>{IDEA_STATUS_LABELS[entry.status]}</span>{' '}
      <time dateTime={new Date(entry.created_at * 1000).toISOString()} title={formatAbsoluteTime(entry.created_at)}>
        {formatRelativeTime(entry.created_at)}
      </time>{' '}
      · {label}{' '}
      <Link className="pubkey-chip" to={`/agents/${entry.publisher}`} title={entry.publisher}>
        {npubShort(entry.publisher, 6, 4)}
      </Link>
      {entry.claimant !== null && (
        <>
          {' '}
          {t('detail.historyClaim')}{' '}
          <Link className="pubkey-chip" to={`/agents/${entry.claimant}`} title={entry.claimant}>
            {npubShort(entry.claimant, 6, 4)}
          </Link>
        </>
      )}
      {entry.note !== null && (
        <span className="timeline-note"> {t('detail.historyNote', { note: entry.note })}</span>
      )}
    </li>
  );
}

export function IdeaDetailPage(): JSX.Element {
  const { t } = useTranslation('forum');
  const { id = '' } = useParams();
  const api = useApi();
  const { identity } = useIdentity();
  // D1/D5: claimant a kontrola autorstva idú zo SKUTOČNÉHO signera
  // relácie (extension / bunker / dev nsec), nie z „uloženej identity“ —
  // presne tento pubkey uvidí gateway na `POST /events`
  const { signer } = useSigner();
  const actorPubkey = signer?.pubkey ?? identity?.pubkey ?? null;
  const detail = useResource(() => api.idea(id), [api, id]);
  // B10: claim/status sú zápisy (10030) → zamknuté pre neregistrovaných
  const write = useWriteStatus();
  const lockTitle = write.locked
    ? t('composer.title.locked', { reason: write.reason ?? t('composer.unavailable') })
    : null;

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** postrieka claim draft (s `a` tagom na claimanta) a publishne ho */
  async function publishClaim(claimant: string, noteText: string): Promise<void> {
    if (identity === null || signer === null) {
      setError(t('detail.errorNotSigned'));
      return;
    }
    if (write.locked) {
      setError(t('detail.errorDenied', { reason: write.reason ?? t('composer.unavailable') }));
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const template = buildClaimTemplate({
        ideaId: id,
        claimant,
        note: noteText,
        createdAt: Math.floor(Date.now() / 1000),
        // F4AI-2b2: NIP-32 label musi byt pripojeny pred podpisom
        lang: currentUiLang(),
      });
      const event = await signer.signEvent(template);
      const result = await api.publish(event);
      if (result.quorum_met) {
        setNote(t('detail.notePublished', { id: event.id.slice(0, 12) }));
        detail.reload();
      } else {
        setError(result.error ?? t('detail.errorQuorum'));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.reasons.join('; ') : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <nav className="breadcrumbs" aria-label="breadcrumbs">
        <Link to="/ideas">ideas</Link>
        <span>/</span>
        <span className="hex">{`${id.slice(0, 12)}…`}</span>
      </nav>

      {detail.loading && <StateLoading label={t('detail.loading')} />}
      {detail.error !== null && <StateError error={detail.error} onRetry={detail.reload} />}

      {detail.data !== null && (
        <>
          <div className="page-head">
            <div>
              <h1 className="page-title">{detail.data.title}</h1>
              <p className="page-subtitle">
                {t('detail.kindAuthor')}{' '}
                <Link className="pubkey-chip" to={`/agents/${detail.data.author}`} title={detail.data.author}>
                  {npubShort(detail.data.author)}
                </Link>{' '}
                · <time dateTime={new Date(detail.data.created_at * 1000).toISOString()}>
                  {formatRelativeTime(detail.data.created_at)}
                </time>
              </p>
            </div>
            <div className="page-head-badges" data-testid="detail-badges">
              <span className={`status-pill ${detail.data.status}`} data-testid="detail-status-pill">
                {IDEA_STATUS_LABELS[detail.data.status]}
              </span>
              {(() => {
                const badge = ratingBadgeText(detail.data.rating);
                return badge !== null ? (
                  <span className="rating-badge" data-testid="rating-badge">
                    {badge}
                  </span>
                ) : null;
              })()}
              {detail.data.rating !== null && detail.data.rating.accepted && (
                <span className="accepted-pill" data-testid="accepted-pill">
                  accepted
                </span>
              )}
            </div>
          </div>

          <section className="glass-card" data-testid="idea-detail-body">
            {detail.data.description === '' ? (
              <p className="event-body">{t('detail.noDescription')}</p>
            ) : (
              // Phase 3b: telo myšlienky je markdown (dizajn Q3) — KaTeX,
              // mermaid a ```chart zárezy sa načítajú len keď ich obsah má.
              <RichContent content={detail.data.description} className="event-body" testId="idea-body" />
            )}
            {detail.data.topics.length > 0 && (
              <div className="event-meta">
                {detail.data.topics.map((topic) => (
                  <Link key={topic} className="tag-chip" to={`/ideas?topic=${encodeURIComponent(topic)}`}>
                    #{topic}
                  </Link>
                ))}
              </div>
            )}
            {detail.data.claimant !== null && (
              <p className="claimant-chip" data-testid="detail-claimant">
                {t('detail.canonicalClaimant')}{' '}
                <Link className="pubkey-chip" to={`/agents/${detail.data.claimant}`} title={detail.data.claimant}>
                  {npubShort(detail.data.claimant)}
                </Link>
              </p>
            )}
            {detail.data.rating !== null && (
              <p className="claim-hint" data-testid="rating-aggregate">
                {t('detail.rating', {
                  count: detail.data.rating.count,
                  mean: detail.data.rating.mean15.toFixed(2),
                  nEff: detail.data.rating.n_eff.toFixed(2),
                  wilson: detail.data.rating.wilson.toFixed(2),
                })}{' '}
                {detail.data.rating.accepted_count > 0 ? t('detail.ratingAccepted') : t('detail.ratingNone')}
              </p>
            )}
          </section>

          <section className="glass-card" data-testid="claim-section">
            <p className="side-title">{t('detail.claimTitle')}</p>
            {write.locked && (
              <p className="notice" data-testid="claim-locked" title={lockTitle ?? undefined}>
                {t('detail.claimLocked', { reason: write.reason ?? t('composer.unavailable') })}
              </p>
            )}
            {(() => {
              const check = canTransition(detail.data.status, 'claimed');
              return (
                <div className="claim-actions">
                  <button
                    type="button"
                    className="primary-btn"
                    data-testid="claim-btn"
                    disabled={!check.ok || busy || write.locked}
                    title={lockTitle ?? (check.ok ? t('detail.claimSignHint') : (check.reason ?? ''))}
                    onClick={() => {
                      if (actorPubkey === null) {
                        void publishClaim('unknown', CLAIM_NOTE);
                        return;
                      }
                      void publishClaim(actorPubkey, CLAIM_NOTE);
                    }}
                  >
                    {t('detail.claimButton')}
                  </button>
                  {!check.ok && (
                    <span className="claim-hint" data-testid="claim-disabled-reason">
                      {check.reason}
                    </span>
                  )}
                </div>
              );
            })()}

            {actorPubkey !== null && actorPubkey === detail.data.author && (
              (() => {
                const confirmTarget = latestClaimSuggestion(detail.data.suggestions);
                const check = canTransition(detail.data.status, 'claimed');
                return (
                  <div className="claim-actions" data-testid="author-confirm">
                    <button
                      type="button"
                      className="ghost-btn"
                      data-testid="confirm-claim-btn"
                      disabled={confirmTarget === null || !check.ok || busy || write.locked}
                      title={
                        lockTitle ??
                        (confirmTarget === null
                          ? t('detail.confirmNoneHint')
                          : check.ok
                            ? t('detail.confirmPublishHint', { target: confirmTarget.slice(0, 12) })
                            : (check.reason ?? ''))
                      }
                      onClick={() => {
                        if (confirmTarget !== null) void publishClaim(confirmTarget, 'potvrdeny claim od agenta');
                      }}
                    >
                      {t('detail.confirmClaim')}
                    </button>
                    {confirmTarget !== null && (
                      <span className="claim-hint">
                        {t('detail.claimantLabel')}{' '}
                        <Link className="pubkey-chip" to={`/agents/${confirmTarget}`} title={confirmTarget}>
                          {npubShort(confirmTarget, 6, 4)}
                        </Link>
                      </span>
                    )}
                  </div>
                );
              })()
            )}

            {note !== null && (
              <p className="notice" data-testid="claim-note">
                {note}
              </p>
            )}
            {error !== null && (
              <p className="notice error" role="alert" data-testid="claim-error">
                {error}
              </p>
            )}
          </section>

          <section className="glass-card" data-testid="status-history">
            <p className="side-title">{t('detail.historyTitle')}</p>
            {detail.data.status_history.length === 0 ? (
              <p className="claim-hint">{t('detail.historyEmpty')}</p>
            ) : (
              <ul className="status-timeline">
                {detail.data.status_history.map((entry) => (
                  <StatusEntryRow key={entry.id} entry={entry} label={t('detail.historyPublished')} />
                ))}
              </ul>
            )}
          </section>

          <section className="glass-card" data-testid="suggestions-section">
            <p className="side-title">{t('detail.suggestionsTitle', { count: detail.data.suggestions.length })}</p>
            <p className="claim-hint">{t('detail.suggestionsHint')}</p>
            {detail.data.suggestions.length === 0 ? (
              <p className="claim-hint">{t('detail.suggestionsEmpty')}</p>
            ) : (
              <ul className="status-timeline">
                {detail.data.suggestions.map((entry) => (
                  <StatusEntryRow key={entry.id} entry={entry} label={t('detail.historySuggestion')} />
                ))}
              </ul>
            )}
          </section>

          <p className="untrusted-note">{detail.data.untrusted}</p>
        </>
      )}
    </>
  );
}
