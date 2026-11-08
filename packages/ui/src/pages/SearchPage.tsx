/**
 * Vyhľadávanie `/search?q=` (S11, F4AI-17) — `GET /search` nad FTS5
 * indexom. UI len prepíše dotaz z URL (header search box sem naviguje),
 * plné napojenie na hybridné vyhľadávanie je S12/S13.
 *
 * F4AI-2b2: filter jazyka (`?lang=`). Tři stavy, ktoré REST skutočne
 * pozná: bez parametra = všetky jazyky, `lang=<kod>` = len daný jazyk.
 * Položka "iné jazyky" negáciu nad REST nemá (gateway nevie `lang!=sk`),
 * preto necháva server vrátiť všetko a jazyk rozhrania vylúči v
 * prehliadači — poznačené, aby si to nikdo nemýlil s serverovým filtrom.
 */
import { type JSX } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';

import { useApi } from '../api/ApiContext.js';
import { useResource } from '../hooks/useResource.js';
import { splitFtsSnippet } from '../lib/fts-snippet.js';
import { StateEmpty, StateError, StateLoading } from '../components/StateView.js';
import { formatRelativeTime, kindClassName, kindLabel } from '../lib/format.js';
import {
  isOtherThan,
  langBadgeText,
  langFilterParam,
  normalizeLangCode,
  shouldShowLangBadge,
} from '../lib/lang.js';
import {
  isRemoteOrigin,
  isUntrustedOrigin,
  originFilterOptions,
  originFilterParam,
  originShortLabel,
  readOriginParam,
} from '../lib/federation.js';
import { npubShort } from '../lib/npub.js';

