/* global console, process, window, Image */
// Regression guard for the WebGPU "belt weave (beltTexture) live swap doesn't take until browser refresh"
// bug, and through it the whole stale-GPU-texture class via view.auditGpuTextures().
//
// The two weave images differ in size (plain BeltFabric.jpg 1024², arrows BeltFabricArrows.jpg 512²).
// three's WebGPU backend allocates a sampled texture's GPUTexture once (Textures.updateTexture gates
// createTexture on isDefaultTexture), so an in-place image swap + needsUpdate keeps sampling the old
// 1024² allocation, and the weave only changes after a reload rebuilds the texture fresh. WebGL never
// shows this (texImage2D re-specifies every upload). BeltSurface.setVariant therefore rebinds a texture
// of its own per weave (src/render/parts/common.ts) instead of swapping the image.
//
// Guard: place a belt (package-edit focus), flip beltTexture standard→alternate→standard live via the same
// store.commit path the Inspector uses, and after each flip require both:
//   1. the belt fabric texture is bound to the expected image at the matching GPUTexture size
//      (1024² plain / 512² arrows), so a broken swap path can't pass vacuously, and
//   2. view.auditGpuTextures() reports zero mismatches scene-wide (the generic invariant: any texture whose
//      GPUTexture no longer matches its bound image is a live stale-texture bug, belt or not).
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

async function launchWebGPU() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch {} }
  return null
}

const audit = (page) => page.evaluate(() => window.__oip.view.auditGpuTextures())

// wait until the belt fabric texture is bound to `file` with a square GPUTexture of `size` (and the audit
// agrees CPU/GPU sizes match): the deterministic "the swap fully took on the GPU" signal
const waitForBeltTex = (page, file, size) =>
  page.waitForFunction(([f, s]) => {
    const a = window.__oip.view.auditGpuTextures()
    const e = a && a.textures.find((t) => t.texture === f)
    return !!e && e.ok && e.gpuSize[0] === s && e.gpuSize[1] === s
  }, [file, size], { timeout: 15000 })

const flipWeave = (page, partId, value) =>
  page.evaluate(([id, v]) => {
    const s = window.__oip.store
    const scene = s.getState().scene
    s.commit('weave', { ...scene, parts: scene.parts.map((p) => (p.id === id ? { ...p, params: { ...p.params, beltTexture: v } } : p)) })
  }, [partId, value])

async function main() {
  const browser = await launchWebGPU()
  if (!browser) { console.log('SKIP: no WebGPU-capable browser available'); return }
  const { url, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
  const fails = []
  const check = (label, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${detail ? ` - ${detail}` : ''}`)
    if (!cond) fails.push(label)
  }
  try {
    await page.goto(`${url}?webgpu`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 30000 })
    if (!(await page.evaluate(() => !!window.__oip.view.renderer.isWebGPURenderer))) {
      console.log('SKIP: WebGPU renderer not active (fell back to WebGL)'); return
    }
    // pre-decode both fabrics so each flip binds an already-cached image (removes decode-timing flakiness)
    await page.evaluate(async () => {
      const load = (u) => { const i = new Image(); i.src = u; return i.decode().catch(() => {}) }
      await Promise.all([load('/textures/BeltFabric.jpg'), load('/textures/BeltFabricArrows.jpg')])
    })

    const partId = await page.evaluate(() => {
      window.__oip.store.enterPackageEdit('oip.belt-conveyor')
      return window.__oip.store.getState().packageEdit?.partId ?? null
    })
    check('belt placed (enterPackageEdit)', !!partId)
    if (!partId) return

    // baseline: standard weave uploaded at 1024², audit clean and non-vacuous
    await waitForBeltTex(page, 'BeltFabric.jpg', 1024)
    const base = await audit(page)
    check('audit sees textures (non-vacuous)', base.checked > 0, `${base.checked} checked`)
    check('baseline audit clean', base.mismatches.length === 0, JSON.stringify(base.mismatches))

    // standard -> alternate: the GPUTexture must shrink to the 512² arrows image
    await flipWeave(page, partId, 'alternate')
    await waitForBeltTex(page, 'BeltFabricArrows.jpg', 512)
    const alt = await audit(page)
    check('alternate weave live (arrows @ 512² on GPU)', true)
    check('audit clean after alternate', alt.mismatches.length === 0, JSON.stringify(alt.mismatches))

    // alternate -> standard: the reverse direction must grow it back to 1024²
    await flipWeave(page, partId, 'standard')
    await waitForBeltTex(page, 'BeltFabric.jpg', 1024)
    const back = await audit(page)
    check('standard weave live again (plain @ 1024² on GPU)', true)
    check('audit clean after revert', back.mismatches.length === 0, JSON.stringify(back.mismatches))
  } catch (e) {
    fails.push('exception')
    console.log('FAIL: exception —', e.message)
  } finally {
    await page.close().catch(() => {})
    vite.kill()
    await browser.close().catch(() => {})
  }
  console.log(fails.length === 0 ? '\nALL PASS' : `\n${fails.length} FAILURE(S): ${fails.join('; ')}`)
  if (fails.length > 0) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exit(1) })
