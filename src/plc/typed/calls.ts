// Where a typed program calls a function whose result is a whole array or struct. Each such call site gets a region of
// its own for the result, placed with the rest before the arena is made (docs/plc-typed-storage.md, "Layout": a
// FUNCTION's region is reused by every call, so `Total(MakePt(1), MakePt(2))` would otherwise hold one result twice).
// A site this walk misses is refused when its code is generated (TypedScope.temp answers nothing), never run wrong.

import { identKey } from '../program'
import type { Decl, Expr, FbArg, Initializer, Stmt } from '../types'
import { isArray, isStruct } from '../types'

/** Every call node, anywhere in these bodies and declarations, that `aggregate(name)` says returns an aggregate - and every
 *  METHOD call whose result is a whole array or struct, whose frame is given back before the caller has used it. */
export function aggregateCalls(bodies: readonly Stmt[][], declLists: readonly (readonly Decl[])[], aggregate: (name: string) => boolean): Expr[] {
  const found: Expr[] = []
  const expr = (e: Expr): void => {
    switch (e.node) {
      case 'num':
      case 'bool':
      case 'str':
      case 'var':
      case 'this':
        return
      case 'member':
      case 'bit':
      case 'isref':
        return expr(e.obj)
      case 'mcall':
        expr(e.obj)
        e.args.forEach((a) => expr(a.value))
        if (e.sig?.ret && (isArray(e.sig.ret) || isStruct(e.sig.ret))) found.push(e)
        return
      case 'index':
        expr(e.obj)
        return e.indices.forEach(expr)
      case 'call':
        e.args.forEach(expr)
        if (aggregate(identKey(e.name))) found.push(e)
        return
      case 'unary':
        return expr(e.expr)
      case 'binary':
        expr(e.left)
        return expr(e.right)
    }
  }
  const init = (v: Initializer): void => {
    if (v.node === 'structInit') v.fields.forEach((f) => init(f.value))
    else if (v.node === 'arrayInit') v.items.forEach(init)
    else expr(v)
  }
  const stmts = (body: readonly Stmt[]): void => body.forEach(stmt)
  const stmt = (s: Stmt): void => {
    switch (s.node) {
      case 'assign':
        expr(s.target)
        return expr(s.value)
      case 'fbcall':
        expr(s.target)
        return s.args.forEach((a: FbArg) => expr(a.value))
      case 'if':
        s.branches.forEach((b) => {
          expr(b.cond)
          stmts(b.body)
        })
        return void (s.elseBody && stmts(s.elseBody))
      case 'case':
        expr(s.selector)
        s.cases.forEach((c) => stmts(c.body))
        return void (s.elseBody && stmts(s.elseBody))
      case 'for':
        expr(s.from)
        expr(s.to)
        if (s.by) expr(s.by)
        return stmts(s.body)
      case 'while':
        expr(s.cond)
        return stmts(s.body)
      case 'repeat':
        stmts(s.body)
        return expr(s.cond)
      case 'exit':
      case 'continue':
      case 'return':
        return
      case 'invoke':
        return expr(s.call)
      case 'bind':
        expr(s.target)
        return void (s.source && expr(s.source))
    }
  }
  bodies.forEach(stmts)
  for (const list of declLists) {
    for (const d of list) {
      if (d.init) expr(d.init)
      d.arrayInit?.forEach(init)
      if (d.structInit) init(d.structInit)
    }
  }
  return found
}
