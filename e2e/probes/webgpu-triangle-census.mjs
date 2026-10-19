// Is WebGPU's low `triangles` a counter artifact, or is geometry missing?
//
// A phone's ?bench WebGPU arm reported 510,217 triangles and 25 draws against WebGL's 1,672,226
// and 556, with gpuMs ~16 where WebGL's frame was ~24. Render bundles cut CPU encoding, not GPU
// work, so they cannot explain a lighter GPU, but a scene drawing a third of its geometry can.
// This repo has shipped that failure twice (deck tiling, the draw-budget staircase), both times
// with every instrument reading better.
//
// The deciding measurement is a scene-graph census: triangles summed from the actual geometry and
// instance counts, independent of renderer.info. If both backends carry the same geometry and only
// the counters differ, it is an artifact. If the census differs, something is not drawn.
// Screenshots of a fixed camera pose answer the visual question either way.
//
// Needs real WebGPU: bundled Chromium has no GPU process, so this launches the msedge channel.
// Run: node e2e/probes/webgpu-triangle-census.mjs
/* global process, console, window, localStorage */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'
import { cleanShot } from '../_shot.mjs'

const { port: PORT, vite } = await startServer()
const OUT = join(import.meta.dirname, '..', 'shots')
mkdirSync(OUT, { recursive: true })
const booted = () => !!(window.__oip?.store && window.__oip?.view)
const POSE = { px: 11, py: 9.5, pz: 6.5, tx: 4.5, ty: 1.2, tz: -4.5 } // DEMO_OPENING_VIEW

const census = () => {
  const view = window.__oip.view
  let meshes = 0
  let visible = 0
  let instances = 0
  let tris = 0
  let hidden = 0
  view.scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return
    meshes++
    let vis = o.visible
    let p = o.parent
    while (vis && p) {
      vis = p.visible
      p = p.parent
    }
    if (!vis) {
      hidden++
      return
    }
    visible++
    const g = o.geometry
    if (!g) return
    const verts = g.index ? g.index.count : (g.attributes.position?.count ?? 0)
    const n = o.isInstancedMesh ? (o.count ?? 0) : 1
    instances += n
    tris += (verts / 3) * n
  })
  const s = view.getStats()
  return {
    census: { meshes, visible, hidden, instances, tris: Math.round(tris) },
    stats: { triangles: s.triangles, drawCalls: s.drawCalls, drawPath: s.drawPath, backend: s.backend, textures: s.textures, geometries: s.geometries },
  }
}

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try {
      return await chromium.launch(opts)
    } catch {
      /* next */
    }
  }
  throw new Error('no chromium available')
}

async function arm(browser, tag, query) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`http://localhost:${PORT}/app/?scene=demo&hook&gfx=low${query}`)
  await page.waitForFunction(booted, { timeout: 40000 })
  await page.evaluate(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.waitForFunction(() => window.__oip.store.getState().scene.parts.length > 1, { timeout: 40000 })
  // positive settle signal - a timed wait samples the climb (AGENTS.md on the draw-budget staircase)
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 60000 })
  await page.waitForTimeout(3500)
  // identical framing on both arms, or the shots compare nothing
  await page.evaluate((p) => window.__oip.view.setCameraPose(p, { instant: true }), POSE)
  await page.waitForTimeout(1200)
  const data = await page.evaluate(census)
  const shot = join(OUT, `tri-census-${tag}.png`)
  await cleanShot(page, shot)
  await page.close()
  return { ...data, errors, shot }
}

const browser = await launch()
try {
  const gl = await arm(browser, 'webgl', '&nowebgpu')
  const gpu = await arm(browser, 'webgpu', '&webgpu')

  const row = (n, r) =>
    `${n.padEnd(8)} backend=${String(r.stats.backend).padEnd(6)} drawPath=${String(r.stats.drawPath).padEnd(6)} ` +
    `info.tris=${String(r.stats.triangles).padStart(9)} draws=${String(r.stats.drawCalls).padStart(4)}  ` +
    `| scene-graph: meshes=${r.census.visible}/${r.census.meshes} hidden=${r.census.hidden} instances=${r.census.instances} tris=${r.census.tris}`
  console.log('\n=== triangle census: renderer counters vs the actual scene graph ===')
  console.log(row('webgl', gl))
  console.log(row('webgpu', gpu))

  const same = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(a, b)
  console.log('\nverdict:')
  console.log(`  scene-graph geometry identical (<2%): ${same(gl.census.tris, gpu.census.tris, 0.02) ? 'YES - the counter is the artifact' : 'NO - geometry differs between backends'}`)
  console.log(`  visible mesh count identical:         ${gl.census.visible === gpu.census.visible ? 'YES' : `NO (${gl.census.visible} vs ${gpu.census.visible})`}`)
  console.log(`  info.triangles ratio webgpu/webgl:    ${(gpu.stats.triangles / gl.stats.triangles).toFixed(3)}`)
  console.log(`\nshots:\n  ${gl.shot}\n  ${gpu.shot}`)
  if (gl.errors.length || gpu.errors.length) console.log('errors:', [...gl.errors, ...gpu.errors].slice(0, 6))
} finally {
  await browser.close()
  vite.kill('SIGTERM')
  spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
}
