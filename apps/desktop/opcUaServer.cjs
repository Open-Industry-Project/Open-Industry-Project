// The desktop shell's OPC UA server: the simulated PLC's variables, published by name for a SCADA or HMI
// (a SCADA, an HMI panel, a test client) the way a real PLC's own OPC UA server publishes its program's.
//
// The reverse of opcUaIo.cjs, which is a client of a real PLC's server. Here the app's own program
// keeps running in the sim worker, and whatever connects sees its variables and writes the ones an operator
// may write (a Start button, a setpoint). As in opcUaIo.cjs, node-opcua handles the protocol and the app decides
// everything else (src/editor/links/opcUaServer.ts): which variables are published, as which type, which of them a
// client may write, and what a write does. This file only turns that into nodes.
//
// An array is published as a real PLC's server publishes one: a node that holds every element, read and written whole
// or by index range (counted from 0, as OPC UA counts). A short array's elements are nodes of their own under it as
// well, each named by the PLC's own index (`[3]`), for a client that cannot send an index range.
//
// Unsecured on purpose, for now, like the client: security policy None and anonymous sessions. It listens on
// this machine only unless the user says otherwise, which is what a SCADA on the same workstation needs.
//
// One server per window, closed with it. node-opcua is loaded on the first start, not at startup.

const { join } = require('node:path')

let lib = null
const { BAD_LINK, heldByAnotherWindow, linkKey, linkNo, onPageGone, windowKeys } = require('./linkKeys.cjs')

function opcua() {
  // the client package re-exports the shared types (Variant, StatusCodes, SecurityPolicy); the server's own
  // exports override them where both define a name
  lib ??= { ...require('node-opcua-client'), ...require('node-opcua-server'), ...require('node-opcua-certificate-manager') }
  return lib
}

/** OPC UA built-in type ids to the DataType names node-opcua takes (Part 6, 5.1.2); the app sends the id. */
const DATA_TYPE = { 1: 'Boolean', 2: 'SByte', 3: 'Byte', 4: 'Int16', 5: 'UInt16', 6: 'Int32', 7: 'UInt32', 10: 'Float', 11: 'Double', 12: 'String' }

/** The fastest a client may sample a variable. The app pushes values at the PLC watch's 10 Hz, so sampling faster gains nothing. */
const MIN_SAMPLING_MS = 50

/** A variable's name as the folders above it and its own browse name: `Main.T1.Q` is Main, T1, then Q. */
function segments(name) {
  return name.split('.')
}

/** An array may hold this many elements and be one node: a client reads and writes the whole value in one message. */
const MAX_ARRAY_ELEMENTS = 65536

/** An element's name as its array's and its index: `Main.Lane[3]` is Main.Lane at 3, `Grid[2,3]` is Grid at 2, 3. */
function elementOf(name) {
  const m = /^(.+)\[(-?\d+(?:,-?\d+)*)\]$/.exec(name)
  return m ? { array: m[1], at: m[2].split(',').map(Number), index: `[${m[2]}]` } : null
}

/** The typed array a number type's elements travel in; a Boolean's and a String's travel in a plain array. */
const TYPED = { 2: Int8Array, 3: Uint8Array, 4: Int16Array, 5: Uint16Array, 6: Int32Array, 7: Uint32Array, 10: Float32Array, 11: Float64Array }

/** What an element reads as before the app has sent its value. */
const blank = (builtin) => (builtin === 1 ? false : builtin === 12 ? '' : 0)

/** An array as the app describes it, or null when it is not one this server can publish. */
function arrayShape(a) {
  if (!a || typeof a.name !== 'string' || a.name === '' || !DATA_TYPE[a.builtin] || !Array.isArray(a.dims) || a.dims.length === 0) return null
  const sizes = []
  for (const d of a.dims) {
    if (!Number.isInteger(d?.lo) || !Number.isInteger(d?.hi) || d.hi < d.lo) return null
    sizes.push(d.hi - d.lo + 1)
  }
  const count = sizes.reduce((n, x) => n * x, 1)
  if (count > MAX_ARRAY_ELEMENTS) return null
  return { name: a.name, builtin: a.builtin, writable: a.writable === true, dims: a.dims.map((d) => ({ lo: d.lo, hi: d.hi })), sizes, count }
}

