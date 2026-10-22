import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT, type PartPackage } from '../../core/parts/partPackage'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartInstance } from '../../core/types'
import { programTagVerdicts, type ProgramCheck } from './tagVerdicts'

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
