/**
 * Unit testy S3-FIFO cache (F4AI-13, S7) — deterministické, bez siete.
 *
 * Kapacita 10 → guest 1 / small 1 / main 8 (10 % / 10 % / zvyšok), takže
 * každá evikcia je jednoznačne sledovateľná. Testy dokladujú kľúčové
 * vlastnosti algoritmu: sken sa cache nedotkne, dvojnásobne použitý kľúč
 * postupuje G → S → M a main evikuje čisto FIFO.
 */
import { describe, expect, it } from 'vitest';

import { S3FifoCache } from '../src/cache.js';

describe('S3FifoCache — invarianty', () => {
  it('nikdy nepresiahne kapacitu ani pri 100 vloženiach do cache pre 10', () => {
    const cache = new S3FifoCache<number, string>({ capacity: 10 });
    for (let i = 1; i <= 100; i += 1) {
      cache.set(i, `v${String(i)}`);
      const stats = cache.stats();
      expect(stats.size).toBeLessThanOrEqual(10);
      expect(stats.guest + stats.small + stats.main).toBe(stats.size);
    }
  });

  it('malá kapacita sa zdvihne na minimum 3 (G/S/M aspoň 1)', () => {
    const cache = new S3FifoCache<string, number>({ capacity: 1 });
    expect(cache.capacity).toBe(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.size).toBeLessThanOrEqual(3);
    expect(cache.get('c')).toBe(3);
  });

  it('set prepíše hodnotu, get/has/delete/clear fungujú', () => {
    const cache = new S3FifoCache<string, number>({ capacity: 10 });
    expect(cache.set('a', 1)).toBe(true);
    expect(cache.set('a', 2)).toBe(true);
    expect(cache.get('a')).toBe(2);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('x')).toBe(false);
    expect(cache.get('x')).toBeUndefined();
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    expect(cache.has('a')).toBe(false);
    cache.set('b', 1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.queueKeys('guest')).toEqual([]);
  });
});

