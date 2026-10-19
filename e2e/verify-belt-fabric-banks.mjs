/* global console, process, window, Image, OffscreenCanvas */
// Verify the instanced belt fabric bed (beltFabricBank.ts + examples/parts/belt-conveyor/part.js bed banks):
//
//   1. POOLING - three straight belts' fabric banks merge into scene-global pool copies carrying the
//      fabricUv/fabricScroll per-instance attributes; the per-part sources are hidden.
//   2. SCROLL PARITY - while running, each belt's bed scrolls at its own speed through the one shared
//      material (the class of bug where a shared refresh lets only the first-drawn belt animate):
//      pixels over a speed-1 and a speed-2.5 belt must change frame-to-frame, a speed-0 belt must not.
//      At the data level `fabricScroll` is vec2 [base, rate] and the shader integrates it against the
//      shared belt clock, so the buffer must hold per-belt rates and must not be rewritten per frame.
//   3. SELECTION - under deferred ejection (viewPool.ts poolExempt) selecting a belt doesn't move pool
//      membership, so its banks stay pooled (the outline masks them via the aSel channel) and the bed
//      keeps scrolling through the same shared material.
//   4. STOP freeze - after controller.stop() every bed freezes (sim-clock discipline).
//   5. DRAW SCALING - adding 3 more belts adds ~no draw calls (every bank, fabric included, pools).
//
// The belts live in the normal scene (the package-edit harness hides non-draft parts, so nothing would
// pool there); the template part is captured once via enterPackageEdit, then cloned after a reload.
// Pixel sampling goes through page.screenshot (the WebGPU canvas reads back blank via createImageBitmap).
//
// Runs WebGPU by default; `--webgl` forces the WebGL path (`?nowebgpu`) to exercise the GLSL patch.
// Run: node e2e/verify-belt-fabric-banks.mjs [--webgl] [--headed]
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const WEBGL = process.argv.includes('--webgl')
const HEADED = process.argv.includes('--headed')