/** Where an element is in its array's values, which run with the last index fastest, or -1 when it is outside the bounds. */
function offsetOf(shape, at) {
  if (at.length !== shape.dims.length) return -1
  let off = 0
  for (let k = 0; k < at.length; k++) {
    const d = shape.dims[k]
    if (!(at[k] >= d.lo && at[k] <= d.hi)) return -1
    off = off * shape.sizes[k] + (at[k] - d.lo)
  }
  return off
}

/** The element at `off`, by the name the program gives it: the PLC's own index, from each dimension's lower bound. */
function elementName(shape, off) {
  const at = new Array(shape.dims.length)
  for (let k = shape.dims.length - 1; k >= 0; k--) {
    at[k] = shape.dims[k].lo + (off % shape.sizes[k])
    off = Math.floor(off / shape.sizes[k])
  }
  return `${shape.name}[${at.join(',')}]`
}

/**
 * An index range as text (`3`, `2:5`, `1,0:3`) as a first and last offset per dimension, counted from 0. Null when
 * it is not one for an array of this shape; 'past' when it reaches beyond the end.
 */
function rangeOf(text, sizes) {
  const parts = text.split(',')
  if (parts.length !== sizes.length) return null
  const out = []
  for (let k = 0; k < parts.length; k++) {
    const m = /^(\d+)(?::(\d+))?$/.exec(parts[k])
    if (!m) return null
    const lo = Number(m[1])
    const hi = m[2] === undefined ? lo : Number(m[2])
    if (hi < lo || (m[2] !== undefined && hi === lo)) return null
    out.push([lo, hi])
  }
  return out.some(([, hi], k) => hi >= sizes[k]) ? 'past' : out
}

class SimOpcUaServer {
  /** @param {string} pkiRoot @param {{ onWrite: (name: string, value: unknown) => void, onClients: (clients: string[]) => void }} events */
  constructor(pkiRoot, events) {
    this.pkiRoot = pkiRoot
    this.events = events
    this.server = null
    this.ns = null
    this.root = null
    /** name -> { node, builtin, writable, value, under, off }: `under` the array it is an element of, '' when none */
    this.vars = new Map()
    /** name -> an array's shape (arrayShape) with { node, values, filled, held }: `values` every element's, last index fastest */
    this.arrays = new Map()
    /** folder path ('' for the root) -> { node, children } */
    this.folders = new Map()
    /** whether the simulation runs: while it does not, reads say so (BadOutOfService) and writes are refused */
    this.running = false
    this.closed = false
  }

  /** Listen on `port`, on this machine only unless `network`. `{error: ''}` and the endpoint's URL, or why not. */
  async start({ port, network }) {
    const ua = opcua()
    const server = new ua.OPCUAServer({
      port,
      // bound to loopback, the endpoint has to name loopback too: a client connects to the URL the server's
      // endpoint list gives, and the machine's own name resolves to an address nothing listens on
      ...(network ? {} : { host: '127.0.0.1', hostname: '127.0.0.1' }),
      securityPolicies: [ua.SecurityPolicy.None],
      securityModes: [ua.MessageSecurityMode.None],
      allowAnonymous: true,
      // no Local Discovery Server to register with: a client is pointed at this address directly
      registerServerMethod: ua.RegisterServerMethod.HIDDEN,
      serverInfo: { applicationName: { text: 'Open Industry Project simulator', locale: 'en' } },
      buildInfo: { productName: 'Open Industry Project simulator', manufacturerName: 'Open Industry Project' },
      serverCertificateManager: new ua.OPCUACertificateManager({ rootFolder: join(this.pkiRoot, 'server'), automaticallyAcceptUnknownCertificate: true }),
    })
    this.server = server
    try {
      await server.initialize()
      if (this.closed) throw new Error('closed')
      const addressSpace = server.engine.addressSpace
      this.ns = addressSpace.getOwnNamespace()
      // everything under one object, so a client browsing Objects finds the program in one place
      this.root = this.ns.addObject({ organizedBy: addressSpace.rootFolder.objects, browseName: 'PLC', nodeId: 's=/' })
      this.folders.set('', { node: this.root, children: 0 })
      server.on('session_activated', () => this.events.onClients(this.clients()))
      // raised while the closing session is still listed, so it is left out by hand
      server.on('session_closed', (closing) => this.events.onClients(this.clients(closing)))
      await server.start()
      if (this.closed) throw new Error('closed')
      return { error: '', endpoint: server.getEndpointUrl() }
    } catch (e) {
      await this.stop()
      const text = String(e?.message ?? e)
      if (/EADDRINUSE/.test(text)) return { error: `port ${port} is already in use${network ? '' : ' on this machine'}` }
      if (/EACCES/.test(text)) return { error: `port ${port} may not be opened by this user` }
      return { error: text.split('\n')[0] }
    }
  }

