// The calls a body written as WebAssembly makes (scanWasm.ts): builtin and user functions, methods, standard and user
// function blocks, and what each is handed. Functions of the emitter, in the walker's order of evaluation.

import { builtinFor, comparisonMode, evalBuiltin, isBuiltinFunc } from './builtins'
import { identKey } from './program'
import { big, FB_INPUT_TYPES, FB_INPUTS, is64 } from './runtime'
import type { MethodRunner } from './scanCodegen'
import type { Emitter } from './scanWasm'
import { no, type Kind, type Held, I32, I64, F64, VOID, isWidth, isLong, kindOf, placeOf, type Address, type Host, textOf, readsOnly } from './scanWasmBase'
import type { TypeLayout } from './typed/layout'
import type { Expr, FbType, ScalarType, Stmt, TagValue, Value } from './types'
import { StError, isStringType } from './types'

/** A builtin function's call: its arguments in order, then the function. A number goes as an
 *  f64 and comes back as one, a truth as an i32; a text is read by the helper from where it is. A 64-bit integer
 *  goes and comes back as an i64, which the helper sees as the bigint the walker hands the same function ('l'; 'L'
 *  one read unsigned). */
export function builtin(em: Emitter, e: Extract<Expr, { node: 'call' }>, textOut: boolean | 'T' = false): Kind {
  const w = em.w
  let sig = ''
  // a comparison function with a 64-bit integer among its arguments takes them in one form (builtins.ts)
  const mode = comparisonMode(e.name, e.args)
  for (const a of e.args) {
    if (isStringType(a.t) || a.node === 'str') sig += em.text(a)
    else {
      const k = em.expr(a)
      if (k === 'b') sig += 'b'
      else if (mode === 'big' && k !== 'L') {
        em.toL(k)
        sig += 'l'
      } else if (isLong(k) && mode !== 'num') sig += k
      else {
        em.toF(k)
        sig += 'n'
      }
    }
  }
  const res = textOut === 'T' ? 'T' : textOut ? 't' : e.t === 'BOOL' ? 'b' : e.t === undefined || isStringType(e.t) ? no('a call answering a text here') : is64(e.t) ? kindOf(e.t) : 'n'
  const direct = e.t ? builtinFor(e.name, e.t, e.args.length) : null
  const name = e.name
  const rt = e.t as ScalarType
  const pos = e.pos
  // (a builtin's own error takes the call's position)
  const fn: (...a: Value[]) => Value =
    (direct as ((...a: Value[]) => Value) | null) ??
    ((...vals: Value[]): Value => {
      try {
        return evalBuiltin(name, rt, vals)
      } catch (err) {
        if (err instanceof Error && !(err instanceof StError)) throw new StError(err.message, pos, name.length)
        throw err
      }
    })
  w.u8(0x41).sleb(em.wk(fn))
  const params = [...sig].map((c) => (c === 'n' ? F64 : c === 'l' || c === 'L' ? I64 : I32))
  w.u8(0x10).uleb(
    em.import(`call_${sig}_${res}`, [...params, I32], res === 't' ? [] : [res === 'n' ? F64 : res === 'l' || res === 'L' ? I64 : I32], (h) => {
      const { bool, num } = h.H as { bool(v: Value): boolean; num(v: Value): number }
      // (an i64 arrives as a signed bigint: an unsigned type's is read unsigned)
      const given = (kind: string, v: number | bigint): Value => (kind === 'n' || kind === 'l' ? v : kind === 'L' ? BigInt.asUintN(64, v as bigint) : kind === 'b' ? v !== 0 : textOf(h, kind, v as number))
      const out = (r: Value): number | bigint | undefined => {
        if (res === 't') {
          h.text = r
          return undefined
        }
        if (res === 'T') return h.texts.push(r as TagValue) - 1
        if (res === 'l' || res === 'L') return big(r)
        return res === 'b' ? (bool(r) ? 1 : 0) : num(r)
      }
      const f = (k: number): ((...a: Value[]) => Value) => h.W[k] as (...a: Value[]) => Value
      const first = sig.indexOf('T')
      if (first >= 0)
        return (...all: number[]) => {
          const args: Value[] = []
          for (let i = 0; i < sig.length; i++) args.push(given(sig[i]!, all[i]!))
          h.texts.length = all[first]!
          return out(f(all[sig.length]!)(...args))
        }
      if (sig.length === 0) return (k: number) => out(f(k)())
      if (sig.length === 1) return (a: number | bigint, k: number) => out(f(k)(given(sig[0]!, a)))
      if (sig.length === 2) return (a: number | bigint, b: number | bigint, k: number) => out(f(k)(given(sig[0]!, a), given(sig[1]!, b)))
      if (sig.length === 3) return (a: number | bigint, b: number | bigint, c: number | bigint, k: number) => out(f(k)(given(sig[0]!, a), given(sig[1]!, b), given(sig[2]!, c)))
      return (...all: (number | bigint)[]) => {
        const args: Value[] = []
        for (let i = 0; i < sig.length; i++) args.push(given(sig[i]!, all[i]!))
        return out(f(all[sig.length] as number)(...args))
      }
    }),
  )
  return res === 'b' ? 'b' : res === 'T' ? 'i' : res === 'l' || res === 'L' ? res : 'f'
}

