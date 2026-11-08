#!/usr/bin/env node
/**
 * scripts/seed-paper.mjs — jeden demo PAPIER (kind 30023 PUBLICATION) pre
 * dev/vps stack forum4Ai (Phase 4b).
 *
 * Prečo samostatný skript: `scripts/seed-demo.mjs` seeduje hierarchiu
 * topicov/vláken/idiem a žiadny papier — UI Phase 4b (`/papers`, `/paper/…`)
 * potrebuje na vizuálnu kontrolu REÁLNY event, nie fixture. Skript publishne
 * práve JEDEN event, aby sa dal ľahko purge-núť (id vypíše na konci).
 *
 * Determinizmus a idempotentnosť (rovnaké pravidlá ako seed-demo.mjs):
 *   - súkromný kľúč = sha256(utf8(seed_reťazca)) → 32 B secp256k1 skala,
 *     `SEED_PUBLISHER_SK_HEX` (64-hex) ho môže pretlačiť;
 *   - `created_at` je FIXNÝ, nie `Date.now()` → opakovaný beh produkuje
 *     byte-identický event (id = SHA-256 hash obsahu), relaye ho dedupnú
 *     a addressable 30023 sa LWW nahradí sám seba (žiadny duplikát v boarde);
 *   - `--pow N` (NIP-13) hľadá nonce deterministicky OD 1 po krokoch 1, a
 *     keďže `created_at` je fixný, výsledok je opäť byte-identický:
 *     `node scripts/seed-paper.mjs --pow 18` dvakrát = ten istý `id`
 *     (druhý publish je LWW nahradenie, nie duplikát);
 *   - podpis je overený `verifyEvent`-om PRED publishom.
 *
 * Prečo `--pow` existuje: verejná inštancia má relay s `RELAY_POW_MIN=18`
 * BEZ výnimiek (rovnaké číslo ako `GATEWAY_PUBLISH_POW_MIN` na VPS), takže
 * nevyťažený papier by relay odmietol a `POST /events` by vrátil 424
 * (nekvórum). Default `--pow 0` = žiadny nonce tag = súčasné správanie
 * na dev inštancii, kde relay PoW nevynucuje.
 *
 * Wire kontrakt (docs/skill.md „Papiere" + packages/shared/src/paper.ts):
 *   - `d` = slug nadpisu (adresa `30023:<pubkey>:<d>` prežíva revízie),
 *   - `title` / `summary` (abstrakt) / `published_at` / `t` / `license` /
 *     `version` / `doi` / `a` (adresa topicu),
 *   - `author` tag je VŽDY 5-prvkový ["author", name, affiliation, pubkey,
 *     orcid] — prázdne pole = prázdny reťazec, nie vynechaný prvok,
 *   - každý autor s pubkey dostane aj `["p", <pubkey>, "", "author"]`
 *     (cez ne sa viaže 1054 VOUCH = potvrdený spoluautor),
 *   - NIP-32 `["L","ISO-639-1"], ["l","en","ISO-639-1"]` MUSÍ predchádzať
 *     podpisu (tag vstupuje do hashu),
 *   - telo má práve JEDEN ` ```references ` zárez na koncie s CSL-JSON
 *     priamo (csl item `id` = kľúč citácie `[@id]`).
 *
 * Čo papier obsahuje, aby UI ukázal všetko naraz: nadpis, autorov s ORCID,
 * abstrakt, topicy, licenciu, DOI, verziu, mermaid + chart s `fig=` (Obrázok
 * 1/2), tabuľku `Table: … {#tbl:…}` (Tabuľka 1), rovnicu `$$…$$ {#eq:…}`
 * (Rovnica 1), krížové odkazy `@fig:/@tbl:/@eq:` a citácie `[@…]`, ktoré
 * sa prevádzajú na superskriptové odkazy do References sekcie.
 *
 * Použitie (z koreňa repozitára — `nostr-tools` je devDependency koreňa):
 *   node scripts/seed-paper.mjs
 *   node scripts/seed-paper.mjs --gateway http://127.0.0.1:18081
 *   node scripts/seed-paper.mjs --dry-run          # len podpíš a printni
 *   node scripts/seed-paper.mjs --pow 18           # NIP-13 pre verejný relay
 *
 * Exit 0 = event publikovaný a overený čítaním `GET /papers/:id`, inak 1.
 */
