// A replayed render bundle must never upload a light camera into its shared uniform groups.
//
// The hazard: three's camera family (`cameraViewMatrix`, `cameraProjectionMatrix`, ...) are
// process-wide singleton uniform nodes in the shared 'render' group, updated render-scope from
// `frame.camera` (three/src/nodes/accessors/Camera.js). A ShadowNode's `updateBefore` runs a
// nested `renderer.render(scene, shadow.camera)`, and `Renderer._renderScene` restores
// `nodeFrame.renderId` but not its camera. So those singletons come back holding the light camera,
// and anything that uploads them afterwards renders the whole bundle from the light's orthographic
// view (the "zoomed-out isometric" flash). bundleReplayRefresh.ts part 2 guards this twice: it
// re-fetches the node frame after a group's before-nodes, and it re-runs the update lists when a
// nested render happened in a later group, because its cam-node set is deduped globally and the
// camera family has exactly one owning group.
//
// What this gate does: it forces a nested shadow render inside the bundle walk on every frame
// (three gates hold that off in ordinary running: NodeFrame.updateBeforeNode's renderId stamp,
// ShadowNode's own `_cameraFrameId.get(camera) === frameId`, and the frozen wall maps), then
// asserts the global cameraViewMatrix node still holds the view camera the moment each view-camera
// bundle has finished replaying. That is the invariant, checked under the condition that breaks it.
//
// Reading the numbers: the unrepaired case needs a shadow node whose first touch in the call is part
// 2's walk, in a group after the camera owner. An unlit first group (baked walls: camera nodes, no
// shadow node) followed by a lit one gives that order, but which group comes first is three's
// render-list sort. In the demo a lit material sorts first, so its group owns the camera and the
// shadow node, and no later group has one. The gate then moves the shadow node to the last group
// (`reordered` counts it), so the hazard is tested whatever the sort does. `DIRTY` must stay 0. With
// the repair disabled (info.calls pinned) every check reads DIRTY: checked to bite.
//
// Run headed:  node e2e/verify-bundle-camera-integrity.mjs
/* global process, console, window, localStorage */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port, vite } = await startServer()
const log = (...a) => console.log(...a)

async function boot(browser) {
  const errors = []
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300))
  })
  page.on('pageerror', (e) => errors.push('PAGEERR ' + String(e).slice(0, 300)))
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const url = `http://localhost:${port}/app/?scene=demo&webgpu`
  const ready = () => page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 30000 })
  await page.goto(url)
  await ready()
  await page.waitForTimeout(2000)
  await page.goto(url) // cold vite can dep-reoptimize -> reload mid-run; second visit is warm
  await ready()
  await page.waitForFunction(() => window.__oip.view.stagedReveal === false, { timeout: 45000 })
  await page
    .waitForFunction(() => window.__oip.view.incrementalWarmReady === true, { timeout: 60000 })
    .catch(() => log('WARN: load compile never settled after 60s, run is suspect'))
  // positive settle signal - part GLBs load async and the bundle re-records until they do
  await page.waitForFunction(() => window.__oip.assetsBusy() === false, { timeout: 60000 }).catch(() => log('WARN: assetsBusy never cleared'))
  await page.waitForTimeout(2000)
  return { page, errors }
}

/** Wrap `_renderBundle`: force a nested shadow render inside the walk, then check the camera. */
async function instrument(page) {
  return page.evaluate(() => {
    const v = window.__oip.view
    const r = v.renderer
    if (!r.backend?.isWebGPUBackend) return { webgpu: false }
    const wp = (window.__camGate = { checks: 0, dirty: 0, hitShadow: 0, forced: 0, nested: 0, reordered: 0 })
    const wrappedShadows = new WeakSet()
    const reordered = new WeakSet()

    const keys = []
    v.scene.traverse((o) => {
      if (o.isDirectionalLight === true && o.castShadow === true) keys.push(o)
    })
    const same = (a, b) => {
      if (!a || !b) return false
      for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false
      return true
    }
    const isShadow = (n) => n.isShadowNode === true || /Shadow/.test(n.constructor?.name ?? '')
    const isCam = (n) => n.name === 'cameraViewMatrix'

    const orig = r._renderBundle
    r._renderBundle = function (bundle, sceneRef, lightsNode) {
      const rb = this._bundles.get(bundle.bundleGroup, bundle.camera, this._currentRenderContext)
      const data = this.backend.get(rb)
      const groups = data.__oipCamNodes
      const viewCam = bundle.camera === v.camera
      let camNode = null

      if (viewCam && groups) {
        const camIdx = groups.findIndex((g) => g.update.some(isCam))
        if (camIdx >= 0) camNode = groups[camIdx].update.find(isCam)
        // Force a nested shadow render inside this bundle's walk. Three separate gates suppress it
        // in ordinary running and all three have to go: NodeFrame.updateBeforeNode's renderId stamp
        // (the node already ran earlier in this render call), ShadowNode's own per-(camera, frame)
        // guard, and a frozen `shadow.needsUpdate`. Restricted to groups after the camera owner -
        // the ordering the bundled wall materials would create.
        // Which group comes first is three's render-list sort, so the scene may not supply the hazard:
        // when the camera owner also holds the shadow node (a lit material sorted first), no later group
        // has one. Then move the owner's shadow nodes to the last group, the order an unlit first
        // material creates. Done once per recording; a re-record derives fresh groups.
        if (camIdx >= 0 && camIdx < groups.length - 1 && !reordered.has(groups)) {
          reordered.add(groups)
          const later = groups.slice(camIdx + 1).some((g) => g.before.some(isShadow))
          if (!later) {
            const last = groups[groups.length - 1]
            for (let i = 0; i <= camIdx; i++) {
              const moved = groups[i].before.filter(isShadow)
              if (moved.length === 0) continue
              groups[i].before = groups[i].before.filter((n) => !isShadow(n))
              last.before.push(...moved)
              wp.reordered++
            }
          }
        }
        const nodeFrame = r._nodes.nodeFrame
        for (let i = 0; i < groups.length; i++) {
          if (camIdx < 0 || i <= camIdx) continue
          for (const n of groups[i].before) {
            if (!isShadow(n)) continue
            if (!wrappedShadows.has(n)) {
              wrappedShadows.add(n)
              const us = n.updateShadow.bind(n)
              n.updateShadow = (f) => {
                wp.nested++ // the nested render actually ran (not just the attempt)
                return us(f)
              }
            }
            nodeFrame.updateBeforeMap.delete(n.updateReference(nodeFrame))
            // three r186 made ShadowNode._cameraFrameId a WeakMap (r185 keyed a plain object by
            // camera). A bare {} here has no .get, and three throws inside updateBefore.
            n._cameraFrameId = new WeakMap()
            const sh = n.shadow ?? n.light?.shadow
            if (sh) sh.needsUpdate = true
            wp.forced++
          }
        }
      }

      const out = orig.call(this, bundle, sceneRef, lightsNode)

      // The assertion point: part 2 has walked its cam nodes and uploaded the shared groups.
      // The global cameraViewMatrix node must still be the view camera's.
      if (viewCam && camNode?.value?.elements) {
        wp.checks++
        if (!same(camNode.value.elements, v.camera.matrixWorldInverse.elements)) {
          wp.dirty++
          for (const l of keys) if (same(camNode.value.elements, l.shadow.camera.matrixWorldInverse.elements)) wp.hitShadow++
        }
      }
      return out
    }
    return { webgpu: true }
  })
}

