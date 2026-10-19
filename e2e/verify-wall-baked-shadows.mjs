// Gate for the building walls' baked light (scripts/bake-wall-lighting.mjs writes it, src/render/parts/
// wallLightmaps.ts draws it). Every way it breaks is silent: no error, just walls that look wrong.
//
//   1. every world facing self-shadows. A lightmap that fails to load renders the neutral fallback, and a
//      wall whose second UV set went missing (the prod optimizer strips attributes by model name) samples
//      one texel: either way the light is uniform. Measured as the lightmap's own contribution: the shot
//      divided by the same shot drawn with the lightmaps removed varies ~12% across a shadowed wall and
//      ~1% (quantization) across a uniform one. A plain luminance spread cannot tell them apart: the panel
//      texture and the braces alone give 8.6 against the baked 9.9.
//   2. the lightmap follows the world facing. The light is world-fixed like the sun, so a building turned a
//      quarter turn must light its world -Z wall exactly as the unturned one did (building.ts litSide), even
//      though that wall is now a different side of the building. The failure looks like shadows thrown
//      against the sun's floor shadows beside them. The comparison is checked against a different facing
//      first, so it cannot pass by being blind.
//   3. the scene's Brightness reaches the walls (they take no scene light, so env.setLighting has to tell
//      them separately).
//   4. WebGL and WebGPU draw the same walls (both compute the lightmap term in their basic material).
// Uncaptured GPU device errors are reported by _gpuGuard.mjs at exit.
//
// Run: node e2e/verify-wall-baked-shadows.mjs   (WebGL always; the WebGPU arm needs installed Edge)
/* global process, console, window, localStorage, requestAnimationFrame */
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'

const { port: PORT, vite } = await startServer()
const OUT = join(import.meta.dirname, 'shots')
mkdirSync(OUT, { recursive: true })

// a square shell at the origin, every cell Wall_A: a quarter turn puts identical geometry on each world edge,
// so only the light can differ. Wall_A because its X-braces throw slanted shadows that mirror with the key
// side; the plain Wall_D panel reads the same lit from either corner, which would blind check 2
const ALL_A = [{ wall: 'A', run: 1, gap: 0, count: 0, start: 0, doorCount: 1, trailer: false }]
const SCENE = JSON.stringify({
  version: 4,
  parts: [{ id: 'bld_1', type: 'building', position: [0, 0, 0], rotationY: 0, params: { lengthSections: 3, widthSections: 3, heightSections: 1, rules: ALL_A } }],
})
const HALF = 15
// from inside, square-on to each world edge's interior face, close enough that framing shadows dominate
const POSES = {
  nz: { px: 0, py: 5, pz: -HALF + 14, tx: 0, ty: 5, tz: -HALF },
  pz: { px: 0, py: 5, pz: HALF - 14, tx: 0, ty: 5, tz: HALF },
  nx: { px: -HALF + 14, py: 5, pz: 0, tx: -HALF, ty: 5, tz: 0 },
  px: { px: HALF - 14, py: 5, pz: 0, tx: HALF, ty: 5, tz: 0 },
}

const frames = (page, n) =>
  page.evaluate((count) => new Promise((resolve) => {
    let i = 0
    const tick = () => (++i >= count ? resolve() : requestAnimationFrame(tick))
    requestAnimationFrame(tick)
  }), n)

const commitBuilding = (page, patch) =>
  page.evaluate((patch) => {
    const { store } = window.__oip
    const s = store.getState().scene
    store.commit('gate baked walls', {
      ...s,
      parts: s.parts.map((p) => (p.type === 'building' ? { ...p, ...patch.part, params: { ...p.params, ...patch.params } } : p)),
    })
  }, patch)

/**
 * The cladding band (above head height, below the eave) as luminance, from a cleanShot PNG. Nearly the full
 * width: the columns' shadows are what fall to one side, while an X-brace's shadow is an X lit
 * from either corner, so a centre crop of the braces alone could not tell the two key corners apart.
 */
