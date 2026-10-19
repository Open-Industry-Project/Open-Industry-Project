// Verify that a shared room carries the PLC program, and that everyone in it can run the line.
//
// The reported bug: "I enter collab mode and nothing runs." The ?scene=demo boot loads its paired
// program live but deliberately unpersisted, so a room seeder that reads the program from the legacy
// localStorage key uploads the layout and no logic. The host and every joiner then attach an empty
// program, which compiles clean and declares no outputs, so every comms device falls back to hand
// control and the line sits there with no error and nothing in the panel to debug.
//
// This drives the real Share button against a real Hocuspocus server, from the demo (the configuration
// that broke), and asserts: the room carries the program, the host runs, a joiner runs, and a program
// arriving after a client joined an empty room is adopted without a manual Stop/Play.
//
// Run: node e2e/verify-collab-program.mjs [--headed]
/* global process, console, window, setTimeout */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { freePort } from './_port.mjs'
import { startServer } from './_server.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// --- collab server on a free port; the client picks it up via VITE_COLLAB_URL ---
const collabPort = await freePort()
const dbPath = join(tmpdir(), `oip-collab-prog-${collabPort}.sqlite`)
process.env.VITE_COLLAB_URL = `ws://localhost:${collabPort}`
const collab = spawn('node', ['index.mjs'], {
  cwd: join(here, '..', 'server'),
  env: { ...process.env, PORT: String(collabPort), DB_PATH: dbPath },
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('collab server did not start')), 15000)
  collab.stdout.on('data', (d) => {
    if (String(d).includes('listening')) {
      clearTimeout(t)
      resolve()
    }
  })
})

// isolated: VITE_COLLAB_URL is set above and a shared server was started without it (see _server.mjs)
const { url: APP_URL, vite } = await startServer({ isolated: true })

// The joiner boots while the host page still holds a live WebGL context and a sim worker, so its
// first paint is slow on a one-GPU machine - give the second client a wider budget than the first.
// NB: waitForFunction is (fn, arg, options) - passing {timeout} as the second argument makes it the
// page-function's arg and silently leaves the default 30 s in force.
async function waitForApp(page, timeout = 30000) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), undefined, { timeout, polling: 500 })
}

const programOf = (page) => page.evaluate(() => window.__oip.store.getState().stProgram)

