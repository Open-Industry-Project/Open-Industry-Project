// Focused check: per-leg footing (legRests resolver, docs/seam-resolvers.md). A legged conveyor straddling
// a platform must stand each leg on the surface actually below it - short legs with their feet on the deck
// over the platform, a tall leg to the warehouse floor past its edge - instead of every foot on one flat
// plane (where legs pierce the deck, or float at deck height past the edge). Verified on both
// leg systems: the belt conveyor (geometry() legs via the legRests param fold) and the roller conveyor
// (rig kind:'leg' link laid out in rig.ts).
// Scene: belt at x∈[−2,2] (y 2.01, stand 2 → own floor = warehouse floor) + roller at x∈[−2,2] on z=6, each
// over a 4×4 platform (deck top 1.2) covering x∈[−0.5,3.5] - leg stations at world x −1.55 (floor), 0, 1.55
// (deck). We read the rendered leg-bank instances per part and assert foot elevations.
// Run: node e2e/verify-leg-platform-rest.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { cleanShot } from './_shot.mjs'

const { port: PORT, vite } = await startServer()
// ?noinstancepool: keep each part's instanced banks under its own part group so leg instances are
// attributable per part (the scene-global pool hoists them into shared InstancedMeshes; it only relocates
// the same baked matrices - pool correctness is covered by verify-instance-pool.mjs).
const URL = `http://localhost:${PORT}/app/?noinstancepool`
const HEADED = process.argv.includes('--headed')