  /** The clients with a session open now, as the dock names them: the client application's own name and its address, "<name> (127.0.0.1)". */
  clients(closing = null) {
    return (this.server?.engine?.getSessions() ?? [])
      .filter((s) => s !== closing && s.status === 'active')
      .map((s) => {
        const name = s.clientDescription?.applicationName?.text || s.clientDescription?.applicationUri || 'a client'
        const remote = s.channel?.remoteAddress
        return remote ? `${name} (${String(remote).replace(/^::ffff:/, '')})` : name
      })
  }

  /** The folder a variable sits in, made on the way down. */
  folder(path) {
    const key = path.join('.')
    const known = this.folders.get(key)
    if (known) return known
    const parent = this.folder(path.slice(0, -1))
    const node = this.ns.addObject({ organizedBy: parent.node, browseName: path.at(-1), nodeId: `s=/${key}` })
    parent.children++
    const made = { node, children: 0 }
    this.folders.set(key, made)
    return made
  }

  /** Drop a folder that no longer holds anything, and any above it that empties with it. Never the root. */
  prune(path) {
    for (let p = path; p.length > 0; p = p.slice(0, -1)) {
      const key = p.join('.')
      const f = this.folders.get(key)
      if (!f || f.children > 0) return
      this.ns.deleteNode(f.node)
      this.folders.delete(key)
      this.folders.get(p.slice(0, -1).join('.')).children--
    }
  }

