import { describe, expect, it } from 'vitest'
import { HitchCounter } from './frameHitch'

const feed = (h: HitchCounter, ms: number, n: number) => {
  for (let i = 0; i < n; i++) h.push(ms / 1000)
}

describe('HitchCounter', () => {
  it('counts nothing on a steady cadence, whatever the cadence is', () => {
    const fast = new HitchCounter()
    feed(fast, 16.7, 600)
    expect(fast.missed).toBe(0)
    // a uniformly slower run is not hitching either; it re-baselines
    const slow = new HitchCounter()
    feed(slow, 23.9, 600)
    expect(slow.missed).toBe(0)
  })

  it('counts a real stall', () => {
    const h = new HitchCounter()
    feed(h, 16.7, 120)
    h.push(0.142) // the 142 ms pipeline compile a phone actually saw
    expect(h.missed).toBe(1)
    feed(h, 16.7, 120)
    expect(h.missed).toBe(1)
  })

  it('is not fooled by a 120 Hz panel occasionally delivering a fast frame', () => {
    // The bug this class exists for. A running-minimum baseline would drop to the 9.7 ms outlier, putting
    // the threshold at 14.6 ms (under the app's healthy 16.7 ms cadence), so every normal frame after it
    // would count as missed: 473 "missed frames" on a real device, in a window whose p95 was 18.1 ms and
    // whose worst frame was 24 ms.
    const h = new HitchCounter()
    for (let dip = 0; dip < 17; dip++) {
      feed(h, 16.7, 100)
      h.push(0.0097) // ProMotion delivers one frame at a full 120 Hz step
    }
    expect(h.missed).toBe(0)
  })

  it('re-baselines when the device throttles instead of reporting every frame as a hitch', () => {
    const h = new HitchCounter()
    feed(h, 16.7, 200) // pre-throttle
    feed(h, 23.9, 400) // the phone settles 40% slower - steady, not janky
    // only the handful of frames spanning the transition may count, never the new steady state
    expect(h.missed).toBeLessThan(10)
    const atTransition = h.missed
    feed(h, 23.9, 400)
    expect(h.missed).toBe(atTransition)
  })

  it('says nothing until it has enough samples to have an opinion', () => {
    const h = new HitchCounter()
    h.push(0.2) // a huge first frame, with no baseline to judge it against
    expect(h.missed).toBe(0)
  })

  it('exposes the baseline it is judging against', () => {
    const h = new HitchCounter()
    feed(h, 16.7, 100)
    expect(h.baselineSec).toBeCloseTo(0.0167, 4)
  })
})
