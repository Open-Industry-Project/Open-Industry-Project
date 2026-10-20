import { describe, expect, it } from 'vitest'
import { programTagChoices, rankTagNames } from './tagSuggest'
import { buildSections } from './tagField'
import type { TagSources } from './tagField'
import type { TagRow } from '../../../plc/tags'
import { plcTagListOf, readOpcUaTagList } from '../../links/externalPlc'
import type { OpcUaHost } from '../../links/externalPlc'

describe('ranking a tag field\'s suggestions', () => {
  const names = ['Sorter.Motor', 'Sorter.MotorFault', 'Packer.Motor', 'Line2.ConveyorMotor', 'MotorSpeed', 'Sorter.Eye']

  it('puts the name itself first, then a last segment that starts with it, then a contained one', () => {
    expect(rankTagNames('motor', names, 10).shown).toEqual(['MotorSpeed', 'Packer.Motor', 'Sorter.Motor', 'Sorter.MotorFault', 'Line2.ConveyorMotor'])
    expect(rankTagNames('Packer.Motor', names, 10).shown[0]).toBe('Packer.Motor')
  })

  it('shows at most the limit and says how many more fit', () => {
    expect(rankTagNames('motor', names, 2)).toEqual({ shown: ['MotorSpeed', 'Packer.Motor'], more: 3 })
    expect(rankTagNames('', names, 2)).toEqual({ shown: names.slice(0, 2), more: 4 })
    expect(rankTagNames('zzz', names, 2)).toEqual({ shown: [], more: 0 })
  })
})

const row = (name: string, type: string, extra: Partial<TagRow> = {}): TagRow => ({ name, type, section: 'VAR', scope: { kind: 'controller' }, description: '', init: '', constant: false, offset: 0, ...extra })

describe('the program\'s tags a field offers', () => {
  const rows = [row('Start', 'BOOL'), row('Speed', 'REAL'), row('Limit', 'REAL', { constant: true }), row('Timer1', 'TON'), row('Local', 'BOOL', { scope: { kind: 'pou', name: 'Fb' } })]
  it('offers controller-scope variables of the field\'s type', () => {
    expect(programTagChoices(rows, 'BOOL')).toEqual([{ name: 'Start', type: 'BOOL' }])
    expect(programTagChoices(rows, 'REAL')).toEqual([{ name: 'Speed', type: 'REAL' }])
  })
  it('offers any bit or number when the field declares no type, never a block', () => {
    expect(programTagChoices(rows, undefined).map((c) => c.name)).toEqual(['Start', 'Speed'])
  })
})

describe('the sections of the list', () => {
  const variables = [
    { path: ['PLC1', 'MAIN', 'Motor'], nodeId: 'a' },
    { path: ['PLC1', 'MAIN', 'Eye'], nodeId: 'b' },
  ]
  const sources = (over: Partial<TagSources> = {}): TagSources => ({ program: '', plc: null, canReadPlc: true, readPlc: () => {}, plcLinked: true, ...over })

  it('lists a program tag the scene already uses once, under the scene', () => {
    const s = buildSections('', ['Motor1'], [{ name: 'Motor1', type: 'BOOL' }, { name: 'Start', type: 'BOOL' }], sources({ plcLinked: false }), '')
    expect(s.map((x) => x.id)).toEqual(['scene', 'program'])
    expect(s[1]!.rows).toEqual([{ kind: 'name', name: 'Start', detail: 'BOOL' }])
  })

  it('offers to read the PLC\'s tags before any have been read', () => {
    const s = buildSections('', [], [], sources(), '')
    expect(s).toHaveLength(1)
    expect(s[0]!.rows).toEqual([{ kind: 'action', label: 'Read the PLC\'s tags', run: expect.any(Function) }])
  })

  it('lists the PLC\'s tags only once something is typed', () => {
    const plc = plcTagListOf('opc.tcp://plc:4840', { variables, truncated: false })
    const idle = buildSections('', [], [], sources({ plc }), '')
    expect(idle[0]!.title).toBe('On the PLC (2 tags)')
    expect(idle[0]!.rows.filter((r) => r.kind === 'name')).toEqual([])
    expect(idle[0]!.notes).toEqual(['Type to search them.'])
    const typed = buildSections('mot', [], [], sources({ plc }), '')
    expect(typed[0]!.rows.filter((r) => r.kind === 'name')).toEqual([{ kind: 'name', name: 'Motor' }])
  })

  it('says when the PLC holds more than was read', () => {
    const plc = plcTagListOf('opc.tcp://plc:4840', { variables, truncated: true })
    expect(buildSections('e', [], [], sources({ plc, canReadPlc: false }), '')[0]!.notes).toEqual([expect.stringContaining('more tags than were read')])
  })

  it('leaves the PLC out when the link is not OPC UA', () => {
    expect(buildSections('', [], [], sources({ plcLinked: false }), '')).toEqual([])
  })
})

describe('reading the PLC\'s tags while stopped', () => {
  const host = (over: Partial<OpcUaHost> = {}): OpcUaHost & { closed: number } => {
    const h = {
      closed: 0,
      connect: async () => ({ error: '' }),
      browse: async () => ({ error: '', variables: [{ path: ['PLC1', 'MAIN', 'Eye'], nodeId: 'e' }], truncated: false }),
      describe: async () => ({ error: '', nodes: [] }),
      exchange: async () => ({ error: '' }),
      close: async () => {
        h.closed++
      },
      onClosed: () => () => {},
      ...over,
    }
    return h
  }

  it('connects, browses and lets go', async () => {
    const h = host()
    const list = await readOpcUaTagList(h, 'opc.tcp://plc:4840', () => true)
    expect(list).toMatchObject({ state: 'ready', names: ['Eye'], truncated: false })
    expect(h.closed).toBe(1)
  })

  it('never closes a link a run has taken over meanwhile', async () => {
    const h = host()
    await readOpcUaTagList(h, 'opc.tcp://plc:4840', () => false)
    expect(h.closed).toBe(0)
  })

  it('says why it could not read', async () => {
    expect(await readOpcUaTagList(host({ connect: async () => ({ error: 'refused' }) }), 'opc.tcp://plc:4840', () => true)).toMatchObject({ state: 'failed', error: 'refused' })
    const lds = await readOpcUaTagList(host({ connect: async () => ({ error: '', discovery: [] }) }), 'opc.tcp://pc:4840', () => true)
    expect(lds.error).toMatch(/discovery server/)
  })
})
