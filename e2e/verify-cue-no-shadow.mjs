// Verify that a translucent cue link casts no shadow. The spawner marker, its drop cone and the
// despawner mouth are ghost volumes (`opacity < 1`, `noCollision`), but three's shadow pass has no
// notion of opacity, so a 25-30%-opaque box casting shadows throws a 100%-opaque silhouette: a hard
// black cube under the spawner and a solid black rectangle under the despawner, painted onto whatever
// they sit over. rig.ts's cue branch sets castShadow=false there (receiveShadow stays on).
// Asserts on the shipped rig.json parts, not a synthetic package, and shoots a before/after pair by
// flipping castShadow back on in-page.
// Run: node e2e/verify-cue-no-shadow.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
import { cleanShot } from './_shot.mjs'

const HEADED = process.argv.includes('--headed')
const { port: PORT, vite } = await startServer()
const waitForApp = (page) => page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim), { timeout: 30000 })

let failed = false
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed = true
}

// A deck to catch the shadow, with the three cue parts floating above it.
const PARTS = [
  { id: 'deck', type: 'part', packageId: 'oip.platform', position: [0, 0, 0], rotationY: 0, params: { length: 10, width: 6, standHeight: 0.6 } },
  { id: 'boxSrc', type: 'part', packageId: 'oip.box-spawner', position: [-2.5, 1.6, 0], rotationY: 0, params: {} },
  { id: 'palSrc', type: 'part', packageId: 'oip.pallet-spawner', position: [0, 1.6, 0], rotationY: 0, params: {} },
  { id: 'sink', type: 'part', packageId: 'oip.despawner', position: [3, 1.0, 0], rotationY: 0, params: {} },
]

// Collect every cue mesh (transparent material, opacity < 1) under the three parts, by part id.
const CUES = `(() => {
  const out = []
  const v = window.__oip.view
  v.scene.traverse((o) => {
    if (!o.isMesh) return
    const m = o.material
    if (!m || Array.isArray(m) || m.transparent !== true || !(m.opacity < 1)) return
    let link = null, part = null
    for (let p = o; p; p = p.parent) {
      if (!link && p.userData.linkName) link = p.userData.linkName
      if (!part && p.userData.partId) part = p.userData.partId
    }
    if (part && ['boxSrc', 'palSrc', 'sink'].includes(part)) out.push({ part, link, cast: o.castShadow, receive: o.receiveShadow, opacity: m.opacity })
  })
  return out
})()`

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ok */ } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().split('\n')[0]))
  try {
    await page.goto(`http://localhost:${PORT}/app/`); await waitForApp(page)
    await page.evaluate(() => window.localStorage.clear())
    await page.reload(); await waitForApp(page); await page.waitForTimeout(2500)
    await page.evaluate((parts) => {
      const store = window.__oip.store
      store.loadScene({ ...store.getState().scene, parts })
      store.setState({ selectedIds: [] })
    }, PARTS)
    await page.waitForTimeout(2500)

    const cues = await page.evaluate(CUES)
    console.log('cue meshes found:', JSON.stringify(cues))
    check('the shipped spawners + despawner expose their cue meshes', cues.length >= 4, `${cues.length} found`)
    check('every translucent cue casts NO shadow', cues.length > 0 && cues.every((c) => c.cast === false), cues.filter((c) => c.cast).map((c) => `${c.part}/${c.link}`).join(',') || 'all clear')
    check('every translucent cue still RECEIVES shadow', cues.length > 0 && cues.every((c) => c.receive === true))
    for (const want of [['boxSrc', 'marker'], ['boxSrc', 'dropCone'], ['palSrc', 'marker'], ['sink', 'mouth']]) {
      check(`  ${want[0]}/${want[1]} present and non-casting`, cues.some((c) => c.part === want[0] && c.link === want[1] && c.cast === false))
    }
    // an opaque link on the same deck part must be unaffected
    const opaqueCasts = await page.evaluate(() => {
      let n = 0, cast = 0
      window.__oip.view.scene.traverse((o) => {
        if (!o.isMesh) return
        const m = o.material
        if (!m || Array.isArray(m) || m.transparent === true) return
        let part = null
        for (let p = o; p; p = p.parent) if (p.userData.partId) { part = p.userData.partId; break }
        if (part !== 'deck') return
        n++; if (o.castShadow) cast++
      })
      return { n, cast }
    })
    check('opaque geometry still casts (no blanket shadow kill)', opaqueCasts.n > 0 && opaqueCasts.cast > 0, `${opaqueCasts.cast}/${opaqueCasts.n} deck meshes cast`)

    const aim = (px, py, pz, tx, ty, tz) => page.evaluate(([a, b, c, d, e, f]) => {
      const v = window.__oip.view
      v.controls.target.set(d, e, f); v.camera.position.set(a, b, c); v.camera.lookAt(v.controls.target); v.controls.update()
    }, [px, py, pz, tx, ty, tz])

    // Low-ish 3/4 view so the deck under the cues fills the frame - that deck is where the bad
    // shadow landed.
    await aim(6.5, 5.0, 8.5, 0.2, 0.9, 0)
    await page.waitForTimeout(600)
    await cleanShot(page, 'e2e/shots/verify-cue-no-shadow-after.png')

    // the "before" shot: flip the cues back to casting and re-shoot the identical frame
    await page.evaluate(() => {
      window.__oip.view.scene.traverse((o) => {
        if (!o.isMesh) return
        const m = o.material
        if (!m || Array.isArray(m) || m.transparent !== true || !(m.opacity < 1)) return
        let part = null
        for (let p = o; p; p = p.parent) if (p.userData.partId) { part = p.userData.partId; break }
        if (['boxSrc', 'palSrc', 'sink'].includes(part)) o.castShadow = true
      })
      window.__oip.view.notifyBundleStructureChanged?.()
    })
    await page.waitForTimeout(800)
    await cleanShot(page, 'e2e/shots/verify-cue-no-shadow-before.png')

    console.log('errors:', errors.length ? errors.slice(0, 8).join(' | ') : 'none')
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close(); vite.kill('SIGTERM')
  }
  console.log(failed ? '\nFAILED' : '\nOK')
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error('verify-cue-no-shadow crashed:', e); process.exit(1) })
