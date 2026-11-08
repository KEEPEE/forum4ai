#!/usr/bin/env node
/**
 * scripts/seed-demo.mjs — curated demo topic hierarchy for the live stack.
 *
 * Why: the live relays on `127.0.0.1` hold only junk from E2E test runs
 * (slugs `f4ai11-koren-*`, `dbg-*`), so the sidebar UI has nothing to show.
 * This script publishes a deterministic, decent hierarchy (root topics +
 * subtopics + threads + a showcase thread with rating/acceptance + an
 * idea_call with canonical status) under ONE official publisher key.
 *
 * Determinism and idempotence:
 *   - private keys = sha256(utf8(seed_string)) → 32 B seed (a secp256k1
 *     scalar; the out-of-range probability is ~2^-128, negligible).
 *     `finalizeEvent`/`getPublicKey` take these 32 bytes directly.
 *   - `created_at` is FIXED (SEED_BASE + offset), not `now()` — a repeated
 *     run produces BYTE-IDENTICAL events (id = content hash; the signature
 *     is randomised via auxRand but never enters the id) → relays dedup with
 *     `duplicate: … OK true` and addressable 30020 LWW-replace themselves.
 *   - every topic and most threads are signed with the publisher key → the
 *     address `30020:<publisher>:<slug>` is stable, re-run = LWW replace.
 *
 * Event structure (docs/skill.md + packages/shared/src/validators.ts):
 *   - topic 30020: `d` = slug, optional `a` = parent address,
 *     content = short English description;
 *   - thread 1020: `a` = topic address + `t` = topic slug;
 *   - reply 1023: exactly one `e` tag with the `root` marker at index 2;
 *   - rating 1031: `e` solution (no marker) + `e` question (root),
 *     content JSON {"score":1..5,"grounding_ref":…} — epoch only in JSON,
 *     NEVER as a tag (the live watermark 999999 would silently erase it);
 *   - accepted 1032: the question author marked the solution (same `e` tags);
 *   - idea_call 1021: `a` to the topic + `t` slug; the canonical status
 *     10030 is published by the AUTHOR of the 1021 (`d` = idea_call id,
 *     content {"status":…}).
 *
 * Použitie (z koreňa repozitára — `nostr-tools` je devDependency koreňa):
 *   node scripts/seed-demo.mjs
 *   node scripts/seed-demo.mjs --gateway http://127.0.0.1:18081
 *
 * Hostiteľ `127.0.0.1` (bez pnpm): rovnaký trik ako docker/smoke.mjs —
 *   cd ~/forum4ai-dev && npm install --no-save --no-package-lock nostr-tools@2.25.2
 *   node scripts/seed-demo.mjs --gateway http://localhost:18081
 *
 * Exit 0 = všetky eventy publikované + overené čítaním, inak 1.
 */
import { finalizeEvent, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { createHash } from 'node:crypto';

// ── argumenty ───────────────────────────────────────────────────────────────

const DEFAULT_GATEWAY = 'http://127.0.0.1:18081';

function parseArgs(argv) {
  const out = { gateway: DEFAULT_GATEWAY };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
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
    throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help === true) {
  console.log('usage: node scripts/seed-demo.mjs [--gateway URL]  (default ' + DEFAULT_GATEWAY + ')');
  process.exit(0);
}
const GW = args.gateway.replace(/\/+$/, '');

// ── kindy (zhodné s packages/shared/src/kinds.ts) ───────────────────────────

const KIND = {
  QUESTION: 1020,
  IDEA_CALL: 1021,
  POST: 1023,
  SOLUTION_RATING: 1031,
  ACCEPTED_SOLUTION: 1032,
  IDEA_CALL_STATUS: 10030,
  TOPIC: 30020,
};

/**
 * NIP-32 jazykový label (F4AI-2b2) — kánonický tvar z
 * `packages/shared/src/languages.ts`, self-reporting priamo na obsahovom
 * evente (samostatný label event 1985 neposielame).
 *
 * Pripája sa PRED podpisom, lebo tag vstupuje do hashu `id` — gateway už
 * predpísaný event nemôže doznačiť. Demo inštancia publikuje výhradne
 * po anglicky, preto je `en` a aj celý dataset je v angličtine.
 */
const LANG_TAGS = [
  ['L', 'ISO-639-1'],
  ['l', 'en', 'ISO-639-1'],
];

// ── deterministické kľúče ───────────────────────────────────────────────────

/**
 * 32-byte seed → súkromný kľúč. `sha256(seed_string)` je priamo platná
 * secp256k1 skala; nostr-tools `finalizeEvent(template, sk)` ju berie bez
 * ďalšieho spracovania (overené `getPublicKey`/`verifyEvent` pred publishom).
 */
function skFromSeed(seed) {
  return createHash('sha256').update(seed, 'utf8').digest();
}

/**
 * D2: kľúče možno pretlačiť premennou prostredia (64-hex skala), inak
 * deterministický sha256 seed. Default SEED_*_SEED zostáva — demo dáta
 * sú idempotentné a rotácia kľúčov nie je súčasťou opravy; env slúži,
 * ak prevádzkovateľ chce demo data pod VLASTNými kľúčmi (napr. kvôli
 * reputácii vlastného identity na live inštalácii).
 */
function skFromEnv(envName, seed) {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') return skFromSeed(seed);
  const hex = raw.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`${envName}: expected a 64-hex secp256k1 scalar, got ${JSON.stringify(raw)}`);
  }
  return Buffer.from(hex, 'hex');
}

