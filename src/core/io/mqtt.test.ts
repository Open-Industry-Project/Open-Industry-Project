import { describe, expect, it } from 'vitest'
import { isLoopbackHost, isMqttTopicPrefix, nameOfSetTopic, parseMqttUrl, parsePayload, payloadText, setFilter, statusTopic, tagTopic } from './mqtt'

describe('a broker address', () => {
  it('reads the three schemes, with each one\'s usual port', () => {
    expect(parseMqttUrl('mqtt://127.0.0.1')).toEqual({ scheme: 'mqtt', host: '127.0.0.1', port: 1883, href: 'mqtt://127.0.0.1:1883' })
    expect(parseMqttUrl('mqtt://broker.local:1884/')).toMatchObject({ host: 'broker.local', port: 1884 })
    expect(parseMqttUrl('ws://localhost:9001')).toEqual({ scheme: 'ws', host: 'localhost', port: 9001, href: 'ws://localhost:9001' })
    expect(parseMqttUrl('wss://broker.example.com/mqtt')).toEqual({ scheme: 'wss', host: 'broker.example.com', port: 443, href: 'wss://broker.example.com/mqtt' })
    expect(parseMqttUrl('mqtt://[::1]:1883')).toMatchObject({ host: '[::1]', port: 1883 })
  })

  it('refuses what is not one', () => {
    for (const bad of ['', 'broker', 'http://broker', 'mqtts://broker', 'mqtt://broker/path', 'mqtt://broker:0', 'mqtt://broker:70000', 'ws://bro ker', 'mqtt://user:pw@broker', 'ws://broker/a#b']) expect(parseMqttUrl(bad), bad).toBeNull()
  })

  it('knows this computer by its loopback names', () => {
    expect(['localhost', '127.0.0.1', '127.1.2.3', '[::1]'].map(isLoopbackHost)).toEqual([true, true, true, true])
    expect(['broker.local', '192.168.0.1', 'localhost.example.com'].map(isLoopbackHost)).toEqual([false, false, false])
  })
})

describe('topics', () => {
  it('takes a prefix of plain levels and refuses wildcards, empty levels and the broker\'s own $ topics', () => {
    expect(['oip', 'plant/line 1/oip', 'a/b/c'].map(isMqttTopicPrefix)).toEqual([true, true, true])
    expect(['', '/oip', 'oip/', 'a//b', 'a/+/b', 'a/#', '$SYS', 7, 'x'.repeat(201)].map(isMqttTopicPrefix)).toEqual(new Array(9).fill(false))
  })

  it('gives a variable a level per dot, and reads a write topic back to its name', () => {
    expect(statusTopic('oip')).toBe('oip/status')
    expect(tagTopic('oip', 'Main.T1.Q')).toBe('oip/tags/Main/T1/Q')
    expect(tagTopic('plant/oip', 'Start')).toBe('plant/oip/tags/Start')
    expect(setFilter('oip')).toBe('oip/set/#')
    expect(nameOfSetTopic('oip', 'oip/set/Main/T1/Q')).toBe('Main.T1.Q')
    expect(nameOfSetTopic('oip', 'oip/set/')).toBeNull()
    expect(nameOfSetTopic('oip', 'oip/tags/Main/Start')).toBeNull()
    expect(nameOfSetTopic('oip', 'oip2/set/Start')).toBeNull()
  })
})

describe('payloads', () => {
  it('writes a value as text', () => {
    expect([true, false, 12.5, -3, 'idle', ''].map(payloadText)).toEqual(['true', 'false', '12.5', '-3', 'idle', ''])
  })

  it('reads a Boolean from true/false or 1/0', () => {
    expect(['true', 'TRUE', ' 1 ', 'false', '0'].map((t) => parsePayload(1, t))).toEqual([true, true, true, false, false])
    expect(['', 'yes', '2', 'on'].map((t) => parsePayload(1, t))).toEqual([null, null, null, null])
  })

  it('reads an integer only when its type holds it', () => {
    expect(parsePayload(4, '32767')).toBe(32767)
    expect(parsePayload(4, '-32768')).toBe(-32768)
    expect(parsePayload(4, '32768')).toBeNull()
    expect(parsePayload(4, '1.5')).toBeNull()
    expect(parsePayload(5, '-1')).toBeNull()
    expect(parsePayload(3, '255')).toBe(255)
    expect(parsePayload(7, '4294967295')).toBe(4294967295)
    expect(parsePayload(6, '1e3')).toBe(1000)
  })

  it('reads a real from any finite number, and nothing else', () => {
    expect(parsePayload(10, '12.5')).toBe(12.5)
    expect(parsePayload(11, '-1e-3')).toBe(-0.001)
    for (const bad of ['', 'NaN', 'Infinity', '0x10', '1,5', 'true', '12 volts']) expect(parsePayload(10, bad), bad).toBeNull()
  })

  it('takes a string as it is', () => {
    expect(parsePayload(12, ' idle ')).toBe(' idle ')
    expect(parsePayload(12, '')).toBe('')
  })
})
