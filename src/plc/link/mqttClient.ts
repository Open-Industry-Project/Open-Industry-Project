// The MQTT 3.1.1 packets the simulator's publisher uses, as bytes. It is a client that publishes and subscribes at
// QoS 0 only, so it needs seven packets:
//
//   CONNECT  ->  CONNACK      the session, with a will the broker publishes if the connection is lost
//   SUBSCRIBE -> SUBACK       one filter, for the writes
//   PUBLISH  <->              a topic and a payload, either way, never acknowledged at QoS 0
//   PINGREQ  ->  PINGRESP     inside every keep-alive interval, or the broker closes the connection
//   DISCONNECT ->             a clean close, which tells the broker not to publish the will
//
// Every packet is one byte of type and flags, a length of one to four bytes (seven bits each, low first, the top bit
// "more follows"), then that many bytes. A string is two bytes of length, high first, then UTF-8.
//
// Like the Modbus and S7 clients this holds no socket: MqttStream frames the bytes it is given, and the functions
// build and read packets. The host owns the connection (editor/links/mqttPublisher.ts, over the desktop shell's TCP
// socket or a WebSocket), so everything that can be wrong about a packet is testable without a network.

const CONNECT = 1
export const CONNACK = 2
export const PUBLISH = 3
const SUBSCRIBE = 8
export const SUBACK = 9
const PINGREQ = 12
export const PINGRESP = 13
const DISCONNECT = 14

const utf8 = new TextEncoder()

/** A string as MQTT carries it: its length in two bytes, then UTF-8. */
function str(text: string | Uint8Array): Uint8Array {
  const bytes = typeof text === 'string' ? utf8.encode(text) : text
  if (bytes.length > 65535) throw new Error('an MQTT string holds at most 65535 bytes')
  const out = new Uint8Array(2 + bytes.length)
  out[0] = bytes.length >> 8
  out[1] = bytes.length & 0xff
  out.set(bytes, 2)
  return out
}

/** One packet: the type and flags byte, the length, then the parts. */
function packet(first: number, ...parts: Uint8Array[]): Uint8Array {
  let length = 0
  for (const p of parts) length += p.length
  if (length > 268435455) throw new Error('an MQTT packet holds at most 268435455 bytes')
  const head = [first]
  let rest = length
  do {
    const seven = rest & 0x7f
    rest >>>= 7
    head.push(rest > 0 ? seven | 0x80 : seven)
  } while (rest > 0)
  const out = new Uint8Array(head.length + length)
  out.set(head, 0)
  let at = head.length
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export interface ConnectOptions {
  clientId: string
  /** seconds without a packet from us after which the broker gives the connection up */
  keepAliveSec: number
  /** what the broker publishes, retained, when the connection is lost without a DISCONNECT */
  will?: { topic: string; payload: string }
  username?: string
  password?: string
}

/** CONNECT, for a clean session: the broker keeps no subscriptions from an earlier one. */
export function connectPacket(o: ConnectOptions): Uint8Array {
  // a password travels only with a username (3.1.2.9)
  const password = o.username !== undefined ? o.password : undefined
  const flags = 0x02 | (o.will ? 0x04 | 0x20 : 0) | (password !== undefined ? 0x40 : 0) | (o.username !== undefined ? 0x80 : 0)
  const parts = [str('MQTT'), Uint8Array.of(4, flags, (o.keepAliveSec >> 8) & 0xff, o.keepAliveSec & 0xff), str(o.clientId)]
  if (o.will) parts.push(str(o.will.topic), str(o.will.payload))
  if (o.username !== undefined) parts.push(str(o.username))
  if (password !== undefined) parts.push(str(password))
  return packet(CONNECT << 4, ...parts)
}

/** PUBLISH at QoS 0. An empty retained payload clears the topic's retained message. */
export function publishPacket(topic: string, payload: string, retain: boolean): Uint8Array {
  return packet((PUBLISH << 4) | (retain ? 1 : 0), str(topic), utf8.encode(payload))
}

/** SUBSCRIBE to one filter at QoS 0. `id` (1-65535) comes back in the SUBACK. */
export function subscribePacket(id: number, filter: string): Uint8Array {
  return packet((SUBSCRIBE << 4) | 0x02, Uint8Array.of(id >> 8, id & 0xff), str(filter), Uint8Array.of(0))
}

export const pingPacket = (): Uint8Array => Uint8Array.of(PINGREQ << 4, 0)
export const disconnectPacket = (): Uint8Array => Uint8Array.of(DISCONNECT << 4, 0)

/** A packet as it arrived: its type (the high four bits), its flags (the low four), and its bytes after the length. */
export interface MqttPacket {
  type: number
  flags: number
  body: Uint8Array
}

/** A packet that cannot be read. The connection is no use after one. */
export class MqttError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MqttError'
  }
}

