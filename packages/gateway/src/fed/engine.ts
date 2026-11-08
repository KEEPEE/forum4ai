/**
 * Federation sync engine (Phase 6a, design Q5).
 *
 * Two directions, one instance:
 *
 *  PULL (reading other people's trees)
 *   `GET <upstream>/fed/events?since=<checkpoint>&limit=<n>&kinds=…`
 *   → we verify every event with `verifyFull` (signature + NIP-01 hash) → we
 *   store it in `remote_events` with `origin = <upstream id>` WITHOUT any
 *   transformation (no rewriting, no re-signing — a remote event is the
 *   author's signature, not our stamp) → we move the checkpoint on.
 *
 *  PUSH (sharing local content)
 *   local content events (1020–1032, 10030, 30020, 30023) go, once accepted by
 *   `POST /events`, into a queue per upstream and that queue is drained with
 *   `POST <upstream>/events`. A failure (network / 4xx / 5xx) is NOT a reason to
 *   throw the item away: it stays `pending` with exponential backoff and after
 *   `maxAttempts` it moves to the dead letter list (`dead`). The quorum of the
 *   local publish must not change because of it — the queue is a side effect.
 *
 * SPLIT-HORIZON (design Q5 + the 6a task): an event we fetched from somebody
 * (`remote_events` knows it) is NOT pushed back to the upstream. Without this
 * rule A→B→A would copy the same event endlessly. The second dedup is per
 * `(upstream_id, event_id)` — the same id is sent to the same upstream once.
 *
 * LOOP = one tick: per upstream first PULL, then PUSH, SEQUENTIALLY (no parallel
 * fan-out — on a dev machine with two instances a parallel round would only
 * compete for CPU and mask slow upstreams).
 */
import { FED_SYNC_KINDS, isFedSyncKind, verifyFull } from '@forum4ai/shared';
import type { NostrEvent } from '@forum4ai/shared';

import type { FedUpstreamConfig } from './config.js';
import type { FedQueueRow, FedQueueStats, FedUpstreamRow, RemoteTopicRow } from './db.js';
import type { FedDb } from './db.js';

/** defaulty — prepisujú sa env `GATEWAY_FED_*` (zoznam v `config.ts`) */
export const FED_INTERVAL_MS_DEFAULT = 30_000;
export const FED_PULL_LIMIT_DEFAULT = 200;
export const FED_PUSH_BATCH_DEFAULT = 50;
export const FED_BACKOFF_INITIAL_MS_DEFAULT = 1_000;
export const FED_BACKOFF_MAX_MS_DEFAULT = 600_000;
/** mŕtvy list po 12 pokusoch (~2 dni pri 10 min stropu backoffu) */
export const FED_MAX_ATTEMPTS_DEFAULT = 12;
export const FED_HTTP_TIMEOUT_MS_DEFAULT = 10_000;
/**
 * `done` položky fronty sú dôkaz, že push prebehol, nie pracovný zoznam:
 * bez kúrenia by `push_queue` rástla s každým vláknom navždy a každé
 * `GET /fed/state` by scanovalo čoraz väčšiu tabuľku. Mažú sa preto raz za
 * hodinu a len tie staršie ako 24 h (mŕtve listy MAŽE ČLOVEK — sú to
 * dôkazy o strate, nie šum).
 */
export const FED_PRUNE_INTERVAL_MS_DEFAULT = 60 * 60_000;
export const FED_PRUNE_KEEP_MS_DEFAULT = 24 * 60 * 60_000;

