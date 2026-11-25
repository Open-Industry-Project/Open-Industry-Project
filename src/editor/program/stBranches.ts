// Which arms of a program's IF and CASE statements it is not taking, read from the values it publishes.
//
// The values are the image at the end of a scan, not what each condition saw when it ran. So an arm is marked only
// when its condition can be worked out from published values alone, and these are left unmarked:
//   - a condition that calls anything, does arithmetic, or reads a name with no published value (a function block's
//     own variable, a 64-bit integer, a string);
//   - anything inside a loop, where the condition differs on each pass;
//   - function blocks, functions and methods, which run once per call;
//   - a condition reading a variable the scan sets before the statement and writes again at or after it
//     (`req := sensor; IF req THEN req := FALSE; ...`): the image holds the later value on every scan, never the one
//     the condition saw. A write in an arm that is itself not taken does not count, so a state machine with a reset
//     ahead of it keeps its marks while the reset is off.
// A variable written only after its condition (a CASE whose arms move its own selector) shows the arm the next scan
// takes, which differs from the one that ran for the one scan of a change.
//
// Pure: stLang.ts keeps a plan per text and asks it on every value push, for the range of the text on screen. A
// statement is worked out when it is asked for, with the earlier ones its answer depends on, so a push costs what is
// on screen and not the program (measured on a 2.8 MB text: 33 ms for all of it, under 0.1 ms for a screen).

import type { Ast, CaseLabel, Expr, SourceSpan, Stmt, TagValue } from '../../plc/types'
import { watchBit } from '../../core/watchTable'

/** A published value by its key upper-cased, or undefined when the image has none. */
export type ReadValue = (keyUpper: string) => TagValue | undefined

type Known = TagValue | undefined
type Eval = (read: ReadValue) => Known

/** One arm of a statement: `arm` counts the arms in order, with the ELSE arm after the last. */
interface ArmRef {
  node: Node
  arm: number
}
interface Arm {
  span: SourceSpan
  inner: Node[]
}
/** A condition, and whether a write ahead of it makes the image the wrong thing to read it from: always (true), never
 *  (null), or while one of these arms, each holding such a write, is running. Made when the condition is first asked
 *  for: a text has far more conditions than a screen shows. */
type Cond = () => { cond: Eval; contest: true | ArmRef[] | null }
interface NodeBase {
  /** where the statement starts and where its last arm ends */
  start: number
  end: number
  /** the arm this statement is written in, or null at the top of a body */
  parent: ArmRef | null
  arms: Arm[]
  rest: Arm | null
}
type Node = (NodeBase & { kind: 'if'; conds: Cond[] }) | (NodeBase & { kind: 'case'; selector: Cond; matches: ((v: number) => boolean | undefined)[] })

/** The IF and CASE statements of a text, with their conditions ready to evaluate. */
export interface BranchPlan {
  /** the top statements of each marked body, in source order */
  readonly bodies: readonly (readonly Node[])[]
}

const UNKNOWN: Eval = () => undefined

interface Scope {
  /** the watch key a name written at an offset is published under (plc/watchScope.ts), or null */
  keyAt: (offset: number, name: string) => string | null
  /** an enumeration member's value: by `TYPE#MEMBER`, and by `MEMBER` alone where one enumeration has it */
  members: ReadonlyMap<string, number>
}

function enumMembers(ast: Ast): Map<string, number> {
  const out = new Map<string, number>()
  const bare = new Map<string, number | null>()
  for (const def of ast.enumDefs) {
    for (const m of def.members) {
      const name = m.name.toUpperCase()
      out.set(`${def.name.toUpperCase()}#${name}`, m.value)
      bare.set(name, bare.has(name) ? null : m.value)
    }
  }
  for (const [name, value] of bare) if (value !== null) out.set(name, value)
  return out
}

/** The key of a place (`a`, `a.b`, `a[i].c`) upper-cased, as a function of the values: an index may be a variable. */
function placeKey(e: Expr, scope: Scope): ((read: ReadValue) => string | null) | null {
  if (e.node === 'var') {
    if (e.ref || e.qualifier !== undefined) return null
    const key = scope.keyAt(e.pos.offset, e.name)
    if (key === null) return null
    const upper = key.toUpperCase()
    return () => upper
  }
  if (e.node === 'member') {
    const base = placeKey(e.obj, scope)
    if (!base) return null
    const field = `.${e.field.toUpperCase()}`
    return (read) => {
      const b = base(read)
      return b === null ? null : b + field
    }
  }
  if (e.node === 'index') {
    const base = placeKey(e.obj, scope)
    if (!base) return null
    const indices = e.indices.map((ix) => compile(ix, scope))
    return (read) => {
      const b = base(read)
      if (b === null) return null
      const at: number[] = []
      for (const ix of indices) {
        const v = ix(read)
        if (typeof v !== 'number' || !Number.isInteger(v)) return null
        at.push(v)
      }
      return `${b}[${at.join(',')}]`
    }
  }
  return null
}

