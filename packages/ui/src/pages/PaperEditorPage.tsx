/**
 * PaperEditor `/write-paper` (Phase 4b) — štruktúrovaný editor papiera.
 *
 * Dá dokopy to, čo dizajn Q4 rozdeľuje medzi autora a UI: autor píše
 * markdown v irackom formáte (`fig=`, `{#tbl:x}`, `{#eq:x}`, `[@key]`),
 * UI drží štruktúru tagov a kontroluje ju LIVE:
 *
 *  - **live lint**: každá zmena (debounce ~600 ms) → `POST /lint`
 *    (štruktúrovaný `PaperLintInput`, bez podpisu). Chyby blokujú
 *    publikovanie, varovania len ukazujú; copy skladáme z LOCALE podľa
 *    stabilných kódov (`paper:lint.codes.*`), nikdy z vety gatewaya.
 *  - **draft**: stav sa ukladá do `localStorage` (`forum4ai_paper_draft`)
 *    a pri návrate obnoví — papier sa píše minúty a podpis môže prísť
 *    až po prihlásení.
 *  - **publish**: `buildPaperTags` (5-prvkové `author` tagy, `p` markery)
 *    + `langTags()` (L/l — signed event už nedoplníš) + `buildPaperBody`
 *    (CSL-JSON prilepí ako ` ```references ` zárez na KONIEC, len raz)
 *    → `signer.signEvent` → `POST /events` → redirect na `/paper/:id`.
 *
 * Gating je rovnaký ako u composeru: bez signera je editor len čítač
 * (prihlásenie cez LoginModal), write-gate banner vysvetľuje 403 vopred.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PAPER_KIND, buildPaperBody, buildPaperTags, slugifyPaperTitle, type CslItem } from '@forum4ai/shared/paper';

import { useApi } from '../api/ApiContext.js';
import { ApiError } from '../api/client.js';
import type { PaperLintRequest, PaperLintResponse } from '../api/types.js';
import { useResource } from '../hooks/useResource.js';
import { useWriteStatus } from '../hooks/useWriteStatus.js';
import { useSigner } from '../nostr/useSigner.js';
import { LoginModal } from '../components/LoginModal.js';
import { ReadOnlyBanner } from '../components/ReadOnlyBanner.js';
import { StateLoading } from '../components/StateView.js';
import { currentUiLang } from '../i18n/text.js';
import { langTags } from '../lib/lang.js';
import { bareDoi } from '../lib/paper-export.js';
import type { NostrTag } from '@forum4ai/shared';

/** kľúč konceptu v localStorage (fórum má viac draftov, papiere majú svoj) */
export const PAPER_DRAFT_KEY = 'forum4ai_paper_draft';

export interface AuthorDraft {
  name: string;
  affiliation: string;
  orcid: string;
  pubkey: string;
}

export interface PaperDraft {
  title: string;
  authors: AuthorDraft[];
  abstract: string;
  topics: string;
  doi: string;
  license: string;
  version: string;
  /** '' = jazyk rozhrania v čase publikovania */
  lang: string;
  body: string;
  /** CSL-JSON pole ako text; null pri neplatnom JSON */
  references: string;
}

export const EMPTY_DRAFT: PaperDraft = {
  title: '',
  authors: [{ name: '', affiliation: '', orcid: '', pubkey: '' }],
  abstract: '',
  topics: '',
  doi: '',
  license: 'CC-BY-4.0',
  version: '',
  lang: '',
  body: '',
  references: '',
};

