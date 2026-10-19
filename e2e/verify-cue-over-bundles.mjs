// A translucent cue (the spawner/despawner marker, rig.ts's `opacity` branch) must tint whatever is
// behind it, not be painted over by it.
//
// The cue is `transparent + depthWrite:false` by design (it occludes nothing), so any opaque draw
// that comes after it paints over it. Under WebGPU, three records render bundles at the top of the
// pass and executes them at the bottom of it, in scene-child order (three.webgpu.js:
// `_renderBundles` -> `renderBundles.push`, `finishRender` -> `executeBundles`), so the relative
// order of two bundle groups is a draw order. With the instance pool's output group mounted after
// view.partsGroup, its merged opaque hardware executes last and draws straight over the marker: the
// infeed conveyor behind the demo's case source draws untinted, and while the scene loads (parts
// entering the pool, structural changes rendering the odd frame unbundled) the two orders alternate,
// a visible flicker behind the marker. Fix: bundleGroups.mountOpaqueBundleGroupFirst.
//
// The assertion compares two renders: the same frame under `?nobundle`
// (no bundles, one correctly-sorted render list) is the ground truth, and the default path must
// match it. A regression that reorders the bundle groups again fails here even if the absolute
// colours shift for unrelated reasons.
//
// Run: node e2e/verify-cue-over-bundles.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
import { cleanShot } from './_shot.mjs'
import sharp from 'sharp'

const { port: PORT, vite } = await startServer()
const OUT = 'e2e/shots'
const HEADED = process.argv.includes('--headed')
// the marker overlaps the infeed conveyor over roughly this fraction of the frame; a punch-through
// moved 1.17% of all pixels, so anything at/above a tenth of that is the bug, not noise
const MAX_DIFF_PCT = 0.1

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: !HEADED, args: ['--enable-unsafe-webgpu'] },
    { headless: !HEADED, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try {
      return await chromium.launch(opts)
    } catch {
      /* next launcher */
    }
  }
  throw new Error('could not launch any Chromium')
}

/** demo scene, parked nose-on to the case-source spawner so its marker overlaps the infeed */
async function shoot(browser, flags, path) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  try {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        /* harmless */
      }
    })
    await page.goto(`http://localhost:${PORT}/app/?scene=demo${flags}`)
    await page.waitForFunction(() => !!(window.__oip?.view && window.__oip.store && window.__oip.sim), null, { timeout: 120000 })
    // Positive settle signals, never a timed wait. Two of them, and the second is what keeps this
    // gate from going vacuous: the artifact only exists once the pool has actually merged the
    // hardware behind the marker, and an early shot (assets quiet, pool not yet rebuilt) draws the
    // per-part copies from the same bundle as the cue and passes no matter what the mount order is.
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 })
    await page.waitForFunction(
      () => {
        const pool = window.__oip.view.scene.children.find((c) => c.userData.instancePoolGroup === true)
        return !pool || pool.children.length > 0 // absent under ?noinstancepool - don't hang there
      },
      null,
      { timeout: 60000 },
    )
    await page.waitForTimeout(1500)
    const framed = await page.evaluate(() => {
      const st = window.__oip.store.getState()
      const v = window.__oip.view
      const sp = st.scene.parts.find((p) => p.packageId === 'oip.box-spawner')
      if (!sp) return { error: 'demo has no box spawner' }
      const w = v.partWorldPosition(sp.id) ?? sp.position
      v.setCameraPose({ px: w[0] + 0.2, py: w[1] + 0.35, pz: w[2] + 2.6, tx: w[0], ty: w[1], tz: w[2] - 3 }, { instant: true })
      return { backend: v.renderer.isWebGPURenderer ? 'WebGPU' : 'WebGL', spawner: sp.name }
    })
    if (framed.error) throw new Error(framed.error)
    await page.waitForTimeout(2000)
    await cleanShot(page, path)
    return framed
  } finally {
    await page.close().catch(() => {})
  }
}

const browser = await launch()
let failed = false
try {
  const a = await shoot(browser, '', `${OUT}/cue-over-bundles.png`)
  const b = await shoot(browser, '&nobundle', `${OUT}/cue-over-bundles-nobundle.png`)
  console.log(`framed ${a.spawner} - default backend=${a.backend}, reference backend=${b.backend} (?nobundle)`)
  if (a.backend !== 'WebGPU') {
    console.log('note: this machine fell back to WebGL, where there are no bundles - the parity check is vacuous here')
  }

  const load = async (p) => await sharp(p).raw().toBuffer({ resolveWithObject: true })
  const def = await load(`${OUT}/cue-over-bundles.png`)
  const ref = await load(`${OUT}/cue-over-bundles-nobundle.png`)
  if (def.data.length !== ref.data.length) throw new Error('shot sizes differ; cannot compare')
  const c = def.info.channels
  const n = def.data.length / c
  let differing = 0
  let max = 0
  for (let i = 0; i < n; i++) {
    const d = Math.max(
      Math.abs(def.data[i * c] - ref.data[i * c]),
      Math.abs(def.data[i * c + 1] - ref.data[i * c + 1]),
      Math.abs(def.data[i * c + 2] - ref.data[i * c + 2]),
    )
    if (d > 12) {
      differing++
      if (d > max) max = d
    }
  }
  const pct = (100 * differing) / n
  console.log(`bundled vs ?nobundle: ${pct.toFixed(3)}% of pixels differ (max channel delta ${max}); budget ${MAX_DIFF_PCT}%`)
  if (pct > MAX_DIFF_PCT) {
    failed = true
    console.log('FAIL: the bundled frame does not match the unbundled one around the spawner marker.')
    console.log('      A bundle group holding opaque merges is executing AFTER the one holding the')
    console.log('      cue - see mountOpaqueBundleGroupFirst in src/render/bundleGroups.ts.')
    console.log(`      Shots: ${OUT}/cue-over-bundles.png vs ${OUT}/cue-over-bundles-nobundle.png`)
  } else {
    console.log('PASS: the cue tints what is behind it on both paths.')
  }
} catch (e) {
  failed = true
  console.log(`FAIL: ${e.message}`)
} finally {
  await browser.close().catch(() => {})
  vite.kill()
}
process.exit(failed ? 1 : 0)
