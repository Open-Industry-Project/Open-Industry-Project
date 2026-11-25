// The simulated PLC's MQTT publisher: the running program's variables, published to a broker by name, so a dashboard,
// a historian or a SCADA's MQTT client follows the simulator the way it follows a line that reports to a broker.
//
// It sits beside the OPC UA server (opcUaServer.ts) and publishes the same variables under the same rules
// (publishedVariables): the program in the PLC panel keeps running in the sim worker, a variable the scene feeds or a
// constant is read-only, and a 64-bit integer is left out. The difference is the direction of the connection. A server
// waits for clients; this connects out to a broker, so it also works in a browser tab, over MQTT's WebSocket
// transport. core/io/mqtt.ts has the topics and payloads, plc/link/mqttClient.ts the packets.
//
// MQTT has no "out of service" for a value, so the state is a topic of its own: `<prefix>/status` reads `running`
// while a program runs here, `stopped` while it does not, and `offline` once the simulator is gone (the broker
// publishes that one, as the connection's will). The values keep what they last were.
//
// A write is a message on `<prefix>/set/<variable>`. It reaches the program only while it runs, only for a variable
// an OPC UA client could write, and only when the payload is a value of its type. A write published retained is
// taken once, when it is published. The copy the broker keeps comes again with every new subscription, marked as
// retained, and that one is ignored: it would be written on every reconnect, long after whoever sent it meant it.
//
// Everything is QoS 0. A value that changes is sent again within a tenth of a second, so a lost message is replaced
// by the next one, and retained values cover a client that connects late.

import { isLoopbackHost, nameOfSetTopic, parsePayload, payloadText, setFilter, statusTopic, tagTopic } from '../../core/io/mqtt'
import type { MqttUrl } from '../../core/io/mqtt'
import { forEachWatchValue } from '../../core/watchTable'
import { CONNACK, connectPacket, disconnectPacket, MqttError, MqttStream, pingPacket, PINGRESP, PUBLISH, publishPacket, readConnack, readPublish, readSuback, SUBACK, subscribePacket } from '../../plc/link/mqttClient'
import type { MqttPacket } from '../../plc/link/mqttClient'
import type { TagValue } from '../../plc/types'
import type { PlcIoHost } from './externalPlcStatus'
import { mqttIo } from './linkHosts'
import { MAX_MQTT_VARIABLES } from './mqttPublisherStatus'
import type { MqttPublisherStatus } from './mqttPublisherStatus'
import { toServerValue } from './opcUaServer'
import type { ServerNode } from './opcUaServer'

/** A connection to a broker, as bytes. */
export interface MqttSocket {
  send(bytes: Uint8Array): void
  close(): void
}

/** Open a connection to a broker. `closed` is called once if it ends by anything but our own close. */
export type MqttDial = (url: MqttUrl, on: { data(bytes: Uint8Array): void; closed(why: string): void }) => Promise<{ error: string; socket?: MqttSocket }>

/** A broker over the desktop shell's TCP socket (apps/desktop/plcIo.cjs). `host` is the publisher's own link there
 *  (linkHosts.ts mqttIo), so it never shares one with a controller's PLC. */
export function tcpDial(host: PlcIoHost): MqttDial {
  return async (url, on) => {
    let id = 0
    let open = true
    const offs = [
      host.onData((e) => {
        if (open && e.id === id) on.data(e.bytes)
      }),
      host.onConnection((e) => {
        if (!open || e.open || e.id !== id) return
        end()
        on.closed('the broker closed the connection')
      }),
    ]
    const end = (): void => {
      open = false
      for (const off of offs.splice(0)) off()
    }
    const r = await host.connect({ host: url.host.replace(/^\[|\]$/g, ''), port: url.port })
    if (r.error) {
      end()
      return { error: r.error }
    }
    id = r.id
    return {
      error: '',
      socket: {
        send: (bytes) => host.write(id, bytes),
        close: () => {
          if (!open) return
          end()
          void host.close()
        },
      },
    }
  }
}

/** The way to a broker at `url` from this surface, or null when there is none: plain TCP needs the desktop shell's socket. */
export function mqttDialFor(url: MqttUrl, plcIo: PlcIoHost | null): MqttDial | null {
  if (url.scheme === 'mqtt') return plcIo ? tcpDial(mqttIo(plcIo)) : null
  return typeof WebSocket === 'undefined' ? null : webSocketDial()
}