/** A user function's call with every input given in order: the
 *  arguments, the function's region reset, each stored where it goes, the body, the result read. */
export function fnCall(em: Emitter, e: Extract<Expr, { node: 'call' }>): Kind {
  const w = em.w
  const fn = em.scope.typed.fn(e.name)
  if (!(fn.direct && !e.slots && e.args.length === fn.inputSlots.length)) {
    if (fn.result) return no('a whole value from a call used as a number')
    const out = e.t === 'BOOL' ? 'b' : e.t === undefined || isStringType(e.t) ? no('a function answering a text here') : is64(e.t) ? kindOf(e.t) : 'n'
    em.fnGiven(e, fn)
    w.u8(0x41).sleb(em.wk(fn)).u8(0x41).sleb(e.slots ? em.wk(e.slots) : -1)
    w.u8(0x10).uleb(
      em.import(`fnCall_${out}`, [I32, I32], [out === 'b' ? I32 : out === 'n' ? F64 : I64], (h) => {
        const { bool, num } = h.H as { bool(v: Value): boolean; num(v: Value): number }
        return (k: number, si: number): number | bigint => {
          const r = (h.W[k] as { call(given: unknown[], slots: readonly number[] | undefined): Value }).call(h.args.pop()!, si < 0 ? undefined : (h.W[si] as readonly number[]))
          return out === 'b' ? (bool(r) ? 1 : 0) : out === 'n' ? num(r) : big(r)
        }
      }),
    )
    return out === 'b' ? 'b' : out === 'n' ? 'f' : out
  }
  if (fn.resultSlot.layout.kind !== 'scalar' || isStringType(fn.resultSlot.layout.scalar)) return no('a function answering a text or a whole value')
  const given: { v: number; k: Held; e: Expr }[] = []
  for (const a of e.args) given.push({ ...em.held(a), e: a })
  const fk = em.wk(fn)
  w.u8(0x41).sleb(fk).u8(0x10).uleb(em.import('fnEnter', [I32], [], (h) => (k: number) => (h.W[k] as { enter(): void }).enter()))
  given.forEach(({ v, k, e: a }, i) => {
    const { off, layout } = fn.inputSlots[i]!
    if (layout.kind !== 'scalar') return
    em.storeGiven({ dyn: null, off, layout }, v, k, a)
  })
  em.dropTexts(given)
  w.u8(0x41).sleb(fk).u8(0x10).uleb(em.import('fnExec', [I32], [], (h) => (k: number) => (h.W[k] as { exec(): void }).exec()))
  return em.loadAt({ dyn: null, off: fn.resultSlot.off, layout: fn.resultSlot.layout })
}

/** The arguments of a function called through its runner: each in order, a
 *  whole array or struct by its address, kept by the host until the call takes them. */
export function fnGiven(em: Emitter, e: Extract<Expr, { node: 'call' }>, fn: { readonly aggregate: readonly boolean[] }): void {
  const w = em.w
  w.u8(0x10).uleb(em.import('argsNew', [], [], (h) => () => void h.args.push([])))
  e.args.forEach((a, k) => {
    const at = e.slots ? e.slots[k]! : k
    if (fn.aggregate[at]) {
      em.aggregate(a)
      w.u8(0x10).uleb(em.import('argAddr', [I32], [], (h) => (v: number) => void h.args[h.args.length - 1]!.push(v >>> 0)))
    } else if (isStringType(a.t) || a.node === 'str') {
      const kind = em.text(a)
      w.u8(0x10).uleb(em.import(`argText${kind}`, [I32], [], (h) => (v: number) => {
        const t = textOf(h, kind, v)
        if (kind === 'T') h.texts.length = v
        h.args[h.args.length - 1]!.push(t)
      }))
    } else {
      const k2 = em.expr(a)
      if (k2 === 'b') w.u8(0x10).uleb(em.import('argBool', [I32], [], (h) => (v: number) => void h.args[h.args.length - 1]!.push(v !== 0)))
      else if (isLong(k2)) {
        w.u8(0x41).sleb(k2 === 'L' ? 1 : 0)
        w.u8(0x10).uleb(em.import('argBig', [I64, I32], [], (h) => (v: bigint, u: number) => void h.args[h.args.length - 1]!.push(u ? BigInt.asUintN(64, v) : v)))
      } else {
        em.toF(k2)
        w.u8(0x10).uleb(em.import('argNum', [F64], [], (h) => (v: number) => void h.args[h.args.length - 1]!.push(v)))
      }
    }
  })
}

/** where a whole array or struct value is, left on the stack: a place's address, or a call's copy of its result at
 *  its own call site */
