// Follows the published MQTT guide, guides/mqtt/index.html (/guides/mqtt/), step by step, in the real desktop shell
// and then in a browser tab, with a Mosquitto broker and Mosquitto's own command-line clients on the other side.
//
// What it proves: a person who does what the page says ends up where the page says (e2e/_guide.mjs has the rule).
// The program is the page's own <pre>, the wiring the page's table, the broker is started with the page's command and
// the page's configuration file, the clients are run with the page's command lines, and each label, default, topic
// and status line the page quotes is looked up on the page first.
//
//   step 1  the parts' Comms fields set through the Inspector, by name (Main.Eye, Main.Run, Main.Speed)
//   step 2  the page's program typed into the PLC panel's code editor
//   step 3  the broker started with the page's command
//   step 4  PLC Controllers... from the palette; the Broker and Topic defaults; the box ticked; the status line
//   step 5  the page's mosquitto_sub prints the page's five lines
//   step 6  Play: running, the belt waits; the page's mosquitto_pub: the belt runs and the box stops at the eye; the
//           last write shown; a write to the eye refused, and shown; Stop and Play; a Speed setpoint sets the belt's
//           speed; the app closed: offline
//   tab     the page's configuration file; a browser tab on its WebSocket address runs the same line
//   trouble the status lines the troubleshooting section quotes, each produced the way it says
//
// One thing differs from the page: the ports. A machine with Mosquitto installed usually has its service on 1883, and
// that broker is the person's own, so this run's brokers listen on free ports and every 1883 and 9001 the page gives
// is replaced by them, in the commands, the configuration file, the addresses and the expected status lines.
// A run that retakes the pictures (--images) is the exception: a picture has to show the page's own address, so the
// desktop steps use port 1883 itself, on the broker already there if one answers, and clear what they left under
// the guide's topic afterwards.
//
// Usage:
//   node e2e/guide-mqtt.mjs                    follow the guide; exit 0 = it works as written
//   node e2e/guide-mqtt.mjs --shots <dir>      also save a screenshot per step
//   node e2e/guide-mqtt.mjs --images           also retake the page's pictures (guides/mqtt/img/, see guidePictures)
//
// Needs Mosquitto on this machine (OIP_MOSQUITTO names its folder when it is not where the installer puts it); without
// one it prints SKIP and exits 0.
// Exit 0 = the guide works; 1 = a step did not; 2 = it could not run.
/* global process, console, window, localStorage */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { freePort } from './_port.mjs'
import { showPlcEditor } from './_plc.mjs'
import { startServer } from './_server.mjs'
import { boxX, commsGroup, guidePictures, guideTest, LINE_CAMERA, labelled, launchShell, loadParts, openExternalPlc, settledX, shot as shotTo, sleep, squash, waitForReset, wire as wireRow } from './_guide.mjs'

const argv = process.argv.slice(2)
const shotsDir = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null
const shot = (page, name) => shotTo(page, shotsDir, name)

// ---- the page ----

const { html, expect, says, programs, wiring, failures } = guideTest('mqtt')
const pics = guidePictures('mqtt', { html, expect })
/** The page's listings, in order. */
const [program, brokerCommand, statusLine, subCommand, subOutput, pubCommand, brokerConf, confCommand] = programs
const bold = (label) => new RegExp(`<span class="ui">${label}</span>: <b>([^<]+)</b>`).exec(html)?.[1]
const guideBroker = bold('Broker')
const guideTopic = bold('Topic')
const tabBroker = /set <span class="ui">Broker<\/span> to <b>(ws:\/\/[^<]+)<\/b>/.exec(html)?.[1]

// ---- Mosquitto ----

const exe = process.platform === 'win32' ? '.exe' : ''
function mosquittoDir() {
  if (process.env.OIP_MOSQUITTO) return process.env.OIP_MOSQUITTO
  const usual = process.platform === 'win32' ? 'C:\\Program Files\\mosquitto' : '/usr/sbin'
  return existsSync(join(usual, `mosquitto${exe}`)) ? usual : null
}
const dir = mosquittoDir()
// on Linux the clients are in /usr/bin while the broker is in /usr/sbin
const toolPath = (name) => (dir && existsSync(join(dir, `${name}${exe}`)) ? join(dir, `${name}${exe}`) : name)

/** A command line of the page as a program and its arguments. */
function argvOf(command) {
  const [name, ...args] = [...command.trim().matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2])
  return { name, args }
}

