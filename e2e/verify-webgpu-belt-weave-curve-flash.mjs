/* global console, process, window, Image */
// Regression guard for the WebGPU "changing the belt weave on a curved belt conveyor blacks out the
// whole scene for a moment" bug.
//
// The two weave images differ in size (plain BeltFabric.jpg 1024², arrows 512²), and three's WebGPU
// backend allocates a sampled texture's GPUTexture once. Forcing a re-allocation by calling
// texture.dispose() on the live texture destroys the GPUTexture synchronously, mid-frame, while
// already-recorded command buffers still reference it:
//
//   GPUValidationError: Destroyed texture [Texture (1024x1024, RGBA8UnormSrgb)] used in a submit.
//
// A rejected submit drops the whole command buffer, so every pass in that frame draws nothing and the
// entire scene goes black, not just the belt. So BeltSurface keeps one Texture per weave variant
// (mirroring beltFabricBank.ts), sharing the belt's uv-transform Vector2s; a swap rebinds and never destroys.
//
// Only the per-belt path (createBeltSurface, used by non-instanced beds like a curved bed) is exposed;
// straight belts go through the shared bank, so this guard drives a curve.
//
// Guard: flip beltTexture back and forth on a curved conveyor via the same store.commit path the
// Inspector uses, and require that no WebGPU validation error (or three uncaptured-error console line)
// is emitted, while the weave still actually reaches the GPU at the right size each time.
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

async function launchWebGPU() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch {} }
  return null
}

// wait until the belt fabric texture is bound to `file` at `size`² on the GPU, with the scene-wide
// CPU/GPU audit agreeing: the deterministic "the swap fully took" signal (see verify-webgpu-belt-weave-live)
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

// WebGL has no GPUTexture to audit, so assert the swap at the material: some scene material's bound
// map must be the expected fabric image. Guards the `material.map = tex` rebind (which
// skips needsUpdate: the program key is the same either way, so a recompile would be wasted).
const waitForBeltMap = (page, file) =>
  page.waitForFunction((f) => {
    let hit = false
    window.__oip.view.scene.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
      for (const m of mats) {
        const src = m.map && m.map.image && m.map.image.src
        if (typeof src === 'string' && src.includes(f)) hit = true
      }
    })
    return hit
  }, file, { timeout: 15000 })

const placeCurve = (page) => page.evaluate(() => {
  window.__oip.store.enterPackageEdit('oip.curved-conveyor')
  return window.__oip.store.getState().packageEdit?.partId ?? null
})