export function aggregate(em: Emitter, e: Expr): void {
  const w = em.w
  if (e.node === 'var' || e.node === 'member' || e.node === 'index') return em.address(em.addr(e))
  if (e.node === 'call' && !isBuiltinFunc(e.name)) {
    const fn = em.scope.typed.fn(e.name)
    if (!fn.result) return no('this whole-array or struct value')
    const dst = em.scope.typed.temp(e)
    if (dst === undefined) return no('this call of a function with a whole array or struct result')
    em.fnGiven(e, fn)
    w.u8(0x41).sleb(em.wk(fn)).u8(0x41).sleb(e.slots ? em.wk(e.slots) : -1).u8(0x41).sleb(dst | 0)
    w.u8(0x10).uleb(
      em.import('fnCallAgg', [I32, I32, I32], [I32], (h) => (k: number, si: number, d: number) =>
        (h.W[k] as { callAgg(given: unknown[], slots: readonly number[] | undefined, dst: number): number }).callAgg(h.args.pop()!, si < 0 ? undefined : (h.W[si] as readonly number[]), d >>> 0),
      ),
    )
    return
  }
  if (e.node === 'mcall' && e.sig?.ret) {
    const res = em.scope.typed.frameOf(e.sig).byKey.get(identKey(e.sig.name))
    if (res && res.layout.kind !== 'scalar') return void em.methodCall(e)
  }
  return no('this whole-array or struct value')
}

/**
 * A METHOD call, in the walker's order: the instance; which implementation runs; the
 * scalar inputs; each copied input, in-out and bound reference or interface; a frame; the arguments stored in it;
 * the body; each scalar in-out copied back, each output stored; the result; the frame given back. Leaves the
 * result: a scalar's value, a whole value's address, 0 for none.
 */
