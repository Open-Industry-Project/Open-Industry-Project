// The simulated PLC's MQTT publisher, through the real app and a real broker: the program in the PLC panel runs here
// and its variables are published to Mosquitto, from the desktop shell over plain TCP and from a browser tab over
// MQTT's WebSocket transport.
//
// This script starts a broker of its own (Mosquitto, on free ports, with a TCP and a WebSocket listener) and plays
// the other clients with Mosquitto's command-line tools, so nothing of ours sits on the far side. The scene is the
// OPC UA server gate's: a belt and an eye wired to `Run := Start AND NOT Eye`, so the belt runs once a client writes
// Start and the box stops at the eye.
//
// It checks what only the running app can show: switched on, the publisher connects before any Play and publishes
// the program as it compiles; the state topic follows Play and Stop; a message on a set topic drives the line; an
// input the scene feeds refuses one; switching off says offline. Without Mosquitto on this machine it skips.
//
//   node e2e/verify-mqtt-electron.mjs       (OIP_MOSQUITTO names Mosquitto's folder when it is not on the PATH)
/* global process, console, window, localStorage, setTimeout, URL */

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron, chromium } from 'playwright'
import { freePort } from './_port.mjs'
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'

const require = createRequire(import.meta.url)
const here = fileURLToPath(new URL('.', import.meta.url))
const desktopDir = join(here, '..', 'apps', 'desktop')

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- Mosquitto: the broker and the other clients ----

const exe = process.platform === 'win32' ? '.exe' : ''
function mosquittoDir() {
  const named = process.env.OIP_MOSQUITTO
  if (named) return named
  const usual = process.platform === 'win32' ? 'C:\\Program Files\\mosquitto' : '/usr/sbin'
  return existsSync(join(usual, `mosquitto${exe}`)) ? usual : null
}
const dir = mosquittoDir()
if (!dir || !existsSync(join(dir, `mosquitto${exe}`))) {
  console.log('SKIP: no Mosquitto broker on this machine (set OIP_MOSQUITTO to its folder)')
  process.exit(0)
}
// on Linux the clients are in /usr/bin while the broker is in /usr/sbin
const toolPath = (name) => (existsSync(join(dir, `${name}${exe}`)) ? join(dir, `${name}${exe}`) : name)

const tcpPort = await freePort()
const wsPort = await freePort()
const work = mkdtempSync(join(tmpdir(), 'oip-mqtt-'))
writeFileSync(
  join(work, 'broker.conf'),
  `listener ${tcpPort} 127.0.0.1\nallow_anonymous true\nlistener ${wsPort} 127.0.0.1\nprotocol websockets\nallow_anonymous true\npersistence false\n`,
)
const broker = spawn(join(dir, `mosquitto${exe}`), ['-c', join(work, 'broker.conf')], { stdio: 'ignore' })

function tool(name, args) {
  return new Promise((resolve) => execFile(toolPath(name), ['-h', '127.0.0.1', '-p', String(tcpPort), ...args], (_error, stdout) => resolve(String(stdout))))
}
/** Every retained message under `topic`, as a client that subscribes now gets them. */
async function retained(topic) {
  const out = await tool('mosquitto_sub', ['-t', `${topic}/#`, '-v', '-W', '1', '--retained-only'])
  return Object.fromEntries(out.split(/\r?\n/).filter(Boolean).map((line) => {
    const at = line.indexOf(' ')
    return at < 0 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)]
  }))
}
const publish = (topic, payload) => tool('mosquitto_pub', ['-t', topic, '-m', payload])
/** Wait until the retained messages under `topic` satisfy `done`; the last ones read either way. */
async function retainedWhen(topic, done, ms = 8000) {
  const end = Date.now() + ms
  for (;;) {
    const got = await retained(topic)
    if (done(got) || Date.now() > end) return got
    await sleep(100)
  }
}

// ---- the scene ----

const PROGRAM = `PROGRAM Main
VAR
  Start : BOOL;
  Eye : BOOL;
  Run : BOOL;
  Speed : REAL := 0.5;
END_VAR
Run := Start AND NOT Eye;
END_PROGRAM
`

async function loadScene(page) {
  return page.evaluate((program) => {
    const st = window.__oip.store
    const pkgs = st.getState().bundledPackages
    const need = ['oip.belt-conveyor', 'oip.box', 'oip.diffuse-sensor'].map((id) => pkgs.find((p) => p.id === id))
    if (need.some((p) => !p)) return 'a bundled package is missing'
    const error = window.__oip.loadSceneText(JSON.stringify({
      version: st.getState().scene.version,
      parts: [
        { id: 'belt', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0,
          params: { shapePreset: 'custom', segments: [[5, 0]], width: 0.8, standHeight: 0.8, speed: 0.5, runTag: 'Main.Run' } },
        { id: 'box', type: 'part', packageId: 'oip.box', position: [0.6, 1.0, 0], rotationY: 0, params: { length: 0.4, width: 0.3, height: 0.3 } },
        { id: 'eye', type: 'part', packageId: 'oip.diffuse-sensor', position: [3, 0.75, -0.6], rotationY: 0, params: { maxRange: 1.2, tag: 'Main.Eye' } },
      ],
      packages: need,
    }))
    if (error) return error
    st.loadStProgram(program)
    st.setState({ selectedIds: [] })
    return true
  }, PROGRAM)
}

