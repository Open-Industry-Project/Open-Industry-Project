// Verify a conveyor snapped end-to-end onto an elevated neighbour regrows its legs to the floor.
// Placement/reposition snap raises the mover's deck to the target conveyor's belt height (a
// non-default floor plane); if it does not also re-resolve the rest:'surfaceBelow' param (standHeight),
// the legs keep their pre-snap length and float above the floor. This checks placement and reposition
// (the drag path re-rests too). Run: node e2e/verify-snap-elevated-legs.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim && window.__oip.controller), { timeout: 20000 })
}

let failed = false
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed = true
}

async function worldToScreen(page, x, y, z) {
  return page.evaluate(([wx, wy, wz]) => {
    const v = window.__oip.view
    const cam = v.camera
    cam.updateMatrixWorld(true)
    const p = cam.position.clone().set(wx, wy, wz).project(cam)
    const rect = v.renderer.domElement.getBoundingClientRect()
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height, inside: p.z < 1 && Math.abs(p.x) < 0.95 && Math.abs(p.y) < 0.95 }
  }, [x, y, z])
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.evaluate(() => window.localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1500)
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click().catch(() => {})
    await page.waitForTimeout(300)

    // Grab a real SDK belt part (full valid params incl. standHeight) from its isolated edit scene, then
    // build a two-conveyor scene: B (target) raised to a 3 m deck with legs to the floor; A (mover) on the
    // floor just past B's head end. Both run along +X from their tail origin (B deck x∈[0,4]).
    await page.evaluate(() => window.__oip.store.enterPackageEdit('oip.belt-conveyor'))
    await page.waitForTimeout(2500)
    const setup = await page.evaluate(() => {
      const st = window.__oip.store
      const src = st.getState().scene.parts.find((p) => p.packageId === 'oip.belt-conveyor')
      if (!src) return { ok: false }
      const mk = (id, pos, standHeight) => ({ ...src, id, position: pos, rotationY: 0, params: { ...src.params, standHeight } })
      const B = mk('belt_target', [0, 3, 0], 3)
      const A = mk('belt_mover', [5.5, 2, 0], 2) // to the right of B's head, at floor belt height
      st.loadScene({ version: st.getState().scene.version, parts: [B, A] }, { persist: false })
      st.select('belt_mover')
      return { ok: true, aStand0: A.params.standHeight, aY0: A.position[1] }
    })
    check('two SDK belts loaded + mover selected', setup.ok, `mover start standHeight=${setup.aStand0}, y=${setup.aY0}`)
    await page.waitForTimeout(1200)

    // Reposition (Shift+G, no Alt → surface snap on) the mover toward B's head end. Cursor just past B's
    // head at floor level; the end-to-end snap butts the mover to B and lifts its deck to y≈3.
    const junction = await worldToScreen(page, 4.3, 0, 0)
    check('junction point is on screen', junction.inside, `x=${junction.x.toFixed(0)} y=${junction.y.toFixed(0)}`)
    await page.mouse.move(junction.x, junction.y, { steps: 4 })
    await page.waitForTimeout(80)
    await page.keyboard.down('Shift')
    await page.keyboard.press('g')
    await page.keyboard.up('Shift')
    await page.waitForTimeout(100)
    check('entered reposition gesture', await page.evaluate(() => !!window.__oip.controller.reposition))
    // nudge toward the junction so the snap engine engages against B's head
    await page.mouse.move(junction.x - 15, junction.y, { steps: 6 })
    await page.waitForTimeout(120)
    await page.mouse.move(junction.x, junction.y, { steps: 6 })
    await page.waitForTimeout(150)
    await page.mouse.down(); await page.mouse.up()
    await page.waitForTimeout(200)

    const res = await page.evaluate(() => {
      const p = window.__oip.store.getState().scene.parts.find((q) => q.id === 'belt_mover')
      return { y: p?.position?.[1] ?? null, standHeight: p?.params?.standHeight ?? null }
    })
    console.log(`mover after snap: deck y=${res.y}, standHeight=${res.standHeight}`)

    // The mover snapped up to B's ~3 m deck...
    check('mover snapped up to the elevated deck (y ≈ 3)', res.y !== null && res.y > 2.5, `y=${res.y}`)
    // ...and its standHeight regrew to match the deck height so the legs reach the floor (deck y − floor 0).
    // If it stays at the pre-snap 2.0 while the deck sits at 3, the legs float ~1 m off the floor.
    const reaches = res.standHeight !== null && Math.abs(res.standHeight - res.y) < 0.15
    check('legs reach the floor: standHeight ≈ deck height', reaches, `standHeight=${res.standHeight}, deckY=${res.y}`)

    // --- Phase 2: placement snap (drag-from-catalog) onto the same elevated B ---
    // Reset to just the elevated B, then place a fresh belt whose ghost snaps to B's head end. Placement
    // builds the part off-scene, so its surfaceBelow re-rest must still resolve the floor under the ghost.
    await page.evaluate(() => {
      const st = window.__oip.store
      const B = st.getState().scene.parts.find((p) => p.id === 'belt_target')
      st.loadScene({ version: st.getState().scene.version, parts: [B] }, { persist: false })
      // enter placing directly: mirror beginCatalogPlace (which the catalog card calls) by priming the
      // controller's pendingPackageId + the store's placing mode, so a canvas click builds the ghost + places.
      window.__oip.controller.pendingPackageId = 'oip.belt-conveyor'
      st.startPlacing('part', 'oip.belt-conveyor')
    })
    await page.waitForTimeout(400)
    const j2 = await worldToScreen(page, 4.3, 0, 0)
    check('placement junction on screen', j2.inside, `(${j2.x.toFixed(0)},${j2.y.toFixed(0)})`)

    // WYSIWYG: hover so the ghost snaps to B's raised end, then read the live preview's standHeight: it must
    // already reach the floor (≈ deck height), not float, before the click commits.
    await page.mouse.move(j2.x, j2.y, { steps: 8 })
    await page.waitForTimeout(250)
    const ghost = await page.evaluate(() => {
      const g = window.__oip.controller.placingPreview?.part
      return g && g.position[1] > 2.5 ? { y: g.position[1], standHeight: g.params?.standHeight } : null
    })
    console.log(`ghost preview at junction: deck y=${ghost?.y}, standHeight=${ghost?.standHeight}`)
    const ghostReaches = ghost && Math.abs(ghost.standHeight - ghost.y) < 0.15
    check('GHOST legs reach the floor in the preview: standHeight ≈ deck height', ghostReaches, `standHeight=${ghost?.standHeight}, deckY=${ghost?.y}`)

    // click to place; the ghost preview can race the pointer, so retry a couple times until a part is placed
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(j2.x, j2.y, { steps: 8 })
      await page.waitForTimeout(200)
      await page.mouse.down(); await page.mouse.up()
      await page.waitForTimeout(250)
      const n = await page.evaluate(() => window.__oip.store.getState().scene.parts.length)
      if (n > 1) break
    }
    const placed = await page.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts.filter((p) => p.packageId === 'oip.belt-conveyor' && p.id !== 'belt_target')
      const p = parts.sort((a, b) => (b.position?.[1] ?? 0) - (a.position?.[1] ?? 0))[0]
      return p ? { y: p.position[1], standHeight: p.params?.standHeight } : null
    })
    console.log(`placed belt after snap: deck y=${placed?.y}, standHeight=${placed?.standHeight}`)
    check('placement snapped the new belt up to the elevated deck (y ≈ 3)', placed && placed.y > 2.5, `y=${placed?.y}`)
    const placedReaches = placed && Math.abs(placed.standHeight - placed.y) < 0.15
    check('placed belt legs reach the floor: standHeight ≈ deck height', placedReaches, `standHeight=${placed?.standHeight}, deckY=${placed?.y}`)

    check('no uncaught page errors', errors.filter((e) => !/favicon|manifest/i.test(e)).length === 0, errors.slice(0, 2).join(' | '))
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  }
}

main()
  .then(() => process.exit(failed ? 1 : 0))
  .catch((e) => { console.error('verify-snap-elevated-legs crashed:', e); process.exit(2) })
