// Small deterministic PRNG (mulberry32). Both ends of the link must generate
// identical sequences for pilots, whitening, interleaving and fountain coefficients.

export class Prng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** Next uint32. */
  nextU32(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  /** Uniform in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }
  bit(): number {
    return this.nextU32() >>> 31;
  }
  /** Standard normal (Box-Muller). */
  gauss(): number {
    let u = this.next();
    if (u < 1e-12) u = 1e-12;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
}

/** Mix two integers into a seed. */
export function hashSeed(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b);
  h ^= h >>> 16;
  return h >>> 0;
}
