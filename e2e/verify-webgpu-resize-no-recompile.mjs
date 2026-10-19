/* global console, process */
// WebGPU resize-hitch guard: extending a conveyor a modest amount must add hardware instances without
// replacing any of the part's bank InstancedMeshes.
//
// Background: under three's WebGPU node backend the render pipeline is keyed on the mesh uuid and the
// instanceMatrix array is captured by reference, so a bank can't grow its buffer in place. Growing past the
// allocated capacity forces a fresh InstancedMesh (new uuid), which cold-compiles a pipeline on the draw
// path: the one-frame stutter a user feels the first time they extend a conveyor. To avoid it,
// src/render/parts/instanceCapacity.ts sizes every instance buffer to a coarse power-of-two bucket
// instead of exact-fit, so a modest resize stays under capacity → the reconcile in sdkPart rewrites the
// same mesh's transforms in place → the uuid (and its warm pipeline) is preserved → no hitch.
//
// What this asserts, end-to-end under real WebGPU: after a modest extend, (1) total instance count grew (the
// resize really added rollers/legs), (2) every bank mesh present before is still present after, so no bank was
// disposed and re-created (which would recompile), (3) the frame still renders and no instancing/material
// error fired. With exact-fit buffers, the leg bank would be re-created on the first added leg and (2) would fail.
// Run: node e2e/verify-webgpu-resize-no-recompile.mjs
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'

const EXTEND_BY = 2 // metres - a modest "first nudge", large enough to add legs/rollers, small enough to stay within capacity buckets

async function launchWebGPU() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch {} }
  return null
}

const waitApp = (page) => page.waitForFunction(() => !!(window.__oip && window.__oip.view && window.__oip.store), { timeout: 30000 })
const settle = async (page, ms) => { await page.waitForTimeout(ms); for (let i = 0; i < 4; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))) }

// uuid -> {count, cap} for every InstancedMesh under a part's group (its own roller / stub / leg / bolt banks)
const bankMap = (page, id) => page.evaluate((id) => {
  let root = null
  window.__oip.view.scene.traverse((o) => { if (o.userData && o.userData.partId === id) root = o })
  const out = {}
  if (root) root.traverse((o) => { if (o.isInstancedMesh) out[o.uuid] = { count: o.count, cap: o.instanceMatrix.count } })
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

const total = (m) => Object.values(m).reduce((s, b) => s + b.count, 0)

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
    const isWebGPU = await page.evaluate(() => !!window.__oip.view.renderer.isWebGPURenderer)
    if (!isWebGPU) { console.log('SKIP: WebGPU renderer not active (fell back to WebGL - no node instance path to exercise)'); return }
    if ((await page.evaluate(() => window.__oip.store.getState().scene.parts.length)) < 10) {
      await clickDemo(page).catch(() => {})
    }
    await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length >= 10, { timeout: 30000 })
    await settle(page, 6000) // let the staged compile finish so all banks exist warm

    const beds = await page.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts
      return parts
        .filter((p) => p.type === 'part' && /roller-conveyor/.test(p.packageId || ''))
        .map((rc) => ({ id: rc.id, name: rc.name, length: (rc.params && rc.params.length) || 0 }))
    })
    if (!beds.length) return fail('demo has no roller conveyor to test')

    // "Modest" means under every bank's capacity bucket: crossing a bucket re-creates the bank by design
    // (instanceCapacity.ts), so a bed whose roller bank already sits near its bucket edge (a bed holding
    // 112 of 128 crosses to 256 at +2 m) cannot test the in-place path with a fixed 2 m. So take the
    // bed with the most headroom and extend it by at most EXTEND_BY, and at most half the length that
    // would fill its tightest bank (instances scale with length).
    const headroomM = (bed, banks) => {
      let m = Infinity
      for (const b of Object.values(banks)) if (b.count >= 4 && bed.length > 0) m = Math.min(m, (b.cap - b.count) / (b.count / bed.length))
      return m
    }
    let info = null
    let extendBy = 0
    for (const bed of beds) {
      const room = headroomM(bed, await bankMap(page, bed.id))
      const ext = Math.min(EXTEND_BY, room / 2)
      if (ext > extendBy) { info = bed; extendBy = ext }
    }
    if (!info || extendBy < 0.3) return fail(`no roller bed has bucket headroom for a modest extend (best ${extendBy.toFixed(2)} m of ${beds.length} beds)`)
    extendBy = Math.round(extendBy * 10) / 10

    await page.evaluate((id) => window.__oip.view.focusOn([id]), info.id)
    await settle(page, 1500)
    const before = await bankMap(page, info.id)

    const errsBeforeGrow = errors.length
    const target = (info.length || 2) + extendBy
    await page.evaluate(([id, len]) => {
      const s = window.__oip.store.getState().scene
      window.__oip.store.commit('resize', { ...s, parts: s.parts.map((p) => (p.id === id ? { ...p, params: { ...p.params, length: len } } : p)) })
    }, [info.id, target])
    await settle(page, 2000)

    const after = await bankMap(page, info.id)
    const lit = await litFrac(page)
    const dc = await page.evaluate(() => window.__oip.view.getStats().drawCalls)
    const grewErrors = errors.slice(errsBeforeGrow)
    const shaderErrors = grewErrors.filter((e) => /not compatible|NodeBuilder|ShaderMaterial|instanceMatrix|out of bounds/i.test(e))

    const beforeUuids = Object.keys(before)
    const minted = beforeUuids.filter((u) => !(u in after)) // banks that vanished = were disposed + re-minted (cold compile)
    const tBefore = total(before), tAfter = total(after)

    // 1) the resize actually added hardware instances (we exercised real growth, not a no-op)
    if (tAfter <= tBefore) return fail(`modest resize added no hardware (${tBefore} -> ${tAfter} instances) - nudge too small to test growth`)
    // 2) the guard: no bank mesh was replaced. A replaced uuid == a fresh InstancedMesh == a cold pipeline == the hitch.
    if (minted.length) return fail(`${minted.length} bank mesh(es) re-minted on a ${extendBy}m extend of ${info.name} (cold-compile hitch): ${minted.map((u) => `cap ${before[u].cap}->gone, was count ${before[u].count}`).join(' | ')}`)
    // 3) render still healthy (a broken reconcile would blank the canvas / crater draws / throw)
    if (shaderErrors.length) return fail(`WebGPU instancing/material error during resize: ${shaderErrors.slice(0, 3).join(' | ')}`)
    if (lit < 0.05) return fail(`canvas nearly blank after resize (lit=${(lit * 100).toFixed(1)}%)`)
    if (dc < 20) return fail(`draw calls cratered after resize (${dc})`)
    if (errors.length) return fail(`console/page errors present: ${errors.slice(0, 3).join(' | ')}`)

    console.log(`PASS: conveyor ${info.id} (${info.name}) extended ${info.length}->${target}m, hardware ${tBefore}->${tAfter} instances, ${beforeUuids.length} banks all reused (0 re-minted), lit=${(lit * 100).toFixed(0)}%, drawCalls=${dc}`)
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
