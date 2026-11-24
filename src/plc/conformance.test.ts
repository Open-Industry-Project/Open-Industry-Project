// Conformance golden-test suite for the ST engine - the "anchor to the spec" pass.
//
// The corpus itself lives in ./conformanceCases (shared, so the external MATIEC oracle in
// scripts/oracle-matiec.mjs replays the exact same cases). This file is the in-process
// half of the checking: every expected value in the corpus is hand-derived from IEC 61131-3, or from the engine's
// own documented rule where IEC leaves a choice open, never from running our own engine, so the suite anchors the
// engine to the standard instead of to itself. Deliberate departures carry a `divergence` note on the case; the
// corpus module is the ledger of them.
//
// Each case is held to its goldens on both scan engines: the typed one every program runs on, and the AST walker,
// its reference (interpreter.ts). scanEngines.test.ts holds the two to each other as well, on everything each holds
// after every scan, golden or not.

import { describe, expect, it } from 'vitest'
import type { Case } from './conformanceCases'
import { CONFORMANCE_CASES, CONFORMANCE_GROUPS } from './conformanceCases'
import { compile, setScanEngine, type ScanEngine } from './interpreter'
import { TaskScheduler } from './scanEngine'
import type { CompiledProgram } from './types'

function build(engine: ScanEngine, src: string): CompiledProgram {
  const was = setScanEngine(engine)
  try {
    return compile(src)
  } finally {
    setScanEngine(was)
  }
}

/** Run one case on one engine, asserting its goldens. */
function runOn(engine: ScanEngine, c: Case): void {
  if (c.rejects) {
    expect(() => build(engine, c.src), `${c.name}: ${engine} accepted it`).toThrow(c.rejects)
    return
  }
  const p = build(engine, c.src)
  // A CONFIGURATION's tasks each scan on their own interval, under the scheduler the live sim uses, and a step's
  // `dt` is then the time that passes rather than one scan.
  const sched = p.tasks.length > 0 ? new TaskScheduler({ tasks: p.tasks, tick: (dt) => p.scan(dt), tickTask: (i, dt) => p.scanTask(i, dt) }, { maxCatchUp: 64 }) : null
  const run = (dt: number): void => void (sched ? sched.advance(dt) : p.scan(dt))
  for (const step of c.steps) {
    for (const [k, v] of Object.entries(step.in ?? {})) p.setInput(k, v)
    const dt = step.dt ?? 0.1
    if (step.throws) {
      expect(() => run(dt), `${c.name}: ${engine} fault`).toThrow(step.throws)
      return // the scan is torn mid-statement; nothing after a fault is comparable
    }
    run(dt)
    for (const [k, v] of Object.entries(step.expect ?? {})) expect(p.get(k), `${c.name}: ${engine} ${k}`).toBe(v)
    // `close` values land in REAL variables, which are single precision (~7 significant
    // digits) - so compare at a relative f32 tolerance rather than an absolute f64 one.
    // Asserting tighter than f32 would be asserting we beat the hardware.
    for (const [k, v] of Object.entries(step.close ?? {})) {
      const tol = 1e-6 * Math.max(1, Math.abs(v))
      expect(p.get(k) as number, `${c.name}: ${engine} ${k}`).toBeCloseTo(v, -Math.log10(tol))
    }
  }
}

/** Run one case on both engines. */
function runCase(c: Case): void {
  runOn('typed', c)
  runOn('walker', c)
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
