/**
 * Achieved sim-clock rate: how much sim time the worker actually advanced per real second.
 *
 * The speed multiplier is a target the step loop may not reach. The step loop accrues scaled real time and
 * runs fixed steps at the world's rate ([worker.ts](./worker.ts)), so sustaining Nx needs `hz * N`
 * steps per real second. A machine that can't keep up sheds the backlog (`acc = 0`), so the world advances
 * slower than the number on the button. Nothing about such a run is wrong: physics and the interleaved
 * PLC scan shed together, so sim time stays exact and every measurement derived from it holds
 * (see docs/sim-clock.md). But wall-clock progress silently falls short of what was asked for,
 * and the silence is the problem. This measures the shortfall so the UI can name it.
 *
 * Fed one sample per posted frame (~125/s); it closes a window every {@link CLOCK_WINDOW_MS} and
 * holds that reading until the next one closes.
 */

/** measurement window. Long enough that step quantisation (1/60 s) is a few % at 0.5x. */
export const CLOCK_WINDOW_MS = 500

// A single window is noisy, and not because the meter is sloppy: the step loop itself is bursty.
// A tick delayed by a GC pause or a heavy step leaves time accrued in `acc` and the next tick runs
// it off up to `maxSteps`, so windows alternate low and high, and a window can even read above the
// requested scale. Judging raw windows therefore fails both ways: consecutive-window counting never
// latches when the readings alternate across the threshold (a machine sustaining 6x of a requested
// 8x stays silent), and any value shown from one window jitters. So the verdict, and any number
// shown to a user, comes off an EMA, never off `measured`.
const SMOOTHING = 0.3 // per window; ~3-window (1.5 s) time constant
const WARMUP_WINDOWS = 3 // until then the EMA is still mostly its seed window
// Hysteresis: enter below 85% of the requested scale, leave above 95%.
const SHORT_ENTER = 0.85
const SHORT_EXIT = 0.95

export class SimClockRate {
  /** sim seconds advanced per real second over the last closed window; null until one closes.
   *  Raw and jittery by nature - for diagnostics, not for display. */
  measured: number | null = null
  /** {@link measured} smoothed across windows: the rate the sim is actually sustaining */
  smoothed: number | null = null
  /** {@link smoothed}, rounded to 0.1 (a stable value for UI state), while the worker is
   *  persistently failing to keep up with the requested scale; null while it is keeping up */
  shortfall: number | null = null

  private base: { real: number; sim: number } | null = null
  private windows = 0
  private short = false

  /** drop the open window. Call whenever real time passes without the sim stepping (pause, tab
   *  hidden) or the target moves (start, stop, a speed change) - the gap is not a stall. */
  reset(): void {
    this.base = null
    this.measured = null
    this.smoothed = null
    this.shortfall = null
    this.windows = 0
    this.short = false
  }

  /** @param realMs wall clock (performance.now()) @param simTime the frame's sim time, seconds
   *  @param requested the commanded speed multiplier */
  sample(realMs: number, simTime: number, requested: number): void {
    const base = this.base
    // no baseline yet, or either clock went backwards (a fresh world) - open a window here
    if (!base || simTime < base.sim || realMs < base.real) {
      this.base = { real: realMs, sim: simTime }
      return
    }
    const dReal = realMs - base.real
    if (dReal < CLOCK_WINDOW_MS) return
    this.base = { real: realMs, sim: simTime }
    const measured = ((simTime - base.sim) * 1000) / dReal
    this.measured = measured
    this.smoothed = this.smoothed === null ? measured : this.smoothed + (measured - this.smoothed) * SMOOTHING
    if (++this.windows < WARMUP_WINDOWS) return
    const ratio = requested > 0 ? this.smoothed / requested : 1
    if (ratio < SHORT_ENTER) this.short = true
    else if (ratio > SHORT_EXIT) this.short = false
    this.shortfall = this.short ? Math.round(this.smoothed * 10) / 10 : null
  }
}
