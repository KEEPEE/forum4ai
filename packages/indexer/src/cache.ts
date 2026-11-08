/**
 * S3-FIFO cache — the base for indexer query results (F4AI-13, S7).
 *
 * Algorithm (SOSP'23 paper "S3-FIFO: Simple, Fast and Practical Caching"):
 * three FIFO queues + access counters:
 *   G (guest)  — input filtering queue; a new key starts HERE,
 *   S (small)  — small warm set; a key gets here if it was used in G at
 *                least `promotionThreshold` times,
 *   M (main)   — the main cache region; a key is promoted from S at the same
 *                threshold, and from there eviction is plain FIFO (no second chance).
 *
 * A key that was never used twice never pollutes the cache at all (scans and
 * one-shot queries fly through G and fall out). That is exactly the property
 * we need from a query-result cache.
 *
 * Capacity split: G = 10 %, S = 10 %, M = the rest (the paper uses
 * 10/10/80 of the total cache size). Invariant: the sum of all three
 * queues is always <= `capacity` — we always evict from the queue that has
 * just outgrown its own cap (G → S → M), so the algorithm always advances
 * by at least one removal.
 *
 * In the indexer the cache is used for the anti-entropy id-set (`verdict`
 * presence on a relay) and is ready for S8 query results as well. Tests: `test/cache.test.ts`.
 */
export interface S3FifoOptions {
  /** celková kapacita (G + S + M) */
  capacity: number;
  /** podiel G a S na kapacite, default 0.1 (paper) */
  fifoRatio?: number;
  /** koľko prístupu musí kľúč mať, aby postúpil z G do S / zo S do M, default 2 */
  promotionThreshold?: number;
}

export interface S3FifoStats {
  size: number;
  capacity: number;
  guest: number;
  small: number;
  main: number;
  hits: number;
  misses: number;
  insertions: number;
  /** kľúky zahodené v G (nikdy nedosiahli S — "scan" traffic) */
  guestDrops: number;
  /** kľúky vyhodené zo S (neprešli prahom) */
  smallEvictions: number;
  /** kľúky vyhodené z M (plná hlavná časť) */
  mainEvictions: number;
  promotionsToSmall: number;
  promotionsToMain: number;
}

/** FIFO fronta kľúčov — Map zachováva poradie vkladania, čelo = najstarší. */
class FifoQueue<K> {
  private readonly set = new Set<K>();

  get size(): number {
    return this.set.size;
  }

  has(key: K): boolean {
    return this.set.has(key);
  }

  push(key: K): void {
    // opätovné vloženie neposúva poradie (FIFO, nie LRU)
    if (!this.set.has(key)) this.set.add(key);
  }

  remove(key: K): boolean {
    return this.set.delete(key);
  }

  /** vyberie a odstráni najstarší kľúč, undefined ak je fronta prázdna */
  shift(): K | undefined {
    for (const key of this.set) {
      this.set.delete(key);
      return key;
    }
    return undefined;
  }

  clear(): void {
    this.set.clear();
  }

  keys(): K[] {
    return [...this.set];
  }
}

export class S3FifoCache<K, V> {
  readonly capacity: number;
  private readonly guestCap: number;
  private readonly smallCap: number;
  private readonly mainCap: number;
  private readonly threshold: number;

  private readonly guest = new FifoQueue<K>();
  private readonly small = new FifoQueue<K>();
  private readonly main = new FifoQueue<K>();
  private readonly values = new Map<K, V>();
  private readonly freq = new Map<K, number>();

  private hits = 0;
  private misses = 0;
  private insertions = 0;
  private guestDrops = 0;
  private smallEvictions = 0;
  private mainEvictions = 0;
  private promotionsToSmall = 0;
  private promotionsToMain = 0;

  constructor(options: S3FifoOptions) {
    const capacity = Math.max(3, Math.floor(options.capacity));
    const ratio = options.fifoRatio ?? 0.1;
    this.capacity = capacity;
    this.guestCap = Math.max(1, Math.floor(capacity * ratio));
    this.smallCap = Math.max(1, Math.floor(capacity * ratio));
    this.mainCap = Math.max(1, capacity - this.guestCap - this.smallCap);
    this.threshold = Math.max(2, Math.floor(options.promotionThreshold ?? 2));
  }

  /** počet prítomných kľúčov (G + S + M) */
  get size(): number {
    return this.values.size;
  }

  /** prítomnosť bez zvýšenia frekvencie (neovplyvňuje promotions) */
  has(key: K): boolean {
    return this.values.has(key);
  }

