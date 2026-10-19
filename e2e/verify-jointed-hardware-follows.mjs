// Verify the fix for "the turntable's roller holders don't rotate with the deck": hardware that FK moves
// must never be merged into the scene-global instance pool. The pool bakes world matrices and only
// re-bakes on structural events, so a merged copy of a jointed link's hardware stands still at the
// last-baked pose. That is what happens to the turntable's side-frame rails, roller end brackets and rim
// bolts when pooled: they stay at the old deck angle while the rollers beside them (exempt via their spin
// material) turn with the platter. rig.ts stamps `poolMobile` on every link group a joint / aim /
// setSubPose moves; instancePool.collectEligible prunes those subtrees.
//
// Two assertions, cheapest first:
//   1. The invariant, scene-wide over the demo: no pool-hidden source anywhere under a `poolMobile`
//      subtree. Cheap, and it holds every jointed part in the scene to the rule, not just the turntable.
//   2. The symptom, driven directly: pose the turntable's joint through the same applier the sim frame
//      routes to (userData.applyJoints) - the path that moves hardware without any store commit, so
//      nothing re-bakes the pool - then assert the holder + bolt hardware actually on screen turned with
//      the deck. If the banks were pooled, their live sources would be hidden and the copies the pool
//      draws would never move.
// Run: node e2e/verify-jointed-hardware-follows.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { chromium } from 'playwright'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { cleanShot } from './_shot.mjs'

const { port: PORT, vite } = await startServer()
const OUT = join(import.meta.dirname, 'shots')
const HEADED = process.argv.includes('--headed')
const URL = `http://localhost:${PORT}/app/`
const DECK_DEG = 40 // the angle the joint is driven to, well clear of the 0 rest pose

let failures = 0
const check = (name, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const waitForApp = (page) => page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })

// every pool-hidden (merged) source sitting inside a runtime-mobile subtree - must be empty
const mobilePooled = () => {
  const v = window.__oip.view
  const hits = []
  const walk = (o, mobile, partId) => {
    const id = typeof o.userData.partId === 'string' ? o.userData.partId : partId
    const m = mobile || o.userData.poolMobile === true
    if (m && o.userData.poolHidden === true) hits.push(`${id}:${o.userData.linkName ?? o.type}`)
    for (const c of o.children) walk(c, m, id)
  }
  walk(v.scene, false, '')
  return hits
}

