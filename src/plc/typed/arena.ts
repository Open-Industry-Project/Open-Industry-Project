// A typed controller's memory: one ArrayBuffer, sized when the program is compiled and never replaced, and the eight
// views every access goes through (docs/plc-typed-storage.md, "The arena"). Addresses are bytes; a place's layout
// (layout.ts) aligns it to its own size, so `I32[addr >> 2]` is exact.

import type { ScalarType, TagValue } from '../types'
import type { ScalarLayout } from './layout'

export class Arena {
  readonly buffer: ArrayBuffer
  readonly I8: Int8Array
  readonly U8: Uint8Array
  readonly I16: Int16Array
  readonly U16: Uint16Array
  readonly I32: Int32Array
  readonly U32: Uint32Array
  readonly F32: Float32Array
  readonly F64: Float64Array

  constructor(bytes: number) {
    // a whole number of 8-byte words, so every view covers all of it
    this.buffer = new ArrayBuffer(Math.max(8, Math.ceil(bytes / 8) * 8))
    this.I8 = new Int8Array(this.buffer)
    this.U8 = new Uint8Array(this.buffer)
    this.I16 = new Int16Array(this.buffer)
    this.U16 = new Uint16Array(this.buffer)
    this.I32 = new Int32Array(this.buffer)
    this.U32 = new Uint32Array(this.buffer)
    this.F32 = new Float32Array(this.buffer)
    this.F64 = new Float64Array(this.buffer)
  }

  /** The value of the scalar at `addr`, as the engine's surfaces answer it: a BOOL a boolean, a STRING text. */
  load(slot: ScalarLayout, addr: number): TagValue {
    switch (slot.scalar) {
      case 'BOOL': return this.U8[addr] !== 0
      case 'SINT': return this.I8[addr]!
      case 'USINT': case 'BYTE': return this.U8[addr]!
      case 'INT': return this.I16[addr >> 1]!
      case 'UINT': case 'WORD': return this.U16[addr >> 1]!
      case 'DINT': return this.I32[addr >> 2]!
      case 'UDINT': case 'DWORD': return this.U32[addr >> 2]!
      case 'REAL': return this.F32[addr >> 2]!
      case 'LREAL': case 'TIME': case 'DATE': case 'TOD': case 'DT': return this.F64[addr >> 3]!
      case 'STRING': return this.strAt(addr)
    }
  }

  /** Store a value already in the slot's form (coerced by the store rules, pou.ts), as the slot's view holds it. */
  store(slot: ScalarLayout, addr: number, v: TagValue): void {
    switch (slot.scalar) {
      case 'BOOL': this.U8[addr] = v ? 1 : 0; return
      case 'SINT': this.I8[addr] = v as number; return
      case 'USINT': case 'BYTE': this.U8[addr] = v as number; return
      case 'INT': this.I16[addr >> 1] = v as number; return
      case 'UINT': case 'WORD': this.U16[addr >> 1] = v as number; return
      case 'DINT': this.I32[addr >> 2] = v as number; return
      case 'UDINT': case 'DWORD': this.U32[addr >> 2] = v as number; return
      case 'REAL': this.F32[addr >> 2] = v as number; return
      case 'LREAL': case 'TIME': case 'DATE': case 'TOD': case 'DT': this.F64[addr >> 3] = v as number; return
      case 'STRING': this.strPut(addr, slot.cap!, v as string)
    }
  }

  /** A STRING's text: its length (U16) then that many UTF-16 code units. */
  strAt(addr: number): string {
    const at = addr >> 1
    const n = this.U16[at]!
    if (n === 0) return ''
    let s = ''
    for (let i = 1; i <= n; i++) s += String.fromCharCode(this.U16[at + i]!)
    return s
  }

  /** Write text into a STRING of capacity `cap`, cut to fit (a store already cut it: this keeps the slot whole whatever). */
  strPut(addr: number, cap: number, s: string): void {
    const at = addr >> 1
    const n = Math.min(s.length, cap)
    this.U16[at] = n
    for (let i = 0; i < n; i++) this.U16[at + 1 + i] = s.charCodeAt(i)
  }

  /** `aggregate := 0` at `addr`: each [offset, bytes] run of `ranges` (layout.ts clearRanges) zeroed */
  clear(addr: number, ranges: readonly number[]): void {
    for (let i = 0; i < ranges.length; i += 2) this.U8.fill(0, addr + ranges[i]!, addr + ranges[i]! + ranges[i + 1]!)
  }

  /** Copy `bytes` from `src` to `dst` (a whole array or struct of one type: the checker allows nothing else). */
  copy(dst: number, src: number, bytes: number): void {
    if (dst !== src) this.U8.copyWithin(dst, src, src + bytes)
  }
}

/** The view and shift a scalar type is read and written through, for generated code (`I32[(a) >> 2]`). */
export function viewOf(t: ScalarType): { view: string; shift: number } {
  switch (t) {
    case 'BOOL': case 'USINT': case 'BYTE': return { view: 'U8', shift: 0 }
    case 'SINT': return { view: 'I8', shift: 0 }
    case 'INT': return { view: 'I16', shift: 1 }
    case 'UINT': case 'WORD': return { view: 'U16', shift: 1 }
    case 'DINT': return { view: 'I32', shift: 2 }
    case 'UDINT': case 'DWORD': return { view: 'U32', shift: 2 }
    case 'REAL': return { view: 'F32', shift: 2 }
    case 'LREAL': case 'TIME': case 'DATE': case 'TOD': case 'DT': return { view: 'F64', shift: 3 }
    case 'STRING': return { view: 'U16', shift: 1 }
  }
}