export interface FedEngineOptions {
  db: FedDb;
  /** konfigurácia upstreamov (z `GATEWAY_UPSTREAM_GATEWAYS`) */
  upstreams: readonly FedUpstreamConfig[];
  /** kindy pre PULL filter, default `FED_SYNC_KINDS` */
  kinds?: readonly number[];
  pullLimit?: number;
  pushBatch?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  maxAttempts?: number;
  httpTimeoutMs?: number;
  /** perioda kúrenia `done` položiek fronty (ms, 0 = bez kúrenia) */
  pruneIntervalMs?: number;
  /** ako dlho sa nechávajú `done` položky (ms) */
  pruneKeepMs?: number;
  /** injectable fetch — testy púšťajú dva in-process gatewaye bez siete */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** default true: `verifyFull` nad každým stiahnutým eventom */
  verify?: boolean;
  /**
   * Node role gating (F4AI-39, epic F4AI-35): a `seed` instance PULLs from
   * its upstreams but never PUSHes back, and `NODE_UPSTREAMS=off` turns both
   * directions off. Both default to true, so a deployment that sets no new
   * environment variable keeps the exact federation behavior it had before.
   */
  pullEnabled?: boolean;
  pushEnabled?: boolean;
  logger?: (line: string) => void;
  /** ms epoch */
  now?: () => number;
}

export interface PullSummary {
  upstream: string;
  ok: boolean;
  fetched: number;
  inserted: number;
  /** overenie `verifyFull` zlyhalo (podpis/hash) — neuložený event */
  invalid: number;
  /**
   * kind mimo `FED_SYNC_KINDS` — peer ho mal odfiltrovat `kinds=` parametrom,
   * ale neverime mu: 30028/30002/1055 su infra kindy, ktorych zdroj pravdy
   * je relay, nie gateway.
   */
  skipped: number;
  /** kurzor po PULLe (sekundy) */
  checkpoint: number;
  error: string;
}

export interface PushSummary {
  upstream: string;
  attempted: number;
  sent: number;
  failed: number;
  dead: number;
  error: string;
}

export interface TickSummary {
  pulled: PullSummary[];
  pushed: PushSummary[];
  skipped: boolean;
}

export interface FedUpstreamState {
  id: string;
  base_url: string;
  checkpoint: number;
  last_pull_at: number;
  last_success_at: number;
  last_error: string;
  pulled_events: number;
  remote_events: number;
  remote_topics: number;
  queue: FedQueueStats;
  dead_letters: Array<{ event_id: string; kind: number; attempts: number; last_error: string }>;
}

/**
 * Exponenciálny backoff s plným jitterom? Nie — **bez jitteru**, lebo
 * fronta je per upstream a jej položky idú v jednom kolečku; jitter by
 * len sťažil testovanie a dôvod, prečo sa položka skúša až o N ms.
 * `initial * 2^attempts`, orezané na `max`.
 */
export function backoffDelayMs(
  attempts: number,
  initialMs: number = FED_BACKOFF_INITIAL_MS_DEFAULT,
  maxMs: number = FED_BACKOFF_MAX_MS_DEFAULT,
): number {
  const exp = Math.min(20, Math.max(0, attempts));
  const delay = initialMs * Math.pow(2, exp);
  return Math.min(maxMs, Math.max(initialMs, delay));
}