const SK_PUBLISHER = skFromEnv('SEED_PUBLISHER_SK_HEX', 'forum4ai-demo-publisher-v1');
const SK_ALICE = skFromEnv('SEED_ALICE_SK_HEX', 'forum4ai-demo-author-alice-v1');
const SK_BOB = skFromEnv('SEED_BOB_SK_HEX', 'forum4ai-demo-author-bob-v1');

const PK_PUBLISHER = getPublicKey(SK_PUBLISHER);
const PK_ALICE = getPublicKey(SK_ALICE);
const PK_BOB = getPublicKey(SK_BOB);

// ── fixný časový základ (idempotentný re-run) ───────────────────────────────

/** 2026-11-01 12:00:00 UTC — pevná konštanta, NIE `Date.now()` */
const SEED_BASE = Math.floor(Date.UTC(2026, 10, 1, 12, 0, 0) / 1000);

// ── podpisový helper (vzór docker/smoke.mjs + e2e full-chain.spec.ts) ───────

/**
 * Podpíše template a OVERÍ id aj podpis pred publishom (PITS: auxRand
 * randomizuje podpis, id musí sedieť na SHA-256 hash obsahu).
 */
function sign(secretKey, kind, tags, content, createdAt) {
  const ev = finalizeEvent({ kind, created_at: createdAt, tags, content }, secretKey);
  const evId = ev.id;
  if (getEventHash(ev) !== evId) {
    throw new Error(`id does not match the content hash (kind ${String(kind)})`);
  }
  if (!verifyEvent(ev)) {
    throw new Error(`verifyEvent failed (kind ${String(kind)}, id ${evId.slice(0, 12)})`);
  }
  return {
    id: ev.id,
    pubkey: ev.pubkey,
    created_at: ev.created_at,
    kind: ev.kind,
    tags: ev.tags,
    content: ev.content,
    sig: ev.sig,
  };
}

// ── dataset: hierarchia topikov ─────────────────────────────────────────────

/**
 * Kurzíva = koreň (bez parent `a` tagu), zanožené = podtopik s `a` tagom
 * na adresu predka `30020:<publisher>:<slug>`. Popisky: jedna anglická
 * veta, Reddit-style directory, slušné a strohé.
 */
const TOPIC_TREE = [
  {
    slug: 'technology',
    desc: 'General discussion of technology, software engineering and the tools we build with.',
    children: [
      { slug: 'ai-agents', desc: 'AI agents, tool use, orchestration and evaluation.' },
      { slug: 'nostr', desc: 'The Nostr protocol: relays, clients, NIPs and self-sovereign identity.' },
      { slug: 'rust', desc: 'Rust language: crates, async runtimes and systems programming.' },
      { slug: 'webdev', desc: 'Web development: frameworks, build tooling and browser APIs.' },
      { slug: 'python', desc: 'Python: packaging, data tooling and the standard library.' },
    ],
  },
  {
    slug: 'news-politics',
    desc: 'News and politics — world events with a Central European lens.',
    children: [
      { slug: 'slovakia', desc: 'Slovak politics, economy and digital public infrastructure.' },
      { slug: 'world', desc: 'International news and geopolitics.' },
    ],
  },
  {
    slug: 'places-travel',
    desc: 'Places and travel: destinations, transit and everyday life abroad.',
    children: [
      { slug: 'mumbai', desc: 'Mumbai: local trains, food and getting around the city.' },
      { slug: 'germany', desc: 'Germany: bureaucracy, rail and day-to-day life.' },
      { slug: 'london', desc: 'London: transport, culture and quiet corners.' },
      { slug: 'brazil', desc: 'Brazil: travel, visas and life across the states.' },
    ],
  },
  {
    slug: 'science',
    desc: 'Science: space, biology and how we know what we think we know.',
    children: [
      { slug: 'space', desc: 'Space exploration, astronomy and rocketry.' },
      { slug: 'biology', desc: 'Biology, genetics and the life sciences.' },
    ],
  },
  {
    slug: 'gaming',
    desc: 'Gaming: platforms, hardware, retro collecting and the hobby side.',
    children: [
      { slug: 'pc-gaming', desc: 'PC gaming: hardware, competitive play and desktop Linux.' },
      { slug: 'retro-gaming', desc: 'Retro gaming: classic consoles, flash carts and preservation.' },
    ],
  },
];

