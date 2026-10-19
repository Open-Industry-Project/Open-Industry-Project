import { DEFAULT_SIM_HZ } from '../core/types'

/**
 * The most steps one worker tick may run before it sheds backlog: the step loop's anti death-spiral cap
 * ([worker.ts](./worker.ts)).
 *
 * It is ~50 ms of real time (3 steps at the default rate), scaled by the speed multiplier, so a fast-forward
 * can still run its extra steps. It is also scaled by the step rate, because the loop's tick does not scale
 * with it: the interval fires every 8 ms whatever the rate, so at 240 Hz one late tick is already three steps
 * behind. A flat cap of 3 would shed real time on every hitch and silently run a 240 Hz scene slow. Never
 * below 3, so slow motion keeps the default rate's headroom.
 */
export function catchUpSteps(timeScale: number, hz: number): number {
  return Math.max(3, Math.ceil((3 * timeScale * hz) / DEFAULT_SIM_HZ))
}
