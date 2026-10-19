// WebGPU resource-lifetime guard, gesture 2: sliding a snapped part along its host must not raise a
// single uncaptured GPU error, and must not blacken the viewport.
//
// verify-webgpu-resize-no-gpu-errors.mjs covers a resize drag (one part re-emitting its own
// geometry). This covers the other shape, which that gate does not reach: a merge drag. Butting a
// spur onto a conveyor and sliding it along re-emits the host's geometry per pointer-move (guard
// openings) while the mover is drag-ejected from the bundles, and it ends with the draw list going
// quiet, so a resource freed under a live recording has nothing left to replace it. The result is a
// permanent black viewport: the main + shadow command buffers are rejected every frame from the
// end of the drag onward ("[Buffer (unlabeled)] used in submit while destroyed" on renderContext_0
// and _2), while the unbundled wall/overlay passes keep drawing the outline and gizmo over black.
//
// Waiting for a completed re-record before freeing is not enough: three re-records per (group,
// camera, renderContext) lazily, so the record it waits on can be one that still encodes the
// resource. src/render/gpuRetire.ts therefore also notifies after any release. This asserts the outcome:
// zero new uncaptured errors, and a viewport as bright at the end of the gesture as at the start.
//
// SKIPs (does not fail) where WebGPU isn't available: no device to validate, no bundles to break.
// Run: node e2e/verify-webgpu-spur-slide-no-gpu-errors.mjs [--headed]
/* global process, console, window, localStorage, document, Image */
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const HEADED = process.argv.includes('--headed')
const STEPS = 20
const METRES = 5 // slide distance along the host

let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

