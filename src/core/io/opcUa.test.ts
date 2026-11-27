import { describe, expect, it } from 'vitest'
import { bindOpcUaPoints, builtinOf, closestOpcUaTagNames, discoveryServerMessage, fromOpcUaValue, matchOpcUaTag, MAX_BROWSE_ROOTS, opcUaBrowseRoot, opcUaPointsFromTags, opcUaTagNames, parseOpcUaBrowseRoots, tagSegments, toOpcUaValue } from './opcUa'
import type { OpcUaNodeInfo, OpcUaVariable } from './opcUa'

/**
 * Three made-up servers laying out the same program differently: deep under the DI companion spec's DeviceSet,
 * through a device name holding spaces, with string NodeIds; shallow under a runtime object; and in a global-data
 * folder with numeric NodeIds.
 */
const DEEP: OpcUaVariable[] = [
  { path: ['DeviceSet', 'Example Soft PLC', 'Resources', 'App', 'Programs', 'Main', 'Eye'], nodeId: 'ns=4;s=App.Main.Eye' },
  { path: ['DeviceSet', 'Example Soft PLC', 'Resources', 'App', 'Programs', 'Main', 'Run'], nodeId: 'ns=4;s=App.Main.Run' },
  { path: ['DeviceSet', 'Example Soft PLC', 'Resources', 'App', 'Programs', 'Packer', 'Run'], nodeId: 'ns=4;s=App.Packer.Run' },
]
const SHALLOW: OpcUaVariable[] = [{ path: ['Runtime1', 'Main', 'Eye'], nodeId: 'ns=4;s=Main.Eye' }]
const GLOBALS: OpcUaVariable[] = [{ path: ['Controller', 'GlobalData', 'Conveyor', 'Eye'], nodeId: 'ns=3;i=1007' }]

describe('which tags travel over OPC UA', () => {
  it('carries every named tag: written when a part publishes it, read when parts only read it', () => {
    const r = opcUaPointsFromTags([
      { name: 'Run', writers: [], readers: ['belt'], type: 'BOOL' },
      { name: 'Eye', writers: ['eye'], readers: ['lamp'], type: 'BOOL' },
      { name: 'Idle', writers: [], readers: [], type: null },
    ])
    expect(r.points).toEqual([
      { tag: 'Eye', dir: 'toPlc', type: 'BOOL' },
      { tag: 'Run', dir: 'fromPlc', type: 'BOOL' },
    ])
    expect(r.problems).toEqual([])
  })

  it('says an address is not a name', () => {
    const r = opcUaPointsFromTags([{ name: '%IX0.0', writers: ['eye'], readers: [], type: 'BOOL' }])
    expect(r.points).toEqual([])
    expect(r.problems).toEqual([expect.stringMatching(/%IX0.0 is an I\/O address/)])
  })
})

describe('finding a tag\'s node by name', () => {
  it('matches the end of the browse path, whatever the server puts above it', () => {
    expect(matchOpcUaTag('Main.Eye', DEEP)).toEqual({ variable: DEEP[0] })
    expect(matchOpcUaTag('Eye', DEEP)).toEqual({ variable: DEEP[0] })
    expect(matchOpcUaTag('Main.Eye', SHALLOW)).toEqual({ variable: SHALLOW[0] })
    // a quoted segment may hold a dot; the quotes are not part of the browse name
    expect(matchOpcUaTag('"Conveyor".Eye', GLOBALS)).toEqual({ variable: GLOBALS[0] })
    expect(tagSegments('"Line.1".Eye')).toEqual(['Line.1', 'Eye'])
  })

  it('ignores case as IEC names do, preferring the exact spelling', () => {
    expect(matchOpcUaTag('main.eye', DEEP)).toEqual({ variable: DEEP[0] })
    const both: OpcUaVariable[] = [
      { path: ['A', 'eye'], nodeId: 'n1' },
      { path: ['A', 'Eye'], nodeId: 'n2' },
    ]
    expect(matchOpcUaTag('Eye', both)).toEqual({ variable: both[1] })
  })

  it('refuses a name that fits several tags, naming them, rather than guessing', () => {
    const r = matchOpcUaTag('Run', DEEP)
    expect(r).toEqual({ error: expect.stringMatching(/^Run names 2 tags on the PLC \(.*Main\.Run, .*Packer\.Run\): name it by more of its path$/) })
    expect(matchOpcUaTag('Packer.Run', DEEP)).toEqual({ variable: DEEP[2] })
  })

  it('says when there is no such tag, and takes a NodeId as written', () => {
    expect(matchOpcUaTag('Missing', DEEP)).toEqual({ error: 'the PLC has no tag named Missing' })
    expect(matchOpcUaTag('ns=4;s=Main.Eye', [])).toEqual({ variable: { path: ['ns=4;s=Main.Eye'], nodeId: 'ns=4;s=Main.Eye' } })
    expect(matchOpcUaTag('ns=3;i=1007', [])).toEqual({ variable: { path: ['ns=3;i=1007'], nodeId: 'ns=3;i=1007' } })
    expect(matchOpcUaTag('Lane[3]', DEEP)).toEqual({ error: 'the PLC has no tag named Lane[3]' })
  })
})

