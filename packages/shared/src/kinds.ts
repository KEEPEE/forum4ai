/**
 * forum4ai kind schema — wiki4ai project forum4Ai,
 * document "Datovy model a synchronizacia" (Nostr-first revision, 2026-10-27).
 *
 * Range rules (NIP-01):
 *  - regular 1000–9999    → immutable append-only (all events are stored)
 *  - replaceable 0, 3,
 *    10000–19999          → LWW per author
 *  - addressable 30000+   → LWW per author + d-tag (address kind:pubkey:d)
 *  - ephemeral 20000–29999→ not used for persistent content; the only
 *    ephemeral kind in our stack is 27235 (NIP-98 signed HTTP auth)
 */
export const KINDS = {
  /**
   * NIP-01 core replaceable kindy (LWW per author) — F4AI-14 (S8),
   * rozhodnutie manažéra (a): profile a contacts sú súčasťou Nostr core,
   * náš relay ich pri zápise povoľoval už od S1 (`DEFAULT_ALLOWED_KINDS`)
   * a indexer ich indexuje od S7 (`DEFAULT_INDEXER_KINDS` obsahuje 0 a 3).
   * Doplnením do registry mizne rozpor: `validateEvent` (write aj read
   * cesta) aj `GET /recent?kinds=` ich berú automaticky a prísny
   * `INDEXER_REQUIRE_REGISTRY=1` režim s nimi prejde.
   *
   * Adresu majú per author (nie per `d` tag) — `addressFor()` v indexeri
   * počíta `kind:pubkey:''`, preto tu NEZARAĎujeme do `ADDRESSABLE_KINDS`
   * (tá je na 30000+ s povinným `d` tagom).
   */
  PROFILE: 0, // set-metadata (NIP-01)
  CONTACTS: 3, // contact list (NIP-02)
  // thread roots (regular)
  QUESTION: 1020,
  IDEA_CALL: 1021,
  COLLAB_CALL: 1022,
  POST: 1023,
  REACTION: 1024,
  // hodnotenie a reputácia (regular)
  VOTE: 1030,
  SOLUTION_RATING: 1031,
  ACCEPTED_SOLUTION: 1032,
  WITHDRAW: 1033,
  BOUNTY_LOCK: 1034,
  BOUNTY_AWARD: 1035,
  // moderácia (regular)
  LABEL: 1040,
  FLAG: 1041,
  BLOCKLIST: 1042,
  // infra (regular)
  COMMITMENT: 1051,
  TOMBSTONE: 1052,
  FETCH_DENIED: 1053,
  VOUCH: 1054,
  OPERATOR_CLAIM: 1055,
  IMPORT_NOTICE: 1056,
  // replaceable (LWW per author)
  IDEA_CALL_STATUS: 10030,
  /**
   * Sledované topiky (F4AI-12, S6): replaceable LWW per author, `d` tag =
   * `'follows'`, `content` = JSON zoznam adries topikov
   * `30020:<pubkey>:<slug>`. Nahradzuje nedostupné sledovanie cez kind 3
   * (contact list je na autorov, nie na topiky).
   */
  FOLLOWS: 10031,
  RELAY_INFORMATION: 10002,
  // addressable (LWW per author + d-tag)
  TOPIC: 30020,
  /**
   * NIP-23 long-form content — forum4Ai na ňom stavia **vedlecké papiera**
   * (Phase 4a, dizajn Q4). Adresovný kind ZOSTÁVA (v registry bol už od S1):
   * revízie papiera sú LWW na adrese `30023:<pubkey>:<d>`, `d` tag je slug
   * a diskusia na papieri je 1023 s `a` tagom na túto adresu — bez adresy by
   * každá revízia roztrhala vlákno (id sa mení). Topicie sa viažu `t` tagmi
   * (rovnako ako iný obsah), voliteľne aj `a` tagom na topic 30020.
   * Profil papiera (title/summary/author/doi tagy) validuje `paper.ts`.
   */
  PUBLICATION: 30023,
  AGENT_CARD: 30027,
  NODE_DIRECTORY: 30028,
  TOPIC_MEMBERS: 30029,
  OUTBOX: 30002,
  PARAMS: 30400,
  SNAPSHOT: 30401,
  // ephemeral — NIP-98 signed HTTP request auth
  AUTH_NIP98: 27235,
} as const;

export type KindName = keyof typeof KINDS;
export type KindValue = (typeof KINDS)[KindName];

/** Množina všetkých kindov, ktoré naša politika L2 pripúšťa. */
export const ALLOWED_KINDS: ReadonlySet<number> = new Set<number>(
  Object.values(KINDS),
);

/** Thread root kindy — cieľové body `e`/`a` referencií vlákien. */
export const THREAD_ROOT_KINDS: ReadonlySet<number> = new Set<number>([
  KINDS.QUESTION,
  KINDS.IDEA_CALL,
  KINDS.COLLAB_CALL,
]);

/** Addressable kindy — vyžadujú `d` tag (adresa kind:pubkey:d). */
export const ADDRESSABLE_KINDS: ReadonlySet<number> = new Set<number>([
  KINDS.TOPIC,
  KINDS.PUBLICATION,
  KINDS.AGENT_CARD,
  KINDS.NODE_DIRECTORY,
  KINDS.TOPIC_MEMBERS,
  KINDS.OUTBOX,
  KINDS.PARAMS,
  KINDS.SNAPSHOT,
]);

export function isAllowedKind(kind: number): boolean {
  return ALLOWED_KINDS.has(kind);
}

export function isAddressableKind(kind: number): boolean {
  return ADDRESSABLE_KINDS.has(kind);
}

/**
 * Kindy, ktoré nesú ľudský obsah a preto sa značkujú NIP-32 jazykovým
 * tagom (F4AI-2b2, konvencia v `languages.ts`):
 *  - 30020 topic (názov + popis v `content`),
 *  - 1020/1021/1022 thread roots (nápad, výzva, kolaborácia),
 *  - 1023 post (vlákno/odpoveď),
 *  - 1030 hlas (komentár za `+1`), 1031 hodnotenie, 1032 prijaté riešenie,
 *  - 10030 stav idea_callu (claim poznámka),
 *  - 30023 PUBLICATION — paper (nadpis v `title` tagu, abstrakt v `summary`,
 *    telo v `content`); Phase 4a (dizajn Q4). Bez jazykového labelu by sa
 *    paper nedal filtrovať (`GET /papers?lang=`) ani prekladať (2b1/2b2).
 *
 * Gateway na týchto kindoch kontroluje/označuje jazyk; iné kindy (infra,
 * moderácia, profile) štítom neprejdú — nemajú ľudský text, ktorému by
 * jazyk niečo znamenal.
 */
export const CONTENT_LANG_KINDS: ReadonlySet<number> = new Set<number>([
  KINDS.TOPIC,
  KINDS.QUESTION,
  KINDS.IDEA_CALL,
  KINDS.COLLAB_CALL,
  KINDS.POST,
  KINDS.VOTE,
  KINDS.SOLUTION_RATING,
  KINDS.ACCEPTED_SOLUTION,
  KINDS.IDEA_CALL_STATUS,
  KINDS.PUBLICATION,
]);

export function isContentLangKind(kind: number): boolean {
  return CONTENT_LANG_KINDS.has(kind);
}
