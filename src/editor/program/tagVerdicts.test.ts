import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT, type PartPackage } from '../../core/parts/partPackage'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartInstance } from '../../core/types'
import { programTagNames, programTagVerdicts, type ProgramCheck } from './tagVerdicts'

const PROGRAM = `VAR
  Motor : BOOL;
  Infeed : INT;
END_VAR
Motor := TRUE;`

const check = (source: string, over: Partial<ProgramCheck> = {}): ProgramCheck => ({ source, dialect: undefined, controller: null, scanMs: 10, ...over })
const part = (id: string, params: Record<string, unknown>): PartInstance => ({ id, type: 'part', packageId: 'x', params }) as unknown as PartInstance

describe('programTagVerdicts', () => {
  beforeAll(() =>
    registerPackage({
      format: PACKAGE_FORMAT,
      id: 'x',
      name: 'X',
      commsParam: 'enableComms',
      params: {
        enableComms: { type: 'boolean', default: false },
        runTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '' },
        speedTag: { type: 'tag', dir: 'in', stType: 'REAL', default: '' },
      },
      behavior: 'definePart({ step(){} })',
      geometry: { kind: 'rig', links: [], joints: [], bounds: { length: 1, width: 1, top: 1 } },
    } as PartPackage),
  )
  afterAll(() => clearPackages())

  it('says which wired names the program declares, and as what', () => {
    const v = programTagVerdicts([part('c1', { enableComms: true, runTag: 'Motor', speedTag: 'Infeed' }), part('c2', { enableComms: true, runTag: 'Motr' })], check(PROGRAM))
    expect(v.get('Motor')).toEqual({ declared: true, type: 'BOOL' })
    expect(v.get('Infeed')).toEqual({ declared: true, type: 'INT' })
    expect(v.get('Motr')).toEqual({ declared: false })
  })

  it('says nothing of a part with comms off', () => {
    expect(programTagVerdicts([part('c1', { enableComms: false, runTag: 'Motr' })], check(PROGRAM)).size).toBe(0)
  })

  it('says nothing without a program it can compile', () => {
    const parts = [part('c1', { enableComms: true, runTag: 'Motr' })]
    expect(programTagVerdicts(parts, check('')).size).toBe(0)
    expect(programTagVerdicts(parts, check('VAR Motor : BOOL END_VAR')).size).toBe(0)
    expect(programTagVerdicts(parts, check(PROGRAM, { dialect: 'other' })).size).toBe(0)
  })
})

const LINE = `PROGRAM Line
VAR
  Run : BOOL;
  Speed : REAL;
  Timer : TON;
END_VAR
VAR CONSTANT
  Max : REAL := 2.0;
END_VAR
Run := Speed < Max;
END_PROGRAM
`

describe('programTagNames', () => {
  it('lists what a part can be wired to, a sole instance by bare name', () => {
    expect(programTagNames(check(PROGRAM))).toEqual([
      { name: 'Motor', type: 'BOOL' },
      { name: 'Infeed', type: 'INT' },
    ])
    expect(programTagNames(check(LINE))).toEqual([
      { name: 'Run', type: 'BOOL' },
      { name: 'Speed', type: 'REAL' },
    ])
  })

  it("lists each instance's variables by their qualified names", () => {
    const two = `${LINE}
CONFIGURATION Cell
  RESOURCE Cpu ON PLC
    TASK Fast (INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM Line1 WITH Fast : Line;
    PROGRAM Line2 WITH Fast : Line;
  END_RESOURCE
END_CONFIGURATION
`
    expect(programTagNames(check(two))?.map((t) => t.name).sort()).toEqual(['Line1.Run', 'Line1.Speed', 'Line2.Run', 'Line2.Speed'])
  })

  it('is null when the program does not compile', () => {
    expect(programTagNames(check('VAR Motor : BOOL END_VAR'))).toBeNull()
  })
})
