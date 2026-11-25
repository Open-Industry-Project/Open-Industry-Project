// Live checks against a real MQTT broker this machine can reach, watched and written by Mosquitto's own command-line
// clients, so nothing of ours sits on the other side. The suite skips them: `OIP_MQTT_BROKER` has to name a broker -
//   $env:OIP_MQTT_BROKER='mqtt://127.0.0.1:1883'; npx vitest run src/editor/links/mqttLive.test.ts
// For a WebSocket address (`ws://127.0.0.1:9001`) the tools still need the broker's TCP listener:
// `OIP_MQTT_TCP='127.0.0.1:1884'`. `OIP_MQTT_USER` and `OIP_MQTT_PASSWORD` are the login, when the broker wants one,
// and `OIP_MOSQUITTO` the folder mosquitto_sub and mosquitto_pub are in, when they are not on the PATH.
// Everything is published under a topic of the run's own, and its retained messages are cleared at the end.

/// <reference types="node" />

import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseMqttUrl } from '../../core/io/mqtt'
import type { TagValue } from '../../plc/types'
import { MqttPublisherSession, webSocketDial } from './mqttPublisher'
import type { MqttDial } from './mqttPublisher'
import type { ServerNode } from './opcUaServer'

declare const process: { env: Record<string, string | undefined> }

const BROKER = process.env.OIP_MQTT_BROKER
const live = BROKER ? describe : describe.skip
const url = parseMqttUrl(BROKER ?? 'mqtt://127.0.0.1')!
const [toolHost, toolPort] = (process.env.OIP_MQTT_TCP ?? `${url.host}:${url.port}`).split(':') as [string, string]
const USER = process.env.OIP_MQTT_USER ?? ''
const PASSWORD = process.env.OIP_MQTT_PASSWORD ?? ''
const TOPIC = `oip-test-${Math.random().toString(16).slice(2, 10)}`

/** Run one of Mosquitto's clients; its output, whatever its exit code (mosquitto_sub exits 27 on a timeout). */
function tool(name: 'mosquitto_sub' | 'mosquitto_pub', args: string[]): Promise<string> {
  const exe = process.env.OIP_MOSQUITTO ? join(process.env.OIP_MOSQUITTO, name) : name
  const login = USER ? ['-u', USER, '-P', PASSWORD] : []
  return new Promise((resolve, reject) =>
    execFile(exe, ['-h', toolHost, '-p', toolPort, ...login, ...args], (error, stdout) => {
      if (error && (error as { code?: unknown }).code === 'ENOENT') reject(new Error(`${name} was not found: set OIP_MOSQUITTO to its folder`))
      else resolve(String(stdout))
    }),
  )
}

/** Every retained message under the run's topic, as a client that subscribes now gets them. */
async function retained(): Promise<Record<string, string>> {
  const out = await tool('mosquitto_sub', ['-t', `${TOPIC}/#`, '-v', '-W', '1', '--retained-only'])
  return Object.fromEntries(
    out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf(' ')
        return at < 0 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)]
      }),
  )
}

/** A broker over node:net, with the socket in hand so a test can cut it. */
function netDial(cut: { now: (() => void) | null }): MqttDial {
  return (u, on) =>
    new Promise((resolve) => {
      const socket = createConnection({ host: u.host.replace(/^\[|\]$/g, ''), port: u.port })
      let ours = false
      socket.once('error', (e: Error) => resolve({ error: e.message }))
      socket.on('data', (bytes: Uint8Array) => on.data(new Uint8Array(bytes)))
      socket.on('close', () => {
        if (!ours) on.closed('the broker closed the connection')
      })
      socket.once('connect', () => {
        cut.now = () => {
          ours = true
          socket.destroy()
        }
        resolve({ error: '', socket: { send: (b) => void socket.write(b), close: () => ((ours = true), void socket.end()) } })
      })
    })
}