export function methodCall(em: Emitter, e: Extract<Expr, { node: 'mcall' }>): Kind {
  const w = em.w
  const typed = em.scope.typed
  const f = em.local(I32)
  // the instance: THIS, what an interface refers to (faulting when none), or a place holding one
  if (e.obj.node === 'this') w.u8(0x20).uleb(0)
  else if (em.isIface(e.obj)) {
    em.at(em.slot(e.obj), 0x28, 2)
    w.u8(0x41).sleb(em.wk(e.pos)).u8(0x10).uleb(em.ifaceAt())
  } else em.address(em.addr(e.obj))
  w.u8(0x21).uleb(f)
  if (e.body) {
    if (!typed.cls) return no('SUPER^() outside a class')
    w.u8(0x41).sleb(em.wk(typed.baseBody(typed.cls.name, e.cls!))).u8(0x20).uleb(f).u8(0x20).uleb(1)
    w.u8(0x10).uleb(em.import('run', [I32, I32, F64], [], (h) => (k: number, at: number, now: number) => (h.W[k] as { run(b: number, now: number): void }).run(at >>> 0, now)))
    w.u8(0x41).sleb(0)
    return 'i'
  }
  const sig = e.sig!
  // which implementation: by the instance's class number (a call through an interface or a reference), or known now
  const cls = em.local(I32)
  let table: number
  let dyn = 0
  if (e.dispatch === 'dynamic') {
    dyn = 1
    table = em.wk(typed.dispatch(e.key!))
    w.u8(0x20).uleb(f).u8(0x28).uleb(2).uleb(0).u8(0x22).uleb(cls)
    w.u8(0x41).sleb(table).u8(0x41).sleb(em.wk(e.pos))
    w.u8(0x10).uleb(
      em.import('mCheck', [I32, I32, I32], [], (h) => (c: number, ti: number, pi: number) => {
        // nothing behind the class number, no implementation: the fault of an interface that refers to none
        if ((h.W[ti] as (MethodRunner | undefined)[])[c >>> 0] === undefined) (h.H.ifaceAt as (a: number, p: unknown) => number)(0, h.W[pi])
      }),
    )
  } else {
    const concrete = e.obj.node === 'this' ? typed.cls?.name : e.cls!
    if (concrete === undefined) return no('THIS outside a class')
    const from = e.dispatch === 'self' ? concrete : e.cls!
    table = em.wk(typed.method(concrete, typed.implOf(from, e.key!)))
    w.u8(0x41).sleb(0).u8(0x21).uleb(cls)
  }
  const runner = (h: Host, ti: number, c: number, d: number): MethodRunner => (d ? (h.W[ti] as MethodRunner[])[c >>> 0]! : (h.W[ti] as MethodRunner))
  const which = (): void => void w.u8(0x41).sleb(table).u8(0x20).uleb(cls).u8(0x41).sleb(dyn)
  const frame = typed.frameOf(sig)
  const fm = em.local(I32)
  const at = (arg: string): Address => {
    const m = frame.byKey.get(identKey(arg))
    if (!m || m.hidden) return no(`the parameter '${arg}'`)
    return { dyn: () => void em.w.u8(0x20).uleb(fm), off: m.off, layout: m.layout }
  }
  const scalars: { arg: string; v: number; k: Held; e: Expr }[] = []
  for (const a of e.args) {
    if (a.out || a.inout || a.copy || a.bind) continue
    scalars.push({ arg: a.name, ...em.held(a.value), e: a.value })
  }
  // what each copied input, in-out and bound argument is given, before the frame is taken; stored once it is
  const stores: (() => void)[] = []
  for (const a of e.args) {
    if (a.copy && !a.out) {
      const p = at(a.name)
      const v = em.local(I32)
      em.aggregate(a.value)
      w.u8(0x21).uleb(v)
      stores.push(() => {
        em.address(p)
        w.u8(0x20).uleb(v).u8(0x41).sleb(p.layout.size).op(0xfc, 0x0a, 0x00, 0x00)
      })
    } else if (a.inout) {
      const m = frame.byKey.get(identKey(a.name))!
      const p = at(a.name)
      if (m.ref) {
        const v = em.local(I32)
        em.address(em.addr(a.value))
        w.u8(0x21).uleb(v)
        stores.push(() => {
          if (p.dyn) p.dyn()
          w.u8(0x20).uleb(v).u8(0x36).uleb(2).uleb(p.off)
        })
      } else {
        if (isStringType(a.value.t)) return no('a STRING VAR_IN_OUT of a method')
        const k = em.expr(a.value)
        if (p.layout.kind !== 'scalar' || isStringType(p.layout.scalar) || kindOf(p.layout.scalar) !== k) return no('a VAR_IN_OUT of another kind than its argument')
        const v = em.local(em.typeOfKind(k))
        w.u8(0x21).uleb(v)
        stores.push(() => em.storeAt(p, v))
      }
    } else if (a.bind) {
      const p = at(a.name)
      const v = em.local(I32)
      if (a.bind === 'ref') em.refGiven(a.value, a.alias)
      else em.instanceOf(a.value)
      w.u8(0x21).uleb(v)
      stores.push(() => {
        if (p.dyn) p.dyn()
        w.u8(0x20).uleb(v).u8(0x36).uleb(2).uleb(p.off)
      })
    }
  }
  which()
  w.u8(0x20).uleb(f)
  w.u8(0x10).uleb(em.import('mEnter', [I32, I32, I32, I32], [I32], (h) => (ti: number, c: number, d: number, inst: number) => runner(h, ti, c, d).enter(inst >>> 0)))
  w.u8(0x21).uleb(fm)
  for (const store of stores) store()
  for (const { arg, v, k, e: given } of scalars) {
    const p = at(arg)
    if (p.layout.kind !== 'scalar') return no(`the parameter '${arg}'`)
    em.storeGiven(p, v, k, given)
  }
  em.dropTexts(scalars)
  which()
  w.u8(0x20).uleb(f).u8(0x20).uleb(1).u8(0x20).uleb(fm)
  w.u8(0x10).uleb(em.import('mRun', [I32, I32, I32, I32, F64, I32], [], (h) => (ti: number, c: number, d: number, inst: number, now: number, m: number) => runner(h, ti, c, d).run(inst >>> 0, now, m >>> 0)))
  for (const a of e.args) {
    if (!a.inout || frame.byKey.get(identKey(a.name))!.ref) continue
    const k = em.loadAt(at(a.name))
    const r = em.local(em.typeOfKind(k))
    w.u8(0x21).uleb(r)
    em.place(a.value, r, k)
  }
  for (const a of e.args) {
    if (!a.out) continue
    const p = at(a.name)
    if (a.copy) {
      em.address(em.addr(a.value))
      em.address(p)
      w.u8(0x41).sleb(p.layout.size).op(0xfc, 0x0a, 0x00, 0x00)
      continue
    }
    if (p.layout.kind === 'scalar' && isStringType(p.layout.scalar)) {
      if (!isStringType(a.value.t)) return no('a STRING output of a method stored to a number')
      em.textFrom(p)
      em.textPutTo(a.value, em.x.placeMaxLen(a.value), undefined)
      continue
    }
    if (isStringType(a.value.t)) return no('a number output of a method stored to a STRING')
    const k = em.coerceStack(a.value.t as ScalarType, em.loadAt(p), undefined)
    const q = em.local(em.typeOfKind(k))
    w.u8(0x21).uleb(q)
    em.place(a.value, q, k)
  }
  let kind: Kind = 'i'
  let result: number
  if (sig.ret === null) {
    result = em.local(I32)
    w.u8(0x41).sleb(0).u8(0x21).uleb(result)
  } else {
    const res = at(sig.name)
    if (res.layout.kind === 'scalar' && isStringType(res.layout.scalar)) {
      // a text: read before the frame is given back and kept by the host, its place there the result
      em.address(res)
      w.u8(0x10).uleb(em.import('textKeeps', [I32], [I32], (h) => (a: number) => h.texts.push(textOf(h, 's', a)) - 1))
      result = em.local(I32)
      w.u8(0x21).uleb(result)
    } else if (res.layout.kind === 'scalar') {
      kind = em.loadAt(res)
      result = em.local(em.typeOfKind(kind))
      w.u8(0x21).uleb(result)
    } else {
      // a whole array or struct: copied to the call site's own region before the frame is given back, and its address
      const dst = typed.temp(e)
      if (dst === undefined) return no('this call of a method with a whole array or struct result')
      w.u8(0x41).sleb(dst | 0)
      em.address(res)
      w.u8(0x41).sleb(res.layout.size).op(0xfc, 0x0a, 0x00, 0x00)
      result = em.local(I32)
      w.u8(0x41).sleb(dst | 0).u8(0x21).uleb(result)
      kind = 'u'
    }
  }
  which()
  w.u8(0x20).uleb(fm)
  w.u8(0x10).uleb(em.import('mLeave', [I32, I32, I32, I32], [], (h) => (ti: number, c: number, d: number, m: number) => runner(h, ti, c, d).leave(m >>> 0)))
  w.u8(0x20).uleb(result)
  return kind
}

