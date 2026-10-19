// WebGPU texture-lifetime guard: the live scene events that destroy a GPUTexture must not raise a
// single uncaptured GPU error, and must not blank the viewport.
//
// Sibling of verify-webgpu-resize-no-gpu-errors.mjs, one resource across. A recorded render bundle
// bakes bind groups, so a `texture.dispose()` on a texture a recording still samples destroys a
// GPUTexture out from under the replay ("Destroyed texture used in a submit"). That is worse than
// the geometry case it mirrors: Dawn rejects the whole command buffer, so every pass in the frame
// draws nothing, not just the bundled main pass. A belt weave swap that disposed its texture blacks
// out the entire scene this way (parts/common.ts createBeltSurface), and it never throws.
//
// Nothing upstream catches it. The stale-recording guard (bundleReplayRefresh.ts) watches
// `bindings.deleteForRender`, which three calls when a material dispose kills a RenderObject. A
// texture dispose leaves the RenderObject and its bindings alive, so `_bindings.has(ro)` still
// answers true and the stale recording replays. `retireTexture()` (gpuRetire.ts) prevents this.
//
// The two live sites this drives, both of them ordinary user actions:
//   1. select-all      -> outlineMaskMerge re-creates its palette DataTexture on capacity growth
//   2. delete parts    -> createBeltSurface / createDeckSurface free their per-part textures
// (A shadow-map resize would be a third. It is not reachable: the resolution is pinned for the
// session, src/render/quality.ts shadowMapSize, because no retire can make a resize safe.)
//
// SKIPs (does not fail) where WebGPU isn't available: the WebGL path has no bundles and no device
// to validate. Run: node e2e/verify-webgpu-texture-retire.mjs [--headed]
/* global process, console, window, localStorage */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const HEADED = process.argv.includes('--headed')

let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