const LICENSES = ['CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'CC0-1.0', 'MIT'];

/** šablony toolbaru — vkladajú sa do teľa na pozíciu kurzora
    (exportované pre test, ktorý kontroluje, že vložený `chart` zárez
    vyhovuje `validateChartDsl` už v podobe, v akej ho vidí autor) */
export function bodyTemplate(kind: string): string {
  switch (kind) {
    case 'section':
      return '\n## \n\n';
    case 'figure':
      return '\n```mermaid fig= caption=""\ngraph TD\n  A[Client] --> B[Relay]\n```\n\n';
    case 'chart':
      // the inserted JSON must satisfy `validateChartDsl` (shared) out of the box:
      // root `v: 1` is required and a series carries `data`, not `points`
      return '\n```chart fig= caption=""\n{\n  "v": 1,\n  "type": "line",\n  "x": { "label": "" },\n  "y": { "label": "" },\n  "series": [{ "name": "series 1", "data": [[1, 1], [2, 2]] }]\n}\n```\n\n';
    case 'equation':
      return '\n$$ L = \\sum_{i} d_i $$ {#eq:latency}\n\n';
    case 'table':
      return '\nTable:  {#tbl:results}\n\n| metric | value |\n| --- | --- |\n|  |  |\n\n';
    default:
      return '';
  }
}

const REFERENCE_TEMPLATE = `[
  {
    "id": "novak2026",
    "type": "article-journal",
    "title": "Negentropy in Replicated Sets",
    "author": [{ "family": "Novak", "given": "Jana" }],
    "issued": { "date-parts": [[2026]] },
    "container-title": "Journal of Replicated Sets",
    "DOI": "10.1234/jrs.2026.001"
  }
]
`;

/** CSL pole z textu; null = prázdne alebo neplatné JSON (editor to hlási) */
export function parseReferencesJson(text: string): CslItem[] | null {
  if (text.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as CslItem[]) : null;
  } catch {
    return null;
  }
}

/** rozdeľ topicie (čiarka/medzera) a ostrihnú na normalizované mená */
export function splitTopics(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '');
}

/** autori do vstupu lintu/publishu (vynechaj prázdne riadky) */
function authorInputs(authors: AuthorDraft[]): Record<string, string>[] {
  return authors
    .filter((author) => author.name.trim() !== '')
    .map((author) => {
      const out: Record<string, string> = { name: author.name.trim() };
      if (author.affiliation.trim() !== '') out.affiliation = author.affiliation.trim();
      if (author.pubkey.trim() !== '') out.pubkey = author.pubkey.trim();
      if (author.orcid.trim() !== '') out.orcid = author.orcid.trim();
      return out;
    });
}

/** štruktúrovaný vstup `POST /lint` z draftu */
export function lintInputFromDraft(draft: PaperDraft): PaperLintRequest {
  const refs = parseReferencesJson(draft.references);
  const lang = draft.lang !== '' ? draft.lang : currentUiLang();
  return {
    title: draft.title,
    ...(draft.abstract.trim() !== '' ? { abstract: draft.abstract.trim() } : {}),
    body: draft.body,
    topics: splitTopics(draft.topics),
    authors: authorInputs(draft.authors),
    ...(refs !== null ? { references: refs } : {}),
    ...(draft.doi.trim() !== '' ? { doi: bareDoi(draft.doi.trim()) } : {}),
    ...(draft.license.trim() !== '' ? { license: draft.license.trim() } : {}),
    ...(draft.version.trim() !== '' ? { version: draft.version.trim() } : {}),
    lang,
  };
}

type LintState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'done'; result: PaperLintResponse }
  | { phase: 'failed'; reason: string };

/** obnovenie konceptu — mäkko overíme tvar, inak prázdny draft */
function loadDraft(): { draft: PaperDraft; restored: boolean } {
  try {
    const raw = window.localStorage.getItem(PAPER_DRAFT_KEY);
    if (raw === null) return { draft: EMPTY_DRAFT, restored: false };
    const parsed = JSON.parse(raw) as Partial<PaperDraft>;
    if (typeof parsed !== 'object' || parsed === null) return { draft: EMPTY_DRAFT, restored: false };
    const authors = Array.isArray(parsed.authors) && parsed.authors.length > 0
      ? (parsed.authors as Partial<AuthorDraft>[]).map((a) => ({
          name: typeof a.name === 'string' ? a.name : '',
          affiliation: typeof a.affiliation === 'string' ? a.affiliation : '',
          orcid: typeof a.orcid === 'string' ? a.orcid : '',
          pubkey: typeof a.pubkey === 'string' ? a.pubkey : '',
        }))
      : EMPTY_DRAFT.authors;
    const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
    return {
      draft: {
        title: str(parsed.title),
        authors,
        abstract: str(parsed.abstract),
        topics: str(parsed.topics),
        doi: str(parsed.doi),
        license: str(parsed.license, 'CC-BY-4.0'),
        version: str(parsed.version),
        lang: str(parsed.lang),
        body: str(parsed.body),
        references: str(parsed.references),
      },
      restored: true,
    };
  } catch {
    return { draft: EMPTY_DRAFT, restored: false };
  }
}

