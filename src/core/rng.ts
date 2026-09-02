// Seeded PRNG (mulberry32). Seed comes from ?seed= URL param, default 1337.

export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [a, b). */
  range(a: number, b: number): number { return a + this.next() * (b - a); }
  /** Integer in [a, b]. */
  int(a: number, b: number): number { return Math.floor(this.range(a, b + 1)); }
  /** True with probability p. */
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(arr: readonly T[]): T { return arr[this.int(0, arr.length - 1)]; }
}

function urlParams(): URLSearchParams {
  if (typeof window === 'undefined') return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

export const PARAMS = urlParams();

export function param(name: string): string | null { return PARAMS.get(name); }

export function paramNum(name: string, fallback: number): number {
  const v = PARAMS.get(name);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const SEED = paramNum('seed', 1337);

/** Shared world-generation stream. Systems that need their own stream make a new Rng. */
export const rng = new Rng(SEED);
