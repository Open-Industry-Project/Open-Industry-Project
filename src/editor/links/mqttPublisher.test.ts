import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { parseMqttUrl } from '../../core/io/mqtt'
import { MAX_SCENE_PLCS } from '../../core/scene/scenePlcs'
import { FakeBroker } from '../../plc/link/mqttFakeBroker'
import type { TagValue } from '../../plc/types'
import type { PlcIoHost } from './externalPlcStatus'
import { MQTT_LINK } from './linkHosts'
import { mqttDialFor, MQTT_RETRY_MS, MqttPublisherSession, tcpDial, webSocketDial } from './mqttPublisher'
import type { MqttDial } from './mqttPublisher'
import { MAX_MQTT_VARIABLES, publisherStatusHint, publisherStatusLine } from './mqttPublisherStatus'
import type { ServerNode } from './opcUaServer'

const shell = createRequire(import.meta.url)('../../../apps/desktop/linkKeys.cjs') as {
  MQTT_LINK: number
  linkNo(opts: { link?: number }): number | null
  listingLinkNo(opts: { link?: number }): number | null
  socketLinkNo(opts: { link?: number }): number | null
}

const URL = parseMqttUrl('mqtt://127.0.0.1:1883')!

const NODES: ServerNode[] = [
  { name: 'Main.Eye', builtin: 1, writable: false, value: false },
  { name: 'Main.Speed', builtin: 10, writable: true, value: 1.5 },
  { name: 'Main.Start', builtin: 1, writable: true, value: false },
  { name: 'Main.Count', builtin: 4, writable: true, value: 0 },
]

/** A broker, a dial that reaches it, and a clock the test moves. */
function bench(opts: { dialError?: string } = {}) {
  const broker = new FakeBroker()
  let closed: ((why: string) => void) | null = null
  const t = { now: 0, dials: 0, closes: 0 }
  const dial: MqttDial = async (_url, on) => {
    t.dials++
    if (opts.dialError) return { error: opts.dialError }
    closed = on.closed
    broker.attach(on.data)
    return { error: '', socket: { send: (bytes) => broker.receive(bytes), close: () => void t.closes++ } }
  }
  const written: Record<string, TagValue>[] = []
  const make = (settings: { user?: string; password?: string; topic?: string } = {}) =>
    new MqttPublisherSession(dial, { url: URL, topic: settings.topic ?? 'oip', user: settings.user ?? '', password: settings.password ?? '' }, (v) => written.push(v), () => {}, { now: () => t.now, interval: false })
  /** let the dial's promise settle */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  }
  return { broker, t, make, written, settle, drop: (why = 'the broker closed the connection') => closed?.(why) }
}

describe('the publisher\'s link in the shell', () => {
  it('is a number of its own, which only the socket takes', () => {
    expect(MQTT_LINK).toBe(MAX_SCENE_PLCS + 1)
    expect(shell.MQTT_LINK).toBe(MQTT_LINK)
    expect(shell.linkNo({ link: MQTT_LINK })).toBeNull()
    expect(shell.listingLinkNo({ link: MQTT_LINK })).toBeNull()
    expect(shell.socketLinkNo({ link: MQTT_LINK })).toBe(MQTT_LINK)
    expect(shell.socketLinkNo({ link: 3 })).toBe(3)
  })
})

