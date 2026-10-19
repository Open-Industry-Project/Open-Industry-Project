// Conformance golden-test suite for the ST engine - the "anchor to the spec" pass.
//
// The corpus itself lives in ./conformanceCases (shared, so the external MATIEC oracle in
// scripts/oracle-matiec.mjs replays the exact same cases). This file is the in-process
// half of the checking, and it does two jobs:
//
//  1. GOLDEN. Every expected value in the corpus is hand-derived from IEC 61131-3 or
//     documented vendor behavior, not from running our own engine - so the suite anchors
//     the engine to the standard instead of to itself. Deliberate departures carry a
//     `divergence` note on the case; the corpus module is the ledger of them.
//
//  2. DIFFERENTIAL. Every case executes through both backends - the AST interpreter (the
//     production path) and the ST->TS emitter's output - and after every scan the full
//     top-level scalar image of the two is compared. This mechanically enforces the
//     emitter's "shown == executed" promise. (The emitted code runs via `new Function`,
//     which is fine in this node test env. The app never runs this code: what it runs is
//     scanCodegen.ts, held to the AST walker by scanEngines.test.ts.)
//
// Emitted-code caveats (deliberate - it is a display/export artifact): it checks array
// bounds (elemAt / elemSet) and caps loops (loopGuard), but throws a plain Error with no
// source position, and logs no minor faults; the
// interpreter's positioned faults are covered in plc.test.ts. Division/MOD by zero throws
// in both backends and is exercised differentially here.

import { describe, expect, it } from 'vitest'
import type { Case } from './conformanceCases'
import { CONFORMANCE_CASES, CONFORMANCE_GROUPS } from './conformanceCases'
import { toTypeScript } from './emit'
import { compile } from './interpreter'
import * as rt from './runtime'
import { BUILTIN_RUNTIME_HELPERS } from './builtins'
import { TaskScheduler } from './scanEngine'
import type { TagValue, TaskInfo } from './types'

/** Every runtime helper the emitted module may reference: the four it always imports, plus
 *  the standard-library helpers and the clock step the emitter pulls in on demand. */
const HELPERS: readonly string[] = ['wrap', 'idiv', 'imod', 'makeFb', ...BUILTIN_RUNTIME_HELPERS, 'nsOf', 'andB', 'orB', 'elemAt', 'elemSet', 'loopGuard', 'forStep', 'inRange', 'refGet', 'refSet', 'refElem', 'itfGet']

/** Compile a program's emitted TypeScript into a runnable {S, scan} pair. `read` resolves a
 *  name the way the interpreter's watch table does: POU locals first, then the emitted
 *  module's VAR_GLOBAL object, which lives outside S exactly as it does in the interpreter. */
function compileEmitted(src: string): {
  G: Record<string, TagValue>
  tasks: TaskInfo[]
  read: (k: string) => TagValue | undefined
  write: (k: string, v: TagValue) => void
  scan: (dt: number) => void
  scanTask: (index: number, dt: number) => void
} {
  const body = toTypeScript(src)
    .replace(/^import[^\n]*\n/, '') // the './runtime' import - helpers are passed in instead
    .replace(/^export (function|const)/gm, '$1')
  // driven off the emitter's own helper list, so a new builtin helper (the string library
  // was one) can never be emitted here without being passed in
  const factory = new Function(
    ...HELPERS,
    `'use strict';\n${body}\nreturn { init, scan, G: typeof G === 'undefined' ? {} : G, tasks: typeof tasks === 'undefined' ? [] : tasks, scanTask: typeof scanTask === 'undefined' ? undefined : scanTask };`,
  )
  const mod = factory(...HELPERS.map((h) => (rt as unknown as Record<string, unknown>)[h])) as {
    init(S: object): void
    scan(S: object, dt: number): void
    scanTask?: (S: object, index: number, dt: number) => void
    G: Record<string, TagValue>
    tasks: TaskInfo[]
  }
  const S: Record<string, unknown> = {}
  mod.init(S)
  // a CONFIGURATION's instance variables are addressed `Instance.Name`, which on the emitted image is
  // a property path: S.Instance.Name
  const holder = (k: string): [Record<string, unknown>, string] => {
    const dot = k.indexOf('.')
    return dot < 0 ? [k in S ? S : mod.G, k] : [S[k.slice(0, dot)] as Record<string, unknown>, k.slice(dot + 1)]
  }
  return {
    G: mod.G,
    tasks: mod.tasks,
    read: (k) => {
      const [obj, name] = holder(k)
      return obj?.[name] as TagValue | undefined
    },
    write: (k, v) => {
      const [obj, name] = holder(k)
      obj[name] = v
    },
    scan: (dt) => mod.scan(S, dt),
    scanTask: (index, dt) => mod.scanTask!(S, index, dt),
  }
}

