import { describe, expect, it } from 'vitest'
import {
  AXIS_ERROR,
  axisCommandAborted,
  axisCommandDone,
  axisFollow,
  axisHalt,
  axisHome,
  axisInPosition,
  axisMoveAbsolute,
  axisMoveRelative,
  axisMoveVelocity,
  axisPosition,
  axisPower,
  axisReleaseStop,
  axisReset,
  axisStop,
  createAxis,
  stepAxis,
  type Axis,
} from './motionAxis'

const DT = 1 / 60

/** Deterministic LCG, so a failing sweep reproduces. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

interface Trace {
  x: number[]
  v: number[]
  ticks: number
}

/** Step until `stop` says so (or a tick cap), recording position and velocity after every tick. */
function run(ax: Axis, stop: (ax: Axis) => boolean, cap = 100_000, dt = DT): Trace {
  const t: Trace = { x: [ax.x], v: [ax.v], ticks: 0 }
  while (t.ticks < cap && !stop(ax)) {
    stepAxis(ax, dt)
    t.ticks++
    t.x.push(ax.x)
    t.v.push(ax.v)
  }
  return t
}

/** The largest per-tick velocity change, as an acceleration. */
const peakAccel = (t: Trace, dt = DT) => t.v.slice(1).reduce((m, v, i) => Math.max(m, Math.abs(v - t.v[i]!) / dt), 0)

/** Time a rest-to-rest trapezoid takes in continuous time. */
function trapezoidTime(dist: number, v: number, a: number, d: number) {
  const dRamp = (v * v) / (2 * a) + (v * v) / (2 * d)
  if (dist >= dRamp) return v / a + v / d + (dist - dRamp) / v
  const vp = Math.sqrt((2 * dist * a * d) / (a + d))
  return vp / a + vp / d
}

const powered = (cfg: Parameters<typeof createAxis>[0], at = 0) => {
  const ax = createAxis(cfg, at)
  axisPower(ax, true)
  return ax
}

describe('motionAxis: rest-to-rest moves', () => {
  it('lands exactly, never overshoots, and respects every limit (seeded sweep)', () => {
    const r = rng(7)
    for (let i = 0; i < 400; i++) {
      const vmax = 0.05 + r() * 5
      const acc = 0.1 + r() * 20
      const dec = 0.1 + r() * 20
      const from = (r() - 0.5) * 10
      const to = (r() - 0.5) * 10
      const ax = powered({ min: -10, max: 10, maxVelocity: 100, maxAccel: 100 }, from)
      const id = axisMoveAbsolute(ax, to, { velocity: vmax, accel: acc, decel: dec })
      expect(id).toBeGreaterThan(0)
      const t = run(ax, (a) => axisCommandDone(a, id))
      const ctx = `#${i} ${from.toFixed(3)} -> ${to.toFixed(3)} v=${vmax.toFixed(3)} a=${acc.toFixed(3)} d=${dec.toFixed(3)}`
      expect(axisPosition(ax), ctx).toBe(to)
      expect(ax.v, ctx).toBe(0)
      expect(ax.state, ctx).toBe('standstill')
      expect(axisInPosition(ax), ctx).toBe(true)
      // no overshoot: every sample stays between start and goal
      const lo = Math.min(from, to) - 1e-9
      const hi = Math.max(from, to) + 1e-9
      expect(t.x.filter((x) => x < lo || x > hi), ctx).toEqual([])
      expect(Math.max(...t.v.map(Math.abs)), ctx).toBeLessThanOrEqual(vmax * (1 + 1e-9))
      expect(peakAccel(t), ctx).toBeLessThanOrEqual(Math.max(acc, dec) * (1 + 1e-6))
      // close to the continuous trapezoid: discretisation adds a few ticks at most
      const ideal = trapezoidTime(Math.abs(to - from), vmax, acc, dec)
      expect(t.ticks * DT, ctx).toBeLessThanOrEqual(ideal + 3 * DT)
    }
  })

  it('a zero-length move is done on the first tick', () => {
    const ax = powered({ min: -1, max: 1, maxVelocity: 1, maxAccel: 1 }, 0.5)
    const id = axisMoveAbsolute(ax, 0.5, { velocity: 1 })
    stepAxis(ax, DT)
    expect(axisCommandDone(ax, id)).toBe(true)
    expect(ax.x).toBe(0.5)
  })

  it('clamps a command to the axis caps', () => {
    const ax = powered({ min: 0, max: 100, maxVelocity: 2, maxAccel: 4 })
    const id = axisMoveAbsolute(ax, 50, { velocity: 1000, accel: 1000 })
    const t = run(ax, (a) => axisCommandDone(a, id))
    expect(Math.max(...t.v)).toBeLessThanOrEqual(2)
    expect(peakAccel(t)).toBeLessThanOrEqual(4 * (1 + 1e-9))
  })

  it('a relative move goes by the distance from where it starts', () => {
    const ax = powered({ min: -5, max: 5, maxVelocity: 1, maxAccel: 2 }, 1)
    const id = axisMoveRelative(ax, -2.5, { velocity: 1 })
    run(ax, (a) => axisCommandDone(a, id))
    expect(ax.x).toBe(-1.5)
  })
})

