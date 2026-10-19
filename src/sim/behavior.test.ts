import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { SCENE_VERSION, DEFAULT_SIM_HZ } from '../core/types'
import type { SceneJSON } from '../core/types'
import { create, destroy, error, meta, step } from './embeddedBehavior'
import { SimWorld } from './world'

const Jolt = await initJolt()

// A user-authored custom part. Declares one exported param (→ Inspector)
// and drives cargo along its flow axis each tick. This exact string is what an author types.
const CONVEYOR = `
definePart({
  params: { speed: { type: 'number', default: 1, min: 0, max: 5, label: 'Speed (m/s)' } },
  step(ctx) {
    const s = ctx.params.speed
    ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: ctx.forward.y * s, z: ctx.forward.z * s })
  },
})
`

function svOf(json: string): [number, number, number] {
  return (JSON.parse(json) as { surfaceVelocity: [number, number, number] }).surfaceVelocity
}

const input = (forward: [number, number, number]) => JSON.stringify({ simTime: 0, position: [0, 0, 0], forward, tags: {} })

describe('custom-part behavior runtime (SDK)', () => {
  it('runs a user script and applies its exported params', () => {
    const h = create(CONVEYOR, '{}')
    expect(h).toBeGreaterThan(0)
    // default speed 1, forward +X → surface velocity +X
    expect(svOf(step(h, input([1, 0, 0]), 1 / DEFAULT_SIM_HZ))).toEqual([1, 0, 0])
    // forward follows the part's orientation
    expect(svOf(step(h, input([0, 0, -1]), 1 / DEFAULT_SIM_HZ))).toEqual([0, 0, -1])
    destroy(h)
  })

  it("the tick length is ctx.dt; a script stored before format 4 still reads it as step's second argument", () => {
    const src = (body: string) => `definePart({ step(ctx, legacy) { ${body} } })`
    for (const body of ['ctx.setSurfaceVelocity({ x: ctx.dt, y: 0, z: 0 })', 'ctx.setSurfaceVelocity({ x: legacy, y: 0, z: 0 })']) {
      const h = create(src(body), '{}')
      expect(svOf(step(h, input([1, 0, 0]), 0.25))[0]).toBe(0.25)
      destroy(h)
    }
  })

  it('overridden params flow through (the Inspector edit path)', () => {
    const h = create(CONVEYOR, JSON.stringify({ speed: 2.5 }))
    expect(svOf(step(h, input([1, 0, 0]), 1 / DEFAULT_SIM_HZ))).toEqual([2.5, 0, 0])
    expect(JSON.parse(meta(h))).toHaveProperty('speed')
    destroy(h)
  })

  it('hot-reload: re-creating from edited source changes behavior', () => {
    const a = create(CONVEYOR, '{}')
    const before = svOf(step(a, input([1, 0, 0]), 1 / DEFAULT_SIM_HZ))
    destroy(a)
    // author edits the script - now it runs at double speed
    const edited = CONVEYOR.replace('ctx.params.speed', 'ctx.params.speed * 2')
    const b = create(edited, '{}')
    const after = svOf(step(b, input([1, 0, 0]), 1 / DEFAULT_SIM_HZ))
    expect(before).toEqual([1, 0, 0])
    expect(after).toEqual([2, 0, 0])
    destroy(b)
  })

  it('rng is deterministic and reproducible across instances', () => {
    const src = `definePart({ step(ctx){ ctx.setSurfaceVelocity({ x: ctx.rng(), y: 0, z: 0 }); } })`
    const a = create(src, '{}')
    const b = create(src, '{}')
    const seqA = [0, 1, 2].map(() => svOf(step(a, input([1, 0, 0]), 1 / DEFAULT_SIM_HZ))[0])
    const seqB = [0, 1, 2].map(() => svOf(step(b, input([1, 0, 0]), 1 / DEFAULT_SIM_HZ))[0])
    expect(seqA).toEqual(seqB) // same source + params → same stream (reproducible)
    expect(new Set(seqA).size).toBe(3) // but it is actually varying, not a constant
    destroy(a)
    destroy(b)
  })

  it('a bad script fails closed (handle 0 + error), never throws across the boundary', () => {
    // valid JS that never registers a part
    expect(create('var x = 1', '{}')).toBe(0)
    expect(error()).toMatch(/definePart/)
    // a syntax error is also caught, not thrown across the boundary
    expect(create('this is not valid', '{}')).toBe(0)
    expect(error().length).toBeGreaterThan(0)
  })

  it('ctx.rising / ctx.falling detect tag edges once, against the previous-tick snapshot', () => {
    // A part that pulses out.execd for the single tick `cmd` rises, and out.cleared when it falls.
    const src = `definePart({ step(ctx){
      ctx.writeTag('execd', ctx.rising('cmd'))
      ctx.writeTag('cleared', ctx.falling('cmd'))
    } })`
    const h = create(src, '{}')
    const tagsOf = (cmd: boolean) => JSON.parse(step(h, JSON.stringify({ simTime: 0, position: [0, 0, 0], forward: [1, 0, 0], tags: { cmd } }), 1 / DEFAULT_SIM_HZ)).tags as Record<string, boolean>
    // tick 1: cmd already true → treated as a rising edge (initial state is false)
    expect(tagsOf(true)).toEqual({ execd: true, cleared: false })
    // tick 2: cmd held true → no edge (this is what hand-rolled prev-diffing gets wrong over the bus)
    expect(tagsOf(true)).toEqual({ execd: false, cleared: false })
    // tick 3: cmd drops → falling edge fires once
    expect(tagsOf(false)).toEqual({ execd: false, cleared: true })
    // tick 4: cmd held false → quiet
    expect(tagsOf(false)).toEqual({ execd: false, cleared: false })
    // tick 5: cmd rises again → rising edge fires again
    expect(tagsOf(true)).toEqual({ execd: true, cleared: false })
    destroy(h)
  })

  it('ctx.tagDriven reads output ownership (the driven set), independent of the tag value table', () => {
    // a device reporting both channels: x = is 'Cmd' driven (owned by a program), y = its value
    const src = `definePart({ step(ctx){
      ctx.setSurfaceVelocity({ x: ctx.tagDriven('Cmd') ? 1 : 0, y: ctx.readTag('Cmd') ? 1 : 0, z: 0 })
    } })`
    const h = create(src, '{}')
    const at = (inp: object) => svOf(step(h, JSON.stringify(inp), 1 / DEFAULT_SIM_HZ))
    // a tag can carry a value while being nobody's output (e.g. a part-written input echoed by the watch)
    expect(at({ tags: { Cmd: true }, driven: {} })).toEqual([0, 1, 0])
    // driven: the attached program declares Cmd as an output - owned even while it commands false
    expect(at({ tags: { Cmd: false }, driven: { Cmd: true } })).toEqual([1, 0, 0])
    // no driven field at all (the idle-preview harness): never owned - hand mode
    expect(at({ tags: { Cmd: true } })).toEqual([0, 1, 0])
    destroy(h)
  })

  it('ctx.rising treats a numeric tag as boolean !== 0', () => {
    const src = `definePart({ step(ctx){ ctx.writeTag('edge', ctx.rising('n')) } })`
    const h = create(src, '{}')
    const edgeOf = (n: number) => JSON.parse(step(h, JSON.stringify({ simTime: 0, position: [0, 0, 0], forward: [1, 0, 0], tags: { n } }), 1 / DEFAULT_SIM_HZ)).tags.edge as boolean
    expect(edgeOf(0)).toBe(false) // 0 = false, no edge
    expect(edgeOf(5)).toBe(true) // 0 → 5 is a rising edge
    expect(edgeOf(3)).toBe(false) // 5 → 3 both nonzero, no edge
    destroy(h)
  })

  it('ctx.approach steps toward a target by at most maxDelta, snapping without overshoot', () => {
    // the part writes approach(current, target, maxDelta) into surfaceVelocity.x so we can read it back
    const src = `definePart({
      params: { cur: { type: 'number', default: 0 }, tgt: { type: 'number', default: 0 }, step: { type: 'number', default: 1 } },
      step(ctx){ ctx.setSurfaceVelocity({ x: ctx.approach(ctx.params.cur, ctx.params.tgt, ctx.params.step), y: 0, z: 0 }) },
    })`
    const ax = (cur: number, tgt: number, maxStep: number) => {
      const h = create(src, JSON.stringify({ cur, tgt, step: maxStep }))
      const v = svOf(step(h, input([1, 0, 0]), 1 / DEFAULT_SIM_HZ))[0]
      destroy(h)
      return v
    }
    expect(ax(0, 10, 2)).toBe(2) // moves +maxDelta toward a far target
    expect(ax(10, 0, 2)).toBe(8) // moves -maxDelta toward a far target (other direction)
    expect(ax(0, 1, 5)).toBe(1) // target within maxDelta → snaps exactly, no overshoot
    expect(ax(0, -1, 5)).toBe(-1) // snaps exactly downward too
    expect(ax(3, 3, 1)).toBe(3) // already at target → unchanged
    expect(ax(0, 10, -2)).toBe(2) // maxDelta magnitude is used (negative treated as +2)
    destroy(create(src, '{}'))
  })

  it('rejects a nondeterministic part at load (the determinism guard), before it can run', () => {
    const bad = `definePart({ step(ctx){ ctx.setSurfaceVelocity({ x: Math.random(), y: 0, z: Date.now() }) } })`
    expect(create(bad, '{}')).toBe(0)
    expect(error()).toMatch(/not deterministic.*Math\.random.*Date/s)
  })

  it('ctx.angleDelta / ctx.clamp: wrap-safe angular difference + the clamp one-liner', () => {
    const src = `definePart({
      params: { from: { type: 'number', default: 0 }, to: { type: 'number', default: 0 } },
      step(ctx){ ctx.setSurfaceVelocity({ x: ctx.angleDelta(ctx.params.from, ctx.params.to), y: ctx.clamp(5, 0, 2), z: ctx.clamp(-1, 0, 2) }) },
    })`
    const ad = (from: number, to: number) => {
      const h = create(src, JSON.stringify({ from, to }))
      const v = svOf(step(h, input([1, 0, 0]), 1 / DEFAULT_SIM_HZ))
      destroy(h)
      return v
    }
    expect(ad(0, Math.PI / 2)[0]).toBeCloseTo(Math.PI / 2, 10)
    // 3 rad → −3 rad: the short way is +0.283 across ±π, not −6 back through zero
    expect(ad(3, -3)[0]).toBeCloseTo(2 * Math.PI - 6, 10)
    expect(ad(-3, 3)[0]).toBeCloseTo(-(2 * Math.PI - 6), 10)
    expect(ad(0, 0)[1]).toBe(2) // clamp hi
    expect(ad(0, 0)[2]).toBe(0) // clamp lo
  })

  it('ctx.approachAngle slews the short way across the ±π wrap and snaps in reach', () => {
    const src = `definePart({
      params: { cur: { type: 'number', default: 0 }, tgt: { type: 'number', default: 0 }, step: { type: 'number', default: 1 } },
      step(ctx){ ctx.setSurfaceVelocity({ x: ctx.approachAngle(ctx.params.cur, ctx.params.tgt, ctx.params.step), y: 0, z: 0 }) },
    })`
    const aa = (cur: number, tgt: number, maxStep: number) => {
      const h = create(src, JSON.stringify({ cur, tgt, step: maxStep }))
      const v = svOf(step(h, input([1, 0, 0]), 1 / DEFAULT_SIM_HZ))[0]
      destroy(h)
      return v
    }
    expect(aa(3, -3, 0.1)).toBeCloseTo(3.1, 10) // heads UP through π (the short arc), not down through 0
    expect(aa(3, -3, 1)).toBeCloseTo(3 + (2 * Math.PI - 6), 10) // in reach → the target modulo 2π, continuous with current
    expect(aa(0.5, 0.2, 1)).toBeCloseTo(0.2, 10) // no wrap involved → a plain snap
  })

  it('ctx.approachVec steps a joint vector so every axis arrives together', () => {
    const far = `definePart({ step(ctx){ const v = ctx.approachVec([0, 0, 7], [10, -5], 2); ctx.setSurfaceVelocity({ x: v[0], y: v[1], z: v[2] }) } })`
    let h = create(far, '{}')
    let v = svOf(step(h, input([1, 0, 0]), 1 / DEFAULT_SIM_HZ))
    destroy(h)
    expect(v[0]).toBeCloseTo(2, 10) // the dominant axis moves maxDelta…
    expect(v[1]).toBeCloseTo(-1, 10) // …the others scale proportionally (they arrive on the same tick)
    expect(v[2]).toBe(7) // no matching target element → unchanged
    const near = `definePart({ step(ctx){ const v = ctx.approachVec([9.5, -4.75], [10, -5], 2); ctx.setSurfaceVelocity({ x: v[0], y: v[1], z: 0 }) } })`
    h = create(near, '{}')
    v = svOf(step(h, input([1, 0, 0]), 1 / DEFAULT_SIM_HZ))
    destroy(h)
    expect(v[0]).toBe(10) // within reach → exact snap, no creep
    expect(v[1]).toBe(-5)
  })

  it('ctx.steer / ctx.heading: waypoint drive commands + the −z yaw convention', () => {
    const steerSrc = (tx: number, tz: number) => `definePart({
      step(ctx){ const s = ctx.steer({ x: ${tx}, z: ${tz} }, { speed: 1.5, turnRate: 2 }); ctx.setSurfaceVelocity({ x: s.forward, y: s.turn, z: s.distance }) },
    })`
    const run = (tx: number, tz: number) => {
      const h = create(steerSrc(tx, tz), '{}')
      const v = svOf(step(h, input([1, 0, 0]), 1 / DEFAULT_SIM_HZ))
      destroy(h)
      return v
    }
    let v = run(2, 0) // dead ahead → full speed, no turn
    expect(v[0]).toBeCloseTo(1.5, 10)
    expect(v[1]).toBeCloseTo(0, 10)
    expect(v[2]).toBeCloseTo(2, 10)
    v = run(0, -2) // 90° to the left (−z) → turn in place, positive (matching drive's + = left)
    expect(v[0]).toBeCloseTo(0, 10)
    expect(v[1]).toBeCloseTo(2, 10) // clamped to turnRate
    v = run(0.001, 0) // a millimetre ahead → the dt cap stops exactly on the point instead of overshooting
    expect(v[0]).toBeCloseTo(0.001 * DEFAULT_SIM_HZ, 6)
    const h = create(`definePart({ step(ctx){ ctx.setSurfaceVelocity({ x: ctx.heading(), y: 0, z: 0 }) } })`, '{}')
    expect(svOf(step(h, input([0, 0, -1]), 1 / DEFAULT_SIM_HZ))[0]).toBeCloseTo(Math.PI / 2, 10) // facing −Z = +90° yaw
    destroy(h)
  })
})

