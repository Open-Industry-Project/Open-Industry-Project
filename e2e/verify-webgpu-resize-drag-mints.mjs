/* global console, process */
// WebGPU gizmo-drag guard: sweeping a conveyor longer in many small steps (what the resize gizmo does: a
// store.setTransient per pointer-move, each re-running the sdkPart bank reconcile) must re-create the part's
// bank InstancedMeshes only a handful of times across the whole drag (once per capacity-bucket crossing),
// not on every step that adds a roller/leg.
//
// verify-webgpu-resize-no-recompile.mjs's single store.commit does not cover this path: one commit jumps
// straight to the final bucket (≤1 re-creation per bank). A real drag walks through intermediate lengths, so
// without bucketed capacity an exact-fit bank would be re-created (cold-compiled) on essentially every added
// piece, a continuously stuttery drag. With the unified InstanceBank capacity policy (parts/instanceBank.ts +
// parts/instanceCapacity.ts) growth crosses few buckets, so total re-creations stay far below the step count.
// Run: node e2e/verify-webgpu-resize-drag-mints.mjs
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'

const STEP = 0.2 // metres per simulated pointer-move
const SWEEP = 3.0 // total extend distance

async function launchWebGPU() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch {} }
  return null
}

const waitApp = (page) => page.waitForFunction(() => !!(window.__oip && window.__oip.view && window.__oip.store), { timeout: 30000 })
const settle = async (page, ms) => { await page.waitForTimeout(ms); for (let i = 0; i < 3; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))) }

// uuid -> live count for every InstancedMesh under a part's group
const bankMap = (page, id) => page.evaluate((id) => {
  let root = null
  window.__oip.view.scene.traverse((o) => { if (o.userData && o.userData.partId === id) root = o })
  const out = {}
  if (root) root.traverse((o) => { if (o.isInstancedMesh) out[o.uuid] = o.count })
  return out
}, id)

const litFrac = (page) => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const src = window.__oip.view.renderer.domElement
    const c = document.createElement('canvas'); c.width = src.width; c.height = src.height
    const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let lit = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++
    resolve(lit / (d.length / 4))
  }))
}))

const total = (m) => Object.values(m).reduce((s, c) => s + c, 0)

async function main() {
  const browser = await launchWebGPU()
  if (!browser) { console.log('SKIP: no chromium/WebGPU browser available'); return }
  const { url, vite } = await startServer()
  const errors = []
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
  page.on('dialog', (d) => d.accept().catch(() => {}))
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  const fail = (msg) => { console.error(`FAIL: ${msg}`); if (errors.length) console.error('errors:', errors.slice(0, 5)); process.exitCode = 1 }
  try {
    await page.goto(`${url}?webgpu&scene=demo`)
    await waitApp(page)
    if (!(await page.evaluate(() => !!window.__oip.view.renderer.isWebGPURenderer))) { console.log('SKIP: WebGPU renderer not active'); return }
    if ((await page.evaluate(() => window.__oip.store.getState().scene.parts.length)) < 10) {
      await clickDemo(page).catch(() => {})
    }
    await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length >= 10, { timeout: 30000 })
    await settle(page, 6000)

    const info = await page.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts
      const rc = parts.find((p) => p.type === 'part' && /roller-conveyor/.test(p.packageId || ''))
      return rc ? { id: rc.id, length: (rc.params && rc.params.length) || 2 } : null
    })
    if (!info) return fail('demo has no roller conveyor to test')
    await page.evaluate((id) => window.__oip.view.focusOn([id]), info.id)
    await settle(page, 1500)

    const errsBefore = errors.length
    let prev = await bankMap(page, info.id)
    const startTotal = total(prev)
    let reMints = 0, stepsThatGrew = 0, steps = 0

    // simulate a gizmo drag: many small setTransient extends (the exact per-pointer-move path)
    for (let d = STEP; d <= SWEEP + 1e-9; d += STEP) {
      const len = info.length + d
      await page.evaluate(([id, len]) => {
        const s = window.__oip.store.getState().scene
        window.__oip.store.setTransient({ ...s, parts: s.parts.map((p) => (p.id === id ? { ...p, params: { ...p.params, length: len } } : p)) })
      }, [info.id, len])
      await settle(page, 120)
      const curr = await bankMap(page, info.id)
      // banks present last step but gone now = disposed + re-minted this step
      reMints += Object.keys(prev).filter((u) => !(u in curr)).length
      if (total(curr) > total(prev)) stepsThatGrew++
      prev = curr
      steps++
    }

    const lit = await litFrac(page)
    const endTotal = total(prev)
    const shaderErrors = errors.slice(errsBefore).filter((e) => /not compatible|NodeBuilder|ShaderMaterial|instanceMatrix|out of bounds/i.test(e))

    // 1) the sweep really grew the conveyor across many steps (we exercised the drag path)
    if (endTotal <= startTotal) return fail(`sweep added no hardware (${startTotal} -> ${endTotal})`)
    if (stepsThatGrew < 3) return fail(`only ${stepsThatGrew}/${steps} steps grew hardware - sweep too coarse to test the drag path`)
    // 2) the guard: re-mints are bounded by bucket crossings, not the step count. Reuse must outnumber growth.
    if (reMints >= stepsThatGrew) return fail(`re-minted ${reMints}x across ${stepsThatGrew} growth-steps - bucketing not reusing buffers on the drag path`)
    if (reMints > 8) return fail(`${reMints} bank re-mints over a ${SWEEP}m drag - more bucket crossings than expected`)
    // 3) render stayed healthy through the whole sweep
    if (shaderErrors.length) return fail(`WebGPU instancing/material error during drag: ${shaderErrors.slice(0, 3).join(' | ')}`)
    if (lit < 0.05) return fail(`canvas nearly blank after drag (lit=${(lit * 100).toFixed(1)}%)`)
    if (errors.length) return fail(`console/page errors present: ${errors.slice(0, 3).join(' | ')}`)

    console.log(`PASS: ${steps}-step drag of conveyor ${info.id} (${info.length}->${(info.length + SWEEP).toFixed(1)}m), hardware ${startTotal}->${endTotal}, ${stepsThatGrew} growth-steps but only ${reMints} bank re-mints, lit=${(lit * 100).toFixed(0)}%`)
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
