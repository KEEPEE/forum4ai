/**
 * Kontext relácie (F4AI-17 → F4AI-23/24, Phase 1b).
 *
 * Pred Phase 1b tu sedela `Identity` (nsec v `localStorage`) a pri prvej
 * návšteve sa TICHO vygeneroval nový kľúč. To je preč (dizajn Q1):
 * **návštevník bez kľúča je platný stav** — fórum číta, composer nevidí,
 * žiadny náhodný pubkey sa nikde nehlása. Relácia teraz znamená
 * `{signer, pubkey}` — kto podpíše, a pozadie z `localStorage`
 * (`forum4ai_signer = nip07 | bunker | nsec`) + NIP-46 session.
 *
 * Pravidlá, ktorá sa nesmú porušiť:
 *  - `identity === null` → anonym; KAŽDÁ čítacia cesta musí fungovať aj tak
 *    (write-status sa pýta len keď pubkey existuje, composer je zamknutý),
 *  - súkromný kľúč sa ukladá LEN do `sessionStorage` a LEN keď build
 *    povie `VITE_ALLOW_NSEC=true` (dev),
 *  - `localStorage` nikdy neobsahuje tajomstvo — len predvoľbu pozadia a
 *    NIP-46 pointer (kľúč konzumenta, nie koreňový kľúč bunkra),
 *  - NIP-07 má pri štarte prednosť pred všetkým (dizajn Q1: default
 *    podpisovateľ je extension), ale nikdy neblokuje načítanie stránky.
 *
 * Testy injectnú `storage` / `sessionStorage` (memory), `identity`
 * (predpriadaná dev identita), `nip07` (falošný `window.nostr`) alebo
 * `bunkerModule` (falošný NIP-46 bez siete).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';

import { npubOf } from '../lib/npub.js';
import { t } from '../i18n/text.js';
import {
  NSEC_STORAGE_KEY,
  browserSessionStorage,
  browserStorage,
  identityFromNsec,
  loadStoredIdentity,
  type Identity,
  type KeyStorage,
} from './keys.js';
import {
  connectBunker,
  createAnonymousSigner,
  createNip07Signer,
  createNsecSigner,
  detectNip07,
  nsecAllowed,
  restoreBunker,
  type BunkerModuleLike,
  type Nip07Provider,
  type Signer,
  type SignerSource,
} from './signer.js';

/** predvoľba pozadia v `localStorage` (dizajn Q1: `forum4ai_signer`) */
export const SIGNER_STORAGE_KEY = 'forum4ai_signer';
/** NIP-46 session v `localStorage`: `{uri, clientSk}` — kľúč KONZUMENTA */
export const BUNKER_STORAGE_KEY = 'forum4ai_bunker';

/**
 * Lehota detekcie NIP-07. Extension (`window.nostr`) sa do stránky
 * vstrekuje async, preto krátku dobu POLLUJEME — ale strop MUSÍ byť
 * nízky, inak návštevník bez extensionu civí na „prihlasujem…“.
 */
export const NIP07_DETECT_TIMEOUT_MS = 1200;

export type SignerPreference = 'nip07' | 'bunker' | 'nsec';
export type SessionStatus = 'anonymous' | 'connecting' | 'connected' | 'error';

/** kým UI ukazuje identitu: kto sme a odkiaľ podpisujeme */
export interface SessionIdentity {
  pubkey: string;
  /** NIP-19 `npub1…` — to, čo ukazujeme verejne (nikdy nie nsec) */
  npub: string;
  source: SignerSource;
}