const DECK_TOP = 1.2
// the deck covers world x ∈ [−0.5, 3.5]; probe the interior with a margin clear of the floor leg's trestle
const DECK_X0 = -0.4
const DECK_X1 = 3.4

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

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

    const havePkgs = await page.evaluate(() =>
      ['oip.belt-conveyor', 'oip.roller-conveyor', 'oip.platform'].every((id) => !!window.__oip.getPackage?.(id)))
    check('belt/roller/platform packages are registered', havePkgs)

    await page.evaluate(() => {
      const parts = [
        // tail-origin belt: local 0..4 → world −2..2; legs at world −1.55 (floor), 0 + 1.55 (deck)
        { id: 'b', type: 'part', packageId: 'oip.belt-conveyor', position: [-2, 2.01, 0], rotationY: 0, params: { segments: [[4, 0]], width: 1.524, standHeight: 2, speed: 1 } },
        { id: 'pb', type: 'part', packageId: 'oip.platform', position: [1.5, 1.2, 0], rotationY: 0, params: { length: 4, width: 4, height: 1.2 } },
        // centre-origin roller: local −2..2 → world −2..2 on z=6; same station layout
        { id: 'r', type: 'part', packageId: 'oip.roller-conveyor', position: [0, 2.01, 6], rotationY: 0, params: { length: 4, width: 1.524, standHeight: 2, speed: 1 } },
        { id: 'pr', type: 'part', packageId: 'oip.platform', position: [1.5, 1.2, 6], rotationY: 0, params: { length: 4, width: 4, height: 1.2 } },
      ]
      window.__oip.store.loadScene({ version: 3, parts })
    })
    // wait for both conveyors' instanced banks to lay out (leg banks are sync, but the visuals build on the
    // next view sync; the roller GLB loads async - legs don't wait on it, so a generous instance floor works)
    await page.waitForFunction(() => {
      return ['b', 'r'].every((id) => {
        const entry = [...window.__oip.view.entries].find(([eid]) => eid === id)?.[1]
        if (!entry) return false
        let insts = 0
        entry.visual.object.traverse((o) => { if (o.isInstancedMesh) insts += o.count })
        return insts > 20
      })
    }, { timeout: 20000 })
    await page.waitForTimeout(500)

    // every instanced-bank instance of a part as its TRUE world AABB: the bank geometry's bounding box pushed
    // through matrixWorld · instanceMatrix (a drum wrap's box is baked into the geometry with a translation-only
    // instance - a naive "translation = centre" read misplaces it)
    const perPart = await page.evaluate(() => {
      const out = {}
      for (const [id, entry] of window.__oip.view.entries) {
        if (id !== 'b' && id !== 'r') continue
        entry.visual.object.updateMatrixWorld(true)
        const pieces = []
        entry.visual.object.traverse((o) => {
          if (!o.isInstancedMesh) return
          if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
          const bb = o.geometry.boundingBox
          const local = o.matrixWorld.clone()
          const world = o.matrixWorld.clone()
          const v = { x: 0, y: 0, z: 0 }
          for (let i = 0; i < o.count; i++) {
            o.getMatrixAt(i, local)
            world.multiplyMatrices(o.matrixWorld, local)
            const e = world.elements
            let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity
            for (let c = 0; c < 8; c++) {
              v.x = c & 1 ? bb.max.x : bb.min.x
              v.y = c & 2 ? bb.max.y : bb.min.y
              v.z = c & 4 ? bb.max.z : bb.min.z
              const wx = e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12]
              const wy = e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13]
              const wz = e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14]
              if (wx < x0) x0 = wx; if (wx > x1) x1 = wx
              if (wy < y0) y0 = wy; if (wy > y1) y1 = wy
              if (wz < z0) z0 = wz; if (wz > z1) z1 = wz
            }
            pieces.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, bottom: y0, top: y1, mesh: `${o.name || o.geometry.type}#${i}/${o.count}` })
          }
        })
        out[id] = pieces
      }
      return out
    })

    for (const [id, label] of [['b', 'belt'], ['r', 'roller']]) {
      const pieces = perPart[id] ?? []
      check(`${label}: instanced pieces rendered`, pieces.length > 20, `count=${pieces.length}`)
      // 1. no punch-through: inside the deck's x-interval nothing of the conveyor reaches below the deck top
      //    (a flat layout runs full-height posts from the warehouse floor up through the deck)
      const pierce = pieces.filter((p) => p.x > DECK_X0 && p.x < DECK_X1 && p.bottom < DECK_TOP - 0.05)
      check(`${label}: no leg pierces the platform deck`, pierce.length === 0,
        pierce.length ? `worst bottom=${Math.min(...pierce.map((p) => p.bottom)).toFixed(3)}` : '')
      for (const p of pierce.slice(0, 6)) console.log(`        pierce: x=${p.x.toFixed(3)} z=${p.z.toFixed(3)} bottom=${p.bottom.toFixed(3)} top=${p.top.toFixed(3)} ${p.mesh}`)
      // 2. feet on the deck: foot hardware sits at the deck top under the covered stations
      const deckFeet = pieces.filter((p) => p.x > DECK_X0 && p.x < DECK_X1 && p.bottom < DECK_TOP + 0.05)
      check(`${label}: legs stand on the deck`, deckFeet.length > 0, `feet=${deckFeet.length}`)
      // 3. foot on the floor: the station past the deck edge still reaches the warehouse floor
      const floorFeet = pieces.filter((p) => p.x < -0.5 && p.bottom < 0.1)
      check(`${label}: the overhanging leg reaches the floor`, floorFeet.length > 0, `feet=${floorFeet.length}`)
    }

    check('no GL shader-compile error', shaderErrors.length === 0, shaderErrors.slice(0, 2).join(' | '))

    // frame the overhang side (world −X, low elevation) so the shot shows the parity look: short trestles
    // standing on the deck and the tall tail leg dropping past the platform edge to the warehouse floor
    await page.evaluate(() => {
      const v = window.__oip.view
      v.controls.target.set(0, 1.2, 3)
      v.camera.position.set(-9, 3.2, 8.5)
      v.camera.lookAt(0, 1.2, 3)
      v.controls.update()
    })
    await page.waitForTimeout(400)
    await cleanShot(page, join(import.meta.dirname, 'shots', 'leg-platform-rest.png'))
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
