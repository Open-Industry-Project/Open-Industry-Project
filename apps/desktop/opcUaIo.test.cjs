// Smoke test for opcUaIo.cjs - the node-opcua half of an OPC UA link. Runs with plain Node (no Electron):
// `node apps/desktop/opcUaIo.test.cjs`. The mapping (which tag is which node) is tested in
// src/core/io/opcUa.test.ts. Here a real node-opcua server tests the service calls: connect, browse,
// describe, a write-then-read cycle, the PLC going away, and a server that refuses an unsecured client.

const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { OPCUAServer } = require('node-opcua-server')
const { OPCUACertificateManager } = require('node-opcua-certificate-manager')
const { ApplicationType, DataType, MessageSecurityMode, SecurityPolicy, VariantArrayType } = require('node-opcua-client')
const { OpcUaLink } = require('./opcUaIo.cjs')

/** A PLC-like server: PLC_PRG.Eye, .Run and .Speed, running `Run := NOT Eye` on every write of Eye. */
async function plc(port, pki, secure = false, discovery = false) {
  const server = new OPCUAServer({
    port,
    ...(discovery ? { serverInfo: { applicationType: ApplicationType.DiscoveryServer, applicationName: { text: 'Test LDS' } } } : {}),
    serverCertificateManager: new OPCUACertificateManager({ rootFolder: join(pki, `server-${port}`) }),
    securityPolicies: [secure ? SecurityPolicy.Basic256Sha256 : SecurityPolicy.None],
    securityModes: [secure ? MessageSecurityMode.SignAndEncrypt : MessageSecurityMode.None],
    allowAnonymous: true,
  })
  await server.initialize()
  const ns = server.engine.addressSpace.getOwnNamespace()
  const prg = ns.addObject({ organizedBy: server.engine.addressSpace.rootFolder.objects, browseName: 'PLC_PRG' })
  const eye = ns.addVariable({ componentOf: prg, browseName: 'Eye', dataType: 'Boolean', value: { dataType: 'Boolean', value: false } })
  const run = ns.addVariable({ componentOf: prg, browseName: 'Run', dataType: 'Boolean', value: { dataType: 'Boolean', value: true } })
  ns.addVariable({ componentOf: prg, browseName: 'Speed', dataType: 'Float', value: { dataType: 'Float', value: 0.5 } })
  eye.on('value_changed', (dv) => run.setValueFromSource({ dataType: 'Boolean', value: !dv.value.value }))
  await server.start()
  return server
}

/** A server with `objects` objects under Objects, each holding the Int32s `names`, and the given capabilities. */
async function crowded(port, pki, objects, names, serverCapabilities) {
  const server = new OPCUAServer({
    port,
    serverCertificateManager: new OPCUACertificateManager({ rootFolder: join(pki, `server-${port}`) }),
    securityPolicies: [SecurityPolicy.None],
    securityModes: [MessageSecurityMode.None],
    allowAnonymous: true,
    serverCapabilities,
  })
  await server.initialize()
  const ns = server.engine.addressSpace.getOwnNamespace()
  for (let i = 0; i < objects; i++) {
    const o = ns.addObject({ organizedBy: server.engine.addressSpace.rootFolder.objects, browseName: `M${i}` })
    for (const name of names) ns.addVariable({ componentOf: o, browseName: name, dataType: 'Int32', value: { dataType: 'Int32', value: 0 } })
  }
  await server.start()
  return server
}