/** whether a METHOD call answers a STRING: its result is then a text the host keeps (methodCall) */
export function answersText(em: Emitter, e: Extract<Expr, { node: 'mcall' }>): boolean {
  if (e.body || !e.sig || e.sig.ret === null) return false
  const res = em.scope.typed.frameOf(e.sig).byKey.get(identKey(e.sig.name))
  return !!res && res.layout.kind === 'scalar' && isStringType(res.layout.scalar)
}
export function ifaceAt(em: Emitter): number {
  return em.import('ifaceAt', [I32, I32], [I32], (h) => (a: number, pi: number) => (h.H.ifaceAt as (a: number, p: unknown) => number)(a >>> 0, h.W[pi]))
}

/** What an argument gives, evaluated now and held in a local until the call stores it: a number or a truth itself,
 *  a text ('t') by its place with the host, which keeps it as it is now whatever a later argument changes. */
export function held(em: Emitter, e: Expr): { v: number; k: Held } {
  const w = em.w
  if (isStringType(e.t) || e.node === 'str') {
    const kind = em.text(e)
    if (kind !== 'T') w.u8(0x10).uleb(em.import(`textKeep${kind}`, [I32], [I32], (h) => (a: number) => h.texts.push(textOf(h, kind, a)) - 1))
    const v = em.local(I32)
    w.u8(0x21).uleb(v)
    return { v, k: 't' }
  }
  const k = em.expr(e)
  const v = em.local(em.typeOfKind(k))
  w.u8(0x21).uleb(v)
  return { v, k }
}

/** the texts `held` kept for a call's arguments given back, once the call has stored them: the first and all after */
export function dropTexts(em: Emitter, given: readonly { v: number; k: Held }[]): void {
  const first = given.find((g) => g.k === 't')
  if (first) em.w.u8(0x20).uleb(first.v).u8(0x10).uleb(em.import('textsDrop', [I32], [], (h) => (at: number) => void (h.texts.length = at)))
}

/** the local `v` (what `e` gave, of kind `k`) stored into a block's or a function's scalar input at `m`, coerced as
 *  the member's setter coerces it */
export function storeGiven(em: Emitter, m: Address, v: number, k: Held, e: Expr): void {
  const w = em.w
  if (m.layout.kind !== 'scalar') return no('a whole value here')
  const t = m.layout.scalar
  if (isStringType(t)) {
    if (k !== 't') return no('a number handed to a STRING input')
    // the text the host keeps, cut to the input's capacity and written
    em.address(m)
    w.u8(0x41).sleb(m.layout.cap!).u8(0x41).sleb(em.wk(em.x.coercerFor('STRING', m.layout.cap, undefined))).u8(0x20).uleb(v)
    w.u8(0x10).uleb(
      em.import('textPutKept', [I32, I32, I32, I32], [], (h) => (a: number, cap: number, ci: number, at: number) => {
        ;(h.H.strPut as (a: number, cap: number, s: string) => void)(a, cap, (h.W[ci] as (v: TagValue) => TagValue)(h.texts[at]!) as string)
      }),
    )
    return
  }
  if (k === 't') return no('a text handed to an input that is not a STRING')
  w.u8(0x20).uleb(v)
  let kept: Kind
  if (m.layout.enumerated) {
    if (k === 'f') em.w.op(0xfc, 0x02)
    else if (isLong(k)) em.w.u8(0xa7)
    em.wrapI('INT')
    kept = 'i'
  } else if (em.canonical(e, t) || (isWidth(t) && e.node !== 'call' && isWidth(e.t) && em.canonical(e, e.t) && em.within(e, t))) {
    // already in the place's form: only its kind may differ (a whole literal into a REAL, or into a 64-bit integer)
    if (kindOf(t) === 'f') em.toF(k)
    else if (isLong(kindOf(t))) em.toL(k === 'b' ? 'u' : k)
    kept = kindOf(t)
  } else kept = em.coerceStack(t, k, undefined)
  const held = em.local(em.typeOfKind(kept))
  w.u8(0x21).uleb(held)
  em.storeAt(m, held)
}

/** a standard block's call: the instance, its inputs in the call's order, the block,
 *  then each output binding read from the record, coerced and stored */
