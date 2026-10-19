// Verify that a scene saved from a live session re-opens and runs, with its PLC program intact.
//
// The program can live in three places (a localStorage key, a room's shared Y.Text, and a
// `pendingStProgram` field for the demo). An exporter that reads localStorage alone gets it wrong:
//   - a scene exported from a ?scene=demo session (program live, deliberately not persisted)
//     carries the layout and no logic
//   - a scene exported from a collab room carries whatever the user had before joining
// Re-opening either gives a line that looks fine and never starts: an empty program attaches
// with no error, declares no outputs, so every comms device falls back to hand control.
//
// This drives the scene-file writer / Import Project (with a scene file) pair (sceneFileText / importSceneText, the same
// functions the menu and the toolbar's Open call; a scene file opens as a new project, and the page reloads into it)
// against the demo, chosen because its program is live but not persisted, which is the configuration that
// breaks, and then asserts the imported scene actually moves cargo.
//
// Run: node e2e/verify-scene-program-roundtrip.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const BASE_URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// NB: waitForFunction is (fn, arg, options). Passing {timeout} as the second argument makes it the
// page-function's arg and leaves the default 30 s in force without any warning.
async function waitForApp(page) {
  await page.waitForFunction(
    () => !!(window.__oip && window.__oip.store && window.__oip.controller && window.__oip.sceneFileText),
    undefined,
    { timeout: 60000, polling: 500 },
  )
}

// How far the furthest piece of cargo is carried, in metres, over MEASURE_MS. Both arms are judged
// against this one number, from opposite sides.
//
// It has to be measured after a settle. The demo ships 132 authored cargo bodies standing in stacks, and
// the first seconds of any run are that pile settling: measured from first-seen over 12 s, a line with no
// program reaches 0.52 m and has no repeatable maximum (0.52, 0.60, 1.88 across runs), because which box
// moves furthest is chaotic. A threshold can't fix that; it is the wrong quantity. 0.52 m of settling
// alone already exceeds a 0.5 m "the line actually runs" threshold, so the main assertion would pass
// vacuously. Settling decays and transport does not, so a window taken after the pile has stopped
// tells them apart with plenty of margin: 2.84-3.23 m driven against 0.18 m dead
// (measured by e2e/probes/dead-line-motion.mjs, which reports both arms split into an early and a late half).
const SETTLE_MS = 6000
const MEASURE_MS = 6000
const TRAVEL_M = 1.0

/**
 * The part of the demo that runs without a program, by design, and so is left out of the measure.
 *
 * The demo is fed from a trailer: a case source dropping cases onto a flex conveyor.
 * Both are comms devices whose hand-control state is running: the flex's run and release tags only stop it
 * "while a program drives" them, and an undriven spawner gate reads open (examples/parts/flex-conveyor
 * runTag/releaseTag, box-spawner runTag). So with no program the trailer keeps unloading at ~1.4 m/s: 8.26 m in
 * the window, every mover a spawned case on the flex (measured). That is the documented hand-control behaviour
 * of those parts, not "the line running", so any body first seen over the flex's bed is not counted, in either
 * arm. Everything the program runs (infeed onward) still is. The bed is read off the scene (origin + its
 * points), never typed.
 */
function handFedBand(page) {
  return page.evaluate(() => {
    const flex = window.__oip.store.getState().scene.parts.find((p) => p.packageId === 'oip.flex-conveyor')
    if (!flex) return null
    const c = Math.cos(flex.rotationY ?? 0), s = Math.sin(flex.rotationY ?? 0)
    const pts = [[0, 0], ...(flex.params.points ?? [])].map(([x, z]) => [flex.position[0] + x * c + z * s, flex.position[2] - x * s + z * c])
    const pad = (flex.params.width ?? 0.6) / 2 + 0.3
    return {
      x0: Math.min(...pts.map((p) => p[0])) - pad, x1: Math.max(...pts.map((p) => p[0])) + pad,
      z0: Math.min(...pts.map((p) => p[1])) - pad, z1: Math.max(...pts.map((p) => p[1])) + pad,
    }
  })
}

