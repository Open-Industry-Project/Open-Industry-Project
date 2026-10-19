// Does the roof auto-hide leave the instance pool incoherent, as a roofVisible param flip would
// without a structure bump?
//
// The param path bumps structureVersion on a visibility flip (building.ts apply), so
// view.poolRebuildOnStructureSettled re-pools the gained meshes. The auto-hide path (building.ts
// viewTick) flips the same roofObj.visible from a per-frame camera check and notifies only the
// bundle, so by the same mechanism the pool's bake signature should go stale when the camera
// crosses the eave/pitch threshold.
//
// This measures whether that is a second instance of the bug or a non-issue: fly the camera above
// the roof pitched down, let it settle, and run the same audit the gate runs. A probe, not a gate:
// the fix (bumping structure from a per-frame camera callback) costs a full pool rebuild per
// crossing, a perf decision that needs its own measurement.
/* global process, console, window, localStorage */
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'

const { port, vite } = await startServer()
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu'] })
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.goto(`http://localhost:${port}/app/?scene=demo`, { timeout: 90000 })
  await page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 60000 })
  await page.waitForTimeout(3000)

  // Poll for convergence, like verify-merge-coherence's audit(). The signature is legitimately
  // stale for a frame or two after any action, so a single sample reports a false failure, even on a
  // freshly loaded scene. What matters is whether it settles.
  const audit = async (deadlineMs = 6000) => {
    const started = Date.now()
    for (;;) {
      await page.waitForTimeout(300)
      const r = await page.evaluate(() => window.__oip.view.auditMergeCoherence())
      if (r.ok || Date.now() - started > deadlineMs) {
        return { ok: r.ok, failed: (r.checks ?? []).filter((c) => !c.ok).map((c) => c.name).join(',') || '-' }
      }
    }
  }
  // roof visibility, read from the auto-hide flag building.ts viewTick writes rather than by
  // guessing an object name (a guessed name returns null)
  const roofState = () =>
    page.evaluate(() => {
      const out = []
      for (const e of window.__oip.view.entries.values()) {
        if (e.part.type !== 'building') continue
        e.visual.object.traverse((o) => { if (o.children.length && o.name) out.push(`${o.name}:${o.visible}`) })
      }
      return out.slice(0, 8).join(' ')
    })

  console.log("baseline           :", JSON.stringify(await audit()))

  // fly above the eave, pitched steeply down - the auto-hide condition (building.ts viewTick)
  await page.evaluate(() => {
    const v = window.__oip.view
    v.camera.position.set(0, 40, 0.1)
    v.camera.lookAt(0, 0, 0)
    v.controls?.target?.set(0, 0, 0)
  })
  await page.waitForTimeout(2500) // let viewTick flip the roof and the epoch settle
  console.log('roof visible now   :', await roofState())
  console.log('after auto-HIDE    :', JSON.stringify(await audit()))

  // drop back down so the roof auto-shows again - the "gained meshes" direction
  await page.evaluate(() => {
    const v = window.__oip.view
    v.camera.position.set(30, 3, 30)
    v.camera.lookAt(0, 2, 0)
    v.controls?.target?.set(0, 2, 0)
  })
  await page.waitForTimeout(2500)
  console.log('roof visible now   :', await roofState())
  console.log('after auto-SHOW    :', JSON.stringify(await audit()))
} finally {
  await browser.close()
  vite.kill()
}
