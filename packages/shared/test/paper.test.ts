/**
 * Testy papierového profilu kindu 30023 (Phase 4a, dizajn Q4).
 *
 * Papierový validátor je JEDEN zdroj pravdy pre gateway lint (`POST /events`
 * → 400 s kódmi + `paper_warnings[]` v 200), MCP `forum_lint_paper` /
 * `forum_publish_paper`, indexer (materializované stĺpce) aj UI editor
 * (Phase 4b). Testy preto pokrývajú každú cestu: wire format (tagy),
 * každý error kód, každé varovanie, veľkostné stropy (per-kind vs default),
 * CSL-JSON tvary a krížové odkazy/citácie.
 */
import { describe, expect, it } from 'vitest';

import {
  CONTENT_LANG_KINDS,
  KINDS,
  MAX_CONTENT_BYTES,
  MAX_PAPER_ABSTRACT_BYTES,
  MAX_PAPER_AUTHORS,
  MAX_PAPER_BODY_BYTES,
  MAX_PAPER_TITLE_CHARS,
  MAX_PAPER_WARNINGS,
  MAX_TAGS,
  PAPER_KIND,
  buildPaperBody,
  buildPaperTags,
  collectCitations,
  collectCrossRefs,
  collectDeclaredRefs,
  contentLimitForKind,
  lintPaper,
  parseCslReferences,
  parseFenceAttrs,
  parseFenceMeta,
  proseOnly,
  referencesFences,
  scanFences,
  slugifyPaperTitle,
  tagsLimitForKind,
  validateCslArray,
  validateEvent,
  validatePaperEvent,
} from '../src/index.js';
import type { NostrEvent, NostrTag } from '../src/index.js';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const SIG = 'c'.repeat(128);

/** referencie v tvare dizajnu Q4 (CSL-JSON subset) */
const REFS = [
  {
    id: 'novak2026',
    type: 'article-journal',
    title: 'Negentropy replication',
    author: [{ family: 'Novak', given: 'Jana' }],
    issued: { 'date-parts': [[2026]] },
    'container-title': 'Journal of Nostr',
    DOI: '10.1234/jn.2026',
  },
  {
    id: 'horvat2025',
    type: 'book',
    title: 'Distributed forums',
    author: [{ family: 'Horvat', given: 'Peter' }],
  },
];

const BODY_WITH_REFS = [
  '## Introduction',
  '',
  'We build @fig:arch and measure it in @tbl:lat, see [@novak2026; @horvat2025].',
  '',
  '```mermaid fig=arch caption="Replication topology"',
  'sequenceDiagram',
  '  B->>A: REQ',
  '```',
  '',
  'Table: Latency by load {#tbl:lat}',
  '',
  '| load | p95 |',
  '| ---- | --- |',
  '| 100  | 4.1 |',
  '',
  'Energy follows $$E = mc^2$$ {#eq:energy}, and @eq:energy is famous.',
  '',
  '```references',
  JSON.stringify(REFS),
  '```',
].join('\n');

/** kánonický paper event podľa wire formatu z `paper.ts` */
function makePaperEvent(overrides: Partial<NostrEvent> = {}, tags?: NostrTag[]): NostrEvent {
  return {
    id: HEX_A,
    pubkey: HEX_B,
    created_at: 1_793_836_800,
    kind: PAPER_KIND,
    tags: tags ?? [
      ['d', '2026-negentropy-replication-forum4ai'],
      ['title', 'Negentropy-based Replication for Gated Nostr Forums'],
      ['summary', 'We replicate gated nostr forums with negentropy sets.'],
      ['published_at', '1793836800'],
      ['t', 'distributed-systems'],
      ['t', 'nostr'],
      ['author', 'Jana Novakova', 'Comenius University', HEX_A, '0000-0002-1825-0097'],
      ['author', 'agent:research-bot', 'myhood.sk', '', ''],
      ['p', HEX_B, '', 'author'],
      ['license', 'CC-BY-4.0'],
      ['a', `30020:${HEX_B}:distributed-systems`],
      ['version', '2'],
      ['doi', '10.5281/zenodo.1234567'],
      ['L', 'ISO-639-1'],
      ['l', 'en', 'ISO-639-1'],
    ],
    content: BODY_WITH_REFS,
    sig: SIG,
    ...overrides,
  };
}