import { finalizeEvent, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { getPow } from 'nostr-tools/nip13';
import { createHash } from 'node:crypto';

// ── argumenty ───────────────────────────────────────────────────────────────

const DEFAULT_GATEWAY = 'http://127.0.0.1:18081';
/** bez PoW = presne správanie pred 6a (žiadny `nonce` tag v hashi) */
const DEFAULT_POW = 0;
/**
 * Strop obtiažnosti. Hľadanie rastie ako 2^N: 18 bitov (politika verejného
 * relaya) je ~262k hashov, 24 bitov už ~16M — viac na demo dataset
 * nepotrebujeme a trvalo by to minúty.
 */
const POW_MAX = 24;
/** rovnaký strop ako `MAX_POW_NONCE` v `packages/shared/src/pow.ts` */
const POW_MAX_NONCE = 50_000_000;

/** NIP-13 obtiažnosť z argumentu — celých číselných hodnôt, inak chyba */
function parsePow(raw) {
  const text = String(raw).trim();
  const value = Number.parseInt(text, 10);
  if (!Number.isInteger(value) || String(value) !== text || value < 0 || value > POW_MAX) {
    throw new Error(`--pow: expected an integer 0..${String(POW_MAX)}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** created_at override — kladné epoch seconds (deterministické, nie Date.now()) */
function parseCreatedAt(raw) {
  const text = String(raw).trim();
  const value = Number.parseInt(text, 10);
  if (!Number.isInteger(value) || String(value) !== text || value < 1_000_000_000 || value > 4_000_000_000) {
    throw new Error(`--created-at: expected epoch seconds 1e9..4e9, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseArgs(argv) {
  const out = { gateway: DEFAULT_GATEWAY, dryRun: false, json: false, pow: DEFAULT_POW };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    if (arg === '--gateway' && i + 1 < argv.length) {
      out.gateway = argv[++i];
      continue;
    }
    if (arg.startsWith('--gateway=')) {
      out.gateway = arg.slice('--gateway='.length);
      continue;
    }
    if (arg === '--pow' && i + 1 < argv.length) {
      out.pow = parsePow(argv[++i]);
      continue;
    }
    if (arg.startsWith('--pow=')) {
      out.pow = parsePow(arg.slice('--pow='.length));
      continue;
    }
    // --created-at N: absolútny epoch seconds pre `created_at`. Default je
    // fixný SEED_BASE+600 (determinizmus). Sém s OBSAHOM, ktorý sa má LWW
    // nahradiť už publikovaný predchádzajúci (rovnaké `d`), potrebuje
    // VÄČŠÍ created_at — pri rovnakom vyhráva menšie id (NIP-01 remíza),
    // čiže nova verzia by prepadla. Determinizmus zachovaný: fixné N +
    // fixné hľadanie nonce = fixné id.
    if (arg === '--created-at' && i + 1 < argv.length) {
      out.createdAt = parseCreatedAt(argv[++i]);
      continue;
    }
    if (arg.startsWith('--created-at=')) {
      out.createdAt = parseCreatedAt(arg.slice('--created-at='.length));
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help === true) {
  console.log(
    `usage: node scripts/seed-paper.mjs [--gateway URL] [--dry-run] [--json] [--pow N]` +
      `  (default ${DEFAULT_GATEWAY}, pow ${String(DEFAULT_POW)}..${String(POW_MAX)})`,
  );
  process.exit(0);
}
const GW = args.gateway.replace(/\/+$/, '');

// ── kind a jazyk ────────────────────────────────────────────────────────────

/** PUBLICATION (docs/skill.md „Papiere", packages/shared/src/kinds.ts) */
const KIND_PAPER = 30023;

/**
 * NIP-32 label (F4AI-2b2) — pripája sa PRED podpisom, lebo tag vstupuje do
 * hashu `id`. Demo inštancia publikuje výhradne po anglicky.
 */
const LANG_TAGS = [
  ['L', 'ISO-639-1'],
  ['l', 'en', 'ISO-639-1'],
];

// ── deterministické kľúče a čas ─────────────────────────────────────────────

function skFromSeed(seed) {
  return createHash('sha256').update(seed, 'utf8').digest();
}

function skFromEnv(envName, seed) {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') return skFromSeed(seed);
  const hex = raw.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`${envName}: expected a 64-hex secp256k1 scalar, got ${JSON.stringify(raw)}`);
  }
  return Buffer.from(hex, 'hex');
}

// ten istý publisher kľúč ako scripts/seed-demo.mjs → papier patrí pod
// rovnakú identitu ako zvyšok demo datasetu (a adresa topicu sedí)
const SK_PUBLISHER = skFromEnv('SEED_PUBLISHER_SK_HEX', 'forum4ai-demo-publisher-v1');
const PK_PUBLISHER = getPublicKey(SK_PUBLISHER);

/** 2026-11-01 12:00:00 UTC — pevný základ, `created_at` = základ + 600 s */
const SEED_BASE = Math.floor(Date.UTC(2026, 10, 1, 12, 0, 0) / 1000);
const PUBLISHED_AT = SEED_BASE;
const CREATED_AT = SEED_BASE + 600;

// ── dáta papiera ────────────────────────────────────────────────────────────

const TITLE = 'Negentropy Gates: Replication and LWW Publishing for Scientific Papers on Nostr';
const SLUG = 'negentropy-gates-replication-and-lww-publishing-for-scientific-papers-on-nostr';
const ABSTRACT =
  'We replicate a gated Nostr forum and extend it with an addressable publication kind (30023) ' +
  'for scientific papers. Numbers, figures, tables, equations and citations are derived from the ' +
  'markdown body at render time, so the wire format stays plain markdown with one CSL-JSON fence. ' +
  'We measure publish latency across two relays and report the replication protocol.';

/** 5-prvkové author tagy — prázdne pole = '' (nie vynechaný prvok) */
const AUTHORS = [
  ['Jana Nováková', 'Institute of Networked Knowledge', PK_PUBLISHER, '0000-0002-1825-0097'],
  ['Wei Chen', 'NostrConf Track Committee', '', ''],
];

const TOPICS = ['nostr', 'science'];
const TOPIC_ADDRESS = `30020:${PK_PUBLISHER}:nostr`;

/**
 * CSL-JSON referencie. `id` = kľúč citácie, ktorú používa telo (`[@novak2026]`).
 * Položky sú úplné (type, title, author, issued, container-title), aby lint
 * nehlásil REFS_ITEM_INCOMPLETE, a všetky sú v tele citované (REF_UNCITED).
 */
const REFERENCES = [
  {
    type: 'article-journal',
    id: 'novak2026',
    title: 'Set-replication under eventual consistency in social relays',
    'container-title': 'Journal of Decentralized Publishing',
    author: [{ family: 'Nováková', given: 'J.' }],
    issued: { 'date-parts': [[2026, 3, 12]] },
    DOI: '10.5555/forum4ai.demo.1',
    volume: '14',
    page: '88-104',
  },
  {
    type: 'paper-conference',
    id: 'chen2025',
    title: 'Proof-of-work gates for write-restricted Nostr relays',
    'container-title': 'Proceedings of NostrConf 2025',
    author: [{ family: 'Chen', given: 'W.' }, { family: 'Berg', given: 'O.' }],
    issued: { 'date-parts': [[2025, 9]] },
  },
  {
    type: 'book',
    id: 'halvorsen2024',
    title: 'Publish or Perish: A Field Guide to Preprint Culture',
    publisher: 'Northlight Press',
    author: [{ family: 'Halvorsen', given: 'M.' }],
    issued: { 'date-parts': [[2024]] },
  },
  {
    type: 'report',
    id: 'winston2023',
    title: 'Relay diversity and the cost of a single write path',
    institution: 'Open Relay Observatory',
    author: [{ family: 'Winston', given: 'R.' }],
    issued: { 'date-parts': [[2023, 6]] },
    URL: 'https://example.org/reports/relay-diversity.pdf',
  },
];

const FENCE = '```';

/**
 * Telo. Poradie deklarácií určuje číslovanie (renderer aj lint počítajú
 * fig zárezy v poradí výskytu, potom {#…} v proze), preto:
 *   Obrázok 1 = fig=arch (mermaid), Obrázok 2 = fig=latency (chart),
 *   Tabuľka 1 = {#tbl:hops}, Rovnica 1 = {#eq:negentropy}.
 * Každá deklarácia je v proze aspoň raz odkazovaná a každá referencia
 * aspoň raz citovaná, aby lint vrátil práve nula varovaní.
 */
const BODY = [
  '## Introduction',
  '',
  'A forum that gates writes still has to answer how content replicates. The stack we',
  'replicate is in @fig:arch — a thin relay, an indexer and a gateway that broadcasts to',
  'two relays and requires one acknowledged write. The per-hop numbers are in',
  '@tbl:hops and the gate signal we replicate from [@novak2026] is in @eq:negentropy.',
  '',
  `${FENCE}mermaid fig=arch caption="Replication stack: gateway to two relays"`,
  'flowchart LR',
  '  ui[Web UI] --> gw[Gateway]',
  '  gw --> r1[Relay A]',
  '  gw --> r2[Relay B]',
  '  r1 --> ix[Indexer]',
  '  r2 --> ix',
  `${FENCE}`,
  '',
  'Table: Publish latency per hop, p50 over 200 runs {#tbl:hops}',
  '',
  '| hop | p50 (ms) | p99 (ms) |',
  '| --- | --- | --- |',
  '| gateway → relay A | 11 | 48 |',
  '| gateway → relay B | 14 | 61 |',
  '| indexer → board | 320 | 900 |',
  '',
  `$$ \\Delta_t = \\sum_{i=1}^{n} \\left( q_{i,t} - w_{i,t} \\right) $$ {#eq:negentropy}`,
  '',
  'where `q` is acknowledged writes and `w` is the write budget the gate allows. A',
  // audit 7.5 P2-13: `\Delta` bol v seede obalený backtickmi → renderoval
  // sa ako code chip (surový TeX), nie KaTeX. Inline `$…$` v paper móde
  // funguje (RichContent naťahuje remark-math bez ohľadu na mód), preto
  // sa opravuje SEED, nie renderer.
  'positive $\\Delta$ means the gate is saturated; we log it rather than drop the event,',
  'following the logging-first rollout in [@chen2025].',
  '',
  '## Method',
  '',
  'We replay the seeded corpus against two relays and record the time from `POST /events`',
  'to the row appearing on the board. Papers are addressable (`30023:<pubkey>:<d>`), so a',
  'revision replaces the previous one by LWW instead of appending a second copy — the',
  'property that makes a preprint server possible on a log without transactions',
  '[@halvorsen2024].',
  '',
  `${FENCE}chart fig=latency caption="p50 publish latency per hop"`,
  '{ "v": 1, "type": "bar", "x": { "label": "hop", "categories": ["relay A", "relay B", "board"] },',
  '  "y": { "label": "p50", "unit": "ms" }, "series": [{ "name": "p50 ms", "data": [11, 14, 320] }] }',
  `${FENCE}`,
  '',
  '## Results',
  '',
  'The distribution behind @fig:latency is unimodal; the board is the slow hop because the',
  'indexer polls in intervals. Single-relay deployments lose the diversity that [@winston2023]',
  'shows to be the cheapest availability insurance, which is why we keep two relays in the',
  'dev stack and require only one acknowledged write.',
  '',
  '## Discussion',
  '',
  'Numbers in this paper are produced by the renderer, not written by hand: the body carries',
  'only `fig=`, `{#tbl:…}` and `{#eq:…}` markers and `[@…]` keys, so a revision cannot drift',
  'out of sync with its own numbering. That is the whole argument for keeping the wire format',
  'plain markdown [@novak2026].',
  '',
].join('\n');

// ── tagy (zrkadlia buildPaperTags v packages/shared/src/paper.ts) ───────────

/**
 * Poradie tagov je dané shared helperom: `d`, `title`, `summary`,
 * `published_at`, `t`*, `author`*, `p` (author marker), `license`, `a`,
 * `version`, `doi`. NIP-32 labely pripájame až za nimi — podpis nasleduje.
 */
function buildTags() {
  const tags = [
    ['d', SLUG],
    ['title', TITLE],
    ['summary', ABSTRACT],
    ['published_at', String(PUBLISHED_AT)],
  ];
  for (const topic of TOPICS) tags.push(['t', topic]);
  for (const author of AUTHORS) tags.push(['author', ...author]);
  for (const author of AUTHORS) {
    if (author[2] !== '') tags.push(['p', author[2], '', 'author']);
  }
  tags.push(['license', 'CC-BY-4.0']);
  tags.push(['a', TOPIC_ADDRESS]);
  tags.push(['version', 'v1']);
  tags.push(['doi', '10.5555/forum4ai.demo.1']);
  return tags;
}

/** `buildPaperBody`: jeden ` ```references ` zárez na koncie teľa */
function buildContent() {
  const trimmed = BODY.replace(/\s+$/, '');
  return `${trimmed}\n\n${FENCE}references\n${JSON.stringify(REFERENCES, null, 2)}\n${FENCE}\n`;
}

// ── podpis + publish ────────────────────────────────────────────────────────

/**
 * NIP-13: `["nonce", <n>, <target>]` mení hash, takže hľadáme `n` od 1
 * dokým má id aspoň `powMin` nulových bitov. Deterministicky (od 1, krok 1)
 * — preto `created_at` + nájdený nonce dávajú VŽDY to isté `id`.
 *
 * Počet bitov počíta `getPow` z `nostr-tools/nip13`, teda tá istá
 * implementácia, na ktorej stojí politika relaya. `countLeadingZeroBits`
 * v `packages/shared/src/pow.ts` je jej krížovo overená kópia
 * (`packages/shared/test/pow.test.ts:50`), takže skript nepotrebuje
 * buildnutý `shared/dist` — stačí mu `nostr-tools`, ktorý má koreň.
 */
function minePowNonce(input, pubkey, powMin) {
  for (let nonce = 1; nonce <= POW_MAX_NONCE; nonce++) {
    const tags = [...input.tags, ['nonce', String(nonce), String(powMin)]];
    const id = getEventHash({
      kind: input.kind,
      created_at: input.created_at,
      tags,
      content: input.content,
      pubkey,
    });
    const bits = getPow(id);
    if (bits >= powMin) return { nonce, tags, bits, attempts: nonce };
  }
  throw new Error(
    `--pow ${String(powMin)}: nedosiahli sme ${String(powMin)} nulových bitov v ${String(POW_MAX_NONCE)} nonce`,
  );
}

/**
 * Podpíš + kontrola. `powMin > 0` pridá vyťažený `nonce` tag PRED podpisom
 * (nonce vstupuje do hashu, takže ho nemožno pridať po podpisu).
 */
function sign(secretKey, kind, tags, content, createdAt, powMin = DEFAULT_POW) {
  const pubkey = getPublicKey(secretKey);
  let signedTags = tags;
  let pow = null;
  if (powMin > 0) {
    const mined = minePowNonce({ kind, created_at: createdAt, tags, content }, pubkey, powMin);
    signedTags = mined.tags;
    pow = { min: powMin, bits: mined.bits, nonce: mined.nonce, attempts: mined.attempts };
  }
  const ev = finalizeEvent({ kind, created_at: createdAt, tags: signedTags, content }, secretKey);
  const computed = getEventHash({
    kind,
    created_at: createdAt,
    tags: signedTags,
    content,
    pubkey: ev.pubkey,
  });
  if (computed !== ev.id) throw new Error('id nezodpoveda hashu obsahu');
  if (verifyEvent(ev) !== true) throw new Error(`verifyEvent zlyhal (kind ${String(kind)})`);
  if (powMin > 0) {
    const bits = getPow(ev.id);
    if (bits < powMin) throw new Error(`PoW has only ${String(bits)} bits, ${String(powMin)} were required`);
    pow.bits = bits;
  }
  return { ev, pow };
}

/** `POST /events` s retry na prechodné zlyhania (424 kvórum, 5xx, sieť) */
async function publish(event) {
  let lastError = 'unreachable';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${GW}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok === true && body.ok === true) return body;
      if (res.status === 424 || res.status >= 500) {
        lastError = `HTTP ${String(res.status)} ${JSON.stringify(body)}`;
        await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
        continue;
      }
      throw new Error(`HTTP ${String(res.status)} ${JSON.stringify(body)}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('HTTP 4')) throw error;
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw new Error(`publish zlyhal po 4 pokusoch: ${lastError}`);
}

async function readBack(id) {
  const res = await fetch(`${GW}/papers/${id}`);
  if (res.ok !== true) throw new Error(`GET /papers/${id.slice(0, 12)}… → HTTP ${String(res.status)}`);
  return await res.json();
}

// ── main ────────────────────────────────────────────────────────────────────

const tags = buildTags();
const content = buildContent();
const { ev: event, pow } = sign(SK_PUBLISHER, KIND_PAPER, [...tags, ...LANG_TAGS], content, args.createdAt ?? CREATED_AT, args.pow);

if (args.json === true) {
  // len event na stdout — kvôli testovaniu (`| node -e …lintPaper…`)
  console.log(JSON.stringify(event));
  process.exit(0);
}

console.log(`gateway:   ${GW}`);
console.log(`publisher: ${PK_PUBLISHER}`);
console.log(`address:   ${String(KIND_PAPER)}:${PK_PUBLISHER}:${SLUG}`);
console.log(`id:        ${event.id}`);
console.log(`size:      ${String(Buffer.byteLength(JSON.stringify(event), 'utf8'))} B`);
console.log(
  pow === null
    ? `pow:       0 bits (no PoW — a relay with RELAY_POW_MIN > 0 would reject the event, use --pow 18)`
    : `pow:       ${String(pow.bits)} bits (nonce ${String(pow.nonce)}, ${String(pow.attempts)} hashes, target ${String(pow.min)})`,
);

/**
 * Self-lint cez zdieľanú implementáciu (packages/shared/dist/paper.js), teda
 * TÚ ISTÚ funkciu, čo volá gateway — chyby teda odhalíme tu a nie ako 400 od
 * relayu. Ak nie je buildnutý dist, len to nahlásime a publish skúsime.
 */
async function selfLint() {
  try {
    const mod = await import('../packages/shared/dist/paper.js');
    const verdict = mod.lintPaper(mod.paperInputFromEvent(event));
    // shared má na výstupe wire meno `warning_codes` (gateway ho posielava
    // ako `paper_warning_codes`)
    return {
      available: true,
      ok: verdict.ok,
      errors: verdict.errors,
      codes: verdict.codes,
      warnings: verdict.warnings,
      warningCodes: verdict.warning_codes,
    };
  } catch (error) {
    return { available: false, note: error instanceof Error ? error.message : String(error) };
  }
}

const lint = await selfLint();
if (lint.available === true) {
  if (lint.ok !== true) {
    console.error(`lint:      ERRORS ${lint.codes.join(', ')}`);
    for (const message of lint.errors) console.error(`           - ${message}`);
    process.exit(1);
  }
  console.log(
    lint.warningCodes.length > 0
      ? `lint:      ok with warnings ${lint.warningCodes.join(', ')}`
      : 'lint:      ok, no warnings',
  );
} else {
  console.log(`lint:      skipped (shared dist not built: ${lint.note})`);
}

if (args.dryRun === true) {
  console.log('\n--dry-run: not posting; the event is signed and verified');
  process.exit(0);
}

const posted = await publish(event);
const okRelays = Array.isArray(posted.results) ? posted.results.filter((r) => r.ok === true).length : '?';
console.log(
  `publish:   ok=${String(posted.ok)} quorum=${String(posted.quorum_met)} ` +
    `relays=${String(okRelays)}/${String(Array.isArray(posted.results) ? posted.results.length : '?')}`,
);
if (Array.isArray(posted.paper_warning_codes) && posted.paper_warning_codes.length > 0) {
  console.log(`gateway:   warnings ${posted.paper_warning_codes.join(', ')}`);
} else {
  console.log('gateway:   no warnings');
}

// board potrebuje indexer; ten becí v intervaloch, takže čítanie skúšame krátko
let detail = null;
for (let attempt = 1; attempt <= 10 && detail === null; attempt++) {
  try {
    detail = await readBack(event.id);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
if (detail === null) {
  console.log('read-back: GET /papers/:id is not in the index yet (the indexer has not caught up)');
} else {
  const verdict = detail.lint ?? {};
  console.log(
    `read-back: ok, title=${JSON.stringify(detail.paper?.title ?? '')} ` +
      `addr=${detail.addr ?? '-'} lint.ok=${String(verdict.ok ?? '?')}`,
  );
}

console.log(`\nevent id for purge: ${event.id}`);