/** max per-body horizontal travel during a window that starts once the authored pile has settled */
async function maxCargoTravel(page) {
  const band = await handFedBand(page)
  await page.waitForTimeout(SETTLE_MS)
  await page.evaluate((band) => {
    const sim = window.__oip.sim
    const prior = sim.onFrame
    window.__seen = new Map()
    window.__travel = 0
    window.__handFed = 0
    sim.onFrame = (f) => {
      prior?.(f)
      for (let i = 0; i < f.count; i++) {
        const id = f.ids[i]
        const x = f.positions[i * 3]
        const z = f.positions[i * 3 + 2]
        const first = window.__seen.get(id)
        // a body created inside the window counts from its creation, which covers a freshly spawned case
        if (first === undefined) {
          const handFed = !!band && x > band.x0 && x < band.x1 && z > band.z0 && z < band.z1
          if (handFed) window.__handFed++
          window.__seen.set(id, handFed ? null : [x, z])
        } else if (first !== null) window.__travel = Math.max(window.__travel, Math.hypot(x - first[0], z - first[1]))
      }
    }
  }, band)
  await page.waitForTimeout(MEASURE_MS)
  return page.evaluate(() => ({ travel: window.__travel, cargo: window.__seen.size, handFed: window.__handFed }))
}

/**
 * Open a scene file the way Import Project does: it becomes a new project and the page reloads into it, so
 * the evaluate may die with the navigation. Resolves to the import's error, or null once the new project is up.
 */
