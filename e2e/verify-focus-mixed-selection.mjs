/* global console, process, window, localStorage, performance, setTimeout */
// Guard for F framing every part of a mixed selection.
//
// view.focusOn frames the union of the selection's rendered AABBs and falls back to declared footprints
// only when nothing in it has a box. A note (or a group) is an empty transform, so in a selection that also
// holds a conveyor or a box, counting boxes alone drops it from the frame entirely: select a note and a box
// ten metres apart, press F, and the camera frames the box alone. So each boxless entry adds its footprint
// (a point at its origin for a note or group) to the union.
//
// The cases, each with its control:
//   1. box alone / note alone frame their own centres (both paths unchanged);
//   2. box + note frames between them, and wider than the box alone (fails without the fix);
//   3. a group whose origin is its members' centroid adds nothing: [group, A, B] frames exactly like [A, B].
// Run: node e2e/verify-focus-mixed-selection.mjs [--headed]
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: !HEADED, args: ['--disable-features=CalculateNativeWinOcclusion'] },
    { headless: !HEADED },
  ]) {
    try {
      return await chromium.launch(opts)
    } catch {
      // that channel is not installed here; try the next one
    }
  }
  return null
}

async function main() {
  const browser = await launch()
  if (!browser) { console.log('SKIP: no chromium available'); return }
  const { url, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => {
    try {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    } catch {
      // storage blocked: the tutorial may open, which the checks below do not depend on
    }
  })
  try {
    await page.goto(`${url}`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
    await page.waitForTimeout(1000)

    // boxA at the origin, boxB 2 m along x, a note 10 m along x, and a group at A and B's centroid
    const loaded = await page.evaluate(() => {
      const { store } = window.__oip
      const box = window.__oip.getPackage('oip.box')
      if (!box) return { error: 'missing package oip.box' }
      const params = { length: 0.4, height: 0.4, width: 0.4 }
      store.loadScene({
        parts: [
          { id: 'group_1', type: 'group', position: [1, 0.2, 0], rotationY: 0, params: {}, name: 'Group 1' },
          { id: 'boxA', type: 'part', packageId: box.id, position: [0, 0.2, 0], rotationY: 0, params: { ...params, color: '#00ff00' }, parent: 'group_1' },
          { id: 'boxB', type: 'part', packageId: box.id, position: [2, 0.2, 0], rotationY: 0, params: { ...params, color: '#ff8800' }, parent: 'group_1' },
          { id: 'note_1', type: 'annotation', position: [10, 0.2, 0], rotationY: 0, params: { text: 'far note', icon: 'info', tag: '', unit: '', decimals: 0 } },
        ],
        packages: [box],
      })
      store.setState({ selectedIds: [] })
      return { ok: true, ids: store.getState().scene.parts.map((p) => p.id) }
    })
    check('scene loaded', !loaded.error && ['group_1', 'boxA', 'boxB', 'note_1'].every((id) => loaded.ids.includes(id)), loaded.error || loaded.ids.join(','))
    if (loaded.error) return
    await page.waitForFunction(() => !window.__oip.assetsBusy?.(), { timeout: 30000 }).catch(() => {})
    await page.waitForTimeout(500)

    // frame the ids and wait for the focus animation to land; returns the target and the orbit distance
    const frame = (ids) => page.evaluate(async (ids) => {
      const view = window.__oip.view
      view.focusOn(ids)
      const t0 = performance.now()
      while (view.focusAnim && performance.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50))
      const p = view.cameraPose()
      return { landed: !view.focusAnim, tx: p.tx, ty: p.ty, tz: p.tz, dist: Math.hypot(p.px - p.tx, p.py - p.ty, p.pz - p.tz) }
    }, ids)
    const at = (f) => `target ${f.tx.toFixed(2)}, ${f.ty.toFixed(2)}, ${f.tz.toFixed(2)}; dist ${f.dist.toFixed(2)}`

    // --- 1. controls: each alone frames its own centre ---------------------------
    const a = await frame(['boxA'])
    check('control: the focus animation lands', a.landed)
    check('control: boxA alone frames boxA', Math.abs(a.tx) < 0.05 && Math.abs(a.tz) < 0.05, at(a))
    const n = await frame(['note_1'])
    check('control: the note alone frames the note (footprint fallback)', Math.abs(n.tx - 10) < 0.05 && Math.abs(n.tz) < 0.05, at(n))

    // --- 2. box + note: the note is in the frame ---------------------------------
    const an = await frame(['boxA', 'note_1'])
    check('box + note frames between them, not the box alone', Math.abs(an.tx - 5) < 0.3, at(an))
    check('box + note pulls back to fit both', an.dist > a.dist * 3, `${an.dist.toFixed(2)} vs ${a.dist.toFixed(2)} m`)

    // --- 3. a group at its members' centroid adds nothing ------------------------
    const ab = await frame(['boxA', 'boxB'])
    const gab = await frame(['group_1', 'boxA', 'boxB'])
    check('control: A + B frames their midpoint', Math.abs(ab.tx - 1) < 0.05, at(ab))
    check('group + members frames exactly like the members', Math.abs(gab.tx - ab.tx) < 0.01 && Math.abs(gab.ty - ab.ty) < 0.01 && Math.abs(gab.dist - ab.dist) < 0.01, `${at(gab)} vs ${at(ab)}`)

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