/** spojí base URL gatewaya a fed cestu (necháva `/api` prefix verejných inštancií) */
export function fedEndpoint(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

export class FedEngine {
  private readonly db: FedDb;
  private readonly upstreams: readonly FedUpstreamConfig[];
  private readonly kinds: readonly number[];
  private readonly pullLimit: number;
  private readonly pushBatch: number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxAttempts: number;
  private readonly httpTimeoutMs: number;
  private readonly pruneIntervalMs: number;
  private readonly pruneKeepMs: number;
  private lastPruneAt = 0;
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly verify: boolean;
  private readonly pullEnabled: boolean;
  private readonly pushEnabled: boolean;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: FedEngineOptions) {
    this.db = options.db;
    this.upstreams = options.upstreams;
    this.kinds = options.kinds ?? FED_SYNC_KINDS;
    this.pullLimit = options.pullLimit ?? FED_PULL_LIMIT_DEFAULT;
    this.pushBatch = options.pushBatch ?? FED_PUSH_BATCH_DEFAULT;
    this.backoffInitialMs = options.backoffInitialMs ?? FED_BACKOFF_INITIAL_MS_DEFAULT;
    this.backoffMaxMs = options.backoffMaxMs ?? FED_BACKOFF_MAX_MS_DEFAULT;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? FED_MAX_ATTEMPTS_DEFAULT);
    this.httpTimeoutMs = options.httpTimeoutMs ?? FED_HTTP_TIMEOUT_MS_DEFAULT;
    this.pruneIntervalMs = Math.max(0, options.pruneIntervalMs ?? FED_PRUNE_INTERVAL_MS_DEFAULT);
    this.pruneKeepMs = Math.max(0, options.pruneKeepMs ?? FED_PRUNE_KEEP_MS_DEFAULT);
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.verify = options.verify ?? true;
    this.pullEnabled = options.pullEnabled ?? true;
    this.pushEnabled = options.pushEnabled ?? true;
    this.log = options.logger ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
  }

  get enabled(): boolean {
    return this.upstreams.length > 0;
  }

  /** parametre pre `GET /fed/state` a dokumentáciu */
  get params(): {
    kinds: readonly number[];
    pull_limit: number;
    push_batch: number;
    backoff_initial_ms: number;
    backoff_max_ms: number;
    max_attempts: number;
    http_timeout_ms: number;
    prune_interval_ms: number;
    prune_keep_ms: number;
  } {
    return {
      kinds: this.kinds,
      pull_limit: this.pullLimit,
      push_batch: this.pushBatch,
      backoff_initial_ms: this.backoffInitialMs,
      backoff_max_ms: this.backoffMaxMs,
      max_attempts: this.maxAttempts,
      http_timeout_ms: this.httpTimeoutMs,
      prune_interval_ms: this.pruneIntervalMs,
      prune_keep_ms: this.pruneKeepMs,
    };
  }

  /** zrovná tabuľku upstreamov s konfiguráciou (volá sa pri štarte) */
  syncConfig(): { added: string[]; updated: string[]; removed: string[] } {
    return this.db.syncUpstreams(this.upstreams);
  }

  listUpstreams(): FedUpstreamRow[] {
    return this.db.listUpstreams();
  }

  // ── PULL ─────────────────────────────────────────────────────────────────

  /**
   * Stiahne jednu dávku vzdialených eventov. Kurzor je `created_at`
   * (sekundy) a používa sa INKLUZÍVNE — pri jednom ticku môžeme dostať
   * časť sekundy, a preto dedupujeme per id (nie per kurzor).
   *
   * Saturovaná stránka (=`pullLimit`) bez jedinej novej riadky znamená,
   * že v jednej sekunde je viac eventov než dávka: vtedy kurzor posunieme
   * o 1 s, inak by sme sa v tej sekunde točili donekonečna.
   */
  async pullOnce(upstreamId: string): Promise<PullSummary> {
    const upstream = this.db.getUpstream(upstreamId);
    const summary: PullSummary = {
      upstream: upstreamId,
      ok: false,
      fetched: 0,
      inserted: 0,
      invalid: 0,
      skipped: 0,
      checkpoint: upstream?.checkpoint ?? 0,
      error: '',
    };
    if (upstream === null) {
      summary.error = `unknown upstream ${upstreamId}`;
      return summary;
    }

    const url = new URL(fedEndpoint(upstream.baseUrl, '/fed/events'));
    url.searchParams.set('since', String(upstream.checkpoint));
    url.searchParams.set('limit', String(this.pullLimit));
    url.searchParams.set('kinds', this.kinds.join(','));

    let body: unknown;
    try {
      const response = await this.httpFetch(url.toString(), { method: 'GET' });
      if (!response.ok) {
        summary.error = `GET ${url.pathname} → HTTP ${String(response.status)}`;
        this.db.recordPullAttempt(upstreamId, false, 0, summary.error);
        return summary;
      }
      body = await response.json();
    } catch (error) {
      summary.error = describeError(error);
      this.db.recordPullAttempt(upstreamId, false, 0, summary.error);
      this.log(`[fed] pull ${upstreamId}: ${summary.error}`);
      return summary;
    }

    const events = extractEvents(body);
    summary.fetched = events.length;
    let maxCreatedAt = upstream.checkpoint;
    for (const event of events) {
      // peer filterí `kinds=`, ale neveríme mu: infra kind (30028 writers,
      // 30002 outbox, 1055 claim) nesmie skončiť v `remote_events` — bol by
      // to cudzí pohľad na DOMÁCU politiku
      if (!isFedSyncKind(event.kind)) {
        summary.skipped += 1;
        if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at;
        continue;
      }
      if (this.verify && !verifyFull(event)) {
        summary.invalid += 1;
        // kurzor ide AJ cez neplatný event: podpis je deterministický,
        // takže event nikdy nebude platný a znova ho sťahovať znamená
        // donekonečna preverovať ten istý odpad
        if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at;
        continue;
      }
      if (this.db.insertRemoteEvent(upstreamId, event)) summary.inserted += 1;
      if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at;
    }

    // Saturovaná stránka bez novej riadky: v tejto sekunde je viac eventov,
    // než sa zmestilo do dávky, a všetky už poznáme. Bez posunu o 1 s by
    // engine donekonečna sťahoval TU ISTÚ stránku a k zvyšku sekundy by sa
    // nikdy nedostal. (Cena: preskočíme eventy tej istej sekundy nad limitom
    // — `since` je jediný kurzor, ktorý fed protokol má.)
    if (events.length >= this.pullLimit && summary.inserted === 0) {
      maxCreatedAt = Math.max(maxCreatedAt, upstream.checkpoint) + 1;
    }
    if (maxCreatedAt > upstream.checkpoint) this.db.bumpCheckpoint(upstreamId, maxCreatedAt);
    this.db.recordPullAttempt(upstreamId, true, summary.inserted, '');
    summary.ok = true;
    summary.checkpoint = maxCreatedAt;
    if (summary.inserted > 0 || summary.invalid > 0) {
      this.log(
        `[fed] pull ${upstreamId}: ${String(summary.inserted)}/${String(summary.fetched)} new` +
          (summary.invalid > 0 ? ` (${String(summary.invalid)} invalid)` : '') +
          ` checkpoint=${String(summary.checkpoint)}`,
      );
    }
    return summary;
  }

  // ── PUSH ─────────────────────────────────────────────────────────────────

  /**
   * Vybiduje dávku fronty. Každé zlyhanie je retry s backoffom; po
   * `maxAttempts` je položka `dead` a ďalej sa nepokúša (audit ju ukáže
   * v `GET /fed/state`).
   */
  async pushOnce(upstreamId: string): Promise<PushSummary> {
    const upstream = this.db.getUpstream(upstreamId);
    const summary: PushSummary = {
      upstream: upstreamId,
      attempted: 0,
      sent: 0,
      failed: 0,
      dead: 0,
      error: '',
    };
    if (upstream === null) {
      summary.error = `unknown upstream ${upstreamId}`;
      return summary;
    }
    const due = this.db.duePushes(upstreamId, this.pushBatch, this.now());
    const url = fedEndpoint(upstream.baseUrl, '/events');

    for (const row of due) {
      summary.attempted += 1;
      try {
        const response = await this.httpFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: row.payload,
        });
        if (response.ok) {
          this.db.markPushSent(upstreamId, row.eventId);
          // `last_success_at` a vymazanie `last_error` patria aj do PUSHu —
          // inak by `GET /fed/state` tvrdil, že upstream je ticho, pritom
          // mu práve došlo 50 vlákien (metrika by klamala)
          this.db.recordPushSuccess(upstreamId);
          summary.sent += 1;
          continue;
        }
        const detail = await readErrorDetail(response);
        const message = `POST ${new URL(url).pathname} → HTTP ${String(response.status)}${detail === '' ? '' : ` ${detail}`}`;
        this.registerFailure(row, message);
        summary.failed += 1;
        summary.error = message;
      } catch (error) {
        const message = describeError(error);
        this.registerFailure(row, message);
        summary.failed += 1;
        summary.error = message;
      }
    }
    summary.dead = this.db.queueStats(upstreamId, this.now()).dead;
    if (summary.attempted > 0) {
      this.log(
        `[fed] push ${upstreamId}: ${String(summary.sent)} sent, ${String(summary.failed)} failed` +
          (summary.error === '' ? '' : ` (last: ${summary.error})`),
      );
    }
    return summary;
  }

  private registerFailure(row: FedQueueRow, message: string): void {
    // `row.attempts` je hodnota PRED týmto pokusom, takže tento pokus je
    // pokus číslo `attempts + 1` — backoff rastie s číslom pokusu
    const attemptCount = row.attempts + 1;
    const delay = backoffDelayMs(attemptCount, this.backoffInitialMs, this.backoffMaxMs);
    const verdict = this.db.markPushFailure(
      row.upstreamId,
      row.eventId,
      message,
      this.now() + delay,
      this.maxAttempts,
    );
    this.db.recordPushError(row.upstreamId, message);
    if (verdict === 'dead') {
      this.log(
        `[fed] push ${row.upstreamId}: ${row.eventId.slice(0, 12)}… DEAD after ${String(this.maxAttempts)} attempts`,
      );
    }
  }

  /**
   * Zaradí AKCEPTOVANÝ lokálny event do fronty všetkých upstreamov.
   * Volá sa z `POST /events` PO kvóre — zlyhanie fronty nesmie zmeniť
   * odpoveď klientovi (dizajn Q5: „It doesn't affect B's quorum").
   */
  enqueueLocalEvent(event: NostrEvent): { queued: string[]; skipped: string[] } {
    const queued: string[] = [];
    const skipped: string[] = [];
    if (!isFedSyncKind(event.kind)) return { queued, skipped };
    for (const upstream of this.db.listUpstreams()) {
      const outcome = this.db.enqueuePush(upstream.id, event);
      if (outcome === 'queued') queued.push(upstream.id);
      else skipped.push(`${upstream.id}:${outcome}`);
    }
    return { queued, skipped };
  }

  // ── tick ─────────────────────────────────────────────────────────────────

  /** jedno kolečko: per upstream PULL potom PUSH, sekvenciálne */
  async tick(): Promise<TickSummary> {
    if (this.ticking) return { pulled: [], pushed: [], skipped: true };
    this.ticking = true;
    const result: TickSummary = { pulled: [], pushed: [], skipped: false };
    try {
      for (const upstream of this.db.listUpstreams()) {
        // role gating: a seed pulls, it never pushes back (F4AI-39)
        if (this.pullEnabled) result.pulled.push(await this.pullOnce(upstream.id));
        if (this.pushEnabled) result.pushed.push(await this.pushOnce(upstream.id));
      }
      this.prune();
    } finally {
      this.ticking = false;
    }
    return result;
  }

  /**
   * Kúrenie `done` položiek fronty (per tick, ale najviac raz za
   * `pruneIntervalMs`). `dead` položky sa nemažú nikdy — sú to dôkazy o
   * strate, ktoré operátor vidí v `GET /fed/state`.
   */
  prune(): number {
    if (this.pruneIntervalMs === 0) return 0;
    const nowMs = this.now();
    if (this.lastPruneAt !== 0 && nowMs - this.lastPruneAt < this.pruneIntervalMs) return 0;
    this.lastPruneAt = nowMs;
    const removed = this.db.pruneDone(this.pruneKeepMs);
    if (removed > 0) this.log(`[fed] prune: ${String(removed)} done položok fronty (> ${String(Math.round(this.pruneKeepMs / 3_600_000))} h)`);
    return removed;
  }

  /** spusti interval (0 = vypnute — testy a single-instance dev stack) */
  start(intervalMs: number): void {
    if (intervalMs <= 0 || this.timer !== null || this.upstreams.length === 0) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.log(`[fed] tick failed: ${describeError(error)}`);
      });
    }, intervalMs);
    // interval nesmie brániť exitu procesu (CLI to vie samo)
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  // ── stav a Network stromy ────────────────────────────────────────────────

  state(): FedUpstreamState[] {
    return this.db.listUpstreams().map((upstream) => ({
      id: upstream.id,
      base_url: upstream.baseUrl,
      checkpoint: upstream.checkpoint,
      last_pull_at: upstream.lastPullAt,
      last_success_at: upstream.lastSuccessAt,
      last_error: upstream.lastError,
      pulled_events: upstream.pulledEvents,
      remote_events: this.db.remoteCount(upstream.id),
      remote_topics: this.db.remoteTopicCount(upstream.id),
      queue: this.db.queueStats(upstream.id, this.now()),
      dead_letters: this.db.deadLetters(upstream.id, 5).map((row) => ({
        event_id: row.eventId,
        kind: row.kind,
        attempts: row.attempts,
        last_error: row.lastError,
      })),
    }));
  }

  /** reset kurzora — ďalší PULL číta od nuly (dedup per id drží, takže to nie je duplikát) */
  resync(upstreamId: string): boolean {
    const ok = this.db.resetCheckpoint(upstreamId);
    if (ok) this.log(`[fed] resync ${upstreamId}: checkpoint → 0`);
    return ok;
  }

  /** korene vzdialených stromov per upstream (sekcia „Network") */
  remoteTopics(limit = 50): Array<{
    id: string;
    base_url: string;
    topic_count: number;
    roots: RemoteTopicRow[];
  }> {
    return this.db.listUpstreams().map((upstream) => ({
      id: upstream.id,
      base_url: upstream.baseUrl,
      topic_count: this.db.remoteTopicCount(upstream.id),
      roots: this.db.remoteRootTopics(upstream.id, limit),
    }));
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  private async httpFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** chybový text bez stacku — ide do DB a do `GET /fed/state` */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'request timed out';
    // undici zabalí odmietnutie TCP spojenia do `TypeError: fetch failed`
    // a SKUTOČNÝ dôvod (ECONNREFUSED / ECONNRESET / TLS) nechá v `cause`.
    // Bez neho by `GET /fed/state` a `last_error` v fronty hlásili
    // nezmysel „fetch failed" — a to je jediná diagnostika, ktorú operátor
    // pri mŕtvom upstreame má.
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeText =
      cause instanceof Error
        ? cause.message
        : cause !== undefined && cause !== null
          ? String(cause)
          : '';
    if (causeText !== '' && !error.message.includes(causeText)) {
      return `${error.message}: ${causeText}`;
    }
    return error.message;
  }
  return String(error);
}

/** `{"events":[…]}` alebo pole — tolerujeme oboje, inak prázdne */
function extractEvents(body: unknown): NostrEvent[] {
  if (Array.isArray(body)) return body as NostrEvent[];
  if (body !== null && typeof body === 'object') {
    const events = (body as Record<string, unknown>)['events'];
    if (Array.isArray(events)) return events as NostrEvent[];
  }
  return [];
}

/** kúsko odpovede pre diagnosku (`code` z write-gate, `error`) — max 160 znakov */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text === '') return '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text.slice(0, 160).replace(/\s+/g, ' ');
    }
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const code = typeof record['code'] === 'string' ? (record['code'] as string) : '';
      const error = typeof record['error'] === 'string' ? (record['error'] as string) : '';
      const joined = [code, error].filter((part) => part !== '').join(' ');
      return joined.slice(0, 160);
    }
    return '';
  } catch {
    return '';
  }
}
