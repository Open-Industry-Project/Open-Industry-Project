// What the WebAssembly emitter's files share (scanWasm.ts, scanWasmCalls.ts): the byte writer, the kinds of value on
// the stack, the link between one program's bodies, and what the host keeps for the helpers a body imports.

import type { GenBody, GenInternals } from './scanCodegen'
import { type TypeLayout, TypedUnsupported } from './typed/layout'
import type { Expr, ScalarType, TagValue } from './types'

/** a construct the emitter cannot write: the whole program is refused, and runs on the walker */
export const no = (what: string): never => {
  throw new TypedUnsupported(what)
}

/** what was written, for a bench to report */
export const wasmStats = { bodies: 0, statements: 0, bytes: 0, emitMs: 0 }

export type Kind = 'b' | 'i' | 'u' | 'f'
/** a held argument: a value of a kind, or a text the host keeps ('t') */
export type Held = Kind | 't'
export const I32 = 0x7f
export const I64 = 0x7e
export const F64 = 0x7c
export const VOID = 0x40

export const SIGNED_NARROW: Partial<Record<ScalarType, number>> = { SINT: 0xc0, INT: 0xc1 }
export const MASK: Partial<Record<ScalarType, number>> = { USINT: 0xff, BYTE: 0xff, UINT: 0xffff, WORD: 0xffff }
export const WIDE: Partial<Record<ScalarType, true>> = { UDINT: true, DWORD: true }
export const isWidth = (t: string | undefined): t is ScalarType => t === 'SINT' || t === 'INT' || t === 'DINT' || t === 'USINT' || t === 'BYTE' || t === 'UINT' || t === 'WORD' || t === 'UDINT' || t === 'DWORD'
export const RANGE: Partial<Record<ScalarType, readonly [number, number]>> = { SINT: [-128, 127], INT: [-32768, 32767], DINT: [-2147483648, 2147483647], USINT: [0, 255], BYTE: [0, 255], UINT: [0, 65535], WORD: [0, 65535], UDINT: [0, 4294967295], DWORD: [0, 4294967295] }
export const kindOf = (t: ScalarType): Kind => (t === 'BOOL' ? 'b' : WIDE[t] ? 'u' : isWidth(t) ? 'i' : t === 'STRING' ? no('a STRING') : 'f')

/**
 * The bodies of one program, where they can call each other without leaving WebAssembly: a table of functions, with a
 * place for each user block's body (given when a call of it is first written, filled when its body is made). Every
 * block's body is made before a program scans (typed/pou.ts finish), so no call finds its place empty.
 */
/** a body as the module exports it: the instance's address, the scan's time, the frame's address */
export type WasmBody = (b: number, now: number, m: number) => void
export interface Link {
  table: WebAssembly.Table
  places: Map<object, number>
}
export const links = new WeakMap<WebAssembly.Memory, Link>()
export function linkOf(memory: WebAssembly.Memory): Link {
  let link = links.get(memory)
  if (!link) links.set(memory, (link = { table: new WebAssembly.Table({ element: 'anyfunc', initial: 16 }), places: new Map() }))
  return link
}
export function placeOf(link: Link, runner: object): number {
  let at = link.places.get(runner)
  if (at === undefined) {
    at = link.places.size
    link.places.set(runner, at)
    if (at >= link.table.length) link.table.grow(link.table.length)
  }
  return at
}
/** A block's body, once made: put where the calls of it look (typed/pou.ts TypedFb.prepare). */
export function publishWasmBody(runner: object, body: GenBody): void {
  const made = body as GenBody & { wasm?: WasmBody; memory?: WebAssembly.Memory }
  if (!made.wasm || !made.memory) return
  const link = linkOf(made.memory)
  link.table.set(placeOf(link, runner), made.wasm as never)
}

/** bytes being written */
export class Bytes {
  buf = new Uint8Array(1024)
  len = 0
  #room(n: number): void {
    if (this.len + n <= this.buf.length) return
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n))
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }
  u8(b: number): this {
    this.#room(1)
    this.buf[this.len++] = b
    return this
  }
  op(...b: number[]): this {
    this.#room(b.length)
    for (const x of b) this.buf[this.len++] = x
    return this
  }
  uleb(n: number): this {
    this.#room(6)
    do {
      let b = n % 128
      n = Math.floor(n / 128)
      if (n !== 0) b |= 0x80
      this.buf[this.len++] = b
    } while (n !== 0)
    return this
  }
  /** a signed whole number (any that a double holds exactly) */
  sleb(n: number): this {
    this.#room(11)
    for (;;) {
      const b = ((n % 128) + 128) % 128
      n = Math.floor(n / 128)
      if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) {
        this.buf[this.len++] = b
        return this
      }
      this.buf[this.len++] = b | 0x80
    }
  }
  f64(x: number): this {
    this.#room(8)
    new DataView(this.buf.buffer, this.buf.byteOffset).setFloat64(this.len, x, true)
    this.len += 8
    return this
  }
  name(s: string): this {
    this.uleb(s.length)
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i))
    return this
  }
  bytes(other: Bytes): this {
    this.#room(other.len)
    this.buf.set(other.buf.subarray(0, other.len), this.len)
    this.len += other.len
    return this
  }
  done(): Uint8Array {
    return this.buf.subarray(0, this.len)
  }
}

/** A byte address being built: a run-time part (code that leaves an i32) and a constant part. */
export interface Address {
  dyn: (() => void) | null
  off: number
  layout: TypeLayout
}

/** what the module is handed for one import: built over the helpers, this body's constants and its escapes */
export interface Host {
  H: Record<string, unknown>
  W: unknown[]
  x: GenInternals
  /** a text on its way from the call that made it to the store that takes it */
  text: TagValue
  /** the arguments of the function calls being put together, innermost last */
  args: unknown[][]
  /** the texts calls answered that a later call or a compare reads: each by its place here, given back when read */
  texts: TagValue[]
}
/** the text a helper was handed: a literal ('S'), a STRING place ('s') or what a call answered ('T') */
export function textOf(h: Host, kind: string, v: number): string {
  return kind === 'S' ? (h.W[v] as string) : kind === 'T' ? (h.texts[v] as string) : (h.H.strAt as (a: number) => string)(v)
}
export interface Import {
  index: number
  type: number
  make(host: Host): unknown
}
export interface Fn {
  type: number
  locals: number[]
  code: Bytes
}


/** scanCodegen.ts readsOnly: a place whose read runs nothing but loads */
export function readsOnly(e: Expr): boolean {
  switch (e.node) {
    case 'var':
    case 'this':
    case 'num':
      return true
    case 'member':
      return readsOnly(e.obj)
    case 'index':
      return readsOnly(e.obj) && e.indices.every(readsOnly)
    default:
      return false
  }
}