describe('wire format papiera (tagy dizajnu Q4)', () => {
  it('30023 je paper kind a dostáva jazykový štítok (2b2)', () => {
    expect(PAPER_KIND).toBe(KINDS.PUBLICATION);
    expect(CONTENT_LANG_KINDS.has(KINDS.PUBLICATION)).toBe(true);
  });

  it('prečíta kompletný event vrátane abstraktu, doi, licencie a jazyka', () => {
    const result = validatePaperEvent(makePaperEvent());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    const data = result.data;
    expect(data).toBeDefined();
    expect(data?.title).toBe('Negentropy-based Replication for Gated Nostr Forums');
    expect(data?.abstract).toBe('We replicate gated nostr forums with negentropy sets.');
    expect(data?.authors).toHaveLength(2);
    expect(data?.authors[0]).toEqual({
      name: 'Jana Novakova',
      affiliation: 'Comenius University',
      pubkey: HEX_A,
      orcid: '0000-0002-1825-0097',
    });
    expect(data?.authors[1]).toEqual({ name: 'agent:research-bot', affiliation: 'myhood.sk' });
    expect(data?.topics).toEqual(['distributed-systems', 'nostr']);
    expect(data?.doi).toBe('10.5281/zenodo.1234567');
    expect(data?.slug).toBe('2026-negentropy-replication-forum4ai');
    expect(data?.license).toBe('CC-BY-4.0');
    expect(data?.version).toBe('2');
    expect(data?.publishedAt).toBe(1_793_836_800);
    expect(data?.topicAddress).toBe(`30020:${HEX_B}:distributed-systems`);
    expect(data?.coauthorPubkeys).toEqual([HEX_B]);
    expect(data?.lang).toBe('en');
    expect(data?.references).toHaveLength(2);
  });

  it('bez chýb a bez varovaní: krížové odkazy aj citácie sedia', () => {
    const result = validatePaperEvent(makePaperEvent());
    expect(result.codes).toEqual([]);
    expect(result.warning_codes).toEqual([]);
    expect(result.data?.declaredRefs).toEqual({
      fig: ['arch'],
      tbl: ['lat'],
      eq: ['energy'],
    });
    expect(result.data?.citedKeys).toEqual(['novak2026', 'horvat2025']);
    expect(result.data?.crossRefs).toEqual([
      { kind: 'fig', id: 'arch' },
      { kind: 'tbl', id: 'lat' },
      { kind: 'eq', id: 'energy' },
    ]);
    expect(result.data?.richBlocks).toBe(1);
  });

  it('buildPaperTags drží poradie a 5-prvkové author tagy (deterministický tvar)', () => {
    const tags = buildPaperTags({
      title: 'Negentropy-based Replication',
      abstract: 'A',
      publishedAt: 1_793_836_800,
      topics: ['nostr'],
      topic: 'ai',
      authors: [
        { name: 'Jana', affiliation: 'CU', pubkey: HEX_A, orcid: '0000-0002-1825-0097' },
        { name: 'Bot' },
      ],
      license: 'CC-BY-4.0',
      topicAddress: `30020:${HEX_B}:nostr`,
      version: '1',
      doi: '10.1/2',
    });
    expect(tags.map((tag) => tag[0])).toEqual([
      'd',
      'title',
      'summary',
      'published_at',
      't',
      't',
      'author',
      'author',
      'p',
      'license',
      'a',
      'version',
      'doi',
    ]);
    expect(tags[6]).toEqual(['author', 'Jana', 'CU', HEX_A, '0000-0002-1825-0097']);
    expect(tags[7]).toEqual(['author', 'Bot', '', '', '']);
    expect(tags[8]).toEqual(['p', HEX_A, '', 'author']);
    expect(tags[0]).toEqual(['d', 'negentropy-based-replication']);
  });

  it('slugifyPaperTitle prepíše diakritiku, oreže a vráti fallback', () => {
    expect(slugifyPaperTitle('Negentropy-based Replication for Gated Nostr Forums')).toBe(
      'negentropy-based-replication-for-gated-nostr-forums',
    );
    expect(slugifyPaperTitle('Reklamačná smernica č. 12/2026')).toBe('reklamacna-smernica-c-12-2026');
    expect(slugifyPaperTitle('!!!')).toBe('paper');
    expect(slugifyPaperTitle('x'.repeat(200)).length).toBeLessThanOrEqual(64);
  });

  it('buildPaperBody prilepí references fence len keď chýba', () => {
    const appended = buildPaperBody({ body: '## Intro', references: REFS });
    expect(referencesFences(appended)).toHaveLength(1);
    expect(appended).toContain('```references');
    expect(buildPaperBody({ body: BODY_WITH_REFS, references: REFS })).toBe(BODY_WITH_REFS);
    expect(buildPaperBody({ body: '## Intro' })).toBe('## Intro');
  });
});