  /**
   * Publish exactly these variables and arrays. One whose name and type are unchanged keeps its node, so a client's
   * subscription to it survives a Stop and Play, or the program being reloaded; the rest are added or removed.
   *
   * An array is one node holding every element. `listed`: its elements are among `nodes` too, and each becomes a node
   * under the array's, with its value kept in step with the array's. The elements of an array that is not listed have
   * no node, and their values arrive by name in `update`.
   * @param {{name: string, builtin: number, writable: boolean, value: unknown}[]} nodes
   * @param {{name: string, builtin: number, writable: boolean, dims: {lo: number, hi: number}[], listed: boolean}[]} [arrays]
   */
  define(nodes, arrays = []) {
    if (!this.ns || this.closed) return // not listening: nothing to publish into
    const ua = opcua()
    const want = new Map(nodes.filter((n) => DATA_TYPE[n.builtin] && n.name).map((n) => [n.name, n]))
    const wantArrays = new Map()
    for (const a of arrays) {
      const shape = arrayShape(a)
      // (a variable of the same name would be the same node)
      if (shape && !want.has(shape.name)) wantArrays.set(shape.name, { ...shape, listed: a.listed === true })
    }
    /** the array whose node an element sits under, '' for a variable that is no element of a published array */
    const under = (name) => {
      const e = elementOf(name)
      const shape = e ? wantArrays.get(e.array) : undefined
      return shape && offsetOf(shape, e.at) >= 0 ? e.array : ''
    }
    const sameShape = (x, y) => y !== undefined && x.builtin === y.builtin && x.writable === y.writable && x.dims.length === y.dims.length && x.dims.every((d, k) => d.lo === y.dims[k].lo && d.hi === y.dims[k].hi)
    const stale = new Set([...this.arrays].filter(([name, held]) => !sameShape(held, wantArrays.get(name))).map(([name]) => name))
    const drop = (name, node) => {
      this.ns.deleteNode(node)
      const path = segments(name).slice(0, -1)
      this.folders.get(path.join('.')).children--
      this.prune(path)
    }
    // elements go before the array node they sit under
    for (const [name, v] of [...this.vars]) {
      const next = want.get(name)
      if (next && next.builtin === v.builtin && next.writable === v.writable && v.under === under(name) && !stale.has(v.under)) continue
      this.vars.delete(name)
      drop(name, v.node)
    }
    for (const name of stale) {
      const held = this.arrays.get(name)
      this.arrays.delete(name)
      drop(name, held.node)
    }
    for (const shape of wantArrays.values()) {
      if (this.arrays.has(shape.name)) continue
      const segs = segments(shape.name)
      const parent = this.folder(segs.slice(0, -1))
      const entry = { ...shape, node: null, values: new Array(shape.count).fill(blank(shape.builtin)), filled: false, held: null }
      const access = shape.writable ? 'CurrentRead | CurrentWrite' : 'CurrentRead'
      entry.node = this.ns.addVariable({
        componentOf: parent.node,
        browseName: segs.at(-1),
        nodeId: `s=${shape.name}`,
        dataType: DATA_TYPE[shape.builtin],
        valueRank: shape.dims.length,
        arrayDimensions: shape.sizes,
        accessLevel: access,
        userAccessLevel: access,
        minimumSamplingInterval: MIN_SAMPLING_MS,
        // the library reads an index range out of the whole value this gives it
        value: { timestamped_get: () => this.arrayValue(entry) },
      })
      if (shape.writable) {
        // A write is taken here, not through the library's own setter: that one is handed the written elements
        // without their index range, and merges them into the value it last read, which may be an old one.
        const writeAttribute = entry.node.writeAttribute.bind(entry.node)
        entry.node.writeAttribute = (context, writeValue, callback) => {
          if (writeValue.attributeId !== ua.AttributeIds.Value) return writeAttribute(context, writeValue, callback)
          callback(null, this.writeArray(entry, writeValue))
        }
      }
      parent.children++
      this.arrays.set(shape.name, entry)
    }
    for (const n of want.values()) {
      const array = this.arrays.get(under(n.name))
      const off = array ? offsetOf(array, elementOf(n.name).at) : -1
      const known = this.vars.get(n.name)
      if (known) known.value = n.value
      else {
        const segs = segments(n.name)
        const folder = this.folder(segs.slice(0, -1))
        const entry = { node: null, builtin: n.builtin, writable: n.writable, value: n.value, under: array ? array.name : '', off }
        const access = n.writable ? 'CurrentRead | CurrentWrite' : 'CurrentRead'
        entry.node = this.ns.addVariable({
          componentOf: array ? array.node : folder.node,
          browseName: array ? elementOf(n.name).index : segs.at(-1),
          nodeId: `s=${n.name}`,
          dataType: DATA_TYPE[n.builtin],
          accessLevel: access,
          userAccessLevel: access,
          minimumSamplingInterval: MIN_SAMPLING_MS,
          value: {
            get: () => (this.running ? new ua.Variant({ dataType: n.builtin, value: entry.value }) : ua.StatusCodes.BadOutOfService),
            set: (variant) => {
              if (!this.running) return ua.StatusCodes.BadInvalidState
              entry.value = variant.value
              if (entry.under) this.put(this.arrays.get(entry.under), entry.off, variant.value)
              this.events.onWrite(n.name, variant.value)
              return ua.StatusCodes.Good
            },
          },
        })
        folder.children++
        this.vars.set(n.name, entry)
      }
      if (array) this.put(array, off, n.value)
    }
  }

  /** One element's value into its array's. */
  put(array, off, value) {
    array.values[off] = value
    array.filled = true
    array.held = null
  }

