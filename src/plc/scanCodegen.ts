// What a definition's body is, and what it is handed (docs/plc-typed-storage.md). The typed engine writes each body as
// a WebAssembly module (scanWasm.ts): `(b, now, m) => void`, built once per definition (shared by every instance) and
// handed the instance's base address `b` in the program's arena (typed/arena.ts). A variable is a load or a store at an
// offset decided when the program was laid out (typed/layout.ts), a global at an absolute address. Everything outside
// the scan (watch, memory, setInput, ports, starting values) is the typed POU's (typed/pou.ts).
//
// A body does what the walker (interpreter.ts buildPou's evalExpr / execStmt) does, node for node. The walker is the
// reference (plc/scanEngines.test.ts holds the two together, every variable after every scan) and the fallback. There
// is no per-node fallback: a construct the emitter cannot write refuses the whole program (TypedUnsupported).
//
// This file holds the types the emitter and the typed POUs share, and the helpers a body imports for what it does not
// do itself: a fault, a division, a store's coercion of a value that is not in its place's form.

import { FAULT, StFault } from './faults'
import type { Env } from './program'
import { bool, calendarRangeError, idiv, imod, num, roundEven, unboundMessage, wrap } from './runtime'
import { generateWasmBody, generateWasmValue } from './scanWasm'
import type { Expr, MethodDef, ScalarType, SourcePos, Stmt, TagValue, Value } from './types'
import { StError } from './types'
import { type PouLayout, type StructLayout, type TypeLayout, TypedUnsupported } from './typed/layout'

/** One generated body: run on the instance whose region starts at `b`, at controller clock `now`; a METHOD's with its
 *  frame (its own variables) at `m`. */
export type GenBody = (b: number, now: number, m?: number) => void

/** A method of one class, as generated code calls it (typed/pou.ts TypedMethod): a frame taken and started, the body run
 *  on an instance with it, the frame given back. */
export interface MethodRunner {
  readonly frame: PouLayout
  enter(b: number): number
  run(b: number, now: number, m: number): void
  leave(m: number): void
}

/** A definition's names: its own declarations first, then the program's globals, and where each one is. */
export interface GenScope {
  env: Env
  genv: Env | null
  typed: TypedScope
}

/** Where a definition's names live (docs/plc-typed-storage.md): the generated body is shared by every instance of it
 *  and handed the instance's base address `b`, so a local is `b + off`; a global is an absolute address, fixed for the
 *  program. */
export interface TypedScope {
  /** `ref`: the name is a whole array or struct VAR_IN_OUT, or a REF_TO (`nullable`: NULL until given a reference),
   *  whose slot holds the address of what it refers to. `iface`: an interface variable, whose slot holds the address
   *  of the instance it refers to. `frame`: a method's own variable, at an offset from its frame `m` */
  resolve(name: string): { layout: TypeLayout; global: boolean; off: number; ref?: TypeLayout; nullable?: true; iface?: string; frame?: true } | undefined
  /** the class whose instance a block's body or method runs on: THIS, at `b` */
  cls?: { name: string; layout: StructLayout }
  /** `impl` generated for instances of class `concrete` */
  method(concrete: string, impl: MethodDef): MethodRunner
  /** the body of class `base`, generated for instances of class `concrete` (SUPER^()) */
  baseBody(concrete: string, base: string): { run(b: number, now: number): void }
  /** for each class number, what an instance of that class runs for `key` (a call through an interface or a reference) */
  dispatch(key: string): (MethodRunner | undefined)[]
  /** the implementation class `cls` has for `key` */
  implOf(cls: string, key: string): MethodDef
  /** the frame of a method (or a signature): where a call stores its arguments and reads its outputs and result */
  frameOf(m: MethodDef): PouLayout
  /** a user function block's runner: its body, generated once for the definition, run on an instance's address */
  fb(name: string): { run(b: number, now: number): void }
  /** a user function's runner (typed/pou.ts TypedFn): which of its inputs take a whole array or struct (by address),
   *  the layout of its result when that is one, and where its inputs and result are */
  fn(name: string): {
    readonly aggregate: readonly boolean[]
    readonly result: TypeLayout | null
    readonly inputSlots: readonly { off: number; layout: TypeLayout }[]
    readonly resultSlot: { off: number; layout: TypeLayout }
    readonly direct: boolean
  }
  /** the region a call site of a function with a whole array or struct result copies it into (typed/calls.ts) */
  temp(call: Expr): number | undefined
}

