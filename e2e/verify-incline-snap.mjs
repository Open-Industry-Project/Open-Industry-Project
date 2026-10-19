// Verify a flat roller conveyor snapped end-to-end onto an inclined roller's head seats exactly on it.
// An inclined straight pivots about its bed centre, so its head sits (L/2)·cos out in plan and (L/2)·sin up.
// Ends reported as if it were flat park the neighbour a few cm too far out and a third of a metre too low,
// leaving every incline junction to be lined up by hand (docs/conveyor-incline.md).
// This drives the real editor path: Shift+G reposition of the flat roller onto the incline's head, then reads
// the committed pose, and checks its legs regrew to the floor at the raised height.
// Run: node e2e/verify-incline-snap.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

const TILT = 15
const L_INCLINE = 3
const L_FLAT = 2
const DECK_Y = 2
const rad = (TILT * Math.PI) / 180
const HEAD = { x: (L_INCLINE / 2) * Math.cos(rad), y: DECK_Y + (L_INCLINE / 2) * Math.sin(rad) }

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

    // a real SDK roller (full valid params incl. standHeight) from its isolated edit scene; then the incline
    // (target) centred at the origin on a 2 m deck, and the flat mover off past its head at the same deck height
    await page.evaluate(() => window.__oip.store.enterPackageEdit('oip.roller-conveyor'))
    await page.waitForTimeout(2500)
    const setup = await page.evaluate(([tilt, lInc, lFlat, deckY]) => {
      const st = window.__oip.store
      const src = st.getState().scene.parts.find((p) => p.packageId === 'oip.roller-conveyor')
      if (!src) return { ok: false }
      const mk = (id, pos, params) => ({ ...src, id, position: pos, rotationY: 0, params: { ...src.params, ...params } })
      const incline = mk('incline', [0, deckY, 0], { length: lInc, tiltDeg: tilt, standHeight: deckY })
      const flat = mk('flat', [4, deckY, 0], { length: lFlat, tiltDeg: 0, standHeight: deckY })
      st.loadScene({ version: st.getState().scene.version, parts: [incline, flat] }, { persist: false })
      st.select('flat')
      return { ok: true }
    }, [TILT, L_INCLINE, L_FLAT, DECK_Y])
    check('incline + flat roller loaded, flat selected', setup.ok)
    await page.waitForTimeout(1200)

    // Shift+G reposition: the part goes where the cursor ray meets the floor, stood its standHeight above it
    // (controller restUnderCursor), so aim at the floor point under where the flat roller's centre belongs, 0.2 m
    // clear of the incline's head; the end-to-end snap then lifts it and seats its back end on the head.
    // the editor eases the camera onto a freshly loaded scene: wait until it stops, or the screen point computed
    // here is stale by the time the gesture reads it (it drifted ~100 px in 1.5 s)
    await page.waitForFunction(() => {
      const c = window.__oip.view.camera.position
      const key = `${c.x.toFixed(4)},${c.y.toFixed(4)},${c.z.toFixed(4)}`
      const w = window
      const same = w.__camKey === key
      w.__camKey = key
      return same
    }, null, { polling: 400, timeout: 15000 })
    const junction = await worldToScreen(page, HEAD.x + L_FLAT / 2 + 0.2, 0, 0)
    check('junction point is on screen', junction.inside, `x=${junction.x.toFixed(0)} y=${junction.y.toFixed(0)}`)
    await page.mouse.move(junction.x, junction.y, { steps: 4 })
    await page.waitForTimeout(80)
    await page.keyboard.down('Shift')
    await page.keyboard.press('g')
    await page.keyboard.up('Shift')
    await page.waitForTimeout(100)
    check('entered reposition gesture', await page.evaluate(() => !!window.__oip.controller.reposition))
    await page.mouse.move(junction.x + 15, junction.y, { steps: 6 })
    await page.waitForTimeout(120)
    await page.mouse.move(junction.x, junction.y, { steps: 6 })
    await page.waitForTimeout(150)
    await page.mouse.down(); await page.mouse.up()
    await page.waitForTimeout(250)

    const res = await page.evaluate(() => {
      const p = window.__oip.store.getState().scene.parts.find((q) => q.id === 'flat')
      return p ? { x: p.position[0], y: p.position[1], z: p.position[2], rot: p.rotationY, standHeight: p.params?.standHeight ?? null } : null
    })
    console.log(`flat roller after snap: pos=(${res?.x?.toFixed(4)}, ${res?.y?.toFixed(4)}, ${res?.z?.toFixed(4)}) rot=${res?.rot?.toFixed(4)} standHeight=${res?.standHeight}`)
    // its back end (x - L/2, flat) must sit on the incline's head: same plan point, same height
    const backX = res ? res.x - L_FLAT / 2 : NaN
    check('flat roller\'s back end sits on the incline head in plan', res && Math.abs(backX - HEAD.x) < 1e-3 && Math.abs(res.z) < 1e-3, `back end x=${backX.toFixed(4)}, head x=${HEAD.x.toFixed(4)}`)
    check('...and at the head\'s height, raised (L/2)·sin above the incline\'s centre', res && Math.abs(res.y - HEAD.y) < 1e-3, `y=${res?.y?.toFixed(4)}, head y=${HEAD.y.toFixed(4)}`)
    check('its legs regrew to the floor at the raised height', res && res.standHeight !== null && Math.abs(res.standHeight - res.y) < 0.15, `standHeight=${res?.standHeight}, deck y=${res?.y?.toFixed(3)}`)

    check('no uncaught page errors', errors.filter((e) => !/favicon|manifest/i.test(e)).length === 0, errors.slice(0, 2).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
}

main()
  .then(() => process.exit(failed ? 1 : 0))
  .catch((e) => { console.error('verify-incline-snap crashed:', e); process.exit(2) })