  /**
   * An array node's value, built again only when an element changed: a client's subscription compares what it is
   * handed with what it was handed last. Out of service while nothing runs the program, as a variable is, and
   * waiting for data until the app has sent the elements' values.
   */
  arrayValue(array) {
    const ua = opcua()
    const state = !this.running ? 'out' : array.filled ? 'good' : 'waiting'
    if (array.held && array.held.state === state) return array.held.value
    const now = new Date()
    const stamps = { sourceTimestamp: now, serverTimestamp: now }
    const value =
      state === 'good'
        ? new ua.DataValue({
            ...stamps,
            value: {
              dataType: array.builtin,
              arrayType: array.dims.length === 1 ? ua.VariantArrayType.Array : ua.VariantArrayType.Matrix,
              ...(array.dims.length > 1 && { dimensions: array.sizes }),
              value: TYPED[array.builtin] ? TYPED[array.builtin].from(array.values) : array.values.slice(),
            },
          })
        : new ua.DataValue({ ...stamps, statusCode: state === 'out' ? ua.StatusCodes.BadOutOfService : ua.StatusCodes.BadWaitingForInitialData })
    array.held = { state, value }
    return value
  }

  /**
   * A client's write to an array node: the whole array, or the elements an index range names. Each element written
   * reaches the app by its own name, as a write to a variable does. The status the client is answered with.
   */
  writeArray(array, writeValue) {
    const ua = opcua()
    if (!this.running || !array.filled) return ua.StatusCodes.BadInvalidState
    const variant = writeValue.value?.value
    if (!variant || variant.dataType !== array.builtin || variant.arrayType === ua.VariantArrayType.Scalar || variant.value == null) return ua.StatusCodes.BadTypeMismatch
    const text = writeValue.indexRange && !writeValue.indexRange.isEmpty() ? String(writeValue.indexRange) : ''
    const range = text === '' ? array.sizes.map((n) => [0, n - 1]) : rangeOf(text, array.sizes)
    if (range === null) return ua.StatusCodes.BadIndexRangeInvalid
    if (range === 'past') return ua.StatusCodes.BadIndexRangeNoData
    const written = Array.from(variant.value)
    if (written.length !== range.reduce((n, [lo, hi]) => n * (hi - lo + 1), 1)) return text === '' ? ua.StatusCodes.BadTypeMismatch : ua.StatusCodes.BadIndexRangeInvalid
    // the written block in the array's own order, last index fastest
    const at = range.map(([lo]) => lo)
    for (let i = 0; i < written.length; i++) {
      let off = 0
      for (let k = 0; k < at.length; k++) off = off * array.sizes[k] + at[k]
      const name = elementName(array, off)
      this.put(array, off, written[i])
      const element = this.vars.get(name)
      if (element) element.value = written[i]
      this.events.onWrite(name, written[i])
      for (let k = at.length - 1; k >= 0; k--) {
        if (at[k] < range[k][1]) {
          at[k]++
          break
        }
        at[k] = range[k][0]
      }
    }
    return ua.StatusCodes.Good
  }

  /**
   * The latest values, by name; a name not published is ignored. `running` false marks them all out of service. An
   * element's value goes into its array's too, whether or not the element has a node of its own.
   */
  update(values, running) {
    this.running = running
    for (const [name, value] of Object.entries(values)) {
      const v = this.vars.get(name)
      if (v) {
        v.value = value
        if (v.under) this.put(this.arrays.get(v.under), v.off, value)
        continue
      }
      const e = elementOf(name)
      const array = e ? this.arrays.get(e.array) : undefined
      const off = array ? offsetOf(array, e.at) : -1
      if (off >= 0) this.put(array, off, value)
    }
  }

  async stop() {
    this.closed = true
    const server = this.server
    this.server = null
    this.vars.clear()
    this.arrays.clear()
    this.folders.clear()
    await server?.shutdown(0).catch(() => {})
  }
}

/** @type {Map<string, SimOpcUaServer>} by window and controller (linkKeys.cjs) */
const servers = new Map()
const watched = new Set()
const generation = new Map()
const bump = (key) => {
  const g = (generation.get(key) ?? 0) + 1
  generation.set(key, g)
  return g
}

function send(sender, channel, payload) {
  if (!sender.isDestroyed()) sender.send(channel, payload)
}

