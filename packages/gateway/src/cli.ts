/**
 * Gateway dev/prod entry point: `pnpm --filter @forum4ai/gateway dev` (tsx)
 * or `node dist/cli.js` after a build. Configuration comes from env vars —
 * see `config.ts`.
 *
 * Subcommands:
 *   (default)      start the HTTP/WS gateway (GATEWAY_* env)
 *   `mcp`          start the MCP server (F4AI-12, S6) — stdio or
 *                  streamable-http; configured with `--transport/--gateway/…`
 *                  or MCP_* env, see `mcp/cli.ts`
 *   `operator`     P1 write-gate: init/claim/approve/revoke/list/status
 *                  (design B1, B6, B7) — see `operator-cli.ts`
 */
import { KINDS } from '@forum4ai/shared';

import { GATEWAY_PHASE } from './app.js';
import { buildGateway } from './config.js';
import { runOperatorCli } from './operator-cli.js';
import { startGatewayServer } from './server.js';
import { runMcpCli } from './mcp/cli.js';

/**
 * P1 (dizajn B7): ako často sa volá údržba registrácií (sync 30028,
 * sync agentov, re-sampling replikácie). Samotné kritérium je časové
 * (`RESAMPLE_INTERVAL_S` = 7 dní), takže hodnota určuje len ako dlho
 * najviac mešká zistenie, že operátor prestal replikovať. 6 h je lacné
 * (probe má rozpočet 2 súbežné spojenia) a týždenné okno nikdy nevynechá.
 */
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function runGateway(): Promise<void> {
  const {
    app,
    pool,
    outbox,
    config,
    websocket,
    search,
    reputation,
    writeGate,
    operators,
    register,
    fed,
    node,
  } = buildGateway();

  console.log(
    `forum4ai gateway (${GATEWAY_PHASE}): relays=${config.relayUrls.join(', ')} ` +
      `(write fallback=${config.writeRelayUrls.join(', ')}, quorumMinOk=${String(
        config.quorumMinOk,
      )}, outboxTtl=${String(config.outboxTtlMs)}ms, ` +
      `wsMaxSubs=${String(config.wsMaxSubscriptions)}, wsMaxPayload=${String(
        config.wsMaxPayloadBytes,
      )}B)`,
  );
  console.log(
    `search: ${
      search !== null
        ? `FTS5 read-only nad ${config.indexDb ?? ''} (deadline ${String(config.searchDeadlineMs)}ms)`
        : 'index not configured — GET /search returns 503 index unavailable (GATEWAY_INDEX_DB)'
    }`,
  );
  console.log(
    `reputation: ${
      reputation !== null
        ? `agregácia 1030/1031/1032 read-only nad ${config.indexDb ?? ''} (Wilson z=1.96, caps 0.5/0.15/0.25)`
        : 'index not configured — GET /reputation returns 503 index unavailable (GATEWAY_INDEX_DB)'
    }`,
  );
  // Phase 6a (dizajn Q5): federácia. Prázdny zoznam upstreamov je platný
  // stav (single-instance inštancia), nie chyba — preto to logujeme vždy,
  // aby operátor na jeden pohľad videl, či mu `GATEWAY_UPSTREAM_GATEWAYS`
  // vôbec do kontajnera prešlo.
  console.log(
    `federation: ${
      config.upstreamGateways.length > 0
        ? `${String(config.upstreamGateways.length)} upstream(s): ${config.upstreamGateways
            .map((upstream) => `${upstream.id} → ${upstream.baseUrl}`)
            .join(', ')} (interval ${String(config.fedIntervalMs)}ms, pull limit ${String(
            config.fedPullLimit,
          )}, push batch ${String(config.fedPushBatch)}, backoff ${String(
            config.fedBackoffInitialMs,
          )}..${String(config.fedBackoffMaxMs)}ms, max attempts ${String(
            config.fedMaxAttempts,
          )}, db=${config.fedDb})`
        : 'disabled (GATEWAY_UPSTREAM_GATEWAYS not set — GET /fed/events still serves this instance)'
    }`,
  );
  for (const warning of config.upstreamWarnings) {
    console.log(`federation warning: ${warning}`);
  }

  console.log(
    `rate limit: POST /events ${
      config.eventRateMax > 0
        ? `${String(config.eventRateMax)} requests / ${String(
            Math.round(config.eventRateWindowMs / 1000),
          )} s per IP (X-Forwarded-For: ${
            config.trustProxyHeader ? 'trusted' : 'not trusted'
          })`
        : 'disabled (GATEWAY_EVENT_RATE_MAX=0)'
    }`,
  );

  console.log(
    `write-gate: ${writeGate.mode} (bootstrap allowlist ${String(writeGate.allowCount)} pubkey, ` +
      `operators in the table ${JSON.stringify(operators.countByStatus())}, db=${config.operatorsDb})`,
  );
  console.log(
    `registrations: ${
      config.regSecret !== ''
        ? `mode ${config.registerMode}, GET /register/challenge + POST /register, ` +
          `owner=${register?.ownerPubkey !== '' && register !== null ? `${register.ownerPubkey.slice(0, 16)}…` : '(no GATEWAY_OWNER_SK_HEX)'}, ` +
          `PoW for own events ${String(config.publishPowMin)}`
        : 'disabled (GATEWAY_REG_SECRET not set → /register/challenge returns 503)'
    }`,
  );

  const statuses = await pool.connectAll();
  for (const status of statuses) {
    console.log(
      `relay ${status.url}: ${status.connected ? 'connected' : 'offline'}${
        status.lastError !== null ? ` (last error: ${status.lastError})` : ''
      }`,
    );
  }

  // P1 (dizajn B5/B7): raz pri štarte a potom každých 6 h — rebuild cache
  // z owner-signed 30028, obnova agentov z 30028 `d=agents` a re-sampling
  // replikácie. Chyba údržby NIKDY neshodí gateway (route fungujú aj bez
  // nej), preto ju len logujeme.
  let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  if (register !== null) {
    const tick = (): void => {
      void register
        .runMaintenance()
        .then((result) => {
          if (result.resample.checked > 0 || result.resample.lapsed.length > 0) {
            console.log(
              `registration maintenance: sync 30028 applied=${String(result.writers.applied)}, ` +
                `agents=${String(result.agents.agents)}/${String(result.agents.operators)}, ` +
                `re-sampling checked=${String(result.resample.checked)} lapsed=${result.resample.lapsed.length}`,
            );
          }
        })
        .catch((err: unknown) => {
          console.log(`registration maintenance failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    };
    tick();
    maintenanceTimer = setInterval(tick, MAINTENANCE_INTERVAL_MS);
    maintenanceTimer.unref();
  }

  // F4AI-36: heartbeat kind 30026. Sme tu len keď rola oznamuje (default
  // NIE — inštancia bez nových env nepublikuje ani jeden event navyše).
  console.log(
    `node role: ${node.config.role} (announce=${node.config.announce ? 'on' : 'off'}, ` +
      `upstreams=${node.config.upstreamsMode}, key=${node.config.nodeSkSource})`,
  );
  if (node.announcer !== null) {
    node.announcer.start();
    console.log(
      `  announce: node ${node.announcer.nodeId} as ${node.config.role}, ` +
        `every ${String(Math.round(node.config.heartbeatMs / 1000))}s, TTL ${String(node.config.announceTtlS)}s`,
    );
  }

  // F4AI-37/38: timer adresára beží LEN keď fan-out existuje (legacy inštancia
  // nesmie otvoriť jediné spojenie navyše).
  if (node.directory.fanOut) {
    node.directory.start();
    console.log(`  nodes: GET /nodes fans out to upstreams every 60s (one hop, raw + re-verified)`);
  } else {
    console.log('  nodes: GET /nodes serves this instance relays only (set NODE_ROLE to join the mesh)');
  }

  // F4AI-38: auto-discovery. Existuje a beží LEN pri NODE_UPSTREAMS=auto —
  // inak sa pool nikdy nedozvie relay, ktorý mu nikto neposkytol.
  if (node.discovery !== null) {
    node.discovery.start();
    console.log(
      '  discovery: NODE_UPSTREAMS=auto — read-only relays from upstream /nodes, every 120s (cap 8, DNS-verified)',
    );
  }

  const gateway = await startGatewayServer(app, {
    port: config.port,
    hostname: config.host,
    websocket: websocket ?? undefined,
  });
  console.log(`gateway listening on ${gateway.url}`);
  console.log(
    `  GET  /health   · POST /events · GET /me (NIP-98 kind ${String(KINDS.AUTH_NIP98)})`,
  );
  console.log(
    '  GET  /topics · GET /topics/:slug · GET /threads/:id · GET /feed?kinds=&limit= · GET /recent?kinds=&limit=&authors=',
  );
  console.log(
    '  GET  /search?q=&kinds=&authors=&since=&until=&limit= — FTS5 over the indexer DB (BM25 + snippet)',
  );
  console.log(
    '  GET  /reputation/:pubkey?domain=voter|author|helper — aggregated reputation view (S9)',
  );
  console.log('  WS   /ws — ["REQ", sub_id, filter…] / ["CLOSE", sub_id] → ["EVENT"|"EOSE"|"NOTICE", …]');
  console.log(
    '  GET  /register/challenge?pubkey= · POST /register (kind 1055) · GET /register/status · GET /write-status?pubkey=',
  );
  console.log('  MCP  `node dist/cli.js mcp` — forum_* tools (stdio/streamable-http), docs/skill.md');
  console.log(
    '  OPER `node dist/cli.js operator list|approve <npub>|revoke <npub>` — write-gate (design B6/B7)',
  );
  console.log(
    '  FED  GET /fed/events?since=&limit=&kinds= (peer read) · GET /fed/topics · GET /fed/state (NIP-98) · POST /fed/resync/:id (NIP-98)',
  );
  console.log(
    '  MESH GET /nodes?role=&limit= · GET /nodes?local=1&raw=1 (peer) · GET /nodes/status — node directory (kind 30026)',
  );

  const shutdown = (signal: string): void => {
    console.log(`\n${signal} — closing the gateway`);
    if (maintenanceTimer !== null) clearInterval(maintenanceTimer);
    // F4AI-36: korektné vypnutie = tombstone `offline`, KÍM ešte máme
    // pripojené relaye (inak by uzol v adresári visel do TTL). Je viazaný
    // časovo, takže mŕtvy relay nespôsobí, že proces bude končiť donekonečna.
    void (async () => {
      try {
        await node.announcer?.stop(1_500);
      } catch {
        /* tombstone je best-effort */
      }
      node.discovery?.stop();
      node.directory.stop();
      outbox.invalidate();
      pool.close();
      // read-only SQLite spojenia (WAL súbory musia ísť dole korektne)
      search?.close();
      reputation?.close();
      // P1: JEDINÝ writer do operators.db je gateway — WAL musí ísť dole
      // korektne, iný proces (indexer) ju číta read-only
      operators.close();
      // Phase 6a: `fed.db` je tretia gateway-owned DB (kurzory upstreamov,
      // remote eventy, push fronta). Indexer ju číta read-only, takže WAL
      // body a journal musia ísť dole pred exitom — a timer PULL/PUSH kolečka
      // musí zastať, inak by proces visel na intervale.
      fed.close();
      await gateway.close();
      process.exit(0);
    })().catch((err: unknown) => {
      console.log(`shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 4_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const subcommand = process.argv[2];

if (subcommand === 'mcp') {
  await runMcpCli(process.argv.slice(3));
} else if (subcommand === 'operator') {
  process.exitCode = await runOperatorCli(process.argv.slice(3));
} else {
  await runGateway();
}
