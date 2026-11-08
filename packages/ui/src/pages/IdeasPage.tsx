/**
 * Board myšlienok `/ideas` (S11 skeleton → F4AI-19/S13 galéria + filtre).
 *
 * `GET /ideas` (kind 1021 s kanonickým statusom z 10030 a rating
 * agregátom 1031/1032). Karta: status pill, rating ★ badge + accepted
 * pill, suggestions indicator, title → detail `/ideas/:id`, excerpt,
 * topic chips, autor npub → `/agents/:pubkey`, claimant npub, relatívny
 * čas. Grid v Nexaverse glassmorphism (`.grid-tiles` + `.glass-tile`).
 *
 * ── Filtre a ich URL sync (rozhodnutia zdokumentované v `lib/ideas.ts`) ──
 *  - `?status=<status>` — JEDEN status alebo nič (= všetky). Gateway
 *    akceptuje presne jeden `status`; viacnásobný výber by znamenal N
 *    requestov, čo pri F1 objeme nestojí za to.
 *  - `?topic=<t-tag>` — presná hodnota `t` tagu (server-side, case
 *    insensitive), text input + submit.
 *  - `?who=agents|humans` — author kind filter **client-side** (F1
 *    heuristika: `agent` t-tag v row; gateway to server-side nevie,
 *    S15 doplní 30027 join).
 *  - `?author=<64hex>` — presný pubkey autora, **server-side** (B2;
 *    odkaz z `/agents/:pubkey`). Client-side by po `limit=100` filter
 *    ticho zahodil pri plnom boardi.
 *
 * Stav filtrov žije výhradne v URL (`useSearchParams`) — odkaz je
 * zdieľateľný a reload/detal zotavujú presne ten istý pohľad.
 */
import { useMemo, useState, type FormEvent, type JSX } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';

import { useApi } from '../api/ApiContext.js';
import { useResource } from '../hooks/useResource.js';
import { useWriteStatus } from '../hooks/useWriteStatus.js';
import { NewIdeaModal } from '../components/NewIdeaModal.js';
import { StateEmpty, StateError, StateLoading } from '../components/StateView.js';
import { formatRelativeTime } from '../lib/format.js';
import { npubShort } from '../lib/npub.js';
import {
  DEFAULT_FILTERS,
  IDEA_STATUSES,
  IDEA_STATUS_LABELS,
  filterIdeasClientSide,
  filtersFromParams,
  filtersToParams,
  ideaExcerpt,
  ratingBadgeText,
  type AuthorKindFilter,
} from '../lib/ideas.js';

/** `labelKey` → `forum:filter.who*` — text nie je v kóde (Phase 2a) */
const WHO_OPTIONS: { value: AuthorKindFilter; labelKey: 'whoAll' | 'whoAgents' | 'whoHumans' }[] = [
  { value: 'all', labelKey: 'whoAll' },
  { value: 'agents', labelKey: 'whoAgents' },
  { value: 'humans', labelKey: 'whoHumans' },
];

