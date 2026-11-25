// A strict stand-in for an MQTT broker, for tests: it reads the client's bytes with a decoder of its own (none of
// mqttClient.ts's code), refuses anything a 3.1.1 broker would refuse, and keeps what a broker keeps: the session's
// CONNECT, its subscriptions, and the retained message of each topic. A test plays the other clients through
// `deliver`.

export interface FakeConnect {
  clientId: string
  keepAliveSec: number
  cleanSession: boolean
  will: { topic: string; payload: string; retain: boolean; qos: number } | null
  username: string | null
  password: string | null
}

export class FakeBroker {
  /** the CONNACK return code the next CONNECT gets (0 accepts) */
  connack = 0
  /** whether a PINGREQ is answered */
  answersPing = true
  connect: FakeConnect | null = null
  /** every subscription, as filter and requested QoS */
  subscriptions: { filter: string; qos: number }[] = []
  /** each topic's retained message; a cleared one is gone */
  readonly retained = new Map<string, string>()
  /** every PUBLISH received, in order */
  readonly published: { topic: string; payload: string; retain: boolean }[] = []
  /** why the broker would have closed the connection, when the client broke the protocol */
  violation: string | null = null
  disconnected = false
  pings = 0
  private buf: number[] = []
  private reply: ((bytes: Uint8Array) => void) | null = null

  /** Attach the client's end: what the broker sends goes to `reply`. */
  attach(reply: (bytes: Uint8Array) => void): void {
    this.reply = reply
    this.buf = []
    this.connect = null
    this.disconnected = false
  }

  /** Bytes from the client. */
  receive(bytes: Uint8Array): void {
    this.buf.push(...bytes)
    for (;;) {
      if (this.buf.length < 2) return
      let length = 0
      let used = 0
      for (;;) {
        if (1 + used >= this.buf.length) return
        const b = this.buf[1 + used]!
        length += (b & 0x7f) * 128 ** used
        used++
        if ((b & 0x80) === 0) break
        if (used === 4) return this.fail('a remaining length of more than four bytes')
      }
      if (this.buf.length < 1 + used + length) return
      const first = this.buf[0]!
      const body = this.buf.slice(1 + used, 1 + used + length)
      this.buf = this.buf.slice(1 + used + length)
      this.packet(first >> 4, first & 0x0f, body)
    }
  }

  private fail(why: string): void {
    this.violation ??= why
  }

  private packet(type: number, flags: number, body: number[]): void {
    let at = 0
    const u16 = (): number => {
      if (at + 2 > body.length) throw new Error('short packet')
      const v = (body[at]! << 8) | body[at + 1]!
      at += 2
      return v
    }
    const str = (): string => {
      const n = u16()
      if (at + n > body.length) throw new Error('short string')
      const s = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(body.slice(at, at + n)))
      at += n
      return s
    }
    try {
      if (type !== 1 && !this.connect) return this.fail('a packet before CONNECT')
      if (type === 1) {
        if (this.connect) return this.fail('a second CONNECT')
        if (flags !== 0) return this.fail('CONNECT flags')
        if (str() !== 'MQTT' || body[at++] !== 4) return this.fail('not protocol MQTT level 4')
        const f = body[at++]!
        if (f & 0x01) return this.fail('the reserved connect flag is set')
        const keepAliveSec = u16()
        const clientId = str()
        const hasWill = (f & 0x04) !== 0
        if (!hasWill && (f & 0x38) !== 0) return this.fail('will QoS or retain without a will')
        const will = hasWill ? { topic: str(), payload: str(), retain: (f & 0x20) !== 0, qos: (f >> 3) & 3 } : null
        if (!(f & 0x80) && f & 0x40) return this.fail('a password without a user name')
        const username = f & 0x80 ? str() : null
        const password = f & 0x40 ? str() : null
        if (at !== body.length) return this.fail('bytes after the CONNECT payload')
        this.connect = { clientId, keepAliveSec, cleanSession: (f & 0x02) !== 0, will, username, password }
        if (this.connack !== 0) this.connect = null
        this.reply?.(Uint8Array.of(0x20, 2, 0, this.connack))
      } else if (type === 3) {
        if ((flags & 0x06) !== 0) return this.fail('a PUBLISH above QoS 0')
        const topic = str()
        if (topic === '' || /[+#]/.test(topic)) return this.fail(`a PUBLISH to "${topic}"`)
        const payload = new TextDecoder().decode(Uint8Array.from(body.slice(at)))
        const retain = (flags & 1) !== 0
        this.published.push({ topic, payload, retain })
        if (retain) {
          if (payload === '') this.retained.delete(topic)
          else this.retained.set(topic, payload)
        }
      } else if (type === 8) {
        if (flags !== 2) return this.fail('SUBSCRIBE flags')
        const id = u16()
        if (id === 0) return this.fail('a packet id of 0')
        const granted: number[] = []
        while (at < body.length) {
          const filter = str()
          const qos = body[at++]!
          if (qos > 2) return this.fail('a requested QoS above 2')
          this.subscriptions.push({ filter, qos })
          granted.push(qos)
        }
        if (granted.length === 0) return this.fail('a SUBSCRIBE with no filter')
        this.reply?.(Uint8Array.of(0x90, 2 + granted.length, id >> 8, id & 0xff, ...granted))
      } else if (type === 12) {
        if (flags !== 0 || body.length !== 0) return this.fail('a malformed PINGREQ')
        this.pings++
        if (this.answersPing) this.reply?.(Uint8Array.of(0xd0, 0))
      } else if (type === 14) {
        if (flags !== 0 || body.length !== 0) return this.fail('a malformed DISCONNECT')
        this.disconnected = true
      } else {
        this.fail(`packet type ${type} from a client that only publishes and subscribes`)
      }
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e))
    }
  }

  /** A message another client published, sent on to ours. `split`: in two pieces, as a network may deliver it. */
  deliver(topic: string, payload: string, opts: { retained?: boolean; split?: boolean } = {}): void {
    const t = new TextEncoder().encode(topic)
    const p = new TextEncoder().encode(payload)
    const length = 2 + t.length + p.length
    if (length > 127) throw new Error('the fake broker sends short messages only')
    const bytes = Uint8Array.of(0x30 | (opts.retained ? 1 : 0), length, t.length >> 8, t.length & 0xff, ...t, ...p)
    if (!opts.split) return this.reply?.(bytes)
    this.reply?.(bytes.slice(0, 3))
    this.reply?.(bytes.slice(3))
  }
}