/** Run a page's client command to its end, on `port`; what it printed. */
function client(command, port, more = []) {
  const { name, args } = argvOf(command)
  return new Promise((resolve) => {
    const p = spawn(toolPath(name), [...args, '-p', String(port), ...more], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', () => resolve(out))
    p.on('error', () => resolve(out))
  })
}

/** Start a broker with a page's command and wait until it takes a client; null if it never did. */
async function startBroker(command, port, more) {
  const { name, args } = argvOf(command)
  const p = spawn(toolPath(name), [...args, ...more], { stdio: 'ignore' })
  for (let i = 0; i < 50; i++) {
    const said = await client('mosquitto_pub -h 127.0.0.1 -t oip-guide-ready -m 1 -d', port)
    if (said.includes('CONNACK')) return p
    await sleep(100)
  }
  p.kill()
  return null
}

/** The page's subscriber, left running as a reader leaves it: every line it prints, as it prints them. */
function subscribe(command, port) {
  const { name, args } = argvOf(command)
  const lines = []
  const p = spawn(toolPath(name), [...args, '-p', String(port)], { stdio: ['ignore', 'pipe', 'ignore'] })
  let rest = ''
  p.stdout.on('data', (d) => {
    const parts = (rest + d).split(/\r?\n/)
    rest = parts.pop()
    lines.push(...parts.filter(Boolean))
  })
  const until = async (done, ms = 10000) => {
    const end = Date.now() + ms
    while (!done() && Date.now() < end) await sleep(50)
    return done()
  }
  return { lines, printed: (line, from = 0, ms) => until(() => lines.indexOf(line, from) >= 0, ms), stop: () => p.kill() }
}

const PART_IDS = { 'Belt Conveyor': 'belt', 'Photo Eye': 'eye' }
const PARTS = [
  { id: 'belt', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0, params: { shapePreset: 'custom', segments: [[5, 0]], width: 0.8, standHeight: 0.8, speed: 0.5 } },
  { id: 'box', type: 'part', packageId: 'oip.box', position: [0.6, 1.0, 0], rotationY: 0, params: { length: 0.4, width: 0.3, height: 0.3 } },
  { id: 'eye', type: 'part', packageId: 'oip.diffuse-sensor', position: [3, 0.75, -0.6], rotationY: 0, params: {} },
]

const publisher = (page) => page.evaluate(() => window.__oip.controller.mqttStatus)
const connected = (page) => page.waitForFunction(() => window.__oip.controller.mqttStatus.state === 'connected' && window.__oip.controller.mqttStatus.variables > 0, null, { timeout: 20000, polling: 100 }).catch(() => {})
const failed = (page) => page.waitForFunction(() => window.__oip.controller.mqttStatus.state === 'failed', null, { timeout: 20000, polling: 100 }).catch(() => {})
const statusText = async (page) => squash(await page.locator('[data-testid="mqtt-status"]').innerText())

/** Type an address into the section's Broker field, as a reader does. */
async function typeBroker(page, address) {
  const field = page.locator('[data-testid="mqtt-url"]')
  await field.fill(address)
  await field.press('Enter')
  await page.waitForFunction((a) => window.__oip.store.getState().externalPlc.mqttUrl === a, address, { timeout: 5000, polling: 50 }).catch(() => {})
}

/** The box's speed in m/s between two positions along the belt, sampled every 100 ms (null if it never crossed both). */
async function speedBetween(page, from, to, timeoutMs = 30000) {
  let a = null
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const x = await boxX(page)
    if (a === null && x !== null && x >= from) a = { t: Date.now(), x }
    if (a !== null && x !== null && x >= to) return (x - a.x) / ((Date.now() - a.t) / 1000)
    await sleep(100)
  }
  return null
}

