// Gizmo-drag twin of verify-stair-platform-cut.mjs stage 4: dragging stairs to a platform by the
// transform gizmo's X arrow must open the railing and lift the flight live, mid-drag. This includes
// the case where the stairs' edgeMount snap carries a numSteps refit (stairs that don't fit the deck).
// Regression gate for "the rail only opens on commit": moveGizmo/applyPoses must fold the snap
// candidate's paramOverrides into the transient stream. If they apply only the pose, the resolver sees
// a non-fitting flight until onPointerUp's withSnapOverrides. Also gates the reverse: a gizmo drag away
// must clear the cut live. Run: node e2e/verify-stair-gizmo-live-cut.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    const waitApp = () => page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
    await waitApp()
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitApp()
    await page.waitForTimeout(1500)

    // platform (+X edge at x=3, deck 2.4) + stairs facing it from x=10. numSteps 8 does not fit the
    // 2.4 m deck, so the edgeMount snap must carry a steps override (→13). This is the case that regressed.
    const ok = await page.evaluate(() => {
      const store = window.__oip.store
      const platPkg = window.__oip.getPackage('oip.platform')
      const stairPkg = window.__oip.getPackage('oip.stairs')
      if (!platPkg || !stairPkg) return false
      const platform = { id: 'plat', type: 'part', packageId: 'oip.platform', position: [0, 2.4, 0], rotationY: 0, params: { length: 6, width: 5, height: 2.4, showRailings: true, showSupports: true, color: '#f2bd0f' } }
      const stair = { id: 'stair', type: 'part', packageId: 'oip.stairs', position: [10, 0, 0], rotationY: Math.PI, params: { numSteps: 8, width: 1.4, showHandrails: true, color: '#f2bd0f' } }
      const keep = (store.getState().scene.packages ?? []).filter((p) => p.id !== platPkg.id && p.id !== stairPkg.id)
      store.loadScene({ ...store.getState().scene, parts: [platform, stair], packages: [...keep, platPkg, stairPkg] })
      store.setSpace('global')
      store.setTool('move')
      store.select('stair')
      return true
    })
    check('scene loaded (platform + non-fitting stairs)', ok)
    if (!ok) return

    await page.evaluate(() => {
      const v = window.__oip.view
      v.controls.target.set(6, 1, 0); v.camera.position.set(6, 12, 14); v.camera.lookAt(6, 1, 0); v.controls.update()
    })
    await page.waitForTimeout(800)

    // the gizmo world-X translate handle near the stair's origin (px = the stair's current world X)
    const findHandle = (px) => page.evaluate((px) => {
      const { view } = window.__oip
      view.camera.updateMatrixWorld(true)
      const c0 = view.worldToScreen(px, 0, 0)
      const cx = view.worldToScreen(px + 1, 0, 0)
      const dir = { x: cx.x - c0.x, y: cx.y - c0.y }
      const len = Math.hypot(dir.x, dir.y) || 1
      dir.x /= len; dir.y /= len
      let best = null
      for (let r = 8; r <= 260 && !best; r += 4) {
        for (const s of [1, -1]) {
          for (let perp = -18; perp <= 18; perp += 6) {
            const x = c0.x + dir.x * r * s - dir.y * perp
            const y = c0.y + dir.y * r * s + dir.x * perp
            if (view.pickGizmoHandle(x, y) === 'x') { best = { x, y }; break }
          }
          if (best) break
        }
      }
      return best ? { ...best, dir, pxPerMeter: len } : null
    }, px)

    const sample = () => page.evaluate(() => {
      const v = window.__oip.view
      const conn = v.lastResolved?.get?.('plat')?.structConn
      const stair = window.__oip.store.getState().scene.parts.find((p) => p.id === 'stair')
      return {
        open: conn?.platform?.get?.('plat')?.openings?.posX ?? [],
        lift: conn?.stairTopConnected?.get?.('stair') ?? null,
        numSteps: stair ? stair.params.numSteps : null,
        stairX: stair ? +stair.position[0].toFixed(3) : null,
        // the merge-seam ejection (view.poolWTStructural): a cut transition mid-drag must move both
        // participants out of the pool/bundle fast paths. Otherwise the merged/recorded copies keep
        // drawing the pre-cut railing ("only opens on commit", intermittent per gesture)
        ejected: ['plat', 'stair'].filter((id) => v.poolWTStructural?.has?.(id)),
      }
    })

    // drag the X arrow `meters` along ±world-X in steps; returns the last mid-drag sample (pre-release)
    async function gizmoDrag(grab, meters, sign) {
      await page.mouse.move(grab.x, grab.y)
      await page.mouse.down()
      let mid = null
      const steps = 16
      for (let i = 1; i <= steps; i++) {
        const m = (meters * i) / steps
        await page.mouse.move(grab.x + sign * grab.dir.x * m * grab.pxPerMeter, grab.y + sign * grab.dir.y * m * grab.pxPerMeter, { steps: 2 })
        await page.waitForTimeout(50)
        mid = await sample()
      }
      await page.mouse.up()
      await page.waitForTimeout(500)
      return mid
    }

    // --- IN: gizmo-drag toward the platform. The snap engages, refits the flight, and the cut applies live ---
    const grabIn = await findHandle(10)
    check('found X handle at start', !!grabIn)
    if (!grabIn) return
    const midIn = await gizmoDrag(grabIn, 3.4, -1)
    check('mid-drag: snap pinned the stairs to the seat', midIn.stairX !== null && Math.abs(midIn.stairX - 6.64) < 1e-3, `stairX=${midIn.stairX}`)
    check('mid-drag: numSteps refit folded into the transient (8→13)', midIn.numSteps === 13, `numSteps=${midIn.numSteps}`)
    check('mid-drag: railing opens LIVE', midIn.open.length === 1, JSON.stringify(midIn.open))
    check('mid-drag: flight lifts LIVE', midIn.lift !== null, `lift=${midIn.lift}`)
    check('mid-drag: both cut participants ejected from the merge seams', midIn.ejected.length === 2, JSON.stringify(midIn.ejected))
    const committed = await sample()
    check('commit: connection + refit persist', committed.open.length === 1 && committed.lift !== null && committed.numSteps === 13, JSON.stringify(committed))
    const auditIn = await page.evaluate(() => window.__oip.view.auditMergeCoherence())
    check('commit: merge layers coherent (pool bake matches live sources)', auditIn === null || auditIn.ok, auditIn?.reason ?? '')

    // --- OUT: gizmo-drag away. The cut must clear live mid-drag and stay cleared on commit ---
    await page.evaluate(() => window.__oip.store.select('stair'))
    await page.waitForTimeout(300)
    const grabOut = await findHandle(6.64)
    check('found X handle at the seat', !!grabOut)
    if (!grabOut) return
    const midOut = await gizmoDrag(grabOut, 4.0, 1)
    check('mid-drag away: cut clears LIVE', midOut.open.length === 0 && midOut.lift === null, JSON.stringify(midOut))
    const healed = await sample()
    check('commit away: railing stays healed', healed.open.length === 0 && healed.lift === null, JSON.stringify(healed))
    const auditOut = await page.evaluate(() => window.__oip.view.auditMergeCoherence())
    check('commit away: merge layers coherent', auditOut === null || auditOut.ok, auditOut?.reason ?? '')
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