/** A server whose Main holds variables of types a PLC defines or the standard derives: none is a built-in itself. */
async function ownTypes(port, pki) {
  const server = new OPCUAServer({
    port,
    serverCertificateManager: new OPCUACertificateManager({ rootFolder: join(pki, `server-${port}`) }),
    securityPolicies: [SecurityPolicy.None],
    securityModes: [MessageSecurityMode.None],
    allowAnonymous: true,
  })
  await server.initialize()
  const ns = server.engine.addressSpace.getOwnNamespace()
  const main = ns.addObject({ organizedBy: server.engine.addressSpace.rootFolder.objects, browseName: 'Main' })
  const add = (browseName, dataType, value) => ns.addVariable({ componentOf: main, browseName, dataType, value })
  // an IEC ENUM gets a type of its own; an alias (TYPE T_Speed : INT; END_TYPE) a subtype of Int16
  add('Mode', ns.addEnumerationType({ browseName: 'E_Mode', enumeration: ['Off', 'Auto', 'Manual'] }), { dataType: DataType.Int32, value: 1 })
  add('Speed', ns.createDataType({ browseName: 'T_Speed', subtypeOf: 'Int16', isAbstract: false }), { dataType: DataType.Int16, value: 5 })
  add('Delay', 'Duration', { dataType: DataType.Double, value: 250 })
  add('Level', 'Number', { dataType: DataType.Float, value: 0.5 })
  add('Count', 'Int64', { dataType: DataType.Int64, arrayType: VariantArrayType.Scalar, value: [0, 7] })
  await server.start()
  return server
}

