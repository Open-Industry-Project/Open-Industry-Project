/* global console, process */
// Probe: under render bundles, do rig-driven parts (robot, diverter) still animate while the sim runs?
// Finds a link mesh whose matrixWorld is actually changing, crops tight around its projected
// screen position, and compares crops 700ms apart. data-moved + pixels-identical = the render-
// bundle replay is not refreshing that object's matrix uniforms.
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'
import { clickDemo } from '../_demo.mjs'

const OUT = 'e2e/out'
mkdirSync(OUT, { recursive: true })

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try { return await chromium.launch(opts) } catch {}
  }
  throw new Error('no chromium')
}

// sample every mesh's world position under the part twice, 400ms apart; return the mesh index
// that moved the most plus its current projected screen position (canvas coords)
const movingLink = (page, id) => page.evaluate(async (pid) => {
  const v = window.__oip.view
  const entry = v.entries.get(pid)
  if (!entry) return null
  const meshes = []
  entry.visual.object.traverse((o) => { if (o.isMesh) meshes.push(o) })
  const posOf = (o) => { const e = o.matrixWorld.elements; return [e[12], e[13], e[14]] }
  const a = meshes.map(posOf)
  await new Promise((r) => setTimeout(r, 400))
  const b = meshes.map(posOf)
  let best = -1
  let bestD = 0
  for (let i = 0; i < meshes.length; i++) {
    const d = Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1], a[i][2] - b[i][2])
    if (d > bestD) { bestD = d; best = i }
  }
  if (best < 0 || bestD < 1e-4) return { moved: false, dist: bestD }
  const w = posOf(meshes[best])
  const cam = v.camera
  cam.updateMatrixWorld()
  const vm = cam.matrixWorldInverse.elements
  const pm = cam.projectionMatrix.elements
  const mul = (m, p) => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12] * p[3],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13] * p[3],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14] * p[3],
    m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15] * p[3],
  ]
  const clip = mul(pm, mul(vm, [w[0], w[1], w[2], 1]))
  const r = v.renderer.domElement.getBoundingClientRect()
  return {
    moved: true,
    dist: bestD,
    x: r.left + ((clip[0] / clip[3] + 1) / 2) * r.width,
    y: r.top + ((1 - clip[1] / clip[3]) / 2) * r.height,
  }
}, id)

const matSig = (page, id) => page.evaluate((pid) => {
  const v = window.__oip.view
  const entry = v.entries.get(pid)
  if (!entry) return null
  const parts = []
  entry.visual.object.traverse((o) => {
    if (o.isMesh || o.isInstancedMesh) parts.push(o.matrixWorld.elements.map((e) => e.toFixed(4)).join(','))
  })
  return parts.join('|')
}, id)

