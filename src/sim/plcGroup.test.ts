import { describe, expect, it } from 'vitest'
import { setScanEngine } from '../plc/interpreter'
import { PlcGroup, samePrograms, type PlcRun } from './plcGroup'
import type { PlcWorldPort } from './plcHost'

const LINE = `VAR_INPUT
  Eye : BOOL;
END_VAR
VAR_OUTPUT
  Run : BOOL;
END_VAR
Run := NOT Eye;
`

/** A world whose parts wrote `writes` on their last step, keeping what the PLCs hand back. */
function world(writes: Record<string, number | boolean>) {
  const got: { tags: Record<string, number | boolean> | null } = { tags: null }
  const port: PlcWorldPort = {
    behaviorTagWrites: () => writes,
    setBehaviorInputTags: (tags) => {
      got.tags = tags
    },
    stepCount: 1,
  }
  return { port, got }
}

describe('controllers the simulator runs side by side', () => {
  it('hands each its own tags without the name, and its outputs back with it, as one table', () => {
    const group = new PlcGroup([
      { controller: null, source: LINE, periodSec: 0.01 },
      { controller: 'Cell2', source: LINE, periodSec: 0.01 },
    ])
    const { port, got } = world({ Eye: true, 'Cell2::Eye': false })
    group.interleave(port, 0.02)
    expect(got.tags).toEqual({ Run: false, 'Cell2::Run': true })
    const shot = group.snapshot()
    expect(shot.outputs).toMatchObject({ Run: false, 'Cell2::Run': true })
    expect(shot.scanTimes.map((t) => t.task)).toEqual(['', 'Cell2::Main'])
  })

  it('is one PlcHost when the default controller runs alone', () => {
    const group = new PlcGroup([{ controller: null, source: LINE, periodSec: 0.01 }])
    const { port, got } = world({ Eye: false, 'Cell2::Eye': true })
    group.interleave(port, 0.02)
    expect(got.tags).toEqual({ Run: true })
  })

  it("sends a force to the controller that runs the instance it names, and says whose a fault is", () => {
    const group = new PlcGroup([
      { controller: null, source: LINE, periodSec: 0.01 },
      { controller: 'Cell2', source: `PROGRAM Line\nVAR_OUTPUT\n  Run : BOOL;\nEND_VAR\nEND_PROGRAM\nCONFIGURATION C\n  RESOURCE R ON PLC\n    TASK T(INTERVAL := T#10ms, PRIORITY := 1);\n    PROGRAM LineB WITH T : Line;\n  END_RESOURCE\nEND_CONFIGURATION\n`, instances: ['LineB'] },
    ])
    group.setForces({ 'LineB.Run': true, Run: true })
    const { port, got } = world({})
    group.interleave(port, 0.02)
    expect(got.tags).toMatchObject({ Run: true, 'Cell2::LineB.Run': true })
    expect(() => new PlcGroup([{ controller: null, source: LINE }, { controller: 'Cell2', source: 'Run := ;' }])).toThrow(/^Cell2: /)
  })

  // a PLC outside the app runs the default controller, so the group holds only the others
  it('with no default controller here, reads and drives only the named controllers\' own tags', () => {
    const one = new PlcGroup([{ controller: 'Cell2', source: LINE, periodSec: 0.01 }])
    const a = world({ Eye: true, 'Cell2::Eye': false })
    one.interleave(a.port, 0.02)
    expect(a.got.tags).toEqual({ 'Cell2::Run': true })
    expect(one.snapshot().outputs).toEqual({ 'Cell2::Run': true })

    const two = new PlcGroup([
      { controller: 'Cell2', source: LINE, periodSec: 0.01 },
      { controller: 'Cell3', source: LINE, periodSec: 0.01 },
    ])
    const b = world({ Eye: false, 'Cell2::Eye': true, 'Cell3::Eye': false })
    two.interleave(b.port, 0.02)
    expect(b.got.tags).toEqual({ 'Cell2::Run': false, 'Cell3::Run': true })
    const shot = two.snapshot()
    expect(shot.outputs).toEqual({ 'Cell2::Run': false, 'Cell3::Run': true })
    expect(shot.inputs).toMatchObject({ 'Cell2::Eye': true, 'Cell3::Eye': false })
  })
})

