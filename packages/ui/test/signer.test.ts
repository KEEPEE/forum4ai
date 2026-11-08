/**
 * Testy Signera (F4AI-18/S12 → F4AI-23/24, Phase 1b) — všetky pozadia za
 * JEDNÍM rozhraním `{getPublicKey, signEvent, source, pubkey}`:
 *  - `nsec`: deterministický podpis cez `finalizeEvent` (overenie
 *    `verifyEvent` + zhoda id s `signEvent` zo S11 `nostr/keys.ts`)
 *  - `nip07`: falošný `window.nostr` provider, ktorý podpisuje reálnym
 *    kľúčom (aby `verifyEvent` prešiel) — a varianty so zlým id / zlým
 *    podpisom / cudzím pubkey
 *  - `bunker`: falošný NIP-46 MODUL (injectnutý, bez siete a WebSocketov)
 *    — overíme, že signer volá `connect()` a vzdialený `signEvent`, a že
 *    lokálne ostáva len kľúč konzumenta
 *  - `anonymous`: žiadny kľúč → `pubkey === null` a podpis s čitateľnou
 *    vetou (anonym je stav, nie chyba)
 *
 * `detectNip07` sa testuje s urychlenou lehotou: extension sa do stránky
 * vstrekuje async, preto krátku dobu POLLUJEME a až potom povieme „nie je
 * nainštalovaný“.
 */