/** A place's path upper-cased, as far as it is fixed: `a.b` for `a.b`, `a` for `a[i].b` and for a bit of `a`. */
function pathOf(e: Expr, scope: Scope): { path: string; whole: boolean } | null {
  if (e.node === 'var') {
    if (e.ref || e.qualifier !== undefined) return null
    const key = scope.keyAt(e.pos.offset, e.name)
    return key === null ? null : { path: key.toUpperCase(), whole: true }
  }
  if (e.node === 'member') {
    const base = pathOf(e.obj, scope)
    return base && base.whole ? { path: `${base.path}.${e.field.toUpperCase()}`, whole: true } : base
  }
  if (e.node === 'index' || e.node === 'bit') {
    const base = pathOf(e.obj, scope)
    return base && { path: base.path, whole: false }
  }
  return null
}

/** The paths an expression reads, each with its prefixes: a write of `a` or of `a.b` changes what `a.b.c` reads. */
function readsOf(e: Expr, scope: Scope, out = new Set<string>()): Set<string> {
  const place = pathOf(e, scope)
  if (place) {
    const parts = place.path.split('.')
    for (let n = 1; n <= parts.length; n++) out.add(parts.slice(0, n).join('.'))
  }
  if (e.node === 'member' || e.node === 'bit') readsOf(e.obj, scope, out)
  else if (e.node === 'index') {
    readsOf(e.obj, scope, out)
    for (const ix of e.indices) readsOf(ix, scope, out)
  } else if (e.node === 'unary') readsOf(e.expr, scope, out)
  else if (e.node === 'binary') {
    readsOf(e.left, scope, out)
    readsOf(e.right, scope, out)
  }
  return out
}

/** Every write in some statements, at any depth and in source order: an assignment's target, a block called (its
 *  outputs change) and the places its outputs go to, a loop's variable. */
function eachWrite(stmts: readonly Stmt[], scope: Scope, found: (path: string, at: number) => void): void {
  const add = (e: Expr, at: number): void => {
    const place = pathOf(e, scope)
    if (place) found(place.path, at)
  }
  for (const s of stmts) {
    const at = s.pos.offset
    if (s.node === 'assign') add(s.target, at)
    else if (s.node === 'fbcall') {
      add(s.target, at)
      for (const a of s.args) if (a.out) add(a.value, at)
    } else if (s.node === 'if') {
      for (const b of s.branches) eachWrite(b.body, scope, found)
      if (s.elseBody) eachWrite(s.elseBody, scope, found)
    } else if (s.node === 'case') {
      for (const c of s.cases) eachWrite(c.body, scope, found)
      if (s.elseBody) eachWrite(s.elseBody, scope, found)
    } else if (s.node === 'for') {
      const key = scope.keyAt(at, s.varName)
      if (key !== null) found(key.toUpperCase(), at)
      eachWrite(s.body, scope, found)
    } else if (s.node === 'while' || s.node === 'repeat') eachWrite(s.body, scope, found)
  }
}

const COMPARE: Partial<Record<string, (a: number, b: number) => boolean>> = {
  '=': (a, b) => a === b,
  '<>': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
}

