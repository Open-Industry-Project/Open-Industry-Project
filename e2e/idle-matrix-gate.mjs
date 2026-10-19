// Regression gate for the owned world-matrix walk (view.updateWorldMatrices): idle matrix
// cost must scale with what moved, not with what exists. Loads the demo scene, duplicates its
// largest top-level group ×4, and asserts:
//   1. matrixLiveParts stays a small constant: only the building and soft-parent group stubs
//      stay live. A growing number means the freeze regressed.
//   2. no matrix-walk escape errors were logged (dev-mode detector in viewMatrices.ts);
//   3. run-mode motion still reaches the view: while the sim runs, a jointed rig link's
//      matrixWorld changes across frames. A frozen rig that is never re-baked would move in the
//      sim data but not on screen.
// Run: node e2e/idle-matrix-gate.mjs
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const MATRIX_LIVE_SLACK = 4 // headroom over "building + group stubs" - the only things that may stay matrix-live

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/?scene=demo`

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const escapes = []
  page.on('console', (m) => { if (m.text().includes('matrix-walk escapes')) escapes.push(m.text()) })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
  try {
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller), { timeout: 60000 })
    await page.waitForTimeout(10000) // GLBs land, pipelines warm, freeze bakes settle

    // duplicate the demo's largest top-level group ×4 (the duplicate-line idle-CPU scenario). Found by
    // subtree size, not name, so a demo edit that renames groups doesn't break it. The biggest subtree
    // also carries the cargo the >200 fixture check below needs.
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => {
        const store = window.__oip.store
        const parts = store.getState().scene.parts
        const kids = new Map()
        for (const p of parts) if (p.parent) kids.set(p.parent, [...(kids.get(p.parent) ?? []), p.id])
        const size = (id) => (kids.get(id) ?? []).reduce((n, c) => n + 1 + size(c), 0)
        const g = parts.filter((p) => p.type === 'group' && !p.parent).sort((a, b) => size(b.id) - size(a.id))[0]
        if (!g) throw new Error('demo scene has no top-level group')
        store.select(g.id)
        store.duplicateSelection()
        store.clearSelection()
      })
      await page.waitForTimeout(1200)
    }
    await page.waitForTimeout(4000) // let async GLBs of the clones land + re-freeze

    const idle = await page.evaluate(() => {
      const v = window.__oip.view
      // private fields, runtime-accessible: the idle authored-cargo frame + the batch's live counts
      const frame = v.idleCargoFrame
      // cargo renders only through the two instanced batches. A clicked box stays in the batch
      // and is tiered through its aSel channel.
      const parts = window.__oip.store.getState().scene.parts
      return {
        liveParts: v.getStats().matrixLiveParts,
        parts: parts.length,
        groups: parts.filter((p) => p.type === 'group').length,
        buildings: parts.filter((p) => p.type === 'building').length,
        cargoInFrame: frame ? frame.count : -1,
        cargoRendered: v.boxes.mesh.count + v.boxes.palletMesh.count,
      }
    })
    // What may stay live is derived from the scene, not a fixture-tuned constant: the building plus the
    // soft-parent group stubs, and nothing else. A flat limit would encode one scene's group count and need
    // re-tuning on every demo edit (duplicating the current demo's biggest group ×4 carries ~66 group stubs).
    const allowed = idle.groups + idle.buildings + MATRIX_LIVE_SLACK
    console.log(`idle: parts=${idle.parts} matrixLiveParts=${idle.liveParts} (gate: <= groups ${idle.groups} + buildings ${idle.buildings} + ${MATRIX_LIVE_SLACK} = ${allowed})`)
    if (idle.liveParts > allowed) throw new Error(`freeze regressed: ${idle.liveParts} matrix-live parts at idle (expected <= ${allowed} of ${idle.parts} parts)`)
    if (idle.liveParts >= idle.parts / 4) throw new Error(`freeze regressed: ${idle.liveParts} matrix-live of ${idle.parts} parts - idle cost is tracking what EXISTS`)
    // the dup ×4 demo carries 231 authored cargo, more than 200. The batch must grow and render every
    // one of them; the regression this catches is overflow cargo silently not drawn.
    console.log(`idle cargo: frame=${idle.cargoInFrame} rendered=${idle.cargoRendered} (gate: all rendered, > 200)`)
    if (idle.cargoInFrame <= 200) throw new Error(`fixture too small: expected > 200 authored cargo in the idle frame, got ${idle.cargoInFrame}`)
    if (idle.cargoRendered !== idle.cargoInFrame) throw new Error(`cargo overflow regressed: idle frame carries ${idle.cargoInFrame} but the batch renders ${idle.cargoRendered}`)

    // run-mode motion: a jointed rig (the diverter) must move its link matrixWorld while running
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForTimeout(4000) // let cargo reach the devices
    const moved = await page.evaluate(async () => {
      const v = window.__oip.view
      const parts = window.__oip.store.getState().scene.parts
      // any rig part with joints whose visual owns an applyJoints - grab each one's first jointed link
      const candidates = []
      for (const p of parts) {
        const obj = v.entries?.get(p.id)?.visual?.object
        if (!obj || typeof obj.userData.applyJoints !== 'function') continue
        candidates.push(obj)
      }
      const snap = () => candidates.map((o) => { let s = ''; o.traverse((n) => { s += n.matrixWorld.elements.join(',') }); return s })
      const a = snap()
      await new Promise((r) => setTimeout(r, 3000))
      const b = snap()
      let changed = 0
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++
      return { rigs: candidates.length, changed }
    })
    console.log(`run: ${moved.changed}/${moved.rigs} jointed rigs moved their world matrices over 3s`)
    if (moved.rigs > 0 && moved.changed === 0) throw new Error('no jointed rig moved while running - frozen rigs are not re-baking (poseRev seam broken)')
    await page.evaluate(() => window.__oip.controller.stop())

    if (escapes.length > 0) throw new Error(`matrix-walk escape(s) detected:\n${escapes.join('\n')}`)
    console.log('idle-matrix-gate PASS')
  } finally {
    await browser.close()
    vite.kill()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