import { describe, expect, it } from 'vitest';
import { finalizeEvent, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';

import {
  noSignerMessage,
  connectBunker,
  createAnonymousSigner,
  createNip07Signer,
  createNsecSigner,
  detectNip07,
  getNip07Provider,
  nsecAllowed,
  resolveSigner,
  restoreBunker,
  type BunkerModuleLike,
  type BunkerPointerLike,
  type BunkerRemoteSigner,
  type EventTemplate,
  type Nip07Provider,
} from '../src/nostr/signer.js';
import { identityFromNsec, signEvent as legacySignEvent } from '../src/nostr/keys.js';
import { TEST_NSEC, TEST_PUBKEY, hexId } from './fixtures.js';

const SECRET = identityFromNsec(TEST_NSEC).secretKey;

const TEMPLATE: EventTemplate = {
  kind: 1023,
  content: '# Titulok\n\ntelo odpovede',
  tags: [['e', 'e'.repeat(64), 'root']],
  created_at: 1_700_000_000,
};

function asVerifiable(event: unknown): Parameters<typeof verifyEvent>[0] {
  return event as Parameters<typeof verifyEvent>[0];
}

/** NIP-07 provider podpisujúci reálnym kľúčom; `defect` rozbije výstup */
export function makeNip07(defect?: 'bad-id' | 'bad-sig' | 'other-pubkey' | 'bad-hex'): Nip07Provider {
  return {
    getPublicKey: async () => (defect === 'bad-hex' ? 'zz' : getPublicKey(SECRET)),
    signEvent: async (event) => {
      const signed = finalizeEvent(
        {
          kind: Number(event['kind']),
          content: String(event['content']),
          tags: event['tags'] as string[][],
          created_at: Number(event['created_at']),
        },
        SECRET,
      );
      const out: Record<string, unknown> = { ...event, id: signed.id, sig: signed.sig };
      if (defect === 'bad-id') out['id'] = hexId('f');
      if (defect === 'bad-sig') out['sig'] = 'zz';
      if (defect === 'other-pubkey') out['pubkey'] = hexId('ab');
      return out;
    },
  };
}

describe('createNsecSigner (dev kľúč)', () => {
  it('pubkey je verejná časť identity a source je nsec', async () => {
    const signer = createNsecSigner(SECRET);
    expect(signer.source).toBe('nsec');
    expect(signer.pubkey).toBe(TEST_PUBKEY);
    await expect(signer.getPublicKey()).resolves.toBe(TEST_PUBKEY);
  });

  it('podpis je platný a id sedí so S11 signEvent', async () => {
    const signer = createNsecSigner(SECRET);
    const event = await signer.signEvent(TEMPLATE);
    expect(verifyEvent(asVerifiable(event))).toBe(true);
    const legacy = legacySignEvent({
      kind: TEMPLATE.kind,
      content: TEMPLATE.content,
      tags: TEMPLATE.tags,
      secretKey: SECRET,
      createdAt: TEMPLATE.created_at,
    });
    // BIP-340 podpisy sú v nostr-tools 2.x randomizované (auxRand) —
    // deterministický je LEN id (hash obsahu); sig overujeme verifyEvent
    expect(event.id).toBe(legacy.id);
    expect(verifyEvent(asVerifiable(legacy))).toBe(true);
  });

  it('výstup má kánonických 7 polí (teliesko pre POST /events)', async () => {
    const event = await createNsecSigner(SECRET).signEvent(TEMPLATE);
    expect(Object.keys(event).sort()).toEqual(['content', 'created_at', 'id', 'kind', 'pubkey', 'sig', 'tags']);
  });
});

describe('createNip07Signer (window.nostr mock)', () => {
  it('source je nip07 a pubkey berie z getPublicKey', async () => {
    const signer = await createNip07Signer(makeNip07());
    expect(signer.source).toBe('nip07');
    expect(signer.pubkey).toBe(TEST_PUBKEY);
  });

  it('podepísaný event prejde verifyEvent a id sedí s NIP-01 hashom', async () => {
    const signer = await createNip07Signer(makeNip07());
    const event = await signer.signEvent(TEMPLATE);
    expect(verifyEvent(asVerifiable(event))).toBe(true);
    expect(event.id).toBe(
      getEventHash({
        pubkey: TEST_PUBKEY,
        created_at: TEMPLATE.created_at,
        kind: TEMPLATE.kind,
        tags: TEMPLATE.tags,
        content: TEMPLATE.content,
      }),
    );
  });

  it('odmietne podpis s cudzím id (extension si vypočítal iný hash)', async () => {
    const signer = await createNip07Signer(makeNip07('bad-id'));
    await expect(signer.signEvent(TEMPLATE)).rejects.toThrow(/id/);
  });

  it('odmietne podpis bez 128-hex sig', async () => {
    const signer = await createNip07Signer(makeNip07('bad-sig'));
    await expect(signer.signEvent(TEMPLATE)).rejects.toThrow(/128-hex/);
  });

  it('odmietne cudzí pubkey v podpísanom evente', async () => {
    const signer = await createNip07Signer(makeNip07('other-pubkey'));
    await expect(signer.signEvent(TEMPLATE)).rejects.toThrow(/pubkey/);
  });

  it('getPublicKey s neplatným hex hodí hneď pri vytváraní signera', async () => {
    await expect(createNip07Signer(makeNip07('bad-hex'))).rejects.toThrow(/getPublicKey/);
  });
});

describe('createAnonymousSigner (žiadny kľúč je platný stav)', () => {
  it('pubkey je null a getPublicKey vráti null', async () => {
    const signer = createAnonymousSigner();
    expect(signer.source).toBe('anonymous');
    expect(signer.pubkey).toBeNull();
    await expect(signer.getPublicKey()).resolves.toBeNull();
  });

  it('pokus o podpis hodí vetu, ktorú UI ukáže ako výzvu na prihlásenie', async () => {
    await expect(createAnonymousSigner().signEvent(TEMPLATE)).rejects.toThrow(noSignerMessage());
  });
});

describe('detectNip07 (extension sa vstrekuje async)', () => {
  const scope = globalThis as unknown as { window: { nostr?: Partial<Nip07Provider> } };

  it('ihneď nájde provider, ktorý už je na window', async () => {
    scope.window.nostr = makeNip07();
    const found = await detectNip07({ timeoutMs: 50, intervalMs: 10 });
    expect(found).not.toBeNull();
    scope.window.nostr = undefined;
  });

  it('nájdie provider, ktorý sa objaví až po čase (polling)', async () => {
    let appeared = false;
    const timer = setTimeout(() => {
      scope.window.nostr = makeNip07();
      appeared = true;
    }, 30);
    const found = await detectNip07({ timeoutMs: 400, intervalMs: 20 });
    clearTimeout(timer);
    expect(appeared).toBe(true);
    expect(found).not.toBeNull();
    scope.window.nostr = undefined;
  });

  it('po lehote vráti null — nie je to chyba, anonym je platný stav', async () => {
    const found = await detectNip07({ timeoutMs: 40, intervalMs: 10 });
    expect(found).toBeNull();
  });

  it('injectnutý `provider` prehovorí priamo (test bez DOM)', async () => {
    await expect(detectNip07({ provider: null })).resolves.toBeNull();
    await expect(detectNip07({ provider: makeNip07() })).resolves.not.toBeNull();
  });

  it('čiastočný provider (bez signEvent) sa nepoužije', () => {
    scope.window.nostr = { getPublicKey: async () => TEST_PUBKEY };
    expect(getNip07Provider()).toBeNull();
    scope.window.nostr = undefined;
  });
});

describe('nsecAllowed (gate dev cesty)', () => {
  it('len presne „true“ povolí nsec tab', () => {
    expect(nsecAllowed({ VITE_ALLOW_NSEC: 'true' })).toBe(true);
    expect(nsecAllowed({ VITE_ALLOW_NSEC: '1' })).toBe(false);
    expect(nsecAllowed({ VITE_ALLOW_NSEC: 'TRUE' })).toBe(false);
    expect(nsecAllowed({})).toBe(false);
  });
});

// ── NIP-46 (bunker) — falošný modul, žiadna sieť ──────────────────────────

interface BunkerCalls {
  connects: number;
  getPublicKey: number;
  signEvent: number;
  metadata: unknown;
  pointer: BunkerPointerLike | null;
}

/** falošný `nostr-tools/nip46`: počítá volania a podpisuje LOKÁLNYM kľúčom */
function makeBunkerModule(options: { failConnect?: boolean; badPubkey?: boolean } = {}): {
  module: BunkerModuleLike;
  calls: BunkerCalls;
} {
  const calls: BunkerCalls = { connects: 0, getPublicKey: 0, signEvent: 0, metadata: null, pointer: null };
  const module: BunkerModuleLike = {
    parseBunkerInput: async (input) => {
      if (!input.startsWith('bunker://')) return null;
      return { relays: ['wss://relay.example'], pubkey: hexId('b1'), secret: 'sekret' };
    },
    BunkerSigner: {
      fromBunker: (_clientSk, pointer) => {
        calls.pointer = pointer;
        const remote: BunkerRemoteSigner = {
          connect: async (metadata) => {
            calls.connects += 1;
            calls.metadata = metadata;
            if (options.failConnect === true) throw new Error('bunker odmietol spojenie');
          },
          getPublicKey: async () => {
            calls.getPublicKey += 1;
            return options.badPubkey === true ? 'zz' : TEST_PUBKEY;
          },
          signEvent: async (event) => {
            calls.signEvent += 1;
            const signed = finalizeEvent(
              {
                kind: event.kind,
                content: event.content,
                tags: event.tags,
                created_at: event.created_at,
              },
              SECRET,
            );
            return { id: signed.id, sig: signed.sig };
          },
        };
        return remote;
      },
    },
  };
  return { module, calls };
}

const BUNKER_URI = 'bunker://abc?relay=wss://relay.example&secret=x';

describe('connectBunker (NIP-46, falošný modul bez siete)', () => {
  it('source je bunker a pubkey prišiel z bunkra', async () => {
    const { module, calls } = makeBunkerModule();
    const session = await connectBunker({ uri: BUNKER_URI, module });
    expect(session.signer.source).toBe('bunker');
    expect(session.signer.pubkey).toBe(TEST_PUBKEY);
    // `connect()` MUSÍ bežať hneď, inak bunker neukáže žiadosť o povolenie
    expect(calls.connects).toBe(1);
    expect(calls.metadata).toEqual({ name: 'forum4Ai' });
    expect(calls.pointer?.pubkey).toBe(hexId('b1'));
  });

  it('podpis ide cez vzdialený `signEvent` a prejde verifyEvent', async () => {
    const { module, calls } = makeBunkerModule();
    const { signer } = await connectBunker({ uri: BUNKER_URI, module });
    const event = await signer.signEvent(TEMPLATE);
    expect(calls.signEvent).toBe(1);
    expect(verifyEvent(asVerifiable(event))).toBe(true);
    expect(event.pubkey).toBe(TEST_PUBKEY);
  });

  it('vráti kľúč KONZUMENTA (hex) — nie koreňový kľúč bunkra', async () => {
    const { module } = makeBunkerModule();
    const session = await connectBunker({ uri: BUNKER_URI, module });
    expect(session.clientSecretKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(session.clientSecretKeyHex).not.toBe(TEST_PUBKEY);
  });

  it('neplatný odkaz → čitateľná veta (žiadny pokus o spojenie)', async () => {
    const { module, calls } = makeBunkerModule();
    await expect(connectBunker({ uri: 'https://priklad.sk', module })).rejects.toThrow(/neplatný bunker odkaz/);
    expect(calls.connects).toBe(0);
  });

  it('prázdny odkaz → veta, ktorá hovorí čo vložiť', async () => {
    const { module } = makeBunkerModule();
    await expect(connectBunker({ uri: '   ', module })).rejects.toThrow(/bunker:\/\/|nip05/);
  });

  it('zlyhanie `connect()` sa prenesie ako chyba s dôvodom', async () => {
    const { module } = makeBunkerModule({ failConnect: true });
    await expect(connectBunker({ uri: BUNKER_URI, module })).rejects.toThrow(/odmietol spojenie/);
  });

  it('bunker s neplatným pubkey → chyba, nie tichý anonym', async () => {
    const { module } = makeBunkerModule({ badPubkey: true });
    await expect(connectBunker({ uri: BUNKER_URI, module })).rejects.toThrow(/neplatný pubkey/);
  });

  it('restoreBunker obnoví reláciu z uloženej session', async () => {
    const { module, calls } = makeBunkerModule();
    const signer = await restoreBunker(
      { uri: BUNKER_URI, clientSecretKeyHex: hexId('a1') },
      { module },
    );
    expect(signer.source).toBe('bunker');
    expect(calls.connects).toBe(1);
  });

  it('restoreBunker odmietne poškodenú session skôr, než volá bunker', async () => {
    const { module, calls } = makeBunkerModule();
    await expect(restoreBunker({ uri: BUNKER_URI, clientSecretKeyHex: 'zz' }, { module })).rejects.toThrow(
      /kľúč konzumenta/,
    );
    expect(calls.connects).toBe(0);
  });
});

describe('resolveSigner (voľba „čo použiť, ak nič nie je prihlásené“)', () => {
  it('uprednostní window.nostr pred nsec', async () => {
    const signer = await resolveSigner({ nip07: makeNip07(), secretKey: SECRET });
    expect(signer.source).toBe('nip07');
  });

  it('bez NIP-07 použije nsec', async () => {
    const signer = await resolveSigner({ nip07: null, secretKey: SECRET });
    expect(signer.source).toBe('nsec');
    expect(signer.pubkey).toBe(TEST_PUBKEY);
  });

  it('bez oboch je anonym — žiadna výnimka pri vytvorení', async () => {
    const signer = await resolveSigner({ nip07: null, secretKey: null });
    expect(signer.source).toBe('anonymous');
    expect(signer.pubkey).toBeNull();
  });
});
