// A running program's value table without the table: the controller's memory as bytes, and where each value is in it.
//
// The typed PLC engine keeps a controller's memory in one buffer whose layout is fixed when the program is compiled
// (docs/plc-typed-storage.md). Building a name -> value object from it and cloning that across the thread boundary
// cost more than everything else a large program's watch did: 577,725 values took ~215 ms to build and ~100-250 ms
// to receive, on every send. The bytes themselves are 8.8 MB and copy in 0.4 ms.
//
// So the sim worker sends the layout once per program and a copy of the bytes per update, and the main thread reads
// a value from its address when someone asks for it. A reader still sees `Readonly<Record<string, value>>`: the table
// is a Proxy, so `table[key]` and `key in table` work as on the object it replaces. Listing its keys through the
// Proxy is slow at that size (the engine checks the list), so code that lists them uses the helpers here.
//
// A table that is a plain object (the walker engine's, a remote controller's, a followed run's) goes through the same
// helpers and is read as the object it is.

/** a value as a watch table holds it (plc `TagValue`, which this layer cannot import) */
export type WatchValue = number | boolean | string

/** How a value is stored at its address: the view it is read through (plc/typed/arena.ts `load`). */
export const WATCH_KIND = { BOOL: 0, I8: 1, U8: 2, I16: 3, U16: 4, I32: 5, U32: 6, F32: 7, F64: 8, STRING: 9 } as const

/** Where each watch value of one compiled program is: `keys[i]` is at byte `addrs[i]`, stored as `kinds[i]`. */
export interface WatchLayout {
  keys: string[]
  addrs: Uint32Array
  kinds: Uint8Array
}

/** What a table that is not a plain object reads from. */
interface WatchSource {
  readonly keys: readonly string[]
  has(key: string): boolean
  get(key: string): WatchValue | undefined
  forEach(fn: (key: string, value: WatchValue) => void): void
  /** set `key` in place, when the source can: a write shown before the frame that confirms it */
  put?(key: string, value: WatchValue): boolean
}

// the position of each key of a layout, built when a key is first looked up and kept for the program's life
const indexes = new WeakMap<WatchLayout, Map<string, number>>()
function indexOf(layout: WatchLayout): Map<string, number> {
  let ix = indexes.get(layout)
  if (!ix) {
    ix = new Map()
    const keys = layout.keys
    for (let i = 0; i < keys.length; i++) ix.set(keys[i]!, i)
    indexes.set(layout, ix)
  }
  return ix
}

/** One copy of a controller's memory, read through its layout. */
class MemorySource implements WatchSource {
  readonly #layout: WatchLayout
  readonly #u8: Uint8Array
  readonly #i8: Int8Array
  readonly #i16: Int16Array
  readonly #u16: Uint16Array
  readonly #i32: Int32Array
  readonly #u32: Uint32Array
  readonly #f32: Float32Array
  readonly #f64: Float64Array

  constructor(layout: WatchLayout, bytes: ArrayBuffer) {
    this.#layout = layout
    this.#u8 = new Uint8Array(bytes)
    this.#i8 = new Int8Array(bytes)
    this.#i16 = new Int16Array(bytes)
    this.#u16 = new Uint16Array(bytes)
    this.#i32 = new Int32Array(bytes)
    this.#u32 = new Uint32Array(bytes)
    this.#f32 = new Float32Array(bytes)
    this.#f64 = new Float64Array(bytes)
  }

  get keys(): readonly string[] {
    return this.#layout.keys
  }

