import { describe, expect, it } from 'vitest'
import {
  AXIS_ERROR, axisCommandAborted, axisCommandDone, axisCommandQueued, axisHalt, axisHome, axisMoveAbsolute, axisMoveRelative,
  axisMoveVelocity, axisPower, axisReleaseStop, axisStop, createAxis, stepAxis, type Axis, type AxisConfig, type AxisState,
} from './motionAxis'

// The motion kernel against the kinematics its profiles are defined by (docs/motion-control.md), sample by sample.
//
// Each expected trajectory is written here as an acceleration curve, piece by piece, from the closed-form rule of the
// trapezoid (constant acceleration, cruise, constant deceleration), with each piece's length worked out by hand in the
// comment beside it. Position and velocity are then integrated from that curve by Gauss-
// Legendre quadrature, which shares no code and no formula with the kernel's own analytic integrals. The kernel samples
// its continuous profile exactly at each tick, so values agree to rounding (1e-9). The tick only decides when samples
// fall, so the one place a tick of slack is allowed is the tick a move completes on.

const DT = 0.004
const TOL = 1e-9

/** A stretch of the expected profile: its length and its acceleration `tau` seconds into it. */
interface Piece {
  dur: number
  acc: (tau: number) => number
}
const constant = (dur: number, a: number): Piece => ({ dur, acc: () => a })

// 5-point Gauss-Legendre on [-1, 1]: exact for polynomials up to degree 9
const GL_X = [0, -0.5384693101056831, 0.5384693101056831, -0.906179845938664, 0.906179845938664]
const GL_W = [0.5688888888888889, 0.4786286704993665, 0.4786286704993665, 0.2369268850561891, 0.2369268850561891]

/** v and x gained over the first `t` seconds of a piece entered at velocity v0: dv = integral of a, dx = v0*t +
 *  integral of (t - u) a(u) du, on 32 sub-intervals. */
function integrate(p: Piece, t: number, v0: number): { dv: number; dx: number } {
  let dv = 0
  let dx = v0 * t
  if (t <= 0) return { dv: 0, dx: 0 }
  const n = 32
  const h = t / n
  for (let i = 0; i < n; i++) {
    const mid = (i + 0.5) * h
    for (let q = 0; q < 5; q++) {
      const u = mid + (GL_X[q]! * h) / 2
      const w = (GL_W[q]! * h) / 2
      const a = p.acc(u)
      dv += w * a
      dx += w * (t - u) * a
    }
  }
  return { dv, dx }
}

/** The expected position and velocity `t` seconds into `pieces`, from (x0, v0); after the last piece, coasting. */
function expected(pieces: Piece[], x0: number, v0: number, t: number): { x: number; v: number } {
  let x = x0
  let v = v0
  let left = t
  for (const p of pieces) {
    if (left <= p.dur) {
      const d = integrate(p, left, v)
      return { x: x + d.dx, v: v + d.dv }
    }
    const d = integrate(p, p.dur, v)
    x += d.dx
    v += d.dv
    left -= p.dur
  }
  return { x: x + v * left, v }
}

const total = (pieces: Piece[]) => pieces.reduce((s, p) => s + p.dur, 0)

interface Row {
  x: number
  v: number
  a: number
  state: AxisState
}

/** Issue tick k's commands (`at`), then step: row k is the sample at (k+1)*DT. */
function trace(cfg: Partial<AxisConfig>, n: number, at: (k: number, ax: Axis) => void, start = 0): { ax: Axis; rows: Row[] } {
  const ax = createAxis({ min: -Infinity, max: Infinity, maxVelocity: Infinity, maxAccel: Infinity, ...cfg }, start)
  axisPower(ax, true)
  const rows: Row[] = []
  for (let k = 0; k < n; k++) {
    at(k, ax)
    stepAxis(ax, DT)
    rows.push({ x: ax.x, v: ax.v, a: ax.a, state: ax.state })
  }
  return { ax, rows }
}

