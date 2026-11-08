/**
 * Board papiera `/papers` (Phase 4b) — `GET /papers` so filtrami.
 *
 * Vzor filtra preberá zo `SearchPage`/`IdeasPage`: parametre žijú v URL
 * (`?topic=&lang=&q=`), takže zdieľaný link je reprodukovateľný.
 *  - `topic` — server-side (presný `t` tag),
 *  - `q` — server-side (title + abstract),
 *  - `lang` — `all` | `ui` | `other` | kód; `ui`/kód ide serveru,
 *    `other` sa triedi lokálne (`isOtherThan`), lebo gateway pozná len
 *    presný `?lang=` (rovnaká dohoda ako pri vláknoch).
 *
 * Karty odkazujú na `/paper/:id`. Stav prázdna nie je chyba: index môže
 * byť bez papierov (dev seed ich má málo) — prázdny board je platný.
 */
import { useMemo, useState, type FormEvent, type JSX } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';

import { useApi } from '../api/ApiContext.js';
import { useResource } from '../hooks/useResource.js';
import { StateEmpty, StateError, StateLoading } from '../components/StateView.js';
import { formatRelativeTime } from '../lib/format.js';
import { currentUiLang } from '../i18n/text.js';
import { isOtherThan, langBadgeText, langFilterParam, shouldShowLangBadge, type LangFilter } from '../lib/lang.js';
import { npubShort } from '../lib/npub.js';
import type { PaperRow } from '../api/types.js';

/** veľkosť teľa v kB (smerom nahor, min 1) — `body_bytes` je UTF-8 bajtov */
function bodyKb(bytes: number): string {
  return String(Math.max(1, Math.ceil(bytes / 1024)));
}

