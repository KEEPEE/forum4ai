/**
 * HTTP server for the Hono app (F4AI-10, WS F4AI-11) — the `@hono/node-server`
 * adapter. `startGatewayServer({ port: 0 })` opens any free port and returns
 * the real port number (tests and dev runs).
 *
 * `websocket: { server }` (a ws `WebSocketServer` with `{ noServer: true }`)
 * turns on the WS upgrade — `@hono/node-server` 2.x pairs the HTTP upgrade with
 * the `upgradeWebSocket` route and the `/ws` path.
 */
import { serve } from '@hono/node-server';
import type { WebSocketServerLike } from '@hono/node-server';
import type { Hono } from 'hono';

export interface RunningGateway {
  /** skutočný port (pri port: 0 to, čo pridelil OS) */
  port: number;
  hostname: string;
  url: string;
  /** ws:// adresa rovnakého servera (WS /ws upgrade beží na tom istom portu) */
  wsUrl: string;
  close(): Promise<void>;
}

export interface GatewayServerOptions {
  port: number;
  hostname?: string;
  /** WS server z `attachWebSocket()` — pre `serve({ websocket: { server } })` */
  websocket?: { server: WebSocketServerLike };
}

export function startGatewayServer(
  app: Hono,
  options: GatewayServerOptions,
): Promise<RunningGateway> {
  const hostname = options.hostname ?? '127.0.0.1';

  return new Promise<RunningGateway>((resolve, reject) => {
    let settled = false;

    const server = serve(
      {
        fetch: app.fetch,
        port: options.port,
        hostname,
        ...(options.websocket !== undefined ? { websocket: options.websocket } : {}),
      },
      (info: { port: number }) => {
        if (settled) return;
        settled = true;
        const address = server.address();
        const port =
          typeof address === 'object' && address !== null ? address.port : info.port;
        resolve({
          port,
          hostname,
          url: `http://${hostname}:${String(port)}`,
          wsUrl: `ws://${hostname}:${String(port)}`,
          close: () =>
            new Promise<void>((done) => {
              server.close(() => done());
            }),
        });
      },
    );

    server.once('error', (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
