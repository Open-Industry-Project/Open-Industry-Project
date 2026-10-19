/* global console, process */
// Regression guard for the WebGPU "spawned cargo is invisible until you select it" bug.
//
// three's node instance path (three/src/nodes/accessors/Instance.js) sizes an InstancedMesh's
// instance-matrix uniform buffer to Math.max(count, 1) matrices at node-build time and caches the
// graph by material; it never re-reads count. So if the cargo batch (SimBoxes) first compiles while
// empty (count 0: a spawner-only scene with no pre-placed cargo), the buffer is baked for one matrix
// and every later-spawned body reads out of bounds, so the whole batch renders invisible under WebGPU
// (WebGL is fine, since it uses real instanced attributes). To prevent this, the batch is baked at
// MAX_BOXES during the WebGPU compile warm (SimBoxes.beginCapacityWarm, driven by compileStaged in viewWarm.ts).
//
// This reproduces the exact trigger: boot a blank scene (so the box mesh compiles at count 0), then
// push a grid of red cargo bodies through applyBoxFrame, the same batch path the running spawner uses.
// PASS = the grid is visibly red; FAIL = it stayed invisible.
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

async function launchWebGPU() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch {} }
  return null
}

const injectGrid = (page) => page.evaluate(() => {
  const v = window.__oip.view
  const cam = v.camera
  const P = v.boxes.mesh.position.constructor
  const camPos = new P(); cam.getWorldPosition(camPos)
  const fwd = new P(); cam.getWorldDirection(fwd)
  const right = new P().crossVectors(fwd, new P(0, 1, 0)).normalize()
  const upv = new P().crossVectors(right, fwd).normalize()
  const centre = camPos.clone().add(fwd.clone().multiplyScalar(6))
  const cols = 6, rows = 4, step = 0.7, n = cols * rows
  const positions = new Float32Array(n * 3), quats = new Float32Array(n * 4)
  const half = new Float32Array(n * 3), colors = new Float32Array(n * 3)
  const kinds = new Uint8Array(n), ids = new Uint32Array(n), partIds = []
  let k = 0
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const off = right.clone().multiplyScalar((c - (cols - 1) / 2) * step).add(upv.clone().multiplyScalar(((rows - 1) / 2 - r) * step))
    const p = centre.clone().add(off)
    positions[k * 3] = p.x; positions[k * 3 + 1] = p.y; positions[k * 3 + 2] = p.z
    quats[k * 4 + 3] = 1
    half[k * 3] = 0.28; half[k * 3 + 1] = 0.28; half[k * 3 + 2] = 0.28
    colors[k * 3] = 1
    ids[k] = 1000 + k; partIds.push(null); k++
  }
  // selected cargo stays in the instanced batch and is tiered per row, so 'nothing selected' is an
  // empty tier map (boxes.ts setSelectionTiers).
  v.boxes.setSelectionTiers(new Map())
  v.applyBoxFrame({ count: n, ids, positions, quats, halfExtents: half, colors, kinds, partIds, simTime: 0 })
  return v.boxes.mesh.count
})

const redFrac = (page) => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const src = window.__oip.view.renderer.domElement
    const c = document.createElement('canvas'); c.width = src.width; c.height = src.height
    const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let red = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] > 100 && d[i + 1] < 80 && d[i + 2] < 80) red++
    resolve(red / (d.length / 4))
  }))
}))

async function main() {
  const browser = await launchWebGPU()
  if (!browser) { console.log('SKIP: no chromium/WebGPU browser available'); return }
  const { url, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
  try {
    await page.goto(`${url}?webgpu`) // startServer's url already ends with /app/
    await page.waitForFunction(() => !!(window.__oip && window.__oip.view && window.__oip.store), { timeout: 30000 })
    const isWebGPU = await page.evaluate(() => !!window.__oip.view.renderer.isWebGPURenderer)
    if (!isWebGPU) { console.log('SKIP: WebGPU renderer not active (fell back to WebGL)'); return }
    // let the staged compile of the empty box mesh (count 0) + its capacity warm finish
    await page.waitForTimeout(8000)
    const n = await injectGrid(page)
    for (let i = 0; i < 3; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())))
    const frac = await redFrac(page)
    const visible = frac > 0.02
    console.log(`injected ${n} cargo bodies, red = ${(frac * 100).toFixed(2)}% -> ${visible ? 'VISIBLE (pass)' : 'INVISIBLE (FAIL)'}`)
    if (!visible) { process.exitCode = 1 }
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