/** Rows [from, to) follow `pieces` entered at (x0, v0) at the start of row `from`'s tick. */
function follows(rows: Row[], from: number, to: number, pieces: Piece[], x0: number, v0: number, what: string): void {
  for (let k = from; k < Math.min(to, rows.length); k++) {
    const t = (k - from + 1) * DT
    const e = expected(pieces, x0, v0, Math.min(t, total(pieces)))
    const r = rows[k]!
    const at = `${what}, row ${k} (t=${t.toFixed(3)}): expected x=${e.x} v=${e.v}, got x=${r.x} v=${r.v}`
    expect(Math.abs(r.x - e.x), at).toBeLessThanOrEqual(TOL * Math.max(1, Math.abs(e.x)))
    expect(Math.abs(r.v - e.v), at).toBeLessThanOrEqual(TOL * Math.max(1, Math.abs(e.v)))
  }
}

/** The tick a profile of `T` seconds completes on, counted from 1: the first sample at or past T (one tick of slack
 *  when T is a whole number of ticks, as the elapsed time is a sum of ticks). */
function expectDoneAt(row: number, T: number, what: string): void {
  const first = Math.ceil(T / DT - 1e-9)
  expect(row + 1, `${what}: done on tick ${row + 1}, profile ${T} s = ${T / DT} ticks`).toBeGreaterThanOrEqual(first)
  expect(row + 1, `${what}: done on tick ${row + 1}, profile ${T} s = ${T / DT} ticks`).toBeLessThanOrEqual(first + 1)
}

const firstRow = (rows: Row[], from: number, pred: (r: Row) => boolean) => rows.findIndex((r, k) => k >= from && pred(r))

const MOVE = { velocity: 20, accel: 100, decel: 100 }

describe('trapezoid: closed-form kinematics, every sample', () => {
  it('0 -> 10 at v 20, a = d = 100: 0.2 s up (2 units), 0.3 s cruise (6), 0.2 s down (2): 0.7 s', () => {
    let id = 0
    const { ax, rows } = trace({}, 200, (k, a) => k === 0 && (id = axisMoveAbsolute(a, 10, MOVE)))
    const P = [constant(0.2, 100), constant(0.3, 0), constant(0.2, -100)]
    follows(rows, 0, 200, P, 0, 0, 'cruise')
    // the first sample of a move from rest is a*dt^2/2, a*dt
    expect(rows[0]!.x).toBeCloseTo((100 * DT * DT) / 2, 12)
    expect(rows[0]!.v).toBeCloseTo(100 * DT, 12)
    expectDoneAt(firstRow(rows, 0, (r) => r.state === 'standstill'), total(P), 'cruise')
    expect(axisCommandDone(ax, id)).toBe(true)
    expect(ax.x).toBe(10)
    expect(Math.max(...rows.map((r) => r.v))).toBeLessThanOrEqual(20 + TOL)
  })

  it('0 -> 1 never reaches 20: a triangle, peak sqrt(d*a) = 10 at 0.1 s, 0.2 s in all', () => {
    const { rows } = trace({}, 60, (k, a) => k === 0 && axisMoveAbsolute(a, 1, MOVE))
    const P = [constant(0.1, 100), constant(0.1, -100)]
    follows(rows, 0, 60, P, 0, 0, 'triangle')
    expectDoneAt(firstRow(rows, 0, (r) => r.state === 'standstill'), 0.2, 'triangle')
    expect(Math.max(...rows.map((r) => r.v))).toBeLessThanOrEqual(10 + TOL)
  })

  it('unequal ramps, a 100 / d 50: up 0.2 s (2 units), cruise 0.2 s (4), down 0.4 s (4)', () => {
    const { rows } = trace({}, 220, (k, a) => k === 0 && axisMoveAbsolute(a, 10, { velocity: 20, accel: 100, decel: 50 }))
    const P = [constant(0.2, 100), constant(0.2, 0), constant(0.4, -50)]
    follows(rows, 0, 220, P, 0, 0, 'asymmetric')
    expectDoneAt(firstRow(rows, 0, (r) => r.state === 'standstill'), 0.8, 'asymmetric')
  })

  it('a relative move of 5: up 0.2 s (2), cruise 0.05 s (1), down 0.2 s (2)', () => {
    const { ax, rows } = trace({}, 130, (k, a) => k === 0 && axisMoveRelative(a, 5, MOVE), 3)
    follows(rows, 0, 130, [constant(0.2, 100), constant(0.05, 0), constant(0.2, -100)], 3, 0, 'relative')
    expect(ax.x).toBe(8)
  })

  it('an abort that reverses: at 0.152 s (x 1.1552, v 15.2) a move to 2 cannot stop in time, so it brakes to rest at 2.3104 and comes back 0.3104 as a triangle', () => {
    let first = 0
    let second = 0
    const { ax, rows } = trace({}, 120, (k, a) => {
      if (k === 0) first = axisMoveAbsolute(a, 10, MOVE)
      if (k === 38) second = axisMoveAbsolute(a, 2, MOVE)
    })
    follows(rows, 0, 38, [constant(0.2, 100)], 0, 0, 'before the abort')
    const x0 = 50 * 0.152 ** 2
    const vp = Math.sqrt(0.3104 * 100)
    const P = [constant(0.152, -100), constant(vp / 100, -100), constant(vp / 100, 100)]
    follows(rows, 38, 120, P, x0, 15.2, 'after the abort')
    expect(axisCommandAborted(ax, first)).toBe(true)
    expect(axisCommandDone(ax, second)).toBe(true)
    expect(ax.x).toBe(2)
    expect(Math.max(...rows.map((r) => r.x))).toBeCloseTo(2.3104, 3)
  })
})

