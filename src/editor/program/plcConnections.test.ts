import { afterEach, describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import type { PartPackage } from '../../core/parts/partPackage'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartInstance, SceneJSON } from '../../core/types'
import type { PlcSetup } from '../store/storePlcs'
import { browsableControllers, connectionMachines, connectionsOf, withConnection } from './plcConnections'

const DIVERTER: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 't.diverter',
  name: 'Diverter',
  params: {
    tag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Extend tag' },
    doneTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Done tag' },
  },
  behavior: 'definePart({step(){}})',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0] }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
}
const diverter = (id: string, params: Record<string, unknown>) => ({ id, name: id, type: 'part', packageId: 't.diverter', position: [0, 0, 0], rotationY: 0, params }) as unknown as PartInstance
const scene = (...parts: PartInstance[]) => ({ version: 1, parts }) as unknown as SceneJSON

afterEach(() => clearPackages())

describe('the PLC connections window', () => {
  it('shows each field with its direction and what it is wired to on this controller', () => {
    registerPackage(DIVERTER)
    const s = scene(diverter('D1', { tag: 'MAIN.Extend', doneTag: 'Cell2::MAIN.Done' }))
    const [m] = connectionMachines(s.parts, null)
    expect(m!.fields).toEqual([
      { key: 'tag', label: 'Extend tag', dir: 'fromPlc', type: 'BOOL', variable: 'MAIN.Extend', elsewhere: undefined },
      { key: 'doneTag', label: 'Done tag', dir: 'toPlc', type: 'BOOL', variable: '', elsewhere: 'Cell2' },
    ])
    // the named controller sees the other one, its name ignoring case as IEC names do
    expect(connectionMachines(s.parts, 'cell2')[0]!.fields.map((f) => [f.variable, f.elsewhere])).toEqual([
      ['', null],
      ['MAIN.Done', undefined],
    ])
  })

  it('lists the connections of one controller', () => {
    registerPackage(DIVERTER)
    const s = scene(diverter('D1', { tag: 'MAIN.Extend', doneTag: '' }), diverter('D2', { tag: '', doneTag: 'MAIN.Done' }))
    expect(connectionsOf(connectionMachines(s.parts, null)).map((c) => `${c.machine} ${c.field} ${c.dir} ${c.variable}`)).toEqual([
      'D1 Extend tag fromPlc MAIN.Extend',
      'D2 Done tag toPlc MAIN.Done',
    ])
  })

  it('connects a field as its tag, with a named controller in front, and disconnects it again', () => {
    registerPackage(DIVERTER)
    const s = scene(diverter('D1', { tag: '', doneTag: '' }))
    const on = withConnection(s, 'D1', 'tag', 'Cell2', 'MAIN.Extend')!
    expect(on.parts[0]!.params).toEqual({ tag: 'Cell2::MAIN.Extend', doneTag: '' })
    expect(withConnection(on, 'D1', 'tag', 'Cell2', '')!.parts[0]!.params).toEqual({ tag: '', doneTag: '' })
    expect(withConnection(s, 'nope', 'tag', null, 'MAIN.Extend')).toBeNull()
  })

  it('offers only the controllers on a PLC over ADS', () => {
    const setup = {
      enabled: true,
      mode: 'ads',
      mainName: 'PLC1',
      adsNetId: '5.170.233.29.1.1',
      adsPort: 851,
      controllers: [
        { name: 'Cell2', runsOn: 'plc', mode: 'ads', adsNetId: '', adsPort: 852 },
        { name: 'Cell3', runsOn: 'app', mode: 'ads', adsNetId: '', adsPort: 851 },
        { name: 'Cell4', runsOn: 'plc', mode: 'opcua', adsNetId: '', adsPort: 851 },
      ],
    } as unknown as PlcSetup
    expect(browsableControllers(setup)).toEqual([
      { name: null, label: 'PLC1', netId: '5.170.233.29.1.1', port: 851 },
      { name: 'Cell2', label: 'Cell2', netId: '', port: 852 },
    ])
  })
})
