// The desktop shell's half of an external PLC link: a plain TCP socket, and nothing else.
//
// The renderer (the sandboxed app) cannot open a socket, so the main process opens it and carries bytes
// both ways over IPC. The direction depends on the PLC: one that polls (OpenPLC) connects to a listener
// here, and one that serves (a Modbus server device) is connected to from here. Either way main
// knows no protocol. Every Modbus decision is made in the app, by src/plc/link/modbusServer.ts and
// src/plc/link/modbusClient.ts, which are unit-tested there (src/editor/links/externalPlc.ts is the renderer's twin of
// this file). Main stays this simple on purpose: the app's own tests cover everything that can be wrong
// about a frame, and a main process that decoded Modbus would be a second copy of that logic.
//
// One link per window - a listener or an outgoing connection - closed with it. Connections are numbered;
// the renderer answers by number.

const { createServer, Socket } = require('node:net')

/** @type {Map<number, { server: import('node:net').Server | null, sockets: Map<number, import('node:net').Socket> }>} */
const links = new Map()
/** windows whose teardown already closes their link */
const watched = new Set()
/**
 * Per window, bumped by every listen, connect and close: a connect still waiting on the network when a newer
 * request arrives (Stop, then Play again, inside the connect's latency) must not install itself over it.
 */
const generation = new Map()
const bump = (senderId) => {
  const g = (generation.get(senderId) ?? 0) + 1
  generation.set(senderId, g)
  return g
}
/** connection ids are unique across a window's links, so a late byte from an old link cannot reach a new one */
let nextId = 1

function send(sender, channel, payload) {
  if (!sender.isDestroyed()) sender.send(channel, payload)
}

function closeFor(senderId) {
  const l = links.get(senderId)
  if (!l) return Promise.resolve()
  links.delete(senderId)
  for (const s of l.sockets.values()) s.destroy()
  const server = l.server
  return server ? new Promise((resolve) => server.close(() => resolve())) : Promise.resolve()
}

/** Close a window's link when the window goes, once per window. */
function watch(sender) {
  if (watched.has(sender.id)) return
  watched.add(sender.id)
  const id = sender.id
  sender.once('destroyed', () => {
    watched.delete(id)
    void closeFor(id)
  })
}

const portError = (port) => (!Number.isInteger(port) || port < 1 || port > 65535 ? `port ${port} is not a TCP port (1-65535)` : '')

/** Carry a socket's bytes and its end to the renderer, under `id`. */
function carry(sender, entry, id, socket, remote) {
  entry.sockets.set(id, socket)
  socket.setNoDelay(true)
  send(sender, 'plcio:connection', { id, remote, open: true })
  socket.on('data', (chunk) => send(sender, 'plcio:data', { id, bytes: new Uint8Array(chunk) }))
  socket.on('error', () => {}) // a peer dropping its connection is routine; 'close' follows
  socket.on('close', () => {
    entry.sockets.delete(id)
    send(sender, 'plcio:connection', { id, remote, open: false })
  })
}

/**
 * Register the `plcio:*` channels.
 *   plcio:listen  {host, port} -> {error: string}            start this window's listener (a PLC that polls)
 *   plcio:connect {host, port} -> {error: string, id: number} connect to a PLC's server (a PLC that serves)
 *   plcio:close                                              stop the link and drop its connections
 *   plcio:write   {id, bytes}                                send bytes on a connection
 *   plcio:drop    {id}                                       close a connection (a stream that is not Modbus)
 * and pushes
 *   plcio:connection {id, remote, open}                      a connection opened or went away
 *   plcio:data {id, bytes}                                   bytes the other end sent
 * `consent` (endpointConsent.cjs `allows`) is asked before a socket that reaches off this machine: a listener on a
 * network interface, or a connection to another host. Without it every endpoint is allowed (a caller that is not
 * the app's window, such as a test).
 */
function registerPlcIo(ipcMain, { consent } = {}) {
  ipcMain.handle('plcio:listen', async (event, opts) => {
    const sender = event.sender
    bump(sender.id)
    await closeFor(sender.id)
    const host = typeof opts?.host === 'string' && opts.host ? opts.host : '127.0.0.1'
    const port = Number(opts?.port)
    const bad = portError(port)
    if (bad) return { error: bad }
    const what = `let a PLC on the network connect to the simulator on port ${port} (${host})`
    if (consent && !(await consent({ host, key: `plcio listen ${host}:${port}`, what }, sender)))
      return { error: `listening on ${host}:${port} was not allowed` }
    const entry = { server: null, sockets: new Map() }
    const server = createServer((socket) => carry(sender, entry, nextId++, socket, `${socket.remoteAddress}:${socket.remotePort}`))
    entry.server = server
    const error = await new Promise((resolve) => {
      server.once('error', (e) => resolve(e.code === 'EADDRINUSE' ? `port ${port} is already in use on ${host}` : String(e.message || e)))
      server.listen(port, host, () => resolve(''))
    })
    if (error) return { error }
    links.set(sender.id, entry)
    watch(sender)
    return { error: '' }
  })

  ipcMain.handle('plcio:connect', async (event, opts) => {
    const sender = event.sender
    const mine = bump(sender.id)
    await closeFor(sender.id)
    const host = typeof opts?.host === 'string' && opts.host ? opts.host : '127.0.0.1'
    const port = Number(opts?.port)
    const bad = portError(port)
    if (bad) return { error: bad, id: 0 }
    const what = `connect to a PLC at ${host}:${port}`
    if (consent && !(await consent({ host, key: `plcio connect ${host}:${port}`, what }, sender)))
      return { error: `the connection to ${host}:${port} was not allowed`, id: 0 }
    if (generation.get(sender.id) !== mine) return { error: 'superseded by a newer connect', id: 0 }
    const socket = new Socket()
    const error = await new Promise((resolve) => {
      socket.setTimeout(3000, () => socket.destroy(Object.assign(new Error(''), { code: 'ETIMEDOUT' })))
      socket.once('error', (e) =>
        resolve(
          e.code === 'ECONNREFUSED'
            ? `nothing is listening on ${host}:${port}`
            : e.code === 'ETIMEDOUT'
              ? `no answer from ${host}:${port} within 3 s`
              : e.code === 'ENOTFOUND'
                ? `no host named ${host}`
                : String(e.message || e),
        ),
      )
      socket.connect(port, host, () => resolve(''))
    })
    if (error || generation.get(sender.id) !== mine) {
      socket.destroy()
      return { error: error || 'superseded by a newer link', id: 0 }
    }
    socket.setTimeout(0)
    const entry = { server: null, sockets: new Map() }
    const id = nextId++
    links.set(sender.id, entry)
    watch(sender)
    carry(sender, entry, id, socket, `${host}:${port}`)
    return { error: '', id }
  })

  ipcMain.handle('plcio:close', (event) => {
    bump(event.sender.id)
    return closeFor(event.sender.id)
  })
  ipcMain.on('plcio:write', (event, msg) => {
    const socket = links.get(event.sender.id)?.sockets.get(msg?.id)
    if (socket && msg.bytes) socket.write(Buffer.from(msg.bytes))
  })
  ipcMain.on('plcio:drop', (event, msg) => {
    links.get(event.sender.id)?.sockets.get(msg?.id)?.destroy()
  })
}

module.exports = { registerPlcIo }
