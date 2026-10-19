import { describe, it, expect } from 'vitest'
import { bucketCapacity } from './instanceCapacity'

// bucketCapacity is the Tier-1 mitigation for the WebGPU resize hitch: instance buffers are sized to coarse
// power-of-two buckets so a small resize stays under capacity and reuses the same mesh (warm pipeline)
// instead of minting a fresh one (cold compile on the draw path). It also does a second job:
// three bakes the capacity into the generated WGSL (`array<mat4x4<f32>, CAPACITY>`), so distinct capacities
// are distinct shaders and distinct cold compiles at load. The floor of 128 keeps that count low.
// These guard the properties both jobs rely on: every result is a power-of-two >= the request (never
// under-allocates), the ladder is coarse, and it is monotonic.
describe('bucketCapacity', () => {
  it('floors at 128 for small / zero / negative requests (no zero-length buffer)', () => {
    expect(bucketCapacity(0)).toBe(128)
    expect(bucketCapacity(1)).toBe(128)
    expect(bucketCapacity(8)).toBe(128)
    expect(bucketCapacity(128)).toBe(128)
    expect(bucketCapacity(-5)).toBe(128)
  })

  it('rounds up to the next power of two above the floor', () => {
    expect(bucketCapacity(129)).toBe(256)
    expect(bucketCapacity(256)).toBe(256)
    expect(bucketCapacity(257)).toBe(512)
    expect(bucketCapacity(1000)).toBe(1024)
    expect(bucketCapacity(1025)).toBe(2048)
  })

  // The purpose of the floor: every bank at or under it declares the same WGSL array size, so they
  // share one compiled shader instead of one per size. The demo scene's 13 distinct capacities collapse
  // to 2 under this.
  it('collapses every small bank onto one declared capacity (shader sharing)', () => {
    const observed = [2, 4, 5, 8, 10, 13, 16, 20, 32, 64, 128] // measured on the demo scene
    expect(new Set(observed.map(bucketCapacity)).size).toBe(1)
  })

  it('never under-allocates and stays a power of two', () => {
    for (let n = 1; n <= 4096; n++) {
      const cap = bucketCapacity(n)
      expect(cap).toBeGreaterThanOrEqual(n) // must fit the request
      expect(Number.isInteger(Math.log2(cap))).toBe(true) // power of two
    }
  })

  it('wastes less than 2x above the floor (bounded headroom)', () => {
    for (let n = 129; n <= 4096; n++) expect(bucketCapacity(n)).toBeLessThan(n * 2)
  })

  it('is monotonic - a larger request never yields a smaller buffer', () => {
    let prev = 0
    for (let n = 0; n <= 5000; n += 7) {
      const cap = bucketCapacity(n)
      expect(cap).toBeGreaterThanOrEqual(prev)
      prev = cap
    }
  })
})