describe('PAPER_TITLE_REQUIRED / PAPER_TITLE_TOO_LONG', () => {
  it('chýbajúci title tag = chyba (title NIE JE prvý riadok body)', () => {
    const result = lintPaper({ body: '## First line as a heading', topics: ['nostr'], authors: [{ name: 'A' }] });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain('PAPER_TITLE_REQUIRED');
  });

  it('title tag s prázdnu hodnotu = PAPER_TITLE_REQUIRED', () => {
    const result = lintPaper({ title: '   ', topics: ['nostr'], authors: [{ name: 'A' }] });
    expect(result.codes).toContain('PAPER_TITLE_REQUIRED');
  });

  it('title nad 300 znakov = PAPER_TITLE_TOO_LONG, 300 znakov prejde', () => {
    const long = lintPaper({ title: 't'.repeat(MAX_PAPER_TITLE_CHARS + 1), topics: ['nostr'], authors: [{ name: 'A' }] });
    expect(long.codes).toContain('PAPER_TITLE_TOO_LONG');
    const exact = lintPaper({ title: 't'.repeat(MAX_PAPER_TITLE_CHARS), topics: ['nostr'], authors: [{ name: 'A' }] });
    expect(exact.codes).not.toContain('PAPER_TITLE_TOO_LONG');
  });
});

describe('PAPER_AUTHORS_INVALID', () => {
  const base = { title: 'T', topics: ['nostr'] };

  it('nula autorov = chyba', () => {
    const result = lintPaper({ ...base, authors: [] });
    expect(result.codes).toEqual(['PAPER_AUTHORS_INVALID']);
    expect(result.errors[0]).toContain('at least one author');
  });

  it('51 autorov = chyba, 50 prejde (hranica)', () => {
    const many = Array.from({ length: MAX_PAPER_AUTHORS + 1 }, (_, i) => ({ name: `A${String(i)}` }));
    expect(lintPaper({ ...base, authors: many }).codes).toContain('PAPER_AUTHORS_INVALID');
    const exact = Array.from({ length: MAX_PAPER_AUTHORS }, (_, i) => ({ name: `A${String(i)}` }));
    expect(lintPaper({ ...base, authors: exact }).codes).toEqual([]);
  });

  it('prázdne meno autora = chyba', () => {
    const result = lintPaper({ ...base, authors: [{ name: '  ' }] });
    expect(result.codes).toContain('PAPER_AUTHORS_INVALID');
    expect(result.errors[0]).toContain('name');
  });

  it('pubkey mimo 64-hex = chyba', () => {
    const result = lintPaper({ ...base, authors: [{ name: 'A', pubkey: 'xyz' }] });
    expect(result.codes).toContain('PAPER_AUTHORS_INVALID');
    expect(result.errors[0]).toContain('64 hex');
  });

  it('orcid bare aj URL sú platné, hociktorý iný tvar = chyba', () => {
    expect(lintPaper({ ...base, authors: [{ name: 'A', orcid: '0000-0002-1825-0097' }] }).codes).toEqual([]);
    expect(
      lintPaper({ ...base, authors: [{ name: 'A', orcid: 'https://orcid.org/0000-0002-1825-0097' }] }).codes,
    ).toEqual([]);
    expect(lintPaper({ ...base, authors: [{ name: 'A', orcid: 'orcid:1234' }] }).codes).toContain(
      'PAPER_AUTHORS_INVALID',
    );
  });

  it('autor ako pole (tvar tagu) sa parsovanie naučí, number = chyba', () => {
    const fromTag = lintPaper({ ...base, authors: [['Jana', 'CU', HEX_A, '']] });
    expect(fromTag.codes).toEqual([]);
    expect(fromTag.data?.authors[0]).toEqual({ name: 'Jana', affiliation: 'CU', pubkey: HEX_A });
    const bad = lintPaper({ ...base, authors: [42] });
    expect(bad.codes).toContain('PAPER_AUTHORS_INVALID');
  });

  it('autor ako čisté meno (string) je akceptovaný tvar', () => {
    const result = lintPaper({ ...base, authors: ['Jana Novakova'] });
    expect(result.codes).toEqual([]);
    expect(result.data?.authors[0]?.name).toBe('Jana Novakova');
  });

  it('name nad 200 znakov a affiliation nad 200 znakov = chyba', () => {
    expect(lintPaper({ ...base, authors: [{ name: 'n'.repeat(201) }] }).codes).toContain('PAPER_AUTHORS_INVALID');
    expect(lintPaper({ ...base, authors: [{ name: 'A', affiliation: 'a'.repeat(201) }] }).codes).toContain(
      'PAPER_AUTHORS_INVALID',
    );
  });

  it('6-prvkový author tag = chyba (pozície sú fixné)', () => {
    const result = lintPaper({ ...base, authors: [['A', '', '', '', '', 'extra']] });
    expect(result.codes).toContain('PAPER_AUTHORS_INVALID');
  });
});