async function main() {
  console.log('Following guides/mqtt/index.html')
  if (!dir) {
    // the gate runner's word for "nothing was tested" (scripts/run-gates.mjs): a skip is not a pass
    console.log('SKIP: Mosquitto is not on this machine (set OIP_MOSQUITTO to its folder), so the guide was not followed')
    return 0
  }
  expect(wiring.length === 3, `the guide wires three fields (${wiring.map((w) => `${w.part} ${w.field} = ${w.address}`).join(', ')})`)
  expect(programs.length === 8, `the guide has its eight listings (${programs.length})`)
  expect(guideBroker === 'mqtt://127.0.0.1:1883' && guideTopic === 'oip', `step 4 gives the Broker and Topic defaults (${guideBroker}, ${guideTopic})`)
  expect(tabBroker === 'ws://127.0.0.1:9001', `the tab's address is the configuration file's WebSocket listener (${tabBroker})`)
  expect(argvOf(brokerCommand).name === 'mosquitto' && argvOf(subCommand).name === 'mosquitto_sub' && argvOf(pubCommand).name === 'mosquitto_pub', "the commands are Mosquitto's")
  if (failures()) return 1

  // this run's ports, in place of the page's (see the top of the file)
  const tcp = pics.publish ? 1883 : await freePort()
  const here = (text) => text.replaceAll('1883', String(tcp))
  /** whether the desktop steps run on a broker that was already there (--images, port 1883) */
  let borrowed = false
  const work = mkdtempSync(join(tmpdir(), 'oip-guide-mqtt-'))
  let broker = null
  let sub = null
  let shell = null
  try {
    shell = await launchShell()
    const { page } = shell
    await pics.sizeWindow(shell.app)

    console.log('--- step 1: build the scene and wire it to the program ---')
    expect((await loadParts(page, PARTS)) === true, 'the scene opens with a belt, a box and a photo eye, unwired')
    for (const row of wiring) await wireRow(page, row, { expect, says, partIds: PART_IDS })
    await shot(page, 'step1-inspector')
    await pics.ui(page, 'inspector-comms', commsGroup(page))

    console.log('--- step 2: write the program ---')
    await showPlcEditor(page)
    const code = page.locator('.cm-content').first()
    await code.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.insertText(program)
    await page.waitForFunction((tail) => window.__oip.store.getState().stProgram.includes(tail), 'Run := Start AND NOT Eye;', { timeout: 10000, polling: 100 })
    expect(squash(await page.evaluate(() => window.__oip.store.getState().stProgram)) === squash(program), "the PLC panel holds the guide's program")
    await shot(page, 'step2-program')

    console.log('--- step 3: start the broker ---')
    borrowed = pics.publish && (await client('mosquitto_pub -h 127.0.0.1 -t oip-guide-ready -m 1 -d', tcp)).includes('CONNACK')
    if (borrowed) console.log(`  (a broker already answers on ${tcp}: using it for the pictures, and clearing ${guideTopic}/# afterwards)`)
    else broker = await startBroker(brokerCommand, tcp, ['-p', String(tcp)])
    expect(borrowed || broker !== null, `"${brokerCommand}", with no configuration file, takes a client without a login`)
    if (!borrowed && !broker) return 1

    console.log('--- step 4: switch on the publisher ---')
    await openExternalPlc(page, { expect, says })
    const ext = page.locator('[data-testid="external-plc"]')
    await ext.waitFor({ timeout: 20000 })
    expect(await ext.locator('label.ctl-ext-field', { hasText: labelled(says('This simulator')) }).locator('input').isChecked(), '"Runs on" is This simulator')
    const section = page.locator('[data-testid="mqtt"]')
    expect((await section.locator('h3').innerText()).trim() === says('MQTT publisher'), 'the section is "MQTT publisher"')
    const field = (label) => section.locator('label.ctl-ext-field', { hasText: labelled(says(label)) }).locator('input')
    expect((await field('Broker').inputValue()) === guideBroker, `Broker reads ${guideBroker}`)
    expect((await field('Topic').inputValue()) === guideTopic, `Topic reads ${guideTopic}`)
    await typeBroker(page, here(guideBroker))
    await field("Publish the program's variables").check()
    await connected(page)
    const before = await statusText(page)
    expect(before === squash(here(statusLine)), `the status line is the guide's, before any Play ("${before}")`)
    await shot(page, 'step4-publisher')
    await pics.ui(page, 'mqtt-publisher', section)
    await page.keyboard.press('Escape')

    console.log('--- step 5: watch from another client ---')
    sub = subscribe(subCommand, tcp)
    const want = subOutput.trim().split(/\r?\n/)
    await sub.printed(want.at(-1))
    await sleep(300)
    expect(JSON.stringify([...sub.lines].sort()) === JSON.stringify([...want].sort()), `the subscriber prints the guide's five lines straight away (${sub.lines.join(' | ')})`)
    for (const topic of ['oip/tags/Main/Start', 'oip/set/Main/Start', 'oip/status']) says(topic)

    console.log('--- step 6: run the line from the client ---')
    let mark = sub.lines.length
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.controller.mqttStatus.live, null, { timeout: 20000, polling: 100 })
    await waitForReset(page)
    expect(await sub.printed(says('oip/status running'), mark), 'on Play the subscriber prints oip/status running')
    await sleep(1500)
    const x0 = await boxX(page)
    await sleep(500)
    expect(Math.abs((await boxX(page)) - x0) < 0.05, 'and the belt waits')
    expect(await page.evaluate(() => window.__oip.controller.programStatus.error === null), 'the program compiled with no errors')

    mark = sub.lines.length
    await client(pubCommand, tcp)
    expect(await sub.printed(says('oip/tags/Main/Eye true'), mark, 25000), 'after the page\'s mosquitto_pub the subscriber prints oip/tags/Main/Eye true')
    const stopped = await settledX(page, 25000, 1500)
    expect(stopped !== null && stopped > x0 + 1 && Math.abs(stopped - 2.83) < 0.3, `the belt ran and stopped the box at the sensor (${x0?.toFixed?.(2)} -> ${stopped?.toFixed?.(3)} m)`)
    await pics.scene(page, 'box-stopped', LINE_CAMERA)
    // a write the program does not take: the page's own example
    await client(`mosquitto_pub -h 127.0.0.1 -t ${says('oip/set/Main/Eye')} -m true`, tcp)
    await page.waitForFunction(() => window.__oip.controller.mqttStatus.lastRefused !== null, null, { timeout: 5000, polling: 100 }).catch(() => {})
    await openExternalPlc(page, { expect, says })
    const lastWrite = await page.locator('[data-testid="mqtt-last-write"]').innerText()
    expect(lastWrite === says('Last write from the broker: Main.Start := TRUE'), `Controller Properties shows the last write ("${lastWrite}")`)
    const lastRefused = await page.locator('[data-testid="mqtt-last-refused"]').innerText()
    expect(lastRefused === says('Last write refused: Main.Eye: it is read-only (a constant, or an input the scene feeds)'), `and the write it refused ("${lastRefused}")`)
    await shot(page, 'step6-last-write')
    await page.keyboard.press('Escape')

    // Stop and Play keep the connection
    mark = sub.lines.length
    await page.evaluate(() => window.__oip.controller.stop())
    expect(await sub.printed('oip/status stopped', mark), 'on Stop the subscriber prints oip/status stopped')
    mark = sub.lines.length
    await page.evaluate(() => window.__oip.controller.run())
    await waitForReset(page)
    expect(await sub.printed('oip/status running', mark), 'and on Play running again, on the same connection')
    await sleep(800)

    // the optional setpoint: 0.2 to Speed, then Start
    await client(`mosquitto_pub -h 127.0.0.1 -t ${says('oip/set/Main/Speed')} -m ${says('0.2')}`, tcp)
    await client(pubCommand, tcp)
    const v = await speedBetween(page, 1.0, 2.0)
    expect(v !== null && Math.abs(v - 0.2) < 0.05, `the belt carries the box at the new speed (${v?.toFixed?.(2)} m/s)`)
    await page.evaluate(() => window.__oip.controller.stop())

    console.log('--- troubleshooting: no broker at the address ---')
    await openExternalPlc(page, { expect, says })
    const dead = await freePort()
    await typeBroker(page, `mqtt://127.0.0.1:${dead}`)
    await failed(page)
    const down = await statusText(page)
    expect(down.startsWith(says('Not connected to')) && down.includes(says('nothing is listening on')), `it says so ("${down}")`)
    expect((await publisher(page)).retrying, 'and keeps trying')
    await typeBroker(page, here(guideBroker))
    await connected(page)
    expect((await publisher(page)).state === 'connected', 'with the broker back at its address it connects by itself')
    await page.keyboard.press('Escape')

    // the app closed: the broker says offline for it
    mark = sub.lines.length
    await shell.close()
    shell = null
    expect(await sub.printed(`oip/status ${says('offline')}`, mark), 'the app closed, the subscriber prints oip/status offline')
  } finally {
    sub?.stop()
    await shell?.close()
    broker?.kill()
    if (borrowed) await client(`mosquitto_sub -h 127.0.0.1 -t "${guideTopic}/#" --remove-retained -W 1`, tcp)
  }

  console.log('--- from a browser tab ---')
  const tabTcp = await freePort()
  const ws = await freePort()
  const tabHere = (text) => text.replaceAll('1883', String(tabTcp)).replaceAll('9001', String(ws))
  writeFileSync(join(work, says('oip.conf')), tabHere(brokerConf) + '\n')
  const { url, vite } = await startServer()
  let browser = null
  broker = null
  try {
    // the page's command names the file; the broker is started in the folder that holds it
    const { name, args } = argvOf(confCommand)
    broker = spawn(toolPath(name), args, { cwd: work, stdio: 'ignore' })
    let up = false
    for (let i = 0; i < 50 && !up; i++) {
      up = (await client('mosquitto_pub -h 127.0.0.1 -t oip-guide-ready -m 1 -d', tabTcp)).includes('CONNACK')
      if (!up) await sleep(100)
    }
    expect(up, `"${confCommand}" starts a broker from the guide's configuration file`)
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
    await page.goto(url)
    await page.waitForFunction(() => !!window.__oip?.store && !!window.__oip?.controller, null, { timeout: 60000, polling: 200 })
    await page.waitForFunction(() => window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 60000, polling: 200 })
    // steps 1 and 2 as the desktop run left them: the same parts, wired as the page's table says, and its program
    const wired = PARTS.map((p) => ({ ...p, params: { ...p.params, ...(p.id === 'belt' ? { runTag: 'Main.Run', speedTag: 'Main.Speed' } : p.id === 'eye' ? { tag: 'Main.Eye' } : {}) } }))
    expect((await loadParts(page, wired)) === true, 'the tab has the same scene')
    await page.evaluate((program) => window.__oip.store.loadStProgram(program), program)
    await showPlcEditor(page)
    await page.locator('[data-testid="org-controller"]').dblclick()
    const section = page.locator('[data-testid="mqtt"]')
    await section.waitFor({ timeout: 20000 })

    // a tab left on the default address: the troubleshooting section's line
    await section.locator('label.ctl-ext-field', { hasText: labelled("Publish the program's variables") }).locator('input').check()
    await failed(page)
    let line = await statusText(page)
    expect(line.includes(says('a browser tab cannot open a plain mqtt:// connection')), `a tab on an mqtt:// address says what it needs ("${line}")`)
    // the plain MQTT port given as a WebSocket address
    await typeBroker(page, `ws://127.0.0.1:${tabTcp}`)
    await page.waitForFunction(() => /no MQTT broker answered/.test(window.__oip.controller.mqttStatus.error ?? ''), null, { timeout: 20000, polling: 100 }).catch(() => {})
    line = await statusText(page)
    expect(line.includes(says('no MQTT broker answered at ws://')), `the plain MQTT port is not a WebSocket listener, and it says so ("${line}")`)

    await typeBroker(page, tabHere(tabBroker))
    await connected(page)
    line = await statusText(page)
    expect(line === squash(statusLine.replace(guideBroker, tabHere(tabBroker))), `on ${tabBroker} the tab connects ("${line}")`)
    await page.locator('[data-testid="controller-props-close"]').click()
    const seen = (await client(subCommand, tabTcp, ['-W', '1', '--retained-only'])).split(/\r?\n/).filter(Boolean)
    const want = subOutput.trim().split(/\r?\n/)
    expect(JSON.stringify(seen.sort()) === JSON.stringify([...want].sort()), `a client on port 1883 still sees the guide's five lines (${seen.join(' | ')})`)
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.controller.mqttStatus.live && window.__oip.controller.livePosition('box') != null, null, { timeout: 20000, polling: 100 })
    await waitForReset(page)
    await sleep(1000)
    const x0 = await boxX(page)
    await client(pubCommand, tabTcp)
    const stopped = await settledX(page, 25000, 1500)
    expect(stopped !== null && stopped > x0 + 1 && Math.abs(stopped - 2.83) < 0.3, `the page's mosquitto_pub runs the tab's line too (${x0?.toFixed?.(2)} -> ${stopped?.toFixed?.(3)} m)`)
    await page.evaluate(() => window.__oip.controller.stop())
  } finally {
    await browser?.close().catch(() => {})
    vite.kill()
    broker?.kill()
    await sleep(200)
    rmSync(work, { recursive: true, force: true })
  }

  await pics.finish()
  console.log(failures() === 0 ? '\nThe guide works as written.' : `\n${failures()} check(s) failed: the guide or the app has to change.`)
  return failures() === 0 ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e)
    process.exit(2)
  },
)
