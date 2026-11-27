// Verify: a skewed roller bed's seam strip meets a butted neighbour at every roller-grid phase.
//
// Two butted roller beds place rollers on the same world pitch grid, so the neighbour's first roller is on the
// next grid line past this bed's end, wherever in world X the pair sits. A skewed bed ends in a cross member,
// not a roller (its short end rollers mount on it). At a butt it draws one
// full-width strip from its end to that roller's face (GeometryContext: the host-resolved grid + which ends
// abut), bounded by R so the strip can never cut through a roller that sits near the seam.
//
// Asserts, sweeping A through a whole pitch: (a) the bare deck between the strip and the neighbour's first roller
// never exceeds the normal roller gap, (b) the strip never reaches into that roller, (c) a free-ended skewed bed
// draws no sheet steel at all, (d) nor does an unskewed bed.
// Run: node e2e/verify-skew-transfer-seam.mjs
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`

const PITCH = 0.075 // the roller bed's declared world grid pitch (examples/parts/roller-conveyor/part.js)
const R = 0.024 //     rendered roller radius
const NORMAL_GAP = PITCH - 2 * R // 0.027 m - the clear gap between any two adjacent rollers
const TOL = 0.002 //   FP + a 2 mm slack, well under the 24 mm the bug opened up
const SKEW = 15
const A_LEN = 4
const PHASES = [0, 0.012, 0.026, 0.038, 0.05, 0.063] // a whole pitch, sampled

const wait = (page) => page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 30000 })

/** Place A (skewed, at world x = ax) and B snapped to its head; report the seam geometry. */
function measure(page, ax, skew, withNeighbour) {
  return page.evaluate(async ([ax, skew, withNeighbour, aLen]) => {
    const g = { leftGuard: false, rightGuard: false }
    const parts = [{ id: 'A', type: 'part', packageId: 'oip.roller-conveyor', name: 'A', position: [ax, 1, 0], rotationY: 0, params: { length: aLen, width: 1.524, skew, ...g } }]
    if (withNeighbour) parts.push({ id: 'B', type: 'part', packageId: 'oip.roller-conveyor', name: 'B', position: [ax + aLen / 2 + 1.5, 1, 0], rotationY: 0, params: { length: 3, width: 1.524, skew: 0, ...g } })
    window.__oip.store.loadScene({ version: 1, parts })
    const groupOf = (id) => { let o = null; window.__oip.view.scene.traverse((n) => { if (n.userData?.partId === id) o = n }); return o }
    // the roller GLB loads async and the plate is (re)emitted on the refresh that learns the bed's grid, so
    // poll for both rather than sleeping a fixed time
    const ready = () => {
      let rollers = false
      groupOf(parts[parts.length - 1].id)?.traverse((o) => { if (o.isInstancedMesh && o.material?.userData?.spinUniform && o.count > 0) rollers = true })
      return rollers
    }
    for (let i = 0; i < 60 && !ready(); i++) await new Promise((r) => setTimeout(r, 150))
    await new Promise((r) => setTimeout(r, 400)) // a little longer for the grid-aware re-emit
    const worldX = (obj, x, y, z) => { obj.updateWorldMatrix(true, false); const m = obj.matrixWorld.elements; return m[0] * x + m[4] * y + m[8] * z + m[12] }
    // A: the transfer plate is the double-sided, shadow-off mesh on the roller link
    const ga = groupOf('A')
    let plate = null
    ga?.traverse((o) => { if (o.isMesh && !o.isInstancedMesh && o.material?.side === 2 && o.castShadow === false) plate = o })
    let plateMaxX = null, plateTris = 0
    if (plate) {
      const pos = plate.geometry.getAttribute('position')
      plateTris = pos.count / 3
      plateMaxX = -Infinity
      for (let i = 0; i < pos.count; i++) plateMaxX = Math.max(plateMaxX, worldX(plate, pos.getX(i), pos.getY(i), pos.getZ(i)))
    }
    // B: the world X of its first roller instance centre
    let firstRollerX = null
    const gb = groupOf('B')
    gb?.traverse((o) => {
      if (!o.isInstancedMesh || !o.material?.userData?.spinUniform || o.castShadow === false) return // tubes only: the stubs skip the shadow pass
      const a = o.instanceMatrix.array
      for (let i = 0; i < o.count; i++) {
        const wx = worldX(o, a[i * 16 + 12], a[i * 16 + 13], a[i * 16 + 14])
        if (firstRollerX === null || wx < firstRollerX) firstRollerX = wx
      }
    })
    return { head: ax + aLen / 2, plateMaxX, plateTris, firstRollerX, hasPlate: !!plate }
  }, [ax, skew, withNeighbour, A_LEN])
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  page.on('console', (m) => { if (m.type() === 'error' && !/mesh load failed/i.test(m.text())) console.log('  [browser err]', m.text()) })
  const checks = []
  const ok = (name, cond, detail = '') => { checks.push(cond); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`) }
  try {
    await page.goto(URL)
    await wait(page)
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') })
    await page.reload()
    await wait(page)
    await page.waitForTimeout(600)

    console.log(`\nBUTTED, skew ${SKEW}: sweeping A through one roller pitch (${PITCH} m)`)
    console.log('   A.x     head     plate ends   lip      B roller 1   bare deck after plate')
    let worstGap = -Infinity
    let worstIntrusion = -Infinity
    let sawLip = false
    for (const ax of PHASES) {
      const m = await measure(page, ax, SKEW, true)
      if (m.firstRollerX === null) { ok(`phase ${ax}: neighbour rollers present`, false, JSON.stringify(m)); continue }
      if (!m.hasPlate) m.plateMaxX = m.head // no strip at this phase: the neighbour's roller is already at the seam
      const lip = m.plateMaxX - m.head
      const rollerFace = m.firstRollerX - R
      const bare = rollerFace - m.plateMaxX
      if (lip > 1e-4) sawLip = true
      worstGap = Math.max(worstGap, bare)
      // How far the plate reaches past both the frame end and the neighbour roller's near face. Those are the
      // two things the plate may touch but not pass: the roller face is its target, and where the neighbour's
      // roller already crosses the seam (face behind our frame end, which the shared grid produces at some
      // phases by itself) the frame end is the limit instead. Either way, going past the roller face is the
      // failure: the lip would lie on top of the neighbour's roller.
      worstIntrusion = Math.max(worstIntrusion, m.plateMaxX - Math.max(m.head, rollerFace))
      console.log(
        `  ${ax.toFixed(3)}   ${m.head.toFixed(3)}    ${m.plateMaxX.toFixed(4)}      ${lip.toFixed(4)}   ${m.firstRollerX.toFixed(4)}       ${bare.toFixed(4)}`,
      )
    }
    console.log('')
    // (a) the bug: with the plate flush, the worst phase leaves 0.050 m, nearly 2x a roller gap.
    ok('bare deck after the plate never exceeds a normal roller gap', worstGap <= NORMAL_GAP + TOL, `worst ${worstGap.toFixed(4)} m, normal ${NORMAL_GAP.toFixed(3)} m`)
    // (b) the lip is a lap, not an intrusion: it stops at the roller face, never on top of the roller
    ok('the lip never reaches past the neighbour\'s first roller face', worstIntrusion <= TOL, `deepest ${Math.max(0, worstIntrusion).toFixed(4)} m`)
    // (c) and it is really doing something: a sweep where every phase produced a zero lip would pass (a) and
    // (b) vacuously if the plate were simply never lapped
    ok('the sweep actually exercises the lip (some phase grows one)', sawLip)

    // (c) free end: nothing to meet, so the plate must stay flush with the frame.
    console.log('\nFREE end (no neighbour), skew ' + SKEW + ':')
    const free = await measure(page, 0.026, SKEW, false)
    console.log('   ', JSON.stringify({ head: free.head, plateMaxX: free.plateMaxX, tris: free.plateTris }))
    ok('a free-ended skewed bed draws no sheet steel', !free.hasPlate, `${free.plateTris} tris`)

    // A neighbour arriving makes the strip appear. Adding a mesh to the scene graph is not enough: a recorded
    // WebGPU render bundle bakes the draw list, so realizeProceduralGeometry must bump the visual root's
    // structureVersion (the counter view.syncBundleInvalidation polls), or the strip stays invisible until
    // something unrelated re-records. structureVersion is backend-independent, so this is real on headless WebGL.
    const arrive = await page.evaluate(async ([ax, aLen]) => {
      const groupA = () => { let g = null; window.__oip.view.scene.traverse((o) => { if (o.userData?.partId === 'A') g = o }); return g }
      const strip = () => { let m = null; groupA()?.traverse((o) => { if (o.isMesh && !o.isInstancedMesh && o.material?.side === 2 && o.castShadow === false) m = o }); return !!m }
      const before = groupA()?.userData.structureVersion ?? 0
      const scene = window.__oip.store.getState().scene
      const b = { id: 'B', type: 'part', packageId: 'oip.roller-conveyor', name: 'B', position: [ax + aLen / 2 + 1.5, 1, 0], rotationY: 0, params: { length: 3, width: 1.524, skew: 0, leftGuard: false, rightGuard: false } }
      window.__oip.store.commit('add neighbour', { ...scene, parts: [...scene.parts, b] })
      for (let i = 0; i < 40 && !strip(); i++) await new Promise((r) => setTimeout(r, 150))
      return { strip: strip(), before, after: groupA()?.userData.structureVersion ?? 0 }
    }, [0.026, A_LEN])
    ok('a neighbour butting the free end makes the seam strip appear', arrive.strip)
    ok('the strip appearing bumps structureVersion (bundle re-record)', arrive.after > arrive.before, `${arrive.before} -> ${arrive.after}`)

    // (d) an unskewed bed is untouched: no plate at all, butted or not.
    console.log('\nUNSKEWED control:')
    const straight = await measure(page, 0.026, 0, true)
    ok('an unskewed butted bed emits no transfer plate at all', !straight.hasPlate)

    // (e) cost. The seam is part of geometry()'s re-emit key, so sliding a bed along its own axis re-emits its
    // geometry on every step (its grid phase really moves). That must stay a buffer rewrite: a structureVersion
    // bump is a WebGPU render-bundle re-record, and one per pointer-move is a recurring drag-perf regression.
    console.log('\nDRAG cost (free-standing skewed bed slid 0.3 m in 20 steps):')
    await measure(page, 0.026, SKEW, false) // a free skewed bed: the realistic drag, where the lap stays 0
    const churn = await page.evaluate(async () => {
      const rev = () => { let g = null; window.__oip.view.scene.traverse((o) => { if (o.userData?.partId === 'A') g = o }); return g ? (g.userData.structureVersion ?? 0) : -1 }
      const before = rev()
      for (let i = 1; i <= 20; i++) {
        const scene = window.__oip.store.getState().scene
        window.__oip.store.commit('slide', { ...scene, parts: scene.parts.map((p) => (p.id === 'A' ? { ...p, position: [0.026 + i * 0.015, 1, 0] } : p)) })
        await new Promise((r) => setTimeout(r, 30))
      }
      await new Promise((r) => setTimeout(r, 300))
      return { before, after: rev() }
    })
    console.log('   ', JSON.stringify(churn))
    ok('sliding a skewed bed re-emits WITHOUT re-recording (structureVersion steady)', churn.after - churn.before <= 1, `${churn.after - churn.before} bumps over 20 moves`)

    const allPass = checks.every(Boolean)
    console.log(`\nVERDICT: ${allPass ? 'PASS - the seam strip meets the neighbour at every grid phase, and a free end draws none' : 'FAIL - see checks above'}`)
    if (!allPass) process.exitCode = 1
  } finally {
    await browser.close()
    vite.kill()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
