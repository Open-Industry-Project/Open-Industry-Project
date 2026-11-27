// Smoke test for opcUaServer.cjs - the simulated PLC's OPC UA server. Runs with plain Node (no Electron):
// `node apps/desktop/opcUaServer.test.cjs`. Which variables are published, as what, is tested in
// src/editor/links/opcUaServer.test.ts. Here a real OPC UA client (the shell's own, opcUaIo.cjs) tests the nodes:
// the tree it browses, the types and access it reads, values while running and out of service while not,
// a write reaching the app and a read-only node refusing one, a redefine keeping the nodes it can, and an array
// read and written by element, both as the element's own node and as an index range of the array's.

const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { AttributeIds } = require('node-opcua-client')
const { OpcUaLink } = require('./opcUaIo.cjs')
const { SimOpcUaServer } = require('./opcUaServer.cjs')

const PORT = 48431
const NODES = [
  { name: 'Start', builtin: 1, writable: true, value: false },
  { name: 'Eye', builtin: 1, writable: false, value: false },
  { name: 'Speed', builtin: 10, writable: true, value: 0.5 },
  { name: 'Count', builtin: 4, writable: true, value: 0 },
  { name: 'Label', builtin: 12, writable: true, value: 'idle' },
  { name: 'T1.Q', builtin: 1, writable: false, value: false },
  { name: 'T1.ET', builtin: 11, writable: false, value: 0 },
]

/** A short array (each element a node too), a two-dimensional one, a read-only one, and one too long for a node each. */
const lane = (i, value) => ({ name: `Lane[${i}]`, builtin: 1, writable: true, value })
const ARRAY_NODES = [
  lane(1, false),
  lane(2, true),
  lane(3, false),
  lane(4, false),
  ...[0, 1].flatMap((r) => [0, 1, 2].map((c) => ({ name: `Main.Grid[${r},${c}]`, builtin: 4, writable: true, value: r * 10 + c }))),
  ...[0, 1, 2].map((i) => ({ name: `Ro[${i}]`, builtin: 10, writable: false, value: i + 0.5 })),
]
const ARRAYS = [
  { name: 'Lane', builtin: 1, writable: true, dims: [{ lo: 1, hi: 4 }], listed: true },
  { name: 'Main.Grid', builtin: 4, writable: true, dims: [{ lo: 0, hi: 1 }, { lo: 0, hi: 2 }], listed: true },
  { name: 'Ro', builtin: 10, writable: false, dims: [{ lo: 0, hi: 2 }], listed: true },
  { name: 'Big', builtin: 4, writable: true, dims: [{ lo: 1, hi: 600 }], listed: false },
]