export function PaperEditorPage(): JSX.Element {
  const { t } = useTranslation('paper');
  const api = useApi();
  const navigate = useNavigate();
  const { signer, pubkey, loading: signerLoading } = useSigner();
  const write = useWriteStatus();

  const initial = useRef(loadDraft());
  const [draft, setDraft] = useState<PaperDraft>(initial.current.draft);
  const [note, setNote] = useState<string | null>(initial.current.restored ? t('editor.draftRestored') : null);
  const [lint, setLint] = useState<LintState>({ phase: 'idle' });
  const [busy, setBusy] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishCodes, setPublishCodes] = useState<string[]>([]);
  const [loginOpen, setLoginOpen] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const topics = useResource(() => api.topics().catch(() => null), [api]);
  const topicSlugs = useMemo(() => {
    const out: string[] = [];
    const walk = (nodes: { slug: string; children: { slug: string; children: never[] }[] }[]): void => {
      for (const node of nodes) {
        out.push(node.slug);
        walk(node.children ?? []);
      }
    };
    if (topics.data !== null && topics.data !== undefined) walk(topics.data.topics as never);
    return out;
  }, [topics.data]);

  // ── live lint (debounce 600 ms) ────────────────────────────────────────
  // signature = serializovaný draft; každá zmena reštartuje timer. Prázdny
  // papier (žiadny názov ani text) nelinntujeme — inak by editor hneď
  // kričal PAPER_TITLE_REQUIRED.
  const signature = JSON.stringify(draft);
  const hasContent = draft.title.trim() !== '' || draft.body.trim() !== '';

  useEffect(() => {
    if (!hasContent) {
      setLint({ phase: 'idle' });
      return;
    }
    let cancelled = false;
    setLint({ phase: 'checking' });
    const timer = setTimeout(() => {
      api
        .lintPaper(lintInputFromDraft(JSON.parse(signature) as PaperDraft))
        .then((result) => {
          if (!cancelled) setLint({ phase: 'done', result });
        })
        .catch((err: unknown) => {
          if (!cancelled) setLint({ phase: 'failed', reason: err instanceof Error ? err.message : String(err) });
        });
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, signature, hasContent]);

  // ── draft do localStorage (debounce 300 ms) ────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        window.localStorage.setItem(PAPER_DRAFT_KEY, JSON.stringify(draft));
      } catch {
        // plný/ nedostupný localStorage — koncept len neuložíme, šéf to nie je
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [draft]);

  const patch = useCallback((part: Partial<PaperDraft>): void => {
    setDraft((prev) => ({ ...prev, ...part }));
  }, []);

  const patchAuthor = (index: number, part: Partial<AuthorDraft>): void => {
    setDraft((prev) => ({
      ...prev,
      authors: prev.authors.map((author, i) => (i === index ? { ...author, ...part } : author)),
    }));
  };

  const insertBody = (kind: string): void => {
    const template = bodyTemplate(kind);
    const el = bodyRef.current;
    if (el === null) {
      patch({ body: draft.body + template });
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = draft.body.slice(0, start) + template + draft.body.slice(end);
    patch({ body: next });
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + template.length;
      el.setSelectionRange(caret, caret);
    });
  };

  const lintErrors = lint.phase === 'done' ? lint.result.codes : [];
  const lintWarnings = lint.phase === 'done' ? lint.result.warning_codes : [];
  const blockedByLint = lint.phase === 'done' && !lint.result.ok;
  const referencesInvalid = draft.references.trim() !== '' && parseReferencesJson(draft.references) === null;
  const missingTitle = draft.title.trim() === '';
  const missingAuthors = authorInputs(draft.authors).length === 0;
  // anonym má signer s `pubkey === null` — podpisovať sa nedá, ale nie je
  // to chyba: zobrazíme výzvu na prihlásenie (rovnaké ako composer)
  const signedIn = signer !== null && signer !== undefined && pubkey !== null;
  const canPublish =
    signedIn &&
    !busy &&
    !write.locked &&
    !blockedByLint &&
    !referencesInvalid &&
    !missingTitle &&
    !missingAuthors;

  const publish = async (): Promise<void> => {
    if (signer === null || signer === undefined || pubkey === null) return;
    setBusy(true);
    setPublishError(null);
    setPublishCodes([]);
    try {
      const refs = parseReferencesJson(draft.references);
      const lang = draft.lang !== '' ? draft.lang : currentUiLang();
      const tags: NostrTag[] = buildPaperTags({
        title: draft.title.trim(),
        ...(draft.abstract.trim() !== '' ? { abstract: draft.abstract.trim() } : {}),
        authors: authorInputs(draft.authors),
        topics: splitTopics(draft.topics),
        slug: slugifyPaperTitle(draft.title.trim()),
        ...(draft.doi.trim() !== '' ? { doi: bareDoi(draft.doi.trim()) } : {}),
        ...(draft.license.trim() !== '' ? { license: draft.license.trim() } : {}),
        ...(draft.version.trim() !== '' ? { version: draft.version.trim() } : {}),
        publishedAt: Math.floor(Date.now() / 1000),
      });
      // L/l MUSÍ byť pred podpisom — podpísaný event sa už nedoplní
      tags.push(...langTags(lang));
      const content = buildPaperBody({
        body: draft.body,
        ...(refs !== null ? { references: refs } : {}),
      });
      const signed = await signer.signEvent({
        kind: PAPER_KIND,
        content,
        tags,
        created_at: Math.floor(Date.now() / 1000),
      });
      const result = await api.publish(signed);
      if (result.ok && result.quorum_met) {
        window.localStorage.removeItem(PAPER_DRAFT_KEY);
        navigate(`/paper/${result.event_id}`);
      } else {
        setPublishError(result.error ?? t('editor.error', { reason: 'quorum not reached' }));
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setPublishError(err.message);
        const body = err.body as { codes?: unknown } | null;
        if (Array.isArray(body?.codes)) setPublishCodes((body?.codes as string[]).map(String));
      } else {
        setPublishError(t('editor.error', { reason: err instanceof Error ? err.message : String(err) }));
      }
    } finally {
      setBusy(false);
    }
  };

  if (signerLoading) return <StateLoading />;

  return (
    <section className="paper-editor" data-testid="paper-editor">
      <div className="page-head">
        <h1 className="page-title">{t('editor.title')}</h1>
      </div>

      <ReadOnlyBanner />

      {!signedIn && (
        <div className="glass-panel paper-editor-signin" data-testid="editor-signin">
          <p>{t('editor.signIn')}</p>
          <button type="button" className="primary-btn" data-testid="editor-signin-btn" onClick={() => setLoginOpen(true)}>
            {t('editor.signIn')}
          </button>
        </div>
      )}

      <form
        className="glass-card paper-editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          void publish();
        }}
      >
        <div className="field">
          <label htmlFor="paper-title-input">{t('editor.fields.title')}</label>
          <input
            id="paper-title-input"
            value={draft.title}
            onChange={(event) => patch({ title: event.target.value })}
            data-testid="field-title"
          />
        </div>
        {missingTitle && <p className="field-hint" data-testid="title-required">{t('editor.titleRequired')}</p>}

        <div className="field author-group" data-testid="field-authors">
          <label>{t('editor.fields.authors')}</label>
          {draft.authors.map((author, i) => (
            <div key={i} className="author-fields" data-testid="author-fields">
              <input
                placeholder={t('editor.fields.name')}
                aria-label={t('editor.fields.name')}
                value={author.name}
                onChange={(event) => patchAuthor(i, { name: event.target.value })}
                data-testid="author-name"
              />
              <input
                placeholder={t('editor.fields.affiliation')}
                aria-label={t('editor.fields.affiliation')}
                value={author.affiliation}
                onChange={(event) => patchAuthor(i, { affiliation: event.target.value })}
                data-testid="author-affiliation"
              />
              <input
                placeholder={t('editor.fields.orcid')}
                aria-label={t('editor.fields.orcid')}
                value={author.orcid}
                onChange={(event) => patchAuthor(i, { orcid: event.target.value })}
                data-testid="author-orcid"
              />
              <input
                placeholder={t('editor.fields.pubkey')}
                aria-label={t('editor.fields.pubkey')}
                value={author.pubkey}
                onChange={(event) => patchAuthor(i, { pubkey: event.target.value })}
                data-testid="author-pubkey"
              />
              {draft.authors.length > 1 && (
                <button
                  type="button"
                  className="ghost-btn"
                  data-testid="author-remove"
                  onClick={() => setDraft((prev) => ({ ...prev, authors: prev.authors.filter((_, j) => j !== i) }))}
                >
                  {t('editor.removeAuthor')}
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="ghost-btn"
            data-testid="author-add"
            onClick={() => setDraft((prev) => ({ ...prev, authors: [...prev.authors, { name: '', affiliation: '', orcid: '', pubkey: '' }] }))}
          >
            {t('editor.addAuthor')}
          </button>
          {missingAuthors && <p className="field-hint">{t('editor.authorsRequired')}</p>}
        </div>

        <div className="field">
          <label htmlFor="paper-abstract-input">{t('editor.fields.abstract')}</label>
          <textarea
            id="paper-abstract-input"
            rows={3}
            value={draft.abstract}
            onChange={(event) => patch({ abstract: event.target.value })}
            data-testid="field-abstract"
          />
        </div>

        <div className="field">
          <label htmlFor="paper-topics-input">{t('editor.fields.topics')}</label>
          <input
            id="paper-topics-input"
            value={draft.topics}
            onChange={(event) => patch({ topics: event.target.value })}
            placeholder={t('editor.fields.topicsHint')}
            list="paper-topic-options"
            data-testid="field-topics"
          />
          <datalist id="paper-topic-options">
            {topicSlugs.map((slug) => (
              <option key={slug} value={slug} />
            ))}
          </datalist>
        </div>

        <div className="field-grid">
          <div className="field">
            <label htmlFor="paper-doi-input">{t('editor.fields.doi')}</label>
            <input
              id="paper-doi-input"
              value={draft.doi}
              onChange={(event) => patch({ doi: event.target.value })}
              data-testid="field-doi"
            />
          </div>
          <div className="field">
            <label htmlFor="paper-license-input">{t('editor.fields.license')}</label>
            <input
              id="paper-license-input"
              value={draft.license}
              onChange={(event) => patch({ license: event.target.value })}
              list="paper-license-options"
              data-testid="field-license"
            />
            <datalist id="paper-license-options">
              {LICENSES.map((license) => (
                <option key={license} value={license} />
              ))}
            </datalist>
          </div>
          <div className="field">
            <label htmlFor="paper-version-input">{t('editor.fields.version')}</label>
            <input
              id="paper-version-input"
              value={draft.version}
              onChange={(event) => patch({ version: event.target.value })}
              data-testid="field-version"
            />
          </div>
          <div className="field">
            <label htmlFor="paper-lang-select">{t('editor.fields.language')}</label>
            <select
              id="paper-lang-select"
              value={draft.lang}
              onChange={(event) => patch({ lang: event.target.value })}
              data-testid="field-lang"
            >
              {/* `value=""` = „auto": papier dostane jazyk rozhrania. Popisok
                  MUSÍ byť odlíšiteľný od doslovnej voľby `en` — inak select
                  ukáže dve identické položky (EN rozhranie) a človek nevie,
                  čo je auto a čo je explicitný výber. */}
              <option value="">{t('editor.fields.languageAuto', { code: currentUiLang() })}</option>
              <option value="en">en</option>
              <option value="sk">sk</option>
            </select>
          </div>
        </div>

        <div className="field">
          <label htmlFor="paper-body-input">{t('editor.fields.body')}</label>
          <p className="field-hint" data-testid="body-hint">
            {t('editor.fields.bodyHint')}
          </p>
          <div className="composer-toolbar" data-testid="editor-toolbar">
            <button type="button" className="filter-pill" data-testid="tool-section" onClick={() => insertBody('section')}>
              {t('editor.toolbar.section')}
            </button>
            <button type="button" className="filter-pill" data-testid="tool-figure" onClick={() => insertBody('figure')}>
              {t('editor.toolbar.figure')}
            </button>
            <button type="button" className="filter-pill" data-testid="tool-chart" onClick={() => insertBody('chart')}>
              {t('editor.toolbar.chart')}
            </button>
            <button type="button" className="filter-pill" data-testid="tool-equation" onClick={() => insertBody('equation')}>
              {t('editor.toolbar.equation')}
            </button>
            <button type="button" className="filter-pill" data-testid="tool-table" onClick={() => insertBody('table')}>
              {t('editor.toolbar.table')}
            </button>
            <button
              type="button"
              className="filter-pill"
              data-testid="tool-references"
              onClick={() => patch({ references: draft.references.trim() === '' ? REFERENCE_TEMPLATE : draft.references })}
            >
              {t('editor.toolbar.references')}
            </button>
          </div>
          <textarea
            id="paper-body-input"
            ref={bodyRef}
            className="paper-body-input"
            rows={18}
            value={draft.body}
            onChange={(event) => patch({ body: event.target.value })}
            data-testid="field-body"
          />
        </div>

        <div className="field">
          <label htmlFor="paper-refs-input">{t('editor.fields.references')}</label>
          <p className="field-hint">{t('editor.fields.referencesHint')}</p>
          <textarea
            id="paper-refs-input"
            rows={8}
            value={draft.references}
            onChange={(event) => patch({ references: event.target.value })}
            data-testid="field-references"
          />
          {referencesInvalid && (
            <p className="field-hint field-error" data-testid="references-invalid">
              {t('editor.referencesInvalid')}
            </p>
          )}
        </div>

        <div className="editor-lint" data-testid="editor-lint" aria-live="polite">
          {lint.phase === 'checking' && <span data-testid="lint-checking">{t('editor.lint.checking')}</span>}
          {lint.phase === 'failed' && (
            <span className="field-hint" data-testid="lint-failed">
              {t('editor.lint.failed', { reason: lint.reason })}
            </span>
          )}
          {lint.phase === 'done' && lint.result.ok && lintWarnings.length === 0 && (
            <span className="lint-clean" data-testid="lint-clean">
              {t('editor.lint.clean')}
            </span>
          )}
          {lint.phase === 'done' && lintErrors.length > 0 && (
            <div data-testid="lint-errors">
              <strong>{t('editor.lint.errors', { count: lintErrors.length })}</strong>
              <ul>
                {lintErrors.map((code, i) => (
                  <li key={`${code}-${String(i)}`} data-testid="lint-error-code" data-code={code}>
                    {t(`lint.codes.${code}`)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {lint.phase === 'done' && lintWarnings.length > 0 && (
            <div data-testid="lint-warnings">
              <strong>{t('editor.lint.warnings', { count: lintWarnings.length })}</strong>
              <ul>
                {lintWarnings.map((code, i) => (
                  <li key={`${code}-${String(i)}`} data-testid="lint-warning-code" data-code={code}>
                    {t(`lint.codes.${code}`)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {blockedByLint && <p className="field-hint field-error">{t('editor.lint.publishBlocked')}</p>}
        </div>

        {publishError !== null && (
          <div className="field-hint field-error" data-testid="publish-error" role="alert">
            <span>{publishError}</span>
            {publishCodes.length > 0 && (
              <ul data-testid="publish-codes">
                {publishCodes.map((code) => (
                  <li key={code} data-code={code}>
                    {t(`lint.codes.${code}`)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="editor-actions">
          <button type="submit" className="primary-btn" disabled={!canPublish} data-testid="publish-btn">
            {busy ? t('editor.publishing') : t('editor.publish')}
          </button>
          {write.locked && (
            <span className="field-hint" data-testid="gate-locked">
              {t('editor.gateLocked')}
            </span>
          )}
          <button
            type="button"
            className="ghost-btn"
            data-testid="draft-clear"
            onClick={() => {
              window.localStorage.removeItem(PAPER_DRAFT_KEY);
              setDraft(EMPTY_DRAFT);
              setNote(t('editor.draftCleared'));
            }}
          >
            {t('editor.draftClear')}
          </button>
        </div>
        {note !== null && (
          <p className="field-hint" data-testid="editor-note">
            {note}
          </p>
        )}
      </form>

      {loginOpen && <LoginModal onClose={() => setLoginOpen(false)} />}
    </section>
  );
}