/** How long a WebSocket may take to open. */
const WS_OPEN_MS = 8000

/** A broker over a WebSocket (its `mqtt` subprotocol), which a browser tab can open as well as the desktop app. */
export function webSocketDial(make: (url: string, protocol: string) => WebSocket = (url, protocol) => new WebSocket(url, protocol)): MqttDial {
  return (url, on) =>
    new Promise((resolve) => {
      let ws: WebSocket
      try {
        ws = make(url.href, 'mqtt')
      } catch {
        // a page served over https may not open plain ws:// to another machine
        resolve({ error: url.scheme === 'ws' && !isLoopbackHost(url.host) ? `this page may only reach ${url.host} over wss://` : `${url.href} could not be opened` })
        return
      }
      ws.binaryType = 'arraybuffer'
      let opened = false
      let ours = false
      const late = setTimeout(() => {
        if (opened) return
        ours = true
        ws.close()
        resolve({ error: `no answer from ${url.href} within ${WS_OPEN_MS / 1000} s` })
      }, WS_OPEN_MS)
      ws.onopen = () => {
        opened = true
        clearTimeout(late)
        resolve({
          error: '',
          socket: {
            send: (bytes) => {
              // a copy: a WebSocket takes only a view of a plain ArrayBuffer
              if (ws.readyState === 1) ws.send(new Uint8Array(bytes))
            },
            close: () => {
              ours = true
              ws.close()
            },
          },
        })
      }
      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) on.data(new Uint8Array(e.data))
      }
      ws.onclose = () => {
        clearTimeout(late)
        if (ours) return
        if (opened) on.closed('the broker closed the connection')
        else resolve({ error: `no MQTT broker answered at ${url.href} (it has to accept WebSocket connections there)` })
      }
    })
}

/** Seconds the broker waits for a packet from us before it gives the connection up. We ping three times in that. */
const KEEP_ALIVE_SEC = 30
const PING_MS = 10_000
/** How long a broker may take to answer CONNECT. */
const CONNACK_MS = 5000
/** How long after a lost or refused connection the next one is tried. */
export const MQTT_RETRY_MS = 3000

export interface MqttPublisherSettings {
  url: MqttUrl
  /** the topic prefix (core/io/mqtt.ts isMqttTopicPrefix) */
  topic: string
  /** '' for an anonymous session */
  user: string
  password: string
}

/** A value as the program's text would write it: TRUE, 12.5, 'idle'. */
function literal(v: TagValue): string {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'string') return `'${v}'`
  return String(v)
}

/**
 * One publisher, for as long as it is switched on (not for one run: a dashboard stays subscribed across Stop and
 * Play). The controller tells it what to publish ({@link publish}) and hands it the variables each frame
 * ({@link update}); a write from the broker comes back through `onWrite`, for the controller to hand the running
 * program. A connection that is lost or refused is tried again every few seconds, except a refused login.
 */
export class MqttPublisherSession {
  private state: 'connecting' | 'connected' | 'failed' = 'connecting'
  private error: string | null = null
  private closed = false
  private started = false
  private socket: MqttSocket | null = null
  /** whether the broker has accepted the session (CONNACK) */
  private session = false
  /** counts connections, so a late callback from an old one is not taken for the current one's */
  private epoch = 0
  private stream = new MqttStream()
  /** whether this connection has sent us anything yet */
  private answered = false
  private retryAt: number | null = null
  private connackBy: number | null = null
  private pingAt = 0
  private pingOpen = false
  private timer: ReturnType<typeof setInterval> | null = null
  /** what is published, by name, and by name in lower case for a write, since IEC names ignore case */
  private nodes = new Map<string, ServerNode>()
  private byLower = new Map<string, ServerNode>()
  private skipped = 0
  /** each variable's payload as it stands, and as the broker was last sent it on this connection */
  private readonly current = new Map<string, string>()
  private readonly sent = new Map<string, string>()
  private sentStatus: string | null = null
  private live = false
  private lastWatch: object | null = null
  private count = 0
  private lastWrite: string | null = null
  private lastRefused: string | null = null
  /** packets waiting to go out as one write */
  private out: Uint8Array[] = []
  private readonly clientId = `oip-${Math.random().toString(16).slice(2, 10)}`