describe('finding an array element', () => {
  const at = ['Device1', 'Main']
  it('takes the element\'s own node, however the server spells its index', () => {
    for (const spelled of [['Lanes', '[3]'], ['Lanes', '3'], ['Lanes', 'Lanes[3]'], ['Lanes[3]'], ['Lanes', '[ 3 ]']]) {
      const vars: OpcUaVariable[] = [
        { path: [...at, 'Lanes'], nodeId: 'whole' },
        { path: [...at, ...spelled], nodeId: 'three' },
        { path: [...at, 'Lanes', '[4]'], nodeId: 'four' },
      ]
      expect(matchOpcUaTag('Lanes[3]', vars), spelled.join('/')).toEqual({ variable: vars[1] })
      expect(matchOpcUaTag('main.lanes[3]', vars), spelled.join('/')).toEqual({ variable: vars[1] })
    }
  })

  it('reads two indexes from one pair of brackets or two, and a member after an element', () => {
    const vars: OpcUaVariable[] = [
      { path: [...at, 'Grid', '[1,2]'], nodeId: 'g12' },
      { path: [...at, 'Grid', '[1]', '[3]'], nodeId: 'g13' },
      { path: [...at, 'Recs', '[2]', 'Ok'], nodeId: 'ok' },
    ]
    expect(matchOpcUaTag('Grid[1,2]', vars)).toEqual({ variable: vars[0] })
    expect(matchOpcUaTag('Grid[1][2]', vars)).toEqual({ variable: vars[0] })
    expect(matchOpcUaTag('Grid[1,3]', vars)).toEqual({ variable: vars[1] })
    expect(matchOpcUaTag('Recs[2].Ok', vars)).toEqual({ variable: vars[2] })
  })

  it('names the element of a node that holds the whole array, when no node is the element\'s own', () => {
    const vars: OpcUaVariable[] = [
      { path: [...at, 'Lanes'], nodeId: 'whole' },
      { path: [...at, 'Grid'], nodeId: 'grid' },
      { path: ['Device1', 'Packer', 'Lanes', '[0]'], nodeId: 'p0' },
    ]
    expect(matchOpcUaTag('Main.Lanes[3]', vars)).toEqual({ variable: vars[0], index: [3] })
    expect(matchOpcUaTag('Grid[1,2]', vars)).toEqual({ variable: vars[1], index: [1, 2] })
    // an element's own node wins over an index into another array of the same name
    expect(matchOpcUaTag('Lanes[0]', vars)).toEqual({ variable: vars[2] })
    // a member of an element is found only where the element is a node
    expect(matchOpcUaTag('Lanes[3].Run', vars)).toEqual({ error: 'the PLC has no tag named Lanes[3].Run' })
    expect(matchOpcUaTag('Nope[3]', vars)).toEqual({ error: 'the PLC has no tag named Nope[3]' })
    const two: OpcUaVariable[] = [vars[0]!, { path: ['Device1', 'Packer', 'Lanes'], nodeId: 'other' }]
    expect(matchOpcUaTag('Lanes[3]', two)).toHaveProperty('error', expect.stringMatching(/^Lanes\[3\] names 2 tags on the PLC/))
  })
})