export function blockCall(em: Emitter, s: Extract<Stmt, { node: 'fbcall' }>): void {
  const w = em.w
  const inst = em.addr(s.target)
  if (inst.layout.kind === 'struct' && inst.layout.fb) return em.userCall(s, inst, inst.layout.fb)
  if (inst.layout.kind !== 'struct') return no('this function block call')
  const blk = inst.layout.block
  if (!blk) return no('this function block call')
  if (s.args.some((a) => a.inout || a.copy)) return no('this function block argument')
  const rec = inst.layout
  const f = em.local(I32)
  em.address(inst)
  w.u8(0x21).uleb(f)
  const given = new Map<string, number>()
  // A 64-bit input (a typed counter's PV) is stored where the block keeps it, exactly: the block's helper takes its
  // inputs as numbers. The block then reads it as an input the call left out, which is what a kept input is.
  const kept: (() => void)[] = []
  for (const a of s.args.filter((x) => !x.out)) {
    if (isStringType(a.value.t)) return no('a STRING handed to a block')
    const wide = FB_INPUT_TYPES[blk][identKey(a.name)]
    if (wide !== undefined && is64(wide)) {
      const field = rec.byKey.get(identKey(a.name))
      if (!field) return no(`the input '${a.name}'`)
      const k = em.coerce(wide, a.pos, a.value)
      const held = em.local(em.typeOfKind(k))
      w.u8(0x21).uleb(held)
      kept.push(() => em.storeAt({ dyn: () => void em.w.u8(0x20).uleb(f), off: field.off, layout: field.layout }, held))
      continue
    }
    const v = em.local(F64)
    em.toF(em.expr(a.value))
    w.u8(0x21).uleb(v)
    given.set(identKey(a.name), v)
  }
  for (const store of kept) store()
  if (blk === 'TON' || blk === 'TOF' || blk === 'TP') timerBlock(em, blk, f, given, rec)
  else if (!hostBlock(em, blk, f, given)) return no('a block with this many inputs')
  for (const a of s.args.filter((x) => x.out)) {
    const field = rec.byKey.get(identKey(a.name))
    if (!field || field.hidden || field.layout.kind !== 'scalar') return no(`the output '${a.name}'`)
    if (isStringType(a.value.t) || isStringType(field.layout.scalar)) return no('a STRING output')
    const k = em.coerceStack(a.value.t as ScalarType, em.loadAt({ dyn: () => void em.w.u8(0x20).uleb(f), off: field.off, layout: field.layout }), undefined)
    const q = em.local(em.typeOfKind(k))
    w.u8(0x21).uleb(q)
    em.place(a.value, q, k)
  }
}

/** A standard block the host runs (typed/blocks.ts): its instance, which inputs the call gives, each input, the
 *  clock. False for a block with more inputs than the mask of the given ones holds. */
function hostBlock(em: Emitter, blk: FbType, f: number, given: ReadonlyMap<string, number>): boolean {
  const w = em.w
  const names = FB_INPUTS[blk]
  let mask = 0
  w.u8(0x20).uleb(f)
  names.forEach((name, i) => {
    if (given.has(identKey(name))) mask += 2 ** i
  })
  if (names.length > 30) return false
  w.u8(0x41).sleb(mask)
  for (const name of names) {
    const v = given.get(identKey(name))
    if (v === undefined) w.u8(0x44).f64(0)
    else w.u8(0x20).uleb(v)
  }
  w.u8(0x20).uleb(1)
  const arity = names.length
  w.u8(0x10).uleb(
    em.import(`blk_${blk}`, [I32, I32, ...names.map(() => F64), F64], [], (h) => {
      const run = h.H[`blk_${blk}`] as (...a: unknown[]) => void
      // an input the call left out is undefined: the block then keeps what its record holds
      const g = (m: number, i: number, v: number): number | undefined => ((m >> i) & 1 ? v : undefined)
      if (arity === 1) return (at: number, m: number, a: number, now: number) => run(at, g(m, 0, a), now)
      if (arity === 2) return (at: number, m: number, a: number, b: number, now: number) => run(at, g(m, 0, a), g(m, 1, b), now)
      if (arity === 3) return (at: number, m: number, a: number, b: number, c: number, now: number) => run(at, g(m, 0, a), g(m, 1, b), g(m, 2, c), now)
      if (arity === 4) return (at: number, m: number, a: number, b: number, c: number, d: number, now: number) => run(at, g(m, 0, a), g(m, 1, b), g(m, 2, c), g(m, 3, d), now)
      return (at: number, m: number, ...rest: number[]) => {
        const args: unknown[] = [at]
        for (let i = 0; i < arity; i++) args.push(g(m, i, rest[i]!))
        args.push(rest[arity])
        run(...args)
      }
    }),
  )
  return true
}

/**
 * A timer block (TON, TOF, TP) written in the body itself, over its record in the arena: what runtime.ts's timers do
 * for the walker, instruction for instruction, with the scan's clock read from the body's own local. A timer is a few
 * loads, a subtraction and a compare, so it needs no call out to the host.
 */
