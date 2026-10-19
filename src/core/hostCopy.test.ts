import { describe, expect, it } from 'vitest'
import { hostCopy } from './hostCopy'

describe('hostCopy', () => {
  it('copies nested plain data and shares nothing with the source', () => {
    const src = { desc: { positions: [0, 1.5, -2], indices: [0, 1, 2] }, name: 'deck', on: true }
    const out = hostCopy(src)
    expect(out).toEqual(src)
    expect(out).not.toBe(src)
    expect(out.desc.positions).not.toBe(src.desc.positions)
    src.desc.positions[0] = 9
    expect(out.desc.positions[0]).toBe(0)
  })

  it('copies a typed array into a plain number array', () => {
    const out = hostCopy(new Float32Array([1, 2.5, 3]))
    expect(Array.isArray(out)).toBe(true)
    expect(out).toEqual([1, 2.5, 3])
  })

  it('keeps order when a non-number appears partway through a number array', () => {
    expect(hostCopy([1, 2, { a: [3, 4] }, 'x', 5])).toEqual([1, 2, { a: [3, 4] }, 'x', 5])
    expect(hostCopy(['x', 1, 2])).toEqual(['x', 1, 2])
    expect(hostCopy([1, 2, null])).toEqual([1, 2, null])
  })

  it('drops functions and symbols, and skips a __proto__ key', () => {
    expect(hostCopy([1, () => 2, Symbol('s'), 3])).toEqual([1, undefined, undefined, 3])
    const evil = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as Record<string, unknown>
    const out = hostCopy(evil)
    expect(Object.keys(out)).toEqual(['ok'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('reads each array entry once, including across the switch to a mixed array', () => {
    const reads = new Map<number, number>()
    const src = new Proxy([1, 2, { k: 3 }, 4], {
      get(target, key, recv) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads.set(Number(key), (reads.get(Number(key)) ?? 0) + 1)
        return Reflect.get(target, key, recv) as unknown
      },
    })
    expect(hostCopy(src)).toEqual([1, 2, { k: 3 }, 4])
    expect([...reads.values()]).toEqual([1, 1, 1, 1])
  })

  it('keeps a number array unboxed after copying arrays of objects', () => {
    // A boxed copy (V8 starting it as a generic array because the same literal held objects) copies into a
    // Float32Array ~25x slower than a fresh array of the same numbers, and the rack's resize copies 330k of them
    // per pointer-move. A ratio within one process, so the machine's speed cancels out.
    for (let i = 0; i < 5; i++) hostCopy([{ desc: { positions: [1.5, 2], indices: [0, 1] } }, [{}], [1, { a: 2 }]])
    const src: number[] = []
    for (let i = 0; i < 300_000; i++) src.push(i * 0.37)
    const copied = hostCopy(src)
    const fresh = Array.from(src)
    const dst = new Float32Array(src.length)
    const best = (a: number[]): number => {
      let min = Infinity
      for (let r = 0; r < 7; r++) {
        const t = performance.now()
        dst.set(a)
        min = Math.min(min, performance.now() - t)
      }
      return min
    }
    best(copied)
    best(fresh)
    const ratio = best(copied) / Math.max(best(fresh), 0.01)
    expect(ratio).toBeLessThan(5)
  })

  it('bounds depth', () => {
    let deep: unknown = 1
    for (let i = 0; i < 40; i++) deep = [deep]
    expect(() => hostCopy(deep)).not.toThrow()
  })
})
