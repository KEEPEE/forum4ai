#!/usr/bin/env node
/**
 * Indexer CLI (F4AI-13, S7) — `node dist/cli.js`.
 *
 * Commands:
 *   (no argument)     run the ingestor — backfill, live subscribe, anti-entropy
 *   `search <query>`  FTS5 query against an existing DB (`--limit`, `--kind`, `--json`)
 *   `stats`           counts / kind distribution / FTS index state
 *
 * Configuration exclusively via env vars (`INDEXER_*`, list in `config.ts`).
 * Graceful shutdown: SIGINT/SIGTERM → `ingestor.stop()` → `pool.close()` →
 * `db.close()` → exit 0 (WAL is checkpointed on close).
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { buildIndexerRuntime, resolveIndexerConfig } from './config.js';
import { openIndexerDb } from './db.js';

function parseFlags(args: string[]): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = 'true';
      }
      continue;
    }
    rest.push(arg);
  }
  return { flags, rest };
}

/** `search` / `stats` pracujú s DB bez siete — otvárame ich readonly. */
function runReadCommand(command: string, args: string[]): number {
  const config = resolveIndexerConfig();
  const { flags, rest } = parseFlags(args);
  const db = openIndexerDb(config.dbPath, { readonly: true });
  try {
    if (command === 'stats') {
      console.log(JSON.stringify(db.stats(), null, 2));
      return 0;
    }
    const query = rest.join(' ').trim();
    if (query === '') {
      console.error(
        'pouzitie: indexer search "<dotaz>" [--limit N] [--kind K] [--lang en|sk|any] [--json]',
      );
      return 2;
    }
    const kinds = flags['kind'] !== undefined ? [Number(flags['kind'])] : undefined;
    const limit = flags['limit'] !== undefined ? Number(flags['limit']) : 10;
    // F4AI-2b2: filter podľa NIP-32 jazyka; `any`/vynechané = všetky
    const lang = flags['lang'] !== undefined && flags['lang'] !== 'any' ? flags['lang'] : undefined;
    const hits = db.search(query, { kinds, limit, lang, snippet: true });
    if (flags['json'] === 'true') {
      console.log(JSON.stringify({ query, lang: lang ?? 'any', hits }, null, 2));
      return 0;
    }
    console.log(
      `FTS5 dotaz "${query}"${lang !== undefined ? ` (lang=${lang})` : ''} — ${String(hits.length)} najdenych:`,
    );
    for (const hit of hits) {
      console.log(
        `  kind=${String(hit.kind)} lang=${hit.lang ?? '-'} created_at=${String(hit.created_at)} id=${hit.id.slice(0, 16)}… score=${hit.score.toFixed(3)}`,
      );
      console.log(`    ${(hit.snippet ?? hit.content).slice(0, 160).replaceAll('\n', ' ')}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

async function runIngestor(): Promise<number> {
  // D4: adresár DB musime vytvorit PRED `buildIndexerRuntime()` — ta otvara
  // SQLite a na neexistujuci adresar zhodi proces skoricu ("unable to open
  // database file"), prave pri prveom spusteni v kontajneri.
  const config = resolveIndexerConfig();
  if (config.dbPath !== ':memory:') {
    mkdirSync(dirname(resolve(config.dbPath)), { recursive: true });
  }
  const runtime = buildIndexerRuntime();
  const { db, pool, ingestor } = runtime;

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`[indexer] ${signal} — uzatvaram ingestor…`);
    ingestor.stop();
    if (typeof pool.close === 'function') pool.close();
    db.close();
    console.log('[indexer] zatvorene (DB + pool)');
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const statusTimer = setInterval(() => {
    console.log(
      `[indexer] status: ${JSON.stringify(ingestor.snapshot())} db=${JSON.stringify(ingestor.stats())}`,
    );
  }, 60_000);
  if (typeof (statusTimer as unknown as { unref?: () => void }).unref === 'function') {
    (statusTimer as unknown as { unref: () => void }).unref();
  }

  await ingestor.start();
  console.log(
    `[indexer] bezim: db=${config.dbPath} relaye=${config.relayUrls.join(', ')} anti-entropia=${String(Math.round(config.antiEntropyIntervalMs / 1000))}s (Ctrl-C pre stop)`,
  );
  return 0;
}

const argv = process.argv.slice(2);
const command = argv[0];

if (command === 'search' || command === 'stats') {
  process.exitCode = runReadCommand(command, argv.slice(1));
} else {
  runIngestor().catch((err: unknown) => {
    console.error('[indexer] fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });
}
