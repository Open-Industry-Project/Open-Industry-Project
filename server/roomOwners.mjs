// Who may close a room (docs/live-share.md "Sharing a project"). Sharing one of the user's projects makes a room, and
// Stop sharing has to make its links stop working. A link cannot be taken back without accounts, so the browser that
// shares a project registers an owner token with the room: a secret of its own, apart from the edit secret, which
// every editor holds. Closing the room takes that token, so an editor cannot close another's project.
//
// Messages are Hocuspocus stateless strings from a writer, `room1|<kind>|<token>`:
//   claim  register the token as the room's owner, when it has none (or say whether it is this one)
//   close  close the room, when the token is its owner's
// The server keeps only a hash of the token. A closed room is deleted, and refused from then on.

import { createHash } from 'node:crypto'

export const ROOM_PREFIX = 'room1|'
const TOKEN_RE = /^[A-Za-z0-9-]{16,128}$/

const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

/** Parse a room message. null = not one. */
export function parseRoomMessage(payload) {
  if (typeof payload !== 'string' || !payload.startsWith(ROOM_PREFIX)) return null
  const [kind, token, ...rest] = payload.slice(ROOM_PREFIX.length).split('|')
  if (rest.length > 0 || (kind !== 'claim' && kind !== 'close') || !TOKEN_RE.test(token ?? '')) return null
  return { kind, token }
}

/**
 * One room message from a connection, against `store` ({ ownerOf(name), setOwner(name, hash), close(name) }, async).
 * Returns { reply } for the sender, and `close: true` when the room was closed (the caller ends its connections).
 * Throws for a message the connection may not send.
 */
export async function handleRoomMessage(store, documentName, payload, { readOnly }) {
  const msg = parseRoomMessage(payload)
  if (!msg) throw new Error('not a room message')
  if (readOnly) throw new Error('a view-only connection cannot claim or close a room')
  const hash = sha256Hex(msg.token)
  const owner = await store.ownerOf(documentName)
  if (msg.kind === 'claim') {
    if (owner === null) {
      await store.setOwner(documentName, hash)
      return { reply: `${ROOM_PREFIX}claim|ok` }
    }
    return { reply: `${ROOM_PREFIX}claim|${owner === hash ? 'ok' : 'taken'}` }
  }
  if (owner === null || owner !== hash) return { reply: `${ROOM_PREFIX}close|refused` }
  await store.close(documentName)
  return { reply: `${ROOM_PREFIX}close|ok`, close: true }
}
