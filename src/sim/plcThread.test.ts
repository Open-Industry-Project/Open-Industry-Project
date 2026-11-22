import { describe, expect, it } from 'vitest'
import { PlcGroup } from './plcGroup'
import type { PlcWorldPort } from './plcHost'
import { PlcThread, PlcThreadFault, plcThreadWanted, type PlcThreadTransport } from './plcThread'
import { PlcThreadServer, statsOf } from './plcThreadServer'
import { Ctl, newPlcThreadMemory, TagReader, TagWriter } from './plcThreadWire'

// The controller on a worker of its own, with both ends on this thread: the transport answers an ask on the spot,
// where the worker's would wake the other thread. What is tested is the hand-over, which is all that differs from
// a PlcGroup stepped here.

const PROGRAM = `
PROGRAM Main
VAR_INPUT Eye : BOOL; Speed : REAL; END_VAR
VAR_OUTPUT Run : BOOL; Count : DINT; Ratio : REAL; END_VAR
VAR was : BOOL; t : TON; END_VAR
IF Eye AND NOT was THEN Count := Count + 1; END_IF;
was := Eye;
t(IN := Eye, PT := T#30ms);
Run := t.Q;
Ratio := Speed / 2.0;
END_PROGRAM
`
const RUNS = [{ controller: null, source: PROGRAM, periodSec: 0.01 }]

/** A world as the controller sees one: tags the parts wrote, tags handed back, a step count. */
class StubWorld implements PlcWorldPort {
  stepCount = 0
  writes: Record<string, number | boolean> = {}
  handed: Record<string, number | boolean>[] = []
  behaviorTagWrites(): Record<string, number | boolean> {
    return this.writes
  }
  setBehaviorInputTags(tags: Record<string, number | boolean>): void {
    this.handed.push({ ...tags })
  }
}

/** what the parts write on step `i`: an eye that blinks, a speed that moves */
const writesAt = (i: number): Record<string, number | boolean> => ({ Eye: i % 7 < 4, Speed: i * 0.25 })

function threaded(runs = RUNS): { thread: PlcThread; group: PlcGroup; asks: () => number } {
  const memory = newPlcThreadMemory()
  const group = new PlcGroup(runs)
  const server = new PlcThreadServer(group, memory)
  const ctl = new Int32Array(memory.ctl)
  let asks = 0
  const transport: PlcThreadTransport = {
    wake: () => {
      asks++
      server.serve()
      ctl[Ctl.Ask] = 0
      ctl[Ctl.Done] = 1
    },
    wait: () => ctl[Ctl.Done] === 1,
    stop: () => {},
  }
  const plan = group.watchPlan()!
  const thread = new PlcThread(memory, transport, { memory: plan.memory as unknown as SharedArrayBuffer, layout: plan.layout, stats: statsOf(group) })
  return { thread, group, asks: () => asks }
}

/** `steps` steps the usual way: the scans, then the step */
function runHere(steps: number): StubWorld {
  const world = new StubWorld()
  const group = new PlcGroup(RUNS)
  for (let i = 0; i < steps; i++) {
    group.interleave(world, 0.01)
    world.writes = writesAt(i) // the parts of step i
    world.stepCount++
  }
  group.interleave(world, 0.01)
  return world
}

