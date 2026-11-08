/**
 * Write-gate (A1 from the security review, design B9) — writes only for
 * registered OPERATORS (instances that mirror the forum) and their agents.
 *
 * The owner policy that this module implements:
 *   READ  = open to anybody (the read routes do not change),
 *   WRITE = only for operators and their agents; keys are created at instance
 *           setup (keypair + replication-proof registration, P1).
 *
 * Two sources of permission:
 *   1. the BOOTSTRAP allowlist (`GATEWAY_WRITE_ALLOW`, comma 64-hex pubkeys) —
 *      valid ALWAYS, even when registration is off. Without it the first
 *      operator (the instance owner) and their agents could not get in, because
 *      registration needs a running forum.
 *   2. `OperatorSource` (P1: `OperatorsDb` + the owner-signed 30028
 *      `d=forum4ai-writers`) — operators with `status=active` and their agents
 *      from 30028 `d=agents` (max 20 `p` tags).
 *
 * The `log` mode is a mandatory intermediate step before `enforce`: the records
 * show who the gate would reject before we actually start blocking them.
 */

export type WriteGateMode = 'off' | 'log' | 'enforce';

export const WRITE_GATE_MODES: readonly WriteGateMode[] = ['off', 'log', 'enforce'];

/** default = `off` (dev inštancia 127.0.0.1 sa zavedením gate nesmie zmeniť) */
export const WRITE_GATE_MODE_DEFAULT: WriteGateMode = 'off';

/** cesta, na ktorú ukazuje 403 dôvod — verejné API je za Caddy pod /api */
export const REGISTER_HINT = '/api/register';

/** stav operátora v operátorskej tabuľke (P1) */
export type OperatorStatus = 'pending' | 'active' | 'lapsed' | 'revoked';

/**
 * Stavový zdroj operátorov. Sync rozhranie zámerne — volá sa na každom
 * `POST /events`, takže nesmie čakať na SQLite ani na relay. P1 ho plní
 * `OperatorsDb` s in-memory snapshotom, ktorý sa obnovuje pri zmene.
 */
export interface OperatorSource {
  /** status operátora, alebo null ak pubkey nie je operátor */
  operatorStatus(pubkey: string): OperatorStatus | null;
  /** agent patrí pod tohto operátora (null = nie je agent / nevieme) */
  agentOf(pubkey: string): { operator: string } | null;
}

export type WriteGateVia = 'bootstrap' | 'operator' | 'agent' | 'none';

/**
 * Stabilný API kód rozhodnutia (F4AI-23/24, Phase 1a). `reasons[]` zostáva
 * človečiteľný text (Phase 2 ho prepne na jazyk UI), `code` je to, na čom
 * UI a agentia visia — preto MUSÍ zostať nemenný:
 *
 *   WG_GATE_OFF                   gate je `off` → povolené
 *   WG_BOOTSTRAP                  pubkey je v bootstrap allowliste → povolené
 *   WG_OPERATOR                   registrovaný aktívny operátor → povolené
 *   WG_AGENT                      agent aktívneho operátora → povolené
 *   WG_NOT_REGISTERED              pubkey nie je v zozname operátorov
 *   WG_PENDING                    registrácia čaká na schválenie
 *   WG_LAPSED                     registrácia vypršala (3 zlyhania / expirácia)
 *   WG_REVOKED                    registrácia bola zrušená
 *   WG_AGENT_OPERATOR_INACTIVE      pubkey je agent, ale jeho operátor
 *                                   nie je aktívny (detail je v `reason`)
 *   WG_NOT_MEMBER                 (rezervované pre Phase 1b: member z
 *                                   30028 `d=agents` píše inak ako agent)
 */
export type WriteGateCode =
  | 'WG_GATE_OFF'
  | 'WG_BOOTSTRAP'
  | 'WG_OPERATOR'
  | 'WG_AGENT'
  | 'WG_NOT_REGISTERED'
  | 'WG_PENDING'
  | 'WG_LAPSED'
  | 'WG_REVOKED'
  | 'WG_AGENT_OPERATOR_INACTIVE';