function timerBlock(em: Emitter, blk: 'TON' | 'TOF' | 'TP', f: number, given: ReadonlyMap<string, number>, rec: Extract<TypeLayout, { kind: 'struct' }>): void {
  const w = em.w
  const off = (field: string): number => rec.byKey.get(identKey(field))!.off
  const inst = (): void => void w.u8(0x20).uleb(f)
  const get = (local: number) => (): void => void w.u8(0x20).uleb(local)
  const i32 = (n: number) => (): void => void w.u8(0x41).sleb(n)
  const f64 = (x: number) => (): void => void w.u8(0x44).f64(x)
  const now = get(1)
  const load8 = (field: string): void => {
    inst()
    w.u8(0x2d).uleb(0).uleb(off(field))
  }
  const store8 = (field: string, value: () => void): void => {
    inst()
    value()
    w.u8(0x3a).uleb(0).uleb(off(field))
  }
  const loadF = (field: string): void => {
    inst()
    w.u8(0x2b).uleb(0).uleb(off(field))
  }
  const storeF = (field: string, value: () => void): void => {
    inst()
    value()
    w.u8(0x39).uleb(0).uleb(off(field))
  }
  const when = (then: () => void, otherwise?: () => void): void => {
    w.u8(0x04).u8(VOID)
    then()
    if (otherwise) {
      w.u8(0x05)
      otherwise()
    }
    w.u8(0x0b)
  }
  const pt = em.local(F64)
  const et = em.local(F64)
  // an input the call gives is kept in the record first; one it leaves out has what the last call gave
  const givenPt = given.get(identKey('PT'))
  if (givenPt !== undefined) storeF('PT', get(givenPt))
  loadF('PT')
  w.u8(0x21).uleb(pt)
  const givenIn = given.get(identKey('IN'))
  /** the given IN as a BOOL: any number but zero (runtime.ts bool) */
  const inGiven = (): void => {
    get(givenIn!)()
    f64(0)()
    w.u8(0x62)
  }
  /** et := min(pt, max(0, now - start) / 1e6), and into ET */
  const elapse = (): void => {
    get(pt)()
    f64(0)()
    now()
    loadF('start')
    w.u8(0xa1).u8(0xa5)
    f64(1e6)()
    w.u8(0xa3).u8(0xa4).u8(0x21).uleb(et)
    storeF('ET', get(et))
  }
  const etBelowPt = (): void => {
    get(et)()
    get(pt)()
    w.u8(0x63)
  }
  const etAtPt = (): void => {
    get(et)()
    get(pt)()
    w.u8(0x66)
  }
  const start = (): void => {
    store8('running', i32(1))
    storeF('start', now)
    storeF('ET', f64(0))
  }
  if (blk === 'TON') {
    if (givenIn !== undefined) store8('IN', inGiven)
    load8('IN')
    when(
      () => {
        load8('running')
        when(
          () => {
            elapse()
            store8('Q', etAtPt)
          },
          () => {
            // the clock starts here, with nothing elapsed yet
            start()
            store8('Q', i32(0))
          },
        )
      },
      () => {
        storeF('ET', f64(0))
        store8('Q', i32(0))
        store8('running', i32(0))
      },
    )
    return
  }
  if (blk === 'TOF') {
    if (givenIn !== undefined) store8('IN', inGiven)
    load8('IN')
    when(
      () => {
        store8('Q', i32(1))
        storeF('ET', f64(0))
        store8('running', i32(0))
      },
      () => {
        // (Q clear: IN was never true, or the off-delay has already expired)
        load8('Q')
        when(() => {
          load8('running')
          when(
            () => {
              elapse()
              store8('Q', etBelowPt)
            },
            // the falling edge: hold Q and start from zero
            start,
          )
        })
      },
    )
    return
  }
  // TP: prev is IN as the last call left it
  const inn = em.local(I32)
  if (givenIn !== undefined) inGiven()
  else {
    load8('prev')
    w.u8(0x41).sleb(0).u8(0x47)
  }
  w.u8(0x21).uleb(inn)
  const rising = em.local(I32)
  get(inn)()
  load8('prev')
  w.u8(0x45).u8(0x71).u8(0x21).uleb(rising)
  store8('prev', get(inn))
  load8('running')
  w.u8(0x45)
  get(rising)()
  w.u8(0x71)
  when(
    () => {
      start()
      store8('Q', i32(1))
    },
    () => {
      load8('running')
      when(
        () => {
          elapse()
          store8('Q', etBelowPt)
          etAtPt()
          when(() => store8('running', i32(0)))
        },
        () => {
          store8('Q', i32(0))
          // pulse finished and input released: clear elapsed
          get(inn)()
          w.u8(0x45)
          when(() => storeF('ET', f64(0)))
        },
      )
    },
  )
}

/** A user function block's call, in the walker's order: the instance's place; the scalar
 *  inputs; each bound reference, copied whole input and VAR_IN_OUT; the scalar inputs stored; the body; each scalar
 *  VAR_IN_OUT copied back; each output read, coerced and stored. */