describe('PAPER_ABSTRACT_TOO_LONG / PAPER_TOPIC_* / PAPER_DOI_INVALID', () => {
  const base = { title: 'T', authors: [{ name: 'A' }] };

  it('abstrakt nad 1024 bajtov = chyba (strop prvku tagu, aj pre strfry)', () => {
    const result = lintPaper({ ...base, topics: ['nostr'], abstract: 'a'.repeat(MAX_PAPER_ABSTRACT_BYTES + 1) });
    expect(result.codes).toContain('PAPER_ABSTRACT_TOO_LONG');
    const exact = lintPaper({ ...base, topics: ['nostr'], abstract: 'a'.repeat(MAX_PAPER_ABSTRACT_BYTES) });
    expect(exact.codes).toEqual([]);
  });

  it('abstrakt meraný v UTF-8 bajtoch, nie znakoch ( diakritika )', () => {
    const result = lintPaper({ ...base, topics: ['nostr'], abstract: 'ä'.repeat(513) });
    expect(result.codes).toContain('PAPER_ABSTRACT_TOO_LONG');
  });

  it('bez t tagu = PAPER_TOPIC_MISSING', () => {
    const result = lintPaper({ title: 'T', authors: [{ name: 'A' }], body: 'x' });
    expect(result.codes).toContain('PAPER_TOPIC_MISSING');
  });

  it('topic nad 200 znakov = PAPER_TOPIC_INVALID', () => {
    const result = lintPaper({ ...base, topics: ['t'.repeat(201)] });
    expect(result.codes).toContain('PAPER_TOPIC_INVALID');
  });

  it('topicie sa trimujú a dedupujú s poradím', () => {
    const result = lintPaper({ ...base, topics: [' nostr ', 'nostr', 'ai', ''] });
    expect(result.data?.topics).toEqual(['nostr', 'ai']);
    expect(result.codes).toEqual([]);
  });

  it('doi musí mať tvar 10.<suffix>/<…>', () => {
    expect(lintPaper({ ...base, topics: ['nostr'], doi: '10.5281/zenodo.1234567' }).codes).toEqual([]);
    expect(lintPaper({ ...base, topics: ['nostr'], doi: 'doi:10.1/2' }).codes).toContain('PAPER_DOI_INVALID');
    expect(lintPaper({ ...base, topics: ['nostr'], doi: '10./x' }).codes).toContain('PAPER_DOI_INVALID');
  });

  // DOI URL je tvar, ktorý agent skopíruje z článku — akceptujeme ho
  // rovnako ako `orcid` (dva tvary). Hodnota tagu sa NEMENÍ, papier sa
  // len neodmietne pre formát odkazu.
  it('doi URL tvar prejde (rovnako ako orcid URL)', () => {
    for (const doi of [
      'https://doi.org/10.5281/zenodo.1234567',
      'http://dx.doi.org/10.5281/zenodo.1234567',
    ]) {
      const result = lintPaper({ ...base, topics: ['nostr'], doi });
      expect(result.codes).toEqual([]);
      expect(result.data?.doi).toBe(doi);
    }
    // URL MUSÍ niesť platné DOI — inak je to stále chyba
    expect(lintPaper({ ...base, topics: ['nostr'], doi: 'https://doi.org/not-a-doi' }).codes).toContain(
      'PAPER_DOI_INVALID',
    );
    expect(
      lintPaper({ ...base, topics: ['nostr'], doi: 'https://example.org/10.5281/zenodo.1' }).codes,
    ).toContain('PAPER_DOI_INVALID');
  });
});

describe('PAPER_BODY_TOO_LARGE a per-kind stropy', () => {
  const base = { title: 'T', authors: [{ name: 'A' }], topics: ['nostr'] };

  it('strop papiera je 160 KiB a default kindov ostáva 32 KiB', () => {
    expect(MAX_PAPER_BODY_BYTES).toBe(160 * 1024);
    expect(contentLimitForKind(KINDS.PUBLICATION)).toBe(163_840);
    expect(contentLimitForKind(KINDS.POST)).toBe(MAX_CONTENT_BYTES);
    expect(contentLimitForKind(KINDS.POST)).toBe(32 * 1024);
    expect(tagsLimitForKind(KINDS.PUBLICATION)).toBe(128);
    expect(tagsLimitForKind(KINDS.QUESTION)).toBe(MAX_TAGS);
  });

  it('160 KiB + 1 bajt = chyba, presne 160 KiB prejde', () => {
    const over = lintPaper({ ...base, body: 'x'.repeat(MAX_PAPER_BODY_BYTES + 1) });
    expect(over.codes).toContain('PAPER_BODY_TOO_LARGE');
    expect(over.data?.bodyBytes).toBe(MAX_PAPER_BODY_BYTES + 1);
    const exact = lintPaper({ ...base, body: 'x'.repeat(MAX_PAPER_BODY_BYTES) });
    expect(exact.codes).toEqual([]);
  });

  it('validateEvent: 100 KiB content pre 30023 prejde, pre 1023 nie (additive)', () => {
    const body = 'x'.repeat(100 * 1024);
    const paper = validateEvent({
      id: HEX_A,
      pubkey: HEX_B,
      created_at: 1_793_836_800,
      kind: KINDS.PUBLICATION,
      tags: [['d', 'slug']],
      content: body,
      sig: SIG,
    });
    expect(paper.codes).not.toContain('CONTENT_TOO_LARGE');
    const post = validateEvent({
      id: HEX_A,
      pubkey: HEX_B,
      created_at: 1_793_836_800,
      kind: KINDS.POST,
      tags: [['e', HEX_A, 'root']],
      content: body,
      sig: SIG,
    });
    expect(post.codes).toContain('CONTENT_TOO_LARGE');
  });

  it('validateEvent: 100 tagov pre 30023 prejde, 70 pre 1023 nie', () => {
    const tags: NostrTag[] = Array.from({ length: 100 }, (_, i) => ['t', `topic${String(i)}`]);
    const paper = validateEvent({
      id: HEX_A,
      pubkey: HEX_B,
      created_at: 1_793_836_800,
      kind: KINDS.PUBLICATION,
      tags: [['d', 'slug'], ...tags],
      content: 'x',
      sig: SIG,
    });
    expect(paper.codes).not.toContain('TAGS_TOO_MANY');
    const post = validateEvent({
      id: HEX_A,
      pubkey: HEX_B,
      created_at: 1_793_836_800,
      kind: KINDS.POST,
      tags: [['e', HEX_A, 'root'], ...Array.from({ length: 69 }, (_, i) => ['t', `t${String(i)}`] as NostrTag)],
      content: 'x',
      sig: SIG,
    });
    expect(post.codes).toContain('TAGS_TOO_MANY');
  });
});