export interface IdentityValue {
  /** `null` = anonym (žiadny kľúč) — všetky čítacie cesty musia fungovať aj tak */
  identity: SessionIdentity | null;
  /** podpisovateľ; `null` kým dobehne obnova relácie */
  signer: Signer | null;
  status: SessionStatus;
  /** čitateľná slovenská veta (zamietnutý extension, nedostupný bunker…) */
  error: string | null;
  /** build dovoľuje dev nsec (`VITE_ALLOW_NSEC=true`) */
  nsecAllowed: boolean;
  /** po štarte známe: má prehliadač `window.nostr`? */
  nip07Available: boolean;
  /** prihlásenie cez NIP-07 extension; hádže čitateľnú chybu */
  connectNip07(): Promise<void>;
  /** prihlásenie cez NIP-46 (`bunker://…` alebo `nip05@doména`) */
  connectBunker(uri: string): Promise<void>;
  /** dev prihlásenie vložením nsec (sessionStorage, gate v env) */
  connectNsec(nsec: string): Promise<void>;
  /** odhlásenie: zahodí pozadie aj predvoľbu — anonym je konečný stav */
  disconnect(): void;
}

const EMPTY_VALUE: IdentityValue = {
  identity: null,
  signer: null,
  status: 'connecting',
  error: null,
  nsecAllowed: false,
  nip07Available: false,
  connectNip07: async () => undefined,
  connectBunker: async () => undefined,
  connectNsec: async () => undefined,
  disconnect: () => undefined,
};

const IdentityContext = createContext<IdentityValue>(EMPTY_VALUE);

// ── úložisko predvoľby (nikdy nie tajomstvo okrem NIP-46 konzumenta) ──────

function readPref(storage: KeyStorage | null): SignerPreference | null {
  try {
    const raw = storage?.getItem(SIGNER_STORAGE_KEY);
    return raw === 'nip07' || raw === 'bunker' || raw === 'nsec' ? raw : null;
  } catch {
    return null;
  }
}

function writePref(storage: KeyStorage | null, pref: SignerPreference | null): void {
  try {
    if (pref === null) storage?.removeItem(SIGNER_STORAGE_KEY);
    else storage?.setItem(SIGNER_STORAGE_KEY, pref);
  } catch {
    /* zamknuté úložisko: relácia platí pre tento tab */
  }
}

interface BunkerRecord {
  uri: string;
  clientSk: string;
}

function readBunkerRecord(storage: KeyStorage | null): BunkerRecord | null {
  try {
    const raw = storage?.getItem(BUNKER_STORAGE_KEY);
    if (typeof raw !== 'string' || raw === '') return null;
    const parsed = JSON.parse(raw) as Partial<BunkerRecord>;
    if (typeof parsed.uri !== 'string' || typeof parsed.clientSk !== 'string') return null;
    return { uri: parsed.uri, clientSk: parsed.clientSk };
  } catch {
    return null;
  }
}