/** Play, then report how far the furthest piece of cargo travels in `ms` */
async function runAndMeasure(page, ms) {
  await page.evaluate(() => {
    const sim = window.__oip.sim
    const prior = sim.onFrame
    window.__seen = new Map()
    window.__travel = 0
    sim.onFrame = (f) => {
      prior?.(f)
      for (let i = 0; i < f.count; i++) {
        const id = f.ids[i]
        const x = f.positions[i * 3]
        const z = f.positions[i * 3 + 2]
        const first = window.__seen.get(id)
        if (first === undefined) window.__seen.set(id, [x, z])
        else window.__travel = Math.max(window.__travel, Math.hypot(x - first[0], z - first[1]))
      }
    }
    try {
      window.__oip.controller.run()
    } catch (e) {
      window.__runError = String(e)
    }
  })
  await page
    .waitForFunction(() => window.__oip.store.getState().running === true, undefined, { timeout: 10000, polling: 500 })
    .catch(async () => {
      const why = await page.evaluate(() => ({
        err: window.__runError ?? null,
        state: window.__oip.store.getState().running,
        readOnly: window.__oip.store.getState().readOnly,
        mode: window.__oip.store.getState().mode,
        hasSim: !!window.__oip.sim,
      }))
      throw new Error(`run() did not start the sim: ${JSON.stringify(why)}`)
    })
  await page.waitForTimeout(ms)
  return page.evaluate(() => ({
    travel: window.__travel,
    driven: window.__oip.controller.plcDrivenKeys.size,
    warnings: window.__oip.controller.programStatus.warnings,
  }))
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const host = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const guest = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const A = await host.newPage()
  try {
    // ── 1. the host opens the demo: program live, deliberately not persisted ──
    await A.goto(`${APP_URL}?scene=demo`, { waitUntil: 'domcontentloaded' })
    await waitForApp(A)
    await A.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 5, undefined, { timeout: 30000, polling: 500 })
    const soloProgram = await programOf(A)
    check('the host has a live PLC program before sharing', soloProgram.length > 50, `${soloProgram.length} chars`)

    // ── 2. Share, through the real button ──
    await A.locator('button.share-button').click()
    await A.locator('button.share-option', { hasText: 'Can edit' }).click()
    await A.waitForFunction(() => new URL(location.href).searchParams.has('room'), undefined, { timeout: 15000, polling: 500 })
    await waitForApp(A)
    await A.waitForFunction(() => window.__oip.store.getState().collab === true, undefined, { timeout: 15000, polling: 500 })
    await A.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 5, undefined, { timeout: 30000, polling: 500 })
    const roomUrl = A.url()
    console.log(`room: ${roomUrl.slice(roomUrl.indexOf('?'))}`)

    const hostProgram = await programOf(A)
    check('the room carries the program the host was editing', hostProgram === soloProgram, `${hostProgram.length} vs ${soloProgram.length} chars`)

    // ── 3. the host can run the line in the room ──
    await A.waitForTimeout(1500)
    const hostRun = await runAndMeasure(A, 12000)
    check('the host drives devices in the room', hostRun.driven > 0, `${hostRun.driven} driven tags`)
    check('no "in hand control" warning for the host', hostRun.warnings.length === 0, hostRun.warnings.join(' | '))
    check('the host line runs (cargo travels)', hostRun.travel > 0.5, `${hostRun.travel.toFixed(2)} m`)
    await A.evaluate(() => window.__oip.controller.stop())
    // Close the host before opening the joiner. Two live 3D contexts + a 197-body sim on one GPU is
    // the contention that makes this fleet flaky (the joiner's boot starves and its rAF stalls), and
    // nothing below needs the host page: the doc is on the server.
    await A.close()

    // ── 4. a joiner gets the program too, and can run its own preview ──
    const B = await guest.newPage()
    await B.goto(roomUrl, { waitUntil: 'domcontentloaded' })
    await waitForApp(B, 90000)
    await B.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 5, undefined, { timeout: 90000, polling: 500 })
    await B.waitForFunction((expected) => window.__oip.store.getState().stProgram.length === expected, soloProgram.length, {
      timeout: 20000,
      polling: 500,
    }).catch(() => {})
    check('a joiner receives the room program', (await programOf(B)) === soloProgram)
    await B.waitForTimeout(1500)
    const guestRun = await runAndMeasure(B, 12000)
    check('the joiner drives devices', guestRun.driven > 0, `${guestRun.driven} driven tags`)
    check('the joiner line runs (cargo travels)', guestRun.travel > 0.5, `${guestRun.travel.toFixed(2)} m`)
    await B.evaluate(() => window.__oip.controller.stop())

    // ── 5. the join race: `whenSynced` gives up on a slow server after 4 s, so a client can boot
    // against an empty doc and press Play before the room's program arrives. If the program were read
    // once, at the run edge, the client would attach the empty program and stay dead until a manual
    // Stop/Play. Drive the doc -> store entry point the bridge uses (applyRemoteStProgram - the
    // Y.Text observer that calls it is covered by collab.test.ts) and assert the controller adopts.
    // What the bridge hands the store is the room's program document, table and all (bridge.syncStProgramFromDoc): an
    // empty room is no text and no table. Pushing only the text would keep the demo's controller table, whose tasks
    // name programs the empty text does not have, so the attach would refuse it outright, a state no room can produce.
    const roomController = await B.evaluate(() => window.__oip.store.getState().controller)
    await B.evaluate(() => window.__oip.store.applyRemoteStProgram('', undefined, null, null))
    const beforeArrival = await runAndMeasure(B, 2000)
    check('[race] a client whose program has not arrived drives nothing', beforeArrival.driven === 0, `${beforeArrival.driven} driven tags`)
    check(
      '[race] and says so rather than sitting there silently',
      beforeArrival.warnings.some((w) => w.includes('hand control')),
      beforeArrival.warnings.join(' | ') || '(no warning)',
    )
    // ...and only that: with no program, every wired tag reads as unwritten, and those wiring lines must not bury it
    check(
      '[race] the hand-control warning is not buried under wiring noise',
      beforeArrival.warnings.length === 1,
      `${beforeArrival.warnings.length} warnings`,
    )
    await B.evaluate(([src, table]) => window.__oip.store.applyRemoteStProgram(src, undefined, table, null), [soloProgram, roomController])
    await B.waitForFunction(() => window.__oip.controller.plcDrivenKeys.size > 0, undefined, { timeout: 20000, polling: 500 }).catch(() => {})
    const adopted = await B.evaluate(() => ({
      driven: window.__oip.controller.plcDrivenKeys.size,
      running: window.__oip.store.getState().running,
    }))
    check(
      '[race] the program that lands mid-run is adopted, no Stop/Play needed',
      adopted.driven > 0 && adopted.running,
      `${adopted.driven} driven tags, running=${adopted.running}`,
    )
    await B.evaluate(() => window.__oip.controller.stop())
  } finally {
    await browser.close()
    vite.kill()
    collab.kill()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  vite.kill()
  collab.kill()
  process.exit(1)
})
