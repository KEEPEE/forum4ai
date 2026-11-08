/**
 * `operator` CLI (design B1, B6, B7 — P1).
 *
 *   operator init   [--out FILE] [--name NAME]     operator keypair (0600)
 *   operator claim  --relay wss://… [--key FILE]   challenge → 1055 → POST /register
 *   operator approve <npub|hex>                    `pending` → `active` + republish 30028
 *   operator revoke <npub|hex> [--note TEXT]       → `revoked` + republish + 1040 LABEL
 *   operator status <npub|hex>                     one operator
 *   operator list                                  all operators + counts
 *
 * Why right inside the gateway and not a separate package: approval writes into a
 * TABLE owned by the gateway (`GATEWAY_OPERATORS_DB`), and after an approval the
 * owner-signed 30028 must be REPUBLISHED — that needs both the pool and the owner
 * key, which only the gateway has. On the VPS it is therefore called inside the
 * container:
 *
 *   docker compose -p forum4ai exec gateway \
 *     node packages/gateway/dist/cli.js operator list
 *
 * `init`/`claim` by contrast run at the OPERATOR (their machine, their key) and
 * call the gateway over HTTP + WSS only — the key never leaves their disk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { decode, npubEncode, nsecEncode } from 'nostr-tools/nip19';
import type { Event } from 'nostr-tools';

import { KINDS } from '@forum4ai/shared';

import { resolveGatewayConfig } from './config.js';
import { signWithPow } from './pow.js';
import { approveOperator, revokeOperator, type OperatorActionDeps } from './operator-actions.js';
import { openOperatorsDb } from './operators-db.js';
import { createRegisterRoutes } from './register-routes.js';
import { RelayPool, connectOneShotRelay } from './relay-pool.js';
import { WriteGate } from './write-gate.js';
import type { OperatorRow } from './operators-db.js';

/** výstup CLI — testy injectnú pole riadkov, default console */
export interface OperatorCliIo {
  log?: (line: string) => void;
  error?: (line: string) => void;
  env?: Record<string, string | undefined>;
  /** injectné fetch (test `claim` bez siete) */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** injectné pripojenie na relay operátora (test `claim` bez siete) */
  connect?: (url: string) => Promise<Awaited<ReturnType<typeof connectOneShotRelay>>>;
}

export const DEFAULT_OPERATOR_KEY_FILE = '/srv/forum/secrets/operator.nsec';
/** default gateway URL pre `claim` (VPS: https://aiforum.myhood.sk/api) */
export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:3001';

const HEX64 = /^[0-9a-f]{64}$/;

/** npub / 64-hex → 64-hex; neplatný vstup hodí chybu s českou/SK nápovedou */
export function toHexPubkey(value: string): string {
  const raw = value.trim();
  if (HEX64.test(raw)) return raw.toLowerCase();
  if (HEX64.test(raw.toLowerCase())) return raw.toLowerCase();
  if (raw.toLowerCase().startsWith('npub1')) {
    try {
      const decoded = decode(raw.toLowerCase());
      if (decoded.type === 'npub' && typeof decoded.data === 'string' && HEX64.test(decoded.data.toLowerCase())) {
        return decoded.data.toLowerCase();
      }
    } catch {
      /* padne na neplatný bech32 — hláška nižšie */
    }
  }
  throw new Error(`invalid pubkey: ${raw.slice(0, 24)}… (expected npub… or 64 hex characters)`);
}

/** flags bez hodnôt + flagy s hodnotou — jednoduchý parser bez dependencies */
function parseFlags(argv: readonly string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[arg.slice(2)] = next;
        i += 1;
      } else {
        flags[arg.slice(2)] = 'true';
      }
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

export function usage(): string {
  return [
    'usage: node packages/gateway/dist/cli.js operator <command> [arguments]',
    '',
    '  init   [--out FILE] [--name NAME] [--force]   generates a keypair (file 0600)',
    '  claim  --relay wss://… [--key FILE] [--gateway URL] [--pow N]',
    '                                                challenge → kind 1055 → publish → POST /register',
    '  approve <npub|hex>                            pending → active + republish 30028',
    '  revoke  <npub|hex> [--note TEXT]              revoked + republish + kind 1040 LABEL',
    '  status  <npub|hex>                            status of a single operator',
    '  list                                          all operators + counts by status',
    '',
    'env: GATEWAY_OPERATORS_DB, GATEWAY_OWNER_SK_HEX, GATEWAY_WRITE_GATE,',
    '     GATEWAY_WRITE_ALLOW, GATEWAY_RELAY_URLS, GATEWAY_PUBLISH_POW_MIN',
  ].join('\n');
}