function writeBunkerRecord(storage: KeyStorage | null, record: BunkerRecord | null): void {
  try {
    if (record === null) storage?.removeItem(BUNKER_STORAGE_KEY);
    else storage?.setItem(BUNKER_STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* ignore */
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function IdentityProvider({
  storage,
  sessionStorage: sessionStorageProp,
  identity: identityProp,
  nip07,
  bunkerModule,
  allowNsec,
  nip07TimeoutMs,
  children,
}: {
  /** `localStorage`-like úložisko (predvoľba + NIP-46 session) */
  storage?: KeyStorage | null;
  /** `sessionStorage`-like úložisko (dev nsec) */
  sessionStorage?: KeyStorage | null;
  /**
   * Test/dev: predpriadaná nsec identita. Je to EXPLICITNÝ vstup, preto
   * nepodlieha gate `VITE_ALLOW_NSEC` — test nesmie závisieť od env.
   */
  identity?: Identity | null;
  /** injectnutý NIP-07 provider (testy); default: live `window.nostr` */
  nip07?: Nip07Provider | null;
  /** injectnutý NIP-46 modul (testy); default: dynamický import */
  bunkerModule?: BunkerModuleLike;
  /** default `nsecAllowed()` z env; testy nastavia priamo */
  allowNsec?: boolean;
  /**
   * Lehota detekcie NIP-07 (ms). Produkcia 1200 — extension sa vstrekuje
   * async. Testy nastavia 0, inak by každá relácia čakala sekundu a pol
   * na stav „anonym“ (a test by padal na 1 s wait).
   */
  nip07TimeoutMs?: number;
  children: ReactNode;
}): JSX.Element {
  const store = useMemo(() => (storage === undefined ? browserStorage() : storage), [storage]);
  const sessionStore = useMemo(
    () => (sessionStorageProp === undefined ? browserSessionStorage() : sessionStorageProp),
    [sessionStorageProp],
  );
  const gate = allowNsec ?? nsecAllowed();
  const seeded = identityProp ?? null;
  const detectTimeout = nip07TimeoutMs ?? NIP07_DETECT_TIMEOUT_MS;

  // Predpriadaná identita sa nasadí SYNCHRONNE — prvý render musí mať
  // podpisovateľa, inak by composer na okamih ukázal „prihlás sa“ aj
  // keď je kľúč v poriadku (a test by padal pred detekciou).
  const [signer, setSigner] = useState<Signer | null>(() =>
    seeded !== null ? createNsecSigner(seeded.secretKey) : null,
  );
  const [status, setStatus] = useState<SessionStatus>(() => (seeded !== null ? 'connected' : 'connecting'));
  const [error, setError] = useState<string | null>(null);
  const [nip07Available, setNip07Available] = useState<boolean>(nip07 !== undefined && nip07 !== null);

  /** jeden vstupný bod pre výsledok — stav nemôže rozhadzovať viac miest */
  const attach = useCallback((next: Signer, message: string | null = null): void => {
    setSigner(next);
    if (next.pubkey === null) {
      setStatus(message === null ? 'anonymous' : 'error');
      setError(message);
    } else {
      setStatus('connected');
      setError(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus('connecting');

    void (async () => {
      // 0) explicitný vstup (test/dev) poráža predvoľby aj detekciu —
      //    inak by test závisel od toho, čo náhodne nájde na `window`
      if (seeded !== null) {
        // signer už bol nasadený synchronne v initial state — NEVYTVÁRAJ
        // nový objekt, inak sa každá stránka kvôli zmenenej identite
        // `signer` naimportí znova (dvojité GET pri otvorení stránky)
        setSigner((current) =>
          current !== null && current.source === 'nsec' && current.pubkey === seeded.pubkey
            ? current
            : createNsecSigner(seeded.secretKey),
        );
        setStatus('connected');
        setError(null);
        return;
      }

      const pref = readPref(store);

      // 1) NIP-46: jediná predvoľba, ktorá prežíva bez lokálneho tajomstva
      if (pref === 'bunker') {
        const record = readBunkerRecord(store);
        if (record !== null) {
          try {
            const restored = await restoreBunker(
              { uri: record.uri, clientSecretKeyHex: record.clientSk },
              bunkerModule !== undefined ? { module: bunkerModule } : {},
            );
            if (!cancelled) attach(restored);
          } catch (err) {
            if (!cancelled) attach(createAnonymousSigner(), `bunker: ${messageOf(err)}`);
          }
          return;
        }
      }

      // 2) dev nsec zo `sessionStorage` (len keď build dovoľuje)
      if (pref === 'nsec' && gate) {
        const stored = loadStoredIdentity(sessionStore);
        if (stored !== null) {
          if (!cancelled) attach(createNsecSigner(stored.secretKey));
          return;
        }
      }

      // 3) NIP-07 — default pozadie dizajnu Q1. Extension sa vstrekuje
      //    async, preto kratučká detekcia s lehotou (`detectNip07`).
      const provider = nip07 !== undefined ? nip07 : await detectNip07({ timeoutMs: detectTimeout });
      if (cancelled) return;
      setNip07Available(provider !== null);
      if (provider !== null) {
        try {
          const nip07Signer = await createNip07Signer(provider);
          if (!cancelled) attach(nip07Signer);
        } catch (err) {
          // zamietnutý prístup → anonym S DÔVODOM, nie tichý pád
          if (!cancelled) attach(createAnonymousSigner(), `NIP-07: ${messageOf(err)}`);
        }
        return;
      }

      // 4) dev nsec zo session, inak anonym
      if (gate) {
        const stored = loadStoredIdentity(sessionStore);
        if (stored !== null && !cancelled) {
          attach(createNsecSigner(stored.secretKey));
          return;
        }
      }
      if (!cancelled) attach(createAnonymousSigner());
    })();

    return () => {
      cancelled = true;
    };
  }, [store, sessionStore, gate, seeded, nip07, detectTimeout, bunkerModule, attach]);

  const connectNip07 = useCallback(async (): Promise<void> => {
    setStatus('connecting');
    const provider = nip07 !== undefined ? nip07 : await detectNip07({ timeoutMs: detectTimeout });
    setNip07Available(provider !== null);
    if (provider === null) {
      const message =
        t('auth:errors.extensionMissing');
      attach(createAnonymousSigner(), message);
      throw new Error(message);
    }
    try {
      const next = await createNip07Signer(provider);
      writePref(store, 'nip07');
      writeBunkerRecord(store, null);
      attach(next);
    } catch (err) {
      const message = `NIP-07: ${messageOf(err)}`;
      attach(createAnonymousSigner(), message);
      throw err instanceof Error ? new Error(message) : err;
    }
  }, [store, nip07, detectTimeout, attach]);

  const connectBunkerWith = useCallback(
    async (uri: string): Promise<void> => {
      setStatus('connecting');
      try {
        const session = await connectBunker({
          uri,
          ...(bunkerModule !== undefined ? { module: bunkerModule } : {}),
          clientMetadata: { name: 'forum4Ai' },
        });
        writePref(store, 'bunker');
        writeBunkerRecord(store, { uri: session.uri, clientSk: session.clientSecretKeyHex });
        attach(session.signer);
      } catch (err) {
        const message = messageOf(err);
        attach(createAnonymousSigner(), message);
        throw err instanceof Error ? new Error(message) : err;
      }
    },
    [store, bunkerModule, attach],
  );

  const connectNsecWith = useCallback(
    async (nsec: string): Promise<void> => {
      setStatus('connecting');
      if (!gate) {
        const message = t('auth:errors.nsecDisabled');
        attach(createAnonymousSigner(), message);
        throw new Error(message);
      }
      try {
        // normalizujeme na `nsecEncode` hodnotu (vstup môže byť hex / veľký /
        // s `0x`), aby sa do úložiska nedostalo to, čo používáč nastrákal
        const parsed: Identity = identityFromNsec(nsec);
        try {
          sessionStore?.setItem(NSEC_STORAGE_KEY, parsed.nsec);
        } catch {
          /* zamknuté úložisko: relácia platí pre tento tab */
        }
        writePref(store, 'nsec');
        attach(createNsecSigner(parsed.secretKey));
      } catch (err) {
        const message = messageOf(err);
        attach(createAnonymousSigner(), message);
        throw err instanceof Error ? new Error(message) : err;
      }
    },
    [gate, store, sessionStore, attach],
  );

  const disconnect = useCallback((): void => {
    writePref(store, null);
    writeBunkerRecord(store, null);
    try {
      sessionStore?.removeItem(NSEC_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    // NO bootstrap: anonym je po odhlásení konečný stav, nech sa nám
    // nevráti pozadie, ktoré sa práve povedlo odpojiť
    attach(createAnonymousSigner());
  }, [store, sessionStore, attach]);

  const value = useMemo<IdentityValue>(() => {
    const pubkey = signer?.pubkey ?? null;
    const identity: SessionIdentity | null =
      pubkey !== null ? { pubkey, npub: npubOf(pubkey), source: signer?.source ?? 'anonymous' } : null;
    return {
      identity,
      signer,
      status: signer === null ? 'connecting' : status,
      error,
      nsecAllowed: gate,
      nip07Available,
      connectNip07,
      connectBunker: connectBunkerWith,
      connectNsec: connectNsecWith,
      disconnect,
    };
  }, [signer, status, error, gate, nip07Available, connectNip07, connectBunkerWith, connectNsecWith, disconnect]);

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

export function useIdentity(): IdentityValue {
  return useContext(IdentityContext);
}
