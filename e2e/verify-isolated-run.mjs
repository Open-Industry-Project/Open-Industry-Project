// Verify a part can be run in its own isolated scene to test it: pressing Play inside a part scene runs
// only that part (the factory's spawner is excluded, so no boxes spawn underneath), and leaving the part
// scene while running stops the sim. controller.boxCount is the live spawned-box count from each sim frame.
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
const { url: URL, vite } = await startServer()
const log = (...a) => console.log(...a)

const snap = (page) => page.evaluate(() => ({
  running: window.__oip.store.getState().running,
  boxCount: window.__oip.controller.boxCount,
  focusedPartId: window.__oip.store.getState().focusedPartId,
  packageEdit: window.__oip.store.getState().packageEdit?.packageId ?? null,
}))

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push('PAGEERR ' + String(e)))
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const results = {}
  try {
    await page.goto(URL)
    await page.waitForSelector('.viewport canvas', { timeout: 25000 })
    await page.waitForFunction(() => {
      const h = window.__oip
      const b = h?.store?.getState().bundledPackages?.[0]
      return !!(b && h.getPackage && h.getPackage(b.id))
    }, { timeout: 25000 })

    // factory scene: a free-running SDK box spawner (no conveyorId/runTag gate → spawns on its own)
    const pkgId = await page.evaluate(() => {
      const store = window.__oip.store
      store.loadScene({
        version: store.getState().scene.version,
        parts: [
          { id: 'sp_1', type: 'part', packageId: 'oip.box-spawner', position: [0, 2.2, 0], rotationY: 0,
            params: { boxesPerMinute: 600, fixedRate: true, boxColor: '#ffffff', boxColors: '', randomColors: false, mass: 10, randomSize: false, disable: false } },
        ],
        packages: [window.__oip.getPackage('oip.box-spawner')],
      })
      return store.getState().bundledPackages[0].id
    })

    // (1) sanity: running the full factory spawns boxes
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForTimeout(2500)
    const full = await snap(page)
    log('FULL run: running =', full.running, '| boxCount =', full.boxCount)
    results.factorySpawns = full.running === true && full.boxCount > 0
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(600)
    const stopped = await snap(page)
    log('after Stop: running =', stopped.running, '| boxCount =', stopped.boxCount)

    // (2) open a part scene (six-axis robot, unplaced) and Play - runs isolated, no factory spawner
    await page.evaluate((id) => window.__oip.controller.editPartPackage(id), pkgId)
    await page.waitForTimeout(400)
    const inPart = await snap(page)
    log('\nin part scene: focused =', inPart.focusedPartId, '| package =', inPart.packageEdit)
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForTimeout(2500)
    const iso = await snap(page)
    log('ISOLATED run: running =', iso.running, '| boxCount =', iso.boxCount, '(should be 0 - spawner excluded)')
    results.isolatedRuns = iso.running === true
    results.noFactoryBoxes = iso.boxCount === 0

    // (3) leaving the part scene while running stops the sim (don't drop back into a running factory)
    // The way back out is the part-focus breadcrumb OR the package-edit scope button, depending on which
  // scope the run opened (this one lands in package edit: focused=pt_1, package=oip.six-axis-robot).
  await page.locator('.scene-breadcrumb, .scene-def-scope-back').first().click()
    await page.waitForTimeout(600)
    const afterBack = await snap(page)
    log('\nBack while running: running =', afterBack.running, '| focused =', afterBack.focusedPartId, '| boxCount =', afterBack.boxCount)
    results.exitStops = afterBack.running === false && afterBack.focusedPartId === null

    // (4) the full factory still runs normally afterwards
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForTimeout(2500)
    const full2 = await snap(page)
    log('FULL run again: running =', full2.running, '| boxCount =', full2.boxCount)
    results.factoryStillWorks = full2.running === true && full2.boxCount > 0
    await page.evaluate(() => window.__oip.controller.stop())

    const realErrors = errors.filter((e) => !/GLTFLoader|Couldn't load texture|texture/i.test(e))
    log('\n=== SUMMARY ===')
    log('1. full factory spawns boxes when run (sanity):', results.factorySpawns)
    log('2. Play inside a part scene RUNS the sim:', results.isolatedRuns)
    log('3. ...with NO factory boxes (spawner excluded - the fix):', results.noFactoryBoxes)
    log('4. leaving the part scene while running STOPS the sim:', results.exitStops)
    log('5. full factory still runs normally afterwards:', results.factoryStillWorks)
    log('console errors (excl. texture noise):', realErrors.length ? JSON.stringify(realErrors.slice(0, 8)) : 'NONE')
    const pass = results.factorySpawns && results.isolatedRuns && results.noFactoryBoxes && results.exitStops && results.factoryStillWorks && realErrors.length === 0
    log('\nOVERALL:', pass ? 'PASS' : 'FAIL')
    if (!pass) process.exitCode = 1
  } finally { await browser.close(); vite.kill() }
}
main().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(1) })
