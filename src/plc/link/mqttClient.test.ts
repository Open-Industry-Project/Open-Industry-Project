import { describe, expect, it } from 'vitest'
import { connectPacket, disconnectPacket, MqttError, MqttStream, pingPacket, PUBLISH, publishPacket, readConnack, readPublish, readSuback, subscribePacket } from './mqttClient'
import { FakeBroker } from './mqttFakeBroker'

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ')

describe('MQTT packets', () => {
  it('builds the CONNECT of the specification, byte for byte', () => {
    // 3.1: fixed header 10, length, "MQTT", level 4, flags (clean session), keep alive, client id
    expect(hex(connectPacket({ clientId: 'a', keepAliveSec: 60 }))).toBe('10 0d 00 04 4d 51 54 54 04 02 00 3c 00 01 61')
  })

  it('builds PUBLISH, SUBSCRIBE, PINGREQ and DISCONNECT byte for byte', () => {
    expect(hex(publishPacket('a/b', 'hi', false))).toBe('30 07 00 03 61 2f 62 68 69')
    expect(hex(publishPacket('a/b', '', true))).toBe('31 05 00 03 61 2f 62')
    expect(hex(subscribePacket(1, 'a/#'))).toBe('82 08 00 01 00 03 61 2f 23 00')
    expect(hex(pingPacket())).toBe('c0 00')
    expect(hex(disconnectPacket())).toBe('e0 00')
  })

  it('writes a length past 127 in two bytes, low seven bits first', () => {
    const p = publishPacket('t', 'x'.repeat(200), false)
    // 2 + 1 + 200 = 203 = 0x4b + 1 * 128
    expect([p[1], p[2]]).toEqual([0xcb, 0x01])
    expect(p.length).toBe(3 + 203)
  })

  it('sends a will, a user name and a password a strict broker accepts', () => {
    const broker = new FakeBroker()
    broker.attach(() => {})
    broker.receive(connectPacket({ clientId: 'oip-1', keepAliveSec: 30, will: { topic: 'oip/status', payload: 'offline' }, username: 'line', password: 'päss' }))
    expect(broker.violation).toBeNull()
    expect(broker.connect).toEqual({ clientId: 'oip-1', keepAliveSec: 30, cleanSession: true, will: { topic: 'oip/status', payload: 'offline', retain: true, qos: 0 }, username: 'line', password: 'päss' })
  })

  it('never sends a password without a user name', () => {
    const broker = new FakeBroker()
    broker.attach(() => {})
    broker.receive(connectPacket({ clientId: 'a', keepAliveSec: 30, password: 'secret' }))
    expect(broker.violation).toBeNull()
    expect(broker.connect).toMatchObject({ username: null, password: null })
  })
})

describe('MqttStream', () => {
  it('takes packets that arrive in pieces, and several in one piece', () => {
    const s = new MqttStream()
    const a = publishPacket('a', '1', false)
    const b = publishPacket('b', 'x'.repeat(300), true)
    const all = new Uint8Array([...a, ...b, ...a])
    expect(s.push(all.slice(0, 1))).toEqual([])
    expect(s.push(all.slice(1, 7)).map((p) => readPublish(p).topic)).toEqual(['a'])
    expect(s.push(all.slice(7, 100))).toEqual([])
    const rest = s.push(all.slice(100)).map(readPublish)
    expect(rest).toEqual([
      { topic: 'b', payload: 'x'.repeat(300), retained: true },
      { topic: 'a', payload: '1', retained: false },
    ])
  })

  it('refuses a length that is not one', () => {
    expect(() => new MqttStream().push(Uint8Array.of(0x30, 0xff, 0xff, 0xff, 0xff, 0x01))).toThrow(MqttError)
    // an HTTP answer read as MQTT: a length of megabytes
    expect(() => new MqttStream().push(Uint8Array.of(0x48, 0xd4, 0xd4, 0xd0, 0x2f))).toThrow(MqttError)
  })
})

describe('reading what a broker sends', () => {
  const one = (bytes: number[]) => new MqttStream().push(Uint8Array.from(bytes))[0]!

  it('reads a CONNACK as accepted, refused, or refused for the login', () => {
    expect(readConnack(one([0x20, 2, 0, 0]))).toEqual({ error: '', auth: false })
    expect(readConnack(one([0x20, 2, 0, 3]))).toMatchObject({ auth: false })
    expect(readConnack(one([0x20, 2, 0, 4]))).toMatchObject({ auth: true })
    expect(readConnack(one([0x20, 2, 0, 5])).error).toMatch(/does not allow/)
    expect(() => readConnack(one([0x30, 3, 0, 1, 0x61]))).toThrow(MqttError)
  })

  it('reads a SUBACK as granted or refused', () => {
    expect(readSuback(one([0x90, 3, 0, 1, 0]))).toEqual({ id: 1, granted: true })
    expect(readSuback(one([0x90, 3, 0, 1, 0x80]))).toEqual({ id: 1, granted: false })
  })

  it('skips the packet id of a PUBLISH above QoS 0', () => {
    const p = one([0x32, 6, 0, 1, 0x61, 0, 9, 0x78])
    expect(p.type).toBe(PUBLISH)
    expect(readPublish(p)).toEqual({ topic: 'a', payload: 'x', retained: false })
  })

  it('refuses a PUBLISH shorter than its topic', () => {
    expect(() => readPublish(one([0x30, 3, 0, 9, 0x61]))).toThrow(MqttError)
  })
})