async function stopFor(key) {
  const s = servers.get(key)
  servers.delete(key)
  await s?.stop()
}

/**
 * Register the `opcuaserver:*` channels. A window runs one server per controller, each on a port of its own: `link` is
 * the controller's number, as its PLC link's (linkKeys.cjs), 0 for the default controller and when absent.
 *   opcuaserver:start  {port, network, link} -> {error, endpoint}    listen (a server already running is replaced)
 *   opcuaserver:define {nodes: [{name, builtin, writable, value}], arrays?: [{name, builtin, writable, dims: [{lo, hi}], listed}], link}
 *                                                                    publish exactly these variables and arrays
 *   opcuaserver:update {values: {name: value}, running, link}        the latest values (fire and forget)
 *   opcuaserver:stop   {link}                                        stop listening
 * and pushes, each with the `link` it is from
 *   opcuaserver:write {name, value, link}                            a client wrote a writable variable, or one
 *                                                                    element of an array (by the element's name)
 *   opcuaserver:clients {clients: string[], link}                    the clients with a session open
 * `consent` (endpointConsent.cjs `allows`) is asked before the server listens on the network rather than on this
 * machine only; without it that is allowed (a caller that is not the app's window, such as a test).
 */
function registerOpcUaServer(ipcMain, { pkiRoot, consent }) {
  ipcMain.handle('opcuaserver:start', async (event, opts) => {
    const sender = event.sender
    const link = linkNo(opts)
    if (link === null) return { error: BAD_LINK, endpoint: '' }
    const key = linkKey(sender.id, link)
    const mine = bump(key)
    await stopFor(key)
    const port = Number(opts?.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `port ${opts?.port} is not a TCP port (1-65535)`, endpoint: '' }
    if (opts?.network === true && consent) {
      const what = `let a SCADA or HMI on the network read and write the simulator's tags over OPC UA on port ${port}`
      if (!(await consent({ host: '0.0.0.0', key: `opcuaserver network ${port}`, what }, sender)))
        return { error: `serving OPC UA to the network on port ${port} was not allowed`, endpoint: '' }
      if (generation.get(key) !== mine) return { error: 'superseded by a newer start', endpoint: '' }
    }
    const server = new SimOpcUaServer(pkiRoot, {
      onWrite: (name, value) => send(sender, 'opcuaserver:write', { name, value, link }),
      onClients: (clients) => send(sender, 'opcuaserver:clients', { clients, link }),
    })
    const started = await server.start({ port, network: opts?.network === true })
    if (started.error) return { error: (/already in use/.test(started.error) && heldByAnotherWindow(servers, sender.id, port)) || started.error, endpoint: '' }
    if (generation.get(key) !== mine) {
      await server.stop()
      return { error: 'superseded by a newer start', endpoint: '' }
    }
    server.port = port
    servers.set(key, server)
    onPageGone(sender, watched, (id) => {
      for (const k of windowKeys(servers, id)) void stopFor(k)
    })
    return started
  })
  ipcMain.handle('opcuaserver:define', (event, opts) => {
    const link = linkNo(opts)
    const server = link === null ? undefined : servers.get(linkKey(event.sender.id, link))
    if (!server) return { error: link === null ? BAD_LINK : 'not started' }
    try {
      server.define(Array.isArray(opts?.nodes) ? opts.nodes : [], Array.isArray(opts?.arrays) ? opts.arrays : [])
      return { error: '' }
    } catch (e) {
      return { error: String(e?.message ?? e).split('\n')[0] }
    }
  })
  ipcMain.on('opcuaserver:update', (event, msg) => {
    const link = linkNo(msg)
    if (link === null) return
    servers.get(linkKey(event.sender.id, link))?.update(msg?.values ?? {}, msg?.running === true)
  })
  ipcMain.handle('opcuaserver:stop', (event, opts) => {
    const link = linkNo(opts)
    if (link === null) return undefined
    const key = linkKey(event.sender.id, link)
    bump(key)
    return stopFor(key)
  })
}

module.exports = { registerOpcUaServer, SimOpcUaServer }