async function launchWebGPU() {
  for (const opts of [
    { channel: 'msedge', headless: !HEADED, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: !HEADED, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch { /* next */ } }
  return null
}

// No draw-count assertions in this script. Under render bundles `renderer.info` is
// replay-dependent and reads differently frame to frame (AGENTS.md): two runs of this very scene,
// same state, reported 23 and 608. A frame whose command buffer was rejected still reports the
// draws it issued, so "draws > 0" stays true while the viewport is black. The GPU-error delta and
// the merge-coherence audit are the signals that actually move.

// `installed: false` matters as much as the count: a watch that never attached would make every
// "no GPU errors" assertion below vacuously true
const gpuErrors = (page) => page.evaluate(() => {
  const r = globalThis.__oipGpuErrors
  if (!r) return { installed: false, count: 0, distinct: [] }
  return { installed: true, count: r.count, distinct: r.distinct.map((d) => `${d.message} (x${d.count})`) }
})

const incoherent = (report) => (report?.checks ?? []).filter((c) => !c.ok).map((c) => `${c.name}: ${c.reason}`)

async function main() {
  const browser = await launchWebGPU()
  if (!browser) { console.log('SKIP: no chromium/WebGPU browser available'); return }
  const { port, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  try {
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ } })
    await page.goto(`http://localhost:${port}/app/?webgpu&scene=demo`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 30000 })
    if (!(await page.evaluate(() => !!window.__oip.view.renderer.isWebGPURenderer))) {
      console.log('SKIP: WebGPU renderer not active (fell back to WebGL)')
      return
    }
    await page.locator('text=Loading models').waitFor({ state: 'hidden', timeout: 60000 }).catch(() => {})
    await page.waitForFunction(() => window.__oip?.view?.incrementalWarmReady === true, { timeout: 90000 }).catch(() => {})
    await page.waitForTimeout(3000)

    const before = await gpuErrors(page)
    check('the uncaptured-error watch is installed on the device', before.installed,
      'globalThis.__oipGpuErrors missing - gpuErrorWatch never attached, so every check below would be vacuous')
    // Same known-open load-time race as the resize gate: three's own bind-group refcount can destroy
    // buffers under a recording during load. Every assertion below is on a delta over this baseline.
    if (before.count > 0) {
      console.log(`KNOWN-OPEN  ${before.count} load-time GPU error(s) - three-internal lifetime race, not a retire regression`)
      console.log(`            ${before.distinct.join('\n            ')}`)
    }

    // ---- 1. select all: the mask-merge palette re-mints (and retires) once past its capacity ----
    const selected = await page.evaluate(() => {
      const st = window.__oip.store
      const ids = st.getState().scene.parts.map((p) => p.id)
      st.selectMany(ids)
      return ids.length
    })
    await page.waitForTimeout(1500)
    const afterSelect = await gpuErrors(page)
    const selectAudit = await page.evaluate(() => window.__oip.view.auditMergeCoherence())
    // Diagnostic only (never an assertion): the palette re-mint fires past INITIAL_SLOTS = 1024, so
    // this says whether the demo is dense enough for select-all to reach it. When it isn't, the
    // re-mint itself is pinned by src/render/viewport/outlineMaskMerge.test.ts instead, and this
    // section still covers the merge's other live path (the rebake's geometry retire).
    const slots = await page.evaluate(() => window.__oip.view.maskMerge?.slotCount ?? -1)
    console.log(`note  selected ${selected} parts; merge baked ${slots} slot(s) (palette re-mints past 1024)`)
    check('select-all raised no new uncaptured GPU errors', afterSelect.count === before.count,
      `+${afterSelect.count - before.count}: ${afterSelect.distinct.join(' | ')}`)
    check('merges coherent after select-all', incoherent(selectAudit).length === 0, incoherent(selectAudit).join(', '))

    // ---- 2. delete a belt conveyor and a deck part: their textures free while the scene runs ----
    // The belt is added first rather than found: createBeltSurface's textures are the known
    // black-screen case, and the demo scene may or may not contain a belt. A
    // "found nothing, deleted nothing" run would pass this section vacuously.
    const added = await page.evaluate(() => {
      const { store: st, getPackage } = window.__oip
      st.clearSelection()
      const pkg = getPackage('oip.belt-conveyor')
      if (!pkg) return null
      const params = {}
      for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
      const scene = st.getState().scene
      const belt = { id: 'texretire-belt', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0.5, -14], rotationY: 0, name: 'RetireBelt', params }
      st.commit('add belt (texture-retire gate)', {
        ...scene,
        parts: [...scene.parts, belt],
        packages: [...(scene.packages ?? []), ...(scene.packages?.some((p) => p.id === pkg.id) ? [] : [pkg])],
      })
      return belt.id
    })
    check('a belt conveyor could be added (its weave textures are the historic black-screen case)', !!added)
    await page.waitForTimeout(2500) // let it build + warm before we tear it back down

    const deleted = await page.evaluate((beltId) => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const deck = scene.parts.find((p) => /platform|stair|deck/i.test(p.packageId))
      const drop = new Set([beltId, deck?.id].filter(Boolean))
      st.commit('delete (texture-retire gate)', { ...scene, parts: scene.parts.filter((p) => !drop.has(p.id)) })
      return { deck: deck?.packageId ?? null, count: drop.size }
    }, added)
    check('both a belt AND a deck part were deleted', deleted.count === 2,
      `dropped ${deleted.count}: belt + ${deleted.deck ?? 'NO DECK PART FOUND'}`)
    await page.waitForTimeout(2000)
    const afterDelete = await gpuErrors(page)
    check('deleting textured parts raised no new uncaptured GPU errors', afterDelete.count === afterSelect.count,
      `+${afterDelete.count - afterSelect.count}: ${afterDelete.distinct.join(' | ')}`)

    // Not driven here: a shadow-quality change. No live path resizes a shadow map. three's own
    // `ShadowNode.renderShadow` re-`setSize`s it on every shadow render and `RenderTarget.setSize`
    // disposes on a change, destroying the `ShadowDepthTexture` that recorded bundles hold by handle,
    // from inside three where no retire can reach. So the resolution never changes at run time: it is
    // a per-client preference resolved once at boot (src/render/quality.ts).
    // `node e2e/probes/shadow-quality-black.mjs` shoots both ends of the range on separate loads and
    // prints each tally, which is the check that design allows.
    const finalAudit = await page.evaluate(() => window.__oip.view.auditMergeCoherence())
    check('merges coherent at the end', incoherent(finalAudit).length === 0, incoherent(finalAudit).join(', '))
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
}

main().then(() => {
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}, (e) => { console.error(e); process.exit(1) })
