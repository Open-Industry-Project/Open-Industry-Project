// Focused check: two butted SDK roller conveyors place their rollers on one shared world pitch grid, so a
// butt join looks like a single continuous bed (docs/seam-resolvers.md, steps 1-3). This verifies the
// world-phase array distribution on the real shipped part + render path (not just the unit-tested core):
// we load two roller conveyors, the second at a deliberately off-grid origin, and read the rendered
// roller-instance world-X. If world-phase works, every roller (both beds) lies on one pitch lattice; a
// centred layout would put the second bed's rollers on a different phase and the union would not share a grid.
// Run: node e2e/verify-roller-grid-seam.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
// ?noinstancepool: keep each bed's roller InstancedMesh under its own part group so we can read rollers
// per-part. With the default scene-global pool on, the roller bank is moved into a shared pool
// InstancedMesh (grouped across parts), which this per-part probe can't attribute. Pooling only relocates
// the same baked matrices; the grid-phasing positions this test checks are identical either way (pool
// correctness is covered by verify-instance-pool.mjs / instancePool.test.ts).
const URL = `http://localhost:${PORT}/app/?noinstancepool`
const HEADED = process.argv.includes('--headed')
const PITCH = 0.075 // ROLLER_CLASSES.light.pitch - the roller array's maxSpacing (world pitch in worldPhase mode)

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const fposmod = (a, b) => ((a % b) + b) % b

async function waitForApp(page) {
  await page.waitForFunction(
    () => !!(window.__oip && window.__oip.store && window.__oip.view),
    { timeout: 20000 },
  )
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const shaderErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Shader Error|ERROR:\s|WebGLProgram/i.test(msg.text())) shaderErrors.push(msg.text())
  })
  page.on('pageerror', (e) => shaderErrors.push(String(e)))

  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.waitForTimeout(1500)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1000)

    // the roller conveyor is a bundled custom part; confirm it's registered before loading a scene of it
    const havePkg = await page.evaluate(() => !!window.__oip.getPackage?.('oip.roller-conveyor'))
    check('roller-conveyor package is registered', havePkg)

    // two collinear beds (rotationY 0, flow = world +X). r1 origin on the trivial grid (x=0); r2 origin
    // deliberately off the pitch grid (x=4.0 → 4/0.075 = 53.33, fract ≈ 0.025 of a pitch) and butting r1's
    // front. World-phase must re-base r2's rollers onto r1's lattice regardless of its off-grid origin.
    const R2X = 4.0
    check('r2 origin is off the pitch grid (a discriminating placement)', Math.min(fposmod(R2X, PITCH), PITCH - fposmod(R2X, PITCH)) > 0.01, `frac=${fposmod(R2X, PITCH).toFixed(4)}`)

    await page.evaluate(
      ([r2x]) => {
        const part = (id, x) => ({ id, type: 'part', packageId: 'oip.roller-conveyor', position: [x, 0, 0], rotationY: 0, params: { length: 4, width: 1.524, speed: 1, standHeight: 2 } })
        window.__oip.store.loadScene({ version: 3, parts: [part('r1', 0), part('r2', r2x)] })
      },
      [R2X],
    )
    // wait until both beds have laid out their roller bank; the roller GLB loads async, so a fixed
    // sleep is flaky (an early snapshot sees the frame/bolt InstancedMeshes but not the spinning roller bodies).
    // The roller bank is the InstancedMesh carrying the spin uniform (rollerMaterial); require >5 per bed.
    await page.waitForFunction(() => {
      const ids = ['r1', 'r2']
      return ids.every((id) => {
        let g = null
        window.__oip.view.scene.traverse((o) => { if (!g && o.userData?.partId === id) g = o })
        if (!g) return false
        let rollers = 0
        g.traverse((o) => { const m = o.material; if (o.isInstancedMesh && m?.userData?.spinUniform) rollers += o.count })
        return rollers > 5
      })
    }, { timeout: 20000 })
    await page.waitForTimeout(300) // settle the final grid rebuild

    // read every roller's world-X, grouped per part. The roller bank renders as an InstancedMesh (one draw
    // per bed), so each roller is an instance: world-X = matrixWorld · instanceMatrix[i], element[12]. The
    // roller material still carries userData.spinUniform (common.rollerMaterial / metalNodeMaterial), so it
    // discriminates the roller bank from the frame/bolt/leg InstancedMeshes. A plain-Mesh fallback is kept in
    // case a path renders rollers un-instanced.
    const perPart = await page.evaluate(() => {
      const out = {}
      for (const [id, entry] of window.__oip.view.entries) {
        const part = entry.part
        if (!part || part.type !== 'part' || part.packageId !== 'oip.roller-conveyor') continue
        entry.visual.object.updateMatrixWorld(true)
        const xs = []
        entry.visual.object.traverse((o) => {
          const m = o.material
          if (!m || !m.userData || !m.userData.spinUniform) return
          if (o.isInstancedMesh) {
            const local = o.matrixWorld.clone() // scratch Matrix4 (getMatrixAt overwrites it)
            const world = o.matrixWorld.clone()
            for (let i = 0; i < o.count; i++) {
              o.getMatrixAt(i, local)
              world.multiplyMatrices(o.matrixWorld, local)
              xs.push(world.elements[12])
            }
          } else if (o.isMesh) {
            xs.push(o.matrixWorld.elements[12])
          }
        })
        out[id] = { originX: part.position[0], count: xs.length, xs }
      }
      return out
    })

    const ids = Object.keys(perPart)
    check('both roller beds rendered', ids.length === 2, `parts=${ids.join(',')}`)
    check('r1 rendered rollers', (perPart.r1?.count ?? 0) > 5, `count=${perPart.r1?.count}`)
    check('r2 rendered rollers', (perPart.r2?.count ?? 0) > 5, `count=${perPart.r2?.count}`)

    // the seam-continuity property: collect all roller world-X across both beds and assert they lie on one
    // pitch lattice. Phase-relative (x - x0) so a constant GLB-centre offset can't cause a false negative; the
    // test still tells world-phase from centred layout because it spans the two differently-phased beds.
    const allXs = [...(perPart.r1?.xs ?? []), ...(perPart.r2?.xs ?? [])]
    const x0 = Math.min(...allXs)
    let worstResidual = 0
    for (const x of allXs) {
      const r = fposmod(x - x0, PITCH)
      worstResidual = Math.max(worstResidual, Math.min(r, PITCH - r))
    }
    check('all rollers across both beds lie on one shared pitch lattice', worstResidual < 2e-3, `worst off-grid residual=${(worstResidual * 1000).toFixed(2)} mm (pitch=${PITCH * 1000} mm)`)

    // sanity: the pooled beds actually span more than one bed length (both contributed, so this is a real seam)
    const span = Math.max(...allXs) - x0
    check('pooled rollers span more than one bed (a genuine two-bed seam)', span > 4, `span=${span.toFixed(2)} m`)
    check('no GL shader-compile error', shaderErrors.length === 0, shaderErrors.slice(0, 2).join(' | '))

    await page.screenshot({ path: join(import.meta.dirname, 'shots', 'roller-grid-seam.png') })
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