const boxX = (page) => page.evaluate(() => window.__oip.controller.livePosition('box')?.[0] ?? null)
const status = (page) => page.evaluate(() => window.__oip.controller.mqttStatus)

/** The whole exchange on one surface: `address` is the broker as that surface reaches it, `topic` its own prefix. */
async function exercise(page, address, topic) {
  await page.waitForFunction(() => window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 60000, polling: 200 })
  const loaded = await loadScene(page)
  expect(loaded === true, `the scene and program open (${loaded})`)
  await showPlcEditor(page)
  await page.locator('[data-testid="org-controller"]').dblclick()
  await page.locator('[data-testid="mqtt"]').waitFor({ timeout: 20000 })
  expect(await page.locator('[data-testid="mqtt-enabled"]').isEnabled(), 'Controller Properties offers the MQTT publisher')

  console.log('  - switched on, before Play')
  await page.evaluate(([mqttUrl, mqttTopic]) => window.__oip.store.setExternalPlc({ mqtt: true, mqttUrl, mqttTopic }), [address, topic])
  await page.waitForFunction(() => window.__oip.controller.mqttStatus.state === 'connected' && window.__oip.controller.mqttStatus.variables > 0, null, { timeout: 30000, polling: 100 }).catch(() => {})
  const st0 = await status(page)
  expect(st0.state === 'connected' && st0.error === null, `it connects to ${address} (${st0.state}${st0.error ? `: ${st0.error}` : ''})`)
  expect(st0.variables === 4 && st0.writable === 3, `and publishes the program before Play: 4 variables, 3 writable (${st0.variables}, ${st0.writable})`)
  let got = await retainedWhen(topic, (r) => Object.keys(r).length >= 5)
  expect(
    JSON.stringify(got, Object.keys(got).sort()) ===
      JSON.stringify({ [`${topic}/status`]: 'stopped', [`${topic}/tags/Main/Eye`]: 'false', [`${topic}/tags/Main/Run`]: 'false', [`${topic}/tags/Main/Speed`]: '0.5', [`${topic}/tags/Main/Start`]: 'false' }),
    `another client finds every variable retained, and the state stopped (${JSON.stringify(got)})`,
  )
  const said = await page.locator('[data-testid="mqtt-status"]').innerText()
  expect(said.startsWith(`Connected to ${address}: 4 variables under ${topic}/tags, 3 writable through ${topic}/set. Stopped:`), `Controller Properties says so (${said})`)
  await publish(`${topic}/set/Main/Start`, 'true')
  await page.waitForFunction(() => window.__oip.controller.mqttStatus.lastRefused !== null, null, { timeout: 5000, polling: 100 }).catch(() => {})
  expect((await status(page)).lastRefused === 'Main.Start: the program is not running', `stopped, a write is refused (${(await status(page)).lastRefused})`)
  await page.locator('[data-testid="controller-props-close"]').click()

  console.log('  - Play: another client runs the line')
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => window.__oip.controller.mqttStatus.live && window.__oip.controller.livePosition('box') != null, null, { timeout: 20000, polling: 100 })
  got = await retainedWhen(topic, (r) => r[`${topic}/status`] === 'running')
  expect(got[`${topic}/status`] === 'running', `on Play the state reads running (${got[`${topic}/status`]})`)
  await sleep(1000)
  const x0 = await boxX(page)
  await sleep(500)
  expect(Math.abs((await boxX(page)) - x0) < 0.05, 'and the belt waits for Start')
  await publish(`${topic}/set/Main/Eye`, 'true')
  await publish(`${topic}/set/Main/Start`, 'true')
  got = await retainedWhen(topic, (r) => r[`${topic}/tags/Main/Eye`] === 'true', 20000)
  expect(got[`${topic}/tags/Main/Start`] === 'true', `a message on the set topic presses Start, and the new value is published (${got[`${topic}/tags/Main/Start`]})`)
  expect(got[`${topic}/tags/Main/Eye`] === 'true', `the eye's topic follows the box (${got[`${topic}/tags/Main/Eye`]})`)
  await sleep(1500)
  const stopped = await boxX(page)
  expect(typeof x0 === 'number' && stopped > x0 + 1 && Math.abs(stopped - 2.83) < 0.3, `the program ran the belt and stopped the box at the eye (${x0?.toFixed?.(2)} -> ${stopped?.toFixed?.(3)} m)`)
  got = await retained(topic)
  expect(got[`${topic}/tags/Main/Run`] === 'false', `and Run is published false again (${got[`${topic}/tags/Main/Run`]})`)
  const st1 = await status(page)
  expect(st1.lastWrite === 'Main.Start := TRUE', `the last write is shown (${st1.lastWrite})`)
  expect(/^Main\.Eye: it is read-only/.test(st1.lastRefused ?? ''), `an input the scene feeds refuses a write (${st1.lastRefused})`)

  console.log('  - Stop, then switched off')
  await page.evaluate(() => window.__oip.controller.stop())
  got = await retainedWhen(topic, (r) => r[`${topic}/status`] === 'stopped')
  expect(got[`${topic}/status`] === 'stopped', `Stop says stopped (${got[`${topic}/status`]})`)
  await page.evaluate(() => window.__oip.store.setExternalPlc({ mqtt: false }))
  await page.waitForFunction(() => window.__oip.controller.mqttStatus.state === 'off', null, { timeout: 10000, polling: 100 })
  got = await retainedWhen(topic, (r) => r[`${topic}/status`] === 'offline')
  expect(got[`${topic}/status`] === 'offline', `switched off, the state reads offline (${got[`${topic}/status`]})`)
}