async function probe(page, url, label) {
  // cold vite re-optimizes deps and full-reloads the page mid-run - warm up, then re-goto
  await page.goto(url).catch(() => {})
  await page.waitForTimeout(6000)
  await page.goto(url)
  await page.waitForFunction(() => !!(window.__oip && window.__oip.view && window.__oip.store && window.__oip.controller), { timeout: 60000 })
  await page.waitForTimeout(1500)
  await clickDemo(page).catch(() => {})
  await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length >= 10, { timeout: 60000 })
  await page.waitForTimeout(4000) // warm: pipelines, pooling, first bundle record

  const info = await page.evaluate(() => {
    const v = window.__oip.view
    const parts = window.__oip.store.getState().scene.parts
      .filter((p) => /loader robot|^diverter$/i.test(p.name))
      .map((p) => ({ id: p.id, name: p.name }))
    return { isWebGPU: !!v.renderer.isWebGPURenderer, parts, drawCalls: v.getStats().drawCalls }
  })
  console.log(`[${label}] webgpu=${info.isWebGPU} drawCalls(idle)=${info.drawCalls} targets=${JSON.stringify(info.parts.map((p) => p.name))}`)

  // start the sim; the button click can race UI state, so retry until running is true
  for (let i = 0; i < 5; i++) {
    await page.locator('button.run-button.play').click().catch(() => {})
    await page.waitForTimeout(1500)
    if (await page.evaluate(() => window.__oip.store.getState().running)) break
  }
  if (!(await page.evaluate(() => window.__oip.store.getState().running))) {
    console.log(`[${label}] FAILED to start sim`)
    return
  }
  await page.waitForTimeout(4000) // let the robot enter its pick cycle

  for (const part of info.parts) {
    // frame the part (camera parks afterwards → one re-record, then pure replay while we sample)
    await page.evaluate((pid) => {
      const v = window.__oip.view
      const p = window.__oip.store.getState().scene.parts.find((x) => x.id === pid)
      const [x, y, z] = p.position
      v.controls.target.set(x, (y ?? 0) + 1.2, z)
      v.camera.position.set(x + 3.2, (y ?? 0) + 3.0, z + 3.2)
      v.controls.update()
    }, part.id)
    await page.waitForTimeout(1200)
    const flags = await page.evaluate((pid) => {
      const o = window.__oip.view.entries.get(pid)?.visual.object
      if (!o) return null
      let frozenMeshes = 0
      let meshes = 0
      o.traverse((m) => { if (m.isMesh) { meshes++; if (m.matrixAutoUpdate === false || m.matrixWorldAutoUpdate === false) frozenMeshes++ } })
      return { rootAuto: o.matrixAutoUpdate, rootWorldAuto: o.matrixWorldAutoUpdate, meshes, frozenMeshes }
    }, part.id)
    console.log(`[${label}] ${part.name} freeze-flags: ${JSON.stringify(flags)}`)

    // Shots must fall inside a motion burst (diverter kicks ~1s; robot sweeps in phases):
    // find a moving link, shoot immediately, wait 250ms, shoot again, and only accept the
    // attempt if the part's matrices also changed between the two shots.
    let verdict = null
    for (let attempt = 0; attempt < 40 && !verdict; attempt++) {
      const link = await movingLink(page, part.id)
      if (!link?.moved) { await page.waitForTimeout(300); continue }
      const half = 55
      const rect = { x: Math.max(0, link.x - half), y: Math.max(0, link.y - half), width: half * 2, height: half * 2 }
      const sigA = await matSig(page, part.id)
      const shotA = await page.screenshot({ clip: rect })
      const fullA = await page.screenshot()
      await page.waitForTimeout(600)
      const sigB = await matSig(page, part.id)
      const shotB = await page.screenshot({ clip: rect })
      const fullB = await page.screenshot()
      if (sigA === sigB) continue // burst ended before the window - retry
      verdict = { link, pixelsMoved: !shotA.equals(shotB), shotA, shotB, fullA, fullB }
    }
    if (!verdict) {
      console.log(`[${label}] ${part.name}: never caught a motion burst - inconclusive`)
      continue
    }
    console.log(`[${label}] ${part.name}: linkSpeed=${verdict.link.dist.toFixed(4)}m/400ms dataMoved=true pixelsMoved=${verdict.pixelsMoved}${verdict.pixelsMoved ? '' : '  <-- FROZEN PIXELS'}`)
    const safe = `${label}-${part.name.replace(/\W+/g, '-')}`
    writeFileSync(`${OUT}/${safe}-a.png`, verdict.shotA)
    writeFileSync(`${OUT}/${safe}-b.png`, verdict.shotB)
    writeFileSync(`${OUT}/${safe}-full-a.png`, verdict.fullA)
    writeFileSync(`${OUT}/${safe}-full-b.png`, verdict.fullB)
  }
}

async function main() {
  const { url, vite } = await startServer()
  const browser = await launch()
  const errors = []
  try {
    for (const [label, qs] of [['bundle-default', '?webgpu&scene=demo'], ['bundle-livesplit', '?webgpu&bundlelive&scene=demo']]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await context.newPage()
      await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
      page.on('dialog', (d) => d.accept().catch(() => {}))
      page.on('pageerror', (e) => errors.push(`[${label}] ${e}`))
      await probe(page, `${url}${qs}`, label) // startServer's url already ends in /app/
      await context.close()
    }
    if (errors.length) console.log('page errors:', errors.slice(0, 5))
  } finally {
    await browser.close()
    vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