  /** vráti hodnotu a zvýši frekvenciu (kľúč sa môže posunúť k postupu) */
  get(key: K): V | undefined {
    if (!this.values.has(key)) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    this.freq.set(key, (this.freq.get(key) ?? 0) + 1);
    return this.values.get(key);
  }

  /**
   * Vloží/aktualizuje záznam. Nový kľúč vstupuje do G. Vráti `true`, ak je
   * kľúč po operácii v cache, `false` ak ho evikčná politika okamžite zahodila.
   */
  set(key: K, value: V): boolean {
    if (this.values.has(key)) {
      this.values.set(key, value);
      this.freq.set(key, (this.freq.get(key) ?? 0) + 1);
      return true;
    }
    this.insertions += 1;
    this.values.set(key, value);
    this.freq.set(key, 1);
    this.guest.push(key);
    this.evict();
    return this.values.has(key);
  }

  delete(key: K): boolean {
    const existed = this.values.delete(key);
    this.freq.delete(key);
    this.guest.remove(key);
    this.small.remove(key);
    this.main.remove(key);
    return existed;
  }

  clear(): void {
    this.guest.clear();
    this.small.clear();
    this.main.clear();
    this.values.clear();
    this.freq.clear();
  }

  /** diagnostika pre logy indexera a testy evikcií */
  stats(): S3FifoStats {
    return {
      size: this.values.size,
      capacity: this.capacity,
      guest: this.guest.size,
      small: this.small.size,
      main: this.main.size,
      hits: this.hits,
      misses: this.misses,
      insertions: this.insertions,
      guestDrops: this.guestDrops,
      smallEvictions: this.smallEvictions,
      mainEvictions: this.mainEvictions,
      promotionsToSmall: this.promotionsToSmall,
      promotionsToMain: this.promotionsToMain,
    };
  }

  /** náhled fronty (testy determinizmu poradia evikcií) */
  queueKeys(which: 'guest' | 'small' | 'main'): K[] {
    return which === 'guest' ? this.guest.keys() : which === 'small' ? this.small.keys() : this.main.keys();
  }

  // ── interné ────────────────────────────────────────────────────────────

  /**
   * Udržiava invaint `|G| + |S| + |M| <= capacity` a per-frontové stropy.
   * Krok buď niečo vymaže, alebo postúpi kľúč do ďalšej fronty — po
   * najviac troch postupeniach vždy vymaže, takže smyčka končí.
   */
  private evict(): void {
    const guardLimit = this.capacity * 4 + 16;
    let steps = 0;
    while (this.values.size > this.capacity || this.guest.size > this.guestCap
        || this.small.size > this.smallCap || this.main.size > this.mainCap) {
      steps += 1;
      if (steps > guardLimit) {
        // poistka: nikdy nie sme horší ako "vymaž čelo najväčšej fronty"
        this.dropOldest();
        continue;
      }
      if (this.guest.size > this.guestCap) this.evictGuest();
      else if (this.small.size > this.smallCap) this.evictSmall();
      else if (this.main.size > this.mainCap) this.evictMain();
      else break; // žiadna fronta nad stropom a celok v kapacite
    }
  }

  /** G: často používaný kľúč postupuje do S, inak zahodiť (scan filter) */
  private evictGuest(): void {
    const key = this.guest.shift();
    if (key === undefined) return;
    if ((this.freq.get(key) ?? 0) >= this.threshold) {
      this.small.push(key);
      this.promotionsToSmall += 1;
      return;
    }
    this.values.delete(key);
    this.freq.delete(key);
    this.guestDrops += 1;
  }

  /** S: často používaný kľúč postupuje do M, inak zahodiť */
  private evictSmall(): void {
    const key = this.small.shift();
    if (key === undefined) return;
    if ((this.freq.get(key) ?? 0) >= this.threshold) {
      this.main.push(key);
      this.promotionsToMain += 1;
      return;
    }
    this.values.delete(key);
    this.freq.delete(key);
    this.smallEvictions += 1;
  }

  /** M: už žiadna druhá šanca — čisto FIFO (paper tu robí 2 % re-insert,
   *  ten tu zámerne nie je: u query výsledkov je horší ako nič) */
  private evictMain(): void {
    const key = this.main.shift();
    if (key === undefined) return;
    this.values.delete(key);
    this.freq.delete(key);
    this.mainEvictions += 1;
  }

  private dropOldest(): void {
    for (const queue of [this.guest, this.small, this.main] as const) {
      const key = queue.shift();
      if (key !== undefined) {
        this.values.delete(key);
        this.freq.delete(key);
        this.guestDrops += 1;
        return;
      }
    }
  }
}
