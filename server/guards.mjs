// Pure helpers behind the server's abuse limits, kept apart from index.mjs (which opens the
// database and listens as soon as it is imported) so they can be exercised on their own.
import { isIPv6 } from 'node:net'

export const isLoopback = (addr) => addr === '::1' || /^(::ffff:)?127\./.test(addr ?? '')

/**
 * The address the per-IP limits count a request under. Caddy terminates TLS in front of us and
 * sets X-Forwarded-For (it replaces whatever the client sent, since no trusted_proxies are
 * configured). The header is only believed from a loopback peer, i.e. from Caddy itself: if HOST
 * is ever opened up, a direct client is keyed by its socket address instead of by whatever it
 * chose to write. A direct (dev) connection falls back the same way.
 */
export function clientIp(request) {
  const peer = request?.socket?.remoteAddress
  const fwd = request?.headers?.['x-forwarded-for']
  if (isLoopback(peer) && typeof fwd === 'string' && fwd.length > 0) return ipKey(fwd.split(',')[0].trim())
  return ipKey(peer ?? 'unknown')
}

/**
 * IPv4 is the address; IPv6 is its /64, because one subscriber is routinely handed a whole /64
 * (SLAAC, privacy addresses) and could otherwise mint a fresh "IP" per connection and walk
 * straight through every per-IP cap. An IPv4-mapped IPv6 address (`::ffff:1.2.3.4`, what a
 * dual-stack socket reports) is its IPv4 address. Anything unparseable is returned as given.
 */
export function ipKey(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return mapped[1]
  const bare = ip.split('%')[0] // a zone index (fe80::1%eth0) is not part of the address
  if (!isIPv6(bare)) return ip
  let groups = bare.split(':')
  if (bare.includes('::')) {
    const [head, tail] = bare.split('::')
    const left = head ? head.split(':') : []
    const right = tail ? tail.split(':') : []
    // An embedded IPv4 tail (64:ff9b::1.2.3.4) is two groups written as one, which miscounts the
    // zero run by one; it only ever sits in the low 32 bits, so the /64 kept here is unaffected.
    groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  }
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`
}

// Hocuspocus message types (@hocuspocus/common MessageType) and y-protocols sync steps
export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
export const MSG_SYNC_REPLY = 4
export const MSG_STATELESS = 5
export const MSG_BROADCAST_STATELESS = 6
export const SYNC_STEP1 = 0
export const SYNC_STEP2 = 1
export const SYNC_UPDATE = 2

/**
 * Read the head of a raw Hocuspocus message: `varString documentName, varUint type`, and for a
 * sync message one more `varUint step`. beforeHandleMessage is handed the undecoded frame, and the
 * limits depend on what kind of message it is (presence vs document content), so this decodes
 * just enough to tell. Returns null for a frame too short or malformed to have a head, which the
 * caller refuses: Hocuspocus would throw on it anyway.
 */
export function readMessageHead(bytes) {
  let pos = 0
  const varUint = () => {
    let n = 0
    let mult = 1
    for (;;) {
      if (pos >= bytes.length || mult > 2 ** 49) return null
      const b = bytes[pos++]
      n += (b & 0x7f) * mult
      if (b < 0x80) return n
      mult *= 128
    }
  }
  const nameLen = varUint()
  if (nameLen === null || pos + nameLen > bytes.length) return null
  pos += nameLen
  const type = varUint()
  if (type === null) return null
  if (type !== MSG_SYNC && type !== MSG_SYNC_REPLY) return { type, step: null }
  const step = varUint()
  return step === null ? null : { type, step }
}
