// Per-sub-step draw attribution inside the consolidated outline pass: wraps renderer.render and
// records the info.render.calls delta of every render invocation in a frame (info.autoReset is
// false and the pass resets once per frame, so deltas are exact), with nothing selected vs one
// box vs one conveyor. Says exactly which mask sub-render owns the +50 draws.
// Run: node e2e/probes/select-mask-substeps.mjs
/* global process, console, window, localStorage, requestAnimationFrame */
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'

const { port, vite } = await startServer()
const browser = await chromium.launch({
  headless: false,
  args: ['--disable-features=CalculateNativeWinOcclusion', '--disable-gpu-vsync'],
})

const probe = (page) =>
  page.evaluate(
    () =>
      new Promise((res) => {
        const view = window.__oip.view
        const r = view.renderer
        const orig = r.render.bind(r)
        const log = []
        r.render = (scene, cam) => {
          const before = r.info.render.calls
          const beforeTris = r.info.render.triangles
          orig(scene, cam)
          log.push({
            scene: scene === view.scene ? 'MAIN' : (scene.name || scene.type),
            children: scene.children.length,
            kids: scene.children.map((c) => c.name || c.type).slice(0, 4).join('+'),
            draws: r.info.render.calls - before,
            tris: r.info.render.triangles - beforeTris,
          })
        }
        // let two frames go by, keep the second
        requestAnimationFrame(() => {
          log.length = 0
          requestAnimationFrame(() => {
            r.render = orig
            res(log)
          })
        })
      }),
  )

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const url = `http://localhost:${port}/app/?scene=demo&nowebgpu`
  await page.goto(url)
  await page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 60000 })
  await page.waitForFunction(() => window.__oip.view.stagedReveal === false, { timeout: 45000 })
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => (window.__oip.controller?.boxCount ?? 0) > 0, { timeout: 30000 })
  await page.waitForTimeout(6000)

  const ids = await page.evaluate(() => {
    const parts = window.__oip.store.getState().scene.parts
    return {
      box: parts.find((p) => p.packageId === 'oip.box')?.id ?? null,
      conveyor: parts.find((p) => /conveyor|belt|roller/i.test(p.packageId ?? ''))?.id ?? null,
    }
  })

  for (const [label, id, hideGizmo] of [
    ['NOTHING selected', null, false],
    ['BOX selected', ids.box, false],
    ['CONVEYOR selected', ids.conveyor, false],
    ['CONVEYOR selected, gizmo root hidden', ids.conveyor, true],
  ]) {
    await page.evaluate((x) => window.__oip.store.select(x), id)
    await page.waitForTimeout(900)
    if (hideGizmo) {
      await page.evaluate(() => { window.__oip.view.gizmo.root.visible = false })
      await page.waitForTimeout(400)
    }
    const log = await probe(page)
    const total = log.reduce((a, b) => a + b.draws, 0)
    console.log(`\n=== ${label} - ${log.length} renderer.render() calls, ${total} draws ===`)
    for (const e of log) {
      console.log(`   ${String(e.draws).padStart(4)} draws ${String(e.tris).padStart(9)} tris   scene=${e.scene} children=${e.children} [${e.kids}]`)
    }
  }
} finally {
  await browser.close()
  vite.kill()
}
