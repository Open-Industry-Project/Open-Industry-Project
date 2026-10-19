import { describe, expect, it } from 'vitest'
import { CLOCK_WINDOW_MS, SimClockRate } from './simClockRate'

const SIM_HZ = 60
const WARMUP = 3 // WARMUP_WINDOWS in simClockRate.ts
const SETTLE = 8 // windows to let the EMA converge on a steady rate
const TICK_MS = 8 // the worker's step-loop interval

/** a monotonic pair of clocks, as a run sees them: wall time and whole 1/60 s steps taken */
interface Clocks {
  t: number
  steps: number
}

const clocks = (): Clocks => ({ t: 1000, steps: 0 })

/**
 * Feed the meter as the worker would: sample once per ~8 ms tick for `windows` measurement
 * windows, with the sim advancing `achieved` sim-seconds per real second in whole steps (sim time
 * never falls between two 1/60 s ticks). Both clocks carry over, so phases compose.
 */
function feed(r: SimClockRate, c: Clocks, achieved: number, requested: number, windows: number): void {
  const end = c.t + windows * CLOCK_WINDOW_MS + TICK_MS
  const stepsPerMs = (achieved * SIM_HZ) / 1000
  let partial = 0
  while (c.t <= end) {
    partial += TICK_MS * stepsPerMs
    const whole = Math.floor(partial)
    partial -= whole
    c.steps += whole
    c.t += TICK_MS
    r.sample(c.t, c.steps / SIM_HZ, requested)
  }
}

describe('SimClockRate', () => {
  it('reads nothing until the first window closes', () => {
    const r = new SimClockRate()
    r.sample(1000, 0, 1)
    r.sample(1000 + CLOCK_WINDOW_MS - 10, 0.4, 1)
    expect(r.measured).toBeNull()
    expect(r.shortfall).toBeNull()
  })

  it('measures the achieved rate, not the requested one', () => {
    const real = new SimClockRate()
    feed(real, clocks(), 1, 1, 1)
    expect(real.measured).toBeCloseTo(1, 1)

    // a fast-forward the machine is holding
    const fast = new SimClockRate()
    feed(fast, clocks(), 4, 4, 1)
    expect(fast.measured).toBeCloseTo(4, 1)

    // slow-motion is not a shortfall: 0.5 achieved against 0.5 requested is keeping up
    const slow = new SimClockRate()
    feed(slow, clocks(), 0.5, 0.5, SETTLE)
    expect(slow.measured).toBeCloseTo(0.5, 1)
    expect(slow.shortfall).toBeNull()
  })

  it('flags a requested speed the machine cannot hold, rounded to 0.1', () => {
    const r = new SimClockRate()
    feed(r, clocks(), 5.2, 8, SETTLE) // 8x asked for, 5.2x delivered
    expect(r.shortfall).toBe(5.2)
  })

  it('flags a shortfall at 1x too (a scene too heavy for realtime)', () => {
    const r = new SimClockRate()
    feed(r, clocks(), 0.6, 1, SETTLE)
    expect(r.shortfall).toBe(0.6)
  })

  it('flags a rate that alternates across the threshold, never sustaining the request', () => {
    // The step loop accrues delayed time and runs it off in the next tick, so windows swing either
    // side of the line: here 4x and 8x alternating, i.e. 6x sustained against 8x asked for. Counting
    // consecutive short windows stays silent through exactly this; verify-sim-speed-ladder.mjs saw it
    // on a loaded machine (5.95x of 8x, no warning).
    const r = new SimClockRate()
    const c = clocks()
    for (let i = 0; i < SETTLE; i++) feed(r, c, i % 2 === 0 ? 4 : 8, 8, 1)
    expect(r.smoothed).toBeGreaterThan(4)
    expect(r.smoothed).toBeLessThan(8)
    expect(r.shortfall).not.toBeNull()
  })

  it('holds quiet while a healthy run merely dips for one window', () => {
    const r = new SimClockRate()
    const c = clocks()
    feed(r, c, 4, 4, SETTLE)
    expect(r.shortfall).toBeNull()
    feed(r, c, 1, 4, 1) // one bad window (a GC pause, a spawn burst)
    expect(r.shortfall).toBeNull()
  })

  it('clears once the machine catches up (hysteresis, not a latch)', () => {
    const r = new SimClockRate()
    const c = clocks()
    feed(r, c, 2, 4, SETTLE)
    expect(r.shortfall).toBe(2)
    feed(r, c, 4, 4, SETTLE) // same run, same clocks: no reset, purely the hysteresis exit
    expect(r.shortfall).toBeNull() // i.e. the EMA climbed back past the 95% exit
    expect(r.measured).toBeCloseTo(4, 1) // the raw window is already there; the EMA still trails
  })

  it('says nothing until the EMA has warmed up, so a start-up hitch cannot flash it', () => {
    const r = new SimClockRate()
    feed(r, clocks(), 0.4, 4, WARMUP - 2)
    expect(r.shortfall).toBeNull()
  })

  it('does not read a pause/hidden gap as a stall (reset drops the open window)', () => {
    const r = new SimClockRate()
    const c = clocks()
    feed(r, c, 4, 4, 1)
    r.reset() // SimClient.setPaused
    expect(r.measured).toBeNull()
    expect(r.smoothed).toBeNull()
    c.t += 30_000 // 30 s hidden: wall clock moved, the sim did not
    feed(r, c, 4, 4, SETTLE)
    expect(r.measured).toBeCloseTo(4, 1)
    expect(r.shortfall).toBeNull()
  })

  it('re-baselines when the world restarts and sim time goes back to zero', () => {
    const r = new SimClockRate()
    feed(r, clocks(), 1, 1, 2)
    // a fresh world on the same wall clock: sim time back at 0 must not read as a negative rate
    const c: Clocks = { t: 20_000, steps: 0 }
    feed(r, c, 1, 1, 2)
    expect(r.measured).toBeCloseTo(1, 1)
    expect(r.shortfall).toBeNull()
  })
})
