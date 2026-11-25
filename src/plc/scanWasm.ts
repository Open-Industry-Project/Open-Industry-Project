// A definition's body as WebAssembly, written straight from the checked program (no JavaScript in between). It does
// what the walker does, statement for statement, over the program's arena (docs/plc-typed-storage.md, "WebAssembly
// bodies"). A statement this cannot write refuses the whole program (`no`), which then runs on the walker.
//
// Values on the WebAssembly stack: a BOOL and the integers up to 32 bits are an i32 ('b', 'i'; UDINT and DWORD the
// same bits read unsigned, 'u'), REAL, LREAL and the time types an f64 ('f'). Integer arithmetic is done in i64, where
// a sum or a product of two 32-bit numbers is exact, and held to its own width after.
// A 64-bit integer is an i64 ('l' a LINT; 'L' a ULINT or an LWORD, the same bits read unsigned), and its arithmetic
// is the i64's own, which wraps as the walker's bigints are wrapped (runtime.ts, "the 64-bit integers").

import { isStringType } from './types'
import { isBuiltinFunc } from './builtins'
import { identKey, literal64 } from './program'
import { is64, isCalendar, isInt, isReal, MAX_LOOP_ITERATIONS, wrap64 } from './runtime'
import type { GenBody, GenInternals, GenScope } from './scanCodegen'
import { HELPERS } from './scanCodegen'
import { clearRanges, type TypeLayout } from './typed/layout'
import { memoryOf } from './typed/arena'
import type { Expr, ScalarType, SourcePos, Stmt, TagValue, Value } from './types'
import { no, wasmStats, type Kind, type Held, I32, I64, F64, VOID, SIGNED_NARROW, MASK, WIDE, isWidth, isLong, RANGE, kindOf, type Link, linkOf, Bytes, type Address, type Host, textOf, type Import, type Fn, readsOnly } from './scanWasmBase'
import type { WasmBody } from './scanWasmBase'
import * as calls from './scanWasmCalls'

export class Emitter {
  /** constants the imports are handed by index: positions, type names, runners */
  readonly W: unknown[] = []
  readonly #types: string[] = []
  readonly #typeBytes: Bytes[] = []
  readonly imports = new Map<string, Import>()
  readonly fns: Fn[] = []
  #fn!: Fn
  w!: Bytes
  /** the open blocks of the function being written, outermost first: a loop's exit and continue blocks are named */
  #labels: { exit?: number; cont?: number }[] = []
  #loop = 0
  /** the function being written answers a code (a sub-function a long statement list was split into) */
  #sub = false

  constructor(
    readonly scope: GenScope,
    readonly link: Link,
  ) {}