describe('the names a tag picker offers', () => {
  it('offers each variable by the shortest end of its path that names it alone', () => {
    expect(opcUaTagNames(DEEP)).toEqual(['Eye', 'Main.Run', 'Packer.Run'])
    expect(opcUaTagNames([...SHALLOW, ...GLOBALS])).toEqual(['Conveyor.Eye', 'Main.Eye'])
  })

  it('offers only names the link binds to exactly that variable', () => {
    const vars: OpcUaVariable[] = [
      ...DEEP,
      { path: ['Device1', 'Line2', 'eye'], nodeId: 'm1' },
      { path: ['Device1', 'Line.1', 'Run'], nodeId: 'm2' },
      { path: ['Device1', 'Cell', 'Line', 'Run'], nodeId: 'm3' },
    ]
    const names = opcUaTagNames(vars)
    expect(names).toContain('"Line.1".Run')
    const bound = names.map((name) => {
      const m = matchOpcUaTag(name, vars)
      expect(m, name).toHaveProperty('variable')
      return 'variable' in m ? m.variable.nodeId : ''
    })
    // one name per variable, each binding a different one
    expect(new Set(bound).size).toBe(vars.length)
    expect(names).toHaveLength(vars.length)
  })

  it('leaves out structures and names a tag field cannot hold', () => {
    const vars: OpcUaVariable[] = [
      { path: ['Device1', 'Main', 'Motor'], nodeId: 's' },
      { path: ['Device1', 'Main', 'Motor', 'Run'], nodeId: 's1' },
      { path: ['Device1', 'Main', 'Has Space'], nodeId: 'w' },
      { path: ['Device1', 'Main', 'Odd[x]'], nodeId: 'o' },
      { path: ['Device1', 'Main', 'Eye'], nodeId: 'e' },
    ]
    expect(opcUaTagNames(vars)).toEqual(['Eye', 'Run'])
  })

  it('offers an element that has a node of its own by the tag\'s spelling, and not the array above it', () => {
    const vars: OpcUaVariable[] = [
      { path: ['Device1', 'Main', 'Lanes'], nodeId: 'a' },
      { path: ['Device1', 'Main', 'Lanes', '[0]'], nodeId: 'a0' },
      { path: ['Device1', 'Main', 'Lanes', '[1]'], nodeId: 'a1' },
      { path: ['Device1', 'Main', 'Recs', 'Recs[2]', 'Ok'], nodeId: 'r' },
      { path: ['Device1', 'Main', 'Recs', 'Recs[3]', 'Ok'], nodeId: 'r3' },
      { path: ['Device1', 'Main', 'Grid', '[1]', '[2]'], nodeId: 'g' },
      { path: ['Device1', 'Packer', 'Lanes', '0'], nodeId: 'p0' },
      // an array that is one node reads as any variable: a browse does not say what a node holds
      { path: ['Device1', 'Main', 'Counts'], nodeId: 'c' },
    ]
    const names = opcUaTagNames(vars)
    expect(names).toEqual(['Counts', 'Grid[1,2]', 'Lanes[1]', 'Main.Lanes[0]', 'Packer.Lanes[0]', 'Recs[2].Ok', 'Recs[3].Ok'])
    for (const name of names) expect(matchOpcUaTag(name, vars), name).toHaveProperty('variable')
    expect(new Set(names.map((name) => (matchOpcUaTag(name, vars) as { variable: OpcUaVariable }).variable.nodeId)).size).toBe(names.length)
  })
})

describe('names close to one the PLC does not hold', () => {
  const names = ['Main.PhotoEye_1', 'Main.PE_01', 'Main.Motor', 'Packer.PhotoEye_2']
  it('ranks by the last segment, ignoring case and separators', () => {
    expect(closestOpcUaTagNames('PhotoEye1', names)).toEqual(['Main.PhotoEye_1', 'Packer.PhotoEye_2'])
    expect(closestOpcUaTagNames('motor', names)).toEqual(['Main.Motor'])
  })
  it('offers nothing when nothing is close', () => {
    expect(closestOpcUaTagNames('Conveyor', names)).toEqual([])
  })
})