describe('MqttPublisherSession', () => {
  it('opens a session with a will, subscribes to the writes, and publishes every value retained, then the state', async () => {
    const b = bench()
    const s = b.make()
    s.publish(NODES)
    s.start()
    await b.settle()
    expect(b.broker.violation).toBeNull()
    expect(b.broker.connect).toMatchObject({ cleanSession: true, keepAliveSec: 30, username: null, will: { topic: 'oip/status', payload: 'offline', retain: true } })
    expect(b.broker.connect!.clientId).toMatch(/^oip-[0-9a-f]+$/)
    expect(b.broker.subscriptions).toEqual([{ filter: 'oip/set/#', qos: 0 }])
    expect(Object.fromEntries(b.broker.retained)).toEqual({
      'oip/tags/Main/Eye': 'false',
      'oip/tags/Main/Speed': '1.5',
      'oip/tags/Main/Start': 'false',
      'oip/tags/Main/Count': '0',
      'oip/status': 'stopped',
    })
    expect(b.broker.published.at(-1)).toEqual({ topic: 'oip/status', payload: 'stopped', retain: true })
    expect(s.status()).toMatchObject({ state: 'connected', variables: 4, writable: 3, live: false, sent: 4 })
  })

  it('publishes only what changed, and the state when the program starts and stops', async () => {
    const b = bench()
    const s = b.make()
    s.publish(NODES)
    s.start()
    await b.settle()
    const before = b.broker.published.length
    s.update({ 'Main.Eye': true, 'Main.Speed': 1.5, 'Main.Start': false, 'Main.Count': 0, Other: 9 }, true)
    expect(b.broker.published.slice(before)).toEqual([
      { topic: 'oip/tags/Main/Eye', payload: 'true', retain: true },
      { topic: 'oip/status', payload: 'running', retain: true },
    ])
    const same = { 'Main.Eye': true, 'Main.Speed': 1.5, 'Main.Start': false, 'Main.Count': 0 }
    s.update(same, true)
    s.update(same, true)
    expect(b.broker.published).toHaveLength(before + 2)
    s.update(null, false)
    expect(b.broker.published.at(-1)).toEqual({ topic: 'oip/status', payload: 'stopped', retain: true })
    // the values keep what they last were
    expect(b.broker.retained.get('oip/tags/Main/Eye')).toBe('true')
    expect(b.broker.violation).toBeNull()
  })

  it('hands a write to the program only while live, to a writable variable, with a value of its type', async () => {
    const b = bench()
    const s = b.make()
    s.publish(NODES)
    s.start()
    await b.settle()
    b.broker.deliver('oip/set/Main/Start', 'true')
    expect(b.written).toEqual([])
    expect(s.status().lastRefused).toBe('Main.Start: the program is not running')
    s.update(null, true)
    b.broker.deliver('oip/set/Main/Start', 'true', { split: true })
    b.broker.deliver('oip/set/main/speed', '2.25') // IEC names ignore case
    b.broker.deliver('oip/set/Main/Count', '7')
    expect(b.written).toEqual([{ 'Main.Start': true }, { 'Main.Speed': 2.25 }, { 'Main.Count': 7 }])
    expect(s.status().lastWrite).toBe('Main.Count := 7')
    b.broker.deliver('oip/set/Main/Eye', 'true')
    expect(s.status().lastRefused).toMatch(/^Main\.Eye: it is read-only/)
    b.broker.deliver('oip/set/Main/Count', '70000')
    expect(s.status().lastRefused).toBe('Main.Count: "70000" is not a value it takes')
    b.broker.deliver('oip/set/Main/Nope', '1')
    expect(s.status().lastRefused).toBe('Main.Nope: the program has no such variable')
    b.broker.deliver('oip/tags/Main/Start', 'true') // not a write topic
    expect(b.written).toHaveLength(3)
  })

  it('ignores a retained write: it would be written again on every reconnect', async () => {
    const b = bench()
    const s = b.make()
    s.publish(NODES)
    s.start()
    await b.settle()
    s.update(null, true)
    b.broker.deliver('oip/set/Main/Start', 'true', { retained: true })
    expect(b.written).toEqual([])
    expect(s.status().lastRefused).toBeNull()
  })

  it('clears the retained value of a variable the program no longer has', async () => {
    const b = bench()
    const s = b.make()
    s.publish(NODES)
    s.start()
    await b.settle()
    s.publish(NODES.filter((n) => n.name !== 'Main.Count'))
    expect(b.broker.retained.has('oip/tags/Main/Count')).toBe(false)
    expect(b.broker.published.at(-1)).toEqual({ topic: 'oip/tags/Main/Count', payload: '', retain: true })
    expect(b.broker.retained.get('oip/tags/Main/Speed')).toBe('1.5')
  })

  it('publishes the first variables up to the limit and counts the rest', async () => {
    const b = bench()
    const s = b.make()
    const many: ServerNode[] = Array.from({ length: MAX_MQTT_VARIABLES + 5 }, (_, i) => ({ name: `V${i}`, builtin: 4, writable: true, value: i }))
    s.publish(many)
    s.start()
    await b.settle()
    expect(s.status()).toMatchObject({ variables: MAX_MQTT_VARIABLES, skipped: 5 })
    expect(b.broker.retained.size).toBe(MAX_MQTT_VARIABLES + 1)
    expect(b.broker.violation).toBeNull()
    expect(publisherStatusLine(s.status(), false)).toMatch(/5 more are left out/)
  })

  it('sends the login, and does not retry one the broker refused', async () => {
    const b = bench()
    b.broker.connack = 4
    const s = b.make({ user: 'line', password: 'wrong' })
    s.start()
    await b.settle()
    expect(s.status()).toMatchObject({ state: 'failed', retrying: false })
    expect(publisherStatusHint(s.status())).toMatch(/user name and password/)
    b.t.now += MQTT_RETRY_MS * 3
    s.tick()
    await b.settle()
    expect(b.t.dials).toBe(1)
  })

  it('tries again after a connection that would not open, and after one that was lost, and publishes everything again', async () => {
    const down = bench({ dialError: 'nothing is listening on 127.0.0.1:1883' })
    const f = down.make()
    f.start()
    await down.settle()
    expect(f.status()).toMatchObject({ state: 'failed', retrying: true, error: 'nothing is listening on 127.0.0.1:1883' })
    expect(publisherStatusHint(f.status())).toMatch(/broker is running/)
    down.t.now += MQTT_RETRY_MS
    f.tick()
    await down.settle()
    expect(down.t.dials).toBe(2)

    const b = bench()
    const s = b.make()
    s.publish(NODES)
    s.start()
    await b.settle()
    s.update({ 'Main.Speed': 3 }, true)
    b.drop()
    expect(s.status()).toMatchObject({ state: 'failed', retrying: true })
    s.update({ 'Main.Speed': 4 }, true) // a value that changes while there is no connection
    b.broker.retained.clear() // a broker that lost what it kept
    b.t.now += MQTT_RETRY_MS
    s.tick()
    await b.settle()
    expect(s.status().state).toBe('connected')
    expect(Object.fromEntries(b.broker.retained)).toMatchObject({ 'oip/tags/Main/Speed': '4', 'oip/tags/Main/Eye': 'false', 'oip/status': 'running' })
    expect(b.broker.violation).toBeNull()
  })

  it('pings inside the keep-alive, and gives up a broker that stops answering', async () => {
    const b = bench()
    const s = b.make()
    s.start()
    await b.settle()
    b.t.now += 10_000
    s.tick()
    expect(b.broker.pings).toBe(1)
    b.t.now += 10_000
    s.tick()
    expect(b.broker.pings).toBe(2)
    expect(s.status().state).toBe('connected')
    b.broker.answersPing = false
    b.t.now += 10_000
    s.tick()
    b.t.now += 10_000
    s.tick()
    expect(s.status()).toMatchObject({ state: 'failed', error: 'the broker stopped answering', retrying: true })
  })

  it('gives up something that accepts the connection but is not a broker', async () => {
    const silent = bench()
    const s = silent.make()
    silent.broker.receive = () => {} // takes the bytes and says nothing
    s.start()
    await silent.settle()
    silent.t.now += 5000
    s.tick()
    expect(s.status().error).toMatch(/did not answer as an MQTT broker/)

    // a web server on the port answers CONNECT with HTTP
    let data: ((bytes: Uint8Array) => void) | null = null
    const http = new MqttPublisherSession(
      async (_u, on) => ((data = on.data), { error: '', socket: { send: () => {}, close: () => {} } }),
      { url: URL, topic: 'oip', user: '', password: '' },
      () => {},
      () => {},
      { interval: false },
    )
    http.start()
    await silent.settle()
    data!(new TextEncoder().encode('HTTP/1.1 400 Bad Request\r\n\r\n'))
    expect(http.status()).toMatchObject({ state: 'failed' })
    expect(http.status().error).toMatch(/did not answer as an MQTT broker/)
  })

  it('says offline and disconnects cleanly when switched off', async () => {
    const b = bench()
    const s = b.make()
    s.publish(NODES)
    s.start()
    await b.settle()
    s.stop()
    expect(b.broker.retained.get('oip/status')).toBe('offline')
    expect(b.broker.disconnected).toBe(true)
    expect(b.broker.violation).toBeNull()
    expect(b.t.closes).toBe(1)
    expect(s.status().state).toBe('off')
    s.update({ 'Main.Eye': true }, true)
    expect(b.broker.retained.get('oip/tags/Main/Eye')).toBe('false')
  })

  it('drops a connection that opens after it was switched off', async () => {
    const b = bench()
    const s = b.make()
    s.start()
    s.stop()
    await b.settle()
    expect(b.t.closes).toBe(1)
    expect(b.broker.connect).toBeNull()
  })
})