describe('motionAxis: aborting a move', () => {
  it('a new target mid-move takes over; the first command reports aborted, the second done', () => {
    const r = rng(11)
    for (let i = 0; i < 200; i++) {
      // limits well clear of the targets: an overshooting reversal near a limit ErrorStops by design (its own test)
      const ax = powered({ min: -100, max: 100, maxVelocity: 5, maxAccel: 10 })
      const first = axisMoveAbsolute(ax, (r() - 0.5) * 20, { velocity: 0.5 + r() * 4, accel: 0.5 + r() * 9 })
      run(ax, () => false, 1 + Math.floor(r() * 120))
      const goal = (r() - 0.5) * 20
      const acc = 0.5 + r() * 9
      const second = axisMoveAbsolute(ax, goal, { velocity: 0.5 + r() * 4, accel: acc })
      expect(axisCommandAborted(ax, first) || axisCommandDone(ax, first)).toBe(true)
      const t = run(ax, (a) => axisCommandDone(a, second))
      expect(ax.x, `#${i}`).toBe(goal)
      expect(ax.v).toBe(0)
      // braking from the first move's speed is done at the new move's deceleration (== its accel here)
      expect(peakAccel(t), `#${i}`).toBeLessThanOrEqual(acc * (1 + 1e-6))
    }
  })

  it('reversing brakes through zero at the deceleration: no sample jumps more than a tick of it', () => {
    const ax = powered({ min: -10, max: 10, maxVelocity: 2, maxAccel: 1 })
    axisMoveAbsolute(ax, 8, { velocity: 2 })
    run(ax, () => false, 180)
    expect(ax.v).toBeGreaterThan(1)
    const id = axisMoveAbsolute(ax, 0, { velocity: 2 })
    const t = run(ax, (a) => axisCommandDone(a, id))
    // the profile is sampled, so a sample may sit either side of zero; the step between two never exceeds decel * dt
    expect(peakAccel(t)).toBeLessThanOrEqual(1 * (1 + 1e-9))
    expect(Math.min(...t.v)).toBeLessThan(0)
    expect(ax.x).toBe(0)
  })
})