async function band(path) {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true })
  const x0 = Math.floor(info.width * 0.03), x1 = Math.floor(info.width * 0.97)
  const y0 = Math.floor(info.height * 0.14), y1 = Math.floor(info.height * 0.44)
  const lum = []
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * info.width + x) * info.channels
      lum.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])
    }
  }
  const mean = lum.reduce((s, v) => s + v, 0) / lum.length
  const std = Math.sqrt(lum.reduce((s, v) => s + (v - mean) ** 2, 0) / lum.length)
  return { lum, mean, std }
}
const meanAbsDiff = (a, b) => a.lum.reduce((s, v, i) => s + Math.abs(v - b.lum[i]), 0) / a.lum.length
/** how much the lightmap's contribution (lit / albedo-only, per pixel) varies across the band: std / mean */
function lightVariation(lit, flat) {
  const ratio = lit.lum.map((v, i) => v / Math.max(1, flat.lum[i]))
  const mean = ratio.reduce((s, v) => s + v, 0) / ratio.length
  return Math.sqrt(ratio.reduce((s, v) => s + (v - mean) ** 2, 0) / ratio.length) / mean
}

async function shoot(page, tag, edge) {
  await page.evaluate((p) => window.__oip.view.setCameraPose(p), POSES[edge])
  await frames(page, 20)
  const path = join(OUT, `wall-baked-${tag}-${edge}.png`)
  await cleanShot(page, path)
  return band(path)
}

async function measure(browser, query, tag, wantWebGPU) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.addInitScript(() => {
    try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ }
  })
  page.on('dialog', (d) => d.accept().catch(() => {}))
  try {
    await page.goto(`http://localhost:${PORT}/app/?${query}`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.loadSceneText && window.__oip.view), { timeout: 60000 })
    const isWebGPU = await page.evaluate(() => !!window.__oip.view.renderer.isWebGPURenderer)
    if (isWebGPU !== wantWebGPU) return null // an arm that fell back would measure the wrong path twice
    await page.evaluate((text) => window.__oip.loadSceneText(text), SCENE)
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 })
    await frames(page, 30)

    const maps = await page.evaluate(() => {
      const out = { materials: 0, loaded: 0 }
      window.__oip.view.scene.traverse((o) => {
        if (!o.isMesh) return
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!m?.lightMap) continue
          out.materials++
          if (m.lightMap.image) out.loaded++
        }
      })
      return out
    })
    const r = { maps, edges: {} }
    for (const edge of Object.keys(POSES)) r.edges[edge] = await shoot(page, `${tag}-rot0`, edge)

    await commitBuilding(page, { part: { rotationY: Math.PI / 2 } })
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 60000 })
    await frames(page, 20)
    // an exact image match would also come out of a turn that never applied: read the turn back off the
    // drawn walls (the building's +X run must now face world -Z, and draw the world -Z light)
    r.turnedRun = await page.evaluate(() => {
      let out = null
      window.__oip.view.scene.traverse((o) => {
        if (o.name !== 'WallSide_px' || !o.parent?.parent?.userData?.partId) return
        o.updateWorldMatrix(true, false)
        const e = o.matrixWorld.elements
        const names = new Set()
        o.traverse((m) => { if (m.isMesh) for (const mat of [m.material].flat()) if (mat?.lightMap) names.add(mat.name.split('@')[1]) })
        out = { yawDeg: Math.round((Math.atan2(e[8], e[10]) * 180) / Math.PI), facings: [...names] }
      })
      return out
    })
    r.turned = await shoot(page, `${tag}-rot90`, 'nz')

    await commitBuilding(page, { part: { rotationY: 0 }, params: { brightness: 0.5 } })
    await frames(page, 20)
    r.dim = await shoot(page, `${tag}-dim`, 'nz')

    // last, because it is destructive: the same four views with every lightmap removed (albedo only)
    await commitBuilding(page, { params: { brightness: 1 } })
    await frames(page, 10)
    await page.evaluate(async () => {
      const { notifyBundleStructureChanged } = await import('/src/render/bundleGroups.ts')
      window.__oip.view.scene.traverse((o) => {
        if (!o.isMesh) return
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!m?.lightMap) continue
          m.lightMap = null
          m.needsUpdate = true
        }
      })
      // the walls draw in the WebGPU render bundles. Without a re-record, the next camera move
      // refreshes the recorded draws, whose lightMap node now reads null and throws in TextureNode.update
      notifyBundleStructureChanged()
    })
    r.flat = {}
    for (const edge of Object.keys(POSES)) r.flat[edge] = await shoot(page, `${tag}-flat`, edge)
    return r
  } finally {
    await page.close()
  }
}