/** Run one case through both backends, asserting goldens and inter-backend agreement. */
function runCase(c: Case): void {
  if (c.rejects) {
    // both front-ends share the checker, so both must refuse it for the same reason
    expect(() => compile(c.src), `${c.name}: interpreter accepted it`).toThrow(c.rejects)
    expect(() => compileEmitted(c.src), `${c.name}: emitter accepted it`).toThrow(c.rejects)
    return
  }
  const p = compile(c.src)
  const em = compileEmitted(c.src)
  // A CONFIGURATION's tasks each scan on their own interval. Both backends then run under the
  // scheduler the live sim uses, and a step's `dt` is the time that passes rather than one scan.
  expect(em.tasks, `${c.name}: task tables differ`).toEqual(p.tasks)
  const scheduled = p.tasks.length > 0
  const pSched = new TaskScheduler({ tasks: p.tasks, tick: (dt) => p.scan(dt), tickTask: (i, dt) => p.scanTask(i, dt) }, { maxCatchUp: 64 })
  const emSched = new TaskScheduler({ tasks: em.tasks, tick: (dt) => em.scan(dt), tickTask: (i, dt) => em.scanTask(i, dt) }, { maxCatchUp: 64 })
  const runP = (dt: number): void => void (scheduled ? pSched.advance(dt) : p.scan(dt))
  const runEm = (dt: number): void => void (scheduled ? emSched.advance(dt) : em.scan(dt))
  const instances = new Set(p.tasks.flatMap((t) => t.programs.map((n) => n.toUpperCase())))
  for (const step of c.steps) {
    for (const [k, v] of Object.entries(step.in ?? {})) {
      p.setInput(k, v)
      em.write(k, v) // corpus inputs are in-range, so no coercion is needed on the raw image
    }
    const dt = step.dt ?? 0.1
    if (step.throws) {
      expect(() => runP(dt), `${c.name}: interpreter fault`).toThrow(step.throws)
      expect(() => runEm(dt), `${c.name}: emitted fault`).toThrow(step.throws)
      return // the scan is torn mid-statement; nothing after a fault is comparable
    }
    runP(dt)
    runEm(dt)
    for (const [k, v] of Object.entries(step.expect ?? {})) {
      expect(p.get(k), `${c.name}: interpreter ${k}`).toBe(v)
      expect(em.read(k), `${c.name}: emitted ${k}`).toBe(v)
    }
    // `close` values land in REAL variables, which are single precision (~7 significant
    // digits) - so compare at a relative f32 tolerance rather than an absolute f64 one.
    // Asserting tighter than f32 would be asserting we beat the hardware.
    for (const [k, v] of Object.entries(step.close ?? {})) {
      const tol = 1e-6 * Math.max(1, Math.abs(v))
      expect(p.get(k) as number, `${c.name}: interpreter ${k}`).toBeCloseTo(v, -Math.log10(tol))
      expect(em.read(k) as number, `${c.name}: emitted ${k}`).toBeCloseTo(v, -Math.log10(tol))
    }
    // drift net: every top-level scalar must agree between the two backends, golden or not
    for (const [k, v] of Object.entries(p.watch)) {
      // FB members live as nested objects on the emitted image; an instance's own variables are
      // one property down, which `read` follows
      const dots = k.split('.').length - 1
      if (k.includes('[')) continue // an array element (`A[3]`): the watch table's spelling, not a variable `read` knows
      if (dots > 1 || (dots === 1 && !instances.has(k.slice(0, k.indexOf('.')).toUpperCase()))) continue
      expect(Object.is(em.read(k), v), `${c.name}: backend drift on '${k}' (interpreter ${String(v)}, emitted ${String(em.read(k))})`).toBe(true)
    }
  }
}

describe('conformance corpus is well-formed', () => {
  it('gives every case a unique name (the oracle keys its report by them)', () => {
    const names = CONFORMANCE_CASES.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('says out loud why a case is withheld from, or inverted for, the external oracle', () => {
    for (const c of CONFORMANCE_CASES) {
      if (c.oracle) {
        const note = c.oracle.skip ?? c.oracle.editionReject
        expect(note, `${c.name}: an oracle annotation must say which kind it is`).toBeDefined()
        expect(note!.length, `${c.name}: empty oracle reason`).toBeGreaterThan(20)
      }
      if (c.divergence) expect(c.divergence.length, `${c.name}: empty divergence note`).toBeGreaterThan(20)
    }
  })

  it('keeps the externally-checkable majority actually checkable', () => {
    // A corpus that quietly drifts into "everything is skipped" would still be green while
    // proving nothing against a real toolchain. Most cases must reach the oracle.
    const checkable = CONFORMANCE_CASES.filter((c) => !c.oracle)
    expect(checkable.length).toBeGreaterThan(CONFORMANCE_CASES.length / 2)
  })
})

for (const group of CONFORMANCE_GROUPS) {
  describe(`conformance: ${group.title}`, () => {
    for (const c of group.cases) it(c.name, () => runCase(c))
  })
}
