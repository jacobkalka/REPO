// Deterministic pseudo-random numbers. Client and server must produce identical
// results for the same seed, so nothing in shared/ may use Math.random().

/** xmur3 string hash → 32-bit seed generator */
export function hashString(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** Stable 32-bit hash of a string (for ids, sub-seeds). */
export function hash32(str: string): number {
  return hashString(str)();
}

/** sfc32 generator, period ~2^128. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: string | number) {
    const h = hashString(typeof seed === 'number' ? 'n' + seed : seed);
    this.a = h();
    this.b = h();
    this.c = h();
    this.d = h();
    for (let i = 0; i < 15; i++) this.next();
  }

  /** uniform in [0, 1) */
  next(): number {
    this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** integer in [min, max] inclusive */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rng.pick on empty array');
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** weighted pick; weights must be >= 0 and not all zero */
  weighted<T>(items: readonly T[], weight: (t: T) => number): T {
    let total = 0;
    for (const it of items) total += Math.max(0, weight(it));
    if (total <= 0) return items[0];
    let r = this.next() * total;
    for (const it of items) {
      r -= Math.max(0, weight(it));
      if (r < 0) return it;
    }
    return items[items.length - 1];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /** approximately normal(0,1) */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.732;
  }

  /** derive an independent generator */
  fork(tag: string): Rng {
    return new Rng(`${tag}:${this.int(0, 0x7fffffff)}`);
  }
}

/** Unambiguous room-code alphabet (no 0/O, 1/I/L). */
export const ROOM_CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXZ23456789';