/** The array checks, on a server that is running: the client is the shell's own, as a PLC's server would meet it. */
async function arrays(server, link, writes) {
  server.define([...NODES, ...ARRAY_NODES], ARRAYS)
  server.update({}, true)
  const { variables } = await link.browse()
  const paths = variables.map((v) => v.path.join('.'))
  const id = (path) => variables.find((v) => v.path.join('.') === path).nodeId
  // an array is one node, and a short array's elements sit under it, each named by the PLC's own index
  for (const want of ['PLC.Lane', 'PLC.Lane.[1]', 'PLC.Lane.[4]', 'PLC.Main.Grid', 'PLC.Main.Grid.[1,2]', 'PLC.Ro.[0]', 'PLC.Big']) assert.ok(paths.includes(want), want)
  assert.ok(!paths.some((x) => x.startsWith('PLC.Big.')), 'a long array has no node per element')
  assert.match(id('PLC.Lane.[3]'), /;s=Lane\[3\]$/, 'an element\'s NodeId is its name')

  const described = await link.describe([id('PLC.Lane'), id('PLC.Main.Grid'), id('PLC.Ro'), id('PLC.Big'), id('PLC.Lane.[3]')])
  assert.deepEqual(described, [
    { dataType: 'ns=0;i=1', builtin: 1, access: 3, rank: 1, dims: [4] },
    { dataType: 'ns=0;i=4', builtin: 4, access: 3, rank: 2, dims: [2, 3] },
    { dataType: 'ns=0;i=10', builtin: 10, access: 1, rank: 1, dims: [3] },
    { dataType: 'ns=0;i=4', builtin: 4, access: 3, rank: 1, dims: [600] },
    { dataType: 'ns=0;i=1', builtin: 1, access: 3, rank: -1, dims: [] },
  ])

  // reads: an element by its own node, and by an index range of the array's node, which counts from 0
  let r = await link.exchange([], [id('PLC.Lane.[2]'), { nodeId: id('PLC.Lane'), indexRange: '1' }, { nodeId: id('PLC.Main.Grid'), indexRange: '1,2' }, { nodeId: id('PLC.Ro'), indexRange: '2' }])
  assert.deepEqual(r.reads, [
    { value: true, status: 'Good' },
    { value: true, status: 'Good' },
    { value: 12, status: 'Good' },
    { value: 2.5, status: 'Good' },
  ])
  const whole = await link.session.read({ nodeId: id('PLC.Lane'), attributeId: AttributeIds.Value })
  assert.deepEqual(Array.from(whole.value.value), [false, true, false, false])

  // a long array waits for its values, which arrive by element name
  r = await link.exchange([{ nodeId: id('PLC.Big'), builtin: 4, value: 1, indexRange: '0' }], [{ nodeId: id('PLC.Big'), indexRange: '599' }])
  assert.deepEqual(r.reads, [{ value: null, status: 'BadWaitingForInitialData' }])
  assert.deepEqual(r.writes, ['BadInvalidState'])
  server.update({ 'Big[1]': 11, 'Big[600]': 66, 'Lane[4]': true }, true)
  r = await link.exchange([], [{ nodeId: id('PLC.Big'), indexRange: '599' }, { nodeId: id('PLC.Big'), indexRange: '0' }, { nodeId: id('PLC.Lane'), indexRange: '3' }, id('PLC.Lane.[4]')])
  assert.deepEqual(r.reads.map((x) => x.value), [66, 11, true, true])

  // writes: one element by index range reaches the app under the PLC's own index, and both nodes then read it
  writes.length = 0
  r = await link.exchange(
    [
      { nodeId: id('PLC.Lane'), builtin: 1, value: true, indexRange: '2' },
      { nodeId: id('PLC.Main.Grid'), builtin: 4, value: 77, indexRange: '0,1' },
      { nodeId: id('PLC.Big'), builtin: 4, value: 5, indexRange: '1' },
      { nodeId: id('PLC.Lane.[1]'), builtin: 1, value: true },
    ],
    [id('PLC.Lane.[3]'), { nodeId: id('PLC.Lane'), indexRange: '0' }, id('PLC.Main.Grid.[0,1]'), { nodeId: id('PLC.Big'), indexRange: '1' }],
  )
  assert.deepEqual(r.writes, ['Good', 'Good', 'Good', 'Good'])
  assert.deepEqual(writes, [
    ['Lane[3]', true],
    ['Main.Grid[0,1]', 77],
    ['Big[2]', 5],
    ['Lane[1]', true],
  ])
  assert.deepEqual(r.reads.map((x) => x.value), [true, true, 77, 5])
  // an element the app did not hear a change for keeps its value: a range write touches only its own elements
  r = await link.exchange([], [{ nodeId: id('PLC.Lane'), indexRange: '1' }, { nodeId: id('PLC.Big'), indexRange: '599' }])
  assert.deepEqual(r.reads.map((x) => x.value), [true, 66])

  // refused: past the end, a read-only array, the wrong type, and the wrong number of indexes
  writes.length = 0
  r = await link.exchange(
    [
      { nodeId: id('PLC.Lane'), builtin: 1, value: true, indexRange: '4' },
      { nodeId: id('PLC.Ro'), builtin: 10, value: 1, indexRange: '0' },
      { nodeId: id('PLC.Lane'), builtin: 4, value: 1, indexRange: '0' },
      { nodeId: id('PLC.Main.Grid'), builtin: 4, value: 1, indexRange: '1' },
    ],
    [{ nodeId: id('PLC.Lane'), indexRange: '4' }],
  )
  assert.deepEqual(r.writes, ['BadIndexRangeNoData', 'BadNotWritable', 'BadTypeMismatch', 'BadIndexRangeInvalid'])
  assert.equal(r.reads[0].status, 'BadIndexRangeNoData')
  assert.deepEqual(writes, [])

  // the whole array in one write, and a run of elements
  const { DataType, VariantArrayType } = require('node-opcua-client')
  let status = await link.session.write({ nodeId: id('PLC.Lane'), attributeId: AttributeIds.Value, value: { value: { dataType: DataType.Boolean, arrayType: VariantArrayType.Array, value: [false, false, true, true] } } })
  assert.equal(status.name, 'Good')
  assert.deepEqual(writes, [
    ['Lane[1]', false],
    ['Lane[2]', false],
    ['Lane[3]', true],
    ['Lane[4]', true],
  ])
  writes.length = 0
  status = await link.session.write({ nodeId: id('PLC.Big'), attributeId: AttributeIds.Value, indexRange: '10:12', value: { value: { dataType: DataType.Int16, arrayType: VariantArrayType.Array, value: Int16Array.of(1, 2, 3) } } })
  assert.equal(status.name, 'Good')
  assert.deepEqual(writes, [
    ['Big[11]', 1],
    ['Big[12]', 2],
    ['Big[13]', 3],
  ])
  status = await link.session.write({ nodeId: id('PLC.Lane'), attributeId: AttributeIds.Value, value: { value: { dataType: DataType.Boolean, arrayType: VariantArrayType.Array, value: [true] } } })
  assert.equal(status.name, 'BadTypeMismatch', 'a whole-array write of the wrong length')

  // stopped: out of service, and a write refused, as a variable is
  server.update({}, false)
  r = await link.exchange([{ nodeId: id('PLC.Lane'), builtin: 1, value: true, indexRange: '0' }], [{ nodeId: id('PLC.Lane'), indexRange: '0' }])
  assert.deepEqual(r.reads, [{ value: null, status: 'BadOutOfService' }])
  assert.deepEqual(r.writes, ['BadInvalidState'])
  server.update({}, true)

  // a redefine keeps an array that is unchanged, with its values, and drops one that went with its elements
  const kept = id('PLC.Big')
  server.define([...NODES, ...ARRAY_NODES.filter((n) => !n.name.startsWith('Lane['))], ARRAYS.filter((a) => a.name !== 'Lane'))
  const after = (await link.browse()).variables.map((v) => v.path.join('.'))
  assert.ok(!after.some((x) => x === 'PLC.Lane' || x.startsWith('PLC.Lane.')), 'the array and its elements are gone')
  assert.ok(after.includes('PLC.Main.Grid.[1,2]') && after.includes('PLC.Big'))
  r = await link.exchange([], [{ nodeId: kept, indexRange: '599' }])
  assert.deepEqual(r.reads, [{ value: 66, status: 'Good' }])
  // an array that changes shape is a new node
  server.define([...NODES], [{ ...ARRAYS[3], dims: [{ lo: 0, hi: 9 }] }])
  const reshaped = await link.describe([kept])
  assert.deepEqual([reshaped[0].rank, reshaped[0].dims], [1, [10]])
  writes.length = 0
  server.define(NODES)
}