describe('velocity, halt and stop', () => {
  it('velocity 15 at a 100 is reached in 0.15 s and held; a halt at d 50 brakes for 0.3 s (2.25 units)', () => {
    let vel = 0
    let halt = 0
    const { ax, rows } = trace({}, 200, (k, a) => {
      if (k === 0) vel = axisMoveVelocity(a, 15, { accel: 100, decel: 100 })
      if (k === 98) halt = axisHalt(a, 50)
    })
    const P = [constant(0.15, 100), constant(98 * DT - 0.15, 0), constant(0.3, -50)]
    follows(rows, 0, 200, P, 0, 0, 'velocity then halt')
    const reached = firstRow(rows, 0, (r) => r.v === 15)
    expectDoneAt(reached, 0.15, 'InVelocity')
    expect(rows[reached]!.state).toBe('continuous')
    expect(axisCommandAborted(ax, vel)).toBe(true)
    expect(axisCommandDone(ax, halt)).toBe(true)
    expect(ax.state).toBe('standstill')
    expectDoneAt(firstRow(rows, 98, (r) => r.state === 'standstill') - 98, 0.3, 'halt')
  })

  it('a stop holds the axis in Stopping, refuses motion while held, and releases to Standstill', () => {
    let stop = 0
    const { ax, rows } = trace({}, 100, (k, a) => {
      if (k === 0) axisMoveVelocity(a, 15, { accel: 100, decel: 100 })
      if (k === 50) stop = axisStop(a, 100)
      if (k === 80) expect(axisMoveAbsolute(a, 0, MOVE)).toBe(-AXIS_ERROR.stopActive)
    })
    follows(rows, 50, 100, [constant(0.15, -100)], rows[49]!.x, 15, 'the stop')
    expect(rows.slice(50).every((r) => r.state === 'stopping')).toBe(true)
    expect(axisCommandDone(ax, stop)).toBe(true)
    axisReleaseStop(ax)
    expect(ax.state).toBe('standstill')
    expect(axisMoveAbsolute(ax, 0, MOVE)).toBeGreaterThan(0)
  })

  it('an unpowered axis refuses motion and does not move', () => {
    const ax = createAxis({ min: -Infinity, max: Infinity, maxVelocity: Infinity, maxAccel: Infinity })
    expect(axisMoveAbsolute(ax, 5, MOVE)).toBe(-AXIS_ERROR.notPowered)
    stepAxis(ax, DT)
    expect([ax.x, ax.state]).toEqual([0, 'disabled'])
  })

  it('home: homingTicks ticks in Homing, then the position is set and the home is done', () => {
    const ax = createAxis({ min: -Infinity, max: Infinity, maxVelocity: Infinity, maxAccel: Infinity, homingTicks: 1 }, 3)
    axisPower(ax, true)
    const id = axisHome(ax, 7)
    stepAxis(ax, DT)
    expect([ax.state, ax.x, axisCommandDone(ax, id)]).toEqual(['homing', 3, false])
    stepAxis(ax, DT)
    expect([ax.state, ax.x, axisCommandDone(ax, id), ax.homed]).toEqual(['standstill', 7, true, true])
  })
})

