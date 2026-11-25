import { describe, expect, it } from 'vitest'
import { validatePartPackage } from './partValidate'

// What an assembly declaration (partPackage.ts AssemblyDecl) must be to load.

const base = {
  id: 'acme.base',
  name: 'Base',
  format: 6,
  params: { mass: { type: 'number', default: 1 } },
  behavior: 'definePart({ step() {} })',
  geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 0.1, width: 0.1, height: 0.02 } },
}
const slot = (name: string, extra: object = {}): object => ({ name, part: 'acme.piece', at: [0, 0.02, 0], ...extra })
const fields = (assembly: unknown, over: object = {}): string[] => validatePartPackage({ ...base, ...over, assembly } as never).map((p) => p.field)

describe('an assembly declaration', () => {
  it('loads with slots, an order, a fixture slot, a product name and what it becomes', () => {
    expect(fields({ product: 'phone', slots: [slot('a'), slot('b', { after: ['a'], reach: 0.01, maxTurn: 20, tolerance: 0.002, quat: [0, 0, 0, 1] }), slot('nest', { hold: true })], becomes: { part: 'acme.whole', at: [0, 0.01, 0] } })).toEqual([])
    expect(fields({ mode: 'loose', slots: [slot('a')] })).toEqual([])
  })

  it('is refused on a part that is not cargo, and when it is not an object with slots', () => {
    expect(fields({ slots: [slot('a')] }, { geometry: { kind: 'rig', links: [], joints: [] } })).toContain('assembly')
    expect(fields({})).toEqual(['assembly'])
    expect(fields({ slots: [slot('a')], mode: 'glued' })).toEqual(['assembly.mode'])
  })

  it('refuses a slot with no name, a name used twice, or the name of a mark the assembly sets', () => {
    expect(fields({ slots: [slot('')] })).toEqual(['assembly.slots[0].name'])
    expect(fields({ slots: [slot('a'), slot('a')] })).toEqual(['assembly.slots[1].name'])
    expect(fields({ slots: [slot('assembled')] })).toEqual(['assembly.slots[0].name'])
    expect(fields({ slots: [slot('occupied')] })).toEqual(['assembly.slots[0].name'])
  })

  it('refuses a place, a turn or a limit that is not what it must be', () => {
    expect(fields({ slots: [{ name: 'a', part: '', at: [0, 0] }] })).toEqual(['assembly.slots[0].part', 'assembly.slots[0].at'])
    expect(fields({ slots: [slot('a', { quat: [0, 0, 0, 2] })] })).toEqual(['assembly.slots[0].quat'])
    expect(fields({ slots: [slot('a', { tolerance: -1, reach: 0, maxTurn: 181, hold: 'yes' })] })).toEqual(['assembly.slots[0].tolerance', 'assembly.slots[0].reach', 'assembly.slots[0].maxTurn', 'assembly.slots[0].hold'])
  })

  it('refuses an order that names no other slot, or that comes back to itself', () => {
    expect(fields({ slots: [slot('a', { after: ['z'] })] })).toEqual(['assembly.slots'])
    expect(fields({ slots: [slot('a', { after: ['a'] })] })).toEqual(['assembly.slots'])
    expect(fields({ slots: [slot('a', { after: ['b'] }), slot('b', { after: ['a'] })] })).toEqual(['assembly.slots'])
  })

  it('refuses a product named as a slot or a mark, and a becomes that cannot be', () => {
    expect(fields({ product: 'a', slots: [slot('a')] })).toEqual(['assembly.product'])
    expect(fields({ product: 'assembled', slots: [slot('a')] })).toEqual(['assembly.product'])
    expect(fields({ slots: [slot('a')], becomes: {} })).toEqual(['assembly.becomes'])
    expect(fields({ slots: [slot('a')], becomes: { part: 'acme.base' } })).toEqual(['assembly.becomes.part'])
    expect(fields({ mode: 'loose', slots: [slot('a')], becomes: { part: 'acme.whole' } })).toEqual(['assembly.becomes'])
  })
})
