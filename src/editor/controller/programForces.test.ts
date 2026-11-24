import { describe, expect, it } from 'vitest'
import { announceDroppedForces, forcePlcValue, keptForces, ProgramState, releasePlcForces, togglePlcBit, writePlcValue, type PlcWriteDeps } from './program'

// The controller's side of forcing (controller/program.ts): what a write to a forced variable does, and which forces
// a reloaded program keeps. The hold itself is LocalPlcLink's (plc.test.ts); the path to the worker is e2e/verify-plc-force.mjs.

/** A stand-in for the sim client: the force table it holds, and the one-time writes it was asked for. */
function deps(watch: Record<string, number | boolean>): PlcWriteDeps & { writes: string[]; told: number[] } {
  const p = new ProgramState()
  const told = [0]
  p.forceWatchers.add(() => told[0]!++)
  const sim = {
    forces: {} as Readonly<Record<string, number | boolean>>,
    plcState: null,
    setForces(f: Readonly<Record<string, number | boolean>>) {
      this.forces = { ...f }
    },
    forceTag(name: string, value: number | boolean) {
      writes.push(`${name}=${String(value)}`)
    },
  }
  const writes: string[] = []
  return { ec: { plcProgramWatch: watch, sim } as unknown as PlcWriteDeps['ec'], p, writes, told }
}

describe('forcing, controller side', () => {
  it('a write to an unforced variable is one write; to a forced one, it changes the held value', () => {
    const d = deps({ Run: false, Speed: 1.5 })
    expect(writePlcValue(d, 'Speed', '2')).toBeNull()
    expect(d.writes).toEqual(['Speed=2'])
    expect(forcePlcValue(d, 'Speed')).toBeNull()
    expect(d.ec.sim.forces).toEqual({ Speed: 1.5 })
    expect(writePlcValue(d, 'Speed', '0.8')).toBeNull()
    expect(d.ec.sim.forces).toEqual({ Speed: 0.8 })
    expect(d.writes).toEqual(['Speed=2'])
    expect(d.told[0]).toBe(2)
  })

  it('one bit of a forced word changes that bit in the held word, which a one-time write could not', () => {
    const d = deps({ Status: 0b0101 })
    expect(forcePlcValue(d, 'Status')).toBeNull()
    expect(togglePlcBit(d, 'Status.1')).toBe(true)
    expect(d.ec.sim.forces).toEqual({ Status: 0b0111 })
    expect(writePlcValue(d, 'Status.0', '0')).toBeNull()
    expect(d.ec.sim.forces).toEqual({ Status: 0b0110 })
    expect(d.writes).toEqual([])
  })

  it('release takes one force, or every one', () => {
    const d = deps({ A: true, B: 3 })
    forcePlcValue(d, 'A')
    forcePlcValue(d, 'B')
    releasePlcForces(d, 'A')
    expect(d.ec.sim.forces).toEqual({ B: 3 })
    releasePlcForces(d)
    expect(d.ec.sim.forces).toEqual({})
  })

  it('a reloaded program keeps the forces it has a value of the same kind for, and drops the rest', () => {
    const forces = { Run: true, Speed: 0.5, Gone: true, Status: 3 }
    // Run is still a BOOL, Speed is now a BOOL, Gone was removed, Status is the same word
    expect(keptForces(forces, { Run: false, Speed: false, Status: 0 })).toEqual({ Run: true, Status: 3 })
    // nothing to drop: the same object, so the caller sends nothing
    expect(keptForces(forces, { Run: false, Speed: 1, Gone: false, Status: 0 })).toBe(forces)
  })

  it('an attach names the forces it dropped, and says nothing when it dropped none', () => {
    const shown: { title: string; message: string }[] = []
    const store = { showSaveNotice: (title: string, message: string) => void shown.push({ title, message }) }
    announceDroppedForces(store, [])
    expect(shown).toEqual([])
    announceDroppedForces(store, ['Gone'])
    expect(shown[0]).toEqual({ title: 'Forces released', message: 'Released Gone: the program no longer has that variable with the same type.' })
    announceDroppedForces(store, ['A', 'B', 'C', 'D', 'E', 'F'])
    expect(shown[1]).toEqual({ title: 'Forces released', message: 'Released A, B, C, D and 2 more: the program no longer has those variables with the same type.' })
  })
})

describe('64-bit values, controller side', () => {
  it('writes a whole number a number holds, and refuses one past 2^53 by name', () => {
    const d = deps({ Total: 5 })
    expect(writePlcValue(d, 'Total', '9007199254740991')).toBeNull()
    expect(writePlcValue(d, 'Total', '9007199254740993')).toMatch(/past 2\^53/)
    expect(writePlcValue(d, 'Total', '16#FFFF_FFFF_FFFF_FFFF')).toMatch(/past 2\^53/)
    // a number written with an exponent is a real's, and goes as the nearest number it is
    expect(writePlcValue(d, 'Total', '1e20')).toBeNull()
    expect(d.writes).toEqual(['Total=9007199254740991', 'Total=100000000000000000000'])
  })

  it('a variable past 2^53 reads as its digits: it takes a number, and is not held as it stands', () => {
    const d = deps({ Total: '9223372036854775807' } as unknown as Record<string, number | boolean>)
    expect(writePlcValue(d, 'Total', '12')).toBeNull()
    expect(d.writes).toEqual(['Total=12'])
    expect(forcePlcValue(d, 'Total')).toMatch(/past 2\^53/)
    expect(forcePlcValue(d, 'Total', '7')).toBeNull()
    expect(d.ec.sim.forces).toEqual({ Total: 7 })
    // the force outlives a reload while the variable is still a number's
    expect(keptForces({ Total: 7 }, { Total: '9223372036854775807' })).toEqual({ Total: 7 })
  })

  it('reads and changes a bit past 31 of a 64-bit word', () => {
    const d = deps({ Mask: 2 ** 40 + 1 })
    expect(forcePlcValue(d, 'Mask')).toBeNull()
    // bit 40 is set, bit 8 (40 modulo 32) is not: toggling 40 clears it
    expect(togglePlcBit(d, 'Mask.40')).toBe(true)
    expect(d.ec.sim.forces).toEqual({ Mask: 1 })
    expect(togglePlcBit(d, 'Mask.35')).toBe(true)
    expect(d.ec.sim.forces).toEqual({ Mask: 2 ** 35 + 1 })
    // bit 63 would take the held word past what a force carries: the force stays as it is
    expect(togglePlcBit(d, 'Mask.63')).toBe(true)
    expect(d.ec.sim.forces).toEqual({ Mask: 2 ** 35 + 1 })
  })
})
