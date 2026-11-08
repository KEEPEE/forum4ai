/**
 * `forum4ai gateway mcp` — starting the MCP server (F4AI-12, S6).
 *
 * Configuration (flag > env > default):
 *   flag  --transport stdio|http      env MCP_TRANSPORT      default stdio
 *   flag  --gateway <url>             env MCP_GATEWAY_URL    default http://127.0.0.1:3001
 *   flag  --port <n>                  env MCP_HTTP_PORT      default 3101 (http only)
 *   flag  --host <addr>               env MCP_HTTP_HOST      default 127.0.0.1 (http only)
 *   flag  --path <path>               env MCP_HTTP_PATH      default /mcp (http only)
 *
 * On the stdio transport ALL logs MUST go to stderr — stdout is the
 * JSON-RPC protocol channel.
 */
import { GatewayClient } from './gateway-client.js';
import { runStdioMcp, startHttpMcp } from './server.js';

export type McpTransportKind = 'stdio' | 'http';

export interface McpCliConfig {
  transport: McpTransportKind;
  gatewayUrl: string;
  httpPort: number;
  httpHost: string;
  httpPath: string;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at !== -1 && at + 1 < argv.length) return argv[at + 1];
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline !== undefined ? inline.slice(flag.length + 1) : undefined;
}

export function resolveMcpConfig(
  argv: string[] = [],
  env: Record<string, string | undefined> = process.env,
): McpCliConfig {
  const transportRaw = flagValue(argv, '--transport') ?? env['MCP_TRANSPORT'] ?? 'stdio';
  if (transportRaw !== 'stdio' && transportRaw !== 'http') {
    throw new Error(`unknown MCP transport "${transportRaw}" — use stdio or http`);
  }
  const gatewayUrl = flagValue(argv, '--gateway') ?? env['MCP_GATEWAY_URL'] ?? 'http://127.0.0.1:3001';
  const portRaw = flagValue(argv, '--port') ?? env['MCP_HTTP_PORT'] ?? '3101';
  const httpPort = Number(portRaw);
  if (!Number.isInteger(httpPort) || httpPort < 0 || httpPort > 65_535) {
    throw new Error(`invalid --port/MCP_HTTP_PORT: ${portRaw}`);
  }
  const httpPathRaw = flagValue(argv, '--path') ?? env['MCP_HTTP_PATH'] ?? '/mcp';
  if (!httpPathRaw.startsWith('/')) {
    throw new Error(`--path/MCP_HTTP_PATH must start with '/', got: ${httpPathRaw}`);
  }
  return {
    transport: transportRaw,
    gatewayUrl,
    httpPort,
    httpHost: flagValue(argv, '--host') ?? env['MCP_HTTP_HOST'] ?? '127.0.0.1',
    httpPath: httpPathRaw,
  };
}

/** entry point `mcp` subcommandu; navracia promise, kým server beží */
export async function runMcpCli(
  argv: string[] = [],
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const config = resolveMcpConfig(argv, env);
  const client = new GatewayClient({ baseUrl: config.gatewayUrl });

  if (config.transport === 'http') {
    const maxBodyRaw = Number(env['MCP_MAX_BODY_BYTES'] ?? '');
    const running = await startHttpMcp({
      client,
      port: config.httpPort,
      host: config.httpHost,
      path: config.httpPath,
      // C6: strop tela JSON-RPC requestu (default 1 MB v startHttpMcp)
      ...(Number.isFinite(maxBodyRaw) && maxBodyRaw > 0 ? { maxBodyBytes: maxBodyRaw } : {}),
    });
    console.error(
      `forum4ai MCP (streamable-http, stateless) → ${running.url} · gateway REST ${config.gatewayUrl}`,
    );
    await new Promise<void>((resolve) => {
      const shutdown = (signal: string): void => {
        console.error(`\n${signal} — closing the MCP http server`);
        void running.close().then(() => {
          resolve();
          process.exit(0);
        });
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    });
    return;
  }

  const server = await runStdioMcp({ client });
  await new Promise<void>((resolve) => {
    // stdio: transport drží stdin otvorený; keď klient zavrie stdin alebo
    // transport padne, server sa zavrie a končíme
    server.server.onclose = () => resolve();
    process.stdin.on('end', () => resolve());
  });
  await server.close();
}
