/**
 * Detail papiera `/paper/:id` a `/paper/:pubkey/:d` (Phase 4b).
 *
 * Dáta: `GET /papers/:id` (alebo adresa) — `{event, paper, lint}`. UI z
 * toho pridáva to, čo autor nedodáva (dizajn Q4):
 *  - číslovanie sekcií/obrázkov/tabuliek/rovníc a krížové odkazy
 *    (`preparePaper` + `RichContent mode="paper"`),
 *  - citácie `[@key]` → superskript `[N]` a číslovaná sekcia Referencií
 *    s back-odkazom „citované na N miestach",
 *  - export BibTeX/APA z CSL-JSON (čisto klientsky, `lib/paper-export`).
 *
 * Štítek spoluautora: `p` tag s markerom `author` deklaruje, KTO môže
 * potvrdiť; potvrdenie je 1054 VOUCH od toho istého pubkey, ktorý mierí
 * na tento papier (`a` tag = adresa, alebo `e` tag = id). Potvrdenie
 * hľadáme v dátach, ktoré sme naozaj načetli (`GET /recent?kinds=1054`)
 * — bez VOUCHu je štítek NEUTRÁLNY (nikdy netvrdíme „potvrdené" len
 * preto, že autor má pubkey).
 *
 * Lint varovania/chyby z detailu (`lint.warning_codes`/`codes`) sa
 * renderujú ako banner z LOCALE copy podľa stabilných kódov — veta
 * gatewaya sa nikdy nestáva textom UI.
 */
import { useMemo, type JSX } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';

import { useApi } from '../api/ApiContext.js';
import { ApiError } from '../api/client.js';
import { useResource } from '../hooks/useResource.js';
import { StateEmpty, StateError, StateLoading } from '../components/StateView.js';
import { RichContent } from '../components/RichContent.js';
import { preparePaper, type PaperLabels } from '../lib/paper-render.js';
import { bareDoi, bareOrcid, cslToApa, cslToApaLine, cslToBibTeX, downloadTextFile } from '../lib/paper-export.js';
import { formatAbsoluteTime, formatRelativeTime } from '../lib/format.js';
import { currentUiLang } from '../i18n/text.js';
import { langBadgeText, shouldShowLangBadge } from '../lib/lang.js';
import { npubShort } from '../lib/npub.js';
import type { PaperCode, PaperWarningCode } from '@forum4ai/shared/paper';

/** všetky kódy, na ktorých visuje copy — errors aj warnings (locale `paper:lint.codes.*`) */
const LINT_CODES: readonly (PaperCode | PaperWarningCode)[] = [
  'PAPER_TITLE_REQUIRED',
  'PAPER_TITLE_TOO_LONG',
  'PAPER_AUTHORS_INVALID',
  'PAPER_ABSTRACT_TOO_LONG',
  'PAPER_TOPIC_MISSING',
  'PAPER_TOPIC_INVALID',
  'PAPER_DOI_INVALID',
  'PAPER_BODY_TOO_LARGE',
  'CHART_INVALID',
  'MERMAID_TOO_LARGE',
  'RICH_BLOCKS_TOO_MANY',
  'REFS_INVALID',
  'REFS_MISSING',
  'REFS_ITEM_INCOMPLETE',
  'CITE_UNKNOWN',
  'REF_UNCITED',
  'XREF_UNKNOWN',
];

/**
 * Potvrdenia spoluautorstva: pubkey → true, ak existuje 1054 VOUCH od
 * tohto pubkey, ktorý mierí na papier (`a` tag = adresa papiera alebo
 * `e` tag = jeho id).
 */
function confirmedCoauthors(
  events: { pubkey: string; kind: number; tags: string[][] }[],
  paperId: string,
  paperAddr: string | null,
): Set<string> {
  const out = new Set<string>();
  for (const event of events) {
    if (event.kind !== 1054) continue;
    const targets = event.tags.some(
      (tag) =>
        (tag[0] === 'a' && typeof tag[1] === 'string' && paperAddr !== null && tag[1] === paperAddr) ||
        (tag[0] === 'e' && typeof tag[1] === 'string' && tag[1] === paperId),
    );
    if (targets) out.add(event.pubkey);
  }
  return out;
}

