// Inside the known gap: promoting a box costs ~6-9 ms of view.syncScene, and that cost grows with the
// scene. What inside it? CPU profile of a promotion, restricted to the samples between a marker and
// the end of the gesture, rolled up by function. Dev server, not prod: the prod bundle is minified,
// and attribution is the point here, not absolute ms.
// Run: node e2e/probes/syncscene-profile.mjs [dups]
/* global process, console, window, localStorage, performance */
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'

const DUPS = Number(process.argv[2] ?? 1)
const { port, vite } = await startServer()
const browser = await chromium.launch({
  headless: false,
  args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion', '--disable-renderer-backgrounding'],
})

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.goto(`http://localhost:${port}/app/?scene=demo&nowebgpu`)
  await page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 60000 })
  await page.waitForFunction(() => window.__oip.view.stagedReveal === false, { timeout: 45000 })
  await page.waitForTimeout(2500)

  for (let i = 0; i < DUPS; i++) {
    await page.evaluate(() => {
      const store = window.__oip.store
      store.selectMany(store.getState().scene.parts.filter((p) => p.type === 'part' && !/^oip\.(box|pallet)$/.test(p.packageId ?? '')).map((p) => p.id))
      store.duplicateSelection()
      store.clearSelection()
    })
    await page.waitForTimeout(4000)
  }
  const parts = await page.evaluate(() => window.__oip.store.getState().scene.parts.length)
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => {
    const b = window.__oip.view.boxes
    return b.boxMeta.some((m) => !m.partId)
  }, { timeout: 40000 })
  await page.waitForTimeout(3000)

  // Wrap the seams syncScene runs through and time them directly - more reliable than a CPU
  // profile with a marker, and it attributes to the code's own structure. resolveScene is a module
  // function (not patchable from out here), so it shows up as the REMAINDER.
  await page.evaluate(() => {
    const view = window.__oip.view
    const t = {}
    window.__oipT = t
    const wrap = (obj, name, label) => {
      const orig = obj?.[name]?.bind(obj)
      if (!orig) return
      obj[name] = (...a) => {
        const t0 = performance.now()
        const r = orig(...a)
        t[label] = +((t[label] ?? 0) + (performance.now() - t0)).toFixed(2)
        return r
      }
    }
    wrap(view, 'syncScene', 'syncScene TOTAL')
    wrap(view, 'poolRebuild', 'poolRebuild')
    wrap(view, 'refreshOutline', 'refreshOutline')
    wrap(view, 'applyIdleCargoFrame', 'applyIdleCargoFrame')
    wrap(view, 'refreshTickRegistries', 'refreshTickRegistries')
    wrap(view, 'syncMatrixFreeze', 'syncMatrixFreeze')
    wrap(view.instancePool, 'rebuild', 'pool.rebuild')
    wrap(view.instancePool, 'tryUpdateParts', 'pool.tryUpdateParts')
    wrap(view.maskMerge ?? {}, 'setMembership', 'maskMerge.setMembership')
    wrap(view.boxes, 'setSelectionTiers', 'boxes.setSelectionTiers')
  })

  const promote = async () => {
    await page.evaluate(() => { for (const k of Object.keys(window.__oipT)) delete window.__oipT[k] })
    await page.evaluate(() => {
      const boxes = window.__oip.view.boxes
      for (const mesh of [boxes.mesh, boxes.palletMesh]) {
        const meta = mesh === boxes.mesh ? boxes.boxMeta : boxes.palletMeta
        for (let i = 0; i < meta.length; i++) {
          if (meta[i].partId) continue
          const m = mesh.instanceMatrix.array
          const o = i * 16
          const id = window.__oip.controller.promoteCargoBox({
            frameId: meta[i].id, partId: null,
            position: [m[o + 12], m[o + 13], m[o + 14]], rotationY: 0,
            size: [0.4, 0.3, 0.3], color: [0.8, 0.6, 0.4],
          })
          if (id) window.__oip.store.select(id)
          return
        }
      }
    })
    await page.waitForTimeout(500)
    return page.evaluate(() => ({ ...window.__oipT }))
  }

  console.log(`\nscene = ${parts} parts - synchronous ms per seam, per promoting click\n`)
  for (let i = 0; i < 3; i++) {
    const t = await promote()
    const total = t['syncScene TOTAL'] ?? 0
    const known = Object.entries(t).filter(([k]) => k !== 'syncScene TOTAL').reduce((a, [, v]) => a + v, 0)
    const rows = Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')
    console.log(` #${i + 1} ${rows}   [remainder (resolveScene + entry loop) = ${(total - known).toFixed(2)}ms]`)
    await page.waitForFunction(() => window.__oip.view.boxes.boxMeta.some((m) => !m.partId), { timeout: 20000 }).catch(() => {})
  }
} finally {
  await browser.close()
  vite.kill()
}