  wk(v: unknown): number {
    this.W.push(v)
    return this.W.length - 1
  }
  type(params: number[], results: number[]): number {
    const key = `${params.join(',')}>${results.join(',')}`
    let i = this.#types.indexOf(key)
    if (i < 0) {
      i = this.#types.push(key) - 1
      const b = new Bytes().u8(0x60).uleb(params.length)
      for (const p of params) b.u8(p)
      b.uleb(results.length)
      for (const r of results) b.u8(r)
      this.#typeBytes.push(b)
    }
    return i
  }
  import(name: string, params: number[], results: number[], make: Import['make']): number {
    let im = this.imports.get(name)
    if (!im) this.imports.set(name, (im = { index: this.imports.size, type: this.type(params, results), make }))
    return im.index
  }
  /** A local for a value in the making. One a finished statement used is handed to the next: a function of a few
   *  hundred statements otherwise has thousands of locals, and V8 took 2.5 s to compile the first scan of a large
   *  program. */
  local(t: number): number {
    const free = this.#free.get(t)
    const index = free && free.length > 0 ? free.pop()! : 3 + this.#fn.locals.push(t) - 1
    this.#mine[this.#mine.length - 1]?.push(index)
    return index
  }
  /** the locals each open statement took, innermost last, and the ones given back, by type */
  #mine: number[][] = []
  #free = new Map<number, number[]>()
  #release(): void {
    for (const index of this.#mine.pop()!) {
      const t = this.#fn.locals[index - 3]!
      let free = this.#free.get(t)
      if (!free) this.#free.set(t, (free = []))
      free.push(index)
    }
  }
  begin(sub: boolean): Fn {
    this.#fn = { type: this.type([I32, F64, I32], sub ? [I32] : []), locals: [], code: new Bytes() }
    this.w = this.#fn.code
    this.#labels = []
    this.#sub = sub
    this.#mine = []
    this.#free = new Map()
    return this.#fn
  }

  // ---- values ----

  /** `k` on the stack, as an f64 */
  toF(k: Kind): void {
    // (a 64-bit integer becomes the nearest number a double holds, as Number() of the walker's bigint is)
    if (k !== 'f') this.w.u8(k === 'l' ? 0xb9 : k === 'L' ? 0xba : k === 'u' ? 0xb8 : 0xb7)
  }
  /** `k` on the stack (a whole number), as an i64 */
  toL(k: Kind): void {
    // (an f64 here is a whole number a call answered: the checker allows no real where a whole number is needed)
    if (isLong(k)) return
    if (k === 'f') this.w.op(0xfc, 0x06)
    else this.w.u8(k === 'u' ? 0xad : 0xac)
  }
  /** `k` on the stack as the 32 bits a bit operation works on: a number held as a real gives its whole part's */
  toBits(k: Kind): void {
    if (k === 'f') this.w.op(0xfc, 0x06).u8(0xa7)
    else if (isLong(k)) this.w.u8(0xa7)
  }
  /** the i64 on the stack held to `t`'s width, as an i64 */
  wrapL(t: ScalarType): void {
    const w = this.w
    if (t === 'SINT') w.u8(0xc2)
    else if (t === 'INT') w.u8(0xc3)
    else if (t === 'DINT') w.u8(0xc4)
    else if (MASK[t]) w.u8(0x42).sleb(MASK[t]!).u8(0x83)
    else if (WIDE[t]) w.u8(0x42).sleb(0xffffffff).u8(0x83)
    else no(`the width of ${t}`)
  }
  /** the i32 on the stack held to `t`'s width (runtime.ts wrap) */
  wrapI(t: ScalarType): void {
    const w = this.w
    if (SIGNED_NARROW[t]) w.u8(SIGNED_NARROW[t]!)
    else if (MASK[t]) w.u8(0x41).sleb(MASK[t]!).u8(0x71)
    else if (t !== 'DINT' && !WIDE[t]) no(`the width of ${t}`)
  }

  lit(v: unknown): Kind {
    const w = this.w
    if (typeof v === 'boolean') {
      w.u8(0x41).sleb(v ? 1 : 0)
      return 'b'
    }
    if (typeof v !== 'number') return no('a literal that is not a number')
    if (Number.isInteger(v) && !Object.is(v, -0) && v >= -2147483648 && v <= 2147483647) {
      w.u8(0x41).sleb(v)
      return 'i'
    }
    if (Number.isInteger(v) && v > 0 && v <= 4294967295) {
      w.u8(0x41).sleb(v | 0)
      return 'u'
    }
    w.u8(0x44).f64(v)
    return 'f'
  }

  /** is `e` already exactly what a store into a `t` place makes of it? */
  canonical(e: Expr, t: ScalarType): boolean {
    if (e.node === 'num') {
      const v = e.value
      if (typeof v !== 'number' || Object.is(v, -0)) return false
      if (is64(t)) {
        if (e.real || !Number.isInteger(v)) return false
        const exact = BigInt(e.big ?? v)
        return wrap64(t, exact) === exact
      }
      if (isWidth(t)) return Number.isInteger(v) && v >= RANGE[t]![0] && v <= RANGE[t]![1]
      if (t === 'REAL') return Math.fround(v) === v
      return t === 'LREAL'
    }
    if (e.node === 'bool') return t === 'BOOL' && typeof e.value === 'boolean'
    if (e.t !== t || !(t === 'BOOL' || isWidth(t) || is64(t) || t === 'REAL' || t === 'LREAL')) return false
    switch (e.node) {
      case 'var': return e.constValue === undefined
      case 'member': return true
      case 'index': return true
      case 'unary': return e.op !== 'POS'
      case 'binary': return true
      default: return false
    }
  }
  within(e: Expr, t: ScalarType): boolean {
    const range = RANGE[t]
    if (!range) return false
    if (e.node === 'num') return Number.isInteger(e.value) && e.value >= range[0] && e.value <= range[1]
    const own = e.node === 'call' ? undefined : RANGE[e.t as ScalarType]
    return own !== undefined && own[0] >= range[0] && own[1] <= range[1]
  }

  /** The value on the stack, of kind `k`, made what a store into a `t` place makes of it (coercerFor). */
  coerceStack(t: ScalarType, k: Kind, pos: SourcePos | undefined): Kind {
    const w = this.w
    if (t === 'BOOL') {
      if (isLong(k)) w.u8(0x50).u8(0x45)
      else if (k === 'f') w.u8(0x44).f64(0).u8(0x62)
      else if (k !== 'b') w.u8(0x41).sleb(0).u8(0x47)
      return 'b'
    }
    if (isWidth(t)) {
      const p = pos ? this.wk(pos) : -1
      const tk = this.wk(t)
      if (k === 'b') return kindOf(t) // 0 or 1 is in every integer's range
      if (k === 'f') {
        // a whole number goes the integer's way; anything else is coI's (the rounding, a number past 64 bits, a NaN)
        const v = this.local(F64)
        const whole = this.local(I64)
        w.u8(0x22).uleb(v).op(0xfc, 0x06).u8(0x22).uleb(whole).u8(0xb9).u8(0x20).uleb(v).u8(0x61)
        w.u8(0x04).u8(I32)
        w.u8(0x20).uleb(whole)
        this.fit(t, tk, p)
        w.u8(0x05)
        w.u8(0x41).sleb(tk).u8(0x20).uleb(v).u8(0x41).sleb(p).u8(0x10).uleb(this.import('coI', [I32, F64, I32], [F64], (h) => (ti: number, x: number, pi: number) => (h.H.coI as (t: unknown, v: number, p: unknown) => number)(h.W[ti], x, pi < 0 ? undefined : h.W[pi])))
        w.op(0xfc, WIDE[t] ? 0x03 : 0x02)
        w.u8(0x0b)
        return kindOf(t)
      }
      // (a 64-bit integer keeps its low bits)
      this.toL(k)
      this.fit(t, tk, p)
      return kindOf(t)
    }
    if (is64(t)) {
      // a narrower whole number widened (the same bits: a negative one into a ULINT is the large number it wraps to), a
      // 64-bit one as it is. Anything held as a real goes by the store's own rule, which rounds it.
      if (k === 'f') {
        w.u8(0x41).sleb(this.wk(this.x.coercerFor(t, undefined, pos)))
        w.u8(0x10).uleb(this.import('coL', [F64, I32], [I64], (h) => (x: number, ci: number) => (h.W[ci] as (v: Value) => Value)(x) as bigint))
      } else this.toL(k === 'b' ? 'u' : k)
      return kindOf(t)
    }
    this.toF(k)
    if (t === 'REAL') w.u8(0xb6).u8(0xbb)
    else if (isStringType(t)) no('a STRING store')
    // (LREAL and the time types: a number is stored as it is, runtime.ts wrap)
    return 'f'
  }
  /** the i64 on the stack as a `t`: held to its width, and reported (interpreter.ts fits) when that changed it */
  fit(t: ScalarType, tk: number, p: number): void {
    const w = this.w
    const x = this.local(I64)
    const kept = this.local(I64)
    w.u8(0x22).uleb(x)
    this.wrapL(t)
    w.u8(0x22).uleb(kept).u8(0x20).uleb(x).u8(0x52)
    w.u8(0x04).u8(VOID)
    w.u8(0x41).sleb(tk).u8(0x20).uleb(x).u8(0xb9).u8(0x20).uleb(kept).u8(0xb9).u8(0x41).sleb(p)
    w.u8(0x10).uleb(this.import('fits', [I32, F64, F64, I32], [], (h) => (ti: number, exact: number, k: number, pi: number) => void h.x.fits(h.W[ti] as ScalarType, exact, k, pi < 0 ? undefined : (h.W[pi] as SourcePos))))
    w.u8(0x0b)
    w.u8(0x20).uleb(kept).u8(0xa7)
  }

  /** `e`'s value coerced for a store into a `t` place */
  coerce(t: ScalarType, pos: SourcePos | undefined, e: Expr): Kind {
    if (this.canonical(e, t)) {
      if (e.node === 'num') return this.constOf(t, e.value, e.big)
      return this.expr(e)
    }
    if (isWidth(t) && e.node !== 'call' && isWidth(e.t) && this.canonical(e, e.t) && this.within(e, t)) {
      this.expr(e)
      return kindOf(t)
    }
    return this.coerceStack(t, this.expr(e), pos)
  }
  /** a literal that `t` holds as written, in `t`'s kind */
  constOf(t: ScalarType, v: number, exact?: string): Kind {
    const k = kindOf(t)
    if (isLong(k)) this.w.u8(0x42).slebBig(BigInt(exact ?? v))
    else if (k === 'f') this.w.u8(0x44).f64(v)
    else this.w.u8(0x41).sleb(v | 0)
    return k
  }

  /** num(e): a number (a BOOL counts 0 or 1) */
  num(e: Expr): Kind {
    const k = this.expr(e)
    return k === 'b' ? 'i' : k
  }
  /** a condition */
  cond(e: Expr): void {
    const k = this.expr(e)
    if (k === 'f') this.w.u8(0x44).f64(0).u8(0x62)
    else if (isLong(k)) this.w.u8(0x50).u8(0x45)
    else if (k !== 'b') this.w.u8(0x41).sleb(0).u8(0x47)
  }

  expr(e: Expr): Kind {
    const w = this.w
    switch (e.node) {
      case 'num':
        // a 64-bit literal: its exact value, held to its type (the walker's evalExpr)
        if (is64(e.t)) {
          w.u8(0x42).slebBig(literal64(e))
          return kindOf(e.t!)
        }
        return this.lit(e.value)
      case 'bool':
        return this.lit(e.value)
      case 'var':
        if (e.constValue !== undefined) return this.lit(e.constValue)
        return this.loadAt(this.addr(e))
      case 'member':
        return this.loadAt(this.addr(e))
      case 'bit': {
        const k = this.num(e.obj)
        if (k === 'f') return no('a bit of a real')
        if (isLong(k)) w.u8(0x42).sleb(e.bit).u8(0x88).u8(0xa7).u8(0x41).sleb(1).u8(0x71)
        else w.u8(0x41).sleb(e.bit).u8(0x76).u8(0x41).sleb(1).u8(0x71)
        return 'b'
      }
      case 'index':
        return this.loadAt(this.addr(e))
      case 'call':
        return isBuiltinFunc(e.name) ? this.builtin(e) : this.fnCall(e)
      case 'mcall':
        if (calls.answersText(this, e)) return no('a text read as a number')
        return this.methodCall(e)
      case 'isref':
        this.at(this.slot(e.obj), 0x28, 2)
        w.u8(0x41).sleb(0).u8(0x47)
        return 'b'
      case 'unary': {
        if (e.op === 'NOT' && e.t === 'BOOL') {
          this.cond(e.expr)
          w.u8(0x45)
          return 'b'
        }
        if (is64(e.t) && e.op !== 'POS') {
          // the complement, or 0 minus it: an i64's own, which wraps
          if (e.op === 'NEG') w.u8(0x42).sleb(0)
          this.toL(this.num(e.expr))
          if (e.op === 'NEG') w.u8(0x7d)
          else w.u8(0x42).sleb(-1).u8(0x85)
          return kindOf(e.t!)
        }
        if (e.op === 'NOT' && isWidth(e.t)) {
          this.toBits(this.num(e.expr))
          w.u8(0x41).sleb(-1).u8(0x73)
          this.wrapI(e.t)
          return kindOf(e.t)
        }
        if (e.op === 'NEG' && isWidth(e.t)) {
          const v = this.local(I32)
          this.toBits(this.num(e.expr))
          w.u8(0x21).uleb(v).u8(0x41).sleb(0).u8(0x20).uleb(v).u8(0x6b)
          this.wrapI(e.t)
          return kindOf(e.t)
        }
        if (e.op === 'NEG' && e.t && (isReal(e.t) || (!isInt(e.t) && e.t !== 'BOOL' && !isStringType(e.t)))) {
          this.toF(this.num(e.expr))
          w.u8(0x9a)
          if (e.t === 'REAL') w.u8(0xb6).u8(0xbb)
          return 'f'
        }
        if (e.op === 'NOT') return no('this NOT')
        return this.num(e.expr)
      }
      case 'binary':
        return this.binary(e)
      default:
        return no(`the expression '${e.node}'`)
    }
  }

  binary(e: Extract<Expr, { node: 'binary' }>): Kind {
    const w = this.w
    const op = e.op
    const t = e.t!
    if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
      const lt = e.left.t
      const rt = e.right.t
      if (lt === undefined || rt === undefined) return no('a comparison of something untyped')
      if (isStringType(lt) || isStringType(rt)) {
        if (lt !== rt) return no('a STRING compared with a number')
        const sig = this.text(e.left) + this.text(e.right)
        w.u8(0x41).sleb(['=', '<>', '<', '>', '<=', '>='].indexOf(op))
        w.u8(0x10).uleb(
          this.import(`cmpS${sig}`, [I32, I32, I32], [I32], (h) => {
            const first = sig.indexOf('T')
            return (a: number, b: number, o: number): number => {
              const l = textOf(h, sig[0]!, a)
              const r = textOf(h, sig[1]!, b)
              if (first >= 0) h.texts.length = first === 0 ? a : b
              return (o === 0 ? l === r : o === 1 ? l !== r : o === 2 ? l < r : o === 3 ? l > r : o === 4 ? l <= r : l >= r) ? 1 : 0
            }
          }),
        )
        return 'b'
      }
      // a truth beside a number compares as truths (the walker's eq): only two truths are written here
      if ((lt === 'BOOL') !== (rt === 'BOOL')) return no('a BOOL compared with a number')
      const a = this.num(e.left)
      const mark = w.len
      const b = this.num(e.right)
      if (is64(lt) || is64(rt)) return this.compareLong(op, lt, rt, a, b, mark)
      const ints = a !== 'f' && b !== 'f'
      if (ints && a === b) {
        const u = a === 'u'
        w.u8(op === '=' ? 0x46 : op === '<>' ? 0x47 : op === '<' ? (u ? 0x49 : 0x48) : op === '>' ? (u ? 0x4b : 0x4a) : op === '<=' ? (u ? 0x4d : 0x4c) : u ? 0x4f : 0x4e)
        return 'b'
      }
      // mixed: both as f64. The left operand's conversion goes in before the right operand's code.
      if (a !== 'f') this.splice(mark, a === 'u' ? 0xb8 : 0xb7)
      this.toF(b)
      w.u8(op === '=' ? 0x61 : op === '<>' ? 0x62 : op === '<' ? 0x63 : op === '>' ? 0x64 : op === '<=' ? 0x65 : 0x66)
      return 'b'
    }
    if (op === 'AND' || op === 'OR' || op === 'XOR') {
      if (t === 'BOOL') {
        this.cond(e.left)
        this.cond(e.right)
        w.u8(op === 'AND' ? 0x71 : op === 'OR' ? 0x72 : 0x73)
        return 'b'
      }
      if (is64(t)) {
        this.toL(this.num(e.left))
        this.toL(this.num(e.right))
        w.u8(op === 'AND' ? 0x83 : op === 'OR' ? 0x84 : 0x85)
        return kindOf(t)
      }
      if (!isWidth(t)) return no(`${op} of ${t}`)
      this.toBits(this.num(e.left))
      this.toBits(this.num(e.right))
      w.u8(op === 'AND' ? 0x71 : op === 'OR' ? 0x72 : 0x73)
      this.wrapI(t)
      return kindOf(t)
    }
    if (isCalendar(t)) {
      this.toFAfter(e.left)
      this.toFAfter(e.right)
      w.u8(op === '+' ? 0xa0 : 0xa1)
      const tk = this.wk(t)
      const v = this.local(F64)
      w.u8(0x21).uleb(v).u8(0x41).sleb(tk).u8(0x20).uleb(v).u8(0x41).sleb(this.wk(e.pos))
      w.u8(0x10).uleb(this.import('cal', [I32, F64, I32], [F64], (h) => (ti: number, x: number, pi: number) => (h.H.cal as (t: unknown, v: number, p: unknown) => number)(h.W[ti], x, h.W[pi])))
      return 'f'
    }
    if (isReal(t) && (op === '+' || op === '-' || op === '*' || op === '/')) {
      this.toFAfter(e.left)
      this.toFAfter(e.right)
      w.u8(op === '+' ? 0xa0 : op === '-' ? 0xa1 : op === '*' ? 0xa2 : 0xa3)
      if (t === 'REAL') w.u8(0xb6).u8(0xbb)
      return 'f'
    }
    if (is64(t)) return this.arithLong(e, t)
    if (!isWidth(t)) {
      // a duration: sums and products are a number's (interpreter.ts fits leaves anything but an integer alone)
      if (t !== 'TIME') return no(`${op} of ${t}`)
      if (op === '/' || op === 'MOD') {
        // a whole quotient or remainder, faulting by zero: the helper the walker's rule is written in
        w.u8(0x41).sleb(op === 'MOD' ? 1 : 0).u8(0x41).sleb(this.wk(t))
        this.toFAfter(e.left)
        this.toFAfter(e.right)
        w.u8(0x41).sleb(this.wk(e.pos))
        w.u8(0x10).uleb(this.import('divF', [I32, I32, F64, F64, I32], [F64], (h) => (m: number, ti: number, l: number, r: number, pi: number) => (h.H[m ? 'modI' : 'divI'] as (t: unknown, l: number, r: number, p: unknown) => number)(h.W[ti], l, r, h.W[pi])))
        return 'f'
      }
      if (op !== '+' && op !== '-' && op !== '*') return no(`${op} of ${t}`)
      this.toFAfter(e.left)
      this.toFAfter(e.right)
      w.u8(op === '+' ? 0xa0 : op === '-' ? 0xa1 : 0xa2)
      return 'f'
    }
    const tk = this.wk(t)
    const p = this.wk(e.pos)
    if (op === '+' || op === '-' || op === '*') {
      this.toL(this.num(e.left))
      this.toL(this.num(e.right))
      w.u8(op === '+' ? 0x7c : op === '-' ? 0x7d : 0x7e)
      this.fit(t, tk, p)
      return kindOf(t)
    }
    if (op !== '/' && op !== 'MOD') return no(`the operator ${op}`)
    const mod = op === 'MOD'
    const known = e.right.node === 'num' && typeof e.right.value === 'number' && Number.isInteger(e.right.value) && e.right.value !== 0
    this.toL(this.num(e.left))
    if (known) {
      w.u8(0x42).sleb((e.right as { value: number }).value).u8(mod ? 0x81 : 0x7f)
      this.wrapL(t)
      w.u8(0xa7)
      return kindOf(t)
    }
    const l = this.local(I64)
    const r = this.local(I64)
    w.u8(0x21).uleb(l)
    this.toL(this.num(e.right))
    w.u8(0x22).uleb(r).u8(0x50)
    w.u8(0x04).u8(I32)
    // by zero: divI / modI, which fault the scan
    w.u8(0x41).sleb(mod ? 1 : 0).u8(0x41).sleb(tk).u8(0x20).uleb(l).u8(0xb9).u8(0x41).sleb(p)
    w.u8(0x10).uleb(this.import('byZero', [I32, I32, F64, I32], [F64], (h) => (m: number, ti: number, x: number, pi: number) => (h.H[m ? 'modI' : 'divI'] as (t: unknown, l: number, r: number, p: unknown) => number)(h.W[ti], x, 0, h.W[pi])))
    w.op(0xfc, WIDE[t] ? 0x03 : 0x02)
    w.u8(0x05)
    w.u8(0x20).uleb(l).u8(0x20).uleb(r).u8(mod ? 0x81 : 0x7f)
    this.wrapL(t)
    w.u8(0xa7)
    w.u8(0x0b)
    return kindOf(t)
  }
  /**
   * A comparison with a 64-bit integer on a side, both operands already on the stack (`a` then `b`; the left one's
   * code ended at `mark`). Two whole numbers compare by their exact values, signed against unsigned included; beside
   * a real or a duration both compare as numbers. Decided by the operands' types, as the walker decides it
   * (interpreter.ts evalBinary).
   */
  compareLong(op: string, lt: ScalarType, rt: ScalarType, a: Kind, b: Kind, mark: number): Kind {
    const w = this.w
    if (!(isInt(lt) && isInt(rt))) {
      if (a !== 'f') this.splice(mark, a === 'l' ? 0xb9 : a === 'L' ? 0xba : a === 'u' ? 0xb8 : 0xb7)
      this.toF(b)
      w.u8(op === '=' ? 0x61 : op === '<>' ? 0x62 : op === '<' ? 0x63 : op === '>' ? 0x64 : op === '<=' ? 0x65 : 0x66)
      return 'b'
    }
    // (a whole number held as a real is one a call answered: its whole part)
    if (a === 'f') this.splice(mark, 0xfc, 0x06)
    else if (!isLong(a)) this.splice(mark, a === 'u' ? 0xad : 0xac)
    this.toL(b)
    const compare = (o: string, unsigned: boolean): number =>
      o === '=' ? 0x51 : o === '<>' ? 0x52 : o === '<' ? (unsigned ? 0x54 : 0x53) : o === '>' ? (unsigned ? 0x56 : 0x55) : o === '<=' ? (unsigned ? 0x58 : 0x57) : unsigned ? 0x5a : 0x59
    // 'u' is never negative, so widened it reads the same signed or unsigned
    if ((a === 'L') === (b === 'L') || a === 'u' || b === 'u') {
      w.u8(compare(op, a === 'L' || b === 'L'))
      return 'b'
    }
    // signed against unsigned: a negative number is below every unsigned one, and any other compares as unsigned
    const y = this.local(I64)
    const x = this.local(I64)
    w.u8(0x21).uleb(y).u8(0x21).uleb(x)
    const signed = a === 'L' ? y : x
    const other = a === 'L' ? x : y
    // the relation with the signed operand on the left
    const rel = a === 'L' ? ({ '<': '>', '>': '<', '<=': '>=', '>=': '<=' }[op] ?? op) : op
    w.u8(0x41).sleb(rel === '<' || rel === '<=' || rel === '<>' ? 1 : 0)
    w.u8(0x20).uleb(signed).u8(0x20).uleb(other).u8(compare(rel, true))
    w.u8(0x20).uleb(signed).u8(0x42).sleb(0).u8(0x53)
    w.u8(0x1b)
    return 'b'
  }
  /**
   * Arithmetic whose result is a 64-bit integer: both operands as i64 (a narrower one widened, which is the result
   * type's reading of it), then the i64's own operation, which wraps. A quotient or a remainder is signed for a LINT
   * and unsigned for a ULINT, and by zero it faults, as the walker's does.
   */
  arithLong(e: Extract<Expr, { node: 'binary' }>, t: ScalarType): Kind {
    const w = this.w
    const op = e.op
    this.toL(this.num(e.left))
    if (op === '+' || op === '-' || op === '*') {
      this.toL(this.num(e.right))
      w.u8(op === '+' ? 0x7c : op === '-' ? 0x7d : 0x7e)
      return kindOf(t)
    }
    if (op !== '/' && op !== 'MOD') return no(`the operator ${op}`)
    const mod = op === 'MOD'
    const l = this.local(I64)
    const r = this.local(I64)
    w.u8(0x21).uleb(l)
    this.toL(this.num(e.right))
    w.u8(0x22).uleb(r).u8(0x50)
    w.u8(0x04).u8(VOID)
    w.u8(0x41).sleb(mod ? 1 : 0).u8(0x41).sleb(this.wk(e.pos))
    w.u8(0x10).uleb(this.import('zeroL', [I32, I32], [], (h) => (m: number, pi: number) => void (h.H[m ? 'modI' : 'divI'] as (t: unknown, l: number, r: number, p: unknown) => number)('DINT', 0, 0, h.W[pi])))
    w.u8(0x00)
    w.u8(0x0b)
    if (t !== 'LINT') {
      w.u8(0x20).uleb(l).u8(0x20).uleb(r).u8(mod ? 0x82 : 0x80)
      return kindOf(t)
    }
    // The least LINT divided by -1 is one more than an i64 holds, and the instruction traps on it. The quotient wraps
    // to the least LINT again (0 minus it), and the remainder is 0.
    w.u8(0x20).uleb(r).u8(0x42).sleb(-1).u8(0x51)
    w.u8(0x04).u8(I64)
    if (mod) w.u8(0x42).sleb(0)
    else w.u8(0x42).sleb(0).u8(0x20).uleb(l).u8(0x7d)
    w.u8(0x05)
    w.u8(0x20).uleb(l).u8(0x20).uleb(r).u8(mod ? 0x81 : 0x7f)
    w.u8(0x0b)
    return kindOf(t)
  }
  /** num(e) as an f64 */
  toFAfter(e: Expr): void {
    this.toF(this.num(e))
  }
  /** bytes put in at `at` (a conversion of a value whose code ended there) */
  splice(at: number, ...bytes: number[]): void {
    const w = this.w
    for (let i = 0; i < bytes.length; i++) w.u8(0)
    w.buf.copyWithin(at + bytes.length, at, w.len - bytes.length)
    for (let i = 0; i < bytes.length; i++) w.buf[at + i] = bytes[i]!
  }
  /**
   * The subscript in the i64 local `v` checked against its dimension, faulting outside it. `k` is the kind it came
   * from: a ULINT's bits are compared unsigned, so one past 2^63 is not read as a negative index inside the bounds.
   */
  bounds(v: number, k: Kind, d: { lo: number; hi: number }, pos: SourcePos): void {
    const w = this.w
    if (k !== 'L') w.u8(0x20).uleb(v).u8(0x42).sleb(d.lo).u8(0x53).u8(0x20).uleb(v).u8(0x42).sleb(d.hi).u8(0x55).u8(0x72)
    else if (d.hi < 0) w.u8(0x41).sleb(1)
    else w.u8(0x20).uleb(v).u8(0x42).sleb(Math.max(d.lo, 0)).u8(0x54).u8(0x20).uleb(v).u8(0x42).sleb(d.hi).u8(0x56).u8(0x72)
    w.u8(0x04).u8(VOID)
    w.u8(0x20).uleb(v).u8(k === 'L' ? 0xba : 0xb9).u8(0x44).f64(d.lo).u8(0x44).f64(d.hi).u8(0x41).sleb(this.wk(pos))
    w.u8(0x10).uleb(this.import('ixFault', [F64, F64, F64, I32], [], (h) => (i: number, lo: number, hi: number, pi: number) => void (h.H.ixFault as (i: number, lo: number, hi: number, p: unknown) => never)(i, lo, hi, h.W[pi])))
    w.u8(0x00)
    w.u8(0x0b)
  }

  // ---- places ----

  addr(e: Expr): Address {
    switch (e.node) {
      case 'var': {
        const r = this.scope.typed.resolve(e.name)
        if (!r) return no(`the name '${e.name}' here`)
        if (r.iface !== undefined) return no('an interface as a place')
        const at: Address = r.global ? { dyn: null, off: r.off, layout: r.layout } : { dyn: () => void this.w.u8(0x20).uleb(r.frame ? 2 : 0), off: r.off, layout: r.layout }
        return r.ref ? this.deref(at, r.ref, r.nullable ? e : undefined) : at
      }
      case 'this': {
        const cls = this.scope.typed.cls
        if (!cls) return no('THIS outside a class')
        return { dyn: () => void this.w.u8(0x20).uleb(0), off: 0, layout: cls.layout }
      }
      case 'member': {
        const p = this.addr(e.obj)
        if (p.layout.kind !== 'struct') return no('this member')
        const f = p.layout.byKey.get(identKey(e.field))
        if (!f || f.hidden) return no(`the member '${e.field}'`)
        const at: Address = { dyn: p.dyn, off: p.off + f.off, layout: f.layout }
        return f.ref ? this.deref(at, f.ref) : at
      }
      case 'index':
        return this.element(e)
      default:
        return no('this place')
    }
  }
  element(e: Extract<Expr, { node: 'index' }>): Address {
    const p = this.addr(e.obj)
    const arr = p.layout
    if (arr.kind !== 'array') return no('this subscript')
    let off = p.off
    const terms: (() => void)[] = []
    e.indices.forEach((ix, n) => {
      const d = arr.dims[n]!
      const stride = arr.strides[n]!
      if (ix.node === 'num' && Number.isInteger(ix.value) && ix.value >= d.lo && ix.value <= d.hi) {
        off += (ix.value - d.lo) * stride
        return
      }
      terms.push(() => {
        const w = this.w
        const k = this.num(ix)
        const v = this.local(I64)
        if (k === 'f') {
          // held as a real (a TIME): checked as the number it is, so one that is no number at all faults too, and
          // then its whole part
          const fv = this.local(F64)
          w.u8(0x22).uleb(fv).u8(0x44).f64(d.lo).u8(0x66).u8(0x20).uleb(fv).u8(0x44).f64(d.hi).u8(0x65).u8(0x71).u8(0x45)
          w.u8(0x04).u8(VOID)
          w.u8(0x20).uleb(fv).u8(0x44).f64(d.lo).u8(0x44).f64(d.hi).u8(0x41).sleb(this.wk(e.pos))
          w.u8(0x10).uleb(this.import('ixFault', [F64, F64, F64, I32], [], (h) => (i: number, lo: number, hi: number, pi: number) => void (h.H.ixFault as (i: number, lo: number, hi: number, p: unknown) => never)(i, lo, hi, h.W[pi])))
          w.u8(0x00)
          w.u8(0x0b)
          w.u8(0x20).uleb(fv).op(0xfc, 0x06).u8(0x21).uleb(v)
        } else {
          this.toL(k)
          w.u8(0x21).uleb(v)
        }
        this.bounds(v, k, d, e.pos)
        w.u8(0x20).uleb(v).u8(0x42).sleb(d.lo).u8(0x7d).u8(0xa7)
        if (stride !== 1) w.u8(0x41).sleb(stride).u8(0x6c)
      })
    })
    if (terms.length === 0) return { dyn: p.dyn, off, layout: arr.elem }
    const base = p.dyn
    return {
      dyn: () => {
        if (base) base()
        terms.forEach((term, i) => {
          term()
          if (base || i > 0) this.w.u8(0x6a)
        })
      },
      off,
      layout: arr.elem,
    }
  }
  deref(slot: Address, layout: TypeLayout, checked?: Extract<Expr, { node: 'var' }>): Address {
    return {
      dyn: () => {
        this.at(slot, 0x28, 2)
        if (checked) {
          const w = this.w
          w.u8(0x41).sleb(this.wk(checked.pos)).u8(0x41).sleb(checked.name.length)
          w.u8(0x10).uleb(this.import('refAt', [I32, I32, I32], [I32], (h) => (a: number, pi: number, len: number) => (h.H.refAt as (a: number, p: unknown, len: number) => number)(a, h.W[pi], len)))
        }
      },
      off: 0,
      layout,
    }
  }
  /** a subscript's offset into its dimension, left on the stack as an i32: checked, faulting outside it */
  subscript(ix: Expr, d: { lo: number; hi: number }, pos: SourcePos): void {
    const w = this.w
    const k = this.num(ix)
    const v = this.local(I64)
    this.toL(k)
    w.u8(0x21).uleb(v)
    this.bounds(v, k, d, pos)
    w.u8(0x20).uleb(v).u8(0x42).sleb(d.lo).u8(0x7d).u8(0xa7)
  }

  /** A text for a helper to read: a literal by its place in the constants ('S'), a STRING place by its address ('s').
   *  Leaves an i32 and answers which. */
  text(e: Expr): 'S' | 's' | 'T' {
    if (e.node === 'str' || (e.node === 'var' && typeof e.constValue === 'string')) {
      this.w.u8(0x41).sleb(this.wk(e.node === 'str' ? e.value : e.constValue))
      return 'S'
    }
    if (e.node === 'mcall') {
      if (!calls.answersText(this, e)) return no('a method that answers no text, read as one')
      this.methodCall(e)
      return 'T'
    }
    if (e.node === 'call') {
      // what a call answers: kept by the host, its place there left for the reader
      if (isBuiltinFunc(e.name)) this.builtin(e, 'T')
      else {
        const fn = this.scope.typed.fn(e.name)
        if (fn.result) return no('a whole value from a call used as a text')
        this.fnGiven(e, fn)
        this.w.u8(0x41).sleb(this.wk(fn)).u8(0x41).sleb(e.slots ? this.wk(e.slots) : -1)
        this.w.u8(0x10).uleb(
          this.import('fnCall_T', [I32, I32], [I32], (h) => (k: number, si: number): number => {
            const r = (h.W[k] as { call(given: unknown[], slots: readonly number[] | undefined): TagValue }).call(h.args.pop()!, si < 0 ? undefined : (h.W[si] as readonly number[]))
            return h.texts.push(r) - 1
          }),
        )
      }
      return 'T'
    }
    const at = this.strSource(e)
    if (!at) return no(`a text from '${e.node}'`)
    this.address(at)
    return 's'
  }

  /** the address, then a load or store instruction with the constant part as its offset */
  at(a: Address, op: number, align: number): void {
    const w = this.w
    if (a.dyn) {
      a.dyn()
      w.u8(op).uleb(align).uleb(a.off)
    } else w.u8(0x41).sleb(a.off | 0).u8(op).uleb(align).uleb(0)
  }
  /** the address itself, as an i32 */
  address(a: Address): void {
    const w = this.w
    if (a.dyn) {
      a.dyn()
      if (a.off !== 0) w.u8(0x41).sleb(a.off).u8(0x6a)
    } else w.u8(0x41).sleb(a.off | 0)
  }
  loadAt(a: Address): Kind {
    if (a.layout.kind !== 'scalar') return no('a whole array or struct here')
    const t = a.layout.scalar
    switch (t) {
      case 'BOOL': this.at(a, 0x2d, 0); return 'b'
      case 'SINT': this.at(a, 0x2c, 0); return 'i'
      case 'USINT': case 'BYTE': this.at(a, 0x2d, 0); return 'i'
      case 'INT': this.at(a, 0x2e, 1); return 'i'
      case 'UINT': case 'WORD': this.at(a, 0x2f, 1); return 'i'
      case 'DINT': this.at(a, 0x28, 2); return 'i'
      case 'UDINT': case 'DWORD': this.at(a, 0x28, 2); return 'u'
      case 'REAL': this.at(a, 0x2a, 2); this.w.u8(0xbb); return 'f'
      case 'LINT': this.at(a, 0x29, 3); return 'l'
      case 'ULINT': case 'LWORD': this.at(a, 0x29, 3); return 'L'
      case 'STRING': case 'WSTRING': return no('a STRING read')
      default: this.at(a, 0x2b, 3); return 'f'
    }
  }
  /** the local `v` (already in the slot's form) stored into the scalar at `a` */
  storeAt(a: Address, v: number): void {
    if (a.layout.kind !== 'scalar') return no('a whole array or struct here')
    const w = this.w
    const t = a.layout.scalar
    const [op, align, demote] = ((): [number, number, boolean] => {
      switch (t) {
        case 'BOOL': case 'SINT': case 'USINT': case 'BYTE': return [0x3a, 0, false]
        case 'INT': case 'UINT': case 'WORD': return [0x3b, 1, false]
        case 'DINT': case 'UDINT': case 'DWORD': return [0x36, 2, false]
        case 'REAL': return [0x38, 2, true]
        case 'LINT': case 'ULINT': case 'LWORD': return [0x37, 3, false]
        case 'STRING': case 'WSTRING': return no('a STRING store')
        default: return [0x39, 3, false]
      }
    })()
    if (a.dyn) a.dyn()
    else w.u8(0x41).sleb(a.off | 0)
    w.u8(0x20).uleb(v)
    if (demote) w.u8(0xb6)
    w.u8(op).uleb(align).uleb(a.dyn ? a.off : 0)
  }
  /** the local `v`, of kind `k` and already coerced, stored into `target` */
  place(target: Expr, v: number, k: Kind): void {
    const w = this.w
    if (target.node === 'var' || target.node === 'index' || target.node === 'member') return this.storeAt(this.addr(target), v)
    if (target.node === 'bit') {
      const t = target.obj.t
      if (is64(t)) {
        // one bit of a 64-bit word: the word with the bit set, or cleared, by the truth of the value
        const word = this.local(I64)
        const out = this.local(I64)
        this.toL(this.num(target.obj))
        w.u8(0x21).uleb(word)
        if (k === 'f' || isLong(k)) return no('a number as a bit')
        const bit = 1n << BigInt(target.bit)
        w.u8(0x20).uleb(word).u8(0x42).slebBig(bit).u8(0x84)
        w.u8(0x20).uleb(word).u8(0x42).slebBig(~bit).u8(0x83)
        w.u8(0x20).uleb(v)
        if (k !== 'b') w.u8(0x41).sleb(0).u8(0x47)
        w.u8(0x1b)
        w.u8(0x21).uleb(out)
        return this.place(target.obj, out, kindOf(t!))
      }
      if (!isWidth(t)) return no('a bit of this')
      const word = this.local(I32)
      const out = this.local(I32)
      if (this.num(target.obj) === 'f') return no('a bit of a real')
      w.u8(0x21).uleb(word)
      const mask = 2 ** target.bit
      if (k === 'f') return no('a real as a bit')
      // set: word | mask, clear: word & ~mask
      w.u8(0x20).uleb(word).u8(0x41).sleb(mask | 0).u8(0x72)
      w.u8(0x20).uleb(word).u8(0x41).sleb(~mask | 0).u8(0x71)
      w.u8(0x20).uleb(v)
      if (k !== 'b') w.u8(0x41).sleb(0).u8(0x47)
      w.u8(0x1b)
      this.wrapI(t)
      w.u8(0x21).uleb(out)
      return this.place(target.obj, out, kindOf(t))
    }
    return no('this place')
  }
  typeOfKind(k: Kind): number {
    return k === 'f' ? F64 : isLong(k) ? I64 : I32
  }

  // ---- statements ----

  /** how far out the block is that a jump of this kind lands after (null: no loop is open in this function) */
  depth(kind: 'exit' | 'cont'): number | null {
    for (let i = this.#labels.length - 1; i >= 0; i--) if (this.#labels[i]![kind] !== undefined) return this.#labels.length - 1 - i
    return null
  }
  open(label: { exit?: number; cont?: number } = {}): void {
    this.#labels.push(label)
  }
  close(): void {
    this.#labels.pop()
    this.w.u8(0x0b)
  }
  ret(): void {
    if (this.#sub) this.w.u8(0x41).sleb(1)
    this.w.u8(0x0f)
  }
  fault(kind: number, pos: SourcePos): void {
    const w = this.w
    w.u8(0x41).sleb(kind).u8(0x41).sleb(this.wk(pos))
    w.u8(0x10).uleb(
      this.import('loopFault', [I32, I32], [], (h) => (k: number, pi: number) => {
        const { StFault, FAULT } = h.H as { StFault: new (f: unknown, m: string, p: unknown) => Error; FAULT: { WATCHDOG: unknown } }
        throw new StFault(FAULT.WATCHDOG, ['FOR loop step is zero: it would never end', 'FOR loop exceeded its iteration limit', 'WHILE loop exceeded its iteration limit', 'REPEAT loop exceeded its iteration limit'][k]!, h.W[pi])
      }),
    )
    w.u8(0x00)
  }
  /** count the pass, and fault past the limit */
  limit(count: number, kind: number, pos: SourcePos): void {
    const w = this.w
    w.u8(0x20).uleb(count).u8(0x41).sleb(1).u8(0x6a).u8(0x22).uleb(count).u8(0x41).sleb(MAX_LOOP_ITERATIONS).u8(0x4a)
    w.u8(0x04).u8(VOID)
    this.open()
    this.fault(kind, pos)
    this.close()
  }

  list(body: Stmt[]): void {
    for (const s of body) this.stmt(s)
  }

  /** one statement, as WebAssembly */
  stmt(s: Stmt): void {
    wasmStats.statements++
    this.#mine.push([])
    this.native(s)
    this.#release()
  }

  native(s: Stmt): void {
    const w = this.w
    switch (s.node) {
      case 'assign': {
        if (s.copy) {
          if (s.value.node === 'num' && s.value.value === 0) {
            const dst = this.addr(s.target)
            const at = this.local(I32)
            this.address(dst)
            w.u8(0x21).uleb(at)
            const ranges = clearRanges(dst.layout)
            for (let i = 0; i < ranges.length; i += 2) {
              w.u8(0x20).uleb(at)
              if (ranges[i] !== 0) w.u8(0x41).sleb(ranges[i]!).u8(0x6a)
              w.u8(0x41).sleb(0).u8(0x41).sleb(ranges[i + 1]!).op(0xfc, 0x0b, 0x00)
            }
            return
          }
          // the value (a place, or a call's result), then the target (the walker's order), then the bytes
          const src = this.local(I32)
          this.aggregate(s.value)
          w.u8(0x21).uleb(src)
          const dst = this.addr(s.target)
          this.address(dst)
          w.u8(0x20).uleb(src).u8(0x41).sleb(dst.layout.size).op(0xfc, 0x0a, 0x00, 0x00)
          return
        }
        const ranged = (s.target.node === 'var' || s.target.node === 'member' || s.target.node === 'index') && s.target.range !== undefined
        const t = s.target.t as ScalarType
        if (isStringType(t)) return ranged ? no('a STRING subrange') : this.stringAssign(s)
        const k = this.coerce(t, s.pos, s.value)
        const v = this.local(this.typeOfKind(k))
        w.u8(0x22).uleb(v)
        if (ranged && isLong(k)) {
          // (a 64-bit integer goes to the check as it is, so the bounds meet its exact value)
          w.u8(0x41).sleb(k === 'L' ? 1 : 0).u8(0x41).sleb(this.wk(s.target)).u8(0x41).sleb(this.wk(s.pos))
          w.u8(0x10).uleb(this.import('rangeL', [I64, I32, I32, I32], [], (h) => (x: bigint, u: number, ti: number, pi: number) => void h.x.checkRange(h.W[ti] as Expr, u ? BigInt.asUintN(64, x) : x, h.W[pi] as SourcePos)))
        } else if (ranged) {
          // the store's own check, after the coercion (interpreter.ts checkRange): it answers the value or faults
          this.toF(k)
          w.u8(0x41).sleb(this.wk(s.target)).u8(0x41).sleb(this.wk(s.pos))
          w.u8(0x10).uleb(this.import('range', [F64, I32, I32], [], (h) => (x: number, ti: number, pi: number) => void h.x.checkRange(h.W[ti] as Expr, x, h.W[pi] as SourcePos)))
        } else w.u8(0x1a)
        return this.place(s.target, v, k)
      }
      case 'if': {
        let opened = 0
        for (const b of s.branches) {
          this.cond(b.cond)
          w.u8(0x04).u8(VOID)
          this.open()
          opened++
          this.list(b.body)
          w.u8(0x05)
        }
        if (s.elseBody) this.list(s.elseBody)
        for (let i = 0; i < opened; i++) this.close()
        return
      }
      case 'case': {
        const k = this.num(s.selector)
        const sel = this.local(this.typeOfKind(k))
        w.u8(0x21).uleb(sel)
        const same = (v: number): void => {
          w.u8(0x20).uleb(sel)
          if (k === 'f') w.u8(0x44).f64(v)
          else if (isLong(k)) w.u8(0x42).sleb(v)
          else if (Number.isInteger(v) && v >= -2147483648 && v <= 4294967295) w.u8(0x41).sleb(v | 0)
          else no('a CASE label past 32 bits')
        }
        let opened = 0
        for (const cl of s.cases) {
          if (cl.labels.length === 0) w.u8(0x41).sleb(0)
          cl.labels.forEach((l, i) => {
            if (isLong(k)) {
              // a 64-bit selector meets its labels exactly. An unsigned one is never a negative label, and is
              // compared unsigned, so one past 2^63 is not read as a negative number inside a range.
              const lo = l.kind === 'range' ? l.lo : (l.value as number)
              const hi = l.kind === 'range' ? l.hi : (l.value as number)
              if (k === 'L' && hi < 0) w.u8(0x41).sleb(0)
              else if (l.kind !== 'range') {
                same(lo)
                w.u8(0x51)
              } else {
                same(k === 'L' ? Math.max(lo, 0) : lo)
                w.u8(k === 'L' ? 0x5a : 0x59)
                same(hi)
                w.u8(k === 'L' ? 0x58 : 0x57).u8(0x71)
              }
            } else if (l.kind === 'range') {
              same(l.lo)
              w.u8(k === 'f' ? 0x66 : k === 'u' ? 0x4f : 0x4e)
              same(l.hi)
              w.u8(k === 'f' ? 0x65 : k === 'u' ? 0x4d : 0x4c).u8(0x71)
            } else {
              same(l.value as number)
              w.u8(k === 'f' ? 0x61 : 0x46)
            }
            if (i > 0) w.u8(0x72)
          })
          w.u8(0x04).u8(VOID)
          this.open()
          opened++
          this.list(cl.body)
          w.u8(0x05)
        }
        if (s.elseBody) this.list(s.elseBody)
        for (let i = 0; i < opened; i++) this.close()
        return
      }
      case 'while':
      case 'repeat': {
        const n = this.#loop++
        const count = this.local(I32)
        w.u8(0x41).sleb(0).u8(0x21).uleb(count)
        w.u8(0x02).u8(VOID)
        this.open({ exit: n })
        w.u8(0x03).u8(VOID)
        this.open()
        if (s.node === 'while') {
          this.cond(s.cond)
          w.u8(0x45).u8(0x0d).uleb(1)
        }
        w.u8(0x02).u8(VOID)
        this.open({ cont: n })
        this.list(s.body)
        this.close()
        if (s.node === 'repeat') {
          this.cond(s.cond)
          w.u8(0x0d).uleb(1)
        }
        this.limit(count, s.node === 'while' ? 2 : 3, s.pos)
        w.u8(0x0c).uleb(0)
        this.close()
        this.close()
        return
      }
      case 'for':
        return this.forLoop(s)
      case 'exit':
      case 'continue': {
        const d = this.depth(s.node === 'exit' ? 'exit' : 'cont')
        if (d === null) return no('a jump with no loop open here')
        w.u8(0x0c).uleb(d)
        return
      }
      case 'return':
        return this.ret()
      case 'fbcall':
        return this.blockCall(s)
      case 'invoke':
        this.methodCall(s.call)
        // (a text it answered is with the host: given back, since nothing reads it)
        if (calls.answersText(this, s.call)) w.u8(0x10).uleb(this.import('textsDrop', [I32], [], (h) => (at: number) => void (h.texts.length = at)))
        else w.u8(0x1a)
        return
      case 'bind': {
        // the address a REF_TO or an interface is given, then its slot
        const v = this.local(I32)
        if (s.source === null) w.u8(0x41).sleb(0)
        else if (s.kind === 'iface') this.instanceOf(s.source)
        else this.refGiven(s.source, s.alias)
        w.u8(0x21).uleb(v)
        const slot = this.slot(s.target)
        if (slot.dyn) slot.dyn()
        else w.u8(0x41).sleb(slot.off | 0)
        w.u8(0x20).uleb(v).u8(0x36).uleb(2).uleb(slot.dyn ? slot.off : 0)
        return
      }
      default:
        return no(`the statement '${(s as Stmt).node}'`)
    }
  }

  /** a STRING copied place to place: the length alone when the text is empty */
  stringAssign(s: Extract<Stmt, { node: 'assign' }>): void {
    const v = s.value
    const target = s.target
    const plain = (e: Expr): boolean => (e.node === 'var' ? e.constValue === undefined : e.node === 'member' || e.node === 'index')
    if (!isStringType(v.t) || !plain(v) || !plain(target) || !readsOnly(target)) return this.textStore(s)
    const src = this.addr(v)
    const dst = this.addr(target)
    if (src.layout.kind !== 'scalar' || !isStringType(src.layout.scalar) || dst.layout.kind !== 'scalar' || !isStringType(dst.layout.scalar)) return no('a STRING store')
    const maxLen = this.x.placeMaxLen(target)
    const cap = maxLen === undefined ? dst.layout.cap! : Math.min(dst.layout.cap!, maxLen)
    this.strCopy(dst, src, cap)
  }
  /** A text stored that is not a copy of a place: the value first (a literal, a place read as text, or what a builtin
   *  answered, kept by the host), then the place, then the text cut as the store cuts it and written. */
  textStore(s: Extract<Stmt, { node: 'assign' }>): void {
    const w = this.w
    const target = s.target
    if (target.node !== 'var' && target.node !== 'index' && target.node !== 'member') return no('a text stored into this')
    const v = s.value
    let lit = -1
    if (v.node === 'str' || (v.node === 'var' && typeof v.constValue === 'string')) lit = this.wk(v.node === 'str' ? v.value : v.constValue)
    else if (v.node === 'call' && isBuiltinFunc(v.name) && (isStringType(v.t) || v.t === undefined)) this.builtin(v, true)
    else {
      const kind = this.text(v)
      w.u8(0x10).uleb(
        this.import(`textAt${kind}`, [I32], [], (h) => (a: number) => {
          h.text = textOf(h, kind, a)
          if (kind === 'T') h.texts.length = a
        }),
      )
    }
    this.textPutTo(target, this.x.placeMaxLen(target), s.pos, lit)
  }
  /** the STRING at `at` read as a text the host keeps for the store that follows */
  textFrom(at: Address): void {
    this.address(at)
    this.w.u8(0x10).uleb(this.import('textAts', [I32], [], (h) => (a: number) => void (h.text = textOf(h, 's', a))))
  }
  /** The text the host keeps (or the literal at `lit` in the constants) stored into the STRING place `target`: the
   *  place found now, the text cut to `maxLen` and the place's capacity. */
  textPutTo(target: Expr, maxLen: number | undefined, pos: SourcePos | undefined, lit = -1): void {
    const w = this.w
    if (target.node !== 'var' && target.node !== 'index' && target.node !== 'member') return no('a text stored into this')
    const dst = this.addr(target)
    if (dst.layout.kind !== 'scalar' || !isStringType(dst.layout.scalar)) return no('a text stored into something else')
    const co = this.wk(this.x.coercerFor('STRING', maxLen, pos))
    this.address(dst)
    w.u8(0x41).sleb(dst.layout.cap!).u8(0x41).sleb(co).u8(0x41).sleb(lit)
    w.u8(0x10).uleb(
      this.import('textPut', [I32, I32, I32, I32], [], (h) => (a: number, cap: number, ci: number, li: number) => {
        const strPut = h.H.strPut as (a: number, cap: number, s: string) => void
        strPut(a, cap, (h.W[ci] as (v: Value) => Value)(li < 0 ? h.text : (h.W[li] as string)) as string)
      }),
    )
  }
  /** the STRING at `src` copied into the one at `dst`, cut to `cap` characters: the source's address first */
  strCopy(dst: Address, src: Address, cap: number): void {
    const w = this.w
    const z = this.local(I32)
    const y = this.local(I32)
    const n = this.local(I32)
    this.address(src)
    w.u8(0x21).uleb(z)
    this.address(dst)
    w.u8(0x21).uleb(y)
    // n = min(the source's length, the capacity); the length word, then that many code units
    w.u8(0x20).uleb(z).u8(0x2f).uleb(1).uleb(0).u8(0x22).uleb(n).u8(0x41).sleb(cap).u8(0x20).uleb(n).u8(0x41).sleb(cap).u8(0x49).u8(0x1b).u8(0x21).uleb(n)
    w.u8(0x20).uleb(y).u8(0x20).uleb(n).u8(0x3b).uleb(1).uleb(0)
    w.u8(0x20).uleb(n).u8(0x04).u8(VOID)
    this.open()
    w.u8(0x20).uleb(y).u8(0x41).sleb(2).u8(0x6a).u8(0x20).uleb(z).u8(0x41).sleb(2).u8(0x6a).u8(0x20).uleb(n).u8(0x41).sleb(1).u8(0x74).op(0xfc, 0x0a, 0x00, 0x00)
    this.close()
  }

  forLoop(s: Extract<Stmt, { node: 'for' }>): void {
    const w = this.w
    const vt = (this.scope.env.get(identKey(s.varName)) ?? this.scope.genv!.get(identKey(s.varName)))!.type as ScalarType
    if (is64(vt)) return this.forLong(s, vt)
    if (!isWidth(vt)) return no('a FOR counter that is not a whole number')
    const n = this.#loop++
    const end = this.local(I64)
    const step = this.local(I64)
    const i = this.local(I64)
    const count = this.local(I32)
    // `to`, then `by`, then `from`: the order the walker evaluates them in
    this.toL(this.num(s.to))
    w.u8(0x21).uleb(end)
    if (s.by) this.toL(this.num(s.by))
    else w.u8(0x42).sleb(1)
    w.u8(0x22).uleb(step).u8(0x50).u8(0x04).u8(VOID)
    this.open()
    this.fault(0, s.pos)
    this.close()
    w.u8(0x41).sleb(0).u8(0x21).uleb(count)
    this.toL(this.num(s.from))
    w.u8(0x21).uleb(i)
    const whole = (e: Expr | null | undefined): boolean => e == null || (e.node === 'num' ? Number.isInteger(e.value) : e.node !== 'call' && isWidth(e.t))
    const bounded = whole(s.by) && this.within(s.from, vt) && this.within(s.to, vt)
    const counter = { node: 'var', name: s.varName, pos: s.pos } as Expr
    w.u8(0x02).u8(VOID)
    this.open({ exit: n })
    w.u8(0x03).u8(VOID)
    this.open()
    // step > 0 ? i <= end : i >= end
    w.u8(0x20).uleb(i).u8(0x20).uleb(end).u8(0x57).u8(0x20).uleb(i).u8(0x20).uleb(end).u8(0x59).u8(0x20).uleb(step).u8(0x42).sleb(0).u8(0x55).u8(0x1b)
    w.u8(0x45).u8(0x0d).uleb(1)
    const held = this.local(I32)
    w.u8(0x20).uleb(i)
    if (bounded) w.u8(0xa7)
    else this.fit(vt, this.wk(vt), -1)
    w.u8(0x21).uleb(held)
    this.place(counter, held, kindOf(vt))
    w.u8(0x02).u8(VOID)
    this.open({ cont: n })
    this.list(s.body)
    this.close()
    this.limit(count, 1, s.pos)
    w.u8(0x20).uleb(i).u8(0x20).uleb(step).u8(0x7c).u8(0x21).uleb(i)
    w.u8(0x0c).uleb(0)
    this.close()
    this.close()
  }

  /**
   * A FOR over a 64-bit counter (interpreter.ts forWide): it counts in the counter's own type, the bounds read as
   * that type and the step as a LINT, and it ends, too, where the next value would leave the type's range.
   */
  forLong(s: Extract<Stmt, { node: 'for' }>, vt: ScalarType): void {
    const w = this.w
    const unsigned = vt !== 'LINT'
    const n = this.#loop++
    const end = this.local(I64)
    const step = this.local(I64)
    const i = this.local(I64)
    const next = this.local(I64)
    const count = this.local(I32)
    // `to`, then `by`, then `from`: the order the walker evaluates them in
    this.toL(this.num(s.to))
    w.u8(0x21).uleb(end)
    if (s.by) this.toL(this.num(s.by))
    else w.u8(0x42).sleb(1)
    w.u8(0x22).uleb(step).u8(0x50).u8(0x04).u8(VOID)
    this.open()
    this.fault(0, s.pos)
    this.close()
    w.u8(0x41).sleb(0).u8(0x21).uleb(count)
    this.toL(this.num(s.from))
    w.u8(0x21).uleb(i)
    const counter = { node: 'var', name: s.varName, pos: s.pos } as Expr
    w.u8(0x02).u8(VOID)
    this.open({ exit: n })
    w.u8(0x03).u8(VOID)
    this.open()
    // step > 0 ? i <= end : i >= end, in the counter's own order
    w.u8(0x20).uleb(i).u8(0x20).uleb(end).u8(unsigned ? 0x58 : 0x57).u8(0x20).uleb(i).u8(0x20).uleb(end).u8(unsigned ? 0x5a : 0x59).u8(0x20).uleb(step).u8(0x42).sleb(0).u8(0x55).u8(0x1b)
    w.u8(0x45).u8(0x0d).uleb(1)
    this.place(counter, i, kindOf(vt))
    w.u8(0x02).u8(VOID)
    this.open({ cont: n })
    this.list(s.body)
    this.close()
    this.limit(count, 1, s.pos)
    w.u8(0x20).uleb(i).u8(0x20).uleb(step).u8(0x7c).u8(0x21).uleb(next)
    // out of the loop where the sum left the type's range: for a LINT, both operands differ in sign from the sum;
    // for a ULINT, the sum went down on a step up, or up on a step down
    if (unsigned) w.u8(0x20).uleb(next).u8(0x20).uleb(i).u8(0x54).u8(0x20).uleb(next).u8(0x20).uleb(i).u8(0x56).u8(0x20).uleb(step).u8(0x42).sleb(0).u8(0x55).u8(0x1b)
    else w.u8(0x20).uleb(i).u8(0x20).uleb(next).u8(0x85).u8(0x20).uleb(step).u8(0x20).uleb(next).u8(0x85).u8(0x83).u8(0x42).sleb(0).u8(0x53)
    w.u8(0x0d).uleb(1)
    w.u8(0x20).uleb(next).u8(0x21).uleb(i)
    w.u8(0x0c).uleb(0)
    this.close()
    this.close()
  }

  /** where the text `e` reads is, when `e` is a whole STRING place */
  strSource(e: Expr): Address | null {
    if (!isStringType(e.t)) return null
    if (e.node === 'var' ? e.constValue !== undefined : e.node !== 'member' && e.node !== 'index') return null
    const a = this.addr(e)
    return a.layout.kind === 'scalar' && isStringType(a.layout.scalar) ? a : null
  }
  /** the slot of a REF_TO or an interface variable: the address it holds, not what it designates */
  slot(e: Expr): Address {
    if (e.node === 'index') return this.element(e)
    if (e.node !== 'var') return no('this reference')
    const r = this.scope.typed.resolve(e.name)
    if (!r) return no(`the name '${e.name}' here`)
    return r.global ? { dyn: null, off: r.off, layout: r.layout } : { dyn: () => void this.w.u8(0x20).uleb(r.frame ? 2 : 0), off: r.off, layout: r.layout }
  }
  isIface(e: Expr): boolean {
    if (e.node === 'var') return this.scope.typed.resolve(e.name)?.iface !== undefined
    if (e.node !== 'index') return false
    const l = this.element(e).layout // (asked, not written: the subscripts' code runs only when the address is used)
    return l.kind === 'scalar' && l.pointer === 'iface'
  }
  /** what a REF_TO is given, as an address left on the stack */
  refGiven(e: Expr, alias: boolean | undefined): void {
    if (alias) return this.at(this.slot(e), 0x28, 2)
    if (e.node === 'num') return void this.w.u8(0x41).sleb(0)
    if (e.node === 'this') return void this.w.u8(0x20).uleb(0)
    this.address(this.addr(e))
  }
  /** what an interface is given: an instance's address, or 0 */
  instanceOf(e: Expr): void {
    if (e.node === 'this') return void this.w.u8(0x20).uleb(0)
    if (e.node === 'num') return void this.w.u8(0x41).sleb(0)
    if (this.isIface(e)) return this.at(this.slot(e), 0x28, 2)
    this.address(this.addr(e))
  }

  builtin(e: Extract<Expr, { node: 'call' }>, textOut: boolean | 'T' = false): Kind {
    return calls.builtin(this, e, textOut)
  }
  fnCall(e: Extract<Expr, { node: 'call' }>): Kind {
    return calls.fnCall(this, e)
  }
  fnGiven(e: Extract<Expr, { node: 'call' }>, fn: { readonly aggregate: readonly boolean[] }): void {
    calls.fnGiven(this, e, fn)
  }
  aggregate(e: Expr): void {
    calls.aggregate(this, e)
  }
  methodCall(e: Extract<Expr, { node: 'mcall' }>): Kind {
    return calls.methodCall(this, e)
  }
  ifaceAt(): number {
    return calls.ifaceAt(this)
  }
  held(e: Expr): { v: number; k: Held } {
    return calls.held(this, e)
  }
  dropTexts(given: readonly { v: number; k: Held }[]): void {
    calls.dropTexts(this, given)
  }
  storeGiven(m: Address, v: number, k: Held, e: Expr): void {
    calls.storeGiven(this, m, v, k, e)
  }
  blockCall(s: Extract<Stmt, { node: 'fbcall' }>): void {
    calls.blockCall(this, s)
  }
  userCall(s: Extract<Stmt, { node: 'fbcall' }>, inst: Address, name: string): void {
    calls.userCall(this, s, inst, name)
  }

  /** one expression's value handed to the host: a truth, a number, or a text (an initial value that is not a literal) */
  valueOut(e: Expr): void {
    const w = this.w
    if (isStringType(e.t) || e.node === 'str') {
      const kind = this.text(e)
      w.u8(0x10).uleb(
        this.import(`valueT${kind}`, [I32], [], (h) => (a: number) => {
          h.text = textOf(h, kind, a)
          if (kind === 'T') h.texts.length = a
        }),
      )
      return
    }
    const k = this.expr(e)
    if (k === 'b') w.u8(0x10).uleb(this.import('valueB', [I32], [], (h) => (v: number) => void (h.text = v !== 0)))
    else if (isLong(k)) {
      w.u8(0x41).sleb(k === 'L' ? 1 : 0)
      w.u8(0x10).uleb(this.import('valueL', [I64, I32], [], (h) => (v: bigint, u: number) => void (h.text = u ? BigInt.asUintN(64, v) : v)))
    } else {
      this.toF(k)
      w.u8(0x10).uleb(this.import('valueN', [F64], [], (h) => (v: number) => void (h.text = v)))
    }
  }

  get x(): GenInternals {
    return this.internals!
  }
  internals: GenInternals | null = null

  // ---- the module ----

  module(body: Stmt[], value?: Expr): Uint8Array {
    // a long statement list is split into functions of its own, each answering whether it returned
    const SPLIT = 6000
    const main = this.begin(false)
    const subs: Fn[] = []
    let cur: Fn | null = null
    const calls: number[] = []
    const startSub = (): void => {
      cur = this.begin(true)
      subs.push(cur)
    }
    startSub()
    for (const s of body) {
      if (cur!.code.len > SPLIT) startSub()
      this.stmt(s)
    }
    if (value) this.valueOut(value)
    for (const f of subs) f.code.u8(0x41).sleb(0)
    // the body: each part in turn, stopping at one that returned
    this.#fn = main
    this.w = main.code
    subs.forEach((_, i) => calls.push(i))
    const nImports = this.imports.size
    // the scan's clock is read from the program's global, not from the argument (scanWasmBase.ts Link.clock)
    main.code.u8(0x23).uleb(0).u8(0x21).uleb(1)
    for (const i of calls) main.code.u8(0x20).uleb(0).u8(0x20).uleb(1).u8(0x20).uleb(2).u8(0x10).uleb(nImports + 1 + i).u8(0x04).u8(VOID).u8(0x0f).u8(0x0b)
    const all = [main, ...subs]
    const out = new Bytes().op(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00)
    const section = (id: number, b: Bytes): void => void out.u8(id).uleb(b.len).bytes(b)
    const types = new Bytes().uleb(this.#typeBytes.length)
    for (const t of this.#typeBytes) types.bytes(t)
    section(1, types)
    const imports = new Bytes().uleb(this.imports.size + 3)
    imports.name('e').name('mem').op(0x02, 0x00).uleb(1)
    imports.name('e').name('tbl').op(0x01, 0x70, 0x00).uleb(0)
    imports.name('e').name('clk').op(0x03, F64, 0x01)
    for (const [name, im] of this.imports) imports.name('e').name(name).u8(0x00).uleb(im.type)
    section(2, imports)
    const funcs = new Bytes().uleb(all.length)
    for (const f of all) funcs.uleb(f.type)
    section(3, funcs)
    section(7, new Bytes().uleb(1).name('body').u8(0x00).uleb(nImports))
    const code = new Bytes().uleb(all.length)
    for (const f of all) {
      const b = new Bytes()
      // locals, in runs of one type
      const runs: [number, number][] = []
      for (const t of f.locals) {
        const last = runs[runs.length - 1]
        if (last && last[1] === t) last[0]++
        else runs.push([1, t])
      }
      b.uleb(runs.length)
      for (const [n, t] of runs) b.uleb(n).u8(t)
      b.bytes(f.code).u8(0x0b)
      code.uleb(b.len).bytes(b)
    }
    section(10, code)
    return out.done()
  }
}

/** The module of `body` (and of `value`, an expression whose value it hands back) over the program's memory. */
function instantiate(body: Stmt[], value: Expr | undefined, scope: GenScope, internals: GenInternals, extra: Record<string, unknown>): { run: WasmBody; host: Host; memory: WebAssembly.Memory; link: Link; bytes: number } {
  const H = { ...HELPERS, ...extra }
  const memory = memoryOf((H as unknown as { U8: Uint8Array }).U8.buffer as ArrayBuffer)
  if (!memory) throw new Error('the program is not in a WebAssembly memory')
  const link = linkOf(memory)
  const em = new Emitter(scope, link)
  em.internals = internals
  const bytes = em.module(body, value)
  const host: Host = { H, W: em.W, x: internals, text: '', args: [], texts: [] }
  const env: Record<string, unknown> = { mem: memory, tbl: link.table, clk: link.clock }
  for (const [name, im] of em.imports) env[name] = im.make(host)
  const run = new WebAssembly.Instance(new WebAssembly.Module(bytes as BufferSource), { e: env } as WebAssembly.Imports).exports.body as WasmBody
  return { run, host, memory, link, bytes: bytes.length }
}

/** One body as WebAssembly over the program's memory. */
export function generateWasmBody(body: Stmt[], scope: GenScope, internals: GenInternals, extra: Record<string, unknown>): GenBody {
  const t0 = performance.now()
  const { run, memory, link, bytes } = instantiate(body, undefined, scope, internals, extra)
  wasmStats.bodies++
  wasmStats.bytes += bytes
  wasmStats.emitMs += performance.now() - t0
  // the clock goes by the program's global; the argument it once went by is zero (scanWasmBase.ts Link.clock)
  const made = ((b: number, now: number, m?: number) => {
    const was = link.now
    if (was !== now) {
      link.clock.value = now
      link.now = now
    }
    link.depth++
    try {
      run(b, 0, m ?? 0)
    } finally {
      if (--link.depth > 0 && was !== now) {
        link.clock.value = was
        link.now = was
      }
    }
  }) as GenBody & { wasm?: WasmBody; memory?: WebAssembly.Memory }
  made.wasm = run
  made.memory = memory
  return made
}

/** One expression as a function of its instance (and a method's frame), answering its value. */
export function generateWasmValue(e: Expr, scope: GenScope, internals: GenInternals, extra: Record<string, unknown>): (b: number, m?: number) => unknown {
  const { run, host } = instantiate([], e, scope, internals, extra)
  return (b: number, m?: number): unknown => {
    run(b, 0, m ?? 0)
    return host.text
  }
}