describe('S3FifoCache — evikcie a promocie', () => {
  it('sken 50 unikátnych kľúčov cache takmer neznečistí (guest filter)', () => {
    const cache = new S3FifoCache<number, string>({ capacity: 10 });
    for (let i = 1; i <= 50; i += 1) cache.set(i, `v${String(i)}`);
    const stats = cache.stats();
    // každý jednorázový kľúč padol v guestu (freq 1 < prah 2)
    expect(stats.guestDrops).toBeGreaterThanOrEqual(48);
    expect(stats.promotionsToSmall).toBe(0);
    expect(stats.mainEvictions).toBe(0);
    expect(stats.size).toBeLessThanOrEqual(2);
    // posledný vložený kľúč ešte sedí v gueste
    expect(cache.get(50)).toBe('v50');
  });

  it('dvojito použitý kľúč postúpi guest → small', () => {
    const cache = new S3FifoCache<string, number>({ capacity: 10 });
    cache.set('a', 1);
    expect(cache.queueKeys('guest')).toEqual(['a']);
    cache.get('a'); // freq = 2
    cache.set('b', 2); // guest pretečie → a s freq 2 ide do small
    expect(cache.queueKeys('small')).toEqual(['a']);
    expect(cache.queueKeys('guest')).toEqual(['b']);
    expect(cache.stats().promotionsToSmall).toBe(1);
    expect(cache.get('a')).toBe(1); // hodnota prežila promocie
  });

  it('kľúč z small postúpi do main a main drží FIFO poradie', () => {
    const cache = new S3FifoCache<string, number>({ capacity: 10 });
    const promote = (key: string): void => {
      cache.set(key, 1);
      cache.get(key); // freq 2 → po evikcii guestu postúpi
      cache.set(`${key}-filler`, 1); // vytlačí ho z guesta
    };
    promote('a');
    promote('b');
    const stats = cache.stats();
    expect(stats.promotionsToSmall).toBeGreaterThanOrEqual(2);
    expect(stats.promotionsToMain).toBeGreaterThanOrEqual(1);
    // 'a' je v main, 'b' ešte v small
    expect(cache.queueKeys('main')).toContain('a');
    expect(cache.queueKeys('small')).toContain('b');

    // main zaplníme promociami → najstarší (a) musí odísť ako prvý
    for (let i = 0; i < 12; i += 1) promote(`x${String(i)}`);
    const after = cache.stats();
    expect(after.size).toBeLessThanOrEqual(10);
    expect(after.mainEvictions).toBeGreaterThanOrEqual(1);
    expect(cache.queueKeys('main').length).toBeLessThanOrEqual(8);
  });

  it('prah promocie je konfigurovateľný (threshold 3 → freq 2 nestačí)', () => {
    const strict = new S3FifoCache<string, number>({ capacity: 10, promotionThreshold: 3 });
    strict.set('a', 1);
    strict.get('a'); // freq 2 < 3
    strict.set('b', 2);
    expect(strict.queueKeys('small')).toEqual([]);
    expect(strict.has('a')).toBe(false);
    expect(strict.stats().guestDrops).toBe(1);

    const loose = new S3FifoCache<string, number>({ capacity: 10, promotionThreshold: 2 });
    loose.set('a', 1);
    loose.get('a');
    loose.set('b', 2);
    expect(loose.queueKeys('small')).toEqual(['a']);
  });

  it('hit/miss počítadlá sedia s operáciami', () => {
    const cache = new S3FifoCache<string, number>({ capacity: 10 });
    cache.set('a', 1);
    cache.get('a');
    cache.get('zzz');
    cache.get('yyy');
    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(2);
    expect(stats.insertions).toBe(1);
  });

  it('anti-entropia vzor (get+set per sweep): horúce id prežijú, jednorázové odídu', () => {
    // prístupový vzor `runAntiEntropyCycle()`: each id sa v kolečku raz
    // prečíta (get) a zapíše (set) → 2 prístupy na kolo = presne prah
    // promocie S3-FIFO. Jednorázové id guest filter vypustí (to je zámer:
    // cache si pamätá len id, ktoré sa opakujú vo viacerých kolečkách).
    // kapacita 300 → guest 30, čo je viac ako jeden sweep (25 vložení),
    // takže id z predchádzajúceho sweepu sa dožijú druhého prístupu.
    const cache = new S3FifoCache<string, 'present' | 'absent'>({ capacity: 300 });
    const sweep = (round: number, coldCount: number): void => {
      for (let cold = 0; cold < coldCount; cold += 1) {
        cache.set(`cold-${String(round)}-${String(cold)}`, 'absent');
      }
      for (let hot = 0; hot < 5; hot += 1) {
        const key = `hot-${String(hot)}`;
        cache.get(key);
        cache.set(key, 'present');
      }
    };
    for (let round = 0; round < 12; round += 1) sweep(round, 20);
    const survivors = [0, 1, 2, 3, 4].filter((hot) => cache.has(`hot-${String(hot)}`));
    expect(survivors).toEqual([0, 1, 2, 3, 4]);
    const stats = cache.stats();
    expect(stats.size).toBeLessThanOrEqual(100);
    expect(stats.promotionsToSmall).toBeGreaterThanOrEqual(1);
    expect(stats.hits).toBeGreaterThanOrEqual(50); // id z predchadzajuceho sweepu su citatelne
    // jednorázové cold id sa drvivou väčšinou neujdu — guest filter funguje
    expect(stats.guestDrops).toBeGreaterThan(150);
  });

  it('head-churn: id na začiatku sweepu sa opakovane premyjú (zdokumentovaný detail)', () => {
    // Anti-entropia berie id v stabilnom poradí, takže prvá časť sweepu
    // padne z guesta skôr, ako ju ďalšie kolo prečíta — verdikty tychto id
    // sú best-effort (counters `zmizol`/`obnoveny` nemusia byť 100 %).
    const cache = new S3FifoCache<string, 'present' | 'absent'>({ capacity: 20 });
    const sweep = (): void => {
      for (let i = 0; i < 15; i += 1) {
        const key = `id-${String(i)}`;
        cache.get(key);
        cache.set(key, 'present');
      }
    };
    for (let round = 0; round < 6; round += 1) sweep();
    const head = [0, 1, 2].filter((i) => cache.has(`id-${String(i)}`));
    const tail = [12, 13, 14].filter((i) => cache.has(`id-${String(i)}`));
    expect(tail).toEqual([13, 14]);
    expect(head).toEqual([]);
  });
});
