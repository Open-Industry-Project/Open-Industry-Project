import { describe, expect, it } from 'vitest'
import type { AssemblySlot } from './parts/partPackage'
import { aabbOverlap, bodyAabb, openSlots, reachesSlot, slotWorld, turnBetween } from './cargoAssembly'
import { qFromAxisAngle } from './rig/rigPose'
import type { Quat, Vec3 } from './rig/rigPose'

// Whether a loose piece has reached its slot on an assembly base (partPackage.ts AssemblyDecl).

const I: Quat = [0, 0, 0, 1]
const yaw = (deg: number): Quat => qFromAxisAngle([0, 1, 0], (deg * Math.PI) / 180)
const HALF: Vec3 = [0.05, 0.005, 0.03]
const slot: AssemblySlot = { name: 'pcb', part: 'acme.pcb', at: [0, 0.01, 0] }

describe('reaching an assembly slot', () => {
  it('grows a turned box and keeps a square one', () => {
    expect(bodyAabb([0, 0, 0], I, HALF).max).toEqual([0.05, 0.005, 0.03])
    const turned = bodyAabb([0, 0, 0], yaw(90), HALF)
    expect(turned.max[0]).toBeCloseTo(0.03)
    expect(turned.max[2]).toBeCloseTo(0.05)
    expect(aabbOverlap(bodyAabb([0, 0, 0], I, HALF), bodyAabb([0.1, 0, 0], I, HALF))).toBe(false) // touching faces
  })

  it('puts a slot where the base is, turned with it', () => {
    const w = slotWorld([1, 2, 3], yaw(90), { ...slot, at: [0.1, 0.01, 0] })
    expect(w.p[0]).toBeCloseTo(1)
    expect(w.p[1]).toBeCloseTo(2.01)
    expect(w.p[2]).toBeCloseTo(2.9)
    expect(turnBetween(w.q, yaw(90))).toBeCloseTo(0)
  })

  it('catches a piece whose box overlaps the slot, within the tolerance and no further', () => {
    expect(reachesSlot([0, 0, 0], I, slot, [0.09, 0.01, 0], I, HALF)).toBe(true)
    expect(reachesSlot([0, 0, 0], I, slot, [0.102, 0.01, 0], I, HALF)).toBe(true) // 2 mm clear, inside the 3 mm default
    expect(reachesSlot([0, 0, 0], I, slot, [0.104, 0.01, 0], I, HALF)).toBe(false)
    expect(reachesSlot([0, 0, 0], I, { ...slot, tolerance: 0 }, [0.102, 0.01, 0], I, HALF)).toBe(false)
  })

  it('holds a piece to the reach and the turn a slot sets', () => {
    expect(reachesSlot([0, 0, 0], I, { ...slot, reach: 0.02 }, [0.09, 0.01, 0], I, HALF)).toBe(false)
    expect(reachesSlot([0, 0, 0], I, { ...slot, reach: 0.02 }, [0.015, 0.012, 0], I, HALF)).toBe(true)
    expect(reachesSlot([0, 0, 0], I, slot, [0, 0.012, 0], yaw(90), HALF)).toBe(true) // any way round by default
    expect(reachesSlot([0, 0, 0], I, { ...slot, maxTurn: 20 }, [0, 0.012, 0], yaw(90), HALF)).toBe(false)
    expect(reachesSlot([0, 0, 0], I, { ...slot, maxTurn: 20 }, [0, 0.012, 0], yaw(8), HALF)).toBe(true)
    // the turn is measured against the slot on the base as it stands, so a base turned with the piece still takes it
    expect(reachesSlot([0, 0, 0], yaw(90), { ...slot, maxTurn: 20 }, [0, 0.012, 0], yaw(95), HALF)).toBe(true)
  })

  it('opens a slot once the ones it comes after are filled', () => {
    const decl = { slots: [slot, { ...slot, name: 'top', after: ['pcb'] }] }
    expect(openSlots(decl, new Set()).map((s) => s.name)).toEqual(['pcb'])
    expect(openSlots(decl, new Set(['pcb'])).map((s) => s.name)).toEqual(['top'])
    expect(openSlots(decl, new Set(['pcb', 'top']))).toEqual([])
  })
})