const until = async (what: string, done: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const NODES: ServerNode[] = [
  { name: 'Main.Eye', builtin: 1, writable: false, value: false },
  { name: 'Main.Speed', builtin: 10, writable: true, value: 1.5 },
  { name: 'Main.Start', builtin: 1, writable: true, value: false },
  { name: 'Main.State', builtin: 12, writable: true, value: 'idle' },
]

live(`a real broker at ${BROKER}`, () => {
  const cut: { now: (() => void) | null } = { now: null }
  const dial = url.scheme === 'mqtt' ? netDial(cut) : webSocketDial()
  const written: Record<string, TagValue>[] = []
  const open = (login: { user: string; password: string } = { user: USER, password: PASSWORD }): MqttPublisherSession =>
    new MqttPublisherSession(dial, { url, topic: TOPIC, ...login }, (v) => written.push(v), () => {})

  afterAll(async () => {
    for (const topic of Object.keys(await retained())) await tool('mosquitto_pub', ['-t', topic, '-r', '-n'])
  })

  it('takes the session, and another client finds every value and the state retained', async () => {
    const s = open()
    s.publish(NODES)
    s.start()
    await until('the session', () => s.status().state === 'connected')
    expect(s.status().error).toBeNull()
    expect(await retained()).toEqual({
      [`${TOPIC}/tags/Main/Eye`]: 'false',
      [`${TOPIC}/tags/Main/Speed`]: '1.5',
      [`${TOPIC}/tags/Main/Start`]: 'false',
      [`${TOPIC}/tags/Main/State`]: 'idle',
      [`${TOPIC}/status`]: 'stopped',
    })

    s.update({ 'Main.Eye': true, 'Main.Speed': 2.5, 'Main.Start': false, 'Main.State': 'run' }, true)
    await new Promise((r) => setTimeout(r, 150))
    expect(await retained()).toMatchObject({ [`${TOPIC}/tags/Main/Eye`]: 'true', [`${TOPIC}/tags/Main/Speed`]: '2.5', [`${TOPIC}/tags/Main/State`]: 'run', [`${TOPIC}/status`]: 'running' })

    // another client writes: the broker carries it to us
    await tool('mosquitto_pub', ['-t', `${TOPIC}/set/Main/Start`, '-m', 'true'])
    await tool('mosquitto_pub', ['-t', `${TOPIC}/set/Main/Speed`, '-m', '3.75'])
    await tool('mosquitto_pub', ['-t', `${TOPIC}/set/Main/Eye`, '-m', 'true'])
    await until('the writes', () => written.length >= 2 && s.status().lastRefused !== null)
    expect(written).toEqual([{ 'Main.Start': true }, { 'Main.Speed': 3.75 }])
    expect(s.status().lastRefused).toMatch(/^Main\.Eye: it is read-only/)

    // a write published retained reaches a subscriber as an ordinary message, so it is taken once, now
    await tool('mosquitto_pub', ['-t', `${TOPIC}/set/Main/Speed`, '-m', '9', '-r'])
    await until('the retained write', () => written.length >= 3)
    expect(written[2]).toEqual({ 'Main.Speed': 9 })

    s.stop()
    await new Promise((r) => setTimeout(r, 200))
    expect((await retained())[`${TOPIC}/status`]).toBe('offline')
  }, 20_000)

  it('has the broker say offline when the connection is cut without a goodbye', async () => {
    if (url.scheme !== 'mqtt') return // a WebSocket here cannot be cut without its closing handshake
    const s = open()
    s.publish(NODES)
    s.start()
    await until('the session', () => s.status().state === 'connected')
    s.update(null, true)
    await new Promise((r) => setTimeout(r, 150))
    expect((await retained())[`${TOPIC}/status`]).toBe('running')
    expect(written).toHaveLength(3) // the retained write of the last test came again with the subscription, and was ignored
    cut.now!()
    await new Promise((r) => setTimeout(r, 300))
    expect((await retained())[`${TOPIC}/status`]).toBe('offline')
    s.stop()
  }, 20_000)

  it('is refused with the wrong password, when the broker wants a login', async () => {
    if (!USER) return
    const s = open({ user: USER, password: `${PASSWORD}-wrong` })
    s.start()
    await until('the refusal', () => s.status().state === 'failed')
    expect(s.status()).toMatchObject({ retrying: false })
    expect(s.status().error).toMatch(/user name or password|does not allow/)
    s.stop()
  }, 20_000)
})