async function main() {
  let failed = false
  const check = (name, ok, info = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
    if (!ok) failed = true
  }
  const arms = []
  const webglBrowser = await chromium.launch({ headless: true })
  try {
    arms.push(['webgl', await measure(webglBrowser, 'nowebgpu', 'webgl', false)])
  } finally {
    await webglBrowser.close()
  }
  let edge = null
  try {
    edge = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] })
  } catch {
    console.log('note: no msedge channel - the WebGPU arm was not exercised (bundled Chromium has no WebGPU device)')
  }
  if (edge) {
    try {
      const r = await measure(edge, 'webgpu', 'webgpu', true)
      if (r) arms.push(['webgpu', r])
      else console.log('note: Edge fell back to WebGL - the WebGPU arm was not exercised')
    } finally {
      await edge.close()
    }
  }
  try {
    if (!arms[0][1]) {
      check('the WebGL arm produced a WebGL renderer', false, '?nowebgpu no longer forces the fallback path')
      return
    }
    for (const [tag, r] of arms) {
      console.log(`${tag}: ${JSON.stringify({ maps: r.maps, ...Object.fromEntries(Object.entries(r.edges).map(([k, v]) => [k, { mean: +v.mean.toFixed(1), std: +v.std.toFixed(2) }])) })}`)
      check(`${tag}: the walls carry baked light, every lightmap decoded`, r.maps.materials > 0 && r.maps.loaded === r.maps.materials, `${r.maps.loaded}/${r.maps.materials}`)
      for (const e of Object.keys(r.edges)) {
        const v = lightVariation(r.edges[e], r.flat[e])
        check(`${tag}: the world-${e} wall self-shadows (its light varies across it)`, v >= 0.05, `variation ${(100 * v).toFixed(1)}%`)
      }
      const same = meanAbsDiff(r.edges.nz, r.turned)
      const other = meanAbsDiff(r.edges.nz, r.edges.px)
      check(`${tag}: the comparison can see a facing change (world -Z vs world +X walls differ)`, other > 3, `mean |diff| ${other.toFixed(2)}`)
      check(`${tag}: the quarter turn applied (the +X run turned to face world -Z, drawing its light)`, r.turnedRun?.yawDeg === 90 && r.turnedRun.facings.join() === 'nz', JSON.stringify(r.turnedRun))
      check(`${tag}: a quarter-turned building lights its world -Z wall as the unturned one did`, same < 0.5 * other, `same facing ${same.toFixed(2)} vs other facing ${other.toFixed(2)}`)
      check(`${tag}: Brightness 0.5 darkens the walls`, r.dim.mean < 0.85 * r.edges.nz.mean, `${r.edges.nz.mean.toFixed(1)} -> ${r.dim.mean.toFixed(1)}`)
    }
    if (arms.length === 2) {
      const [a, b] = [arms[0][1].edges.nz, arms[1][1].edges.nz]
      check('WebGL and WebGPU draw the same walls', Math.abs(a.mean - b.mean) < 6 && meanAbsDiff(a, b) < 6, `mean ${a.mean.toFixed(1)} vs ${b.mean.toFixed(1)}, |diff| ${meanAbsDiff(a, b).toFixed(2)}`)
    }
    if (!failed) console.log(`PASS: baked wall light holds on ${arms.map(([t]) => t).join(' + ')}`)
  } finally {
    vite.kill()
    if (failed) process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