// A second run of the same programs restarts the controller it has (sim/worker.ts): nothing is compiled, and what the
// world is handed must be what a controller built for that run hands it.
describe('a group restarted for another run', () => {
  // a count of the eye's rising edges, an on-delay, and an output that follows a wired tag
  const COUNTING = `VAR_INPUT
  Eye : BOOL;
END_VAR
VAR_OUTPUT
  Run : BOOL;
  Count : DINT;
END_VAR
VAR
  was : BOOL;
  t : TON;
  Lamp : BOOL;
END_VAR
IF Eye AND NOT was THEN Count := Count + 1; END_IF;
was := Eye;
t(IN := Eye, PT := T#30ms);
Run := t.Q;
Lamp := Count > 2;
`
  /** what the world is handed over `steps` steps of a blinking eye, and the frame at the end */
  const run = (group: PlcGroup, steps: number): unknown[] => {
    const handed: unknown[] = []
    let writes: Record<string, number | boolean> = {}
    const port: PlcWorldPort = { behaviorTagWrites: () => writes, setBehaviorInputTags: (tags) => void handed.push({ ...tags }), stepCount: 1 }
    for (let i = 0; i < steps; i++) {
      writes = { Eye: i % 5 < 3 }
      group.interleave(port, 0.01)
    }
    const shot = group.snapshot()
    return [...handed, shot.outputs, shot.watch, shot.scansRun, shot.scanTimes.map((t) => t.scans)]
  }

  it('hands the world what a newly built group does, on the scan time and wiring of the new run', () => {
    const first: PlcRun[] = [{ controller: null, source: COUNTING, periodSec: 0.01 }]
    const second: PlcRun[] = [{ controller: null, source: COUNTING, periodSec: 0.02, wired: { inputs: [], outputs: ['Lamp'] } }]
    expect(samePrograms(first, second)).toBe(true)
    const group = new PlcGroup(first)
    group.setForces({ Run: true })
    run(group, 37)
    expect(group.restart(second)).toBe(true)
    const again = run(group, 60)
    expect(again).toEqual(run(new PlcGroup(second), 60))
    // not vacuous: the wired output is handed on, the count moved, and the force of the last run is gone
    expect(JSON.stringify(again)).toMatch(/"Lamp":true/)
    expect(JSON.stringify(again)).toMatch(/"Run":false/)
  })

  it('restarts every controller of several', () => {
    const runs: PlcRun[] = [
      { controller: null, source: COUNTING, periodSec: 0.01 },
      { controller: 'Cell2', source: LINE, periodSec: 0.01 },
    ]
    const group = new PlcGroup(runs)
    run(group, 23)
    expect(group.restart(runs)).toBe(true)
    expect(run(group, 40)).toEqual(run(new PlcGroup(runs), 40))
  })

  it('is not for other programs, and a program on the walker does not restart', () => {
    const a: PlcRun[] = [{ controller: null, source: COUNTING }]
    expect(samePrograms(a, [{ controller: null, source: LINE }])).toBe(false)
    expect(samePrograms(a, [{ controller: 'Cell2', source: COUNTING }])).toBe(false)
    expect(samePrograms(a, [...a, { controller: 'Cell2', source: LINE }])).toBe(false)
    expect(samePrograms([{ controller: null, source: LINE, instances: ['A'] }], [{ controller: null, source: LINE, instances: ['B'] }])).toBe(false)
    const was = setScanEngine('walker')
    try {
      const group = new PlcGroup(a)
      const before = run(group, 10)
      expect(group.restart(a)).toBe(false)
      // and nothing changed: it runs on from where it was
      expect(run(group, 10)).not.toEqual(before)
    } finally {
      setScanEngine(was)
    }
  })
})
