// Census and escape detector for the sim-frame bundle dirty-list (bundleReplayRefresh part 1).
// While the demo sim runs under render bundles, it fingerprints every bundled-candidate mesh per
// frame and checks that every observed mutation (matrix / instanced-attr / material animation) is
// covered by the refresh. A mutation is covered when it is one of:
//   - inside the activity always-active bucket (dynamicInstances, unowned draws);
//   - owned by a part (or an instance pool, by its poolMarkId) in that frame's dirty-mark set
//     (globalThis.__oipBundleDirtyParts: owned-walk re-bakes, tick mutation reports, viewTick
//     reports, syncScene edits, pool writes);
//   - a material-only change on a tick-group material (spinUniform, uploaded by the replay's direct
//     shared-buffer upload, part 1.5, not by any walk). Belt/chain scroll is tick-group too but lives
//     in texture.offset, which this fingerprint doesn't read.
// `escapes` must be 0. A nonzero escape means a runtime mutation lives outside every mark seam and
// would render stale mid-sim (fix the mark seam, or the classification in classifyBundleObject).
// The dirty-set check spans the current and previous frame, because mark and fingerprint can be one
// rAF apart. A real unmarked mutator mutates every frame, so it cannot hide in that window.
// Also reports walkedPerFrame (part1Walked delta). Capability baseline:
// full walk ~742/frame → capability dirty-list ~271/frame at demo scale (45 truly dirty of 340);
// with activity marks ~212-237/frame (viewTick subtrees bucketed);
// tick-uniform groups + viewTick marks should cut it to ≈ bucket + cargo-adjacent marks.
// NB an intermittent load race can leave parts hidden (candidates ~33, dirtyAvg 0) - rerun.
/* global process, console, window, localStorage, requestAnimationFrame */
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'