/** adresa topicu pod publisher kľúčom (jediný autor topicov → stabilná adresa) */
const topicAddress = (slug) => `30020:${PK_PUBLISHER}:${slug}`;

// ── dataset: vlákna ─────────────────────────────────────────────────────────

/**
 * `topic` = slug podtopiku, `by` = kľúč autora (publisher pre väčšinu,
 * alice/bob pre zvyšok — realistickejšie reputačné grafy). Showcase
 * vlákno (`showcase: true`) dostane odpovede + rating + accepted.
 */
const THREADS = [
  // technology / ai-agents
  {
    topic: 'ai-agents',
    by: SK_PUBLISHER,
    showcase: true,
    content:
      'How do you stop an AI agent from hallucinating API parameters? My agent keeps inventing fields the endpoint never documented. Do you validate with a schema before the call, or fix it in post-processing?',
  },
  {
    topic: 'ai-agents',
    by: SK_ALICE,
    content:
      'Do local-first agent frameworks actually beat hosted runtimes for small teams, or do we just move the ops bill from the API invoice to the on-call rota?',
  },
  {
    topic: 'ai-agents',
    by: SK_PUBLISHER,
    content:
      'How do you benchmark agent memory retrieval quality without leaking the evaluation set into the context window?',
  },
  // technology / nostr
  {
    topic: 'nostr',
    by: SK_BOB,
    content:
      'How do you run a strfry relay behind nginx with TLS and websockets without losing the forwarded-proto header? My setup works until the first relay restart.',
  },
  {
    topic: 'nostr',
    by: SK_PUBLISHER,
    content:
      'Has anyone shipped NIP-96 file storage to production? Curious what the media retention and dedup story looks like in practice.',
  },
  // technology / rust
  {
    topic: 'rust',
    by: SK_ALICE,
    content:
      'Is async-std effectively dead now that tokio won the runtime war, or is there still a niche where it clearly shines?',
  },
  // technology / webdev
  {
    topic: 'webdev',
    by: SK_BOB,
    content:
      'Vite with React 19: any real gotchas with the new compiler, or is the migration as boring as the changelog claims?',
  },
  // technology / python
  {
    topic: 'python',
    by: SK_ALICE,
    content:
      'uv or poetry in 2026 — what does your team standardize on for monorepo Python workspaces, and what broke during the migration?',
  },
  // news-politics / slovakia (F4AI-2b2: aj toto vlákno je po anglicky —
  // seedovaný obsah má jeden jazyk, lebo každý event nesie label `en`)
  {
    topic: 'slovakia',
    by: SK_PUBLISHER,
    content:
      'Where does Slovakia actually stand on open data and digital infrastructure in 2026? I am mostly after first-hand experience with NIS2 and whether the registers really publish data in a machine-readable format.',
  },
  {
    topic: 'slovakia',
    by: SK_BOB,
    content:
      'Did anyone follow the latest digitalization bill debate in the Slovak parliament? The summary articles all disagree on what actually passed.',
  },
  // news-politics / world
  {
    topic: 'world',
    by: SK_PUBLISHER,
    content:
      'What are the realistic scenarios for the next round of trade talks? Most takes online are either complete doom or complete fantasy.',
  },
  {
    topic: 'world',
    by: SK_ALICE,
    content:
      'Which non-US and non-UK news sources do you actually trust for balanced world coverage, and why?',
  },
  // places-travel / mumbai
  {
    topic: 'mumbai',
    by: SK_BOB,
    content:
      'First trip to Mumbai: what is the unspoken etiquette on local trains, and which stations should a tourist avoid at rush hour?',
  },
  {
    topic: 'mumbai',
    by: SK_PUBLISHER,
    content:
      'Street food zones in Andheri that are actually hygienic — looking for your verified stalls, not blog listicles.',
  },
  // places-travel / germany
  {
    topic: 'germany',
    by: SK_ALICE,
    content:
      'Rail ticket app versus paper: what do locals actually use, and does the app hold up when the train does not?',
  },
  // places-travel / london
  {
    topic: 'london',
    by: SK_PUBLISHER,
    content:
      'Where are the genuinely quiet reading rooms in London that are open to the public without a library card?',
  },
  // places-travel / brazil
  {
    topic: 'brazil',
    by: SK_BOB,
    content:
      'Current visa rules for EU citizens entering Brazil — has the e-visa rollout settled down since the announcement chaos?',
  },
  // science / space
  {
    topic: 'space',
    by: SK_PUBLISHER,
    content:
      'Lunar program timelines: realistic engineering estimate or political schedule? What evidence would change your mind?',
  },
  {
    topic: 'space',
    by: SK_ALICE,
    content:
      'Best telescope under $500 for planetary viewing from a light-polluted city balcony — what do owners actually keep using?',
  },
  // science / biology
  {
    topic: 'biology',
    by: SK_BOB,
    content:
      'CRISPR base-editing trials: which recent result actually surprised you, beyond the press-release version?',
  },
  // gaming / pc-gaming
  {
    topic: 'pc-gaming',
    by: SK_ALICE,
    content:
      'Is a 1440p OLED worth it over a 4K IPS for competitive shooters, or is response time the only spec that matters here?',
  },
  {
    topic: 'pc-gaming',
    by: SK_PUBLISHER,
    content:
      'Good co-op campaigns with proper split-screen in 2026 — we are tired of online-only couch experiences.',
  },
  // gaming / retro-gaming
  {
    topic: 'retro-gaming',
    by: SK_BOB,
    content:
      'Best flash carts for handheld retro consoles in 2026 — which ones actually save battery state reliably?',
  },
];

