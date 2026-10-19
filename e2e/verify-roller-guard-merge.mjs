// Verify neighbour guard auto-open on the SDK roller conveyor (guards against side guards not opening when a
// conveyor snaps to the side of a roller while the belt's do). Builds a T-junction with a roller host and a
// perpendicular roller butting its +Z side mid-bed, then (1) asserts the host's guardR link split into >=2
// kept-segment meshes (a real gap) while guardL stays one solid wall, and (2) screenshots the junction.
// Run: node e2e/verify-roller-guard-merge.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const OUT = 'e2e/shots/roller-guard-merge.png'

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim), { timeout: 20000 })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.evaluate(() => window.localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1500)
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click().catch(() => {})

    // Host roller A along +X: centre-origin bed x in [-2, 2] (length 4), width 1.524 -> guards at |z| = 0.762.
    // Opener roller B (length 2, narrow width 0.6) turned +90 deg so its discharge end (local x=+1) lands on A's
    // +Z edge at host-local x=0: B_pos = (0, 1.762) since rotateXZ(1,0,pi/2) = (0,-1). A's right (+Z) guard opens
    // a ~0.6 m gap centred at x=0; its LEFT (-Z) guard stays a solid wall.
    const res = await page.evaluate(() => {
      const store = window.__oip.store
      const pkg = (store.getState().bundledPackages ?? []).find((p) => p.id === 'oip.roller-conveyor')
      if (!pkg) return { error: 'no roller pkg' }
      const roller = (id, x, z, rot, length, width) => ({ id, type: 'part', packageId: 'oip.roller-conveyor', position: [x, 2, z], rotationY: rot, params: { length, width, standHeight: 2 } })
      store.loadScene({ version: store.getState().scene.version, parts: [roller('a', 0, 0, 0, 4, 1.524), roller('b', 0, 1.762, Math.PI / 2, 2, 0.6)], packages: [pkg] })
      window.__oip.view.setCameraPose({ px: 6.5, py: 3.6, pz: 5.2, tx: 0, ty: 2.0, tz: 0.6 })
      return { parts: store.getState().scene.parts.length }
    })
    await page.waitForTimeout(1000)

    // Count the split box meshes in the host roller's guardL / guardR link groups (a gap => >=2 kept segments).
    const split = await page.evaluate(() => {
      const view = window.__oip.view
      const host = view.entries?.get?.('a')?.visual?.object
      if (!host) return { error: 'no host visual' }
      const count = (linkName) => {
        let n = -1
        host.traverse((o) => {
          if (o.userData && o.userData.linkName === linkName) {
            n = o.children.filter((c) => c.isMesh && c.scale.x > 0.001).length
          }
        })
        return n
      }
      return { guardL: count('guardL'), guardR: count('guardR') }
    })

    console.log('loadScene ->', JSON.stringify(res))
    console.log('guard split ->', JSON.stringify(split))
    await cleanShot(page, OUT)
    console.log('screenshot ->', OUT)

    const ok = split && split.guardR >= 2 && split.guardL === 1
    console.log(ok ? 'PASS: host roller +Z guard OPENED (split into segments); -Z guard stayed solid' : 'FAIL: guard did not open as expected')
    console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO ERRORS')
    if (!ok) process.exitCode = 1
  } finally {
    await browser.close()
    vite.kill()
  }
}
main()