  constructor(
    private readonly dial: MqttDial,
    readonly settings: MqttPublisherSettings,
    /** the broker carried a write to these variables: hand them to the running program */
    private readonly onWrite: (values: Record<string, TagValue>) => void,
    private readonly onChange: () => void,
    /** `interval` false: the owner calls {@link tick} itself (a test) */
    private readonly opts: { now?: () => number; interval?: boolean } = {},
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  start(): void {
    if (this.started || this.closed) return
    this.started = true
    if (this.opts.interval !== false) this.timer = setInterval(() => this.tick(), 1000)
    void this.connect()
  }

  private async connect(): Promise<void> {
    const epoch = ++this.epoch
    this.state = 'connecting'
    this.retryAt = null
    this.stream = new MqttStream()
    this.answered = false
    this.onChange()
    const r = await this.dial(this.settings.url, {
      data: (bytes) => {
        if (epoch === this.epoch) this.received(bytes)
      },
      closed: (why) => {
        if (epoch === this.epoch) this.lost(why)
      },
    }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e), socket: undefined }))
    if (this.closed || epoch !== this.epoch) {
      r.socket?.close()
      return
    }
    if (r.error || !r.socket) return this.lost(r.error || 'no connection')
    this.socket = r.socket
    this.connackBy = this.now() + CONNACK_MS
    const { topic, user, password } = this.settings
    r.socket.send(
      connectPacket({
        clientId: this.clientId,
        keepAliveSec: KEEP_ALIVE_SEC,
        will: { topic: statusTopic(topic), payload: 'offline' },
        ...(user ? { username: user, ...(password ? { password } : {}) } : {}),
      }),
    )
  }

  /** The connection is gone or no use: drop it, and try again in a while unless that cannot help. */
  private lost(why: string, retry = true): void {
    this.epoch++
    this.socket?.close()
    this.socket = null
    this.session = false
    this.connackBy = null
    this.pingOpen = false
    this.out = []
    // the next connection publishes everything again: the broker may be another one, or have lost what it kept
    this.sent.clear()
    this.sentStatus = null
    this.state = 'failed'
    this.error = why
    this.retryAt = retry ? this.now() + MQTT_RETRY_MS : null
    this.onChange()
  }

  private received(bytes: Uint8Array): void {
    try {
      // a broker's first byte is a CONNACK's. Anything else (a web server's "HTTP/1.1 400") is refused at once
      // instead of being waited on as the start of a long packet
      if (!this.session && !this.answered && bytes.length > 0 && bytes[0] !== CONNACK << 4) throw new MqttError('its first byte is not a CONNACK')
      this.answered = true
      for (const p of this.stream.push(bytes)) {
        if (!this.socket) return
        this.packet(p)
      }
    } catch (e) {
      this.lost(`${this.settings.url.href} did not answer as an MQTT broker (${e instanceof Error ? e.message : String(e)})`)
    }
  }

  private packet(p: MqttPacket): void {
    if (!this.session) {
      const { error, auth } = readConnack(p)
      if (error) return this.lost(error, !auth)
      this.session = true
      this.state = 'connected'
      this.error = null
      this.connackBy = null
      this.pingAt = this.now() + PING_MS
      this.queue(subscribePacket(1, setFilter(this.settings.topic)))
      this.flush()
      this.onChange()
      return
    }
    if (p.type === PUBLISH) this.written(readPublish(p))
    else if (p.type === PINGRESP) this.pingOpen = false
    else if (p.type === SUBACK && !readSuback(p).granted) {
      this.error = `the broker refused the subscription to ${setFilter(this.settings.topic)}, so nothing can be written`
      this.onChange()
    }
  }

  /** Once a second: the retry of a lost connection, a broker that never answered, and the keep-alive ping. */
  tick(): void {
    if (this.closed || !this.started) return
    const now = this.now()
    if (this.retryAt !== null && now >= this.retryAt) return void this.connect()
    if (this.connackBy !== null && now >= this.connackBy) return this.lost(`${this.settings.url.href} accepted the connection but did not answer as an MQTT broker`)
    if (!this.session || now < this.pingAt) return
    if (this.pingOpen) return this.lost('the broker stopped answering')
    this.pingOpen = true
    this.pingAt = now + PING_MS
    this.queue(pingPacket())
    this.emit()
  }

  private queue(bytes: Uint8Array): void {
    this.out.push(bytes)
  }

  /** Send what is queued as one write. */
  private emit(): void {
    const socket = this.socket
    const parts = this.out
    if (!socket || parts.length === 0) return
    this.out = []
    if (parts.length === 1) return socket.send(parts[0]!)
    let length = 0
    for (const p of parts) length += p.length
    const all = new Uint8Array(length)
    let at = 0
    for (const p of parts) {
      all.set(p, at)
      at += p.length
    }
    socket.send(all)
  }

  private put(name: string, text: string): void {
    if (this.sent.get(name) === text) return
    this.sent.set(name, text)
    this.count++
    this.queue(publishPacket(tagTopic(this.settings.topic, name), text, true))
  }

  /** Send the state and every value the broker does not have yet. */
  private flush(): void {
    if (!this.session) return
    for (const [name, text] of this.current) this.put(name, text)
    this.putStatus()
  }

  /** Send the state if it changed, and whatever is queued. After the values, so a client that reads `running` has them. */
  private putStatus(): void {
    if (!this.session) return
    const status = this.live ? 'running' : 'stopped'
    if (status !== this.sentStatus) {
      this.sentStatus = status
      this.queue(publishPacket(statusTopic(this.settings.topic), status, true))
    }
    this.emit()
  }

  /** Publish exactly these variables, the first {@link MAX_MQTT_VARIABLES} of them. One no longer published has its
   *  retained value cleared on the broker. */
  publish(nodes: ServerNode[]): void {
    const kept = nodes.slice(0, MAX_MQTT_VARIABLES)
    this.skipped = nodes.length - kept.length
    this.nodes = new Map(kept.map((n) => [n.name, n]))
    this.byLower = new Map(kept.map((n) => [n.name.toLowerCase(), n]))
    this.lastWatch = null
    this.current.clear()
    for (const n of kept) this.current.set(n.name, payloadText(n.value))
    for (const name of [...this.sent.keys()]) {
      if (this.nodes.has(name)) continue
      this.sent.delete(name)
      this.queue(publishPacket(tagTopic(this.settings.topic, name), '', true))
    }
    this.flush()
    this.onChange()
  }

  /**
   * One frame: the program's variables as they stand, and whether they are live (the simulation runs a program
   * here). Only what changed is published, and nothing when the frame carries the same watch.
   */
  update(watch: Readonly<Record<string, TagValue>> | null, live: boolean): void {
    if (this.closed) return
    if (live !== this.live) {
      this.live = live
      this.onChange()
    }
    if (watch && watch !== this.lastWatch) {
      this.lastWatch = watch
      forEachWatchValue(watch, (name, v) => {
        const node = this.nodes.get(name)
        if (!node) return
        const text = payloadText(toServerValue(node.builtin, v))
        if (this.current.get(name) === text) return
        this.current.set(name, text)
        if (this.session) this.put(name, text)
      })
    }
    this.putStatus()
  }

  private written(m: { topic: string; payload: string; retained: boolean }): void {
    if (m.retained) return
    const name = nameOfSetTopic(this.settings.topic, m.topic)
    if (name === null) return
    const node = this.nodes.get(name) ?? this.byLower.get(name.toLowerCase())
    const refuse = (why: string): void => {
      this.lastRefused = `${node?.name ?? name}: ${why}`
      this.onChange()
    }
    if (!node) return refuse('the program has no such variable')
    if (!node.writable) return refuse('it is read-only (a constant, or an input the scene feeds)')
    if (!this.live) return refuse('the program is not running')
    const value = parsePayload(node.builtin, m.payload)
    if (value === null) return refuse(`"${m.payload.slice(0, 40)}" is not a value it takes`)
    this.lastWrite = `${node.name} := ${literal(value)}`
    this.onWrite({ [node.name]: value })
    this.onChange()
  }

  /** Close the session: `offline` is published first, since a clean close keeps the broker from publishing the will. */
  stop(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer !== null) clearInterval(this.timer)
    this.epoch++
    if (this.socket && this.session) {
      this.out = [publishPacket(statusTopic(this.settings.topic), 'offline', true), disconnectPacket()]
      this.emit()
    }
    this.socket?.close()
    this.socket = null
    this.session = false
  }

  status(): MqttPublisherStatus {
    let writable = 0
    for (const n of this.nodes.values()) if (n.writable) writable++
    return {
      state: this.closed ? 'off' : this.state,
      broker: this.settings.url.href,
      topic: this.settings.topic,
      variables: this.nodes.size,
      writable,
      skipped: this.skipped,
      live: this.live,
      sent: this.count,
      lastWrite: this.lastWrite,
      lastRefused: this.lastRefused,
      error: this.error,
      retrying: this.retryAt !== null,
    }
  }
}