async function openSceneFile(page, text, fileName) {
  const loaded = page.waitForEvent('load', { timeout: 180000 })
  const err = await page
    .evaluate(([t, n]) => window.__oip.importSceneText(t, n), [text, fileName])
    .catch((e) => (/context was destroyed|navigat/i.test(String(e)) ? null : String(e)))
  if (err !== null) {
    loaded.catch(() => {})
    return err
  }
  await loaded
  await waitForApp(page)
  return null
}
const docId = (page) => page.evaluate(() => localStorage.getItem('oip-web/document-id'))

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  try {
    // ── 1. a session whose program is live but deliberately not persisted (the demo) ──
    await page.goto(`${BASE_URL}?scene=demo`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await waitForApp(page)
    await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 5, undefined, { timeout: 30000, polling: 500 })

    const source = await page.evaluate(() => ({
      program: window.__oip.store.getState().stProgram,
      scanMs: window.__oip.store.getState().stScanMs,
      persisted: localStorage.getItem('oip-web/st-program'),
      parts: window.__oip.store.getState().scene.parts.length,
    }))
    check('the demo session has a live PLC program', source.program.length > 50, `${source.program.length} chars`)
    // The precondition for the bug: nothing on disk to export from. If this stops holding, the gate
    // still passes but tests nothing, so assert it explicitly.
    check(
      'and it is deliberately NOT in the persisted buffer (the old exporter read only this)',
      source.persisted === null || source.persisted === '',
      `persisted=${JSON.stringify(source.persisted)}`,
    )

    // ── 2. Save, exactly as the toolbar does ──
    const file = await page.evaluate(() => window.__oip.sceneFileText())
    const doc = JSON.parse(file)
    check('the saved file carries the program', typeof doc.stProgram === 'string' && doc.stProgram.length > 50, `${(doc.stProgram ?? '').length} chars`)
    check('the saved file carries its scan time', doc.stScanMs === source.scanMs, `${doc.stScanMs} vs ${source.scanMs}`)
    check('the saved file carries the layout', Array.isArray(doc.parts) && doc.parts.length === source.parts, `${doc.parts?.length} parts`)

    // ── 3. Open it in a clean browser profile (no saved program anywhere) ──
    await page.evaluate(() => localStorage.clear())
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await waitForApp(page)
    const docBefore = await docId(page)
    const err = await openSceneFile(page, file, 'roundtrip.json')
    check('the saved file re-opens without error', err === null, String(err))
    const opened0 = { name: await page.evaluate(() => window.__oip.store.getState().projectName), doc: await docId(page) }
    check(
      'it opens as a NEW project, named after the file',
      opened0.name === 'roundtrip' && opened0.doc !== null && opened0.doc !== docBefore,
      `"${opened0.name}", document ${docBefore} -> ${opened0.doc}`,
    )

    const opened = await page.evaluate(() => ({
      program: window.__oip.store.getState().stProgram,
      scanMs: window.__oip.store.getState().stScanMs,
      parts: window.__oip.store.getState().scene.parts.length,
    }))
    check('the re-opened scene has the same program', opened.program === source.program)
    check('the re-opened scene has the same scan time', opened.scanMs === source.scanMs, `${opened.scanMs}`)
    check('the re-opened scene has the same layout', opened.parts === source.parts, `${opened.parts} parts`)

    // ── 4. and it runs: the program attaches, drives outputs, and cargo moves ──
    await page.waitForTimeout(1500) // let the scene's models load before Play
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.store.getState().running === true, undefined, { timeout: 10000, polling: 500 })

    const status = await page.evaluate(() => {
      const s = window.__oip.controller.programStatus
      return { attached: s.attached, error: s.error, warnings: s.warnings, driven: window.__oip.controller.plcDrivenKeys.size }
    })
    check('the program attached', status.attached && !status.error, String(status.error))
    check('and it DRIVES devices (this is what "nothing runs" looked like)', status.driven > 0, `${status.driven} driven tags`)
    check('so no "drives no device" warning is raised', status.warnings.length === 0, status.warnings.join(' | '))

    const motion = await maxCargoTravel(page)
    check('the demo\'s hand-fed trailer bed was found (so it can be left out of both arms)', motion.handFed > 0, `${motion.handFed} bodies first seen on it`)
    check('the line actually runs (cargo travels)', motion.travel > TRAVEL_M, `${motion.travel.toFixed(2)} m across ${motion.cargo - motion.handFed} bodies off the trailer bed`)

    await page.evaluate(() => window.__oip.controller.stop())

    // ── 5. negative control: the same layout with its program stripped is what a broken exporter
    // produces. Assert it looks broken; otherwise the checks above could pass vacuously and this
    // gate would keep saying ALL PASS after a regression. Also covers the "drives no device" warning.
    const stripped = JSON.stringify({ ...doc, stProgram: undefined, stScanMs: undefined })
    await page.evaluate(() => localStorage.clear())
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await waitForApp(page)
    const strippedErr = await openSceneFile(page, stripped, 'stripped.json')
    check('[control] the stripped file opens too', strippedErr === null && (await page.evaluate(() => window.__oip.store.getState().projectName)) === 'stripped', String(strippedErr))
    await page.waitForTimeout(1500)
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.store.getState().running === true, undefined, { timeout: 10000, polling: 500 })
    const dead = await page.evaluate(() => ({
      driven: window.__oip.controller.plcDrivenKeys.size,
      warnings: window.__oip.controller.programStatus.warnings,
    }))
    const deadMotion = await maxCargoTravel(page)
    check('[control] a layout with no program drives nothing', dead.driven === 0, `${dead.driven} driven tags`)
    check(
      '[control] and SAYS so instead of failing silently',
      dead.warnings.some((w) => w.includes('hand control')),
      dead.warnings.join(' | ') || '(no warning)',
    )
    check(
      '[control] and the line does not run - so the checks above are not vacuous',
      deadMotion.travel < TRAVEL_M,
      `${deadMotion.travel.toFixed(2)} m across ${deadMotion.cargo - deadMotion.handFed} bodies off the trailer bed`,
    )
    await page.evaluate(() => window.__oip.controller.stop())
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  vite.kill()
  process.exit(1)
})