/** The largest packet taken from a broker. A write is a value, so anything near this is not one. */
const MAX_INBOUND = 1 << 20

/** The byte stream as packets: a packet may arrive in pieces, and several in one piece. */
export class MqttStream {
  private pending = new Uint8Array(0)

  /** Add bytes, and take every packet that is now whole. Throws MqttError on a length that is not one. */
  push(bytes: Uint8Array): MqttPacket[] {
    let buf = bytes
    if (this.pending.length > 0) {
      buf = new Uint8Array(this.pending.length + bytes.length)
      buf.set(this.pending, 0)
      buf.set(bytes, this.pending.length)
    }
    const out: MqttPacket[] = []
    let at = 0
    for (;;) {
      let length = 0
      let used = 0
      let whole = false
      while (at + 1 + used < buf.length) {
        const b = buf[at + 1 + used]!
        length += (b & 0x7f) * 2 ** (7 * used)
        used++
        if ((b & 0x80) === 0) {
          whole = true
          break
        }
        if (used === 4) throw new MqttError('a packet length of more than four bytes')
      }
      if (!whole) break
      if (length > MAX_INBOUND) throw new MqttError(`a packet of ${length} bytes`)
      const start = at + 1 + used
      if (start + length > buf.length) break
      out.push({ type: buf[at]! >> 4, flags: buf[at]! & 0x0f, body: buf.slice(start, start + length) })
      at = start + length
    }
    this.pending = buf.slice(at)
    return out
  }
}

/** Why a broker refused the session, by CONNACK return code (3.2.2.3). */
const REFUSED: Readonly<Record<number, string>> = {
  1: 'the broker does not speak MQTT 3.1.1',
  2: 'the broker refused the client id',
  3: 'the broker is not available',
  4: 'the broker refused the user name or password',
  5: 'the broker does not allow this client (it may need a user name and password)',
}

/** A CONNACK's verdict: '' when the session is open, else why not. `auth`: the login is what it refused. */
export function readConnack(p: MqttPacket): { error: string; auth: boolean } {
  if (p.type !== CONNACK || p.body.length !== 2) throw new MqttError('not a CONNACK')
  const code = p.body[1]!
  if (code === 0) return { error: '', auth: false }
  return { error: REFUSED[code] ?? `the broker refused the connection (code ${code})`, auth: code === 4 || code === 5 }
}

/** A SUBACK's verdict for the one filter asked: whether the broker took the subscription. */
export function readSuback(p: MqttPacket): { id: number; granted: boolean } {
  if (p.type !== SUBACK || p.body.length < 3) throw new MqttError('not a SUBACK')
  return { id: (p.body[0]! << 8) | p.body[1]!, granted: p.body[2] !== 0x80 }
}

const text = new TextDecoder('utf-8', { fatal: false })

/** A PUBLISH from the broker: its topic, its payload as text, and whether it is a retained message (one stored before
 *  we subscribed, not one published now). */
export function readPublish(p: MqttPacket): { topic: string; payload: string; retained: boolean } {
  if (p.type !== PUBLISH || p.body.length < 2) throw new MqttError('not a PUBLISH')
  const topicLength = (p.body[0]! << 8) | p.body[1]!
  // above QoS 0 a packet id follows the topic; we subscribe at 0, so a broker never sends one, but skip it if it does
  const start = 2 + topicLength + ((p.flags & 0x06) !== 0 ? 2 : 0)
  if (start > p.body.length) throw new MqttError('a PUBLISH shorter than its topic')
  return { topic: text.decode(p.body.subarray(2, 2 + topicLength)), payload: text.decode(p.body.subarray(start)), retained: (p.flags & 0x01) !== 0 }
}