describe('the way to a broker', () => {
  function fakeIo() {
    const calls: string[] = []
    let onData: ((e: { id: number; bytes: Uint8Array; link?: number }) => void) | null = null
    let onConnection: ((e: { id: number; remote: string; open: boolean; link?: number }) => void) | null = null
    const host: PlcIoHost = {
      listen: async () => ({ error: '' }),
      connect: async (o) => (calls.push(`connect ${o.host}:${o.port} link ${o.link}`), { error: '', id: 7 }),
      close: async (o) => void calls.push(`close link ${o?.link}`),
      onConnection: (cb) => ((onConnection = cb), () => (onConnection = null)),
      onData: (cb) => ((onData = cb), () => (onData = null)),
      write: (id, bytes) => void calls.push(`write ${id} ${bytes.length}`),
      drop: () => {},
    }
    return { host, calls, data: (e: { id: number; bytes: Uint8Array; link?: number }) => onData?.(e), connection: (e: { id: number; remote: string; open: boolean; link?: number }) => onConnection?.(e) }
  }

  it('is the shell\'s socket for mqtt://, on the publisher\'s own link, and takes only that connection\'s bytes', async () => {
    const io = fakeIo()
    const dial = mqttDialFor(parseMqttUrl('mqtt://[::1]:1884')!, io.host)!
    const got: number[] = []
    const closed: string[] = []
    const r = await dial(parseMqttUrl('mqtt://[::1]:1884')!, { data: (b) => got.push(b.length), closed: (why) => closed.push(why) })
    expect(io.calls).toEqual([`connect ::1:1884 link ${MQTT_LINK}`])
    io.data({ id: 7, bytes: new Uint8Array(3), link: MQTT_LINK })
    io.data({ id: 8, bytes: new Uint8Array(5), link: MQTT_LINK })
    io.data({ id: 7, bytes: new Uint8Array(9), link: 0 }) // a controller's link
    expect(got).toEqual([3])
    r.socket!.send(new Uint8Array(4))
    expect(io.calls.at(-1)).toBe('write 7 4')
    io.connection({ id: 7, remote: '', open: false, link: MQTT_LINK })
    expect(closed).toEqual(['the broker closed the connection'])
    r.socket!.close() // already gone: nothing more to close
    expect(io.calls.filter((c) => c.startsWith('close'))).toEqual([])
  })

  it('closes the shell\'s link when the session closes it', async () => {
    const io = fakeIo()
    const r = await tcpDial(io.host)(URL, { data: () => {}, closed: () => {} })
    r.socket!.close()
    expect(io.calls.at(-1)).toBe('close link undefined')
  })

  it('is nothing for mqtt:// without the shell: a browser tab has no TCP socket', () => {
    expect(mqttDialFor(URL, null)).toBeNull()
  })

  it('opens a WebSocket with the mqtt subprotocol, and says why one would not open', async () => {
    class Ws {
      static last: Ws
      binaryType = ''
      readyState = 0
      sent: Uint8Array[] = []
      onopen: (() => void) | null = null
      onmessage: ((e: { data: unknown }) => void) | null = null
      onclose: (() => void) | null = null
      constructor(readonly url: string, readonly protocol: string) {
        Ws.last = this
      }
      send(b: Uint8Array): void {
        this.sent.push(b)
      }
      close(): void {
        this.readyState = 3
        this.onclose?.()
      }
    }
    const dial = webSocketDial((url, protocol) => new Ws(url, protocol) as unknown as WebSocket)
    const url = parseMqttUrl('ws://localhost:9001/mqtt')!
    const got: number[] = []
    const closed: string[] = []
    const opening = dial(url, { data: (b) => got.push(b.length), closed: (why) => closed.push(why) })
    const ws = Ws.last
    expect([ws.url, ws.protocol, ws.binaryType]).toEqual(['ws://localhost:9001/mqtt', 'mqtt', 'arraybuffer'])
    ws.readyState = 1
    ws.onopen!()
    const r = await opening
    r.socket!.send(Uint8Array.of(1, 2))
    expect(ws.sent).toHaveLength(1)
    ws.onmessage!({ data: new ArrayBuffer(6) })
    ws.onmessage!({ data: 'text' })
    expect(got).toEqual([6])
    ws.close()
    expect(closed).toEqual(['the broker closed the connection'])

    const refused = dial(url, { data: () => {}, closed: () => {} })
    Ws.last.onclose!()
    expect((await refused).error).toMatch(/no MQTT broker answered at ws:\/\/localhost:9001\/mqtt/)

    const blocked = await webSocketDial(() => {
      throw new Error('SecurityError')
    })(parseMqttUrl('ws://broker.example.com:9001')!, { data: () => {}, closed: () => {} })
    expect(blocked.error).toBe('this page may only reach broker.example.com over wss://')
  })
})