describe('bohaté bloky: RICH_BLOCKS_TOO_MANY, MERMAID_TOO_LARGE, CHART_INVALID', () => {
  const base = { title: 'T', authors: [{ name: 'A' }], topics: ['nostr'] };
  const diagram = (n: number, lang: 'mermaid' | 'chart' = 'mermaid'): string =>
    Array.from({ length: n }, (_, i) =>
      lang === 'mermaid'
        ? '```mermaid fig=f' + String(i) + '\ngraph TD; A-->B;\n```'
        : '```chart fig=f' + String(i) + '\n{"v":1,"type":"bar","series":[{"name":"s","data":[1,2]}]}\n```',
    ).join('\n\n');

  it('9 bohatých blokov = chyba, 8 prejde', () => {
    expect(lintPaper({ ...base, body: diagram(9) }).codes).toContain('RICH_BLOCKS_TOO_MANY');
    const eight = lintPaper({ ...base, body: diagram(8) });
    expect(eight.codes).toEqual([]);
    expect(eight.data?.richBlocks).toBe(8);
  });

  it('mermaid zárez nad 20 000 znakov = MERMAID_TOO_LARGE', () => {
    const body = `\`\`\`mermaid fig=big\n${'x'.repeat(20_001)}\n\`\`\``;
    const result = lintPaper({ ...base, body });
    expect(result.codes).toContain('MERMAID_TOO_LARGE');
  });

  it('neplatný chart DSL = CHART_INVALID so správou z chart-dsl validátora', () => {
    const body = '```chart fig=bad\n{"v":2,"type":"pie","series":[]}\n```';
    const result = lintPaper({ ...base, body });
    expect(result.codes).toContain('CHART_INVALID');
    expect(result.errors.join(' ')).toContain('root.v');
  });

  it('chart zárez s neplatným JSON = CHART_INVALID', () => {
    const result = lintPaper({ ...base, body: '```chart\n{ "v": 1,\n```' });
    expect(result.codes).toContain('CHART_INVALID');
    expect(result.errors.join(' ')).toContain('invalid JSON');
  });

  it('platný chart DSL prejde a počíta sa ako bohatý blok', () => {
    const body = '```chart fig=lat caption="p95"\n{"v":1,"type":"line","series":[{"name":"a","data":[[1,2]]}]}\n```';
    const result = lintPaper({ ...base, body });
    expect(result.codes).toEqual([]);
    expect(result.data?.richBlocks).toBe(1);
    expect(result.data?.declaredRefs.fig).toEqual(['lat']);
  });

  it('obyčajný ```json zárez nie je bohatý blok a nevaliduje sa ako chart', () => {
    const result = lintPaper({ ...base, body: '```json\n{"anything": true}\n```' });
    expect(result.codes).toEqual([]);
    expect(result.data?.richBlocks).toBe(0);
  });
});