async function main() {
  const pki = mkdtempSync(join(tmpdir(), 'oip-opcua-'))
  const server = await plc(48411, pki)
  try {
    // 1. connect, browse: the program's variables and nothing of the server's own model
    let closedWhy = null
    const link = new OpcUaLink(join(pki, 'client'), (why) => (closedWhy = why))
    assert.deepEqual(await link.connect('opc.tcp://127.0.0.1:48411'), { error: '' })
    const { variables, truncated } = await link.browse()
    assert.equal(truncated, false)
    const paths = variables.map((v) => v.path.join('.')).sort()
    assert.deepEqual(paths, ['PLC_PRG.Eye', 'PLC_PRG.Run', 'PLC_PRG.Speed'])
    const id = (name) => variables.find((v) => v.path.at(-1) === name).nodeId

    // 2. describe: types and access, as the app binds against them
    const nodes = await link.describe([id('Eye'), id('Speed')])
    assert.deepEqual(nodes, [
      { dataType: 'ns=0;i=1', builtin: 1, access: 3 },
      { dataType: 'ns=0;i=10', builtin: 10, access: 3 },
    ])

    // 3. one cycle: write the eye, read what the PLC's rung made of it
    const cycle = await link.exchange([{ nodeId: id('Eye'), builtin: 1, value: true }], [id('Run'), id('Speed')])
    assert.deepEqual(cycle.writes, ['Good'])
    assert.deepEqual(cycle.reads, [
      { value: false, status: 'Good' },
      { value: 0.5, status: 'Good' },
    ])
    // a wrong type is a per-item status, not a failed cycle
    assert.deepEqual((await link.exchange([{ nodeId: id('Eye'), builtin: 4, value: 1 }], [])).writes, ['BadTypeMismatch'])

    // 4. the PLC goes away: the link says so without being asked
    await server.shutdown(0)
    const until = Date.now() + 5000
    while (closedWhy === null && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
    assert.match(String(closedWhy), /lost|closed/)
    await link.close()

    // 5. nothing listening, and a server that only accepts secured clients
    const nobody = new OpcUaLink(join(pki, 'client'), () => {})
    assert.deepEqual(await nobody.connect('opc.tcp://127.0.0.1:48419'), { error: 'nothing answered at opc.tcp://127.0.0.1:48419' })
    const locked = await plc(48412, pki, true)
    try {
      const refused = new OpcUaLink(join(pki, 'client'), () => {})
      const { error: why } = await refused.connect('opc.tcp://127.0.0.1:48412')
      assert.match(why, /only accepts secured connections/)
      console.log(`  a server that only accepts secured clients: "${why}"`)
    } finally {
      await locked.shutdown(0)
    }

    // 6. a discovery server where a PLC was expected: told apart before any session, with what it lists
    const lds = await plc(48413, pki, false, true)
    try {
      const probe = new OpcUaLink(join(pki, 'client'), () => {})
      const r = await probe.connect('opc.tcp://127.0.0.1:48413')
      assert.equal(r.error, 'a discovery server, not a PLC')
      assert.deepEqual(r.discovery, []) // it lists only itself, which is not a PLC's server
      console.log(`  a discovery server: ${JSON.stringify(r)}`)
    } finally {
      await lds.shutdown(0)
    }
    // 7. a server with low OperationLimits: every request is split to fit them
    const small = await crowded(48414, pki, 150, ['A', 'B'], { operationLimits: { maxNodesPerRead: 100, maxNodesPerWrite: 100, maxNodesPerBrowse: 100 } })
    try {
      const link = new OpcUaLink(join(pki, 'client'), () => {})
      assert.deepEqual(await link.connect('opc.tcp://127.0.0.1:48414'), { error: '' })
      const { variables } = await link.browse()
      assert.equal(variables.length, 300)
      const ids = variables.filter((v) => v.path.at(-1) === 'A').map((v) => v.nodeId)
      const nodes = await link.describe(ids)
      assert.equal(nodes.length, 150)
      assert.ok(nodes.every((n) => n.dataType === 'ns=0;i=6'))
      const cycle = await link.exchange(ids.map((nodeId, i) => ({ nodeId, builtin: 6, value: i })), ids)
      assert.equal(cycle.writes.length, 150)
      assert.ok(cycle.writes.every((s) => s === 'Good'))
      assert.deepEqual(cycle.reads.map((r) => r.value), ids.map((_, i) => i))
      await link.close()
    } finally {
      await small.shutdown(0)
    }

    // 8. a server with two browse continuation points: the nodes it has none left for are browsed again, not lost
    const paged = await crowded(48415, pki, 10, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], { maxBrowseContinuationPoints: 2 })
    try {
      const link = new OpcUaLink(join(pki, 'client'), () => {})
      assert.deepEqual(await link.connect('opc.tcp://127.0.0.1:48415'), { error: '' })
      // a PLC pages a node's references at its own size; node-opcua's server pages only at the size the client asks
      link.session.requestedMaxReferencesPerNode = 5
      const { variables, truncated } = await link.browse()
      assert.equal(truncated, false)
      assert.equal(variables.length, 80)
      await link.close()
    } finally {
      await paged.shutdown(0)
    }

    // 9. a PLC's own types: each described by the built-in it comes down to, and written as that
    const typed = await ownTypes(48416, pki)
    try {
      const link = new OpcUaLink(join(pki, 'client'), () => {})
      assert.deepEqual(await link.connect('opc.tcp://127.0.0.1:48416'), { error: '' })
      const { variables } = await link.browse()
      const names = ['Mode', 'Speed', 'Delay', 'Level', 'Count']
      const ids = names.map((name) => variables.find((v) => v.path.at(-1) === name).nodeId)
      const nodes = await link.describe(ids)
      // an enumeration as Int32, an alias of Int16 as Int16, Duration as Double, an abstract Number by its value's
      // Float, and Int64 as itself (the app refuses it)
      assert.deepEqual(nodes.map((n) => n.builtin), [6, 4, 11, 10, 8])
      assert.ok(nodes[0].dataType.startsWith('ns=1;'))
      const writes = [2, 7, 500, 0.25].map((value, i) => ({ nodeId: ids[i], builtin: nodes[i].builtin, value }))
      const cycle = await link.exchange(writes, ids.slice(0, 4))
      assert.deepEqual(cycle.writes, ['Good', 'Good', 'Good', 'Good'])
      assert.deepEqual(cycle.reads.map((r) => r.value), [2, 7, 500, 0.25])
      await link.close()
    } finally {
      await typed.shutdown(0)
    }
    console.log('opcUaIo: all checks passed')
  } finally {
    await server.shutdown(0).catch(() => {})
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