describe('motionAxis: velocity mode', () => {
  it('ramps to the velocity and reports done (InVelocity) there', () => {
    const ax = powered({ min: -100, max: 100, maxVelocity: 3, maxAccel: 2 })
    const id = axisMoveVelocity(ax, -1.5)
    const t = run(ax, (a) => axisCommandDone(a, id))
    expect(ax.v).toBe(-1.5)
    expect(ax.state).toBe('continuous')
    expect(t.ticks * DT).toBeCloseTo(0.75, 1)
  })

  it('running into a software limit brakes short of it and goes to ErrorStop (the first sample that could not stop in time is never shown: the brake starts from the sample before)', () => {
    const ax = powered({ min: 0, max: 1, maxVelocity: 2, maxAccel: 4 })
    const id = axisMoveVelocity(ax, 2)
    const t = run(ax, (a) => a.state === 'errorStop' && a.v === 0, 10_000)
    expect(ax.x).toBeLessThan(1)
    expect(ax.x).toBeGreaterThan(0.9)
    expect(Math.max(...t.x)).toBeLessThan(1)
    expect(ax.error).toBe(AXIS_ERROR.limitReached)
    expect(axisCommandAborted(ax, id)).toBe(true)
    // refused until reset, then free to move back
    expect(axisMoveAbsolute(ax, 0, { velocity: 1 })).toBe(-AXIS_ERROR.inErrorStop)
    axisReset(ax)
    expect(ax.state).toBe('standstill')
    expect(axisMoveAbsolute(ax, 0, { velocity: 1 })).toBeGreaterThan(0)
  })

  it('a modulo axis spins forever and reports a wrapped position', () => {
    const ax = powered({ min: 0, max: 0, maxVelocity: 720, maxAccel: 720, modulo: 360 })
    axisMoveVelocity(ax, 360)
    run(ax, () => false, 600)
    expect(ax.state).toBe('continuous')
    expect(axisPosition(ax)).toBeGreaterThanOrEqual(0)
    expect(axisPosition(ax)).toBeLessThan(360)
    expect(ax.x).toBeGreaterThan(360 * 8)
  })
})

describe('motionAxis: modulo absolute moves', () => {
  const cases: Array<[number, number, 'shortest' | 'positive' | 'negative', number]> = [
    [350, 10, 'shortest', 20],
    [10, 350, 'shortest', -20],
    [10, 350, 'positive', 340],
    [350, 10, 'negative', -340],
  ]
  for (const [from, to, dir, travel] of cases) {
    it(`${from} -> ${to} ${dir} travels ${travel}`, () => {
      const ax = powered({ min: 0, max: 0, maxVelocity: 90, maxAccel: 180, modulo: 360 }, from)
      const id = axisMoveAbsolute(ax, to, { velocity: 90 }, dir)
      run(ax, (a) => axisCommandDone(a, id))
      expect(ax.x - from).toBeCloseTo(travel, 9)
      expect(axisPosition(ax)).toBeCloseTo(to, 9)
    })
  }
})