function emptyScene(): SceneJSON {
  return { version: SCENE_VERSION, parts: [] }
}

describe('custom-part behavior in the running sim', () => {
  it('a scripted conveyor actually conveys cargo', () => {
    const w = new SimWorld(Jolt, emptyScene())
    const ok = w.spawnScriptedConveyor([0, 1, 0], 0, 8, 2, CONVEYOR, JSON.stringify({ speed: 1.5 }))
    expect(ok).toBe(true)
    w.spawnBoxAt(0, 1.3, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1])
    for (let i = 0; i < DEFAULT_SIM_HZ * 3; i++) w.step()
    const x = w.frame().positions[0] // the lone box's world X
    expect(x).toBeGreaterThan(0.8) // dragged in +X by the script's surface velocity
  })

  it('the scripted run is deterministic', () => {
    const run = (): number[] => {
      const w = new SimWorld(Jolt, emptyScene())
      w.spawnScriptedConveyor([0, 1, 0], 0, 8, 2, CONVEYOR, JSON.stringify({ speed: 1.5 }))
      w.spawnBoxAt(0, 1.3, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1])
      for (let i = 0; i < DEFAULT_SIM_HZ * 3; i++) w.step()
      return Array.from(w.frame().positions)
    }
    expect(run()).toEqual(run())
  })
})
