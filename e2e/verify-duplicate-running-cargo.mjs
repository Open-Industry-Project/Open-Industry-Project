// Verify duplicating a running box copies it where it is, not where it was authored.
//
// Physics owns a running cargo body, so the part's own transform is a stale spawn pose. Cloning that
// transform verbatim would make Ctrl+D on a box riding a belt drop the copy back at the head of the
// line (the same staleness the gizmo/drag paths handle via liveCargo). The store rebases every copy
// source through the controller's live-cargo seam (storeCopy.copySourceParts / LiveCargoHost), and
// cargo minted mid-run is run-scoped, so Stop drops it like a mid-run drop.
//
// Covers: Ctrl+D (the real key), the Shift+drag duplicate's detached seam, and the Stop rule.
//
// Run: node e2e/verify-duplicate-running-cargo.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }
const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity)
const fmt = (p) => (p ? `[${p.map((v) => v.toFixed(2)).join(', ')}]` : 'null')

const SPAWN = [2, 3.0, 0] // box_1's authored pose: above the belt head, so it drops on and rides

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture|WebGPU unavailable|custom-part mesh load failed/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })

  try {
    // warm-up visit: a cold vite re-optimizes the lazily-discovered sim worker (Jolt) on the first
    // run and full-reloads mid-script, killing the evaluate contexts - so spend one run here
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 60000 })
    await page.waitForTimeout(3000)
    await page.evaluate(() => window.__oip.controller.run()).catch(() => {})
    await page.waitForTimeout(5000)
    await page.evaluate(() => window.__oip.controller.stop()).catch(() => {})
    await page.waitForTimeout(1500)
    errors.length = 0
    await page.reload()
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
    await page.waitForTimeout(800)
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click({ force: true }).catch(() => {})

    const loaded = await page.evaluate((spawn) => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const pkgs = st.getState().bundledPackages
      const want = ['oip.belt-conveyor', 'oip.box']
      const found = want.map((id) => pkgs.find((p) => p.id === id))
      if (found.some((p) => !p)) return { ok: false, have: pkgs.map((p) => p.id) }
      st.loadScene({
        ...scene,
        parts: [
          { id: 'belt_1', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0, 0], rotationY: 0, params: { length: 14, speed: 1, standHeight: 2 } },
          { id: 'box_1', type: 'part', packageId: 'oip.box', position: spawn, rotationY: 0, params: {} },
        ],
        packages: found,
      })
      st.setState({ selectedIds: [] })
      return { ok: true }
    }, SPAWN)
    check('scene loaded (belt + one authored box)', loaded.ok, loaded.ok ? '' : `have=${loaded.have}`)
    if (!loaded.ok) throw new Error('bundled packages missing')

    await page.waitForTimeout(2000)
    await page.evaluate(() => window.__oip.view.focusOn([]))

    // --- run, and let the box ride well away from its authored spawn pose --------------------
    await page.evaluate(() => window.__oip.controller.run())
    let travelled = 0
    const t0 = Date.now()
    while (Date.now() - t0 < 25000) {
      await page.waitForTimeout(400)
      travelled = await page.evaluate((sx) => {
        const v = window.__oip.view
        const p = new (v.camera.position.constructor)()
        return v.boxes.livePartPosition('box_1', p) ? p.x - sx : 0
      }, SPAWN[0])
      if (travelled > 2.5) break
    }
    check('the box left its authored spawn pose (test is meaningful)', travelled > 1.5, `moved ${travelled.toFixed(2)} m in X`)

    // Pause: still running (cargo keeps its live pose) but nothing moves, so every pose sampled
    // below still describes the world when the duplicate is made.
    await page.evaluate(() => window.__oip.controller.togglePause())
    await page.waitForTimeout(400)
    check('sim is paused but still RUNNING', await page.evaluate(() => window.__oip.store.getState().running))

    await page.evaluate(() => window.__oip.store.select('box_1'))
    await page.waitForTimeout(300)

    const before = await page.evaluate(() => {
      const st = window.__oip.store
      const s = st.getState()
      const c = window.__oip.controller
      const v = window.__oip.view
      const p = new (v.camera.position.constructor)()
      const box = s.scene.parts.find((x) => x.id === 'box_1')
      return {
        ids: s.scene.parts.map((x) => x.id),
        authored: [...box.position],
        live: c.liveCargo.get('box_1')?.position ?? null,
        body: v.boxes.livePartPosition('box_1', p) ? [p.x, p.y, p.z] : null,
        undo: st.getEditHistory().cursor,
      }
    })
    console.log(`      box_1 authored=${fmt(before.authored)} live=${fmt(before.live)} body=${fmt(before.body)}`)
    check('the controller tracks the selected box\'s live pose', !!before.live)
    check('live and authored poses actually differ (test is meaningful)',
      dist(before.live, before.authored) > 1, `apart by ${dist(before.live, before.authored).toFixed(2)} m`)

    // --- Ctrl+D, the real key ----------------------------------------------------------------
    await page.keyboard.press('Control+d')
    await page.waitForTimeout(500)

    const dup = await page.evaluate((prev) => {
      const st = window.__oip.store
      const s = st.getState()
      const seen = new Set(prev)
      const added = s.scene.parts.filter((p) => !seen.has(p.id))
      const box = s.scene.parts.find((x) => x.id === 'box_1')
      return {
        added: added.map((p) => ({ id: p.id, packageId: p.packageId, position: [...p.position] })),
        origAuthored: [...box.position],
        selected: s.selectedIds,
        undo: st.getEditHistory().cursor,
        runScoped: [...window.__oip.controller.runPromotedBoxes],
      }
    }, before.ids)
    check('Ctrl+D added exactly one part', dup.added.length === 1, `added=${JSON.stringify(dup.added.map((p) => p.id))}`)
    if (dup.added.length !== 1) throw new Error('duplicate did not add a part')
    const clone = dup.added[0]
    console.log(`      clone ${clone.id} at ${fmt(clone.position)}`)

    check('THE FIX: the copy lands on the LIVE body, not the authored spawn pose',
      dist(clone.position, before.live) < 0.05,
      `clone ${fmt(clone.position)} vs live ${fmt(before.live)} - off by ${dist(clone.position, before.live).toFixed(3)} m`)
    check('the copy is nowhere near the authored spawn pose',
      dist(clone.position, before.authored) > 1,
      `only ${dist(clone.position, before.authored).toFixed(2)} m from ${fmt(before.authored)}`)
    check('the ORIGINAL keeps its authored spawn pose (a copy is not a bake)',
      dist(dup.origAuthored, before.authored) < 1e-6, `now ${fmt(dup.origAuthored)}`)
    check('the copy is selected', dup.selected.length === 1 && dup.selected[0] === clone.id, JSON.stringify(dup.selected))
    // the copy is run-owned (below: Stop drops it), so minting it is run state, not an edit - the store's edit
    // gate gives it no undo step (AGENTS.md "Only authoring writes the document"; verify-run-cargo-not-edits)
    check('no undo step: a run-owned copy is no edit', dup.undo - before.undo === 0, `undo grew by ${dup.undo - before.undo}`)
    check('the copy is run-scoped (Stop will drop it, like a mid-run cargo drop)',
      dup.runScoped.includes(clone.id), `runPromotedBoxes=${JSON.stringify(dup.runScoped)}`)

    // --- the Shift+drag duplicate's seam (same store entry point, no gizmo needed) -------------
    const detached = await page.evaluate(() => {
      const st = window.__oip.store
      st.select('box_1')
      const d = st.duplicateSelectionDetached() // pure: returns a scene, commits nothing
      if (!d) return null
      const clone = d.scene.parts.find((p) => p.id === d.selectionIds[0])
      return { position: [...clone.position] }
    })
    check('Shift+drag duplicate stages its clone on the live body too',
      detached && dist(detached.position, before.live) < 0.05,
      `staged at ${fmt(detached?.position)} vs live ${fmt(before.live)}`)

    // --- resume: the copy must exist as a real body where the original is ---------------------
    await page.evaluate(() => window.__oip.controller.togglePause())
    await page.waitForTimeout(600)
    const cloneBody = await page.evaluate((id) => {
      const v = window.__oip.view
      const p = new (v.camera.position.constructor)()
      return v.boxes.livePartPosition(id, p) ? [p.x, p.y, p.z] : null
    }, clone.id)
    console.log(`      clone body after resume: ${fmt(cloneBody)}`)
    check('the copy became a live body in the running sim', !!cloneBody)
    // the pair spawns interpenetrating and shoves apart, so this is a "near, not at the spawn
    // pose" check, not an equality one
    check('the copy is simulating next to the original, not back at the line head',
      dist(cloneBody, before.live) < dist(cloneBody, before.authored),
      `${dist(cloneBody, before.live).toFixed(2)} m from live vs ${dist(cloneBody, before.authored).toFixed(2)} m from authored`)

    // --- Stop drops the mid-run copy, keeps the authored original -----------------------------
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(600)
    const stopped = await page.evaluate((id) => {
      const s = window.__oip.store.getState()
      const box = s.scene.parts.find((p) => p.id === 'box_1')
      return { hasClone: s.scene.parts.some((p) => p.id === id), origin: box ? [...box.position] : null, selected: s.selectedIds }
    }, clone.id)
    check('Stop dropped the mid-run copy (run-scoped cargo)', !stopped.hasClone)
    check('Stop kept the authored original at its spawn pose',
      dist(stopped.origin, before.authored) < 1e-6, `${fmt(stopped.origin)} vs ${fmt(before.authored)}`)
    check('the dropped copy was pruned from the selection', !stopped.selected.includes(clone.id), JSON.stringify(stopped.selected))

    // --- regression guard: duplicating while stopped still copies the authored pose -----------
    const idle = await page.evaluate(() => {
      const st = window.__oip.store
      st.select('box_1')
      const prev = new Set(st.getState().scene.parts.map((p) => p.id))
      st.duplicateSelection()
      const s = st.getState()
      const added = s.scene.parts.filter((p) => !prev.has(p.id))
      return {
        n: added.length,
        position: added[0] ? [...added[0].position] : null,
        runScoped: [...window.__oip.controller.runPromotedBoxes],
      }
    })
    check('stopped: duplicate still copies the authored pose exactly',
      idle.n === 1 && dist(idle.position, before.authored) < 1e-6, `${idle.n} added at ${fmt(idle.position)}`)
    check('stopped: the copy is durable (not run-scoped)', idle.runScoped.length === 0, JSON.stringify(idle.runScoped))

    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close().catch(() => {})
    vite.kill()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