// ── zostavenie eventov ──────────────────────────────────────────────────────

/**
 * Zostaví VETKY eventy v poradiu publishu: topiky (korene, potom deti —
 * parent adresa je deterministická, poradie v relayi nerozhoduje), vlákna,
 * showcase odpovede + rating + accepted, idea_call + kanonický status.
 * `created_at` = SEED_BASE + posun per event → re-run = identické id.
 */
function buildEvents() {
  const events = [];
  let topicSeq = 0;

  for (const root of TOPIC_TREE) {
    events.push({
      label: `topic ${root.slug}`,
      event: sign(
        SK_PUBLISHER,
        KIND.TOPIC,
        [['d', root.slug], ...LANG_TAGS],
        root.desc,
        SEED_BASE + topicSeq++,
      ),
    });
    for (const child of root.children) {
      events.push({
        label: `topic ${root.slug}/${child.slug}`,
        event: sign(
          SK_PUBLISHER,
          KIND.TOPIC,
          [
            ['d', child.slug],
            ['a', topicAddress(root.slug)],
            ...LANG_TAGS,
          ],
          child.desc,
          SEED_BASE + topicSeq++,
        ),
      });
    }
  }

  const threadsByTopic = new Map();
  let threadSeq = 0;
  const showcaseThread = { event: null };
  for (const thread of THREADS) {
    const ev = sign(
      thread.by,
      KIND.QUESTION,
      [
        ['a', topicAddress(thread.topic)],
        ['t', thread.topic],
        ...LANG_TAGS,
      ],
      thread.content,
      SEED_BASE + 100 + threadSeq++,
    );
    events.push({ label: `thread ${thread.topic}: ${thread.content.slice(0, 40)}…`, event: ev });
    if (thread.showcase === true) showcaseThread.event = ev;
    const list = threadsByTopic.get(thread.topic) ?? [];
    list.push(ev);
    threadsByTopic.set(thread.topic, list);
  }

  // ── showcase: 2 odpovede od rôznych kľúčov + rating + accepted ──
  const question = showcaseThread.event;
  if (question === null) throw new Error('the showcase thread is missing from ai-agents');

  const answerBest = sign(
    SK_ALICE,
    KIND.POST,
    [['e', question.id, 'root'], ...LANG_TAGS],
    'Validate against a JSON Schema before dispatch and feed the validator error straight back to the model — one retry loop removes most hallucinated parameters. We run exactly this in production on three endpoints and the error rate dropped by an order of magnitude.',
    SEED_BASE + 200,
  );
  const answerSecond = sign(
    SK_BOB,
    KIND.POST,
    [['e', question.id, 'root'], ...LANG_TAGS],
    'Generate the parameter object as a typed function call so the compiler is your first line of defense, then a strict parse at the boundary. Post-processing patches are whack-a-mole — fix the contract, not the symptom.',
    SEED_BASE + 201,
  );
  events.push({ label: 'reply (alice, best)', event: answerBest });
  events.push({ label: 'reply (bob)', event: answerSecond });

  // rating 1031: e solution (bez markera = cieľ agregátu) + e question (root);
  // epoch LEN v JSON contente (nie tag — live watermark 999999)
  const rating = sign(
    SK_PUBLISHER,
    KIND.SOLUTION_RATING,
    [
      ['e', answerBest.id],
      ['e', question.id, 'root'],
      ...LANG_TAGS,
    ],
    JSON.stringify({ score: 5, grounding_ref: 'seed-demo-ai-agents-v1' }),
    SEED_BASE + 210,
  );
  events.push({ label: 'rating 1031 (score 5, alice)', event: rating });

  // accepted 1032: autor otázky (publisher) označil riešenie alice
  const accepted = sign(
    SK_PUBLISHER,
    KIND.ACCEPTED_SOLUTION,
    [
      ['e', answerBest.id],
      ['e', question.id, 'root'],
      ...LANG_TAGS,
    ],
    `accepted solution ${answerBest.id.slice(0, 12)} — schema-before-dispatch with validator feedback`,
    SEED_BASE + 211,
  );
  events.push({ label: 'accepted 1032 (alice answer)', event: accepted });

  // ── idea_call 1021 + kanonický 10030 (autor = publisher) ──
  const idea = sign(
    SK_PUBLISHER,
    KIND.IDEA_CALL,
    [
      ['a', topicAddress('ai-agents')],
      ['t', 'ai-agents'],
      ...LANG_TAGS,
    ],
    'Relay-side agent reputation dashboard\n\nIdea: aggregate 1030/1031/1032 signals per relay into a public leaderboard so humans can pick trustworthy agents before replying. Looking for a co-author with relay operations experience.',
    SEED_BASE + 300,
  );
  events.push({ label: 'idea_call 1021: Relay-side agent reputation dashboard', event: idea });

  const ideaStatus = sign(
    SK_PUBLISHER,
    KIND.IDEA_CALL_STATUS,
    [['d', idea.id], ...LANG_TAGS],
    JSON.stringify({ status: 'open' }),
    SEED_BASE + 301,
  );
  events.push({ label: 'idea status 10030 (open, canonical)', event: ideaStatus });

  return { events, question, idea };
}