export function SearchPage(): JSX.Element {
  const { t, i18n } = useTranslation('forum');
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  // F4AI-19: `?author=<64hex>` — gateway `/search` má `authors=` filter
  // (overené curlom), link z `/agents/:pubkey` ho predpĺňa; `q` je na
  // gateway povinný, takže bez dotazu sa len drží author-scope v URL.
  const rawAuthor = (params.get('author') ?? '').trim().toLowerCase();
  const author = /^[0-9a-f]{64}$/.test(rawAuthor) ? rawAuthor : '';
  // F4AI-2b2: `?lang=` — `all` (bez parametra), `ui`, `other` alebo kód
  const rawLang = (params.get('lang') ?? '').trim().toLowerCase();
  const langFilter = rawLang === '' || rawLang === 'all' ? 'all' : rawLang;
  const uiLang = i18n.resolvedLanguage ?? i18n.language;
  const langParam = langFilterParam(langFilter, uiLang);
  // Phase 6b (dizajn Q5): `?origin=` — `all` (parameter sa neposiel), `self`
  // (len domáce stromy) alebo PRESNÉ id upstreamu. Posieme len id, ktoré
  // sme našli vo výsledkoch, lebo gateway odpovie 400 `invalid origin` na
  // id, ktoré nepozná ani z configu, ani z indexu.
  const originFilter = readOriginParam(params.get('origin'));
  const originParam = originFilterParam(originFilter);
  const api = useApi();
  const results = useResource(
    () =>
      query === ''
        ? Promise.resolve(null)
        : api.search({
            q: query,
            limit: 20,
            ...(author !== '' ? { authors: [author] } : {}),
            ...(langParam !== undefined ? { lang: langParam } : {}),
            ...(originParam !== undefined ? { origin: originParam } : {}),
          }),
    [api, query, author, langParam, originParam],
  );

  const setLangFilter = (value: string): void => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete('lang');
    else next.set('lang', value);
    setParams(next, { replace: true });
  };

  const setOriginFilter = (value: string): void => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete('origin');
    else next.set('origin', value);
    setParams(next, { replace: true });
  };

  const data = results.data;
  // filter `other` = lokálne vylúčenie jazyka rozhrania (server negáciu
  // nepozná); inak posielame to, čo vrátil gateway
  const hits =
    data === null || data === undefined
      ? []
      : langFilter === 'other'
        ? data.results.filter((hit) => isOtherThan(hit, uiLang))
        : data.results;
  // dropdown drží jazyky, ktoré sú v výsledkoch — inak by sme používateľa
  // nútili hádať kódy. Vybraný kód sa ponechá aj keď už v výsledkoch nie je.
  const seenLangs = new Set<string>();
  for (const hit of data?.results ?? []) {
    if (typeof hit.lang === 'string' && hit.lang !== '') seenLangs.add(hit.lang);
  }
  const currentLangCode = normalizeLangCode(langFilter);
  if (currentLangCode !== null) seenLangs.add(currentLangCode);
  const langOptions = [...seenLangs].sort();
  // Phase 6b: inštancie, ktoré v výsledkoch SKUTOČNE sú — filter sa nedá
  // vymyslieť, musí prísť z dát. Vybrané id nechávame v zozname aj keď ho
  // výsledky neobsahujú (rovnaké pravidlo ako `seenLangs` vyššie).
  const originOptions = originFilterOptions(data?.results, originFilter);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('search.title')}</h1>
          <p className="page-subtitle">
            {query === ''
              ? t('search.noQuery')
              : t('search.queryNote', { query, ms: String(data?.took_ms ?? 0) })}
          </p>
        </div>
        {data !== null && <p className="untrusted-note">{t('search.results', { count: data.count })}</p>}
      </div>

      {query !== '' && (
        <p className="claim-hint" data-testid="search-lang-filter">
          <label htmlFor="search-lang" className="pubkey-chip">
            {t('common:lang.filterLabel')}
          </label>{' '}
          <select
            id="search-lang"
            data-testid="search-lang-select"
            value={langFilter}
            onChange={(event) => setLangFilter(event.target.value)}
          >
            <option value="all">{t('common:lang.filterAll')}</option>
            <option value="ui">{t('common:lang.filterUiOnly', { code: (uiLang ?? 'en').toUpperCase() })}</option>
            <option value="other">{t('common:lang.filterOther')}</option>
            {langOptions.map((code) => (
              <option key={code} value={code}>
                {code.toUpperCase()}
              </option>
            ))}
          </select>
        </p>
      )}
      {query !== '' && langFilter === 'other' && (
        <p className="notice" data-testid="search-lang-note">
          {t('common:lang.filterNote', { code: (uiLang ?? 'en').toUpperCase() })}
        </p>
      )}

      {/*
        Phase 6b (dizajn Q5): filter pôvodu obsahu vedľa jazykového filtru.
        Rovnaké ovládanie ako `search-lang-select`, lebo rovnaký význam:
        vyberám hodnotu, ktorú index v výsledkoch naozaj má.
      */}
      {query !== '' && (
        <p className="claim-hint" data-testid="search-origin-filter">
          <label htmlFor="search-origin" className="pubkey-chip">
            {t('search.originFilter')}
          </label>{' '}
          <select
            id="search-origin"
            data-testid="search-origin-select"
            value={originFilter}
            onChange={(event) => setOriginFilter(event.target.value)}
          >
            <option value="all">{t('search.originAll')}</option>
            <option value="self">{t('search.originSelf')}</option>
            {originOptions.map((id) => (
              <option key={id} value={id} title={id}>
                {originShortLabel(id)}
              </option>
            ))}
          </select>
        </p>
      )}
      {query !== '' && originParam !== undefined && originParam !== 'self' && (
        <p className="notice" data-testid="search-origin-note">
          {t('search.originNote', { id: originParam })}
        </p>
      )}

      {query === '' && (
        <StateEmpty
          title={t('search.emptyTitle')}
          hint={author !== '' ? t('search.emptyHintAuthor') : t('search.emptyHintQuery')}
        />
      )}
      {author !== '' && (
        <p className="claim-hint" data-testid="search-author-note">
          {t('search.authorFilter')}{' '}
          <Link className="pubkey-chip" to={`/agents/${author}`} title={author}>
            {author.slice(0, 12)}…
          </Link>
        </p>
      )}
      {query !== '' && results.loading && <StateLoading label={t('search.loading')} />}
      {query !== '' && results.error !== null && <StateError error={results.error} onRetry={results.reload} />}
      {query !== '' && data !== null && hits.length === 0 && (
        <StateEmpty title={t('search.noneTitle')} hint={t('search.noneHint')} />
      )}

      {query !== '' && hits.length > 0 && (
        <div className="stack" data-testid="search-results">
          {hits.map((hit) => (
            <article key={hit.id} className="glass-card event-card" data-testid="search-result">
              <div className="event-meta">
                <span className={`kind-badge ${kindClassName(hit.kind)}`}>{kindLabel(hit.kind)}</span>
                {hit.lang !== undefined && shouldShowLangBadge(hit.lang, uiLang) && (
                  // `hit.lang === undefined` = gateway pole nevrátil (index
                  // pred 2b2) → ŽIADNY štítok: "nevieme" nie je "neoznačené".
                  // `null` = event bol oznámený bez labelu → UND.
                  <span
                    className="lang-badge"
                    data-testid="lang-badge"
                    title={
                      hit.lang === null || hit.lang === undefined
                        ? t('common:lang.badgeUndetermined')
                        : t('common:lang.badge', { code: hit.lang })
                    }
                  >
                    {langBadgeText(hit.lang)}
                  </span>
                )}
                {isRemoteOrigin(hit.origin) && (
                  // Absencia poľa `origin` = gateway pred 6a → ŽIADNY stipok.
                  // `origin: 'self'` = domáci obsah → tiež žiadny (domáce je
                  // predvolený stav, stipok by len šumel — rovnaká logika
                  // ako pri jazykovom štítku).
                  <span
                    className={`origin-chip kind-badge ${isUntrustedOrigin(hit.trusted) ? 'warn' : 'info'}`}
                    data-testid="origin-chip"
                    title={
                      isUntrustedOrigin(hit.trusted)
                        ? t('search.originChipUntrusted', { id: hit.origin ?? '' })
                        : t('search.originChip', { id: hit.origin ?? '' })
                    }
                  >
                    ⇄ {originShortLabel(hit.origin)}
                  </span>
                )}
                <time dateTime={new Date(hit.created_at * 1000).toISOString()}>
                  {formatRelativeTime(hit.created_at)}
                </time>
                <Link className="pubkey-chip" to={`/agents/${hit.pubkey}`} title={hit.pubkey}>
                  {npubShort(hit.pubkey)}
                </Link>
                <span>score {hit.score.toFixed(2)}</span>
              </div>
              <h3>
                {/* F4AI-42: the heading is the event's title. Before it, a hit
                    carried no title at all and every result was headed by its
                    NIP-01 address or a slice of its id. The fallbacks stay for
                    an event with no title and for a gateway that does not send
                    the field yet. */}
                <Link to={`/threads/${hit.id}`}>{hit.title ?? hit.addr ?? hit.id.slice(0, 16)}</Link>
              </h3>
              <p className="event-body">
                {splitFtsSnippet(hit.snippet).map((seg, i) =>
                  seg.hit ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
                )}
              </p>
            </article>
          ))}
        </div>
      )}

      {data !== null && data.partial && (
        <p className="notice">{t('search.partial', { note: data.note ?? t('search.partialFallback') })}</p>
      )}
      {data !== null && <p className="untrusted-note">{data.untrusted}</p>}
    </>
  );
}
