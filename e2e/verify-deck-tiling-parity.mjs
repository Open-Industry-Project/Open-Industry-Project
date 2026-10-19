/* global console, process, window, localStorage */
// Deck tiling must survive the merge mechanisms, and read the same on both backends.
//
// A deck surface (common.ts createDeckSurface) carries its tiling in a per-material uniform, so a
// 13.5 m catwalk and a 0.6 m stair tread are the same material shape over the same shared texture
// pair, differing only in a Vector2 nothing else in the render identity can see. instancePool
// merges by that identity, so unless tiling is part of it, every deck in the scene hashes
// identically and collapses into one bank, which draws them all at the first deck's tiling.
// Measured on the demo with that bug: WebGL drew the 13.5 m catwalk at repeat (2, 4.02) instead of
// (27, 3.8), i.e. 13x too coarse, while WebGPU (whose node materials never collided) drew it
// correctly. That explains the whole report "WebGL shows the tread pattern, WebGPU washes out to
// flat white": the backends disagreed because one of them was wrong.
//
// The bug is invisible to a pixel diff: BuildingFloor.webp is near-featureless noise, so a 13x
// tiling error changes well under 2% of pixels and reads as ordinary backend aliasing. So this gate
// asserts the structure instead, which is exact and content-independent.
//
// Three checks:
//  1. No deck is drawn at another deck's tiling: the set of distinct tilings among deck sources must
//     equal the set actually drawn. A bank that collapses three tilings into one shrinks the drawn
//     set, and this fails. This is the check that catches the regression.
//  2. Both backends agree: same drawn tiling set under WebGL and WebGPU. Skipped (not failed)
//     where no WebGPU adapter is available, like the other webgpu gates.
//  3. Identical decks still merge: the fix must split banks by tiling, not disable pooling. Two
//     same-size platforms must still collapse to one drawable; two different-size ones must not.
//     Without this, refusing to pool decks at all would also keep the gate green.
//
// Run: node e2e/verify-deck-tiling-parity.mjs
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port: PORT, vite } = await startServer()
let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch {} }
  return null
}

/**
 * Every deck drawable in the scene, split by the pool's own bookkeeping: instancePool tags each
 * mesh it swallows with `userData.poolHidden`, so a source is a tagged mesh and a drawn deck is
 * any other. Not keyed on `.visible` up the parent chain - under WebGPU the decks
 * hang off a BundleGroup and the staged reveal toggles visibility while the scene settles, which
 * makes an ancestor walk read differently frame to frame for reasons that have nothing to do with
 * tiling. A tiling is reported as "x,y" to 0.01: setExtent derives it from metre dimensions, so
 * exact float equality across a rebuild is not something to lean on.
 */
const CENSUS = () => {
  const v = window.__oip.view
  const key = (r) => `${r.x.toFixed(2)},${r.y.toFixed(2)}`
  const drawn = new Set()
  const sources = new Set()
  let drawables = 0
  v.scene.traverse((o) => {
    const list = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
    for (const m of list) {
      const rep = m?.userData?.deckRepeat
      if (!rep) continue
      if (o.userData.poolHidden === true) sources.add(key(rep))
      else { drawn.add(key(rep)); drawables++ }
    }
  })
  return {
    backend: v.renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl',
    drawn: [...drawn].sort(),
    sources: [...sources].sort(),
    drawables,
  }
}

/**
 * CENSUS once the merge mechanisms have stopped moving. The pool bakes on its own schedule (a few
 * seconds later under WebGPU than WebGL), and sampling mid-bake reads a scene that is half-merged
 * - which is a harness artifact, not a finding. Poll until two consecutive samples agree.
 */