export interface WriteGateDecision {
  ok: boolean;
  /** ako bolo povolenie získané — pre logy a `/write-status` */
  via: WriteGateVia;
  /** krátky slovenský dôvod (pre 403 `reasons[]` a `/write-status`) */
  reason: string;
  /** stabilný strojový kód — kontrakt pre UI/agentov (pozri `WriteGateCode`) */
  code: WriteGateCode;
  /**
   * pubkey operátora, pod ktorého zápis spadá (bootstrap/operátor = sám
   * seba, agent = jeho operátor). Per-operátor rate limit počítá tento
   * kľúč, nie pubkey agenta.
   */
  operator?: string;
}

export interface WriteGateOptions {
  mode?: WriteGateMode;
  /** bootstrap allowlist — normalizované 64-hex pubkeys */
  allow?: Iterable<string>;
  /** P1 zdroj operátorov; bez neho gate pozná len bootstrap allowlist */
  source?: OperatorSource;
  /** logger pre `log` režim (default ticho) */
  logger?: (line: string) => void;
}

/**
 * Parsovať režim z env. Neznáma hodnota → `off` (bezpečný default:
 * preklep v `GATEWAY_WRITE_GATE` nesmie náhodou zapnúť blockovanie).
 */
export function parseWriteGateMode(raw: string | undefined): WriteGateMode {
  const value = (raw ?? '').trim().toLowerCase();
  return (WRITE_GATE_MODES as readonly string[]).includes(value)
    ? (value as WriteGateMode)
    : WRITE_GATE_MODE_DEFAULT;
}

/**
 * Parsovať bootstrap allowlist z env (`GATEWAY_WRITE_ALLOW`). Oddeľovače
 * čiarka / medzera / nový riadok; neplatné 64-hex položky zahadzujeme
 * (jedna preklepnutá položka nesme znefunkčniť celý zoznam).
 */
export function parseWriteAllowlist(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  const HEX64 = /^[0-9a-f]{64}$/;
  for (const part of (raw ?? '').split(/[\s,]+/)) {
    const value = part.trim().toLowerCase();
    if (HEX64.test(value)) out.add(value);
  }
  return out;
}

/** krátky identifikátor pubkey do hlášok (prvých 8 hex znakov) */
export function shortPubkey(pubkey: string): string {
  return `${pubkey.slice(0, 8)}…`;
}

/**
 * Dôvod 403 odpovede (Slovak, ukazuje na registráciu). Presne tento text
 * dostane UI aj MCP `forum_publish` — MCP ho posiela nemenený.
 */
export function writeGateReason(pubkey: string, decision: WriteGateDecision): string {
  return (
    `pubkey ${shortPubkey(pubkey)} is not a registered operator/agent ` +
    `(${decision.reason}); writing is only for instances that mirror the forum — ` +
    `registration: ${REGISTER_HINT}`
  );
}

export class WriteGate {
  readonly mode: WriteGateMode;
  readonly allow: ReadonlySet<string>;
  private readonly source: OperatorSource | null;
  private readonly log: (line: string) => void;

  constructor(options: WriteGateOptions = {}) {
    this.mode = options.mode ?? WRITE_GATE_MODE_DEFAULT;
    // normalizujeme aj sem (nie len v `parseWriteAllowlist`) — testy a
    // P1 `OperatorsDb` môžu dostať hex z rôznych zdrojov s rôznou veľkosťou
    this.allow = new Set([...(options.allow ?? [])].map((k) => k.trim().toLowerCase()));
    this.source = options.source ?? null;
    this.log = options.logger ?? (() => undefined);
  }

  get enabled(): boolean {
    return this.mode !== 'off';
  }

  /** `true` = zamietnutie sa NIE je blokujúce (režim `log`) */
  get loggingOnly(): boolean {
    return this.mode === 'log';
  }

  /** počet bootstrap pubkey (testy / /health) */
  get allowCount(): number {
    return this.allow.size;
  }

