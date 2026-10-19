/**
 * The shared sim-animation clock: sim-time seconds, the one per-frame value behind every
 * shader-integrated part animation (belt-fabric scroll, roller spin).
 *
 * These animations are all `∫rate·dt`, so the CPU does not re-derive them per frame. Each consumer
 * stores `(base, rate)` per instance, in a buffer that only changes when the rate changes, and the
 * shader evaluates `base + rate·clock`. The per-frame host cost for the whole scene is this one uniform,
 * instead of O(parts) or O(instances) writes.
 *
 * The clock wraps so `rate × clock` stays small in float32. A fast belt is ~10 texture-periods/s and
 * a fast roller ~20 rad/s, so one 64 s window peaks in the hundreds, where the ulp is ~1e-4
 * (sub-millimetre, far below a visible rotation step). An unwrapped clock visibly quantises after an
 * hour of running. Every wrap bumps `animClockEpoch()`, which consumers poll to add the
 * `rate × WRAP` the shader just lost back into their base (see rebaseSpinForWrap).
 *
 * Advanced once per running frame from view.tickBody, before the part ticks, so every consumer's rebase
 * sees a wrap in the frame it happens. Not wall-clock: a paused worker sends no frames, so the delta is 0
 * and everything freezes together (docs/sim-clock.md).
 */

const CLOCK_WRAP = 64

let clock = 0
let epoch = 0

/** WebGL: the one shared uniform object handed to every consumer's compiled shader. */
export const animClockUniform = { value: 0 }

// WebGPU: the TSL twin's uniform is in the shared TICK group. createRenderer injects the sink so this
// module (which the WebGL bundle imports) never pulls in three/webgpu.
let clockSink: ((v: number) => void) | null = null
export function setAnimClockSink(sink: ((v: number) => void) | null): void {
  clockSink = sink
}

/**
 * The clock's current value, in sim-time seconds since the last wrap.
 *
 * Exported for the same reason IRenderViewTestSurface exists. Every shader-integrated animation is
 * `base + rate × clock`, so this number is the only CPU-visible evidence that the scene is animating.
 * No material property moves per frame, so a gate asking "does the belt scroll while running and stop
 * while paused" has nothing else to read (e2e/verify-pause-freezes-conveyors.mjs).
 */
export function animClockValue(): number {
  return clock
}

/** wrap generation: on a bump every consumer adds `rate × CLOCK_WRAP` to its base */
export function animClockEpoch(): number {
  return epoch
}

/** Advance by one frame of sim time. Callers gate on the sim actually running. */
export function advanceAnimClock(dt: number): void {
  if (!(dt > 0)) return
  clock += dt
  // dt is capped at 0.1 s upstream, so at most one wrap happens per frame
  if (clock >= CLOCK_WRAP) {
    clock -= CLOCK_WRAP
    epoch++
  }
  animClockUniform.value = clock
  clockSink?.(clock)
}

/**
 * Re-express `(base, rate)` against `nextRate` without a visible jump: keep the value the consumer
 * shows at this instant and solve for the base that reproduces it under the new rate. `fold` is the
 * period to wrap the base into (1 texture period for scroll, 2π for a spin angle). The sampler and
 * rotation are periodic, so dropping whole periods is invisible and keeps the base within float
 * precision over a long session.
 */
export function rebaseAnim(base: number, rate: number, nextRate: number, fold: number): number {
  return (base + (rate - nextRate) * clock) % fold
}

/** Carry a base across `wraps` clock wraps. The clock dropped by `wraps × CLOCK_WRAP`, so the base adds
 *  exactly what the shader's `rate × clock` term lost. */
export function rebaseAnimForWrap(base: number, rate: number, wraps: number, fold: number): number {
  return (base + rate * CLOCK_WRAP * wraps) % fold
}