describe('software limits: a sample the axis could not stop from at or before a limit is never shown', () => {
  /** The nominal samples of `P` until the first whose stopping distance at `D` passes `max`: that row, and the
   *  state the brake starts from (the row before it). */
  function trip(P: Piece[], D: number, max: number): { k: number; x: number; v: number } {
    let prev = { x: 0, v: 0 }
    for (let k = 0; ; k++) {
      const e = expected(P, 0, 0, (k + 1) * DT)
      if (e.x + (e.v * Math.abs(e.v)) / (2 * D) > max) return { k, ...prev }
      prev = e
    }
  }

  // the limit deceleration (core/motionAxis.ts, SOFTWARE LIMITS): the axis's configured one; else its maximum
  // deceleration; else, on an uncapped axis, the deceleration of the command in motion (both commands here: 100)
  for (const [rule, cfg, limitDecel] of [
    ['configured (1000)', { limitDecel: 1000 }, 1000],
    ["none configured: the axis's maximum deceleration (200)", { maxAccel: 200 }, 200],
    ["none configured, an uncapped axis: the move's own deceleration (100)", {}, 100],
  ] as const) {
  for (const [what, cmd, P] of [
    ['a target past the limit (8, limit 5)', (a: Axis) => axisMoveAbsolute(a, 8, MOVE), [constant(0.2, 100), constant(0.2, 0), constant(0.2, -100)]],
    ['a velocity run into it', (a: Axis) => axisMoveVelocity(a, 15, { accel: 100, decel: 100 }), [constant(0.15, 100), constant(10, 0)]],
  ] as const) {
    it(`${what}, limit deceleration ${rule}: accepted, braked at it from the last safe sample, ErrorStop at rest at or short of the limit`, () => {
      let id = 0
      const { ax, rows } = trace({ min: -5, max: 5, ...cfg }, 200, (k, a) => k === 0 && (id = cmd(a)))
      expect(id).toBeGreaterThan(0)
      const t = trip([...P], limitDecel, 5)
      follows(rows, 0, t.k, [...P], 0, 0, 'before the limit')
      // from the last safe sample, a straight brake at the limit deceleration
      follows(rows, t.k, 200, [constant(t.v / limitDecel, -limitDecel)], t.x, t.v, 'the limit brake')
      expect(rows[t.k]!.state).toBe('errorStop')
      expect(ax.error).toBe(AXIS_ERROR.limitReached)
      expect(axisCommandAborted(ax, id)).toBe(true)
      expect(ax.v).toBe(0)
      expect(ax.x).toBeCloseTo(t.x + (t.v * t.v) / (2 * limitDecel), 9)
      // never past it (rounding aside: a brake that stops exactly on the limit may end a few ulps over)
      expect(Math.max(...rows.map((r) => r.x))).toBeLessThanOrEqual(5 + 1e-12)
      // within a tick of travel of the limit: it caught the first sample that could not stop
      expect(ax.x).toBeGreaterThan(5 - 20 * DT - (20 * 20) / (2 * limitDecel))
    })
  }
  }

  it('a move that ends exactly on the limit, decelerating at the limit deceleration, is not a fault', () => {
    const { ax } = trace({ min: -5, max: 5, limitDecel: 100 }, 200, (k, a) => k === 0 && axisMoveAbsolute(a, 5, MOVE))
    expect([ax.state, ax.x, ax.error]).toEqual(['standstill', 5, AXIS_ERROR.none])
  })
})

