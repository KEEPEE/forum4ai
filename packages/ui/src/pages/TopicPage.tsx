/**
 * Detail topicu `/topics/:slug` (S11 → F4AI-18/S12) — `GET /topics/:slug`
 * vracia `{ topic, children, threads, thread_count, limit, issues }`:
 * uzol stromu + deti + posledné N koreňových vlákien (1020/1021/1022 s `a`
 * tagom na adresu topicu). Stránka z toho postaví hlavičku, strom detí a
 * zoznam vlákien s náhľadom (title + prvý riadok textu z `EventCard`).
 *
 * S12 pridáva:
 *  - **composer otázky** (`mode="question"`): kind 1020 s `a` tagom na
 *    adresu topicu + `t` tagom na slug → `POST /events`; po úspešnom
 *    publishi refetch (vlákno pribudne do zoznamu)
 *  - **live update**: `useLiveFeed({ topicAddress })` — nová otázka v
 *    topicu → invalidácia + refetch bez reload-u stránky
 *  - empty/error stavy ponechané (prázdny topic, 404 `topic not found`)
 *
 * Phase 6b (dizajn Q5): `?origin=<upstream id>` prepne stránku do režimu
 * CUDZÍ STROM. Domáce čítanie (`GET /topics/:slug`) číta relaye, v ktorých
 * cudzie eventy nie sú — pull ich ukladá do `fed.db` a do indexu (sweep v
 * `indexer/src/fed.ts`), do relays ich prinesie až `strfry router`
 * stream-down. Preto cudzí detail nepoužíva relay route vôbec:
 *
 *   1. koreň  → `GET /fed/topics?limit=200` a v ňom presná zhoda
 *      `upstream.id === origin` + `root.slug === slug`
 *      (`findRemoteTopicRoot()` v `lib/federation.ts`),
 *   2. vlákna → `GET /search?q=<adresa topicu>&kinds=1020,1021,1022&origin=<id>`.
 *
 * Prečo práve táto cesta: REST `/search` NEMÁ filter podľa adresy (`a=`),
 * takže `/search?kinds=30020&a=<addr>` zo zadania by bol heuristický dopyt
 * — a `GET /fed/events` naopak vráca LOKÁLNY obsah (relay pool), nie
 * cudzie eventy. Adresa topicu je v `tags_text` indexu (hodnota `a` tagu),
 * takže `q=<adresa>` je na FTS5 fráza `30020 <pubkey> <slug>` — presné,
 * nie výčet slov. Vlákna sú náhľad z indexu, nie čítanie z relayu, a to
 * stránka aj povie.
 */
import { type JSX } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';

import { useApi } from '../api/ApiContext.js';
import type { Api } from '../api/client.js';
import { useResource } from '../hooks/useResource.js';
import { useLiveFeed } from '../hooks/useLiveFeed.js';
import { Composer } from '../components/Composer.js';
import { EventCard } from '../components/EventCard.js';
import { RichContent } from '../components/RichContent.js';
import { StateEmpty, StateError, StateLoading } from '../components/StateView.js';
import { titleFromContent } from '../lib/format.js';
import {
  findRemoteTopicRoot,
  isRemoteOrigin,
  normalizeOriginId,
  originShortLabel,
} from '../lib/federation.js';
import type {
  EventSummary,
  FedRemoteTopic,
  FedUpstreamTopics,
  SearchResult,
} from '../api/types.js';

/** kindy koreňových vlákien — rovnaká trojica ako domáci `topic.threads` */
const REMOTE_THREAD_KINDS = [1020, 1021, 1022];

export function TopicPage(): JSX.Element {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  // Phase 6b: `?origin=` nesmie byť nikdy dôveryhodný reťazec z URL —
  // normalizujeme ho (lowercase, trim) a prázdny/`self`/`any` je domáci
  // režim, nie cudzí.
  const rawOrigin = params.get('origin');
  const remoteOrigin = isRemoteOrigin(rawOrigin) ? normalizeOriginId(rawOrigin) : null;

  if (remoteOrigin === null) return <LocalTopicPage slug={slug} />;
  return <RemoteTopicPage slug={slug} origin={remoteOrigin} />;
}