describe('REFS_INVALID — štruktúra ```references zárezu', () => {
  const base = { title: 'T', authors: [{ name: 'A' }], topics: ['nostr'] };
  const withRefs = (raw: string): string => `Body text.\n\n\`\`\`references\n${raw}\n\`\`\``;

  it('neplatné JSON = REFS_INVALID s dôvodom parsera', () => {
    const result = lintPaper({ ...base, body: withRefs('[{id: 1},]') });
    expect(result.codes).toContain('REFS_INVALID');
    expect(result.errors.join(' ')).toContain('not valid JSON');
    expect(result.data?.references).toBeNull();
  });

  it('pole namiesto objektu/naopak: objekt = REFS_INVALID', () => {
    const result = lintPaper({ ...base, body: withRefs('{"id":"a"}') });
    expect(result.codes).toContain('REFS_INVALID');
    expect(result.errors.join(' ')).toContain('JSON ARRAY');
  });

  it('položka bez id a bez type = dve chyby', () => {
    const result = lintPaper({ ...base, body: withRefs('[{"title":"x"}]') });
    expect(result.codes.filter((c) => c === 'REFS_INVALID')).toHaveLength(2);
    expect(result.errors.join(' ')).toContain('"id" is required');
    expect(result.errors.join(' ')).toContain('"type" is required');
  });

  it('id, ktoré sa nedá citovať [@…], = REFS_INVALID', () => {
    const result = lintPaper({ ...base, body: withRefs('[{"id":"bad id!","type":"book"}]') });
    expect(result.codes).toContain('REFS_INVALID');
  });

  it('duplicitné id = REFS_INVALID (citácia musí rozlíšiť položku)', () => {
    const result = lintPaper({
      ...base,
      body: withRefs('[{"id":"a","type":"book","title":"T","author":[{}]},{"id":"a","type":"book","title":"T","author":[{}]}]'),
    });
    expect(result.codes).toContain('REFS_INVALID');
    expect(result.errors.join(' ')).toContain('duplicate id');
  });

  it('author nie je pole / položka nie je objekt = REFS_INVALID', () => {
    const result = lintPaper({ ...base, body: withRefs('[{"id":"a","type":"book","title":"T","author":"Novak"}]') });
    expect(result.codes).toContain('REFS_INVALID');
    const nested = lintPaper({
      ...base,
      body: withRefs('[{"id":"a","type":"book","title":"T","author":["Novak"]}]'),
    });
    expect(nested.codes).toContain('REFS_INVALID');
  });

  it('issued.date-parts mimo pole polí čísel = REFS_INVALID', () => {
    const result = lintPaper({
      ...base,
      body: withRefs('[{"id":"a","type":"book","title":"T","author":[{}],"issued":{"date-parts":"2025"}}]'),
    });
    expect(result.codes).toContain('REFS_INVALID');
  });

  it('DOI/URL/title mimo reťazca = REFS_INVALID', () => {
    const result = lintPaper({
      ...base,
      body: withRefs('[{"id":"a","type":"book","title":2025,"author":[{}],"URL":123}]'),
    });
    expect(result.codes.filter((c) => c === 'REFS_INVALID')).toHaveLength(2);
  });

  it('dva references zárezy = REFS_INVALID (dizajn: jeden posledný)', () => {
    const body = 'A\n\n```references\n[]\n```\n\nB\n\n```references\n[]\n```';
    expect(lintPaper({ ...base, body }).codes).toContain('REFS_INVALID');
  });

  it('prázdne pole referencií nie je chyba (len žiadne citácie)', () => {
    const result = lintPaper({ ...base, body: withRefs('[]') });
    expect(result.codes).toEqual([]);
    expect(result.data?.references).toEqual([]);
  });

  it('CSL-JSON subset s neznámymi kľúčmi prejde (Q4: subset, nie prísna schéma)', () => {
    const result = lintPaper({
      ...base,
      body: 'Prose [@a].\n\n```references\n[{"id":"a","type":"paper-conference","title":"T","author":[{"family":"N","given":"J"}],"issued":{"date-parts":[[2025,3,14]]},"URL":"https://x/y","accessed":{"date-parts":[[2026]]},"note":"seen"}]\n```',
    });
    expect(result.codes).toEqual([]);
    expect(result.warning_codes).toEqual([]);
  });

  it('parseCslReferences a validateCslArray zdieľajú pravidlá', () => {
    const fromString = parseCslReferences('[{"id":"a","type":"book"}]');
    const fromArray = validateCslArray([{ id: 'a', type: 'book' }]);
    expect(fromString.errors).toEqual(fromArray.errors);
    expect(fromString.incomplete).toEqual(fromArray.incomplete);
  });
});