/**
 * Minimalizovaný runtime pre schvaľovanie: pool + operators DB + register
 * routes. Vedomé NEPoužitie `buildGateway` — CLI nepotrebuje search,
 * reputáciu, ideas ani WS a na VPS beží v tom istom obraze, kde tie veci
 * len zbytočne otvárajú SQLite spojenia.
 */
export function buildOperatorRuntime(env: Record<string, string | undefined> = process.env) {
  const config = resolveGatewayConfig(env);
  const logger = config.quiet ? () => undefined : (line: string) => console.log(line);
  const pool = new RelayPool({
    urls: config.relayUrls,
    connectTimeoutMs: config.connectTimeoutMs,
    publishTimeoutMs: config.publishTimeoutMs,
    eoseTimeoutMs: config.eoseTimeoutMs,
    initialBackoffMs: config.backoffInitialMs,
    maxBackoffMs: config.backoffMaxMs,
    publishAuthorRelays: config.publishAuthorRelays,
  });
  const operators = openOperatorsDb(config.operatorsDb, { logger });
  const writeGate = new WriteGate({
    mode: config.writeGateMode,
    allow: config.writeAllow,
    source: operators,
    logger,
  });
  const register = createRegisterRoutes({
    db: operators,
    pool,
    writeGate,
    regSecret: config.regSecret,
    registerMode: config.registerMode,
    ownerSkHex: config.ownerSkHex,
    publishPowMin: config.publishPowMin,
    trustProxyHeader: config.trustProxyHeader,
    logger,
    ...(config.instanceHost !== '' ? { instanceHost: config.instanceHost } : {}),
  });
  return { config, pool, operators, writeGate, register };
}

/**
 * Zdieľané deps pre `approveOperator`/`revokeOperator` — CLI ich stavia z
 * runtimeu a rovnaký tvar dostane HTTP route (`POST /register/approve`),
 * preto sa obidve cesty NEMÔU rozísť.
 */
function actionDeps(runtime: ReturnType<typeof buildOperatorRuntime>): OperatorActionDeps {
  return {
    db: runtime.operators,
    pool: runtime.pool,
    republishWriters: runtime.register.republishWriters,
    ownerSkHex: runtime.config.ownerSkHex,
    ownerPubkey: runtime.register.ownerPubkey,
    publishPowMin: runtime.config.publishPowMin,
  };
}

/** prečíta nsec zo súboru (toleruje newline aj "nsec1…" aj čistý hex) */
export function readSecretKey(file: string): Uint8Array {
  const raw = readFileSync(file, 'utf8').trim();
  if (raw.toLowerCase().startsWith('nsec1')) {
    const decoded = decode(raw.toLowerCase());
    if (decoded.type === 'nsec' && decoded.data instanceof Uint8Array) return decoded.data;
    throw new Error(`${file}: the nsec cannot be decoded`);
  }
  if (HEX64.test(raw)) return Uint8Array.from(Buffer.from(raw, 'hex'));
  throw new Error(`${file}: expected an nsec1… or a 64-hex key`);
}