/** The interpreter's own pieces a body needs: the store rules the walker uses, so the engines agree. */
export interface GenInternals {
  fits(t: ScalarType, exact: number, kept: number, pos: SourcePos | undefined): number
  checkRange(target: Expr, v: Value, pos: SourcePos): Value
  coercerFor(type: ScalarType, maxLen: number | undefined, pos: SourcePos | undefined): (v: Value) => Value
  placeMaxLen(target: Expr): number | undefined
}

const subscript = (i: number, lo: number, hi: number, pos: SourcePos): StFault => new StFault(FAULT.SUBSCRIPT, `array index ${i} out of bounds [${lo}..${hi}]`, pos)

/** The helpers a body imports. */
export const HELPERS: Record<string, unknown> = {
  num, bool, StFault, FAULT,
  /** a subscript outside its dimension */
  ixFault(i: number, lo: number, hi: number, pos: SourcePos): never {
    throw subscript(i, lo, hi, pos)
  },
  divI(t: ScalarType, l: number, r: number, pos: SourcePos): number {
    if (r === 0) throw new StError('division by zero', pos)
    return wrap(t, idiv(l, r))
  },
  modI(t: ScalarType, l: number, r: number, pos: SourcePos): number {
    if (r === 0) throw new StError('MOD by zero', pos)
    return wrap(t, imod(l, r))
  },
  cal(t: ScalarType, v: number, pos: SourcePos): number {
    const why = calendarRangeError(t, v)
    if (why !== null) throw new StError(why, pos)
    return v
  },
  // a store's coercion into an integer place (interpreter.ts coercerFor)
  coI(t: ScalarType, v: TagValue, _pos: SourcePos | undefined): number {
    const n = typeof v === 'number' ? v : num(v)
    return wrap(t, Number.isInteger(n) ? n : roundEven(n))
  },
  /** a REF_TO's address, faulting when it is NULL (the walker's refCell) */
  refAt(a: number, pos: SourcePos, len: number): number {
    if (a === 0) throw new StError(unboundMessage('ref'), pos, len)
    return a
  },
  /** an interface's instance, faulting when it refers to none (the walker's callMethod) */
  ifaceAt(a: number, pos: SourcePos): number {
    if (a === 0) throw new StError(unboundMessage('iface'), pos)
    return a
  },
}

/** Bodies that could not be made, with why: a host that will not run a WebAssembly module lands here, and so would an
 *  emitter bug. The program then runs on the walker, which is why the engine tests assert this stays empty. */
export const codegenFallbacks: string[] = []

/** One body, or null where it could not be built (the program is then refused, and runs on the walker). */
export function generateBody(body: Stmt[], scope: GenScope, internals: GenInternals, extra: Record<string, unknown> = {}): GenBody | null {
  try {
    return generateWasmBody(body, scope, internals, extra)
  } catch (e) {
    // a construct the emitter cannot write is the PROGRAM's refusal, not a failure to build
    if (e instanceof TypedUnsupported) throw e
    const why = e instanceof Error ? e.message : String(e)
    // said once per realm: the program still runs, ~9x slower, and nothing else would show it
    if (codegenFallbacks.length === 0) console.warn(`PLC: a program body could not be built, so the program runs on the much slower reference engine: ${why}`)
    if (codegenFallbacks.length < 16) codegenFallbacks.push(why)
    return null
  }
}

/** One expression of a typed POU as a function of its instance (`b`; `m`, a method's frame, when the value is one of
 *  its variables' starting values): what an initial value that is not a literal is evaluated by, so it follows the
 *  very operator rules the scan does (typed/pou.ts). */
export function generateValue(e: Expr, scope: GenScope, internals: GenInternals, extra: Record<string, unknown>): (b: number, m?: number) => unknown {
  return generateWasmValue(e, scope, internals, extra)
}