describe('binding points to nodes', () => {
  const info: Record<string, OpcUaNodeInfo> = {
    [DEEP[0]!.nodeId]: { dataType: 'ns=0;i=1', access: 3 },
    [DEEP[1]!.nodeId]: { dataType: 'ns=0;i=1', access: 1 },
    [DEEP[2]!.nodeId]: { dataType: 'ns=0;i=10', access: 3 },
  }
  const describe_ = (id: string) => info[id]

  it('binds each point with the type it is written as', () => {
    const r = bindOpcUaPoints(
      [
        { tag: 'Main.Eye', dir: 'toPlc', type: 'BOOL' },
        { tag: 'Main.Run', dir: 'fromPlc', type: 'BOOL' },
      ],
      DEEP,
      describe_,
    )
    expect(r.problems).toEqual([])
    expect(r.bindings.map((b) => [b.tag, b.nodeId, b.builtin])).toEqual([
      ['Main.Eye', DEEP[0]!.nodeId, 1],
      ['Main.Run', DEEP[1]!.nodeId, 1],
    ])
  })

  it('refuses a bit on a number, a node it may not write, and a type that is not a value', () => {
    const r = bindOpcUaPoints(
      [
        { tag: 'Packer.Run', dir: 'fromPlc', type: 'BOOL' },
        { tag: 'Main.Run', dir: 'toPlc', type: 'BOOL' },
      ],
      DEEP,
      describe_,
    )
    expect(r.bindings).toEqual([])
    expect(r.problems).toEqual([expect.stringMatching(/carry a bit, and .*Packer\.Run is Float/), expect.stringMatching(/does not let this client write .*Main\.Run \(a PLC's own inputs usually cannot be written/)])
    const odd = bindOpcUaPoints([{ tag: 'Eye', dir: 'toPlc', type: null }], SHALLOW, () => ({ dataType: 'ns=0;i=12', access: 3 }))
    expect(odd.problems).toEqual([expect.stringMatching(/not a single bit or number \(its type is ns=0;i=12\)/)])
  })

  it('binds one element of an array node by an index range counted from 0, and refuses what is not an element', () => {
    const vars: OpcUaVariable[] = [
      { path: ['Main', 'Lanes'], nodeId: 'lanes' },
      { path: ['Main', 'Grid'], nodeId: 'grid' },
      { path: ['Main', 'Eye'], nodeId: 'eye' },
      { path: ['Main', 'Open'], nodeId: 'open' },
    ]
    const nodes: Record<string, OpcUaNodeInfo> = {
      lanes: { dataType: 'ns=0;i=1', access: 3, rank: 1, dims: [4] },
      grid: { dataType: 'ns=0;i=4', access: 3, rank: 2, dims: [2, 3] },
      eye: { dataType: 'ns=0;i=1', access: 3, rank: -1, dims: [] },
      // an array whose length the server does not fix
      open: { dataType: 'ns=0;i=4', access: 3, rank: 1, dims: [0] },
    }
    const bind = (tag: string, type: 'BOOL' | 'INT' = 'BOOL') => bindOpcUaPoints([{ tag, dir: 'toPlc', type }], vars, (id) => nodes[id])
    expect(bind('Lanes[3]').bindings).toEqual([{ tag: 'Lanes[3]', dir: 'toPlc', type: 'BOOL', nodeId: 'lanes', path: ['Main', 'Lanes'], builtin: 1, indexRange: '3' }])
    expect(bind('Grid[1,2]', 'INT').bindings.map((b) => b.indexRange)).toEqual(['1,2'])
    expect(bind('Open[700]', 'INT').bindings.map((b) => b.indexRange)).toEqual(['700'])
    expect(bind('Lanes').problems).toEqual(['Lanes: Main.Lanes is an array; name one element of it, like Lanes[0]'])
    expect(bind('Grid', 'INT').problems).toEqual(['Grid: Main.Grid is an array; name one element of it, like Grid[0,0]'])
    // a NodeId names the whole node, so an element of it is asked for by the tag's name
    expect(bindOpcUaPoints([{ tag: 'ns=4;s=Lanes', dir: 'toPlc', type: 'BOOL' }], vars, () => nodes.lanes).problems).toEqual(['ns=4;s=Lanes is an array; wire the part by the tag\'s name with an index, like Lane[0]'])
    expect(bind('Eye[0]').problems).toEqual(['Eye[0]: Main.Eye is a single value, not an array'])
    expect(bind('Lanes[4]').problems).toEqual(['Lanes[4]: Main.Lanes has 4 elements; over OPC UA an index counts from 0, whatever the PLC declares'])
    expect(bind('Lanes[-1]').problems).toEqual(['Lanes[-1]: Main.Lanes has no element before 0; over OPC UA an index counts from 0, whatever the PLC declares'])
    expect(bind('Grid[1,3]', 'INT').problems).toEqual(['Grid[1,3]: Main.Grid has 3 elements in dimension 2; over OPC UA an index counts from 0, whatever the PLC declares'])
    expect(bind('Grid[1]', 'INT').problems).toEqual(['Grid[1]: Main.Grid has 2 dimensions, and the tag gives 1 index'])
    expect(bind('Lanes[0]', 'INT').problems).toEqual([expect.stringMatching(/carry a number, and Main\.Lanes is Boolean/)])
    // a shell that reads no rank: every node is one value, as before
    expect(bindOpcUaPoints([{ tag: 'Lanes', dir: 'toPlc', type: 'BOOL' }], vars, () => ({ dataType: 'ns=0;i=1', access: 3 })).problems).toEqual([])
  })

  it('binds a PLC\'s own type by the built-in it comes down to, and names a refused one', () => {
    const r = bindOpcUaPoints([{ tag: 'Eye', dir: 'toPlc', type: 'INT' }], SHALLOW, () => ({ dataType: 'ns=4;i=3005', builtin: 6, access: 3 }))
    expect(r.problems).toEqual([])
    expect(r.bindings.map((b) => b.builtin)).toEqual([6])
    const wide = bindOpcUaPoints([{ tag: 'Eye', dir: 'toPlc', type: 'DINT' }], SHALLOW, () => ({ dataType: 'ns=0;i=8', builtin: 8, access: 3 }))
    expect(wide.problems).toEqual([expect.stringMatching(/not a single bit or number \(its type is Int64\)/)])
  })
})

describe('a discovery server where a PLC was expected', () => {
  it('names the servers it lists, by their opc.tcp address', () => {
    expect(
      discoveryServerMessage('opc.tcp://127.0.0.1:4840', [
        { name: 'Example Soft PLC', urls: ['https://plc:4843', 'opc.tcp://plc:4841'] },
        { name: 'Other', urls: [] },
      ]),
    ).toBe(
      'opc.tcp://127.0.0.1:4840 is an OPC UA discovery server, not a PLC: it only lists the OPC UA servers on its machine. It knows of Example Soft PLC at opc.tcp://plc:4841. Put that address in the Server field.',
    )
    expect(discoveryServerMessage('opc.tcp://x:4840', [{ name: 'A', urls: ['opc.tcp://x:4841'] }, { name: 'B', urls: ['opc.tcp://x:4842'] }])).toMatch(/It knows of A at opc\.tcp:\/\/x:4841, B at opc\.tcp:\/\/x:4842\. Put one of those addresses/)
  })

  it('says where to look when it lists none', () => {
    expect(discoveryServerMessage('opc.tcp://x:4840', [])).toMatch(/it knows of none\. A PLC's OPC UA server listens on a port of its own/)
  })
})

describe('values on the wire', () => {
  it('knows the built-in types a scene value travels as', () => {
    expect([builtinOf('ns=0;i=1'), builtinOf('i=10'), builtinOf('ns=0;i=12'), builtinOf('ns=3;i=1')]).toEqual([1, 10, null, null])
  })

  it('writes a whole number rounded and held in its range, and reads a Boolean as a bit', () => {
    expect(toOpcUaValue(4, 70000)).toBe(32767)
    expect(toOpcUaValue(5, -3)).toBe(0)
    expect(toOpcUaValue(6, 2.6)).toBe(3)
    expect(toOpcUaValue(10, 0.3)).toBe(0.3)
    expect(toOpcUaValue(1, 1)).toBe(true)
    expect(toOpcUaValue(4, Number.NaN)).toBe(0)
    expect(fromOpcUaValue(1, 1)).toBe(true)
    expect(fromOpcUaValue(10, 0.5)).toBe(0.5)
    expect(fromOpcUaValue(4, true)).toBe(1)
  })
})

describe('browse start points', () => {
  it('reads a path of browse names as a tag is written, or a NodeId as it is', () => {
    expect(opcUaBrowseRoot('DeviceSet.PLC.Programs')).toEqual({ path: ['DeviceSet', 'PLC', 'Programs'] })
    expect(opcUaBrowseRoot(' "Cell.A".Data ')).toEqual({ path: ['Cell.A', 'Data'] })
    expect(opcUaBrowseRoot('ns=4;s=Programs')).toEqual({ nodeId: 'ns=4;s=Programs' })
    expect(opcUaBrowseRoot('i=85')).toEqual({ nodeId: 'i=85' })
    for (const bad of ['', '   ', 'DeviceSet..PLC', 'Programs.', 'Main.Arr[0]', 'x'.repeat(513)]) expect(opcUaBrowseRoot(bad)).toBeNull()
  })

  it('splits a field at commas outside quotes, and refuses it whole when one start point is wrong', () => {
    expect(parseOpcUaBrowseRoots('')).toEqual([])
    expect(parseOpcUaBrowseRoots(' , ')).toEqual([])
    expect(parseOpcUaBrowseRoots('DeviceSet.PLC.Programs, ns=4;s=GVL')).toEqual(['DeviceSet.PLC.Programs', 'ns=4;s=GVL'])
    expect(parseOpcUaBrowseRoots('"Line 1, Cell 2".Data')).toEqual(['"Line 1, Cell 2".Data'])
    expect(parseOpcUaBrowseRoots('Programs, Main..Eye')).toBeNull()
    expect(parseOpcUaBrowseRoots('"Programs')).toBeNull()
    expect(parseOpcUaBrowseRoots(Array.from({ length: MAX_BROWSE_ROOTS + 1 }, (_, i) => `F${i}`).join(','))).toBeNull()
  })
})
