// Verify the SDK Roller Conveyor (oip.roller-conveyor, rendered via src/render/parts/sdkPart.ts)
// draws its roller bed with GPU instancing (one InstancedMesh for the bodies + one per axle-stub link)
// instead of one THREE.Mesh per roller, so a long bed stays a couple of draw calls. Also confirms the instanced rollers still render + spin (shared roller material).
// Run: node e2e/verify-sdk-roller-instancing.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })
}

// Inspect the rendered visual of the placed part: tally InstancedMeshes vs plain meshes that carry the
// spinning roller material (userData.spinUniform), and whether any spin uniform exists at all.
function inspect(page, partId) {
  return page.evaluate((partId) => {
    let group = null
    window.__oip.view.scene.traverse((o) => { if (o.userData && o.userData.partId === partId) group = o })
    if (!group) return { found: false }
    const instancedRoller = [] // {count, geom} for InstancedMeshes carrying the spin material
    let plainRollerMeshes = 0 // non-instanced visible meshes carrying the spin material (one mesh per roller, uninstanced)
    let spinObjects = 0 // total render objects (instanced or not) carrying the spin material - the draw-call proxy
    let spinUniformFound = false
    let bodyInstanced = false // the roller bed bodies (the tubes, which cast shadows; the stubs skip that pass) are instanced
    group.traverse((o) => {
      if (!o.isMesh) return
      const mat = o.material
      const hasSpin = !!(mat && mat.userData && mat.userData.spinUniform)
      if (!hasSpin) return
      spinUniformFound = true
      spinObjects++
      if (o.isInstancedMesh) {
        const geom = o.castShadow === false ? 'stub' : 'tube' // the axle stubs skip the shadow pass (_shared/rollerBed.js)
        instancedRoller.push({ count: o.count, geom })
        if (geom === 'tube') bodyInstanced = true
      } else if (o.visible) plainRollerMeshes++
    })
    return { found: true, instancedRoller, plainRollerMeshes, spinObjects, spinUniformFound, bodyInstanced }
  }, partId)
}

// Read then drive the roller material's spin uniform via the part's real tick(dt, running).
function driveSpin(page, partId, dt, running, times) {
  return page.evaluate(({ partId, dt, running, times }) => {
    let group = null
    window.__oip.view.scene.traverse((o) => { if (o.userData && o.userData.partId === partId) group = o })
    if (!group) return null
    let u = null
    group.traverse((o) => { const m = o.material; if (m && m.userData && m.userData.spinUniform) u = m.userData.spinUniform })
    const tick = group.userData.tick
    if (!u || typeof tick !== 'function') return null
    for (let i = 0; i < times; i++) tick(dt, running)
    return u.value
  }, { partId, dt, running, times })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })

  const shaderErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text()
      // genuine three.js shader-compile errors only, not the unrelated "custom-part mesh load failed
      // TypeError: Failed to fetch" (a headless GLB-asset fetch failure whose "Error:" would otherwise match)
      if (/Shader Error|WebGLProgram/i.test(t) && !/mesh load failed/i.test(t)) shaderErrors.push(t)
    }
  })
  page.on('pageerror', (e) => shaderErrors.push(String(e)))

  const PART_ID = 'sdk_roller_1'
  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(600)

    // A 4 m SDK roller conveyor: ~53 rollers at the 0.075 m grid pitch. Without instancing that is ~53 body
    // meshes + ~106 stub meshes (~159 draw calls); it must be 3 InstancedMeshes (1 bed + 2 stub links).
    const placed = await page.evaluate((partId) => {
      const part = {
        id: partId, type: 'part', packageId: 'oip.roller-conveyor', name: 'SDK Roller',
        position: [0, 2, 0], rotationY: 0,
        params: { length: 4, width: 1.524, speed: 1, standHeight: 2, leftGuard: true, rightGuard: true },
      }
      window.__oip.store.loadScene({ version: 1, parts: [part] })
      return true
    }, PART_ID)
    check('scene loaded', placed)

    // Poll until the roller body InstancedMesh has been laid out (the part's geometry() banks land on the
    // first refresh after the package registers). Up to ~8 s.
    let info = await inspect(page, PART_ID)
    for (let i = 0; i < 16 && !(info.found && info.bodyInstanced); i++) {
      await page.waitForTimeout(500)
      info = await inspect(page, PART_ID)
    }
    check('SDK roller conveyor visual found', info.found === true, JSON.stringify(info))
    check('roller material exposes a spin uniform (shader path present)', info.spinUniformFound === true)
    check('no per-roller plain meshes remain (bed is instanced, not N meshes)', info.plainRollerMeshes === 0, `plainRollerMeshes=${info.plainRollerMeshes}`)
    const bed = info.instancedRoller.find((m) => m.geom === 'tube' && m.count >= 20) || null
    check('roller BED is ONE InstancedMesh holding the whole row', !!bed && info.bodyInstanced, `instanced=${JSON.stringify(info.instancedRoller)}`)
    check('axle STUBS are instanced too', info.instancedRoller.some((m) => m.geom === 'stub' && m.count >= 20), `instanced=${JSON.stringify(info.instancedRoller)}`)
    check('draw-call proxy is a handful of objects, not ~159', info.spinObjects > 0 && info.spinObjects <= 6, `spin-material objects=${info.spinObjects}`)
    check('no GL shader-compile error rendering the instanced rollers', shaderErrors.length === 0, shaderErrors.slice(0, 2).join(' | '))

    // spin still animates the shared instanced material while running, and holds when stopped
    const base = await driveSpin(page, PART_ID, 0, true, 1)
    const after = await driveSpin(page, PART_ID, 0.1, true, 3)
    check('uSpin advances while running', base !== null && after !== null && Math.abs(after - base) > 0.01, `base=${base?.toFixed(3)} after=${after?.toFixed(3)}`)
    const held0 = await driveSpin(page, PART_ID, 0.1, false, 1)
    const held1 = await driveSpin(page, PART_ID, 0.1, false, 5)
    check('uSpin holds while stopped', held0 !== null && held0 === held1, `held0=${held0?.toFixed(3)} held1=${held1?.toFixed(3)}`)

    console.log(`\nroller-bed instance counts: ${JSON.stringify(info.instancedRoller)}  |  spin-material draw objects: ${info.spinObjects}`)
    await page.screenshot({ path: join(import.meta.dirname, 'shots', 'sdk-roller-instancing.png') })
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
