// The per-slot tint cache in SimBoxes.apply (boxColorSrc/palletColorSrc) skips setColorAt when a
// slot's source rgb is unchanged, which keeps the sRGB→linear transform out of the per-body loop. That is sound only if instanceColor always holds the conversion of exactly the rgb the cache
// recorded - so this asserts the live buffer against a from-scratch conversion of the frame that
// produced it. A stale-cache bug (wrong tint, or cargo stuck white after a re-mint) fails here.
//
// Three states, each a different edge:
//   1. running steady state - the cache hits on every row (its purpose); rows must be right
//   2. changed source rgb - must miss the cache and re-upload
//   3. capacity re-mint - instanceColor comes back all-white, so the cache must be dropped
//
// 2 and 3 drive apply() directly with a cloned frame, synchronously inside one evaluate, so the
// worker's next real frame cannot land between the write and the assert.
/* global process, console, window, localStorage */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'

const { port, vite } = await startServer()
const browser = await chromium.launch({
  headless: false,
  args: ['--disable-features=CalculateNativeWinOcclusion', '--enable-unsafe-webgpu'],
})
let failed = false
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.goto(`http://localhost:${port}/app/?scene=demo`, { timeout: 90000 })
  await page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 60000 })
  await page.waitForTimeout(2500)

  // shared helpers installed once: a frame tap, and the buffer-vs-expected comparison
  await page.evaluate(() => {
    const view = window.__oip.view
    const boxes = view.boxes
    const proto = Object.getPrototypeOf(boxes).apply
    window.__applyDirect = (frame) => proto.call(boxes, frame)
    boxes.apply = function tap(frame) { window.__lastFrame = frame; return proto.call(this, frame) }
    let Col = null
    view.scene.traverse((o) => { if (!Col && o.isLight && typeof o.color?.setRGB === 'function') Col = o.color.constructor })
    window.__ColorCtor = Col
    // Re-derives every live row's expected linear rgb from `frame` and compares against what is
    // actually in instanceColor. Same three Color + SRGBColorSpace path apply() uses, so this
    // checks the cache, not the colour maths.
    window.__checkTints = (frame) => {
      const Colr = window.__ColorCtor
      if (!Colr) return { ok: false, reason: 'no three Color reachable' }
      if (!frame) return { ok: false, reason: 'no frame' }
      const probe = new Colr()
      let bi = 0
      let pl = 0
      const bad = []
      for (let i = 0; i < frame.count; i++) {
        const pi = i * 3
        const isPallet = frame.kinds[i] === 1 // CARGO_KIND_PALLET (core/frame.ts)
        const mesh = isPallet ? boxes.palletMesh : boxes.mesh
        const row = isPallet ? pl++ : bi++
        probe.setRGB(frame.colors[pi], frame.colors[pi + 1], frame.colors[pi + 2], 'srgb')
        const arr = mesh.instanceColor.array
        const o = row * 3
        const d = Math.max(Math.abs(arr[o] - probe.r), Math.abs(arr[o + 1] - probe.g), Math.abs(arr[o + 2] - probe.b))
        if (d > 1e-5) {
          bad.push(
            `${isPallet ? 'pallet' : 'box'} row ${row}: buffer(${arr[o].toFixed(4)},${arr[o + 1].toFixed(4)},${arr[o + 2].toFixed(4)})` +
              ` != expected(${probe.r.toFixed(4)},${probe.g.toFixed(4)},${probe.b.toFixed(4)})`,
          )
        }
      }
      return { ok: bad.length === 0, bodies: frame.count, boxes: bi, pallets: pl, bad: bad.slice(0, 4) }
    }
    // shallow clone with an independent colors array, so a perturbation can't leak into the real stream
    window.__cloneFrame = (f) => ({ ...f, colors: Float32Array.from(f.colors) })
  })

  const results = []
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForTimeout(9000) // spawners fill the line; the cache is hitting at steady state

  results.push({ label: '1. running steady state (cache hitting)', ...(await page.evaluate(() => window.__checkTints(window.__lastFrame))) })

  results.push({
    label: '2. changed source rgb (must miss cache)',
    ...(await page.evaluate(() => {
      const f = window.__cloneFrame(window.__lastFrame)
      // perturb every body to a distinctly different tint
      for (let i = 0; i < f.count; i++) {
        const pi = i * 3
        f.colors[pi] = 0.93
        f.colors[pi + 1] = 0.11
        f.colors[pi + 2] = 0.57
      }
      window.__applyDirect(f)
      return window.__checkTints(f)
    })),
  })

  results.push({
    label: '3. capacity re-mint (cache must drop)',
    ...(await page.evaluate(() => {
      const boxes = window.__oip.view.boxes
      const f = window.__cloneFrame(window.__lastFrame)
      boxes.capacity = 0 // ensureCapacity re-mints both meshes → fresh all-white instanceColor
      window.__applyDirect(f)
      return window.__checkTints(f)
    })),
  })

  // restore the real stream and let a few genuine frames land, then assert once more -
  // catches a cache left stale by the direct apply() calls above
  await page.evaluate(() => { delete window.__oip.view.boxes.apply })
  await page.waitForTimeout(2000)
  await page.evaluate(() => {
    const boxes = window.__oip.view.boxes
    const proto = Object.getPrototypeOf(boxes).apply
    boxes.apply = function tap(frame) { window.__lastFrame = frame; return proto.call(this, frame) }
  })
  await page.waitForTimeout(1500)
  results.push({ label: '4. back on the live frame stream', ...(await page.evaluate(() => window.__checkTints(window.__lastFrame))) })

  await cleanShot(page, 'e2e/out/cargo-tint-cache.png')

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}` + (r.bodies !== undefined ? `  [${r.bodies} bodies: ${r.boxes} box / ${r.pallets} pallet]` : ''))
    if (!r.ok) {
      failed = true
      if (r.reason) console.log(`      ${r.reason}`)
      for (const b of r.bad ?? []) console.log(`      ${b}`)
    }
  }
  console.log('\nshot: e2e/out/cargo-tint-cache.png')
} finally {
  await browser.close()
  vite.kill()
}
process.exit(failed ? 1 : 0)