async function launchWebGPU() {
  for (const opts of [
    { channel: 'msedge', headless: !HEADED, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: !HEADED, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch { /* next */ } }
  return null
}

// `installed: false` matters as much as the count: a watch that never attached would make the
// error assertions vacuous, and with nothing listening to the device this failure class is invisible
const gpuErrors = (page) => page.evaluate(() => {
  const r = globalThis.__oipGpuErrors
  if (!r) return { installed: false, count: 0, distinct: [] }
  return { installed: true, count: r.count, distinct: r.distinct.map((d) => `${d.message} (x${d.count})`) }
})

// mean luminance of the canvas. The direct symptom: a rejected command buffer loses the whole main
// pass, so the frame darkens to the unbundled wall/overlay passes alone. Screenshot the canvas rect
// rather than cleanShot(): deselecting would tear down the gizmo this gesture drags.
async function meanLuminance(page, dir, name) {
  const file = join(dir, `${name}.png`)
  const rect = await page.evaluate(() => {
    const r = window.__oip.view.renderer.domElement.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  await page.screenshot({ path: file, clip: rect })
  const b64 = (await readFile(file)).toString('base64')
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let sum = 0
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    return +(sum / (d.length / 4)).toFixed(2)
  }, b64)
}

/** screen point of the gizmo translate handle for `axis`, searched outward from the part origin */
const handleAt = (page, axis) => page.evaluate((axis) => {
  const { view, store } = window.__oip
  const p = store.getState().scene.parts.find((q) => q.id === 'spur')
  view.camera.updateMatrixWorld(true)
  const c0 = view.worldToScreen(p.position[0], p.position[1], p.position[2])
  const along = axis === 'x'
    ? view.worldToScreen(p.position[0] + 1, p.position[1], p.position[2])
    : view.worldToScreen(p.position[0], p.position[1], p.position[2] + 1)
  const dir = { x: along.x - c0.x, y: along.y - c0.y }
  const px = Math.hypot(dir.x, dir.y) || 1
  dir.x /= px; dir.y /= px
  // the transform gizmo's rings are screen-constant, so walk out until the axis handle picks
  for (let r = 10; r <= 300; r += 4) {
    for (const s of [1, -1]) {
      for (let perp = -16; perp <= 16; perp += 8) {
        const x = c0.x + dir.x * r * s - dir.y * perp
        const y = c0.y + dir.y * r * s + dir.x * perp
        if (view.pickGizmoHandle(x, y) === axis) return { x, y, dir, px }
      }
    }
  }
  return null
}, axis)

async function main() {
  const browser = await launchWebGPU()
  if (!browser) { console.log('SKIP: no chromium/WebGPU browser available'); return }
  const { port, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const shotDir = mkdtempSync(join(tmpdir(), 'oip-spur-slide-'))
  try {
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ } })
    await page.goto(`http://localhost:${port}/app/?webgpu`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 40000 })
    if (!(await page.evaluate(() => !!window.__oip.view.renderer.isWebGPURenderer))) {
      console.log('SKIP: WebGPU renderer not active (fell back to WebGL)')
      return
    }

    // host conveyor along X + a spur offset from its side, ready to be butted in
    const setup = await page.evaluate(() => {
      const { store, getPackage } = window.__oip
      const hostPkg = getPackage('oip.roller-conveyor')
      const spurPkg = getPackage('oip.spur-conveyor')
      if (!hostPkg || !spurPkg) return { ok: false, reason: 'conveyor packages not registered' }
      const defs = (pkg) => {
        const o = {}
        for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) o[k] = spec.default
        return o
      }
      store.loadScene({
        version: store.getState().scene.version,
        parts: [
          { id: 'host', type: 'part', packageId: 'oip.roller-conveyor', position: [0, 0.75, 0], rotationY: 0, name: 'host',
            params: { ...defs(hostPkg), length: 8, width: 1.524, speed: 0.5, standHeight: 0.75 } },
          { id: 'spur', type: 'part', packageId: 'oip.spur-conveyor', position: [-1.0, 0.75, 1.6], rotationY: Math.PI / 2, name: 'spur',
            params: { ...defs(spurPkg), length: 2, width: 1.524, speed: 0.5, angleFrontDeg: 30, angleBackDeg: 0, standHeight: 0.75 } },
        ],
        packages: [hostPkg, spurPkg],
      })
      store.setSpace('global')
      store.setTool('move')
      store.select('spur')
      const view = window.__oip.view
      view.camera.position.set(-6, 7, 10)
      view.controls.target.set(0, 0.75, 0.5)
      view.controls.update()
      view.camera.updateMatrixWorld(true)
      return { ok: true }
    })
    check('host + spur scene loaded', setup.ok, setup.reason || '')
    if (!setup.ok) return

    // Settle on the scene, not a stopwatch: the staged reveal + pipeline warm finish whenever this
    // machine finishes them, and a baseline sampled mid-reveal is dim for reasons that have nothing
    // to do with this bug (a timed baseline varies between 28 and 79).
    await page.waitForFunction(() => window.__oip?.view?.incrementalWarmReady === true, { timeout: 90000 }).catch(() => {})
    let lumBefore = 0
    for (let i = 0; i < 20; i++) {
      const lum = await meanLuminance(page, shotDir, 'before')
      if (lum > 40 && Math.abs(lum - lumBefore) < 0.5) { lumBefore = lum; break }
      lumBefore = lum
      await page.waitForTimeout(500)
    }
    const before = await gpuErrors(page)
    check('the uncaptured-error watch is installed on the device', before.installed,
      'globalThis.__oipGpuErrors missing - gpuErrorWatch never attached, so every check below would be vacuous')
    check('the viewport is drawing before the gesture', lumBefore > 40, `mean luminance ${lumBefore}`)
    if (before.count > 0) {
      // same known-open load-time race the resize gate documents: three-internal bind-group lifetime,
      // not one of our seams. The assertions below are on the gesture's delta, so it can't mask one.
      console.log(`KNOWN-OPEN  ${before.count} load-time GPU error(s) before the gesture`)
    }

    // --- phase 1: butt the spur onto the host's side (-Z) until the structural snap captures
    const zHandle = await handleAt(page, 'z')
    check('the world Z translate handle is pickable', !!zHandle)
    if (!zHandle) return
    await page.mouse.move(zHandle.x, zHandle.y)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) {
      const m = -(1.2 * i) / 8
      await page.mouse.move(zHandle.x + zHandle.dir.x * m * zHandle.px, zHandle.y + zHandle.dir.y * m * zHandle.px)
      await page.waitForTimeout(60)
    }
    await page.mouse.up()
    await page.waitForTimeout(1200)

    // the merge is the precondition for this gesture: the host must have opened a guard for the spur
    const merged = await page.evaluate(() => {
      const view = window.__oip.view
      const openings = view.lastResolved?.get?.('host')?.openings
      const spans = (openings?.left?.length ?? 0) + (openings?.right?.length ?? 0)
      return { spans, z: window.__oip.store.getState().scene.parts.find((q) => q.id === 'spur').position[2] }
    })
    check('the spur merged into the host (guard opened)', merged.spans > 0,
      `openings=${merged.spans}, spur z=${merged.z.toFixed(2)} - without a merge the slide re-emits nothing and the gate is vacuous`)

    // --- phase 2: the gesture under test: slide the merged spur along the host
    const xHandle = await handleAt(page, 'x')
    check('the world X translate handle is pickable after the merge', !!xHandle)
    if (!xHandle) return
    await page.mouse.move(xHandle.x, xHandle.y)
    await page.mouse.down()
    for (let i = 1; i <= STEPS; i++) {
      const m = (METRES / STEPS) * i
      await page.mouse.move(xHandle.x + xHandle.dir.x * m * xHandle.px, xHandle.y + xHandle.dir.y * m * xHandle.px, { steps: 2 })
      await page.waitForTimeout(80)
    }
    await page.mouse.up()
    // the failure is at the end of the gesture (the draw list goes quiet holding a stale encode),
    // so settle well past mouse-up before judging: this is where the viewport would go black and stay black
    await page.waitForTimeout(2500)

    const slid = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((q) => q.id === 'spur').position[0])
    check('the drag actually slid the spur along the host', slid > -1.0 + 1.0, `x -1.00 -> ${slid.toFixed(2)}`)

    const after = await gpuErrors(page)
    const added = after.count - before.count
    check('the slide raised no new uncaptured GPU errors', added === 0,
      `+${added} during/after the gesture: ${after.distinct.join(' | ')}`)

    const lumAfter = await meanLuminance(page, shotDir, 'after')
    check('the viewport did not go black', lumAfter >= lumBefore * 0.75,
      `mean luminance ${lumBefore} -> ${lumAfter}`)

    const audit = await page.evaluate(() => window.__oip.view.auditMergeCoherence())
    check('merges coherent after the gesture', audit.ok, audit.reason)

    // The structural half of the protection (src/render/geometryRecycle.ts): the re-emits this gesture
    // drives must recycle their buffers, not create replacements. gpuRetire makes a free safe; not
    // freeing at all keeps the hazard from arising in the first place, and nothing visible changes
    // when that stops holding. A re-emit that goes back to creating buffers per pointer-move still
    // renders correctly and is one missed invalidation away from the bug above.
    const recycle = await page.evaluate(() => {
      const r = globalThis.__oipGeoRecycle
      return r ? { ...r } : null
    })
    check('the geometry-recycle tally is exposed', !!recycle, '__oipGeoRecycle missing')
    if (recycle) {
      check('the gesture recycled geometry in place', recycle.inPlace > 0,
        `inPlace=${recycle.inPlace} minted=${recycle.minted} - every re-emit minted a replacement, so the drag is freeing GPU buffers per pointer-move again`)
      console.log(`info  geometry re-emits: ${recycle.inPlace} recycled, ${recycle.minted} minted`)
    }
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
}
main()