function compile(e: Expr, scope: Scope): Eval {
  switch (e.node) {
    case 'bool': {
      const v = e.value
      return () => v
    }
    case 'num': {
      // (a literal past 2^53 is not the number it reads as)
      if (e.big !== undefined) return UNKNOWN
      const v = e.value
      return () => v
    }
    case 'var': {
      if (e.qualifier !== undefined) {
        const v = scope.members.get(`${e.qualifier.toUpperCase()}#${e.name.toUpperCase()}`)
        return () => v
      }
      const key = placeKey(e, scope)
      if (!key) return UNKNOWN
      // a bare name with no value may be an enumeration member (`state = Running`)
      const member = scope.members.get(e.name.toUpperCase())
      return (read) => {
        const k = key(read)
        return k === null ? undefined : (read(k) ?? member)
      }
    }
    case 'member':
    case 'index': {
      const key = placeKey(e, scope)
      if (!key) return UNKNOWN
      return (read) => {
        const k = key(read)
        return k === null ? undefined : read(k)
      }
    }
    case 'bit': {
      const key = placeKey(e.obj, scope)
      if (!key) return UNKNOWN
      const bit = e.bit
      return (read) => {
        const k = key(read)
        return k === null ? undefined : watchBit(read(k), bit)
      }
    }
    case 'unary': {
      const inner = compile(e.expr, scope)
      const op = e.op
      return (read) => {
        const v = inner(read)
        if (op === 'NOT') return typeof v === 'boolean' ? !v : undefined
        if (typeof v !== 'number') return undefined
        return op === 'NEG' ? -v : v
      }
    }
    case 'binary': {
      const left = compile(e.left, scope)
      const right = compile(e.right, scope)
      const op = e.op
      if (op === 'AND' || op === 'OR' || op === 'XOR') {
        return (read) => {
          const a = left(read)
          const b = right(read)
          // one side settles AND and OR whatever the other is. On integers these are bitwise, which is left alone.
          if (op === 'AND' && (a === false || b === false)) return false
          if (op === 'OR' && (a === true || b === true)) return true
          if (typeof a !== 'boolean' || typeof b !== 'boolean') return undefined
          return op === 'AND' ? a && b : op === 'OR' ? a || b : a !== b
        }
      }
      const compare = COMPARE[op]
      if (!compare) return UNKNOWN
      return (read) => {
        const a = left(read)
        const b = right(read)
        if (typeof a === 'boolean' && typeof b === 'boolean') return op === '=' ? a === b : op === '<>' ? a !== b : undefined
        if (typeof a !== 'number' || typeof b !== 'number') return undefined
        const result = compare(a, b)
        // A REAL is held in 32 bits and a literal beside it is rounded to match, which the text alone does not say.
        // Where rounding would change the answer, there is none.
        if ((!Number.isInteger(a) || !Number.isInteger(b)) && compare(Math.fround(a), Math.fround(b)) !== result) return undefined
        return result
      }
    }
    default:
      return UNKNOWN
  }
}

function labelMatch(labels: readonly CaseLabel[], scope: Scope): (v: number) => boolean | undefined {
  const tests = labels.map((l): ((v: number) => boolean | undefined) => {
    if (l.kind === 'single') return (v) => v === l.value
    if (l.kind === 'range') return (v) => v >= l.lo && v <= l.hi
    const value = scope.members.get(l.qualifier !== undefined ? `${l.qualifier.toUpperCase()}#${l.name.toUpperCase()}` : l.name.toUpperCase())
    return (v) => (value === undefined ? undefined : v === value)
  })
  return (v) => {
    let unknown = false
    for (const test of tests) {
      const hit = test(v)
      if (hit) return true
      if (hit === undefined) unknown = true
    }
    return unknown ? undefined : false
  }
}

/** One body's statements. `elsewhere` says whether another body writes a variable. */
function bodyOf(stmts: readonly Stmt[], scope: Scope, elsewhere: (path: string) => boolean): Node[] {
  // each variable's writes in source order, with the arm each is written in (null: it runs on every scan)
  const sites = new Map<string, { at: number; owner: ArmRef | null }[]>()
  // Set before the statement and written again at or after it: the image holds the later value. One of the two
  // writes may be another body's, whose place in the scan the text does not say.
  const contestOf = (reads: Iterable<string>, start: number): true | ArmRef[] | null => {
    const owners: ArmRef[] = []
    for (const r of reads) {
      const written = sites.get(r) ?? []
      const after = written.length > 0 && written[written.length - 1]!.at >= start
      const other = elsewhere(r)
      if (other && after) return true
      if (!(after || other)) continue
      for (const w of written) {
        if (w.at >= start) break
        if (!w.owner) return true
        owners.push(w.owner)
      }
    }
    return owners.length > 0 ? owners : null
  }
  // (asked only once the body is read, so every write is in `sites`)
  const cond = (e: Expr, start: number): Cond => {
    let made: ReturnType<Cond> | null = null
    return () => (made ??= { cond: compile(e, scope), contest: contestOf(readsOf(e, scope), start) })
  }
  const walk = (list: readonly Stmt[], owner: ArmRef | null): Node[] => {
    const out: Node[] = []
    for (const s of list) {
      const start = s.pos.offset
      const base = { start, end: start, parent: owner, arms: [], rest: null }
      let node: Node | null = null
      let bodies: { body: Stmt[]; span: SourceSpan }[] = []
      // (a statement lowered from a rung has no ranges, and a loop's condition differs on each pass: both are only
      // the writes inside them)
      if (s.node === 'if' && s.branches.every((b) => b.span) && (!s.elseBody || s.elseSpan)) {
        node = { ...base, kind: 'if', conds: s.branches.map((b) => cond(b.cond, start)) }
        bodies = s.branches.map((b) => ({ body: b.body, span: b.span! }))
      } else if (s.node === 'case' && s.cases.every((c) => c.span) && (!s.elseBody || s.elseSpan)) {
        node = { ...base, kind: 'case', selector: cond(s.selector, start), matches: s.cases.map((c) => labelMatch(c.labels, scope)) }
        bodies = s.cases.map((c) => ({ body: c.body, span: c.span! }))
      }
      if (!node || (s.node !== 'if' && s.node !== 'case')) {
        eachWrite([s], scope, (path, at) => {
          const list = sites.get(path)
          if (list) list.push({ at, owner })
          else sites.set(path, [{ at, owner }])
        })
        continue
      }
      const made = node
      made.arms = bodies.map((b, i) => ({ span: b.span, inner: walk(b.body, { node: made, arm: i }) }))
      if (s.elseBody) made.rest = { span: s.elseSpan!, inner: walk(s.elseBody, { node: made, arm: bodies.length }) }
      made.end = (made.rest ?? made.arms[made.arms.length - 1]!).span.to
      out.push(made)
    }
    return out
  }
  return walk(stmts, null)
}

