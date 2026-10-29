// The live-share relay (docs/live-share.md): a writer streaming its running sim to a room's other connections.
//
// Messages are Hocuspocus stateless strings, `live1|<kind>|<stream>|<body>`:
//   s  snapshot: everything a viewer needs to start (src/core/live/liveFrameWire.ts). Kept, not relayed: it is
//      ~150 KB, and only a joining or lost viewer needs one.
//   d  delta: one frame's changes. Relayed to every other connection and kept after the snapshot, so a viewer
//      joining between snapshots starts from the snapshot and catches up through these.
//   e  end: the run stopped. Relayed, and the room's stream is dropped.
//   r  resync: a viewer missed a delta and asks for the snapshot and the deltas after it. Answered here, to that
//      connection only, so a viewer can never make the server send anything to anyone else.
// Only a writer (a connection holding the room's edit secret) may send s, d or e. The relay never reads a body:
// it is opaque base64 to the server.

export const LIVE_PREFIX = 'live1|'
export const MAX_SNAPSHOT_CHARS = 8 * 1024 * 1024
export const MAX_DELTA_CHARS = 1024 * 1024
/** deltas kept after a snapshot; the sharer sends a snapshot every few seconds, so this is never reached in a healthy stream */
export const MAX_BACKLOG_CHARS = 16 * 1024 * 1024
export const RESYNC_EVERY_MS = 1000
const STREAM_RE = /^[A-Za-z0-9-]{1,64}$/

/** Parse a live message. null = not one (the caller refuses it). */
export function parseLive(payload) {
  if (typeof payload !== 'string' || !payload.startsWith(LIVE_PREFIX)) return null
  const rest = payload.slice(LIVE_PREFIX.length)
  const a = rest.indexOf('|')
  const b = a < 0 ? -1 : rest.indexOf('|', a + 1)
  if (b < 0) return null
  const kind = rest.slice(0, a)
  const stream = rest.slice(a + 1, b)
  if (!['s', 'd', 'e', 'r'].includes(kind) || !STREAM_RE.test(stream)) return null
  return { kind, stream, bodyChars: rest.length - b - 1 }
}

export class LiveRelay {
  constructor(now = () => Date.now()) {
    this.now = now
    /** documentName -> { stream, owner, snapshot, backlog, backlogChars } */
    this.rooms = new Map()
    /** connection key -> last resync time */
    this.resyncAt = new Map()
  }

  /**
   * One stateless message from a connection. Returns what to do:
   *   { broadcast: payload } send it to every other connection of the document
   *   { reply: payload[] }  send these to the sender only
   *   {}                    nothing
   * Throws for a message the connection may not send, which closes it.
   */
  handle(documentName, payload, { readOnly, key }) {
    const msg = parseLive(payload)
    if (!msg) throw new Error('stateless message is not a live-share message')
    if (msg.kind === 'r') {
      const last = this.resyncAt.get(key) ?? -Infinity
      if (this.now() - last < RESYNC_EVERY_MS) return {}
      this.resyncAt.set(key, this.now())
      return { reply: this.catchUp(documentName) }
    }
    if (readOnly) throw new Error('a view-only connection cannot share a live run')
    if (msg.kind === 's') {
      if (msg.bodyChars > MAX_SNAPSHOT_CHARS) throw new Error('live snapshot too large')
      this.rooms.set(documentName, { stream: msg.stream, owner: key, snapshot: payload, backlog: [], backlogChars: 0 })
      return {}
    }
    const room = this.rooms.get(documentName)
    if (msg.kind === 'e') {
      if (room && room.stream === msg.stream) this.rooms.delete(documentName)
      return { broadcast: payload }
    }
    if (msg.bodyChars > MAX_DELTA_CHARS) throw new Error('live delta too large')
    if (!room || room.stream !== msg.stream) return {} // a stream nobody can start from: its snapshot comes first
    if (room.snapshot !== null) {
      room.backlogChars += payload.length
      if (room.backlogChars > MAX_BACKLOG_CHARS) {
        // too far behind its last snapshot to replay: joiners wait for the next one
        room.snapshot = null
        room.backlog = []
        room.backlogChars = 0
      } else room.backlog.push(payload)
    }
    return { broadcast: payload }
  }

  /** What a connection joining now needs: the snapshot and every delta after it, or nothing when no run is live. */
  catchUp(documentName) {
    const room = this.rooms.get(documentName)
    if (!room || room.snapshot === null) return []
    return [room.snapshot, ...room.backlog]
  }

  /** A connection left. If it was sharing, the run ends for everyone: returns the end message to broadcast. */
  disconnected(documentName, key) {
    this.resyncAt.delete(key)
    const room = this.rooms.get(documentName)
    if (!room || room.owner !== key) return null
    this.rooms.delete(documentName)
    return `${LIVE_PREFIX}e|${room.stream}|`
  }

  unload(documentName) {
    this.rooms.delete(documentName)
  }
}