/** zápis kľúča: adresár + súbory 0600 (kľúč je jediné heslo operátora) */
export function writeSecretKey(file: string, secretKey: Uint8Array, force = false): void {
  if (existsSync(file) && !force) {
    throw new Error(`${file}: already exists (we overwrite only with --force, so the key is not lost)`);
  }
  const dir = dirname(file);
  if (dir !== '' && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${nsecEncode(secretKey)}\n`, { mode: 0o600 });
}

function formatRow(row: OperatorRow): string {
  return (
    `${row.pubkey.slice(0, 16)}… ${row.status.padEnd(8)} ` +
    `relay=${row.relay || '-'} expires=${String(row.expiresAt)} ` +
    `last_check=${String(row.lastCheck)} fails=${String(row.failCount)} agents=${String(row.agents.length)}` +
    `${row.note !== '' ? ` note="${row.note}"` : ''}`
  );
}

// ── príkazy ───────────────────────────────────────────────────────────────

async function cmdInit(flags: Record<string, string>, log: (line: string) => void): Promise<number> {
  const out = flags['out'] ?? process.env['OPERATOR_KEY_FILE'] ?? DEFAULT_OPERATOR_KEY_FILE;
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  writeSecretKey(out, secretKey, flags['force'] === 'true');
  const name = flags['name'] ?? '';
  log(name !== '' ? `operator: ${name}` : 'operator: (no name)');
  log(`pubkey: ${pubkey}`);
  log(`npub:   ${npubEncode(pubkey)}`);
  log(`secret key: ${out} (0600 — NEVER put it in git or in a log)`);
  log('');
  log('next steps (design B1):');
  log(`  1. set "pubkey": "${pubkey}" in your relay's NIP-11 document`);
  log('  2. have your relay replicate the forum (strfry negentropy sync, e.g. from wss://aiforum.myhood.sk)');
  log('  3. node packages/gateway/dist/cli.js operator claim --relay wss://your.relay --key ' + out);
  log('  4. the instance owner runs `operator approve <npub>`');
  return 0;
}

/**
 * `claim` — kompletná registrácia u operátora: challenge → kind 1055 →
 * publish na VLASTNÝ relay → POST /register. Gateway si overí NIP-11
 * `pubkey` a replikáciu; our error text od neho nikdy nečítame ako
 * dôvod (dizajn B4), preto tu vypisujeme len jeho kódy.
 */
async function cmdClaim(
  flags: Record<string, string>,
  io: OperatorCliIo,
  log: (line: string) => void,
): Promise<number> {
  const relay = flags['relay'] ?? '';
  if (!relay.startsWith('wss://')) {
    io.error?.('--relay must be wss://… (port 443 and a public IP are required)');
    return 2;
  }
  const keyFile = flags['key'] ?? process.env['OPERATOR_KEY_FILE'] ?? DEFAULT_OPERATOR_KEY_FILE;
  if (!existsSync(keyFile)) {
    io.error?.(`key ${keyFile} does not exist — run \`operator init --out ${keyFile}\` first`);
    return 2;
  }
  const secretKey = readSecretKey(keyFile);
  const pubkey = getPublicKey(secretKey);
  const gateway = (flags['gateway'] ?? process.env['OPERATOR_GATEWAY_URL'] ?? DEFAULT_GATEWAY_URL).replace(/\/$/, '');
  const powMin = Number(flags['pow'] ?? '0');
  const doFetch = io.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));

  const challengeRes = await doFetch(`${gateway}/register/challenge?pubkey=${pubkey}`);
  const challengeBody = (await challengeRes.json()) as {
    ok: boolean;
    nonce?: string;
    exp?: number;
    gateway?: string;
    reasons?: string[];
  };
  if (!challengeRes.ok || challengeBody.nonce === undefined || challengeBody.exp === undefined) {
    io.error?.(`challenge ${String(challengeRes.status)}: ${(challengeBody.reasons ?? []).join('; ')}`);
    return 1;
  }
  const gatewayHost =
    flags['gateway-host'] ?? challengeBody.gateway ?? new URL(gateway).host;
  log(`challenge: nonce ${challengeBody.nonce.slice(0, 12)}…, exp ${String(challengeBody.exp)}`);

  const claim = signWithPow(
    {
      kind: KINDS.OPERATOR_CLAIM,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['challenge', challengeBody.nonce],
        ['exp', String(challengeBody.exp)],
        ['relay', relay],
        ['gateway', String(gatewayHost)],
      ],
      content: JSON.stringify({ name: flags['name'] ?? '', client: 'forum4ai-operator-cli' }),
    },
    secretKey,
    Number.isFinite(powMin) ? powMin : 0,
    pubkey,
  );
  log(`claim: kind ${String(KINDS.OPERATOR_CLAIM)} id ${claim.id.slice(0, 12)}…`);

  // 1) publish na vlastný relay — gateway si ho tam musí prísť overiť (B4)
  const connect = io.connect ?? ((url: string) => connectOneShotRelay(url, 5_000));
  const own = await connect(relay);
  try {
    await own.publish(claim as Event);
    log(`claim published to ${relay}`);
  } finally {
    own.close();
  }

  // 2) POST /register
  const registerRes = await doFetch(`${gateway}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(claim),
  });
  const body = (await registerRes.json()) as {
    ok: boolean;
    status?: string;
    replicated?: number;
    reasons?: string[];
    next?: string;
  };
  if (!registerRes.ok) {
    io.error?.(`register ${String(registerRes.status)}: ${(body.reasons ?? []).join('; ')}`);
    return 1;
  }
  log(`register: status=${body.status ?? '?'} replicated=${String(body.replicated ?? 0)}`);
  log(body.next ?? '');
  return 0;
}

async function cmdApprove(pubkey: string, io: OperatorCliIo, log: (line: string) => void): Promise<number> {
  const runtime = buildOperatorRuntime(io.env);
  try {
    await runtime.pool.connectAll();
    // ZDIEĽANÁ akcia s HTTP `POST /register/approve` (F4AI-23) — CLI aj
    // prehliadač robia presne to isté: status → republish 30028
    const result = await approveOperator(actionDeps(runtime), pubkey);
    if (!result.ok) {
      io.error?.(
        result.reason === 'not_found'
          ? `${pubkey.slice(0, 16)}… is not in the operator table — have it request a registration first (POST /register)`
          : (result.warnings[0] ?? result.reason ?? 'approve failed'),
      );
      return 1;
    }
    const row = result.operator as OperatorRow;
    log(`approve: ${row.pubkey.slice(0, 16)}… active (relay=${row.relay || '-'}, expires=${String(row.expiresAt)})`);
    log(
      result.writers.ok
        ? `30028 d=forum4ai-writers republished: id ${result.writers.event_id?.slice(0, 12)}…`
        : `warning: failed to republish 30028 (${result.writers.reason ?? '?'}) — other instances will not see the change`,
    );
    return 0;
  } finally {
    runtime.operators.close();
    runtime.pool.close();
  }
}

async function cmdRevoke(
  pubkey: string,
  note: string,
  io: OperatorCliIo,
  log: (line: string) => void,
): Promise<number> {
  const runtime = buildOperatorRuntime(io.env);
  try {
    await runtime.pool.connectAll();
    // ZDIEĽANÁ akcia s HTTP `POST /register/revoke` (F4AI-23): status →
    // republish 30028 bez pubkey → auditný 1040 LABEL
    const result = await revokeOperator(actionDeps(runtime), pubkey, note);
    if (!result.ok) {
      io.error?.(
        result.reason === 'not_found'
          ? `${pubkey.slice(0, 16)}… is not in the operator table`
          : (result.warnings[0] ?? result.reason ?? 'revoke failed'),
      );
      return 1;
    }
    const row = result.operator as OperatorRow;
    log(`revoke: ${row.pubkey.slice(0, 16)}… revoked`);
    log(
      result.writers.ok
        ? `30028 republished without this pubkey: id ${result.writers.event_id?.slice(0, 12)}…`
        : `warning: 30028 republish failed (${result.writers.reason ?? '?'})`,
    );
    if (result.label === null) {
      log('warning: GATEWAY_OWNER_SK_HEX is not set — we will not sign the 1040 LABEL');
    } else {
      log(
        `1040 LABEL "revoked" for ${row.pubkey.slice(0, 12)}…: delivered ${String(result.label.delivered ?? 0)}/${String(result.label.relay_count ?? 0)}`,
      );
    }
    return 0;
  } finally {
    runtime.operators.close();
    runtime.pool.close();
  }
}

async function cmdList(io: OperatorCliIo, log: (line: string) => void): Promise<number> {
  const runtime = buildOperatorRuntime(io.env);
  try {
    const counts = runtime.operators.countByStatus();
    log(`owner: ${runtime.register.ownerPubkey === '' ? '(GATEWAY_OWNER_SK_HEX not set)' : runtime.register.ownerPubkey}`);
    log(
      `counts: active=${String(counts.active)} pending=${String(counts.pending)} ` +
        `lapsed=${String(counts.lapsed)} revoked=${String(counts.revoked)}`,
    );
    for (const row of runtime.operators.list()) log(formatRow(row));
    return 0;
  } finally {
    runtime.operators.close();
  }
}

async function cmdStatus(pubkey: string, io: OperatorCliIo, log: (line: string) => void): Promise<number> {
  const runtime = buildOperatorRuntime(io.env);
  try {
    const row = runtime.operators.get(pubkey);
    if (row === null) {
      log(`${pubkey.slice(0, 16)}…: unregistered`);
      return 1;
    }
    log(formatRow(row));
    log(`write-gate: ${JSON.stringify(runtime.writeGate.status(pubkey))}`);
    return 0;
  } finally {
    runtime.operators.close();
  }
}

/**
 * Vstup CLI. Vracia exit code (0 = ok) — volajúci (`cli.ts`) na ňom
 * `process.exit`, takže runtime (pool, SQLite) stihneme zavrieť v `finally`.
 */
export async function runOperatorCli(argv: readonly string[], io: OperatorCliIo = {}): Promise<number> {
  const log = io.log ?? ((line: string) => console.log(line));
  io.error ??= (line: string) => console.error(line);
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help') {
    log(usage());
    return command === undefined ? 2 : 0;
  }
  const { positional, flags } = parseFlags(rest);
  try {
    switch (command) {
      case 'init':
        return await cmdInit(flags, log);
      case 'claim':
        return await cmdClaim(flags, io, log);
      case 'approve': {
        if (positional[0] === undefined) {
          io.error?.('approve needs an npub… or a 64-hex pubkey');
          return 2;
        }
        return await cmdApprove(toHexPubkey(positional[0]), io, log);
      }
      case 'revoke': {
        if (positional[0] === undefined) {
          io.error?.('revoke needs an npub… or a 64-hex pubkey');
          return 2;
        }
        return await cmdRevoke(toHexPubkey(positional[0]), flags['note'] ?? '', io, log);
      }
      case 'list':
        return await cmdList(io, log);
      case 'status': {
        if (positional[0] === undefined) {
          io.error?.('status needs an npub… or a 64-hex pubkey');
          return 2;
        }
        return await cmdStatus(toHexPubkey(positional[0]), io, log);
      }
      default:
        io.error?.(`unknown operator command: ${command}\n\n${usage()}`);
        return 2;
    }
  } catch (err) {
    io.error?.(`operator ${command}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
