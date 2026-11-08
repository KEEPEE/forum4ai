/**
 * Klzacie okno (sliding window) rate limiter per kľúč (pubkey).
 * Čistý modul s injectable hodinami — testovateľný bez reálneho čakania.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** koľko udalostí ešte prejde v aktuálnom okne */
  remaining: number;
  /** za koľko ms sa uvoľní najstarší slot (0 pri povolení) */
  retryAfterMs: number;
}

export interface SlidingWindowOptions {
  maxEventsPerWindow: number;
  windowMs: number;
  /** injectable hodiny v ms — pre unit testy */
  now?: () => number;
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  /**
   * Kľúče, ktoré už nemajú žiadne údery v okne, mažeme (code-review A5):
   * bez toho `hits` rastie bez stropu s každým novým pubkey, čo dlhobežiaci
   * relay zamestná len pamäťou. Prah je nasadený vysoko, bežný pubkey
   * ním neprejde; sweep je O(size) a robí sa len pri jeho prekročení.
   */
  private static readonly SWEEP_THRESHOLD = 10_000;

  constructor(opts: SlidingWindowOptions) {
    if (!Number.isInteger(opts.maxEventsPerWindow) || opts.maxEventsPerWindow <= 0) {
      throw new TypeError('maxEventsPerWindow musí byť kladné celé číslo');
    }
    if (!(opts.windowMs > 0)) {
      throw new TypeError('windowMs musí byť kladné číslo');
    }
    this.max = opts.maxEventsPerWindow;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Skontroluje a pri povolení aj zaznamená jeden úder (EVENT správu) pre `key`.
   * Zamietnuté správy sa nezaznamenávajú — okno naplnia len akceptované úvery.
   */
  check(key: string): RateLimitResult {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const seen = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);

    if (seen.length === 0) this.hits.delete(key);
    else this.hits.set(key, seen);

    if (this.hits.size > SlidingWindowRateLimiter.SWEEP_THRESHOLD) {
      for (const [k, ts] of this.hits) {
        const last = ts[ts.length - 1];
        if (last === undefined || last <= cutoff) this.hits.delete(k);
      }
    }

    if (seen.length >= this.max) {
      const oldest = seen[0] ?? now;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, oldest + this.windowMs - now),
      };
    }

    seen.push(now);
    this.hits.set(key, seen);
    return { allowed: true, remaining: this.max - seen.length, retryAfterMs: 0 };
  }

  reset(): void {
    this.hits.clear();
  }
}