export function userCall(em: Emitter, s: Extract<Stmt, { node: 'fbcall' }>, inst: Address, name: string): void {
  const w = em.w
  const rec = inst.layout as Extract<TypeLayout, { kind: 'struct' }>
  const f = em.local(I32)
  em.address(inst)
  w.u8(0x21).uleb(f)
  const fAt = (off: number, layout: TypeLayout): Address => ({ dyn: () => void em.w.u8(0x20).uleb(f), off, layout })
  const member = (arg: string): Address | null => {
    const m = rec.byKey.get(identKey(arg))
    return m && !m.hidden ? fAt(m.off, m.layout) : null
  }
  const scalars: { arg: string; v: number; k: Held; e: Expr }[] = []
  for (const a of s.args) {
    if (a.out || a.inout || a.copy || a.bind) continue
    scalars.push({ arg: a.name, ...em.held(a.value), e: a.value })
  }
  for (const a of s.args) {
    const m = rec.byKey.get(identKey(a.name))
    if (a.bind) {
      if (!m) continue
      w.u8(0x20).uleb(f)
      if (a.bind === 'ref') em.refGiven(a.value, a.alias)
      else em.instanceOf(a.value)
      w.u8(0x36).uleb(2).uleb(m.off)
    } else if (a.copy && !a.out) {
      if (!m) continue
      const src = em.local(I32)
      em.aggregate(a.value)
      w.u8(0x21).uleb(src).u8(0x20).uleb(f)
      if (m.off !== 0) w.u8(0x41).sleb(m.off).u8(0x6a)
      w.u8(0x20).uleb(src).u8(0x41).sleb(m.layout.size).op(0xfc, 0x0a, 0x00, 0x00)
    } else if (a.inout) {
      if (!m) continue
      if (m.ref) {
        // bound by reference: its address
        w.u8(0x20).uleb(f)
        em.address(em.addr(a.value))
        w.u8(0x36).uleb(2).uleb(m.off)
      } else {
        // a scalar: its value, in, and back out below
        const src = em.strSource(a.value)
        const slot = fAt(m.off, m.layout)
        if (src && slot.layout.kind === 'scalar' && isStringType(slot.layout.scalar)) em.strCopy(slot, src, slot.layout.cap!)
        else {
          if (isStringType(a.value.t)) return no('a STRING VAR_IN_OUT that is not a place')
          const k = em.expr(a.value)
          if (slot.layout.kind !== 'scalar' || isStringType(slot.layout.scalar) || kindOf(slot.layout.scalar) !== k) return no('a VAR_IN_OUT of another kind than its argument')
          const v = em.local(em.typeOfKind(k))
          w.u8(0x21).uleb(v)
          em.storeAt(slot, v)
        }
      }
    }
  }
  for (const { arg, v, k, e } of scalars) {
    const m = member(arg)
    if (!m || m.layout.kind !== 'scalar') continue // a name the block does not have: its setter does nothing
    em.storeGiven(m, v, k, e)
  }
  em.dropTexts(scalars)
  // the block's body, through the program's table: no JavaScript between the two
  w.u8(0x20).uleb(f).u8(0x20).uleb(1).u8(0x41).sleb(0).u8(0x41).sleb(placeOf(em.link, em.scope.typed.fb(name)))
  w.u8(0x11).uleb(em.type([I32, F64, I32], [])).uleb(0)
  for (const a of s.args) {
    if (!a.inout) continue
    const m = rec.byKey.get(identKey(a.name))
    if (!m || m.ref) continue
    const slot = fAt(m.off, m.layout)
    if (slot.layout.kind === 'scalar' && isStringType(slot.layout.scalar)) {
      if (!isStringType(a.value.t)) return no('a STRING VAR_IN_OUT copied back to a number')
      if (!readsOnly(a.value) || !em.strSource(a.value)) {
        em.textFrom(slot)
        em.textPutTo(a.value, undefined, undefined)
        continue
      }
      const dst = em.addr(a.value)
      em.strCopy(dst, slot, (dst.layout as Extract<TypeLayout, { kind: 'scalar' }>).cap!)
      continue
    }
    const k = em.loadAt(slot)
    const r = em.local(em.typeOfKind(k))
    w.u8(0x21).uleb(r)
    em.place(a.value, r, k)
  }
  for (const a of s.args) {
    if (!a.out) continue
    const m = member(a.name)
    if (!m) return no(`the output '${a.name}'`)
    if (a.copy) {
      em.address(em.addr(a.value))
      em.address(m)
      w.u8(0x41).sleb(m.layout.size).op(0xfc, 0x0a, 0x00, 0x00)
      continue
    }
    if (m.layout.kind === 'scalar' && isStringType(m.layout.scalar)) {
      if (!isStringType(a.value.t)) return no('a STRING output stored to a number')
      if (!readsOnly(a.value) || !em.strSource(a.value)) {
        em.textFrom(m)
        em.textPutTo(a.value, em.x.placeMaxLen(a.value), undefined)
        continue
      }
      const dst = em.addr(a.value)
      const maxLen = em.x.placeMaxLen(a.value)
      const cap = (dst.layout as Extract<TypeLayout, { kind: 'scalar' }>).cap!
      em.strCopy(dst, m, maxLen === undefined ? cap : Math.min(cap, maxLen))
      continue
    }
    if (isStringType(a.value.t)) return no('a STRING output')
    const k = em.coerceStack(a.value.t as ScalarType, em.loadAt(m), undefined)
    const q = em.local(em.typeOfKind(k))
    w.u8(0x21).uleb(q)
    em.place(a.value, q, k)
  }
}