// Visual-latency probe. The GPU audit above shows the right texture is bound; it cannot show the
// screen displays it. Under render bundles a recorded bind group replays the old texture until something
// re-records, so the weave can stay visually stale for as long as the scene is otherwise idle.
//
// Discriminator: the fraction of vividly green pixels (g - r > 25). The arrows fabric is saturated
// green; nothing else in the scene (grey floor, blue-grey steel) comes close, so this reads ~0 on the
// plain weave and clearly positive on the arrows. A whole-frame mean would not work: the belt is too
// small a slice of the viewport to move it reliably. The belt's scroll doesn't change the count, only the
// weave does. Sampling runs in a self-rescheduling rAF (drawing buffer still valid, no scene
// interaction), deliberately not via cleanShot, whose deselect + DOM hide would itself force the
// re-record and mask exactly the bug this measures.
const installHueProbe = (page) => page.evaluate(() => {
  const canvas = window.__oip.view.renderer.domElement
  const probe = document.createElement('canvas')
  probe.width = 160; probe.height = 100
  const ctx = probe.getContext('2d', { willReadFrequently: true })
  window.__hue = { v: null, frames: 0 }
  const tick = () => {
    try {
      ctx.drawImage(canvas, 0, 0, probe.width, probe.height)
      const d = ctx.getImageData(0, 0, probe.width, probe.height).data
      let green = 0
      const n = d.length / 4
      for (let i = 0; i < d.length; i += 4) if (d[i + 1] - d[i] > 25) green++
      window.__hue.v = green / n
      window.__hue.frames++
    } catch { /* transient read failure */ }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})

const hue = (page) => page.evaluate(() => window.__hue)

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
  // the symptom, caught at the source: any destroyed-texture / validation error from the WebGPU backend
  const gpuErrors = []
  page.on('console', (m) => {
    const t = m.text()
    if (/GPUValidationError|Destroyed texture|Uncaptured WebGPU/i.test(t)) gpuErrors.push(t.split('\n')[0])
  })
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

    const partId = await placeCurve(page)
    check('curved conveyor placed (enterPackageEdit)', !!partId)
    if (!partId) return

    // Run the sim so the render loop keeps submitting frames across each flip; a parked loop would
    // never replay the command buffers that hold the stale reference, hiding the bug.
    await page.evaluate(() => window.__oip.controller.run())
    await waitForBeltTex(page, 'BeltFabric.jpg', 1024)
    const base = await page.evaluate(() => window.__oip.view.auditGpuTextures())
    check('audit sees textures (non-vacuous)', base.checked > 0, `${base.checked} checked`)

    // several round trips: the destroyed-texture submit is a race against in-flight command buffers,
    // so one flip can miss it (though a dispose-on-swap shows on the first flip of a cold run)
    for (let i = 0; i < 3; i++) {
      await flipWeave(page, partId, 'alternate')
      await waitForBeltTex(page, 'BeltFabricArrows.jpg', 512)
      await flipWeave(page, partId, 'standard')
      await waitForBeltTex(page, 'BeltFabric.jpg', 1024)
    }
    check('weave swaps still reach the GPU at both sizes (3 round trips)', true)

    const final = await page.evaluate(() => window.__oip.view.auditGpuTextures())
    check('audit clean after the flips', final.mismatches.length === 0, JSON.stringify(final.mismatches))
    check('no WebGPU validation / destroyed-texture errors', gpuErrors.length === 0, gpuErrors.slice(0, 4).join(' | '))

    // ...and that the swap reaches the screen, not just the bind group. Nothing touches the scene
    // between the flip and the measurement, so only the weave rebind can move the hue.
    //
    // Stop the sim first: this is the state a user actually edits in, and it's the state that exposes
    // the staleness. While the sim runs, every frame counts as scene activity and the bundle replay
    // refreshes bindings anyway, so a missing re-record notify stays invisible. A weave change is not
    // a geometry change, so functionMesh reconciles it without a structural bump of its own.
    await page.evaluate(() => window.__oip.controller.stop())
    await new Promise((r) => setTimeout(r, 1500)) // let the render loop park
    await installHueProbe(page)
    await page.waitForFunction(() => window.__hue.frames > 8, null, { timeout: 10000 })
    const before = (await hue(page)).v
    const t0 = Date.now()
    await flipWeave(page, partId, 'alternate')
    let latency = null
    try {
      await page.waitForFunction((b) => window.__hue.v > b + 0.005, before, { timeout: 8000 })
      latency = Date.now() - t0
    } catch { /* never became visible */ }
    const after = (await hue(page)).v
    const pct = (x) => `${(x * 100).toFixed(2)}%`
    console.log(`  green-pixel share: ${pct(before)} → ${pct(after)}; visible after ${latency === null ? 'NEVER (>8s)' : latency + 'ms'}`)
    check('the new weave becomes VISIBLE (green arrows appear)', latency !== null, `${pct(before)} → ${pct(after)}`)
    // An idle scene must not sit on the old weave: the rebind has to carry its own bundle re-record.
    check('...promptly, without any further interaction (<1.5 s)', latency !== null && latency < 1500, `${latency}ms`)

    // WebGL leg: the same code rebinds material.map there, and the other weave gate is WebGPU-only,
    // so check that the swap still takes on the WebGL path at all.
    const gl = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    try {
      await gl.goto(`${url}?nowebgpu`)
      await gl.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 30000 })
      const glPart = await placeCurve(gl)
      check('WebGL: curved conveyor placed', !!glPart)
      if (glPart) {
        await waitForBeltMap(gl, 'BeltFabric.jpg')
        await flipWeave(gl, glPart, 'alternate')
        await waitForBeltMap(gl, 'BeltFabricArrows.jpg')
        await flipWeave(gl, glPart, 'standard')
        await waitForBeltMap(gl, 'BeltFabric.jpg')
        check('WebGL: weave swap rebinds material.map both ways', true)
      }
    } finally {
      await gl.close().catch(() => {})
    }
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
