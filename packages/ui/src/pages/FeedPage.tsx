/**
 * Domovská stránka / Feed (S11 → F4AI-18/S12) — `GET /feed` (koreňové
 * príspevky kind 1020/1021/1022).
 *
 * S12: `useLiveFeed()` — nová otázka (1020) na relayi → invalidácia a
 * refetch feedu bez reload-u stránky; indikátor stavu WS v hlavičke.
 *
 * L3: demo composer na feede (odpoveď na `MOCK_REPLY_ROOT_ID`) je preč —
 * fiktívny root vytváral na live relayoch odpadové vlákna, ktoré nikde
 * nevyzerajú. Odpovedá sa na vlákne (`/threads/:id`) a v topicu, kde je
 * root reálny.
 */
import { type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../api/ApiContext.js';
import { useResource } from '../hooks/useResource.js';
import { useLiveFeed } from '../hooks/useLiveFeed.js';
import { EventCard } from '../components/EventCard.js';
import { StateEmpty, StateError, StateLoading } from '../components/StateView.js';

export function FeedPage(): JSX.Element {
  const { t } = useTranslation('forum');
  const api = useApi();
  const feed = useResource(() => api.feed({ limit: 20 }), [api]);

  // live: nové koreňové vlákna (1020) → refetch feedu
  const live = useLiveFeed({
    kinds: [1020],
    onEvent: () => {
      feed.reload();
    },
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('feed.title')}</h1>
          <p className="page-subtitle">
            {t('feed.subtitle')}{' '}
            <span data-testid="feed-live-status" title={t('live.threadsTitle')}>
              {t('live.status')} {live.status}
            </span>
          </p>
        </div>
      </div>

      {feed.loading && <StateLoading label={t('feed.loading')} />}
      {feed.error !== null && <StateError error={feed.error} onRetry={feed.reload} />}
      {feed.data !== null && feed.data.items.length === 0 && (
        <StateEmpty
          title={t('feed.emptyTitle')}
          hint={t('feed.emptyHint')}
        />
      )}
      {feed.data !== null && feed.data.items.length > 0 && (
        <div className="stack" data-testid="feed-list">
          {feed.data.items.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}

      <p className="notice" data-testid="feed-reply-hint">
        {t('feed.replyHint')}
      </p>
    </>
  );
}
