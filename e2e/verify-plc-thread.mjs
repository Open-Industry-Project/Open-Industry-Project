// The controller on a worker of its own (src/sim/plcThread.ts), in the browser. plcThread.test.ts holds the
// hand-over to what a controller on the sim worker does, with both ends on one thread. Only a browser has the two
// workers: this checks that a program scans over there, that parts and program reach each other across it, that a
// force and a fault cross it, and that Stop and a second run leave nothing behind. The same run with ?plcthread=0
// must come out the same, apart from where it scanned.
// Run: node e2e/verify-plc-thread.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// Go runs the belt, the belt answers on Moving, and Echo follows Moving: one trip from the program to a part and
// back. Count counts scans. Bad is an index the fault check sends out of range.
const PROGRAM = `VAR
  Go : BOOL;
  Moving : BOOL;
  Echo : BOOL;
  Count : DINT;
  Bad : INT;
  Slots : ARRAY[0..3] OF INT;
END_VAR
Go := TRUE;
Echo := Moving;
Count := Count + 1;
Slots[Bad] := 1;
`

const stats = (page) => page.evaluate(() => ({ ...(window.__oip.sim.stepStats ?? {}) }))

async function run(browser, query, threaded) {
  const label = threaded ? 'own worker' : 'sim worker'
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ } })
    await page.goto(`http://localhost:${PORT}/app/${query}`)
    await page.evaluate(() => localStorage.clear()).catch(() => {})
    await page.reload()
    await page.waitForFunction(() => !!window.__oip?.store && !!window.__oip?.controller, null, { timeout: 120000, polling: 200 })
    await page.evaluate((src) => {
      const st = window.__oip.store
      st.loadScene({
        version: st.getState().scene.version,
        parts: [{ id: 'belt', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.8, 0], rotationY: 0, params: { shapePreset: 'custom', segments: [[3, 0]], width: 0.8, standHeight: 0.8, speed: 0.5, runTag: 'Go', runningTag: 'Moving' } }],
      })
      st.loadStProgram(src)
    }, PROGRAM)
    await page.evaluate(() => window.__oip.controller.run())
    const counting = await page.waitForFunction(() => (window.__oip.controller.plcWatch?.Count ?? 0) > 50, null, { timeout: 90000 }).then(() => true, () => false)
    check(`${label}: the program scans`, counting)
    if (!counting) return
    const s = await stats(page)
    check(`${label}: the scans are made ${threaded ? 'on a worker of their own' : 'on the sim worker'}`, (s.plcThread === true) === threaded, `plcThread ${s.plcThread}`)
    check(`${label}: their cost is reported`, (s.plcSplit?.scans ?? 0) > 50 && s.plcSplit.scanMs > 0, JSON.stringify(s.plcSplit))

    // program -> part -> program
    const echoed = await page.waitForFunction(() => window.__oip.controller.plcWatch?.Echo === true, null, { timeout: 15000 }).then(() => true, () => false)
    check(`${label}: the belt runs on the program's output and the program reads the belt's answer`, echoed)
    check(`${label}: a frame carries the process image`, await page.evaluate(() => window.__oip.sim.plcState?.outputs?.Go === true && window.__oip.sim.plcState?.inputs?.Moving === true), JSON.stringify(await page.evaluate(() => ({ o: window.__oip.sim.plcState?.outputs, i: window.__oip.sim.plcState?.inputs }))))
    check(`${label}: ...and each task's scan time`, await page.evaluate(() => (window.__oip.sim.plcState?.scanTimes?.[0]?.scans ?? 0) > 0))

    // a force holds Go off against the program, so the belt stops and Echo follows it down
    await page.evaluate(() => window.__oip.controller.forcePlcValue('Go', 'FALSE'))
    const stopped = await page.waitForFunction(() => window.__oip.controller.plcWatch?.Go === false && window.__oip.controller.plcWatch?.Echo === false, null, { timeout: 15000 }).then(() => true, () => false)
    check(`${label}: a force holds an output against the program, and the belt follows`, stopped)
    await page.evaluate(() => window.__oip.controller.releasePlcForces?.())
    const again = await page.waitForFunction(() => window.__oip.controller.plcWatch?.Echo === true, null, { timeout: 15000 }).then(() => true, () => false)
    check(`${label}: released, the program has it again`, again)

    // each step is scanned for once, wherever the scans are made: 60 steps a second on a 10 ms scan is 5 scans to 3 steps
    const a = await stats(page)
    await page.waitForTimeout(1500)
    const b = await stats(page)
    const perStep = (b.plcSplit.scans - a.plcSplit.scans) / (b.steps - a.steps)
    check(`${label}: the scans a step gets are the ones its time covers, no more`, b.steps - a.steps > 30 && Math.abs(perStep - 5 / 3) < 0.06, `${perStep.toFixed(3)} scans a step over ${b.steps - a.steps} steps`)

    // a fault stops the program and names the place, and the sim goes on
    await page.evaluate(() => window.__oip.controller.writePlcValue('Bad', '9'))
    const faulted = await page.waitForFunction(() => window.__oip.controller.programStatus?.attached === false, null, { timeout: 15000 }).then(() => true, () => false)
    check(`${label}: an index out of range faults the program`, faulted, JSON.stringify(await page.evaluate(() => window.__oip.controller.programStatus)))
    check(`${label}: ...with a message that says so`, /out of bounds/.test(JSON.stringify(await page.evaluate(() => window.__oip.controller.plcFaults ?? window.__oip.controller.programStatus))))
    const stepsAt = (await stats(page)).steps
    await page.waitForTimeout(500)
    check(`${label}: the physics steps on without it`, (await stats(page)).steps > stepsAt)

    // Stop, and a second run from the top
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForFunction(() => window.__oip.store.getState().running === false, null, { timeout: 15000 })
    await page.evaluate(() => window.__oip.controller.run())
    const second = await page.waitForFunction(() => (window.__oip.controller.plcWatch?.Count ?? 0) > 20 && window.__oip.controller.programStatus?.attached === true, null, { timeout: 60000 }).then(() => true, () => false)
    check(`${label}: a second run scans from the start`, second)
    check(`${label}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await page.close()
  }
}

const browser = await chromium.launch({ headless: !HEADED, ...(process.env.OIP_BROWSER_CHANNEL ? { channel: process.env.OIP_BROWSER_CHANNEL } : {}) })
try {
  await run(browser, '?plcthread', true)
  await run(browser, '?plcthread=0', false)
} finally {
  await browser.close()
  vite?.kill()
}
console.log(failures === 0 ? '\nverify-plc-thread: all checks passed' : `\nverify-plc-thread: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