const { url, vite } = await startServer()
const profileDir = mkdtempSync(join(tmpdir(), 'oip-profile-'))
let app
try {
  // the broker needs a moment to bind
  for (let i = 0; i < 50 && (await tool('mosquitto_pub', ['-t', 'oip-ready', '-m', '1', '-d'])).indexOf('CONNACK') < 0; i++) await sleep(100)

  console.log('--- the desktop app, over mqtt:// ---')
  const electronPath = require(join(desktopDir, 'node_modules', 'electron'))
  const env = { ...process.env, DESKTOP_URL: url }
  delete env.ELECTRON_RUN_AS_NODE // else Electron runs main.cjs as plain Node (see docs/desktop-shell.md)
  app = await _electron.launch({ executablePath: electronPath, args: [desktopDir, `--user-data-dir=${profileDir}`], env })
  const page = await app.firstWindow()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.waitForSelector('.toolbar', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__oip?.store && !!window.__oip?.controller, null, { timeout: 60000, polling: 200 })
  await page.evaluate(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await exercise(page, `mqtt://127.0.0.1:${tcpPort}`, 'oip-desktop')

  // a broker that is not there: the publisher says so and keeps trying
  const dead = await freePort()
  await page.evaluate((p) => window.__oip.store.setExternalPlc({ mqtt: true, mqttUrl: `mqtt://127.0.0.1:${p}` }), dead)
  await page.waitForFunction(() => window.__oip.controller.mqttStatus.state === 'failed', null, { timeout: 15000, polling: 100 }).catch(() => {})
  const down = await status(page)
  expect(down.state === 'failed' && down.retrying && /nothing is listening/.test(down.error ?? ''), `no broker at the address: it says so and retries (${down.state}, ${down.error})`)
  await page.evaluate(() => window.__oip.store.setExternalPlc({ mqtt: false }))
  expect(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`)
} catch (err) {
  failures++
  console.error('  FAIL:', err)
} finally {
  await app?.close().catch(() => {})
  rmSync(profileDir, { recursive: true, force: true })
}

try {
  console.log('--- a browser tab, over ws:// ---')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
    await page.goto(url)
    await page.waitForFunction(() => !!window.__oip?.store && !!window.__oip?.controller, null, { timeout: 60000, polling: 200 })
    await exercise(page, `ws://127.0.0.1:${wsPort}`, 'oip-browser')

    // a plain mqtt:// address in a tab: there is no TCP socket, and the status says what to use instead
    await page.evaluate((p) => window.__oip.store.setExternalPlc({ mqtt: true, mqttUrl: `mqtt://127.0.0.1:${p}` }), tcpPort)
    await page.waitForFunction(() => window.__oip.controller.mqttStatus.state === 'failed', null, { timeout: 15000, polling: 100 }).catch(() => {})
    const tab = await status(page)
    expect(tab.state === 'failed' && /WebSocket address/.test(tab.error ?? ''), `a tab given mqtt:// asks for the WebSocket address (${tab.error})`)
    expect(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`)
  } finally {
    await browser.close()
  }
} catch (err) {
  failures++
  console.error('  FAIL:', err)
} finally {
  vite.kill()
  broker.kill()
  await sleep(200)
  rmSync(work, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall mqtt-electron checks passed')
process.exit(0)