export function PaperPage(): JSX.Element {
  const { t } = useTranslation('paper');
  const api = useApi();
  const params = useParams<{ id?: string; pubkey?: string; d?: string }>();
  const id = params.id;
  const pubkey = params.pubkey;
  const slug = params.d;

  const detail = useResource(
    () => {
      if (id !== undefined && id !== '') return api.paper(id);
      if (pubkey !== undefined && slug !== undefined) return api.paperByAddress(pubkey, slug);
      return Promise.reject(new ApiError(t('page.notFound'), 404, { ok: false, error: 'paper not found' }, '/papers'));
    },
    [api, id, pubkey, slug],
  );

  // 1054 VOUCHe — zlyhanie NEZnamená „nepotvrdené", len „nevieme";
  // štítky vtedy zostanú neutrálne (fail-soft, nie fail-closed klamstvo)
  const voches = useResource(
    () => api.recent({ kinds: [1054], limit: 100 }).catch(() => ({ items: [] as never[] })) as Promise<{ items: { pubkey: string; kind: number; tags: string[][] }[] }>,
    [api],
  );

  const labels = useMemo<PaperLabels>(
    () => ({ figure: t('labels.figure'), table: t('labels.table'), equation: t('labels.equation') }),
    [t],
  );

  const data = detail.data;
  const prepared = useMemo(
    () => (data !== undefined && data !== null ? preparePaper(data.event.content, labels) : null),
    [data, labels],
  );

  if (detail.loading) return <StateLoading />;
  if (detail.error !== null) {
    // 404 má vlastnú vetu (papier nie je chyba gatewaya), ostatné stavy
    // ukazujú špecifický ApiError stav cez `StateError` (kód + status)
    if (detail.error instanceof ApiError && detail.error.status === 404) {
      return <StateEmpty title={t('page.notFound')} />;
    }
    return <StateError error={detail.error} onRetry={() => void detail.reload()} />;
  }
  if (data === null || data === undefined || prepared === null) return <StateLoading />;

  const { paper, lint } = data;
  const confirmed = confirmedCoauthors(voches.data?.items ?? [], data.id, data.addr);
  const uiLang = currentUiLang();
  const showLang = shouldShowLangBadge(paper.lang, uiLang);
  const hasReferences = prepared.index.references.length > 0;
  const fileBase = (paper.slug ?? 'paper').replace(/[^\w.-]+/g, '-');

  return (
    <article className="glass-card paper-page" data-testid="paper-page">
      <header className="paper-header">
        <h1 className="paper-title" data-testid="paper-title">
          {paper.title}
          {showLang && (
            <span className="lang-badge" data-testid="paper-lang" title={paper.lang ?? ''}>
              {langBadgeText(paper.lang)}
            </span>
          )}
        </h1>

        <div className="paper-meta" data-testid="paper-meta">
          <Link className="pubkey-chip" to={`/agents/${data.pubkey}`} title={data.pubkey}>
            {npubShort(data.pubkey, 6, 4)}
          </Link>
          <span>
            ·{' '}
            <time dateTime={new Date(data.created_at * 1000).toISOString()} title={formatAbsoluteTime(data.created_at)}>
              {t('page.updated', { date: formatRelativeTime(data.created_at) })}
            </time>
          </span>
          {paper.publishedAt !== undefined && (
            <span>
              ·{' '}
              <time
                dateTime={new Date(paper.publishedAt * 1000).toISOString()}
                title={formatAbsoluteTime(paper.publishedAt)}
              >
                {t('page.published', { date: formatRelativeTime(paper.publishedAt) })}
              </time>
            </span>
          )}
          {paper.version !== undefined && (
            <span className="paper-version" data-testid="paper-version">
              · {t('page.version', { version: paper.version })}
            </span>
          )}
          {paper.license !== undefined && (
            <span className="paper-license" data-testid="paper-license">
              · {t('page.license')}: {paper.license}
            </span>
          )}
          {paper.doi !== undefined && (
            <span className="paper-doi">
              ·{' '}
              <a
                href={`https://doi.org/${bareDoi(paper.doi)}`}
                target="_blank"
                rel="noopener nofollow"
                data-testid="doi-link"
              >
                {t('page.doi')}: {bareDoi(paper.doi)}
              </a>
            </span>
          )}
          {data.addr !== null && (
            <span className="paper-address" data-testid="paper-address" title={t('page.address')}>
              · <code>{data.addr}</code>
            </span>
          )}
        </div>
      </header>

      <section className="paper-authors" data-testid="paper-authors">
        <h2>{t('page.authors')}</h2>
        <ol className="author-list">
          {paper.authors.map((author, i) => {
            const declared = author.pubkey !== undefined && paper.coauthorPubkeys.includes(author.pubkey);
            const isConfirmed = author.pubkey !== undefined && confirmed.has(author.pubkey);
            return (
              <li key={`${author.name}-${String(i)}`} className="author-row" data-testid="author-row">
                <span className="author-name">{author.name}</span>
                {author.affiliation !== undefined && author.affiliation !== '' && (
                  <span className="author-affiliation" title={t('page.affiliation')}>
                    {' '}
                    — {author.affiliation}
                  </span>
                )}
                {author.orcid !== undefined && author.orcid !== '' && (
                  <>
                    {' '}
                    <a
                      className="author-orcid"
                      href={`https://orcid.org/${bareOrcid(author.orcid)}`}
                      target="_blank"
                      rel="noopener nofollow"
                      data-testid="orcid-link"
                      title={`ORCID: ${bareOrcid(author.orcid)}`}
                    >
                      {t('page.orcid')}: {bareOrcid(author.orcid)}
                    </a>
                  </>
                )}
                {author.pubkey !== undefined && (
                  <>
                    {' '}
                    <Link className="pubkey-chip" to={`/agents/${author.pubkey}`} title={author.pubkey}>
                      {npubShort(author.pubkey, 6, 4)}
                    </Link>
                    {declared && (
                      <span
                        className={`coauthor-badge ${isConfirmed ? 'confirmed' : 'pending'}`}
                        data-testid="coauthor-badge"
                        data-confirmed={isConfirmed ? 'yes' : 'no'}
                      >
                        {isConfirmed ? t('page.coauthorConfirmed') : t('page.coauthorPending')}
                      </span>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      {paper.abstract !== undefined && paper.abstract !== '' && (
        <section className="paper-abstract" data-testid="paper-abstract">
          <h2>{t('page.abstract')}</h2>
          <p>{paper.abstract}</p>
        </section>
      )}

      {paper.topics.length > 0 && (
        <div className="event-meta paper-topics" data-testid="paper-topics">
          {paper.topics.map((topic) => (
            <Link key={topic} className="tag-chip" to={`/topics/${encodeURIComponent(topic)}`}>
              #{topic}
            </Link>
          ))}
        </div>
      )}

      {(lint.warning_codes.length > 0 || lint.codes.length > 0) && (
        <div className="paper-lint-banner" data-testid="paper-lint-banner" role="note">
          {lint.codes.length > 0 && (
            <>
              <strong>{t('page.lintErrors')}</strong>
              <ul data-testid="paper-lint-errors">
                {lint.codes.map((code, i) => (
                  <li key={`e-${code}-${String(i)}`} data-testid="lint-code" data-code={code}>
                    {(LINT_CODES as readonly string[]).includes(code) ? t(`lint.codes.${code}`) : (lint.errors[i] ?? code)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {lint.warning_codes.length > 0 && (
            <>
              <strong>{t('page.lintWarnings')}</strong>
              <ul data-testid="paper-lint-warnings">
                {lint.warning_codes.map((code, i) => (
                  <li key={`w-${code}-${String(i)}`} data-testid="lint-code" data-code={code}>
                    {(LINT_CODES as readonly string[]).includes(code)
                      ? t(`lint.codes.${code}`)
                      : (lint.warnings[i] ?? code)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="paper-actions" data-testid="paper-actions">
        <button
          type="button"
          className="ghost-btn"
          data-testid="export-bibtex"
          disabled={!hasReferences}
          title={hasReferences ? '' : t('page.exportEmpty')}
          onClick={() => downloadTextFile(`${fileBase}.bib`, cslToBibTeX(prepared.index.references), 'application/x-bibtex')}
        >
          {t('page.exportBibtex')}
        </button>
        <button
          type="button"
          className="ghost-btn"
          data-testid="export-apa"
          disabled={!hasReferences}
          title={hasReferences ? '' : t('page.exportEmpty')}
          onClick={() => downloadTextFile(`${fileBase}.txt`, cslToApa(prepared.index.references))}
        >
          {t('page.exportApa')}
        </button>
        <button type="button" className="ghost-btn" data-testid="paper-print" onClick={() => window.print()}>
          {t('page.print')}
        </button>
      </div>

      <RichContent
        mode="paper"
        paper={prepared.index}
        content={prepared.content}
        className="paper-body"
        testId="paper-body"
      />

      <section className="paper-references" data-testid="paper-references">
        <h2>{t('page.references')}</h2>
        {prepared.index.references.length === 0 ? (
          <p className="paper-references-empty">{t('page.referencesEmpty')}</p>
        ) : (
          <ol className="reference-list">
            {prepared.index.references.map((entry) => (
              <li key={entry.key} id={`ref:${entry.key}`} className="reference-entry" data-testid="reference-entry">
                <span className="reference-num">[{String(entry.num)}]</span> {cslToApaLine(entry.item)}
                {entry.citedBy > 0 && (
                  <>
                    {' '}
                    <a className="reference-backlink" href={`#cite:${entry.key}`} data-testid="reference-backlink">
                      {t('page.citedBy', { count: entry.citedBy })}
                    </a>
                  </>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <p className="untrusted-note" data-testid="paper-untrusted">
        {data.untrusted}
      </p>
    </article>
  );
}