describe('the controller on a worker of its own', () => {
  it('hands the world what a controller on this thread hands it, step for step', () => {
    const here = runHere(40)
    const world = new StubWorld()
    const { thread } = threaded()
    for (let i = 0; i < 40; i++) {
      thread.beforeStep(world, 0.01)
      world.writes = writesAt(i)
      thread.afterParts(world, 0.01) // asked for once the parts have run, before the step is counted
      world.stepCount++
    }
    thread.beforeStep(world, 0.01)
    expect(world.handed).toEqual(here.handed)
    expect(world.handed.length).toBeGreaterThan(5)
  })

  it('scans on its own turn when nothing was asked ahead: a Step while paused', () => {
    const here = runHere(40)
    const world = new StubWorld()
    const { thread } = threaded()
    for (let i = 0; i < 40; i++) {
      thread.beforeStep(world, 0.01) // no afterParts: the scan is made here
      world.writes = writesAt(i)
      world.stepCount++
    }
    thread.beforeStep(world, 0.01)
    expect(world.handed).toEqual(here.handed)
  })

  it('scans a step once, though a frame or a command collects its answer early', () => {
    const here = runHere(40)
    const world = new StubWorld()
    const { thread, group } = threaded()
    for (let i = 0; i < 40; i++) {
      thread.beforeStep(world, 0.01)
      world.writes = writesAt(i)
      thread.afterParts(world, 0.01)
      // between the parts and the next step: a frame takes the watch table, the page resets the scan times
      if (i % 3 === 0) thread.watchBytes()
      if (i % 5 === 0) thread.resetScanTimes()
      world.stepCount++
    }
    thread.beforeStep(world, 0.01)
    expect(world.handed).toEqual(here.handed)
    // 40 steps of 10 ms on a 10 ms scan: the first step is not scanned for, and each one after it once
    expect(group.perf.scans).toBe(40)
  })

  it('takes the parts\' writes one at a time where the world gives them so, a later write of a tag winning', () => {
    const { thread, group } = threaded()
    const world = Object.assign(new StubWorld(), {
      eachBehaviorTagWrite(put: (name: string, value: number | boolean) => void): void {
        put('Speed', 1)
        put('Eye', true)
        put('Speed', 8) // a second part writes the same tag
      },
    })
    world.stepCount = 1
    thread.beforeStep(world, 0.01)
    expect(group.snapshot().watch.Ratio).toBe(4)
    expect(group.snapshot().watch.Count).toBe(1)
  })

  it('makes no scan before the first step, as a controller here makes none', () => {
    const world = new StubWorld()
    const { thread, asks } = threaded()
    thread.beforeStep(world, 0.01)
    expect(asks()).toBe(0)
    expect(world.handed).toEqual([])
  })

  it('carries a NaN, an infinity and a negative zero as they are', () => {
    const memory = newPlcThreadMemory()
    const ctl = new Int32Array(memory.ctl)
    const w = new TagWriter(memory.inputs, ctl, Ctl.InCount, Ctl.InNameBytes)
    const r = new TagReader(memory.inputs, ctl, Ctl.InCount, Ctl.InNameBytes)
    w.write({ a: NaN, b: -Infinity, c: -0, on: true, off: false, 'Cell2::%IX0.0': 1.5, 'Größe': 2 })
    const got = r.read()
    expect(Object.is(got.a, NaN) && Object.is(got.c, -0)).toBe(true)
    expect(got).toEqual({ a: NaN, b: -Infinity, c: -0, on: true, off: false, 'Cell2::%IX0.0': 1.5, 'Größe': 2 })
    // a tag written before and not now is absent, and one new to the table joins it
    w.write({ on: false, late: 7 })
    expect(r.read()).toEqual({ on: false, late: 7 })
  })

  it('keeps one table up to date in place for a reader that holds none between asks', () => {
    const memory = newPlcThreadMemory()
    const ctl = new Int32Array(memory.ctl)
    const w = new TagWriter(memory.inputs, ctl, Ctl.InCount, Ctl.InNameBytes)
    const r = new TagReader(memory.inputs, ctl, Ctl.InCount, Ctl.InNameBytes)
    w.write({ a: 0, b: true, c: NaN })
    const kept = r.update()
    expect(kept).toEqual({ a: 0, b: true, c: NaN })
    // the same tags in another order, one changed, one a zero turned negative, one gone, one new
    w.write({ c: NaN, a: -0, d: 4 })
    expect(r.update()).toBe(kept)
    expect(Object.is(kept.a, -0)).toBe(true)
    expect(kept).toEqual({ a: -0, c: NaN, d: 4 })
    w.write({ b: false, a: -0, c: 1, d: 4 })
    expect(r.update()).toEqual({ a: -0, b: false, c: 1, d: 4 })
  })

  it('carries a force, a write and a scan-time change to the programs, in the order they were given', () => {
    const world = new StubWorld()
    const { thread, group } = threaded()
    world.stepCount = 1
    thread.setForces({ Count: 41 })
    thread.beforeStep(world, 0.01)
    expect(group.snapshot().watch.Count).toBe(41)
    thread.setForces({})
    thread.write({ Count: 5 })
    thread.setPeriod(0.02)
    thread.beforeStep(world, 0.01)
    expect(group.snapshot().watch.Count).toBe(5)
    expect(group.scanTimes()[0]!.periodSec).toBe(0.02)
  })

  it('reports a scan fault as its message and place, on the step that would have used the scan', () => {
    const faulting = [{ controller: null, source: 'PROGRAM Main VAR_INPUT i : INT; END_VAR VAR a : ARRAY[0..3] OF INT; END_VAR a[i] := 1; END_PROGRAM', periodSec: 0.01 }]
    const world = new StubWorld()
    const { thread } = threaded(faulting)
    world.stepCount = 1
    world.writes = { i: 9 }
    thread.afterParts(world, 0.01)
    world.stepCount++
    let fault: unknown = null
    try {
      thread.beforeStep(world, 0.01)
    } catch (err) {
      fault = err
    }
    expect(fault).toBeInstanceOf(PlcThreadFault)
    expect((fault as PlcThreadFault).fault.message).toMatch(/out of bounds/)
    expect((fault as PlcThreadFault).fault.line).toBe(1)
  })

  it('shows a frame the inputs the last scan read, its outputs, and the scan counts', () => {
    const world = new StubWorld()
    const { thread } = threaded()
    world.stepCount = 1
    world.writes = { Eye: true, Speed: 3 }
    thread.afterParts(world, 0.01)
    world.stepCount++
    thread.beforeStep(world, 0.01)
    const shot = thread.snapshot()
    expect(shot.inputs).toEqual({ Eye: true, Speed: 3 })
    expect(shot.outputs).toMatchObject({ Count: 1, Ratio: 1.5 })
    expect(thread.perf.scans).toBe(1)
    expect(thread.watchBytes().byteLength).toBe(thread.watchPlan().memory.byteLength)
  })

  it('is used for one default controller of any size, where memory can be shared', () => {
    const big = [{ controller: null, source: 'x'.repeat(300_000) }]
    const isolated = globalThis.crossOriginIsolated
    try {
      Object.defineProperty(globalThis, 'crossOriginIsolated', { value: true, configurable: true })
      Object.defineProperty(globalThis, 'Worker', { value: globalThis.Worker ?? class {}, configurable: true })
      expect(plcThreadWanted(big, 'auto')).toBe(true)
      expect(plcThreadWanted(RUNS, 'auto')).toBe(true)
      expect(plcThreadWanted(RUNS, 'on')).toBe(true)
      expect(plcThreadWanted(big, 'off')).toBe(false)
      expect(plcThreadWanted([...big, { controller: 'Cell2', source: '' }], 'on')).toBe(false)
      expect(plcThreadWanted([{ controller: 'Cell2', source: 'x'.repeat(300_000) }], 'on')).toBe(false)
      Object.defineProperty(globalThis, 'crossOriginIsolated', { value: false, configurable: true })
      expect(plcThreadWanted(big, 'on')).toBe(false)
    } finally {
      Object.defineProperty(globalThis, 'crossOriginIsolated', { value: isolated, configurable: true })
    }
  })
})