/** domáci detail — `GET /topics/:slug` (relay pool), S11/S12 správanie */
function LocalTopicPage({ slug }: { slug: string }): JSX.Element {
  const { t } = useTranslation('forum');
  const api = useApi();
  const topic = useResource(() => api.topic(slug, { limit: 20 }), [api, slug]);

  // live: nová otázka (1020) v tomto topicu → refetch zoznamu vlákien
  const live = useLiveFeed({
    topicSlug: slug,
    topicAddress: topic.data?.topic.address ?? null,
    kinds: [1020],
    onEvent: () => {
      topic.reload();
    },
  });

  return (
    <>
      <nav className="breadcrumbs" aria-label="breadcrumbs">
        <Link to="/">feed</Link>
        <span>/</span>
        <span>topics</span>
        <span>/</span>
        <span>{slug}</span>
      </nav>

      {topic.loading && <StateLoading label={t('topics.pageLoading', { slug })} />}
      {topic.error !== null && <StateError error={topic.error} onRetry={topic.reload} />}

      {topic.data !== null && (
        <>
          <div className="page-head">
            <div>
              <h1 className="page-title">{topic.data.topic.slug}</h1>
              {/* Phase 3b: popis topicu (a text stránky „about-this-forum") sa
                  renderuje ako markdown — `.page-subtitle` ostáva na kontajneri. */}
              {(() => {
                const description = titleFromContent(topic.data.topic.content, '');
                return description === '' ? (
                  <p className="page-subtitle">{t('topics.noDescription')}</p>
                ) : (
                  <RichContent content={description} className="page-subtitle" testId="topic-description" />
                );
              })()}
              <p className="page-subtitle">
                <span data-testid="topic-live-status" title={t('live.threadsTitle')}>
                  {t('live.status')} {live.status}
                </span>
              </p>
            </div>
            <p className="untrusted-note">{t('topics.threadCount', { count: topic.data.thread_count })}</p>
          </div>

          {topic.data.children.length > 0 && (
            <section className="glass-panel" style={{ padding: 20 }} aria-label={t('topics.childrenAria')}>
              <p className="side-title">{t('topics.childrenTitle')}</p>
              <ul className="topic-tree">
                {topic.data.children.map((child) => (
                  <li key={child.address ?? child.slug}>
                    <Link className="topic-link" to={`/topics/${child.slug}`} data-testid={`topic-child-${child.slug}`}>
                      {child.slug}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {topic.data.threads.length === 0 ? (
            <StateEmpty title={t('topics.emptyTitle')} hint={t('topics.emptyHint')} />
          ) : (
            <div className="stack" data-testid="topic-threads">
              {topic.data.threads.map((event) => (
                <EventCard key={event.id} event={event} />
              ))}
            </div>
          )}

          {topic.data.issues.length > 0 && (
            <p className="notice">{t('topics.diagnostics')} {topic.data.issues.join('; ')}</p>
          )}

          {topic.data.topic.address !== null && (
            <Composer
              mode="question"
              topic={{ address: topic.data.topic.address, slug: topic.data.topic.slug }}
              heading={t('composer.heading.topic')}
              testId="topic-composer"
              onPublished={() => {
                topic.reload();
              }}
            />
          )}
        </>
      )}
    </>
  );
}

/**
 * Cudzí detail (Phase 6b). Dva dopyty, oba REST, žiadny relay:
 * `GET /fed/topics` (koreň) a `GET /search` (vlákna). Search zlyhať MÔŽE
 * (503 index unavailable) — vtedy stránka stále ukáže koreň a povie, prečo
 * nie sú vlákna; koreň zlyhá = empty/404 → not-found hlášku, nie error.
 */
function RemoteTopicPage({ slug, origin }: { slug: string; origin: string }): JSX.Element {
  const { t } = useTranslation('forum');
  const api = useApi();
  const view = useResource(() => loadRemoteTopic(api, origin, slug), [api, slug, origin]);

  return (
    <>
      <nav className="breadcrumbs" aria-label="breadcrumbs">
        <Link to="/">feed</Link>
        <span>/</span>
        <Link to="/">{t('network.title')}</Link>
        <span>/</span>
        <span>{slug}</span>
      </nav>

      {view.loading && <StateLoading label={t('topics.pageLoading', { slug })} />}
      {view.error !== null && <StateError error={view.error} onRetry={view.reload} />}
      {/* `data === null` bez chyby = koreň sme nenašli (ešte stiahnutý nie je) */}
      {view.data === null && !view.loading && view.error === null && (
        <StateEmpty title={t('topics.remoteNotFoundTitle')} hint={t('topics.remoteNotFoundHint', { id: origin, slug })} />
      )}

      {view.data !== null && <RemoteTopicDetail data={view.data} origin={origin} slug={slug} />}
    </>
  );
}

/** teliesko cudzieho detailu — samostatná zložka, lebo `data` je narrows */
function RemoteTopicDetail({
  data,
  origin,
  slug,
}: {
  data: RemoteTopicView;
  origin: string;
  slug: string;
}): JSX.Element {
  const { t } = useTranslation('forum');
  const { root } = data;
  // dopyt, ktorý vlákna našiel — odkaz vedie na tú istú množinu, nie do
  // `/threads/:id` (cudzie eventy v relayoch ešte nie sú, stream-down je
  // 6b backend a do tej doby by detail vlákna vrátil 404)
  const address = root.address ?? root.slug ?? slug;
  const searchUrl = `/search?q=${encodeURIComponent(address)}&origin=${encodeURIComponent(origin)}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            {root.slug ?? root.id.slice(0, 12)}{' '}
            <span
              className="origin-chip kind-badge info"
              data-testid="topic-origin-chip"
              title={t('search.originChip', { id: origin })}
            >
              {originShortLabel(origin)}
            </span>
          </h1>
          {(() => {
            const description = titleFromContent(root.content, '');
            return description === '' ? (
              <p className="page-subtitle">{t('topics.noDescription')}</p>
            ) : (
              <RichContent content={description} className="page-subtitle" testId="topic-description" />
            );
          })()}
          <p className="page-subtitle" data-testid="topic-remote-note">
            {t('topics.remoteNote', { id: origin })}
          </p>
          <p className="page-subtitle">
            <code data-testid="topic-remote-address">{root.address ?? '—'}</code>
          </p>
        </div>
        <p className="untrusted-note">
          <Link className="pubkey-chip" to={searchUrl} data-testid="topic-remote-search">
            {t('topics.remoteSearchLink')}
          </Link>
        </p>
      </div>

      {data.threads.length === 0 ? (
        <StateEmpty
          title={t('topics.emptyTitle')}
          hint={data.threadsFailed ? t('topics.remoteThreadsNote') : t('topics.emptyHint')}
        />
      ) : (
        <>
          <p className="untrusted-note" data-testid="topic-remote-count">
            {t('topics.remoteThreadsTitle', { count: data.threads.length })}
          </p>
          <p className="notice" data-testid="topic-remote-note-threads">
            {t('topics.remoteThreadsNote')}
          </p>
          <div className="stack" data-testid="topic-threads">
            {data.threads.map((hit) => (
              <EventCard key={hit.id} event={searchHitToEvent(hit)} testId="remote-thread-card" to={searchUrl} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** hit z indexu → `EventSummary` pre EventCard (index neposiela tags/sig) */
function searchHitToEvent(hit: SearchResult): EventSummary {
  return {
    id: hit.id,
    pubkey: hit.pubkey,
    created_at: hit.created_at,
    kind: hit.kind,
    tags: [],
    content: hit.snippet,
    sig: '',
  };
}

export interface RemoteTopicView {
  upstream: FedUpstreamTopics;
  root: FedRemoteTopic;
  threads: SearchResult[];
  /** search zlyhal (index nedostupný) — odlišujeme ho od „žiadne vlákna“ */
  threadsFailed: boolean;
}

/**
 * Rozbalí cudzí topic. `null` = koreň neexistuje (cudzí upstream, alebo
 * ešte nebol stiahnutý) — volajúci ukáže not-found, nie error.
 */
export async function loadRemoteTopic(api: Api, origin: string, slug: string): Promise<RemoteTopicView | null> {
  const fed = await api.getFedTopics({ limit: 200 });
  const match = findRemoteTopicRoot(fed, origin, slug);
  if (match === null) return null;
  const address = match.root.address ?? match.root.slug ?? slug;
  try {
    const found = await api.search({
      q: address,
      kinds: REMOTE_THREAD_KINDS,
      origin,
      limit: 20,
    });
    return { ...match, threads: found.results, threadsFailed: false };
  } catch {
    return { ...match, threads: [], threadsFailed: true };
  }
}
