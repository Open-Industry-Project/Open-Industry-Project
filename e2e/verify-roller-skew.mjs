// Verify: SDK Roller Conveyor skew (skew_angle parity).
// Loads a straight bed (skew 0) beside a skewed bed (skew 35), waits for the roller beds to lay out, then reads the
// rendered roller InstancedMesh matrices to confirm the skewed bed's rollers are (a) rotated ~35° about +Y,
// (b) lengthened (bigger axle scale so they still span the width), and (c) that the axle-stub InstancedMesh,
// folded into the roller bank (docs/sdk-geometry-flexibility.md), follows each roller (present on both beds,
// rotated to match, not hidden). Screenshots both to e2e/shots/roller-skew.png.
// Run: node e2e/verify-roller-skew.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const SKEW_DEG = 35

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })
}

// For the part with this id: find its roller (spin) InstancedMeshes and axle-stub (spin, no-shadow) InstancedMeshes, and report the max |Y-rotation| of the roller instances + the max axle scale + stub count.
function inspectPart(page, partId) {
  return page.evaluate((partId) => {
    let group = null
    window.__oip.view.scene.traverse((o) => { if (o.userData && o.userData.partId === partId) group = o })
    if (!group) return { found: false }
    let rollerCount = 0, stubCount = 0, maxAngle = 0, maxAxleScale = 0, hasBed = false
    // the skew transfer plate (render-only corner dead-plate), authored by the part's geometry() as a
    // DoubleSide + no-shadow gapfill Mesh, emitted only while skewed. (Frame/guard steel is also DoubleSide, but
    // casts shadow; the plate is the only double-sided, shadow-off mesh, matching its castShadow:false authoring.)
    let plate = null
    group.traverse((o) => { if (o.isMesh && !o.isInstancedMesh && o.material && o.material.side === 2 && o.castShadow === false) plate = o })
    const plateTris = plate && plate.geometry.getAttribute('position') ? plate.geometry.getAttribute('position').count / 3 : 0
    group.traverse((o) => {
      if (!o.isInstancedMesh) return
      const spin = !!(o.material && o.material.userData && o.material.userData.spinUniform)
      if (!spin) return
      const isCyl = o.castShadow === false // the axle stubs: the one spinning bank that skips the shadow pass (_shared/rollerBed.js)
      const arr = o.instanceMatrix.array
      if (isCyl) { stubCount += o.count; return }
      hasBed = true
      rollerCount += o.count
      for (let i = 0; i < o.count; i++) {
        const b = i * 16
        // column 2 (local +Z axle, scaled): elements [8,9,10]; angle in XZ, scale = its length
        const zx = arr[b + 8], zy = arr[b + 9], zz = arr[b + 10]
        const len = Math.hypot(zx, zy, zz)
        const ang = Math.abs((Math.atan2(zx, zz) * 180) / Math.PI)
        if (ang > maxAngle) maxAngle = ang
        if (len > maxAxleScale) maxAxleScale = len
      }
    })
    return { found: true, hasBed, rollerCount, stubCount, maxAngle, maxAxleScale, hasPlate: !!plate, plateTris }
  }, partId)
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  page.on('console', (m) => { if (m.type() === 'error' && !/mesh load failed/i.test(m.text())) console.log('  [browser err]', m.text()) })
  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(500)

    await page.evaluate((skew) => {
      window.__oip.store.loadScene({
        version: 1,
        parts: [
          { id: 'straight', type: 'part', packageId: 'oip.roller-conveyor', name: 'straight', position: [-3, 2, -1.2], rotationY: 0, params: { length: 4, width: 1.524, skew: 0 } },
          { id: 'skewed', type: 'part', packageId: 'oip.roller-conveyor', name: 'skewed', position: [-3, 2, 1.6], rotationY: 0, params: { length: 4, width: 1.524, skew } },
        ],
      })
    }, SKEW_DEG)

    // wait for both beds' roller banks to lay out
    let straight, skewed
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(400)
      straight = await inspectPart(page, 'straight')
      skewed = await inspectPart(page, 'skewed')
      if (straight.hasBed && skewed.hasBed) break
    }

    mkdirSync('e2e/shots', { recursive: true })
    await page.screenshot({ path: 'e2e/shots/roller-skew.png' })

    console.log('\n=== straight (skew 0) ===', JSON.stringify(straight))
    console.log('=== skewed (skew ' + SKEW_DEG + ') ===', JSON.stringify(skewed))

    const checks = []
    const ok = (name, cond) => { checks.push({ name, cond }); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`) }
    console.log('\n=== CHECKS ===')
    ok('straight rollers are axis-aligned (~0°)', straight.hasBed && straight.maxAngle < 2)
    ok('straight bed keeps its axle stubs', straight.stubCount > 0)
    ok(`skewed rollers rotate ~${SKEW_DEG}°`, skewed.hasBed && Math.abs(skewed.maxAngle - SKEW_DEG) < 3)
    ok('skewed rollers lengthen (axle scale grows vs straight)', skewed.maxAxleScale > straight.maxAxleScale * 1.05)
    ok('skewed bed keeps its axle stubs (folded into the bank, following each roller)', skewed.stubCount > 0)
    // transfer plates (part-authored geometry()): absent on the straight bed, 4 corner plates (20 tris) when skewed.
    ok('straight bed draws no transfer plate', !straight.hasPlate)
    ok('skewed bed draws its transfer plate', skewed.hasPlate)
    ok('skewed transfer plate has 4 corner plates (20 tris)', skewed.plateTris === 20)

    // Live edit: skewing an already-placed bed. Adding the plate mesh to the scene graph is not enough:
    // a recorded WebGPU render bundle bakes the draw list, so rig.ts's realizeProceduralGeometry must
    // bump the visual root's structureVersion (the counter view.syncBundleInvalidation polls), or the
    // plates stay invisible until some unrelated interaction triggers a re-record (measured: 8 s+ with
    // no re-record at all, e2e/probes/skew-inventory.mjs). structureVersion is backend-independent, so
    // this check is real on the headless WebGL path too, where the bundles themselves don't exist.
    const structRev = (partId) =>
      page.evaluate((partId) => {
        let g = null
        window.__oip.view.scene.traverse((o) => { if (o.userData && o.userData.partId === partId) g = o })
        return g ? (g.userData.structureVersion ?? 0) : -1
      }, partId)
    const editParam = (partId, key, value) =>
      page.evaluate(([partId, key, value]) => {
        const scene = window.__oip.store.getState().scene
        window.__oip.store.commit(`Edit ${key}`, {
          ...scene,
          parts: scene.parts.map((p) => (p.id === partId ? { ...p, params: { ...p.params, [key]: value } } : p)),
        })
      }, [partId, key, value])

    const revBefore = await structRev('straight')
    await editParam('straight', 'skew', 20)
    await page.waitForTimeout(500)
    const nowSkewed = await inspectPart(page, 'straight')
    const revAfterSkew = await structRev('straight')
    ok('live skew edit adds the transfer plate', nowSkewed.hasPlate && nowSkewed.plateTris === 20)
    ok('live skew edit bumps structureVersion (bundle re-record)', revAfterSkew > revBefore)

    // …and the converse, so the bump only fires when needed: a param geometry() ignores re-emits identical
    // descs, reuses every slot, and must not re-record (a notify per param change re-records every drag frame).
    await editParam('straight', 'speed', 0.4)
    await page.waitForTimeout(500)
    ok('a geometry-neutral param edit does NOT bump structureVersion', (await structRev('straight')) === revAfterSkew)

    // removing the skew drops the plate again. (No structureVersion assertion here: un-skewing also
    // re-lays out the rollers, which bumps on its own, so a rev check on this edit can't tell the two apart.
    // The add case above is the one that isolates the geometry() seam.)
    await editParam('straight', 'skew', 0)
    await page.waitForTimeout(500)
    ok('un-skewing drops the transfer plate again', !(await inspectPart(page, 'straight')).hasPlate)

    const allPass = checks.every((c) => c.cond)
    console.log(`\nVERDICT: ${allPass ? 'PASS - the part roller layout rotates + lengthens + clips the rollers; the stubs follow each roller' : 'FAIL - see checks above'}`)
    console.log('screenshot: e2e/shots/roller-skew.png')
    if (!allPass) process.exitCode = 1
  } finally {
    await browser.close()
    vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
