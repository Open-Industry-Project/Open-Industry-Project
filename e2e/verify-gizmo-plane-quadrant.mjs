// Verify the translate plane pads follow the camera quadrant:
// the XZ ground pad must sit on the side of the gizmo the camera is on, so it is never parked
// behind the part it moves. Orbits the camera through all four XZ quadrants and asserts the 'xz'
// handle picks in the near quadrant and not in the opposite one, then shoots the two extremes.
// Run: node e2e/verify-gizmo-plane-quadrant.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim), { timeout: 20000 })
}

/** put the camera on the (sx, sz) side of the part, looking at it from above */
async function orbitTo(page, sx, sz) {
  await page.evaluate(
    ([sx, sz]) => {
      const v = window.__oip.view
      const c = v.gizmo.root.position // orbit the gizmo, not the part origin (a belt's is its tail)
      v.setCameraPose({ px: c.x + sx * 4, py: c.y + 4, pz: c.z + sz * 4, tx: c.x, ty: c.y, tz: c.z })
    },
    [sx, sz],
  )
  // setCameraPose animates the camera (focusAnim) - reading the pads mid-flight reads the old quadrant
  await page.waitForFunction(() => !window.__oip.view.focusAnim, { timeout: 8000 })
  await page.waitForTimeout(200)
}

/**
 * Does the 'xz' pad pick in the (sx, sz) quadrant? Projects the pad's world centre for that
 * quadrant off the live gizmo root (its position/orientation/screen scale are the truth about
 * where the handle is) and asks the view what handle sits there, with a few px of slack.
 */
async function padPicksIn(page, sx, sz) {
  return page.evaluate(
    ([sx, sz]) => {
      const v = window.__oip.view
      const g = v.gizmo.root // runtime access: the e2e harness is plain JS, TS privacy is compile-time
      const s = g.scale.x
      const local = { x: sx * 0.42 * s, y: 0, z: sz * 0.42 * s }
      // gizmo-local -> world (root carries the part's yaw in local space; identity in global)
      const q = g.quaternion
      const p = new (Object.getPrototypeOf(g.position).constructor)(local.x, local.y, local.z)
      p.applyQuaternion(q).add(g.position)
      const c = v.worldToScreen(p.x, p.y, p.z)
      if (!c) return { hit: false, reason: 'pad centre did not project' }
      for (let r = 0; r <= 6; r += 2) {
        for (let a = 0; a < 360; a += 45) {
          const x = c.x + r * Math.cos((a * Math.PI) / 180)
          const y = c.y + r * Math.sin((a * Math.PI) / 180)
          if (v.pickGizmoHandle(x, y) === 'xz') return { hit: true, x: Math.round(x), y: Math.round(y) }
          if (r === 0) break
        }
      }
      return { hit: false, at: `${Math.round(c.x)},${Math.round(c.y)}` }
    },
    [sx, sz],
  )
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && !benign(m.text()) && errors.push(m.text()))
  const failures = []

  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.waitForTimeout(1800)

    // one belt at the origin, selected, move tool -> the translate pads are live
    const sel = await page.evaluate(() => {
      const { store, getPackage } = window.__oip
      const pkg = getPackage('oip.belt-conveyor')
      if (!pkg) return { ok: false, reason: 'oip.belt-conveyor not registered' }
      const params = {}
      for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
      store.loadScene({
        version: store.getState().scene.version,
        parts: [{ id: 'belt1', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.5, 0], rotationY: 0, name: 'belt1', params }],
        packages: [pkg],
      })
      store.setSpace('global')
      store.setTool('move')
      store.select('belt1')
      return { ok: true, count: store.getState().scene.parts.length }
    })
    console.log('scene:', JSON.stringify(sel))
    if (!sel.ok) throw new Error(sel.reason)
    await page.waitForTimeout(1200)

    for (const [sx, sz] of [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ]) {
      await orbitTo(page, sx, sz)
      const near = await padPicksIn(page, sx, sz)
      const far = await padPicksIn(page, -sx, -sz)
      const ok = near.hit && !far.hit
      console.log(
        `camera ${sx > 0 ? '+X' : '-X'}/${sz > 0 ? '+Z' : '-Z'}: near quadrant ${near.hit ? `PICKS xz @${near.x},${near.y}` : 'MISS'} · far quadrant ${far.hit ? 'PICKS xz (should not)' : 'empty'} -> ${ok ? 'OK' : 'FAIL'}`,
      )
      if (!ok) failures.push(`camera ${sx},${sz}: near=${near.hit} far=${far.hit}`)
    }

    // Not cleanShot here: it deselects to strip the overlays, and the gizmo is the subject.
    // Clip to the canvas instead, which is all the docks would have cost us anyway.
    const shoot = async (path) => {
      const box = await page.locator('canvas').first().boundingBox()
      await page.screenshot({ path, clip: box })
    }
    await orbitTo(page, 1, 1)
    await shoot('e2e/shots/gizmo-plane-quadrant-pos.png')
    await orbitTo(page, -1, -1)
    await shoot('e2e/shots/gizmo-plane-quadrant-neg.png')
    console.log('shots -> e2e/shots/gizmo-plane-quadrant-{pos,neg}.png')
  } finally {
    await browser.close()
    vite.kill()
  }

  if (errors.length) console.log('page errors:', errors.slice(0, 5))
  if (failures.length) {
    console.log(`FAIL (${failures.length}):`, failures.join(' | '))
    process.exit(1)
  }
  console.log('PASS: the XZ plane pad tracks the camera quadrant in all four orbits')
}

await main()
