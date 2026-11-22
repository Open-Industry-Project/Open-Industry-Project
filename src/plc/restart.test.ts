// A compiled program restarts as it was compiled (CompiledProgram.restart; typed/pou.ts rewind).
//
// The typed engine keeps nearly everything a program remembers in its arena, and a restart copies the arena back.
// What it keeps outside the arena (a motion kernel's plan, the method stack's top, each task's clock) is put back by
// hand, so a new piece of such state is forgotten silently unless something checks. This does: every program of the
// conformance corpus is run, written to at random, restarted, and run again, and the second run must be the run a
// newly compiled program makes, scan for scan and variable for variable.
//
// The clocks are the one part nothing here can see. A timer and a motion kernel keep the reading they started at and
// take the difference, so a clock that was not put back gives the same values. It is put back all the same.

import { describe, expect, it } from 'vitest'
import { CONFORMANCE_CASES } from './conformanceCases'
import { compile, typedRefusals } from './interpreter'
import { TaskScheduler } from './scanEngine'
import { randomWrites, seeded, type OracleStep } from './scanEngineOracle'
import type { CompiledProgram, TagValue } from './types'

const hash = (s: string): number => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7)

/** Everything the program holds, as text: a NaN and a negative zero are told from a null and a zero. */
const held = (p: CompiledProgram): string =>
  Object.entries(p.deepMemory)
    .map(([k, v]) => `${k}=${Object.is(v, -0) ? '-0' : String(v)}`)
    .join('\n')

/** One scan per step, as a host makes them: a scheduler for a program with tasks, built anew for each run. */
function runner(p: CompiledProgram): (dt: number) => void {
  if (p.tasks.length === 0) return (dt) => p.scan(dt)
  const sched = new TaskScheduler({ tasks: p.tasks, tick: (dt) => p.scan(dt), tickTask: (i, dt) => p.scanTask(i, dt) }, { maxCatchUp: 64 })
  return (dt) => void sched.advance(dt)
}

/** What the program holds after each step, or the fault a step ended in (the run stops there). */
function trace(p: CompiledProgram, steps: readonly OracleStep[], between?: ReturnType<typeof randomWrites>): string[] {
  const run = runner(p)
  const out: string[] = []
  for (let i = 0; i < steps.length; i++) {
    for (const [k, v] of Object.entries(steps[i]!.in ?? {})) p.setInput(k, v)
    try {
      run(steps[i]!.dt)
    } catch (e) {
      out.push(`fault: ${e instanceof Error ? e.message : String(e)}`)
      break
    }
    out.push(held(p))
    if (between) {
      const memory = p.memory
      for (const [k, v] of Object.entries(between(i, Object.keys(memory), memory))) p.setInput(k, v as TagValue)
    }
  }
  return out
}

/** Run `src`, disturb it, restart it, and hold it to a newly compiled program. The differences, worded. */
function restartDiffs(name: string, src: string, steps: readonly OracleStep[]): string[] {
  const fresh = compile(src)
  const p = compile(src)
  if (!p.restart) return [`${name}: no restart (not on the typed engine)`]
  const built = held(p)
  const want = trace(fresh, steps)
  // its own steps and six more, with variables overwritten between scans: state the restart has to undo
  trace(p, [...steps, ...Array.from({ length: 6 }, () => ({ dt: 0.1 }))], randomWrites(seeded(hash(name)), 4))
  p.restart()
  const diffs: string[] = []
  if (held(p) !== built) diffs.push(`${name}: after a restart it does not hold what it held when compiled`)
  const got = trace(p, steps)
  const at = want.findIndex((w, i) => w !== got[i])
  if (at >= 0 || got.length !== want.length) diffs.push(`${name}: scan ${at < 0 ? want.length : at} after a restart is not a new program's`)
  return diffs
}

const MV = 'Velocity := 20, Acceleration := 100, Deceleration := 100'

describe('a restarted program is the program as compiled', () => {
  it('every case of the conformance corpus', () => {
    const cases = CONFORMANCE_CASES.filter((c) => !c.rejects)
    const diffs = cases.flatMap((c) => restartDiffs(c.name, c.src, c.steps.map((s) => ({ in: s.in, dt: s.dt ?? 0.1 }))))
    expect(diffs).toEqual([])
    expect(cases.length).toBeGreaterThan(150) // not vacuous: the corpus really was run
    expect(typedRefusals).toEqual([])
  })

  it('a timer part-way through its time starts again from nothing', () => {
    const src = `VAR
  Go : BOOL;
  T : TON;
  Done : BOOL;
END_VAR
T(IN := Go, PT := T#450MS);
Done := T.Q;`
    const steps: OracleStep[] = Array.from({ length: 8 }, () => ({ in: { Go: true }, dt: 0.1 }))
    expect(restartDiffs('timer', src, steps)).toEqual([])
    // and the time itself, not only agreement with a second program: 450 ms is five scans of 100 ms after the first
    const p = compile(src)
    trace(p, steps.slice(0, 3))
    p.restart!()
    const after = trace(p, steps).map((m) => /Done=true/.test(m))
    expect(after.indexOf(true)).toBe(5)
  })

  it('timers on two tasks of different intervals start again from nothing', () => {
    const src = `PROGRAM Lane
VAR
  Go : BOOL;
  T : TON;
  N : DINT;
END_VAR
T(IN := Go, PT := T#300MS);
IF T.Q THEN N := N + 1; END_IF;
END_PROGRAM
CONFIGURATION C
  RESOURCE R ON PLC
    TASK Fast (INTERVAL := T#20MS, PRIORITY := 1);
    TASK Slow (INTERVAL := T#100MS, PRIORITY := 2);
    PROGRAM A WITH Fast : Lane;
    PROGRAM B WITH Slow : Lane;
  END_RESOURCE
END_CONFIGURATION`
    const steps: OracleStep[] = Array.from({ length: 12 }, () => ({ in: { 'A.Go': true, 'B.Go': true }, dt: 0.05 }))
    expect(restartDiffs('tasks', src, steps)).toEqual([])
  })

  it('a motion kernel: an axis part-way through a move is at rest and unpowered again', () => {
    const src = `VAR
  AX : AXIS_REF;
  pwr : MC_Power;
  mv : MC_MoveAbsolute;
  cyc : INT;
END_VAR
pwr(Axis := AX, Enable := TRUE);
mv(Axis := AX, Execute := pwr.Status, Position := 10, ${MV});
cyc := cyc + 1;`
    const steps: OracleStep[] = Array.from({ length: 40 }, () => ({ dt: 0.01 }))
    expect(restartDiffs('motion', src, steps)).toEqual([])
  })

  it('a fault part-way through a scan: the scans after a restart are a new program\'s', () => {
    const src = `VAR
  I : INT;
  A : ARRAY[0..3] OF INT;
  N : DINT;
END_VAR
N := N + 1;
A[I] := 1;
I := I + 1;`
    const steps: OracleStep[] = Array.from({ length: 7 }, () => ({ dt: 0.1 }))
    const p = compile(src)
    const first = trace(p, steps)
    expect(first.at(-1)).toMatch(/^fault: /)
    p.restart!()
    expect(trace(p, steps)).toEqual(first)
  })
})
