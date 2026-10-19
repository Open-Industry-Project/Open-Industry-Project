/// <reference types="vite/client" />
import { afterEach, describe, expect, it } from 'vitest'
import { create, destroy, stepDirect } from './embeddedBehavior'
import type { BehaviorOutput } from './embeddedBehavior'

// The committed diverter behavior (examples/parts/diverter), driven directly through the embeddable runtime
// (no Jolt/world). Pins the panel indicators: the housing models two lens materials (LampRed + LampGreen),
// which read as painted plastic unless the behavior drives them. They follow the home end-of-stroke, the way
// a real pusher's reed switches do: green while the blade is home, red from the moment it leaves until it is
// fully back, through the whole travel, both directions.
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
const SOURCE = BEHAVIORS['../../examples/parts/diverter/behavior.ts']!.replace(/\r\n/g, '\n')

const DT = 1 / 60
const DIVERT_SECONDS = 0.25 // the `divertTime` param's DEFAULT full-stroke travel

describe('diverter behavior - the two panel lamps', () => {
  let h = 0
  afterEach(() => {
    if (h > 0) destroy(h)
    h = 0
  })

  const tick = (used = false): BehaviorOutput =>
    stepDirect(h, { simTime: 0, position: [0, 0, 0], forward: [1, 0, 0], tags: {}, used }, DT)!

  it('sits green at rest - the blade is home and the lane is clear', () => {
    h = create(SOURCE, '{}')
    const out = tick()
    expect(out.lamps['green']).toBe(true)
    expect(out.lamps['red']).toBe(false)
    expect(out.joints['ext3']).toBe(0)
  })

  it('an authored `diverted: true` seeds red - the stopped-scene idle preview matches the extended arms', () => {
    h = create(SOURCE, JSON.stringify({ diverted: true }))
    const out = tick()
    expect(out.lamps['red']).toBe(true)
    expect(out.lamps['green']).toBe(false)
    expect(out.joints['ext3']).toBeGreaterThan(0)
  })

  it('swaps to red on the first tick of travel, not on arrival - the lane is blocked the whole stroke', () => {
    h = create(SOURCE, '{}')
    tick() // settled home, green
    const first = tick(true) // Use → the blade starts moving out
    expect(first.joints['ext3']).toBeGreaterThan(0)
    expect(first.joints['ext3']).toBeLessThan(0.75) // still mid-travel, nowhere near the 0.75 m default stroke
    expect(first.lamps['red']).toBe(true)
    expect(first.lamps['green']).toBe(false)
  })

  it('stays red all the way back and returns to green only once the blade is fully home', () => {
    h = create(SOURCE, JSON.stringify({ diverted: true }))
    tick() // settled extended, red
    let out = tick(true) // Use → retract
    let ticks = 0
    while (out.joints['ext3']! > 0 && ticks < 120) {
      expect(out.lamps['red']).toBe(true) // mid-retraction the blade is still in the lane
      expect(out.lamps['green']).toBe(false)
      out = tick()
      ticks++
    }
    expect(out.joints['ext3']).toBe(0) // home
    expect(out.lamps['green']).toBe(true)
    expect(out.lamps['red']).toBe(false)
    expect(ticks).toBeLessThanOrEqual(Math.ceil(DIVERT_SECONDS / DT) + 2) // one stroke, not a stall
  })
})
