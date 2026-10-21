// The desktop shell's half of an OPC UA link: a node-opcua client, and nothing about the scene.
//
// OPC UA is too large a protocol to implement in the app the way Modbus is (plcIo.cjs moves raw bytes and
// src/plc/modbus*.ts implement the protocol). So here the library handles the protocol and the app decides everything
// else: which tags travel, which node each one is, and what a value means (src/core/io/opcUa.ts,
// src/editor/links/externalPlc.ts). This file only turns those decisions into service calls.
//
// Unsecured on purpose, for now: security policy None and an anonymous session, with no certificates to trust
// on either side. That is the setting a test bench or a soft PLC on the same machine uses. A plant network
// usually forbids it, and the dock says the connection is unsecured. node-opcua still keeps a client
// certificate store even for None, so it gets one of its own under the app's data folder.
//
// One link per window, closed with it. node-opcua is loaded on the first connect, not at startup: most
// sessions never use OPC UA, and the library is large.

const { join } = require('node:path')
const { opcUaHost } = require('./endpointConsent.cjs')

let lib = null
function opcua() {
  lib ??= { ...require('node-opcua-client'), ...require('node-opcua-certificate-manager') }
  return lib
}

/** Browse limits: deep enough for any vendor's layout, bounded so a huge server cannot stall a connect. */
const MAX_DEPTH = 12
const MAX_NODES = 20000
const BROWSE_BATCH = 200
/** The reference type for properties (EngineeringUnits and the like), which are not a program's variables. */
const HAS_PROPERTY = 'ns=0;i=46'

/** `items` in runs of at most `size` (0: one run), for a server's per-request node limit. */
function chunks(items, size) {
  if (!(size > 0) || items.length <= size) return [items]
  const out = []
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size))
  return out
}

/** A library error as one readable line. */
function say(e) {
  const text = String(e?.message ?? e).split('\n')[0].trim().replace(/\s+\.$/, '')
  if (/BadIdentityToken|BadUserAccessDenied|Anonymous/i.test(text)) return `the PLC refused an anonymous login (${text})`
  if (/BadSecurityPolicyRejected|BadSecurityModeRejected|End point must exist.*securityMode = None/i.test(text)) {
    return 'the PLC only accepts secured connections: allow the "None" security policy on its OPC UA server to connect without certificates'
  }
  if (/cannot be established/i.test(text)) return `nothing answered at ${text.match(/opc\.tcp:\/\/\S+/)?.[0] ?? 'that address'}`
  return text
}

class OpcUaLink {
  /** @param {string} pkiRoot @param {(why: string) => void} onClosed */
  constructor(pkiRoot, onClosed) {
    this.pkiRoot = pkiRoot
    this.onClosed = onClosed
    this.client = null
    this.session = null
    this.closed = false
    /** The server's OperationLimits: most nodes per Read, Write and Browse request (0: no limit). */
    this.limits = { read: 0, write: 0, browse: 0 }
  }

  /**
   * Connect and open an anonymous session. `{error: ''}` on success, else why not. For a discovery server
   * (it holds the standard port 4840 on machines where a vendor install brought one, and has no tags),
   * also `discovery`: the servers it lists, for the app to name.
   */
  async connect(endpoint) {
    const ua = opcua()
    const client = ua.OPCUAClient.create({
      applicationName: 'Open Industry Project',
      securityMode: ua.MessageSecurityMode.None,
      securityPolicy: ua.SecurityPolicy.None,
      endpointMustExist: false,
      keepSessionAlive: false,
      // a request left unanswered fails the cycle in seconds, not the library's default minute; the app's
      // watchdog has already de-energised the PLC's outputs after one
      defaultTransactionTimeout: 3000,
      // the app retries on its own schedule, and says so; the library's own backoff would hide a dead PLC
      connectionStrategy: { maxRetry: 0, initialDelay: 100, maxDelay: 200 },
      clientCertificateManager: new ua.OPCUACertificateManager({ rootFolder: this.pkiRoot, automaticallyAcceptUnknownCertificate: true }),
    })
    this.client = client
    try {
      await client.connect(endpoint)
      if (this.closed) throw new Error('closed')
      // what kind of server answered, before asking it for a session a discovery server may not even offer
      const endpoints = await client.getEndpoints()
      if (endpoints.some((e) => e.server?.applicationType === ua.ApplicationType.DiscoveryServer)) {
        const servers = await client.findServers().catch(() => [])
        const discovery = servers
          .filter((s) => s.applicationType !== ua.ApplicationType.DiscoveryServer && s.applicationType !== ua.ApplicationType.Client)
          .map((s) => ({ name: s.applicationName?.text || s.applicationUri || 'an OPC UA server', urls: [...(s.discoveryUrls ?? [])] }))
        await this.close()
        return { error: 'a discovery server, not a PLC', discovery }
      }
      client.on('connection_lost', () => this.lost('the connection to the PLC was lost'))
      client.on('close', () => this.lost('the PLC closed the connection'))
      this.session = await client.createSession()
      if (this.closed) throw new Error('closed')
      this.session.on('session_closed', () => this.lost('the PLC closed the session'))
      // node-opcua does not split requests, and a server rejects one over its limits with BadTooManyOperations.
      // A limit the server does not publish is taken as none. (The library's readOperationLimits reads twelve
      // limits and logs a warning for each one a server leaves out.)
      const ids = ua.VariableIds
      const limits = await this.session
        .read([ids.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead, ids.Server_ServerCapabilities_OperationLimits_MaxNodesPerWrite, ids.Server_ServerCapabilities_OperationLimits_MaxNodesPerBrowse].map((i) => ({ nodeId: `ns=0;i=${i}`, attributeId: ua.AttributeIds.Value })))
        .catch(() => [])
      if (this.closed) throw new Error('closed')
      const limit = (i) => (limits[i]?.statusCode.isGood() ? Number(limits[i].value.value) || 0 : 0)
      this.limits = { read: limit(0), write: limit(1), browse: limit(2) }
      return { error: '' }
    } catch (e) {
      await this.close()
      return { error: say(e) }
    }
  }