async function settledCensus(page) {
  let prev = ''
  for (let i = 0; i < 20; i++) {
    const c = await page.evaluate(CENSUS)
    const now = JSON.stringify([c.drawn, c.sources, c.drawables])
    if (now === prev) return c
    prev = now
    await page.waitForTimeout(1500)
  }
  return page.evaluate(CENSUS)
}
async function open(browser, query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  await page.goto(`http://localhost:${PORT}/app/?scene=demo&${query}`)
  await page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 90000 })
  await page.waitForFunction(() => window.__oip.view.stagedReveal === false, { timeout: 90000 }).catch(() => {})
  await page.waitForTimeout(4000)
  return page
}

// two platforms, either the same size (must merge) or different (must not)
const PAIR = (sameSize) => ({
  parts: [
    { id: 'a', type: 'part', packageId: 'oip.platform', position: [0, 1, 0], rotationY: 0, params: { length: 2, width: 2, height: 1 } },
    { id: 'b', type: 'part', packageId: 'oip.platform', position: [0, 1, 6], rotationY: 0, params: { length: sameSize ? 2 : 13.5, width: sameSize ? 2 : 1.9, height: 1 } },
  ],
})

async function main() {
  const browser = await launch()
  if (!browser) { console.log('no browser available'); process.exit(2) }
  const results = {}
  try {
    for (const [label, query] of [['webgl', 'nowebgpu'], ['webgpu', 'webgpu']]) {
      const page = await open(browser, query)
      const c = await settledCensus(page)
      if (c.backend !== label) {
        console.log(`SKIP  ${label}: got the ${c.backend} backend instead (no adapter?)`)
        await page.close()
        continue
      }
      results[label] = c
      console.log(`\n${label}: ${c.drawables} deck drawables, tilings drawn ${JSON.stringify(c.drawn)}, pooled-away sources ${JSON.stringify(c.sources)}`)

      // 1. every tiling a source asked for must actually reach the screen
      const missing = c.sources.filter((s) => !c.drawn.includes(s))
      check(`${label}: no deck is drawn at another deck's tiling`, missing.length === 0,
        missing.length ? `tilings swallowed by a merge: ${JSON.stringify(missing)}` : `${c.drawn.length} distinct tilings, all drawn`)

      // 3. the merge must still happen for decks that genuinely match
      for (const sameSize of [true, false]) {
        await page.evaluate((s) => window.__oip.store.loadScene(s), PAIR(sameSize))
        const p = await settledCensus(page)
        const info = `${p.drawables} drawables, tilings ${JSON.stringify(p.drawn)}`
        if (!sameSize) {
          check(`${label}: two DIFFERENT-SIZE platforms stay apart`, p.drawables === 2 && p.drawn.length === 2, info)
        } else if (label === 'webgl') {
          check(`${label}: two IDENTICAL platforms still merge`, p.drawables === 1, info)
        } else {
          // Reported, not enforced. Cross-part decks don't merge on WebGPU: materialKey folds in
          // customProgramCacheKey, and a node material mints a per-instance one (measured: two
          // identical decks key as MeshStandardNodeMaterial2706942765631224 vs ...1834879372241197),
          // so two decks never share a bank however identical they are. Same class as the pipeline
          // duplication common.ts solves by handing one shared node material to every consumer of a
          // static spec. Decks are excluded from that because each carries its own tiling uniform,
          // though same-tiling decks could share one. That is separate work, outside what this gate
          // covers, so enforcing it here would fail for an unrelated reason.
          console.log(`note  ${label}: two identical platforms do NOT merge (${info}) - node materials never share a merge key; WebGL merges them`)
        }
      }
      await page.close()
    }

    // 2. the two backends must agree on what is on screen
    if (results.webgl && results.webgpu) {
      const a = JSON.stringify(results.webgl.drawn)
      const b = JSON.stringify(results.webgpu.drawn)
      check('WebGL and WebGPU draw the same deck tilings', a === b, a === b ? a : `webgl ${a} vs webgpu ${b}`)
    } else {
      console.log('SKIP  cross-backend comparison - only one backend was available')
    }
  } finally {
    await browser.close().catch(() => {})
    vite.kill('SIGTERM')
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures ? 1 : 0)
}

main().catch((err) => { console.error('verify crashed:', err); process.exit(2) })