const { port, vite } = await startServer()
const browser = await chromium.launch({
  headless: false,
  args: ['--disable-features=CalculateNativeWinOcclusion', '--enable-unsafe-webgpu'],
})
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const url = `http://localhost:${port}/app/?scene=demo&webgpu`
  await page.goto(url)
  const ready = () => page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 60000 })
  await ready()
  await page.waitForTimeout(2000)
  await page.goto(url)
  await ready()
  await page.waitForFunction(() => window.__oip.view.stagedReveal === false, { timeout: 45000 })
  await page.waitForTimeout(2500)

  // start the sim (retry - the button click can race UI state)
  for (let i = 0; i < 10; i++) {
    await page.locator('button.run-button.play').click().catch(() => {})
    await page.waitForTimeout(500)
    if (await page.evaluate(() => window.__oip.store.getState().running)) break
  }
  if (!(await page.evaluate(() => window.__oip.store.getState().running))) {
    console.log('FAILED to start sim')
    process.exit(1)
  }
  await page.waitForTimeout(3000) // let cargo spawn and devices engage

  const out = await page.evaluate(
    () =>
      new Promise((res) => {
        const v = window.__oip.view
        // the three bundle roots: partsGroup, livePartsGroup, the pool output group
        const roots = [v.partsGroup, v.livePartsGroup].filter(Boolean)
        v.scene.children.forEach((c) => {
          if (c.userData?.instancePoolGroup) roots.push(c)
        })
        // candidates ≈ what the bundle records: visible meshes under the bundle roots
        const candidates = []
        for (const root of roots) {
          root.traverse((o) => {
            if (!o.isMesh || !o.visible) return
            let vis = true, n = o
            while (n && n !== v.scene) { if (n.visible === false) { vis = false; break } n = n.parent }
            if (!vis) return
            let part = null
            n = o
            while (n) { if (typeof n.userData?.partId === 'string') { part = n.userData.partId; break } n = n.parent }
            // Activity always-bucket classification (mirror classifyBundleObject's default mode):
            // per-frame instance rewrites or unowned draws. viewTick subtrees (the building) are not
            // bucketed: viewTicks report their mutation and the view marks the part. Everything else
            // must be covered by dirty-part marks, except material-only changes on tick-group
            // materials (spinUniform), which the replay uploads directly.
            // An instance pool has its own mark id (instancePool.ts markPool), so it must be
            // mark-covered like a part. That way a pooled material mutating mid-run (no buffer
            // version moves, so the replay's backstop can't see it) shows up as an escape.
            if (part === null && typeof o.userData?.poolMarkId === 'string') part = o.userData.poolMarkId
            const m0 = Array.isArray(o.material) ? o.material[0] : o.material
            let bucket = part === null
            if (!bucket && o.userData?.dynamicInstances === true) bucket = true
            const tickMat = m0?.userData?.spinUniform !== undefined
            candidates.push({ o, part: part ?? (o.userData?.instancePool ? '<pool>' : '<none>'), rawPart: part, bucket, tickMat, prev: null })
          })
        }
        const fp = (o) => {
          let s = 0
          const e = o.matrixWorld.elements
          for (let i = 0; i < 16; i++) s += e[i] * (i + 3)
          let attrs = 0
          if (o.isInstancedMesh) attrs += o.instanceMatrix.version + o.count * 1e3
          const g = o.geometry
          if (g) for (const k of Object.keys(g.attributes)) { const a = g.attributes[k]; if (a.isInstancedBufferAttribute) attrs += a.version }
          const m = Array.isArray(o.material) ? o.material[0] : o.material
          let mat = 0
          if (m) {
            mat += m.emissive ? m.emissive.getHex() : 0
            mat += m.color ? m.color.getHex() % 997 : 0
            const spin = m.userData?.spinUniform
            if (spin && typeof spin.value === 'number') mat += spin.value
          }
          return { s, attrs, mat }
        }
        // long enough to span several PLC divert bursts + robot pick cycles; a 150-frame window
        // misses the diverter entirely (it never fires) and under-reports escapes
        const FRAMES = 1500
        let frame = 0
        const perFrameDirty = []
        const partDirtyFrames = new Map() // partId → frames with any change
        const kindTotals = { matrix: 0, attrs: 0, material: 0 }
        let escapes = 0 // dirty meshes neither always-bucketed NOR mark-covered - must be 0
        const escapees = new Set()
        const markedPerFrame = [] // size of the frame's dirty-mark set (the walk's byPart cost driver)
        let prevMarks = new Set()
        const walked0 = window.__oipBundleCam ? window.__oipBundleCam.part1Walked : 0
        const tick = () => {
          let dirty = 0
          const dirtyParts = new Set()
          // the frame's consumed dirty-mark set (bundleGroups.flushBundleInvalidation publishes it)
          const marks = window.__oipBundleDirtyParts ?? new Set()
          for (const c of candidates) {
            const now = fp(c.o)
            if (c.prev) {
              const dm = now.s !== c.prev.s, da = now.attrs !== c.prev.attrs, dmat = now.mat !== c.prev.mat
              if (dm || da || dmat) {
                dirty++
                dirtyParts.add(c.part)
                if (dm) kindTotals.matrix++
                if (da) kindTotals.attrs++
                if (dmat) kindTotals.material++
                const covered =
                  c.bucket ||
                  (c.rawPart !== null && (marks.has(c.rawPart) || prevMarks.has(c.rawPart))) ||
                  // material-only change on a TICK-group material (spin) - shipped by the
                  // replay's direct shared-buffer upload, no walk and no mark required
                  (c.tickMat && dmat && !dm && !da)
                if (!covered) { escapes++; escapees.add(`${c.part}:${c.o.name || c.o.type}`) }
              }
            }
            c.prev = now
          }
          markedPerFrame.push(marks.size)
          prevMarks = marks
          if (frame > 0) {
            perFrameDirty.push(dirty)
            for (const p of dirtyParts) partDirtyFrames.set(p, (partDirtyFrames.get(p) ?? 0) + 1)
          }
          if (++frame <= FRAMES) requestAnimationFrame(tick)
          else {
            const sorted = [...perFrameDirty].sort((a, b) => a - b)
            const walked = window.__oipBundleCam ? window.__oipBundleCam.part1Walked - walked0 : -1
            res({
              candidates: candidates.length,
              bucketSize: candidates.filter((c) => c.bucket).length,
              tickMats: candidates.filter((c) => c.tickMat).length,
              tickUploads: window.__oipBundleCam ? window.__oipBundleCam.tickUploads : -1,
              frames: perFrameDirty.length,
              dirtyAvg: perFrameDirty.reduce((a, b) => a + b, 0) / perFrameDirty.length,
              dirtyP95: sorted[Math.floor(sorted.length * 0.95)],
              dirtyMax: sorted[sorted.length - 1],
              markedAvg: markedPerFrame.reduce((a, b) => a + b, 0) / markedPerFrame.length,
              kindTotals,
              escapes,
              escapees: [...escapees].slice(0, 10),
              walkedPerFrame: walked / perFrameDirty.length,
              topParts: [...partDirtyFrames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
            })
          }
        }
        requestAnimationFrame(tick)
      }),
  )
  console.log(JSON.stringify(out, null, 2))
} finally {
  await browser.close().catch(() => {})
  vite.kill()
}