async function main() {
  const pki = mkdtempSync(join(tmpdir(), 'oip-opcua-server-'))
  const writes = []
  let clients = []
  const server = new SimOpcUaServer(pki, { onWrite: (name, value) => writes.push([name, value]), onClients: (c) => (clients = c) })
  const link = new OpcUaLink(join(pki, 'client'), () => {})
  try {
    // 1. start, on this machine only, and publish
    const started = await server.start({ port: PORT, network: false })
    assert.equal(started.error, '')
    assert.equal(started.endpoint, `opc.tcp://127.0.0.1:${PORT}`)
    server.define(NODES)

    // 2. a client connects and finds the program under PLC, a function block's outputs in its own folder
    assert.deepEqual(await link.connect(started.endpoint), { error: '' })
    const until = Date.now() + 3000
    while (clients.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20))
    assert.equal(clients.length, 1, 'the session is reported')
    console.log(`  client: ${clients[0]}`)
    const { variables } = await link.browse()
    const paths = variables.map((v) => v.path.join('.')).sort()
    assert.deepEqual(paths, ['PLC.Count', 'PLC.Eye', 'PLC.Label', 'PLC.Speed', 'PLC.Start', 'PLC.T1.ET', 'PLC.T1.Q'])
    const id = (path) => variables.find((v) => v.path.join('.') === path).nodeId
    assert.match(id('PLC.T1.Q'), /;s=T1\.Q$/, 'a variable\'s NodeId is its name, so a SCADA tag can be written by hand')

    // 3. types and access, as published
    const described = await link.describe([id('PLC.Start'), id('PLC.Eye'), id('PLC.Speed'), id('PLC.Count'), id('PLC.Label')])
    const one = { rank: -1, dims: [] }
    assert.deepEqual(described, [
      { dataType: 'ns=0;i=1', builtin: 1, access: 3, ...one },
      { dataType: 'ns=0;i=1', builtin: 1, access: 1, ...one },
      { dataType: 'ns=0;i=10', builtin: 10, access: 3, ...one },
      { dataType: 'ns=0;i=4', builtin: 4, access: 3, ...one },
      { dataType: 'ns=0;i=12', builtin: 12, access: 3, ...one },
    ])

    // 4. while the simulation is stopped, a read says so and a write is refused
    let r = await link.exchange([{ nodeId: id('PLC.Start'), builtin: 1, value: true }], [id('PLC.Eye')])
    assert.deepEqual(r.reads, [{ value: null, status: 'BadOutOfService' }])
    assert.deepEqual(r.writes, ['BadInvalidState'])
    assert.equal(writes.length, 0)

    // 5. running: the values the app pushes, and writes reach the app
    server.update({ Eye: true, Speed: 1.25, Count: 7, Label: 'running', 'T1.ET': 250 }, true)
    r = await link.exchange(
      [
        { nodeId: id('PLC.Start'), builtin: 1, value: true },
        { nodeId: id('PLC.Count'), builtin: 4, value: 42 },
      ],
      [id('PLC.Eye'), id('PLC.Speed'), id('PLC.Count'), id('PLC.Label'), id('PLC.T1.ET')],
    )
    assert.deepEqual(r.writes, ['Good', 'Good'])
    assert.deepEqual(writes, [
      ['Start', true],
      ['Count', 42],
    ])
    assert.deepEqual(
      r.reads.map((x) => x.value),
      [true, 1.25, 42, 'running', 250],
    )
    // a read-only variable (an input the scene feeds) refuses a client
    r = await link.exchange([{ nodeId: id('PLC.Eye'), builtin: 1, value: false }], [])
    assert.deepEqual(r.writes, ['BadNotWritable'])
    assert.equal(writes.length, 2)

    // 5b. arrays
    const heard = writes.length
    const before5b = writes.slice()
    await arrays(server, link, writes)
    writes.length = 0
    writes.push(...before5b)
    assert.equal(writes.length, heard)

    // 6. a redefine keeps what is unchanged (same node) and drops what went, folder and all
    const before = id('PLC.Start')
    server.define(NODES.filter((n) => !n.name.startsWith('T1.')).concat([{ name: 'Main.Run', builtin: 1, writable: true, value: true }]))
    const again = (await link.browse()).variables.map((v) => v.path.join('.')).sort()
    assert.deepEqual(again, ['PLC.Count', 'PLC.Eye', 'PLC.Label', 'PLC.Main.Run', 'PLC.Speed', 'PLC.Start'])
    const dv = await link.session.read({ nodeId: before, attributeId: AttributeIds.Value })
    assert.equal(dv.statusCode.name, 'Good', 'a node kept across a redefine still answers')

    // 7. the port taken: said in words
    const second = new SimOpcUaServer(pki, { onWrite() {}, onClients() {} })
    const taken = await second.start({ port: PORT, network: false })
    assert.equal(taken.error, `port ${PORT} is already in use on this machine`)

    // 8. the client leaves
    await link.close()
    const gone = Date.now() + 3000
    while (clients.length > 0 && Date.now() < gone) await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(clients, [])
    console.log('opcUaServer: all checks passed')
  } finally {
    await link.close().catch(() => {})
    await server.stop()
    rmSync(pki, { recursive: true, force: true })
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
