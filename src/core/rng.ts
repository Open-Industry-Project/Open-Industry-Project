// Deterministic seeded PRNG (mulberry32) for the simulation core. A digital twin's measurements
// must be reproducible - same scene + seed → same run → same numbers - so the sim uses this instead
// of Math.random (which is non-deterministic and would make measurements unrepeatable).
// See docs/architecture.md and src/core/simCore.ts.

export class Rng {
  private s: number

  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0
  }

  /** Next float in [0, 1). Deterministic given the seed. */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
