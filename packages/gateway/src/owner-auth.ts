/**
 * Instance OWNER verification for owner-only routes (F4AI-23/24, Phase 1b).
 *
 * Phase 1a built the NIP-98 check directly in `register-routes.ts` (only for
 * `POST /register/approve|revoke`). Phase 1b adds `GET /register/pending`,
 * which needs THIS EXACT procedure — that is why the validator is a separate
 * module and the route only calls it. One place = one semantics: 503 without an
 * owner key, 401 for an invalid token, 403 when somebody else signed.
 *
 * Important rules (same as Phase 1a, they must not change):
 *  - kind 27235 is AUTH here, not an event (`POST /events` rejects it — A7),
 *  - the `u` tag MUST match the PATH of the request; only the substitutions a
 *    reverse proxy causes are allowed (scheme / port / `/api` prefix) — see
 *    `nip98UrlCandidates`,
 *  - the signing pubkey must equal the pubkey derived from
 *    `GATEWAY_OWNER_SK_HEX`; otherwise 403 `NOT_OWNER`,
 *  - without `GATEWAY_OWNER_SK_HEX` there is nothing to verify against → 503
 *    `OWNER_NOT_CONFIGURED` (before any signature at all).
 */
import { verifyNip98Authorization } from './nip98.js';

/** kódy mimo write-gate — rovnaký kontrakt ako `WG_*`, iná route (F4AI-23) */
export type OwnerAuthCode = 'OWNER_NOT_CONFIGURED' | 'AUTH_NIP98_INVALID' | 'NOT_OWNER';

export interface OwnerAuthFailure {
  status: 503 | 401 | 403;
  error: string;
  code: OwnerAuthCode;
  reasons: string[];
}

export type OwnerAuthResult = { ok: true; pubkey: string } | { ok: false; failure: OwnerAuthFailure };

export interface OwnerAuthOptions {
  /** `Authorization` hlavička požiadavky (môže chýbať) */
  header?: string | null;
  /** URL tak, ako ju vidí SERVER (za Caddy bez `/api` a na http) */
  url: string;
  /** metóda požiadavky — `u`/`method` tag sa musí zhodovať */
  method: string;
  /** surové telo (GET/HEAD → undefined); `payload` tag sa hashuje z týchto bajtov */
  rawBody?: string;
  /** 64-hex skala vlastníka z configu; prázdny reťazec = vlastník nenastavený */
  ownerSkHex: string;
  /** owner pubkey (lowercase hex); prázdny, keď skala chýba */
  ownerPubkey: string;
  /**
   * Ďalšie URL, ktoré `u` tag môže spĺňať. Default: `nip98UrlCandidates(url)`
   * (tolerancia reverznej proxy). Volajúci smie pridať len varianty TEJ ISTEJ
   * cesty — iná cesta by dovolila replay auth eventu na inú route.
   */
  altUrls?: readonly string[];
}

/**
 * Kandidátske URL pre kontrolu NIP-98 `u` tagu (F4AI-23).
 *
 * Klient (UI) podpisuje URL, ktoré VOLÁ — `https://host/api/register/approve`.
 * Gateway ale vidí inú adresu: Caddy `handle_path /api/*` STRHÁVA prefix a
 * TLS končí pred gatewayom, takže server vidí
 * `http://host:3001/register/approve`. Bez tolerance by každá owner akcia
 * padla na `u tag nezodpovedá`. Povolené varianty sú LEN zámeny, ktoré
 * spôsobuje reverzná proxy:
 *   - schéma `http` ↔ `https`,
 *   - port (verejný origin ho nemá, gateway áno),
 *   - `/api` prefix (s ním aj bez neho).
 * CESTA sama sa meniť NESMIE — inak by sa dal auth event podpísaný pre
 * inú route replaynúť (napr. approve → revoke).
 */
export function nip98UrlCandidates(rawUrl: string): string[] {
  const out = new Set<string>([rawUrl]);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return [...out];
  }
  const paths = new Set<string>([url.pathname]);
  if (url.pathname.startsWith('/api/')) paths.add(url.pathname.slice(4));
  else if (url.pathname !== '/api') paths.add(`/api${url.pathname}`);
  for (const scheme of ['http:', 'https:']) {
    for (const pathname of paths) {
      for (const port of [url.port, '']) {
        const candidate = new URL(url.toString());
        candidate.protocol = scheme;
        candidate.port = port;
        candidate.pathname = pathname;
        out.add(candidate.toString());
      }
    }
  }
  return [...out];
}

/**
 * Over, že požiadavku podpísal VLASTNÍK inštancie. Vracia buď overený
 * pubkey, alebo štruktúrovanú chybu, z ktorej route postaví odpoveď
 * (`ownerAuthResponse`) — žiadne HTTP detaily tu, aby to šlo použiť aj
 * mimo hono.
 */
export async function verifyOwnerAuthorization(options: OwnerAuthOptions): Promise<OwnerAuthResult> {
  if (options.ownerSkHex.trim() === '' || options.ownerPubkey === '') {
    return {
      ok: false,
      failure: {
        status: 503,
        error: 'owner not configured',
        code: 'OWNER_NOT_CONFIGURED',
        reasons: [
          'the instance has no owner configured (GATEWAY_OWNER_SK_HEX) — owner routes over HTTP are not available',
        ],
      },
    };
  }

  const auth = await verifyNip98Authorization(options.header, {
    url: options.url,
    altUrls: options.altUrls ?? nip98UrlCandidates(options.url),
    method: options.method,
    ...(options.rawBody !== undefined ? { rawBody: options.rawBody } : {}),
  });
  if (!auth.ok) {
    return {
      ok: false,
      failure: {
        status: 401,
        error: 'unauthorized',
        code: 'AUTH_NIP98_INVALID',
        reasons: [`NIP-98 auth did not pass: ${auth.reason}`],
      },
    };
  }

  const signer = auth.pubkey.toLowerCase();
  if (signer !== options.ownerPubkey.toLowerCase()) {
    return {
      ok: false,
      failure: {
        status: 403,
        error: 'not owner',
        code: 'NOT_OWNER',
        reasons: [
          `the request was signed by ${signer.slice(0, 8)}…, but only the instance owner may decide (${options.ownerPubkey.slice(0, 8)}…)`,
        ],
      },
    };
  }
  return { ok: true, pubkey: signer };
}

/** teliesko chyby (zhodné s `POST /register/approve|revoke` z Phase 1a) */
export function ownerAuthBody(failure: OwnerAuthFailure): {
  ok: false;
  error: string;
  code: OwnerAuthCode;
  reasons: string[];
} {
  return { ok: false, error: failure.error, code: failure.code, reasons: failure.reasons };
}