describe('buffered moves', () => {
  // 0 -> 5 at v 20, a = d = 100: up 0.2 s, cruise 0.05 s, down 0.2 s
  const TO5 = [constant(0.2, 100), constant(0.05, 0), constant(0.2, -100)]
  // 5 -> 8: 3 units is under the 4 two full ramps need, so a triangle peaking at sqrt(3 * 100)
  const vp = Math.sqrt(300)
  const TO8 = [constant(vp / 100, 100), constant(vp / 100, -100)]

  it('behind a position move: waits (queued), then starts from where it stopped, its first motion the tick after', () => {
    let first = 0
    let second = 0
    const { ax, rows } = trace({}, 220, (k, a) => {
      if (k === 0) first = axisMoveAbsolute(a, 5, MOVE)
      if (k === 18) {
        second = axisMoveAbsolute(a, 8, { ...MOVE, buffered: true })
        expect(axisCommandQueued(a, second)).toBe(true)
      }
    })
    const done = firstRow(rows, 0, (r) => r.v === 0 && r.x === 5)
    expectDoneAt(done, total(TO5), 'the first move')
    follows(rows, 0, done, TO5, 0, 0, 'the first move')
    follows(rows, done + 1, 220, TO8, 5, 0, 'the buffered move')
    expect(axisCommandDone(ax, first) && axisCommandDone(ax, second)).toBe(true)
    expect(ax.x).toBe(8)
  })

  it('on an idle axis: starts at once', () => {
    const { rows } = trace({}, 10, (k, a) => k === 0 && axisMoveAbsolute(a, 3, { ...MOVE, buffered: true }))
    expect(rows[0]!.x).toBeCloseTo(50 * DT * DT, 12)
  })

  it('a queue of two runs in order, each from where the one ahead stopped', () => {
    const ids: number[] = []
    const { ax, rows } = trace({}, 400, (k, a) => {
      if (k === 0) ids.push(axisMoveAbsolute(a, 3, MOVE))
      if (k === 8) ids.push(axisMoveAbsolute(a, 6, { ...MOVE, buffered: true }))
      if (k === 13) ids.push(axisMoveAbsolute(a, 1, { ...MOVE, buffered: true }))
      if (k === 20) expect([axisCommandQueued(a, ids[1]!), axisCommandQueued(a, ids[2]!)]).toEqual([true, true])
    })
    // 3 units each way: triangles peaking at sqrt(300), 2*sqrt(3)/10 s; then 5 units: up 0.2, cruise 0.05, down 0.2
    const tri = (s: number) => [constant(vp / 100, 100 * s), constant(vp / 100, -100 * s)]
    const back = [constant(0.2, -100), constant(0.05, 0), constant(0.2, 100)]
    const d1 = firstRow(rows, 0, (r) => r.x === 3)
    const d2 = firstRow(rows, d1 + 1, (r) => r.x === 6)
    follows(rows, d1 + 1, d2, tri(1), 3, 0, 'second')
    follows(rows, d2 + 1, 400, back, 6, 0, 'third')
    expectDoneAt(d2 - d1 - 1, total(tri(1)), 'second')
    expect(ids.every((id) => axisCommandDone(ax, id))).toBe(true)
    expect(ax.x).toBe(1)
  })

  it('an Aborting move ends the active one and every waiting one', () => {
    const ids: number[] = []
    const { ax } = trace({}, 200, (k, a) => {
      if (k === 0) ids.push(axisMoveAbsolute(a, 5, MOVE))
      if (k === 8) ids.push(axisMoveAbsolute(a, 8, { ...MOVE, buffered: true }))
      if (k === 28) ids.push(axisMoveAbsolute(a, 2, MOVE))
    })
    expect([axisCommandAborted(ax, ids[0]!), axisCommandAborted(ax, ids[1]!), axisCommandDone(ax, ids[2]!)]).toEqual([true, true, true])
    expect(ax.x).toBe(2)
  })

  it('behind a velocity move: takes over the tick the velocity is reached, planned from that tick\'s start', () => {
    let vel = 0
    let move = 0
    const { ax, rows } = trace({}, 200, (k, a) => {
      if (k === 0) vel = axisMoveVelocity(a, 15, { accel: 100, decel: 100 })
      if (k === 8) move = axisMoveAbsolute(a, 6, { ...MOVE, buffered: true })
    })
    // 15 is reached at 0.15 s, in tick 38 (row 37); that tick plans from the end of tick 37: t 0.148, v 14.8,
    // x 1.0952. From there: up to 20 in 0.052 s (0.9048 units), down from 20 in 0.2 s (2 units), and the 2 units left
    // between at 20: 0.1 s
    const x0 = 50 * 0.148 ** 2
    follows(rows, 0, 37, [constant(0.15, 100)], 0, 0, 'the velocity ramp')
    follows(rows, 37, 200, [constant(0.052, 100), constant(0.1, 0), constant(0.2, -100)], x0, 14.8, 'the buffered move')
    expect(axisCommandDone(ax, vel)).toBe(true) // it did reach its velocity
    expect(axisCommandDone(ax, move)).toBe(true)
    expect(ax.x).toBe(6)
  })
})
