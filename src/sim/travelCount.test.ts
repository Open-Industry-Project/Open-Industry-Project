import { describe, expect, it } from 'vitest'
import { advanceTravel, newTravelCount, writeTravel } from './travelCount'

// What the conveyors counted in their own code before the host took the count over (conveyorDrive.js publishDrive):
// travel in inches against a pitch in inches. A program that tracks cargo by a conveyor's pulses was written against
// this, so the host's count has to give the same pulse on the same step and the same odometer.
function countedInThePart(): { step(v: number, dt: number, inchesPerPulse: number): { pulse: boolean; odo: number } } {
  let pulseTravel = 0
  let odo = 0
  return {
    step(v, dt, inchesPerPulse) {
      const pitch = inchesPerPulse > 0 ? inchesPerPulse : 1
      pulseTravel += (Math.abs(v) * dt) / 0.0254
      const pulse = pulseTravel >= pitch - 1e-9
      if (pulse) pulseTravel = Math.max(0, pulseTravel - pitch * Math.max(1, Math.floor(pulseTravel / pitch + 1e-9)))
      odo += v * dt
      return { pulse, odo }
    },
  }
}

describe('the travel the host counts for a part', () => {
  it('pulses on the steps, and reads the odometer, a conveyor counting in its own code did', () => {
    let seed = 99
    const rnd = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) | 0
      return ((seed >>> 8) & 0xffff) / 0x10000
    }
    let pulses = 0
    for (const inches of [1, 0.5, 0.25, 0.05, 2, 3.7, 12]) {
      for (const dt of [1 / 60, 1 / 100, 1 / 240]) {
        const part = countedInThePart()
        const host = newTravelCount()
        host.pitch = inches * 0.0254
        host.on = true
        let v = 0
        for (let step = 0; step < 40_000; step++) {
          // a drive: steady for a while, then ramping to another speed, some of them reversed or stopped, and
          // speeds that divide a pitch exactly (60 FPM at 100 steps a second is twelve hundredths of an inch a step)
          if (step % 700 === 0) v = [0, 0.3048, 0.5, 1.524, -0.8, 2.54, 0.0254 * 12, rnd() * 3][Math.floor(rnd() * 8)]!
          else if (step % 700 < 60) v += (rnd() - 0.5) * 0.02
          const want = part.step(v, dt, inches)
          host.speed = v
          const pulse = advanceTravel(host, dt)
          if (pulse !== want.pulse || host.odo !== want.odo) throw new Error(`pitch ${inches} in, dt ${dt}, step ${step}: host ${pulse} ${host.odo}, part ${want.pulse} ${want.odo}`)
          if (pulse) pulses++
        }
      }
    }
    expect(pulses).toBeGreaterThan(10_000)
  })

  it('writes the tags it was given, and only those', () => {
    const t = newTravelCount()
    t.speed = 1
    t.pitch = 0.5
    t.encoderKey = 'Enc'
    const tags: Record<string, number | boolean> = { Running: true }
    writeTravel(t, advanceTravel(t, 0.25), tags)
    expect(tags).toEqual({ Running: true, Enc: 0.25 })
    t.pulseKey = 'Pulse'
    writeTravel(t, advanceTravel(t, 0.25), tags)
    expect(tags).toEqual({ Running: true, Enc: 0.5, Pulse: true })
  })
})