  lost(why) {
    if (this.closed) return
    this.onClosed(why)
    void this.close()
  }

  /**
   * Every variable under Objects, with its path of browse names. The standard namespace (0) holds the
   * server's own model, never a program's variables, so it is not entered; nor are properties. A variable
   * is entered too, because a structure's members are its children.
   */
  async browse() {
    const ua = opcua()
    const variables = []
    let level = [{ nodeId: 'ns=0;i=85', path: [] }]
    let seen = 0
    let truncated = false
    const size = this.limits.browse > 0 ? Math.min(BROWSE_BATCH, this.limits.browse) : BROWSE_BATCH
    const children = (n) => ({ nodeId: n.nodeId, browseDirection: ua.BrowseDirection.Forward, referenceTypeId: 'HierarchicalReferences', includeSubtypes: true, nodeClassMask: 0, resultMask: 63 })
    for (let depth = 0; depth < MAX_DEPTH && level.length > 0 && !truncated; depth++) {
      const next = []
      for (let at = 0; at < level.length && !truncated; at += size) {
        const batch = level.slice(at, at + size)
        const results = await this.session.browse(batch.map(children))
        const found = []
        const retry = []
        for (let i = 0; i < results.length; i++) {
          const status = results[i].statusCode
          if (status.name === 'BadNoContinuationPoints') retry.push(batch[i])
          else if (status.isGood()) found.push([batch[i], await this.pages(results[i])])
          // any other status is a node this session may not browse, and it is left out
        }
        // A server holds only so many continuation points per session, and answers the rest of a request with
        // BadNoContinuationPoints. Those nodes go again one at a time, each one's points released before the next.
        for (const node of retry) {
          const [result] = await this.session.browse([children(node)])
          if (!result.statusCode.isGood()) throw new Error(`could not browse ${node.path.join('.') || 'Objects'} (${result.statusCode.name})`)
          found.push([node, await this.pages(result)])
        }
        for (const [node, refs] of found) {
          for (const ref of refs) {
            if (ref.nodeId.namespace === 0 || ref.referenceTypeId.toString() === HAS_PROPERTY) continue
            const path = [...node.path, ref.browseName.name]
            const nodeId = ref.nodeId.toString()
            if (ref.nodeClass === ua.NodeClass.Variable) variables.push({ path, nodeId })
            if (ref.nodeClass === ua.NodeClass.Object || ref.nodeClass === ua.NodeClass.Variable) next.push({ nodeId, path })
            if (++seen >= MAX_NODES) truncated = true
          }
        }
      }
      level = next
    }
    return { variables, truncated }
  }

  /** A browse result's references, with every page behind its continuation point. */
  async pages(result) {
    const refs = [...(result.references ?? [])]
    let cp = result.continuationPoint
    while (cp && cp.length > 0) {
      const [more] = await this.session.browseNext([cp], false)
      // a point the server dropped (BadContinuationPointInvalid) would otherwise end the list early without a word
      if (!more.statusCode.isGood()) throw new Error(`browsing the PLC's tags stopped part way (${more.statusCode.name})`)
      refs.push(...(more.references ?? []))
      cp = more.continuationPoint
    }
    return refs
  }

  /** The DataType and the user's access level of each node, for the app to bind against. */
  async describe(nodeIds) {
    const ua = opcua()
    if (nodeIds.length === 0) return []
    const reads = nodeIds.flatMap((nodeId) => [
      { nodeId, attributeId: ua.AttributeIds.DataType },
      { nodeId, attributeId: ua.AttributeIds.UserAccessLevel },
    ])
    const dv = await this.read(reads)
    return nodeIds.map((_, i) => {
      const type = dv[i * 2]
      const access = dv[i * 2 + 1]
      return {
        dataType: type.statusCode.isGood() ? type.value.value.toString() : '',
        access: access.statusCode.isGood() ? Number(access.value.value) : 0,
      }
    })
  }