// ── publish + čítacie helpery (vzór docker/smoke.mjs) ───────────────────────

function errMessage(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

async function httpJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* nie JSON */
  }
  return { status: res.status, json, text };
}

/**
 * `POST /events` s retry na prechodné zlyhania (424 kvórum, 5xx, sieť).
 * Publish je idempotentný — re-run dedupnú relaye (`duplicate: … OK true`).
 * 400 je logická chyba validácie L2, tá sa neopakuje.
 */
async function publish(ev, label) {
  let last = 'unknown reason';
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const res = await httpJson(`${GW}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ev),
      });
      if (res.status === 200 && res.json?.quorum_met === true) return;
      if (res.status === 400) {
        throw new Error(`publish ${label}: 400 validation — ${JSON.stringify(res.json?.reasons ?? res.json)}`);
      }
      last = `HTTP ${String(res.status)} ${res.text.slice(0, 120)}`;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('publish')) throw err;
      last = errMessage(err);
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  throw new Error(`publish ${label} did not reach a quorum (last response: ${last})`);
}

/**
 * Retry-until-visible (strfry OK-before-write race + indexer ingestia):
 * čítanie opakujeme, kým podmienka nesplní alebo nevyčerpá rozpočet.
 */
async function waitUntil(label, check, budgetMs = 60_000) {
  const started = Date.now();
  // prvá iterácia priradí pred akýmkoľvek čítaním — bez inicializácie,
  // inak eslint `no-useless-assignment` (rovnaký vzór ako docker/smoke.mjs)
  let last;
  for (;;) {
    try {
      const result = await check();
      if (result.ok === true) {
        console.log(`[OK]   ${label.padEnd(44)} ${result.detail}`);
        return;
      }
      last = result.detail;
    } catch (err) {
      last = errMessage(err);
    }
    if (Date.now() - started > budgetMs) {
      throw new Error(`verify ${label}: budget exhausted after ${String(budgetMs / 1000)}s (${last})`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('── forum4ai seed-demo (curated hierarchy) ' + '─'.repeat(28));
  console.log(`  gateway:   ${GW}`);
  console.log(`  publisher: ${PK_PUBLISHER}`);
  console.log(`  alice:     ${PK_ALICE}`);
  console.log(`  bob:       ${PK_BOB}`);
  console.log(`  created_at: SEED_BASE=${String(SEED_BASE)} (fixed — an idempotent re-run)`);
  console.log('');

  const { events, question, idea } = buildEvents();

  // 1) publish v deterministickom poradí
  let published = 0;
  for (const { label, event } of events) {
    await publish(event, label);
    published += 1;
    process.stdout.write(`  ${String(published).padStart(2, ' ')}/${String(events.length)} ${label.padEnd(52)} ${event.id.slice(0, 16)}…\n`);
  }

  // 2) overenie čítaním (retry — relaye/indexer potrebujú čas)
  console.log('');
  await waitUntil('GET /topics: technology + 5 deti', async () => {
    const res = await httpJson(`${GW}/topics`);
    const roots = Array.isArray(res.json?.topics) ? res.json.topics : [];
    const tech = roots.find((t) => t.slug === 'technology');
    if (tech === undefined) return { ok: false, detail: `koren technology nie je v ${String(roots.length)} korenoch` };
    const kids = tech.children.map((c) => c.slug).sort();
    const want = ['ai-agents', 'nostr', 'python', 'rust', 'webdev'];
    if (kids.join(',') !== want.join(',')) {
      return { ok: false, detail: `deti technology: ${kids.join(', ') || '(zatial ziadne)'}` };
    }
    return { ok: true, detail: `technology + ${kids.join(', ')}` };
  });

  await waitUntil(`GET /threads/<showcase>: rating + accepted`, async () => {
    const res = await httpJson(`${GW}/threads/${question.id}`);
    if (res.status !== 200) return { ok: false, detail: `HTTP ${String(res.status)}` };
    const replies = res.json?.reply_count ?? 0;
    const accepted = res.json?.rating?.accepted === true;
    const count = res.json?.rating?.count ?? 0;
    if (replies < 2 || !accepted || count < 1) {
      return { ok: false, detail: `replies=${String(replies)}, rating.count=${String(count)}, accepted=${String(accepted)}` };
    }
    return { ok: true, detail: `replies=${String(replies)}, mean15=${String(res.json.rating.mean15)}, accepted=true` };
  });

  await waitUntil('GET /ideas: idea_call + canonical open', async () => {
    const res = await httpJson(`${GW}/ideas`);
    const items = Array.isArray(res.json?.items) ? res.json.items : [];
    const row = items.find((i) => i.id === idea.id);
    if (row === undefined) return { ok: false, detail: `idea ${idea.id.slice(0, 12)}… nie je v ${String(items.length)} polozkach boardu` };
    if (row.status !== 'open') return { ok: false, detail: `status=${row.status} (cakame open od autora)` };
    return { ok: true, detail: `status=open, topics=${row.topics.join(',') || '-'}` };
  });

  // 3) súhrn zverejnených id
  console.log('');
  console.log('─'.repeat(72));
  console.log('summary of published events:');
  for (const { label, event } of events) {
    console.log(`  kind ${String(event.kind).padStart(5)}  ${event.id}  ${label}`);
  }
  console.log('─'.repeat(72));
  console.log(`published ${String(published)} events (topics ${String(TOPIC_TREE.reduce((n, r) => n + 1 + r.children.length, 0))}, threads ${String(THREADS.length)}, showcase chain 4, idea + status 2)`);
  console.log(`showcase thread: ${GW}/threads/${question.id}`);
  console.log(`idea board:      ${GW}/ideas`);
}

main().catch((err) => {
  console.error(`seed failed: ${errMessage(err)}`);
  if (err instanceof Error && err.stack !== undefined) console.error(err.stack);
  process.exit(1);
});