  /**
   * Rozhodni o zápise pre `pubkey`. Čisté a lacne — žiadne I/O.
   * `off` → vždy ok; inak bootstrap → operátor → agent operátora.
   */
  check(pubkey: string): WriteGateDecision {
    if (this.mode === 'off') {
      return {
        ok: true,
        via: 'none',
        code: 'WG_GATE_OFF',
        reason: 'write gate is off (GATEWAY_WRITE_GATE=off)',
      };
    }
    const normalized = pubkey.toLowerCase();
    if (this.allow.has(normalized)) {
      return {
        ok: true,
        via: 'bootstrap',
        code: 'WG_BOOTSTRAP',
        reason: 'bootstrap allowlist GATEWAY_WRITE_ALLOW',
        operator: normalized,
      };
    }
    const status = this.source?.operatorStatus(normalized) ?? null;
    if (status === 'active') {
      return {
        ok: true,
        via: 'operator',
        code: 'WG_OPERATOR',
        reason: 'registered active operator',
        operator: normalized,
      };
    }
    const agent = this.source?.agentOf(normalized) ?? null;
    if (agent !== null) {
      const operatorStatus = this.source?.operatorStatus(agent.operator) ?? null;
      if (operatorStatus === 'active') {
        return {
          ok: true,
          via: 'agent',
          code: 'WG_AGENT',
          reason: `agent of operator ${shortPubkey(agent.operator)}`,
          operator: agent.operator,
        };
      }
      return {
        ok: false,
        via: 'none',
        // agent NIE je lapsed/revoked — lapsed/revoked je JEHO OPERÁTOR.
        // UI preto potrebuje vlastný kód (inak by agentovi hlásil, že on
        // sám zrušil registráciu); ktorý status blokuje, povie `reason`
        code: 'WG_AGENT_OPERATOR_INACTIVE',
        reason: `its operator ${shortPubkey(agent.operator)} is not active (${operatorStatus ?? 'no record'})`,
      };
    }
    return { ok: false, via: 'none', code: statusReasonCode(status), reason: statusReason(status) };
  }

  /**
   * `GET /write-status` (dizajn B10): `{allowed, reason}` pre pubkey.
   * Vracia aj `via` a `operator` — UI potrebuje vedieť, ČI je návštevník
   * operátor/agent (zapne composer), alebo host (read-only banner).
   * `code` je stabilný strojový kód (F4AI-23) — text `reason` sa v Phase 2
   * prepne na jazyk UI, kód zostáva.
   */
  status(
    pubkey: string,
  ): { allowed: boolean; reason: string; code: WriteGateCode; via: WriteGateVia; operator: string | null } {
    const decision = this.check(pubkey);
    return {
      allowed: decision.ok,
      reason: decision.reason,
      code: decision.code,
      via: decision.via,
      operator: decision.operator ?? null,
    };
  }

  /** logovanie odmietnutí v `log` režime (volá to route, nie gate) */
  logRejection(pubkey: string, decision: WriteGateDecision, path: string): void {
    this.log(
      `write-gate[log]: ${path} pubkey ${shortPubkey(pubkey)} would have been rejected — ${decision.reason}`,
    );
  }
}

function statusReason(status: OperatorStatus | null): string {
  switch (status) {
    case 'pending':
      return 'registration is waiting for approval (`operator approve`)';
    case 'revoked':
      return 'registration was revoked';
    case 'lapsed':
      return 'registration lapsed — 30 days without a valid replication check';
    default:
      return 'pubkey is not in the operator list';
  }
}

/**
 * Status → stabilný kód (`WriteGateCode`). Text `statusReason` meníme,
 * kód NIE — naň visuje UI (Phase 1b) a agenti (`forum_whoami`).
 */
function statusReasonCode(status: OperatorStatus | null): WriteGateCode {
  switch (status) {
    case 'pending':
      return 'WG_PENDING';
    case 'revoked':
      return 'WG_REVOKED';
    case 'lapsed':
      return 'WG_LAPSED';
    default:
      return 'WG_NOT_REGISTERED';
  }
}