describe('motionAxis: the state machine', () => {
  it('refuses motion while unpowered, and powering off stops the axis dead', () => {
    const ax = createAxis({ min: -1, max: 1, maxVelocity: 1, maxAccel: 1 })
    expect(ax.state).toBe('disabled')
    expect(axisMoveAbsolute(ax, 1, { velocity: 1 })).toBe(-AXIS_ERROR.notPowered)
    axisPower(ax, true)
    axisMoveVelocity(ax, 1)
    run(ax, () => false, 30)
    axisPower(ax, false)
    expect(ax.v).toBe(0)
    expect(ax.state).toBe('disabled')
    const x = ax.x
    run(ax, () => false, 30)
    expect(ax.x).toBe(x)
  })

  it('refuses a target that is not a number, and bad dynamics', () => {
    const ax = powered({ min: -1, max: 1, maxVelocity: 1, maxAccel: 1 })
    expect(axisMoveAbsolute(ax, 0.5, { velocity: 0 })).toBe(-AXIS_ERROR.badDynamics)
    expect(axisMoveAbsolute(ax, 0.5, { velocity: 1, accel: -1 })).toBe(-AXIS_ERROR.badDynamics)
    expect(axisMoveAbsolute(ax, Number.NaN, { velocity: 1 })).toBe(-AXIS_ERROR.targetOutOfRange)
    expect(axisMoveRelative(ax, Number.POSITIVE_INFINITY, { velocity: 1 })).toBe(-AXIS_ERROR.targetOutOfRange)
    expect(ax.state).toBe('standstill')
  })

  it('accepts a target past a software limit: it moves, then ErrorStops at or short of the limit', () => {
    const ax = powered({ min: -1, max: 1, maxVelocity: 1, maxAccel: 4 })
    const id = axisMoveAbsolute(ax, 1.5, { velocity: 1 })
    expect(id).toBeGreaterThan(0)
    const t = run(ax, (a) => a.state === 'errorStop' && a.v === 0, 10_000)
    expect(ax.x).toBeGreaterThan(0.8)
    expect(Math.max(...t.x)).toBeLessThanOrEqual(1 + 1e-12)
    expect(axisCommandAborted(ax, id)).toBe(true)
  })

  it('halt brakes to standstill and stays commandable', () => {
    const ax = powered({ min: -10, max: 10, maxVelocity: 2, maxAccel: 2 })
    const move = axisMoveAbsolute(ax, 9, { velocity: 2 })
    run(ax, () => false, 90)
    const halt = axisHalt(ax)
    expect(axisCommandAborted(ax, move)).toBe(true)
    run(ax, (a) => axisCommandDone(a, halt))
    expect(ax.state).toBe('standstill')
    expect(ax.v).toBe(0)
    expect(axisMoveAbsolute(ax, 0, { velocity: 1 })).toBeGreaterThan(0)
  })

  it('a held stop refuses motion until released', () => {
    const ax = powered({ min: -10, max: 10, maxVelocity: 2, maxAccel: 2 })
    axisMoveVelocity(ax, 2)
    run(ax, () => false, 90)
    const stop = axisStop(ax)
    run(ax, (a) => axisCommandDone(a, stop))
    expect(ax.state).toBe('stopping')
    expect(axisMoveAbsolute(ax, 0, { velocity: 1 })).toBe(-AXIS_ERROR.stopActive)
    axisReleaseStop(ax)
    expect(ax.state).toBe('standstill')
    expect(axisMoveAbsolute(ax, 0, { velocity: 1 })).toBeGreaterThan(0)
  })

  it('a reset is refused while the axis is still braking, and clears it once still', () => {
    const ax = powered({ min: 0, max: 10, maxVelocity: 5, maxAccel: 1 })
    axisMoveVelocity(ax, 5)
    run(ax, (a) => a.state === 'errorStop')
    // the limit fault is raised as the brake starts, with the axis still moving
    expect(ax.v).not.toBe(0)
    expect(axisReset(ax)).toBe(-AXIS_ERROR.stillMoving)
    run(ax, (a) => a.v === 0)
    expect(axisReset(ax)).toBeGreaterThanOrEqual(0)
    expect(ax.state).toBe('standstill')
  })

  it('home sets the position in place and marks the axis homed', () => {
    const ax = powered({ min: -1, max: 1, maxVelocity: 1, maxAccel: 1 }, 0.3)
    expect(ax.homed).toBe(false)
    const id = axisHome(ax, 0)
    expect(axisCommandDone(ax, id)).toBe(true)
    expect(ax.x).toBe(0)
    expect(ax.homed).toBe(true)
  })
})

describe('motionAxis: follow (external setpoint)', () => {
  it('tracks a setpoint stream, capped at max velocity, held inside the limits', () => {
    const ax = powered({ min: 0, max: 1, maxVelocity: 0.6, maxAccel: 1 })
    const id = axisFollow(ax, 0.005)
    stepAxis(ax, DT)
    expect(ax.x).toBeCloseTo(0.005, 12)
    // a jump far beyond what max velocity allows in a tick is slewed, not teleported
    expect(axisFollow(ax, 0.9)).toBe(id)
    stepAxis(ax, DT)
    expect(ax.x).toBeCloseTo(0.005 + 0.6 * DT, 12)
    axisFollow(ax, 5)
    run(ax, () => false, 600)
    expect(ax.x).toBe(1)
  })
})

describe('motionAxis: follow on a wrapping axis', () => {
  it('a setpoint stream crossing 360 -> 0 turns on through it instead of spinning back a turn', () => {
    const ax = powered({ min: 0, max: 0, maxVelocity: 720, maxAccel: 720, modulo: 360 }, 350)
    let sp = 350
    for (let i = 0; i < 60; i++) {
      sp = (sp + 1) % 360 // 1 degree a tick, wrapping at 360
      axisFollow(ax, sp)
      stepAxis(ax, DT)
      expect(ax.v).toBeGreaterThanOrEqual(0)
    }
    expect(ax.x).toBeCloseTo(410, 9) // unwrapped: 60 degrees on from 350
    expect(axisPosition(ax)).toBeCloseTo(50, 9)
  })
})