  has(key: string): boolean {
    return indexOf(this.#layout).has(key)
  }

  get(key: string): WatchValue | undefined {
    const i = indexOf(this.#layout).get(key)
    return i === undefined ? undefined : this.#at(i)
  }

  forEach(fn: (key: string, value: WatchValue) => void): void {
    const keys = this.#layout.keys
    for (let i = 0; i < keys.length; i++) fn(keys[i]!, this.#at(i))
  }

  put(key: string, value: WatchValue): boolean {
    const i = indexOf(this.#layout).get(key)
    if (i === undefined) return false
    const addr = this.#layout.addrs[i]!
    const kind = this.#layout.kinds[i]!
    if (kind === WATCH_KIND.STRING || typeof value === 'string') return false
    const n = typeof value === 'boolean' ? (value ? 1 : 0) : value
    switch (kind) {
      case WATCH_KIND.BOOL: this.#u8[addr] = value ? 1 : 0; break
      case WATCH_KIND.I8: this.#i8[addr] = n; break
      case WATCH_KIND.U8: this.#u8[addr] = n; break
      case WATCH_KIND.I16: this.#i16[addr >> 1] = n; break
      case WATCH_KIND.U16: this.#u16[addr >> 1] = n; break
      case WATCH_KIND.I32: this.#i32[addr >> 2] = n; break
      case WATCH_KIND.U32: this.#u32[addr >> 2] = n; break
      case WATCH_KIND.F32: this.#f32[addr >> 2] = n; break
      default: this.#f64[addr >> 3] = n
    }
    return true
  }

  #at(i: number): WatchValue {
    const addr = this.#layout.addrs[i]!
    switch (this.#layout.kinds[i]) {
      case WATCH_KIND.BOOL: return this.#u8[addr] !== 0
      case WATCH_KIND.I8: return this.#i8[addr]!
      case WATCH_KIND.U8: return this.#u8[addr]!
      case WATCH_KIND.I16: return this.#i16[addr >> 1]!
      case WATCH_KIND.U16: return this.#u16[addr >> 1]!
      case WATCH_KIND.I32: return this.#i32[addr >> 2]!
      case WATCH_KIND.U32: return this.#u32[addr >> 2]!
      case WATCH_KIND.F32: return this.#f32[addr >> 2]!
      case WATCH_KIND.F64: return this.#f64[addr >> 3]!
      default: {
        // a STRING: its length, then that many UTF-16 code units
        const at = addr >> 1
        const n = this.#u16[at]!
        let s = ''
        for (let k = 1; k <= n; k++) s += String.fromCharCode(this.#u16[at + k]!)
        return s
      }
    }
  }
}

/** A table over another: `over`'s values win, and `under`'s keys come first (the order `{ ...under, ...over }` gives). */
class OverlaySource implements WatchSource {
  #keys: string[] | null = null

  constructor(
    private readonly under: Readonly<Record<string, WatchValue>>,
    private readonly over: Readonly<Record<string, WatchValue>>,
  ) {}

  get keys(): readonly string[] {
    if (!this.#keys) {
      const keys = Object.keys(this.under)
      const mine = new Set(keys)
      for (const k of watchKeysOf(this.over)) if (!mine.has(k)) keys.push(k)
      this.#keys = keys
    }
    return this.#keys
  }

  has(key: string): boolean {
    return watchHas(this.over, key) || Object.hasOwn(this.under, key)
  }

  get(key: string): WatchValue | undefined {
    if (watchHas(this.over, key)) return this.over[key]
    return Object.hasOwn(this.under, key) ? this.under[key] : undefined
  }

  forEach(fn: (key: string, value: WatchValue) => void): void {
    for (const k of this.keys) fn(k, this.get(k)!)
  }
}

const SOURCE = Symbol('watch source')
type Target = { [SOURCE]: WatchSource }
const sources = new WeakMap<object, WatchSource>()

const handler: ProxyHandler<Target> = {
  get: (t, p) => (typeof p === 'string' ? t[SOURCE].get(p) : undefined),
  has: (t, p) => typeof p === 'string' && t[SOURCE].has(p),
  ownKeys: (t) => t[SOURCE].keys as string[],
  getOwnPropertyDescriptor: (t, p) => {
    if (typeof p !== 'string') return undefined
    const value = t[SOURCE].get(p)
    return value === undefined ? undefined : { value, writable: true, enumerable: true, configurable: true }
  },
  // a table is read; a value shown early goes through withWatchValue (core/watchKeys.ts)
  set: () => false,
  defineProperty: () => false,
  deleteProperty: () => false,
}

function tableOf(source: WatchSource): Readonly<Record<string, WatchValue>> {
  const table = new Proxy<Target>({ [SOURCE]: source }, handler) as unknown as Readonly<Record<string, WatchValue>>
  sources.set(table, source)
  return table
}

/** The watch table of a program whose values are at `layout` in this copy of its memory. */
export function memoryTable(layout: WatchLayout, bytes: ArrayBuffer): Readonly<Record<string, WatchValue>> {
  return tableOf(new MemorySource(layout, bytes))
}

/** `{ ...under, ...over }` without copying `over`: a large table with a few values of another kind beside it. */
export function overlayTable(under: Readonly<Record<string, WatchValue>>, over: Readonly<Record<string, WatchValue>>): Readonly<Record<string, WatchValue>> {
  return tableOf(new OverlaySource(under, over))
}

/** The table's keys, in its order. The array is the table's own: do not change it. */
export function watchKeysOf(table: Readonly<Record<string, WatchValue>>): readonly string[] {
  return sources.get(table)?.keys ?? Object.keys(table)
}

/** How many values the table holds. */
export function watchKeyCount(table: Readonly<Record<string, WatchValue>>): number {
  return watchKeysOf(table).length
}

/** Does the table hold nothing? Without listing the keys of a plain object. */
export function watchIsEmpty(table: Readonly<Record<string, WatchValue>>): boolean {
  const source = sources.get(table)
  if (source) return source.keys.length === 0
  for (const k in table) if (Object.hasOwn(table, k)) return false
  return true
}

/** Each value of the table, in its order. */
export function forEachWatchValue<V extends WatchValue>(table: Readonly<Record<string, V>>, fn: (key: string, value: V) => void): void {
  const source = sources.get(table)
  if (source) return source.forEach(fn as (key: string, value: WatchValue) => void)
  for (const k of Object.keys(table)) fn(k, table[k]!)
}

/** Does the table hold `key` itself (not through a prototype)? */
export function watchHas(table: Readonly<Record<string, WatchValue>>, key: string): boolean {
  const source = sources.get(table)
  return source ? source.has(key) : Object.hasOwn(table, key)
}

/** `table` with `key` already in it set to `value`, as a new table: written in place when the table is a copy of
 *  memory (the copy is this thread's own), else null and the caller copies the object. */
export function putWatchValue<V extends WatchValue>(table: Readonly<Record<string, V>>, key: string, value: V): Readonly<Record<string, V>> | null {
  const source = sources.get(table)
  if (!source?.put?.(key, value)) return null
  return tableOf(source) as Readonly<Record<string, V>>
}
