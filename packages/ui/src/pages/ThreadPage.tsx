/**
 * Vlákno `/threads/:id` (S11 → F4AI-18/S12) — `GET /threads/:id`: root
 * event, strom odpovedí (`ReplyNode` s rekurzívnymi `children`), agregát
 * hodnotení 1031/1032 a composer odpovede viazaný na toto vlákno.
 *
 * S12 pridáva:
 *  - **1031 rating badge** v hlavičke, ak `rating.count > 0` (priemer 1–5
 *    + počet ratingov; wilson/n_eff ostávajú v mriežke agregátu)
 *  - **accepted solution** vyznačenie, ak `rating.accepted` (agregát S9 —
 *    1032 viazaný na root), badge na karte rootu aj v hlavičke
 *  - **untrusted badge** na karte rootu aj každej odpovedi (obsah fóra
 *    nie je moderovaný — rovnaký status ako `untrusted` reťazce iných
 *    route)
 *  - **live update**: `useLiveFeed({ threadId })` — nový 1023 s `e` tagom
 *    na root → invalidácia a refetch vlákna (reply sa objavia bez
 *    reload-u stránky); po publishi z composeru taktiež refetch
 */
import { type JSX } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';

import { useApi } from '../api/ApiContext.js';
import { useResource } from '../hooks/useResource.js';
import { useLiveFeed } from '../hooks/useLiveFeed.js';
import { Composer } from '../components/Composer.js';
import { EventCard, ReplyTree } from '../components/EventCard.js';
import { StateEmpty, StateError, StateLoading } from '../components/StateView.js';
import { formatPercent, formatScore } from '../lib/format.js';

/**
 * C1: `GET /threads/:id` dokáže ako root vrátiť aj ODPOVEĎ (1023) — ak
 * otvoríš permalink odpovede. Odpoveď v composeri sa musí viazať `root`
 * markerom na SKUTOČNÝ root vlákna (otázku 1020), inak L2 pravidlo
 * (práve jeden root marker) vytvorí nový strom a odpoveď zmizne z
 * pôvodného vlákna. Skutočný root berieme z `e` tagu rootu samotného:
 * marker `root`, fallback prvý 64-hex `e` tag.
 */
export function realRootOf(root: { kind: number; tags: string[][] }): string | null {
  if (root.kind !== 1023) return null;
  for (const tag of root.tags) {
    if (tag[0] === 'e' && tag[2] === 'root' && typeof tag[1] === 'string' && tag[1].length === 64) {
      return tag[1];
    }
  }
  for (const tag of root.tags) {
    if (tag[0] === 'e' && typeof tag[1] === 'string' && tag[1].length === 64) return tag[1];
  }
  return null;
}

export function ThreadPage(): JSX.Element {
  const { t } = useTranslation(['forum', 'common']);
  const { id = '' } = useParams();
  const api = useApi();
  const thread = useResource(() => api.thread(id), [api, id]);

  // live: nové odpovede (1023) viazané na root tohto vlákna → refetch
  const live = useLiveFeed({
    threadId: id,
    kinds: [1023],
    onEvent: () => {
      thread.reload();
    },
  });

  // C1: ak je root odpoveď (1023), odpovedáme na jej skutočný root
  const realRoot = thread.data !== null ? realRootOf(thread.data.root) : null;

  return (
    <>
      <nav className="breadcrumbs" aria-label="breadcrumbs">
        <Link to="/">feed</Link>
        <span>/</span>
        <span>thread</span>
        <span>/</span>
        <span className="hex">{`${id.slice(0, 12)}…`}</span>
      </nav>

      {thread.loading && <StateLoading label={t('thread.loading')} />}
      {thread.error !== null && <StateError error={thread.error} onRetry={thread.reload} />}

      {thread.data !== null && (
        <>
          <div className="page-head">
            <div>
              <h1 className="page-title">
                {t('thread.title')}{' '}
                {thread.data.rating.count > 0 && (
                  <span
                    className="rating-badge"
                    data-testid="thread-rating-badge"
                    title={t('thread.ratingTitle', {
                      score: formatScore(thread.data.rating.mean15),
                      count: thread.data.rating.count,
                    })}
                  >
                    ★ {formatScore(thread.data.rating.mean15)}/5 · {String(thread.data.rating.count)}×
                  </span>
                )}
              </h1>
              <p className="page-subtitle">
                {t('thread.replies', { count: thread.data.reply_count })} {t('thread.ratingLabel')}{' '}
                {formatScore(thread.data.rating.mean15)}/5 {t('thread.wilson')} {formatPercent(thread.data.rating.wilson)}
                {' · '}
                <span data-testid="thread-live-status" title={t('live.repliesTitle')}>
                  {t('live.status')} {live.status}
                </span>
              </p>
            </div>
            <div className="page-head-badges">
              <span className="untrusted-badge" data-testid="untrusted-badge" title={t('common:untrusted.title')}>
                untrusted
              </span>
              {thread.data.rating.accepted && (
                <span
                  className="status-pill done"
                  data-testid="thread-accepted-pill"
                  title={t('thread.acceptedTitle', { count: thread.data.rating.accepted_count })}
                >
                  {t('thread.acceptedPill')}
                </span>
              )}
            </div>
          </div>

          <div className="stack">
            <EventCard
              event={thread.data.root}
              to={`/threads/${thread.data.root.id}`}
              testId="thread-root"
              untrusted
              rich
            />
          </div>

          <section className="stat-grid" aria-label={t('thread.statsAria')}>
            <div className="glass-panel stat">
              <p className="stat-value">{String(thread.data.rating.count)}</p>
              <p className="stat-label">{t('thread.statRatings')}</p>
            </div>
            <div className="glass-panel stat">
              <p className="stat-value">{formatScore(thread.data.rating.mean15)}</p>
              <p className="stat-label">{t('thread.statMean')}</p>
            </div>
            <div className="glass-panel stat">
              <p className="stat-value">{formatPercent(thread.data.rating.wilson)}</p>
              <p className="stat-label">{t('thread.statWilson')}</p>
            </div>
            <div className="glass-panel stat">
              <p className="stat-value">{formatScore(thread.data.rating.n_eff)}</p>
              <p className="stat-label">{t('thread.statNeff')}</p>
            </div>
          </section>

          {thread.data.rating.note !== undefined && <p className="notice">{thread.data.rating.note}</p>}

          {thread.data.replies.length === 0 ? (
            <StateEmpty title={t('thread.emptyTitle')} hint={t('thread.emptyHint')} />
          ) : (
            <ReplyTree nodes={thread.data.replies} />
          )}

          {thread.data.issues.length > 0 && (
            <p className="notice">
              {t('thread.issues')} {thread.data.issues.join('; ')}
            </p>
          )}

          <Composer
            replyTo={realRoot ?? thread.data.root.id}
            parentId={realRoot !== null ? thread.data.root.id : null}
            heading={realRoot !== null ? t('composer.heading.replyToReply') : t('composer.heading.thread')}
            onPublished={() => {
              thread.reload();
            }}
          />
        </>
      )}
    </>
  );
}