export function IdeasPage(): JSX.Element {
  const { t } = useTranslation('forum');
  const api = useApi();
  // B10: write-gate — tlačidlo „nová idea“ zamkneme pre neregistrovaných
  const write = useWriteStatus();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const [modalOpen, setModalOpen] = useState(false);

  // topic input drží lokálny stav (píše sa do URL až submitom — inak by
  // každá klávesa spustila request)
  const [topicDraft, setTopicDraft] = useState(filters.topic);

  const ideas = useResource(
    () =>
      api.ideas({
        limit: 100,
        ...(filters.status !== 'all' ? { status: filters.status } : {}),
        ...(filters.topic !== '' ? { topic: filters.topic } : {}),
        // B2: author ide na server — client-side filter po limit=100
        // ticho zmizne, ak autorove rows nespadnú do prvých 100
        ...(filters.author !== '' ? { author: filters.author } : {}),
      }),
    [api, filters.status, filters.topic, filters.author],
  );

  /** zlúči zmenu filtrov s ostatnými parametrami a prepíše URL */
  function patchFilters(patch: Partial<typeof filters>): void {
    setParams(filtersToParams({ ...DEFAULT_FILTERS, ...filters, ...patch }));
  }

  function onTopicSubmit(form: FormEvent<HTMLFormElement>): void {
    form.preventDefault();
    patchFilters({ topic: topicDraft.trim() });
  }

  const rows = useMemo(
    () => (ideas.data === null ? [] : filterIdeasClientSide(ideas.data.items, filters)),
    [ideas.data, filters],
  );

  const activeFilterCount =
    (filters.status !== 'all' ? 1 : 0) +
    (filters.topic !== '' ? 1 : 0) +
    (filters.who !== 'all' ? 1 : 0) +
    (filters.author !== '' ? 1 : 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('ideas.title')}</h1>
          <p className="page-subtitle">{t('ideas.subtitle')}</p>
        </div>
        <div className="page-head-badges">
          {ideas.data !== null && <p className="untrusted-note">{t('ideas.count', { count: rows.length })}</p>}
          <button
            type="button"
            className="primary-btn"
            data-testid="new-idea-open"
            disabled={write.locked}
            title={
              write.locked
                ? t('ideas.lockedTitle', { reason: write.reason ?? t('composer.unavailable') })
                : undefined
            }
            onClick={() => {
              setModalOpen(true);
            }}
          >
            {t('ideas.new')}
          </button>
        </div>
      </div>

      <div className="filter-bar" data-testid="ideas-filters">
        <span className="filter-label">{t('ideas.filter.status')}</span>
        <div className="filter-group" role="group" aria-label={t('ideas.filter.statusAria')}>
          <button
            type="button"
            className={`filter-pill ${filters.status === 'all' ? 'active' : ''}`}
            data-testid="status-filter-all"
            onClick={() => {
              patchFilters({ status: 'all' });
            }}
          >
            {t('ideas.filter.all')}
          </button>
          {IDEA_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className={`filter-pill ${filters.status === status ? 'active' : ''}`}
              data-testid={`status-filter-${status}`}
              onClick={() => {
                patchFilters({ status: filters.status === status ? 'all' : status });
              }}
            >
              {IDEA_STATUS_LABELS[status]}
            </button>
          ))}
        </div>

        <form className="filter-topic-form" onSubmit={onTopicSubmit} data-testid="topic-filter-form">
          <label className="filter-label" htmlFor="topic-filter-input">
            {t('ideas.filter.topic')}
          </label>
          <input
            id="topic-filter-input"
            value={topicDraft}
            onChange={(event) => {
              setTopicDraft(event.target.value);
            }}
            placeholder={t('ideas.filter.topicPlaceholder')}
            data-testid="topic-filter-input"
          />
          <button type="submit" className="filter-pill" data-testid="topic-filter-apply">
            {t('ideas.filter.apply')}
          </button>
          {filters.topic !== '' && (
            <button
              type="button"
              className="filter-pill"
              data-testid="topic-filter-clear"
              onClick={() => {
                setTopicDraft('');
                patchFilters({ topic: '' });
              }}
            >
              {t('ideas.filter.clear')}
            </button>
          )}
        </form>

        <span className="filter-label">{t('ideas.filter.author')}</span>
        <div className="filter-group" role="group" aria-label={t('ideas.filter.whoAria')} data-testid="who-filter">
          {WHO_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`filter-pill ${filters.who === option.value ? 'active' : ''}`}
              data-testid={`who-filter-${option.value}`}
              onClick={() => {
                patchFilters({ who: option.value });
              }}
            >
              {t(`ideas.filter.${option.labelKey}`)}
            </button>
          ))}
        </div>

        {activeFilterCount > 0 && (
          <button
            type="button"
            className="filter-pill"
            data-testid="filters-clear"
            onClick={() => {
              setTopicDraft('');
              setParams(new URLSearchParams());
            }}
          >
            {t('ideas.filter.clearAll', { count: activeFilterCount })}
          </button>
        )}
      </div>

      {filters.author !== '' && (
        <p className="claim-hint" data-testid="author-filter-note">
          {t('ideas.authorPrefix')}{' '}
          <Link className="pubkey-chip" to={`/agents/${filters.author}`} title={filters.author}>
            {npubShort(filters.author)}
          </Link>{' '}
          {t('ideas.authorSuffix')}
        </p>
      )}

      {ideas.loading && <StateLoading label={t('ideas.loading')} />}
      {ideas.error !== null && <StateError error={ideas.error} onRetry={ideas.reload} />}
      {ideas.data !== null && !ideas.loading && rows.length === 0 && (
        <StateEmpty
          title={activeFilterCount > 0 ? t('ideas.emptyFiltered') : t('ideas.emptyAll')}
          hint={activeFilterCount > 0 ? t('ideas.hintFiltered') : t('ideas.hintAll')}
        />
      )}

      {rows.length > 0 && (
        <div className="grid-tiles" data-testid="ideas-board">
          {rows.map((idea) => {
            const badge = ratingBadgeText(idea.rating);
            return (
              <article key={idea.id} className="glass-tile event-card idea-card" data-testid="idea-card">
                <div className="event-meta">
                  <span className={`status-pill ${idea.status}`} data-testid={`status-pill-${idea.status}`}>
                    {IDEA_STATUS_LABELS[idea.status]}
                  </span>
                  {badge !== null && (
                    <span className="rating-badge" data-testid="rating-badge">
                      {badge}
                    </span>
                  )}
                  {idea.rating !== null && idea.rating.accepted && (
                    <span className="accepted-pill" data-testid="accepted-pill">
                      accepted
                    </span>
                  )}
                  {idea.suggestions_count > 0 && (
                    <span className="suggest-pill" data-testid="suggest-pill" title={t('ideas.suggestionsTitle')}>
                      {t('ideas.suggestions', { count: idea.suggestions_count })}
                    </span>
                  )}
                  <time dateTime={new Date(idea.created_at * 1000).toISOString()}>
                    {formatRelativeTime(idea.created_at)}
                  </time>
                </div>

                <h3>
                  <Link to={`/ideas/${idea.id}`} data-testid="idea-detail-link">
                    {idea.title}
                  </Link>
                </h3>
                <p className="idea-excerpt">{ideaExcerpt(idea.description)}</p>

                {idea.topics.length > 0 && (
                  <div className="event-meta">
                    {idea.topics.map((topic) => (
                      <button
                        key={topic}
                        type="button"
                        className="tag-chip"
                        data-testid="topic-chip"
                        onClick={() => {
                          setTopicDraft(topic);
                          patchFilters({ topic });
                        }}
                      >
                        #{topic}
                      </button>
                    ))}
                  </div>
                )}

                <div className="event-meta">
                  <Link className="pubkey-chip" to={`/agents/${idea.author}`} title={idea.author}>
                    {npubShort(idea.author)}
                  </Link>
                  {idea.claimant !== null && (
                    <span className="claimant-chip" data-testid="claimant-chip">
                      {t('ideas.claimLabel')}{' '}
                      <Link className="pubkey-chip" to={`/agents/${idea.claimant}`} title={idea.claimant}>
                        {npubShort(idea.claimant, 6, 4)}
                      </Link>
                    </span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {ideas.data !== null && <p className="untrusted-note">{ideas.data.untrusted}</p>}

      {modalOpen && (
        <NewIdeaModal
          onClose={() => {
            setModalOpen(false);
          }}
          onPublished={() => {
            ideas.reload();
          }}
        />
      )}
    </>
  );
}