/** idle (part 1 skipped - part 2 walks alone), an orbit (camera frames), then the sim (active) */
async function exercise(page) {
  await page.waitForTimeout(3000)
  const box = await page.locator('canvas').first().boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down({ button: 'right' })
  for (let i = 0; i < 24; i++) {
    await page.mouse.move(box.x + box.width / 2 + i * 6, box.y + box.height / 2 + i * 2)
    await page.waitForTimeout(16)
  }
  await page.mouse.up({ button: 'right' })
  await page.waitForTimeout(2000)
  await page.evaluate(() => window.__oip.controller.run?.())
  await page.waitForTimeout(3000)
  await page.evaluate(() => window.__oip.controller.stop?.())
  await page.waitForTimeout(2000)
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion'],
  })
  try {
    const { page, errors } = await boot(browser)
    const { webgpu } = await instrument(page)
    if (!webgpu) {
      log('SKIP: WebGPU backend unavailable on this machine - the patch under test is WebGPU-only')
      return
    }
    await exercise(page)
    const out = await page.evaluate(() => {
      const ge = globalThis.__oipGpuErrors
      return {
        gate: { ...window.__camGate },
        cam: globalThis.__oipBundleCam ? { ...globalThis.__oipBundleCam } : null,
        gpuErrors: Array.isArray(ge) ? ge.length : (ge?.count ?? ge ?? 0),
      }
    })
    await page.close()

    log(`\ncamera checks ${out.gate.checks}   DIRTY ${out.gate.dirty}   matched a shadow camera ${out.gate.hitShadow}`)
    log(`forced nested shadow renders inside the bundle walk: ${out.gate.nested} (over ${out.gate.forced} attempts)`)
    log(`shadow nodes moved after the camera owner (the scene's own order lacked the hazard): ${out.gate.reordered}`)
    log(`__oipBundleCam refreshFrames ${out.cam?.refreshFrames} camRepairs ${out.cam?.camRepairs} uploads ${out.cam?.uploads} records ${out.cam?.records}`)
    log(`gpu errors ${out.gpuErrors}`)

    const errs = errors.filter((e) => !/GLTFLoader|Couldn't load texture/i.test(e))
    const results = {
      // non-vacuous: the walk ran many times AND a nested render really fired inside it
      exercised: out.gate.checks > 50 && out.gate.nested > 50,
      // the invariant
      cameraStaysTheViewCamera: out.gate.dirty === 0,
      // the shared-group upload path was live (otherwise a stale camera could not have shipped anyway)
      uploadsHappened: (out.cam?.uploads ?? 0) > 0,
      noGpuErrors: out.gpuErrors === 0,
      noConsoleErrors: errs.length === 0,
    }
    log('')
    for (const [k, ok] of Object.entries(results)) log(`${ok ? 'ok  ' : 'FAIL'}  ${k}`)
    if (errs.length) log('console errors:', JSON.stringify(errs.slice(0, 6)))
    if ((out.cam?.camRepairs ?? 0) === 0) log('note: camRepairs 0 - the forced nested renders should trigger repairs; check the group reorder (see header)')

    const pass = Object.values(results).every(Boolean)
    log('\nOVERALL:', pass ? 'PASS' : 'FAIL')
    if (!pass) process.exitCode = 1
  } finally {
    await browser.close()
    vite.kill()
  }
}

main().catch((e) => {
  console.error('SCRIPT ERROR', e)
  vite.kill()
  process.exit(1)
})