/** The plan of a parsed text: the code outside every POU and each PROGRAM's body. `keyAt` is the text's watch scopes'. */
export function branchPlan(ast: Ast, keyAt: (offset: number, name: string) => string | null): BranchPlan {
  // (a name is asked about several times: as a write, as a read, and to evaluate it)
  const keys = new Map<number, string | null>()
  const scope: Scope = {
    keyAt: (offset, name) => {
      let key = keys.get(offset)
      if (key === undefined) keys.set(offset, (key = keyAt(offset, name)))
      return key
    },
    members: enumMembers(ast),
  }
  const marked = [ast.body, ...ast.programDefs.map((p) => p.body)]
  // the blocks and functions are not marked, but what they write is a write from somewhere else
  const others = [...ast.fbDefs.flatMap((b) => [b.body, ...(b.methods ?? []).map((m) => m.body)]), ...ast.funcDefs.map((f) => f.body)]
  const writes = [...marked, ...others].map((body) => {
    const paths = new Set<string>()
    eachWrite(body, scope, (path) => paths.add(path))
    return paths
  })
  const writers = new Map<string, number>()
  for (const paths of writes) for (const p of paths) writers.set(p, (writers.get(p) ?? 0) + 1)
  return { bodies: marked.map((body, i) => bodyOf(body, scope, (path) => (writers.get(path) ?? 0) > (writes[i]!.has(path) ? 1 : 0))) }
}

/** How long a chain of statements, each waiting on an earlier one, is followed before the answer is "not known". */
const CHAIN = 200

/**
 * The arms not taken under these values that reach into `from`..`to` of the text, outermost only: nothing inside a
 * skipped arm is listed again.
 */
export function untakenSpans(plan: BranchPlan, read: ReadValue, from = 0, to = Infinity): SourceSpan[] {
  // which arms of a statement are ruled out, worked out once per call
  const known = new Map<Node, boolean[]>()
  const running = (ref: ArmRef, depth: number): boolean => {
    for (let a: ArmRef | null = ref; a; a = a.node.parent) if (skipped(a.node, depth)[a.arm]) return false
    return true
  }
  const judged = (c: Cond, depth: number): Known => {
    const { cond, contest } = c()
    if (contest === true) return undefined
    if (contest && (depth >= CHAIN || contest.some((ref) => running(ref, depth + 1)))) return undefined
    return cond(read)
  }
  const skipped = (n: Node, depth: number): boolean[] => {
    const had = known.get(n)
    if (had) return had
    const out = new Array<boolean>(n.arms.length + 1).fill(false)
    if (n.kind === 'if') {
      // An arm runs when every condition before it is false and its own is true. So a false condition rules its arm
      // out, and a true one rules out every arm after it, whatever the conditions before it are.
      let settled = false
      n.conds.forEach((c, i) => {
        const v = settled ? false : judged(c, depth)
        if (v === false) out[i] = true
        else if (v === true) settled = true
      })
      out[n.arms.length] = settled
    } else {
      const v = judged(n.selector, depth)
      if (typeof v === 'number') {
        const hits = n.matches.map((m) => m(v))
        const taken = hits.indexOf(true)
        hits.forEach((hit, i) => {
          out[i] = hit === false || (taken >= 0 && i !== taken && hit === true)
        })
        out[n.arms.length] = taken >= 0
      }
    }
    known.set(n, out)
    return out
  }
  const spans: SourceSpan[] = []
  const visit = (nodes: readonly Node[]): void => {
    for (const n of nodes) {
      if (n.end <= from) continue
      if (n.start >= to) break
      const out = skipped(n, 0)
      const arm = (a: Arm, i: number): void => {
        if (!out[i]) visit(a.inner)
        else if (a.span.to > a.span.from && a.span.from < to && a.span.to > from) spans.push(a.span)
      }
      n.arms.forEach(arm)
      if (n.rest) arm(n.rest, n.arms.length)
    }
  }
  for (const nodes of plan.bodies) visit(nodes)
  return spans
}