  /** One cycle: the writes, then the reads. Per-item statuses come back by name ("Good", "BadNotWritable"). */
  async exchange(writes, reads) {
    const ua = opcua()
    const w = await this.write(writes.map((x) => ({ nodeId: x.nodeId, attributeId: ua.AttributeIds.Value, value: { value: { dataType: x.builtin, value: x.value } } })))
    const r = await this.read(reads.map((nodeId) => ({ nodeId, attributeId: ua.AttributeIds.Value })))
    return {
      writes: w.map((s) => s.name),
      reads: r.map((d) => ({ value: d.value?.value ?? null, status: d.statusCode.name })),
    }
  }

  /** A Read of any length, in requests the server's MaxNodesPerRead allows. */
  async read(nodes) {
    const out = []
    for (const part of chunks(nodes, this.limits.read)) if (part.length > 0) out.push(...(await this.session.read(part)))
    return out
  }

  /** A Write of any length, in requests the server's MaxNodesPerWrite allows. */
  async write(nodes) {
    const out = []
    for (const part of chunks(nodes, this.limits.write)) if (part.length > 0) out.push(...(await this.session.write(part)))
    return out
  }

  async close() {
    this.closed = true
    const { session, client } = this
    this.session = null
    this.client = null
    await session?.close().catch(() => {})
    await client?.disconnect().catch(() => {})
  }
}

/** @type {Map<number, OpcUaLink>} */
const links = new Map()
const watched = new Set()
const generation = new Map()
const bump = (id) => {
  const g = (generation.get(id) ?? 0) + 1
  generation.set(id, g)
  return g
}

function send(sender, channel, payload) {
  if (!sender.isDestroyed()) sender.send(channel, payload)
}

async function closeFor(id) {
  const link = links.get(id)
  links.delete(id)
  await link?.close()
}

/** Run `fn` on the window's link, turning a missing link or a library error into `{error}`. */
async function withLink(event, fn) {
  const link = links.get(event.sender.id)
  if (!link) return { error: 'not connected' }
  try {
    return { error: '', ...(await fn(link)) }
  } catch (e) {
    return { error: say(e) }
  }
}

/**
 * Register the `opcua:*` channels.
 *   opcua:connect  {endpoint} -> {error, discovery?}                connect and open an anonymous session;
 *                                                                   discovery: [{name, urls}] when the address
 *                                                                   is a discovery server, not a PLC
 *   opcua:browse   -> {error, variables: [{path, nodeId}], truncated} every variable under Objects
 *   opcua:describe {nodeIds} -> {error, nodes: [{dataType, access}]}
 *   opcua:exchange {writes: [{nodeId, builtin, value}], reads: [nodeId]} -> {error, writes: [status], reads: [{value, status}]}
 *   opcua:close                                                     end the session
 * and pushes
 *   opcua:closed {why}                                              the PLC went away
 * `consent` (endpointConsent.cjs `allows`) is asked before connecting to another host; without it every endpoint
 * is allowed (a caller that is not the app's window, such as a test).
 */
function registerOpcUaIo(ipcMain, { pkiRoot, consent }) {
  ipcMain.handle('opcua:connect', async (event, opts) => {
    const sender = event.sender
    const mine = bump(sender.id)
    await closeFor(sender.id)
    const endpoint = typeof opts?.endpoint === 'string' ? opts.endpoint : ''
    if (!/^opc\.tcp:\/\/\S+$/.test(endpoint)) return { error: `${endpoint || 'an empty endpoint'} is not an opc.tcp:// address` }
    const host = opcUaHost(endpoint)
    if (consent && !(await consent({ host, key: `opcua connect ${endpoint}`, what: `connect to the OPC UA server at ${endpoint}` }, sender)))
      return { error: `the connection to ${endpoint} was not allowed` }
    if (generation.get(sender.id) !== mine) return { error: 'superseded by a newer connect' }
    const link = new OpcUaLink(join(pkiRoot), (why) => {
      if (links.get(sender.id) === link) {
        links.delete(sender.id)
        send(sender, 'opcua:closed', { why })
      }
    })
    const connected = await link.connect(endpoint)
    if (connected.error) return connected
    if (generation.get(sender.id) !== mine) {
      await link.close()
      return { error: 'superseded by a newer link' }
    }
    links.set(sender.id, link)
    if (!watched.has(sender.id)) {
      watched.add(sender.id)
      const id = sender.id
      sender.once('destroyed', () => {
        watched.delete(id)
        void closeFor(id)
      })
    }
    return { error: '' }
  })
  ipcMain.handle('opcua:browse', (event) => withLink(event, (l) => l.browse()))
  ipcMain.handle('opcua:describe', (event, opts) => withLink(event, async (l) => ({ nodes: await l.describe(Array.isArray(opts?.nodeIds) ? opts.nodeIds : []) })))
  ipcMain.handle('opcua:exchange', (event, opts) => withLink(event, (l) => l.exchange(Array.isArray(opts?.writes) ? opts.writes : [], Array.isArray(opts?.reads) ? opts.reads : [])))
  ipcMain.handle('opcua:close', (event) => {
    bump(event.sender.id)
    return closeFor(event.sender.id)
  })
}

module.exports = { registerOpcUaIo, OpcUaLink }