async function launchBrowser() {
  if (WEBGL) return chromium.launch({ headless: !HEADED })
  for (const opts of [
    { channel: 'msedge', headless: !HEADED, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: !HEADED, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch {} }
  return null
}

// mean |Δ| per byte between two clipped screenshots, decoded in-page (Playwright PNGs → ImageData)
async function scrollDiff(page, rect, settleMs = 450) {
  const clip = { x: rect.x, y: rect.y, width: rect.w, height: rect.h }
  const a = await page.screenshot({ clip })
  await page.waitForTimeout(settleMs)
  const b = await page.screenshot({ clip })
  return page.evaluate(async ([b64a, b64b]) => {
    const decode = async (b64) => {
      const img = new Image()
      img.src = 'data:image/png;base64,' + b64
      await img.decode()
      const c = new OffscreenCanvas(img.width, img.height)
      const ctx = c.getContext('2d')
      ctx.drawImage(img, 0, 0)
      return ctx.getImageData(0, 0, img.width, img.height).data
    }
    const [da, db] = await Promise.all([decode(b64a), decode(b64b)])
    let sum = 0
    const n = Math.min(da.length, db.length)
    for (let i = 0; i < n; i++) sum += Math.abs(da[i] - db[i])
    return sum / n
  }, [a.toString('base64'), b.toString('base64')])
}

// screen-space rect over a belt's bed: project the part-root origin (the bed's top surface passes
// through it) through the live camera
const bedRect = (page, partId) =>
  page.evaluate((id) => {
    const view = window.__oip.view
    let root = null
    view.scene.traverse((o) => { if (!root && o.userData?.partId === id) root = o })
    if (!root) return null
    const v = root.position.clone()
    v.project(view.camera)
    const canvas = document.querySelector('canvas')
    const r = canvas.getBoundingClientRect()
    return {
      x: Math.max(0, Math.round(r.left + (v.x * 0.5 + 0.5) * r.width) - 60),
      y: Math.max(0, Math.round(r.top + (-v.y * 0.5 + 0.5) * r.height) - 20),
      w: 120, h: 40,
    }
  }, partId)

async function main() {
  const browser = await launchBrowser()
  if (!browser) { console.log('SKIP: no suitable browser'); return }
  const { url, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch {} })
  const fails = []
  const check = (label, cond, detail = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${detail ? ` - ${detail}` : ''}`)
    if (!cond) fails.push(label)
  }
  try {
    const q = WEBGL ? '?nowebgpu' : '?webgpu'
    await page.goto(`${url}${q}`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
    const isWebGPU = await page.evaluate(() => !!window.__oip.view.renderer.isWebGPURenderer)
    if (!WEBGL && !isWebGPU) { console.log('SKIP: WebGPU not active'); return }
    console.log(`backend: ${isWebGPU ? 'WebGPU' : 'WebGL'}`)

    // capture a schema-true belt part via package edit, then return to the normal scene
    const template = await page.evaluate(() => {
      window.__oip.store.enterPackageEdit('oip.belt-conveyor')
      const p = window.__oip.store.getState().scene.parts.find((x) => x.packageId === 'oip.belt-conveyor')
      return p ? JSON.stringify(p) : null
    })
    check('belt template captured', !!template)
    if (!template) return
    await page.goto(`${url}${q}`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
    await page.waitForTimeout(1200)

    // three belts in the normal scene: speed 1 / 2.5 / 0, spread along z
    const ids = await page.evaluate((tpl) => {
      const s = window.__oip.store
      const scene = s.getState().scene
      const mk = (id, dz, speed) => {
        const p = JSON.parse(tpl)
        // rest the legs on the floor: the harness template stages the part at y=0 (bed at floor level,
        // hidden under the floor plane) - lift the deck to standHeight like a real placement would
        const y = typeof p.params.standHeight === 'number' ? p.params.standHeight : 0.75
        return { ...p, id, name: id, position: [p.position[0], y, (p.position[2] ?? 0) + dz], params: { ...p.params, speed } }
      }
      s.commit('fabric-bank-test', { ...scene, parts: [...scene.parts, mk('beltA', 0, 1), mk('beltB', 3, 2.5), mk('beltC', -3, 0)] })
      s.select(null)
      return { a: 'beltA', b: 'beltB', c: 'beltC' }
    }, template)
    await page.waitForTimeout(3500) // geometry build + fabric decode + pool rebuild + pipeline warm
    const partCount = await page.evaluate(() => window.__oip.store.getState().scene.parts.filter((p) => p.packageId === 'oip.belt-conveyor').length)
    check('scene holds 3 belts', partCount === 3, `${partCount}`)

    // 1. POOLING census: pool copies carry the fabric attributes; per-part fabric banks are hidden
    const census = await page.evaluate(() => {
      const view = window.__oip.view
      const out = { poolFabric: [], liveFabric: { visible: 0, hidden: 0 } }
      view.scene.traverse((o) => {
        if (o.isInstancedMesh && o.geometry?.attributes?.fabricScroll) {
          if (o.userData.instancePool === true) out.poolFabric.push(o.count)
          else if (o.visible) out.liveFabric.visible++
          else out.liveFabric.hidden++
        }
      })
      return out
    })
    check('fabric pools exist (band + wrap)', census.poolFabric.length === 2, JSON.stringify(census.poolFabric))
    check('pools hold all 12 bed instances', census.poolFabric.reduce((a, b) => a + b, 0) === 12, JSON.stringify(census.poolFabric))
    check('per-part fabric banks hidden', census.liveFabric.visible === 0 && census.liveFabric.hidden === 6, JSON.stringify(census.liveFabric))

    // 2. SCROLL PARITY while running - first at the data level (the pool's merged fabricScroll buffer
    // must carry per-belt values that advance), then at the pixel level with the camera framed on each bed
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForTimeout(1800)
    const poolScroll = () =>
      page.evaluate(() => {
        let best = null
        window.__oip.view.scene.traverse((o) => {
          if (o.isInstancedMesh && o.userData.instancePool === true && o.geometry?.attributes?.fabricScroll) {
            const a = o.geometry.attributes.fabricScroll
            if (!best || o.count > best.count) best = { count: o.count, itemSize: a.itemSize, values: Array.from(a.array.slice(0, o.count * a.itemSize)) }
          }
        })
        return best
      })
    const s1 = await poolScroll()
    await page.waitForTimeout(600)
    const s2 = await poolScroll()
    check('pool scroll buffer present', !!s1 && !!s2 && s1.count === 6)
    if (s1 && s2) {
      check('pooled scroll is vec2 [base, rate]', s1.itemSize === 2 && s1.values.length === 12, `itemSize ${s1.itemSize}, ${s1.values.length} floats`)
      // the point of the shader-integrated scroll: the shared clock uniform moves the beds, so a
      // running belt must not rewrite its instance buffer per frame - these samples are identical
      const churned = s2.values.filter((v, i) => v !== s1.values[i]).length
      check('running belts do not rewrite the scroll buffer per frame', churned === 0, `${churned} floats churned`)
      const rates = s2.values.filter((_, i) => i % 2 === 1)
      const moving = rates.filter((r) => Math.abs(r) > 1e-4).length
      const stillZero = rates.filter((r) => r === 0).length
      const distinct = new Set(rates.map((r) => r.toFixed(4))).size
      check('running belts carry a pooled scroll rate (4 of 6 instances)', moving === 4, `moving ${moving}`)
      check('speed-0 belt scroll rate stays 0 (2 instances)', stillZero === 2, `${stillZero}`)
      check('per-belt scroll rates are independent', distinct >= 3, `${distinct} distinct`)
    }
    const scrollAt = async (id) => {
      await page.evaluate((pid) => window.__oip.view.focusOn([pid]), id)
      await page.waitForTimeout(1000) // focus ease-in settles
      const rect = await bedRect(page, id)
      return rect ? scrollDiff(page, rect) : -1
    }
    const dA = await scrollAt(ids.a)
    const dB = await scrollAt(ids.b)
    const dC = await scrollAt(ids.c)
    check('speed-1 belt scrolls (pooled)', dA > 0.15, `diff ${dA.toFixed(2)}`)
    check('speed-2.5 belt scrolls (pooled, own speed)', dB > 0.15, `diff ${dB.toFixed(2)}`)
    check('speed-0 belt is still', dC >= 0 && dC < 0.1, `diff ${dC.toFixed(2)}`)

    // 3. SELECTION: the selected belt stays pooled (deferred ejection) and keeps scrolling
    await page.evaluate((id) => { window.__oip.view.focusOn([id]); window.__oip.store.select(id) }, ids.a)
    await page.waitForTimeout(1000)
    const liveVis = await page.evaluate(() => {
      let vis = 0
      window.__oip.view.scene.traverse((o) => {
        if (o.isInstancedMesh && o.geometry?.attributes?.fabricScroll && o.userData.instancePool !== true && o.visible) vis++
      })
      return vis
    })
    check('selected belt stays pooled (no live banks)', liveVis === 0, `${liveVis}`)
    const rectSel = await bedRect(page, ids.a)
    const dSel = rectSel ? await scrollDiff(page, rectSel) : -1
    check('selected belt keeps scrolling', dSel > 0.15, `diff ${dSel.toFixed(2)}`)
    await page.evaluate(() => window.__oip.store.select(null))

    // 4. STOP freezes every bed
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(800)
    const rectB = await bedRect(page, ids.b)
    const dStop = rectB ? await scrollDiff(page, rectB) : -1
    check('stop freezes the fabric', dStop >= 0 && dStop < 0.1, `diff ${dStop.toFixed(2)}`)

    // 5. DRAW SCALING: +3 belts ≈ +0 draws (fabric included - every bank pools). The incremental
    // pipeline warm holds fresh parts hidden through the commit's own pool rebuild, so force one more
    // rebuild (select/deselect) after the warm settles before measuring - same as any later user click.
    const draws3 = await page.evaluate(() => window.__oip.view.getStats().drawCalls)
    await page.evaluate((tpl) => {
      const s = window.__oip.store
      const scene = s.getState().scene
      const mk = (id, dz) => {
        const p = JSON.parse(tpl)
        const y = typeof p.params.standHeight === 'number' ? p.params.standHeight : 0.75
        return { ...p, id, name: id, position: [p.position[0], y, (p.position[2] ?? 0) + dz] }
      }
      s.commit('more-belts', { ...scene, parts: [...scene.parts, mk('beltD', 6), mk('beltE', -6), mk('beltF', 9)] })
    }, template)
    await page.waitForTimeout(3000)
    await page.evaluate(() => { window.__oip.store.select('beltD'); window.__oip.store.select(null) })
    await page.waitForTimeout(800)
    const draws6 = await page.evaluate(() => window.__oip.view.getStats().drawCalls)
    check('3→6 belts adds ~no draws', draws6 - draws3 <= 8, `${draws3} → ${draws6} (Δ${draws6 - draws3})`)
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
