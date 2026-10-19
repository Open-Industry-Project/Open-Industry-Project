// Cargo with its own body in the app (docs/cargo-bodies.md): the Drum (libraries/containers/drum, built here from its
// source as a project that added it from Containers holds it), a rig declaring `cargo`.
//
//   1. placed drums draw as their own visual through the instanced cargo batches (render/viewport/boxes.ts), not as
//      boxes, both stopped and running, and a lying drum and an upright one share no batch with the boxes
//   2. a Spawner set to the Drum spawns drums as their own shape (the frame names their shape, kind 'part')
//   3. 200 drums draw in the same few batches as 2: placing more drums adds no draws
//
// The physics (a drum rolls where a box slides) is pinned headless in src/sim/cargoBodies.test.ts.
//
//   node e2e/verify-cargo-bodies.mjs [--headed] [--shot <dir>]
/* global window, localStorage, console, process, requestAnimationFrame */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer as createVite } from 'vite'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'

const shotDir = process.argv.includes('--shot') ? process.argv[process.argv.indexOf('--shot') + 1] : null
let failures = 0
const check = (n, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`)
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createVite({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})
const { buildPackage } = await vite.ssrLoadModule('/src/sim/buildPackage.ts')
const drumDir = resolve(repo, 'libraries/containers/drum')
const drumPkg = buildPackage(JSON.parse(readFileSync(resolve(drumDir, 'manifest.json'), 'utf8')), readFileSync(resolve(drumDir, 'behavior.js'), 'utf8'))
await vite.close()

const { port } = await startServer()
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })

/** the cargo batches' state: rows per kind, and how many part shapes and batches exist */
const batches = () =>
  page.evaluate(() => {
    const boxes = window.__oip.view.boxes
    const shapes = [...boxes.partShapes.values()]
    return {
      boxRows: boxes.box.count,
      partShapes: shapes.length,
      partBatches: shapes.reduce((n, s) => n + s.batches.length, 0),
      // every row is written to each of its shape's batches: the first batch's count is the bodies drawn
      partRows: shapes.reduce((n, s) => n + (s.batches[0]?.count ?? 0), 0),
      tinted: shapes.flatMap((s) => s.batches.map((b) => b.tinted)),
    }
  })

/** draws on a quiet main pass (the shadow refresh held off, as verify-instanced-cargo does) */
const mainPassDraws = () =>
  page.evaluate(async () => {
    const view = window.__oip.view
    const env = view.env
    const refresh = env?.refreshKeyShadow
    if (env && refresh) env.refreshKeyShadow = () => {}
    try {
      const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
      for (let i = 0; i < 4; i++) await frame()
      const samples = []
      for (let i = 0; i < 6; i++) {
        await frame()
        samples.push(view.getStats().drawCalls)
      }
      return Math.max(...samples)
    } finally {
      if (env && refresh) env.refreshKeyShadow = refresh
    }
  })

/** replace the scene with these parts (built by createSdkPart in the page), one commit */
const placeDrums = (drums) =>
  page.evaluate((list) => {
    const { store } = window.__oip
    const s = store.getState()
    const pkg = window.__oip.getPackage('oip.drum')
    const parts = list.map((d, i) => ({ id: `drum_${i}`, type: 'part', packageId: pkg.id, name: `Drum ${i}`, position: d.pos, rotationY: 0, ...(d.lying ? { rotationX: Math.PI / 2 } : {}), params: {} }))
    // embedded, as placing a part embeds it: the worker only knows the packages the scene carries
    const packages = [...(s.scene.packages ?? []).filter((p) => p.id !== pkg.id), pkg]
    store.commit('Place drums', { ...s.scene, packages, parts: [...s.scene.parts.filter((p) => !String(p.id).startsWith('drum_')), ...parts] })
  }, drums)

try {
  await page.goto(`http://localhost:${port}/app/`)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  await page.reload()
  await page.waitForFunction(() => window.__oip?.controller && window.__oip.registerPackage, null, { timeout: 120000 })
  await page.evaluate((pkg) => window.__oip.registerPackage(pkg), drumPkg)
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 })

  // ── 1. placed drums draw as their own visual ──────────────────────────────────────────────────────
  await placeDrums([
    { pos: [0, 0.45, 0] },
    { pos: [2, 0.3, 0], lying: true },
  ])
  await page.waitForFunction(() => window.__oip.view.boxes.partShapes.size > 0, null, { timeout: 15000 }).catch(() => {})
  let b = await batches()
  check('stopped: the drums draw through their own shape batches', b.partShapes === 1 && b.partRows === 2, JSON.stringify(b))
  check('stopped: no drum is drawn as a box', b.boxRows === 0, `box rows ${b.boxRows}`)
  check("the drum's paint takes the body's colour, its bare rim does not", b.tinted.includes(true) && b.tinted.includes(false), JSON.stringify(b.tinted))
  if (shotDir) await cleanShot(page, `${shotDir}/drums-stopped.png`)

  await page.evaluate(() => window.__oip.controller.run())
  // a running frame has sim time; the stopped one is built at 0
  await page.waitForFunction(() => (window.__oip.view.boxes.appliedFrame?.simTime ?? 0) > 1.5, null, { timeout: 60000 })
  b = await batches()
  check('running: the drums still draw through their own shape batches', b.partRows === 2 && b.boxRows === 0, JSON.stringify(b))
  if (shotDir) await cleanShot(page, `${shotDir}/drums-running.png`)
  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForTimeout(1500)

  // ── 2. a Spawner set to the Drum spawns drums as their own shape ─────────────────────────────────
  await page.evaluate(() => {
    const { store } = window.__oip
    const s = store.getState()
    const spawner = window.__oip.getPackage('oip.box-spawner')
    const drum = window.__oip.getPackage('oip.drum')
    const packages = [...(s.scene.packages ?? []).filter((p) => p.id !== spawner.id && p.id !== drum.id), spawner, drum]
    const part = { id: 'spawner_1', type: 'part', packageId: spawner.id, name: 'Spawner', position: [-4, 1.2, 0], rotationY: 0, params: { product: 'oip.drum', boxesPerMinute: 60 } }
    store.commit('Add a drum spawner', { ...s.scene, packages, parts: [...s.scene.parts, part] })
  })
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(
    () => {
      const f = window.__oip.view.boxes.appliedFrame
      if (!f || !f.shapes) return false
      for (let i = 0; i < f.count; i++) if (f.partIds[i] === null && f.kinds[i] === 3 && f.shapes[i]) return true
      return false
    },
    null,
    { timeout: 30000 },
  ).then(() => check('a Spawner set to the Drum spawns drums as their own shape', true), () => check('a Spawner set to the Drum spawns drums as their own shape', false, 'no spawned body with a shape'))
  b = await batches()
  check('spawned drums draw with the placed ones, not as boxes', b.partRows > 2 && b.boxRows === 0, JSON.stringify(b))
  if (shotDir) await cleanShot(page, shotDir + '/drums-spawned.png')
  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForTimeout(1500)
  await page.evaluate(() => {
    const { store } = window.__oip
    const s = store.getState()
    store.commit('Remove the spawner', { ...s.scene, parts: s.scene.parts.filter((p) => p.id !== 'spawner_1') })
  })

  // ── 3. many drums, no more draws ──────────────────────────────────────────────────────────────────
  const few = await mainPassDraws()
  await placeDrums(Array.from({ length: 200 }, (_, i) => ({ pos: [(i % 20) * 0.7 - 7, 0.45, Math.floor(i / 20) * 0.7 + 3] })))
  await page.waitForTimeout(1500)
  const many = await mainPassDraws()
  b = await batches()
  check('200 drums draw', b.partRows === 200, `rows ${b.partRows}`)
  check('200 drums cost the draws of 2 (one instanced batch per material)', many - few <= 1, `${few} -> ${many} draws`)
  if (shotDir) await cleanShot(page, `${shotDir}/drums-200.png`)
} catch (e) {
  failures++
  console.log(`FAIL  ${e instanceof Error ? e.message : e}`)
} finally {
  await browser.close()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