describe('the controller on a worker of its own, kept for another run', () => {
  /** `steps` steps on `thread`, as the step loop makes them; what the world was handed */
  const run = (thread: PlcThread, steps: number): Record<string, number | boolean>[] => {
    const world = new StubWorld()
    for (let i = 0; i < steps; i++) {
      thread.beforeStep(world, 0.01)
      world.writes = writesAt(i)
      thread.afterParts(world, 0.01)
      world.stepCount++
    }
    thread.beforeStep(world, 0.01)
    return world.handed
  }

  it('restarted, hands a new world what a controller built for it hands it', () => {
    const { thread, group } = threaded()
    // a run that ends with scans asked for and never waited on, a force held and a command sent
    const world = new StubWorld()
    for (let i = 0; i < 23; i++) {
      thread.beforeStep(world, 0.01)
      world.writes = writesAt(i)
      thread.afterParts(world, 0.01)
      world.stepCount++
    }
    thread.setForces({ Run: true })
    expect(thread.restart(RUNS)).toBe(true)
    expect(group.snapshot().scansRun).toBe(0)
    expect(thread.snapshot().scansRun).toBe(0)
    expect(thread.perf.scans).toBe(0)
    const again = run(thread, 40)
    expect(again).toEqual(runHere(40).handed)
    expect(again.length).toBeGreaterThan(5)
  })

  it('restarted on another scan time, scans on it', () => {
    const slow = [{ controller: null, source: PROGRAM, periodSec: 0.02 }]
    const { thread } = threaded()
    run(thread, 15)
    expect(thread.restart(slow)).toBe(true)
    const fresh = threaded(slow)
    expect(run(thread, 40)).toEqual(run(fresh.thread, 40))
    expect(thread.snapshot().scanTimes[0]!.periodSec).toBe(0.02)
  })

  it('a run that ended in a fault restarts clean', () => {
    const faulting = [{ controller: null, source: `VAR_INPUT Eye : BOOL; END_VAR
VAR_OUTPUT N : DINT; END_VAR
VAR A : ARRAY[0..3] OF INT; I : INT; END_VAR
N := N + 1;
A[I] := 1;
I := I + 1;
`, periodSec: 0.01 }]
    const first = threaded(faulting)
    expect(() => run(first.thread, 20)).toThrow(PlcThreadFault)
    expect(first.thread.restart(faulting)).toBe(true)
    // the same four scans and the same fault, as a controller built now makes them
    const world = new StubWorld()
    world.stepCount = 1
    first.thread.beforeStep(world, 0.01)
    expect(world.handed.at(-1)).toMatchObject({ N: 1 })
  })

  it('stopped, does not restart', () => {
    const { thread } = threaded()
    thread.stop()
    expect(thread.restart(RUNS)).toBe(false)
  })
})