describe('varovania: REFS_MISSING, REFS_ITEM_INCOMPLETE, CITE_UNKNOWN, REF_UNCITED, XREF_UNKNOWN', () => {
  const base = { title: 'T', authors: [{ name: 'A' }], topics: ['nostr'] };

  it('bez references fence = REFS_MISSING (aj keď telo nič necituje)', () => {
    const result = lintPaper({ ...base, body: '## Intro\n\nPlain prose.' });
    expect(result.ok).toBe(true);
    expect(result.warning_codes).toContain('REFS_MISSING');
  });

  it('citácie bez referencií = REFS_MISSING s počtom kľúčov', () => {
    const result = lintPaper({ ...base, body: 'Prose [@ghost2024].' });
    expect(result.warning_codes).toContain('REFS_MISSING');
    expect(result.warnings.join(' ')).toContain('1 key(s)');
  });

  it('chýbajúci title/author položky = REFS_ITEM_INCOMPLETE', () => {
    const result = lintPaper({ ...base, body: 'Prose.\n\n```references\n[{"id":"a","type":"book"}]\n```' });
    expect(result.warning_codes).toContain('REFS_ITEM_INCOMPLETE');
    expect(result.warnings.join(' ')).toContain('"a" has no title');
    expect(result.warnings.join(' ')).toContain('"a" has no author');
    expect(result.ok).toBe(true);
  });

  it('[@key] mimo referencií = CITE_UNKNOWN (len neznáme kľúče)', () => {
    const body = 'Prose [@novak2026] and [@ghost].\n\n```references\n[{"id":"novak2026","type":"book","title":"T","author":[{"family":"N","given":"J"}]}]\n```';
    const result = lintPaper({ ...base, body });
    expect(result.warning_codes).toContain('CITE_UNKNOWN');
    const citeWarning = result.warnings[result.warning_codes.indexOf('CITE_UNKNOWN')] ?? '';
    expect(citeWarning).toContain('@ghost');
    expect(citeWarning).not.toContain('@novak2026');
    expect(result.warning_codes).not.toContain('REFS_ITEM_INCOMPLETE');
    expect(result.warning_codes).not.toContain('REF_UNCITED');
  });

  it('referencia bez citácie = REF_UNCITED', () => {
    const body = 'Prose.\n\n```references\n[{"id":"novak2026","type":"book","title":"T","author":[{}]}]\n```';
    const result = lintPaper({ ...base, body });
    expect(result.warning_codes).toContain('REF_UNCITED');
    expect(result.warnings.join(' ')).toContain('@novak2026');
  });

  it('všetky referencie citované = žiadne varovania', () => {
    const result = validatePaperEvent(makePaperEvent());
    expect(result.warning_codes).toEqual([]);
  });

  it('@fig: bez deklarácie = XREF_UNKNOWN, s fig= deklaráciou nie', () => {
    const dangling = lintPaper({ ...base, body: 'See @fig:arch for details.' });
    expect(dangling.warning_codes).toContain('XREF_UNKNOWN');
    expect(dangling.warnings.join(' ')).toContain('@fig:arch');
    const declared = lintPaper({
      ...base,
      body: 'See @fig:arch.\n\n```mermaid fig=arch\ngraph TD; A-->B;\n```',
    });
    expect(declared.warning_codes).not.toContain('XREF_UNKNOWN');
  });

  it('{#tbl:x} a {#eq:y} deklarácie uspokoja @tbl:x / @eq:y', () => {
    const result = lintPaper({
      ...base,
      body: 'Table: Cap {#tbl:x}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n$$a^2$$ {#eq:y} and @tbl:x plus @eq:y.',
    });
    expect(result.warning_codes).not.toContain('XREF_UNKNOWN');
    expect(result.data?.declaredRefs.tbl).toEqual(['x']);
    expect(result.data?.declaredRefs.eq).toEqual(['y']);
  });

  it('krížový odkaz na zlý druh nie je uspokojený (@tbl: vs fig=)', () => {
    const result = lintPaper({
      ...base,
      body: 'See @tbl:arch.\n\n```mermaid fig=arch\ngraph TD; A-->B;\n```',
    });
    expect(result.warning_codes).toContain('XREF_UNKNOWN');
  });

  it('citácie a odkazy vnútri kódu sa NEPOČÍTAJÚ', () => {
    const body = ['Prose without citations.', '', '```', 'Look at [@fake] and @fig:fake in code.', '```', '', 'Inline `[@alsoFake]` too.'].join('\n');
    const result = lintPaper({ ...base, body });
    expect(result.data?.citedKeys).toEqual([]);
    expect(result.data?.crossRefs).toEqual([]);
    expect(result.warning_codes).not.toContain('CITE_UNKNOWN');
    expect(result.warning_codes).not.toContain('XREF_UNKNOWN');
  });

  it('markdown odkaz [text](https://x/@y) nie je citácia', () => {
    const result = lintPaper({ ...base, body: 'Read [the paper](https://example.org/@ghost) for more.' });
    expect(result.data?.citedKeys).toEqual([]);
  });

  it('tvar [@a; @b], [-@a] a [see @a, p. 12] sa parsovanie naučia', () => {
    expect(collectCitations('[@a; @b]')).toEqual(['a', 'b']);
    expect(collectCitations('[-@a]')).toEqual(['a']);
    expect(collectCitations('[see @a, p. 12]')).toEqual(['a']);
    expect(collectCitations('[@a].')).toEqual(['a']);
  });

  it('varovania sú nad MAX_PAPER_WARNINGS zrnuté', () => {
    const refs = Array.from({ length: MAX_PAPER_WARNINGS + 5 }, (_, i) => ({
      id: `r${String(i)}`,
      type: 'book',
      title: 'T',
      author: [{}],
    }));
    const body = `Prose.\n\n\`\`\`references\n${JSON.stringify(refs)}\n\`\`\``;
    const result = lintPaper({ ...base, body });
    expect(result.warnings).toHaveLength(MAX_PAPER_WARNINGS + 1);
    expect(result.warnings.at(-1)).toContain('suppressed');
    expect(result.warnings).toHaveLength(result.warning_codes.length);
  });

  it('errors/codes a warnings/warning_codes majú indexovo rovnakú dĺžku', () => {
    const result = lintPaper({ authors: [{ name: '' }], body: 'x' });
    expect(result.errors).toHaveLength(result.codes.length);
    expect(result.warnings).toHaveLength(result.warning_codes.length);
    expect(result.ok).toBe(false);
  });
});