/** autori: mená, max 3 + "a ďalší" */
function authorLine(row: PaperRow, max = 3): string {
  const names = row.authors.map((author) => author.name).filter((name) => name !== '');
  if (names.length === 0) return npubShort(row.pubkey, 6, 4);
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${String(names.length - max)}`;
}

export function PaperBoardPage(): JSX.Element {
  const { t } = useTranslation('paper');
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const uiLang = currentUiLang();

  const topic = params.get('topic') ?? '';
  const q = params.get('q') ?? '';
  const langFilter = (params.get('lang') ?? 'all') as LangFilter | 'all';

  // drafty inputov — filter sa posielá až submitom (rovnaké ako IdeasPage,
  // inak by každá klávesa reloadla board)
  const [topicDraft, setTopicDraft] = useState(topic);
  const [qDraft, setQDraft] = useState(q);

  const response = useResource(
    () =>
      api.papers({
        limit: 50,
        ...(topic !== '' ? { topic } : {}),
        ...(q !== '' ? { q } : {}),
        ...(langFilterParam(langFilter, uiLang) !== undefined ? { lang: langFilterParam(langFilter, uiLang) } : {}),
      }),
    [api, topic, q, langFilter, uiLang],
  );

  const items = useMemo(() => {
    const rows = response.data?.items ?? [];
    return langFilter === 'other' ? rows.filter((row) => isOtherThan(row, uiLang)) : rows;
  }, [response.data, langFilter, uiLang]);

  // jazyky, ktoré v aktuálnych výsledkoch skutočne sú — select môže ponúknuť
  // aj kódy, ktoré by inak používáč nenašiel (2b2 vzor zo SearchPage)
  const seenLangs = useMemo(() => {
    const set = new Set<string>();
    for (const row of response.data?.items ?? []) {
      if (typeof row.lang === 'string' && row.lang !== '') set.add(row.lang);
    }
    return [...set].sort();
  }, [response.data]);

  const applyFilters = (event: FormEvent): void => {
    event.preventDefault();
    const next = new URLSearchParams();
    if (topicDraft.trim() !== '') next.set('topic', topicDraft.trim());
    if (qDraft.trim() !== '') next.set('q', qDraft.trim());
    if (langFilter !== 'all') next.set('lang', langFilter);
    setParams(next);
  };

  const setLang = (value: string): void => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete('lang');
    else next.set('lang', value);
    setParams(next);
  };

  const hasFilters = topic !== '' || q !== '' || langFilter !== 'all';

  return (
    <section className="paper-board" data-testid="paper-board">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('board.title')}</h1>
          <p className="page-subtitle">{t('board.subtitle')}</p>
        </div>
        <Link className="primary-btn" to="/write-paper" data-testid="new-paper-link">
          {t('board.new')}
        </Link>
      </div>

      <form className="filter-bar paper-filter-bar" onSubmit={applyFilters} data-testid="paper-filters">
        <input
          type="text"
          value={qDraft}
          onChange={(event) => setQDraft(event.target.value)}
          placeholder={t('board.filterQuery')}
          aria-label={t('board.filterQuery')}
          data-testid="paper-filter-q"
        />
        <input
          type="text"
          value={topicDraft}
          onChange={(event) => setTopicDraft(event.target.value)}
          placeholder={t('board.filterTopic')}
          aria-label={t('board.filterTopic')}
          data-testid="paper-filter-topic"
        />
        <select
          value={langFilter}
          onChange={(event) => setLang(event.target.value)}
          aria-label={t('board.langAll')}
          data-testid="paper-filter-lang"
        >
          <option value="all">{t('board.langAll')}</option>
          <option value="ui">{t('board.langUi')}</option>
          <option value="other">{t('board.langOther')}</option>
          {seenLangs
            .filter((code) => code !== langFilterParam('ui', uiLang))
            .map((code) => (
              <option key={code} value={code}>
                {langBadgeText(code)}
              </option>
            ))}
        </select>
        <button type="submit" className="filter-pill" data-testid="paper-filter-submit">
          {t('board.filterTopic')}
        </button>
        {hasFilters && (
          <button
            type="button"
            className="filter-pill"
            data-testid="paper-filter-clear"
            onClick={() => {
              setTopicDraft('');
              setQDraft('');
              setParams(new URLSearchParams());
            }}
          >
            {t('board.clear')}
          </button>
        )}
      </form>

      {response.loading && <StateLoading />}
      {!response.loading && response.error !== null && (
        <StateError error={response.error} onRetry={() => void response.reload()} />
      )}
      {!response.loading && response.error === null && items.length === 0 && (
        <StateEmpty title={t('board.empty')} />
      )}

      {!response.loading && items.length > 0 && (
        <>
          <p className="untrusted-note" data-testid="paper-count">
            {t('board.count', { count: items.length })}
          </p>
          <div className="paper-list">
            {items.map((row) => (
              <article key={row.id} className="glass-card paper-card" data-testid="paper-card">
                <h3>
                  <Link to={`/paper/${row.id}`} data-testid="paper-card-link">
                    {row.title}
                  </Link>
                  {shouldShowLangBadge(row.lang, uiLang) && (
                    <span className="lang-badge" title={row.lang ?? ''}>
                      {langBadgeText(row.lang)}
                    </span>
                  )}
                </h3>
                <p className="paper-card-authors" data-testid="paper-card-authors">
                  {t('board.authors', { authors: authorLine(row) })}
                </p>
                {row.abstract !== undefined && row.abstract !== '' && (
                  <p className="paper-card-abstract">{row.abstract}</p>
                )}
                <div className="event-meta">
                  {row.topics.map((tag) => (
                    <span key={tag} className="tag-chip">
                      #{tag}
                    </span>
                  ))}
                  <span
                    className="paper-card-size"
                    data-testid="paper-card-size"
                    title={t('board.bodySize', { size: bodyKb(row.body_bytes) })}
                  >
                    {t('board.bodySize', { size: bodyKb(row.body_bytes) })}
                  </span>
                  <time
                    className="paper-card-date"
                    data-testid="paper-card-date"
                    dateTime={new Date(row.created_at * 1000).toISOString()}
                    title={formatRelativeTime(row.created_at)}
                  >
                    {formatRelativeTime(row.created_at)}
                  </time>
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {response.data !== null && (
        <p className="untrusted-note" data-testid="paper-untrusted">
          {response.data.untrusted}
        </p>
      )}
    </section>
  );
}
