// A host-owned copy of something part code handed back (docs/part-sandbox.md). What a sandboxed part returns
// (geometry() submeshes, its declared snap / unit / lamps) is its own object: it can carry getters or be a Proxy, so
// reading it later runs part code, and the part keeps a reference it can change after the host has validated or
// memoised it. Copying once, at the boundary, makes everything downstream plain data the part cannot reach.
//
// Plain data only: primitives as they are; arrays, typed arrays and objects rebuilt entry by entry, each read
// once; functions and symbols dropped; a `__proto__` key skipped; depth and length bounded, so a hostile
// value cannot make the copy itself run away.

const MAX_DEPTH = 16
/** larger than any real mesh array (a 100k-vertex part is ~0.3M numbers), small enough to bound a hostile one */
const MAX_LENGTH = 16_000_000

function copyEntry(x: unknown, depth: number): unknown {
  if (x === null) return null
  const t = typeof x
  if (t === 'object') return hostCopy(x, depth + 1)
  return t === 'function' || t === 'symbol' ? undefined : x
}

// V8 remembers the element kind an array literal's arrays reach and starts later arrays from that literal in it.
// One literal for every array would box mesh numbers once it had held a list of submeshes, and a boxed array
// copies into a Float32Array ~25x slower (10.7 ms vs 0.4 ms for 330k numbers, the rack's resize re-emit). So
// number arrays come from their own literal, and only an array that turns out to hold something else uses the other.
function copyArray(src: ArrayLike<unknown>, n: number, depth: number): unknown[] {
  const nums: number[] = []
  for (let i = 0; i < n; i++) {
    const x = src[i]
    if (typeof x === 'number') {
      nums.push(x)
      continue
    }
    // the first non-number: move to a mixed array, keeping the read-once order
    const out: unknown[] = []
    for (let j = 0; j < i; j++) out.push(nums[j])
    out.push(copyEntry(x, depth))
    for (let k = i + 1; k < n; k++) {
      const y = src[k]
      out.push(typeof y === 'number' ? y : copyEntry(y, depth))
    }
    return out
  }
  return nums
}

/** a plain-data copy of `v` that shares nothing with it */
export function hostCopy<T = unknown>(v: T, depth = 0): T {
  if (v === null || typeof v !== 'object') return (typeof v === 'function' || typeof v === 'symbol' ? undefined : v) as T
  if (depth > MAX_DEPTH) return undefined as T
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const src = v as unknown as ArrayLike<unknown>
    const n = Number(src.length) >>> 0
    if (n > MAX_LENGTH) return [] as unknown as T
    return copyArray(src, n, depth) as unknown as T
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(v)) {
    if (key === '__proto__') continue
    out[key] = copyEntry((v as Record<string, unknown>)[key], depth)
  }
  return out as T
}