describe('markdown skan (scanFences / proseOnly / collectDeclaredRefs)', () => {
  it('scanFences číta jazyk, metadata, zdroj a poradie', () => {
    const fences = scanFences('a\n```mermaid fig=arch caption="Top"\ngraph TD; A-->B;\n```\nb');
    expect(fences).toHaveLength(1);
    expect(fences[0]?.lang).toBe('mermaid');
    expect(fences[0]?.meta).toBe('fig=arch caption="Top"');
    expect(fences[0]?.source).toBe('graph TD; A-->B;');
    expect(fences[0]?.line).toBe(1);
    expect(fences[0]?.open).toBe(false);
  });

  it('scanFences: tilde zárez a neuzavretý zárez', () => {
    const tildes = scanFences('~~~chart\n{"v":1}\n~~~');
    expect(tildes[0]?.lang).toBe('chart');
    const unclosed = scanFences('```mermaid\ngraph TD;');
    expect(unclosed[0]?.open).toBe(true);
    expect(unclosed[0]?.source).toBe('graph TD;');
  });

  it('zárez vnútri iného typu zárezu sa nespája (```` fence s ``` vnútri)', () => {
    const body = '````markdown\n```mermaid\ngraph TD;\n```\n````';
    const fences = scanFences(body);
    expect(fences).toHaveLength(1);
    expect(fences[0]?.lang).toBe('markdown');
    expect(fences[0]?.source).toBe('```mermaid\ngraph TD;\n```');
  });

  it('proseOnly vynechá zárez aj inline code, ale zachová zvyšok', () => {
    const prose = proseOnly('A\n\n```\nhidden\n```\n\nB `hidden` C');
    expect(prose).not.toContain('hidden');
    expect(prose).toContain('A');
    expect(prose).toContain('B  C');
  });

  it('collectDeclaredRefs berie fig= zo zárezu a atribúty z prozy', () => {
    const declared = collectDeclaredRefs('```chart fig=c1\n{"v":1,"type":"bar","series":[{"name":"s","data":[1]}]}\n```\n\nTable: T {#tbl:t1}\n\n$$x$$ {#eq:e1}');
    expect(declared).toEqual({ fig: ['c1'], tbl: ['t1'], eq: ['e1'] });
  });

  it('collectCrossRefs deduplikuje a ignoruje kód', () => {
    expect(collectCrossRefs('@fig:a @fig:a @tbl:b and `@eq:x`')).toEqual([
      { kind: 'fig', id: 'a' },
      { kind: 'tbl', id: 'b' },
    ]);
  });
});

describe('parseFenceMeta / parseFenceAttrs (presunuté z UI, Phase 4a)', () => {
  it('dvojité aj jednoduché úvodzovky aj holá hodnota', () => {
    expect(parseFenceMeta('fig=arch caption="Replication topology"')).toEqual({
      fig: 'arch',
      caption: 'Replication topology',
    });
    expect(parseFenceMeta("fig='x' caption='y z'")).toEqual({ fig: 'x', caption: 'y z' });
    expect(parseFenceMeta(undefined)).toEqual({});
    expect(parseFenceMeta('   ')).toEqual({});
  });

  it('neznáme kľúče ignoruje, ale parseFenceAttrs ich ukáže', () => {
    expect(parseFenceMeta('fig=a width=800 tbl=t')).toEqual({ fig: 'a' });
    expect(parseFenceAttrs('fig=a width=800 tbl=t')).toEqual({ fig: 'a', width: '800', tbl: 't' });
    expect(parseFenceAttrs(undefined)).toEqual({});
  });

  it('strihy fig 64 / caption 240 sú súčasťou kontraktu', () => {
    const meta = parseFenceMeta(`fig=${'f'.repeat(80)} caption="${'c'.repeat(300)}"`);
    expect(meta.fig).toHaveLength(64);
    expect(meta.caption).toHaveLength(240);
  });
});
