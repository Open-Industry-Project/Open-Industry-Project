// PROBE (not a gate): decompose the demo scene's `phys` HUD number into its three components -
// Jolt step / world.frame() build / interleaved PLC scan - by window-diffing SimClient.stepStats
// while the PLC sortation demo (?scene=demo) runs. Samples two windows (early, then after cargo
// accumulates) to show how each component scales with the box population.
// Run: node e2e/probes/phys-breakdown.mjs [--headed]
/* global process, console, window */
import { startServer } from '../_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
// ?perfparts opts into the O(parts) profiling timers (per-part script/rig cost, beams/zones sub-phases).
// They are off in a shipping run because they cost ~350 ns each per part per step, so the per-part
// numbers this probe prints are inflated by roughly that much.
const URL = `http://localhost:${PORT}/app/?scene=demo&perfparts=1`
const HEADED = process.argv.includes('--headed')

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  try {
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 60000 })
    await page.waitForTimeout(3000)
    await page.reload()
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
    await page.waitForTimeout(1500)
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click({ force: true }).catch(() => {})

    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => (window.__oip.sim.stepStats?.steps ?? 0) > 60, { timeout: 30000 })

    const sample = () => page.evaluate(() => ({
      ...window.__oip.sim.stepStats,
      boxes: window.__oip.controller.boxCount,
      t: performance.now(),
    }))
    const report = (label, a, b) => {
      const steps = b.steps - a.steps
      const per = (k) => ((b[k] - a[k]) / steps).toFixed(3)
      const phys = ((b.totalMs - a.totalMs + b.frameTotalMs - a.frameTotalMs + b.plcTotalMs - a.plcTotalMs) / steps).toFixed(3)
      console.log(`${label}: boxes ${a.boxes}→${b.boxes}  bodies=${b.bodies} active=${b.active}  behaviors=${b.behaviorCount} rigs=${b.rigCount}  steps=${steps} over ${((b.t - a.t) / 1000).toFixed(1)}s`)
      console.log(`  phys ${phys} ms/step  =  step ${per('totalMs')}  +  frame ${per('frameTotalMs')}  +  plc ${per('plcTotalMs')}   (cum maxStep ${b.maxMs.toFixed(2)} ms)`)
      const phN = (k) => (b.phases[k] - a.phases[k]) / steps
      const ph = (k) => phN(k).toFixed(3)
      console.log(`  step split: cull ${ph('cull')}  behaviors ${ph('behaviors')} (of which beams ${ph('beams')}, zones ${ph('zones')}, script ${ph('script')})  drives ${ph('drives')}  facets ${ph('facets')}  solver ${ph('solver')}`)
      console.log(`  script split: input-refresh ${ph('scriptTags')}  setup ${ph('scriptSetup')}  body ${ph('scriptBody')}`)
      const us = (ms, n) => ((ms * 1000) / (n || 1)).toFixed(1)
      console.log(`  per part: script ${us(phN('script'), b.behaviorCount)} us/behavior  loop-overhead ${us(phN('behaviors') - phN('beams') - phN('zones') - phN('script'), b.behaviorCount)} us/behavior  rig FK ${us(phN('drives'), b.rigCount)} us/rig`)
      if (b.plcSplit) {
        const pl = (k) => ((b.plcSplit[k] - (a.plcSplit?.[k] ?? 0)) / steps).toFixed(3)
        const scans = b.plcSplit.scans - (a.plcSplit?.scans ?? 0)
        console.log(`  plc split: inputs ${pl('inputsMs')}  scan ${pl('scanMs')}  image ${pl('imageMs')}  (${scans} scans = ${(scans / steps).toFixed(2)}/step)`)
      }
      if (b.worstStep) {
        const w = b.worstStep
        const f = (x) => x.toFixed(2)
        console.log(`  worst step (cum): ${f(w.ms)} ms at step ${w.step} (boxes ${w.boxes}) = cull ${f(w.cull)} behaviors ${f(w.behaviors)} drives ${f(w.drives)} facets ${f(w.facets)} solver ${f(w.solver)}   over-budget steps ${b.overBudgetSteps - (a.overBudgetSteps ?? 0)} in window, ${b.overBudgetSteps} cum`)
        const c = b.worstScriptCall
        if (c) console.log(`  worst single script call (cum): ${f(c.ms)} ms, part ${c.partId} at step ${c.step}`)
      }
    }

    const a1 = await sample()
    await page.waitForTimeout(8000)
    const b1 = await sample()
    report('EARLY  (t≈1-9s) ', a1, b1)

    await page.waitForTimeout(20000) // let the spawner fill the line
    const a2 = await sample()
    await page.waitForTimeout(8000)
    const b2 = await sample()
    report('LOADED (t≈29-37s)', a2, b2)

    // rank parts by their windowed per-step worker cost (script + rig), joined with scene names
    const partInfo = await page.evaluate(() => {
      const m = {}
      for (const p of window.__oip.store.getState().scene.parts) m[p.id] = `${p.name ?? p.id} [${p.packageId ?? p.type}]`
      return m
    })
    const steps2 = b2.steps - a2.steps
    const rows = new Map()
    const add = (field, key) => {
      for (const [k, v] of Object.entries(b2[field] ?? {})) {
        const d = v - (a2[field]?.[k] ?? 0)
        const r = rows.get(k) ?? { script: 0, rig: 0 }
        r[key] = d
        rows.set(k, r)
      }
    }
    add('scriptMsByPart', 'script')
    add('rigMsByPart', 'rig')
    const top = [...rows]
      .map(([k, r]) => ({ k, script: (r.script * 1000) / steps2, rig: (r.rig * 1000) / steps2 }))
      .sort((x, y) => y.script + y.rig - (x.script + x.rig))
      .slice(0, 12)
    console.log('TOP PARTS by worker cost, LOADED window (us/step):')
    for (const t of top)
      console.log(`  total ${(t.script + t.rig).toFixed(1).padStart(6)}  script ${t.script.toFixed(1).padStart(6)}  rig ${t.rig.toFixed(1).padStart(6)}   ${partInfo[t.k] ?? t.k}`)
  } finally {
    await browser.close().catch(() => {})
    vite.kill()
  }
}

main().catch((e) => { console.error(e); vite.kill(); process.exit(1) })