// the turntable's drawn hardware: for each bank under the part, its world yaw and whether it is on screen
const hardware = (partId) => {
  const v = window.__oip.view
  v.scene.updateMatrixWorld(true)
  const find = (o) => { if (o.userData.partId === partId) return o; for (const c of o.children) { const r = find(c); if (r) return r } return null }
  const root = find(v.scene)
  if (!root) return null
  const yaw = (e) => +(Math.atan2(e[8], e[0]) * 180 / Math.PI).toFixed(1)
  const banks = []
  const walk = (o) => {
    if (o.isInstancedMesh) {
      let vis = o.visible
      for (let p = o.parent; p && vis; p = p.parent) vis = p.visible
      banks.push({ n: o.count, spin: !!o.material?.userData?.spinUniform, drawn: vis, yaw: yaw(o.matrixWorld.elements) })
    }
    for (const c of o.children) walk(c)
  }
  walk(root)
  return banks
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]))
  try {
    await page.goto(URL); await waitForApp(page)
    await page.waitForTimeout(1500)
    await page.evaluate(() => localStorage.clear())
    await page.reload(); await waitForApp(page)
    await page.waitForTimeout(1200)

    // ---- 1. the invariant, over the demo (every jointed part in a real scene) -------------------------
    await clickDemo(page)
    await page.waitForTimeout(6000)
    // bake with everything attached and settled, so the check reads a fully-merged pool
    await page.evaluate(() => window.__oip.view.instancePool?.rebuild(new Set()))
    await page.waitForTimeout(400)
    const hits = await page.evaluate(mobilePooled)
    check('no merged hardware under any runtime-mobile link in the demo', hits.length === 0, hits.slice(0, 5).join(', ') || 'none')

    // ---- 2. the symptom: drive the joint the way the sim does, with no re-bake --------------------------
    // a turntable plus two roller conveyors, so the pool has same-signature partners to merge with (a lone
    // part pools nothing and the test would pass vacuously)
    const placed = await page.evaluate(() => {
      const st = window.__oip.store
      const pkgs = st.getState().bundledPackages ?? []
      const tt = pkgs.find((p) => p.id === 'oip.turntable-conveyor')
      const rc = pkgs.find((p) => p.id === 'oip.roller-conveyor')
      if (!tt || !rc) return false
      const s = st.getState().scene
      const conv = (id, x) => ({ id, type: 'part', packageId: rc.id, position: [x, 0.95, 0], rotationY: 0, params: { length: 2, width: 1.524, standHeight: 0.95 } })
      st.loadScene({
        ...s,
        parts: [
          ...s.parts.filter((q) => q.type !== 'part'),
          { id: 'tt_1', type: 'part', packageId: tt.id, position: [0, 0.95, 0], rotationY: 0, params: { deckAngleDeg: 0 } },
          conv('rc_1', -2.2), conv('rc_2', 2.2),
        ],
      })
      return true
    })
    check('turntable + conveyor packages available', placed)
    if (!placed) throw new Error('missing packages')
    await page.waitForTimeout(2500)
    await page.evaluate(() => {
      const v = window.__oip.view
      v.controls.target.set(0, 0.9, 0)
      v.camera.position.set(1.8, 2.8, 1.8)
      v.controls.update()
      v.instancePool?.rebuild(new Set()) // bake at the rest pose - the stale copy's angle, under the old code
    })
    await page.waitForTimeout(600)
    await cleanShot(page, join(OUT, 'jointed-hardware-rest.png'))

    const atRest = await page.evaluate(hardware, 'tt_1')
    check('the turntable builds its roller + holder + bolt banks', (atRest?.length ?? 0) >= 3, `banks=${atRest?.length}`)
    check('none of them is merged away at rest', atRest?.every((b) => b.drawn) === true, atRest?.map((b) => `${b.n}${b.drawn ? '' : ':HIDDEN'}`).join(' '))

    // drive the joint through the sim's own applier - no store commit, so nothing schedules a pool re-bake
    const drove = await page.evaluate((deg) => {
      const v = window.__oip.view
      const find = (o) => { if (o.userData.partId === 'tt_1') return o; for (const c of o.children) { const r = find(c); if (r) return r } return null }
      const root = find(v.scene)
      const apply = root?.userData.applyJoints
      if (typeof apply !== 'function') return false
      apply({ rotate: (deg * Math.PI) / 180 })
      return true
    }, DECK_DEG)
    check('the rig exposes the joint applier the sim frame routes to', drove)
    await page.waitForTimeout(400)
    await cleanShot(page, join(OUT, 'jointed-hardware-turned.png'))

    const turned = await page.evaluate(hardware, 'tt_1')
    const drawn = turned?.filter((b) => b.drawn) ?? []
    check('every bank is still drawn live after the joint moved', drawn.length === (turned?.length ?? -1),
      turned?.map((b) => `${b.n}@${b.yaw}${b.drawn ? '' : ':HIDDEN'}`).join(' '))
    // the main check: the hardware on screen sits at the deck's new angle, not at the baked rest pose
    const off = drawn.filter((b) => Math.abs(b.yaw - DECK_DEG) > 0.5)
    check(`all drawn turntable hardware follows the deck to ${DECK_DEG}°`, off.length === 0,
      off.map((b) => `${b.n} bank at ${b.yaw}°`).join(', ') || `${drawn.length} banks at ${DECK_DEG}°`)

    if (errors.length) console.log('page errors:', errors.slice(0, 5))
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    await browser.close()
    vite.kill()
  }
}
main().catch((e) => { console.error('crashed:', e); process.exitCode = 2 })
