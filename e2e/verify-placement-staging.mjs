// Placement-staging regression check (docs/placement-staging.md): drives the exact
// seam the Catalog UI uses (beginCatalogPlace / catalogPlaceMove / endCatalogPlace) and
// asserts the staged-preview invariants. Run: node e2e/verify-placement-staging.mjs
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { coverLifted } from './_settle.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`

async function waitForApp(page) {
  await page.waitForFunction(() => {
    const h = window.__oip
    return !!(h && h.store && h.view && h.controller && h.sim)
  }, { timeout: 20000 })
  // …and the loading cover is out of the way. It is opaque and takes pointer events until `.ready`, so a
  // viewport click before then hits the cover (elementFromPoint returns its logo IMG), not the canvas,
  // and looks like the app ignoring the click.
  await coverLifted(page)
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  try {
    await page.goto(URL)
    await waitForApp(page)
    // first dev visit can trigger vite dep-optimization which force-reloads the page;
    // settle, clear state, reload, settle again so the evaluate context is stable
    await page.waitForTimeout(4000)
    // fresh state, but keep the onboarding tour dismissed: its modal overlays the viewport
    // and would block the real pointer input the click-to-place phase drives
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(3000)
    await waitForApp(page)

    const result = await page.evaluate(async () => {
      const { controller, store, view } = window.__oip
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const out = { checks: [], ok: true }
      const check = (name, cond, extra) => {
        out.checks.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`)
        if (!cond) out.ok = false
      }
      const canvas = view.renderer?.domElement ?? document.querySelector('canvas')
      const r = canvas.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2

      // ---- 1. catalog drag: press card → travel → staged preview → drop -----------------
      const base = store.getState().scene
      controller.beginCatalogPlace('part', 60, 60, 'oip.box')
      controller.catalogPlaceMove(cx, cy, false) // travels > threshold ⇒ a drag
      await sleep(50)
      controller.catalogPlaceMove(cx + 8, cy + 8, false)
      const during = store.getState()
      check('drag: placing mode', during.mode === 'placing')
      check('drag: staged part in transient scene', during.scene.parts.length === base.parts.length + 1,
        `${base.parts.length} -> ${during.scene.parts.length}`)
      const staged = during.scene.parts.find((p) => !base.parts.some((b) => b.id === p.id))
      check('drag: staged part exists', !!staged)
      const stagedId = staged?.id
      // the staged preview must not be pickable
      const picked = view.pickPart(cx + 8, cy + 8)
      check('drag: staged part not pickable', picked !== stagedId, `picked=${picked}`)
      controller.endCatalogPlace(cx + 8, cy + 8, false)
      await sleep(50)
      const afterDrop = store.getState()
      check('drop: back to idle (drag is one-shot)', afterDrop.mode === 'idle')
      const placed = afterDrop.scene.parts.find((p) => p.id === stagedId)
      check('drop: committed part has THE SAME id as the staged preview', !!placed, `id=${stagedId}`)
      check('drop: exactly one part added', afterDrop.scene.parts.length === base.parts.length + 1)
      // committed part is a real part: pickable now
      const picked2 = view.pickPart(cx + 8, cy + 8)
      check('drop: placed part pickable after commit', picked2 === stagedId, `picked=${picked2}`)

      // ---- 2. undo returns to the base scene (no leftover preview) ----------------------
      store.undo()
      await sleep(50)
      const afterUndo = store.getState().scene
      check('undo: part count back to base', afterUndo.parts.length === base.parts.length,
        `${afterUndo.parts.length} vs ${base.parts.length}`)
      check('undo: staged id gone', !afterUndo.parts.some((p) => p.id === stagedId))
      store.redo()
      await sleep(50)
      check('redo: part back', store.getState().scene.parts.some((p) => p.id === stagedId))

      // ---- 3. cancel path: drag off then Esc reverts the transient ----------------------
      const base2 = store.getState().scene
      controller.beginCatalogPlace('part', 60, 60, 'oip.pallet')
      controller.catalogPlaceMove(cx - 40, cy - 20, false)
      await sleep(50)
      check('cancel: staged during second drag', store.getState().scene.parts.length === base2.parts.length + 1)
      controller.cancelCatalogPlace()
      await sleep(50)
      const afterCancel = store.getState()
      check('cancel: scene reverted to base', afterCancel.scene === base2 || afterCancel.scene.parts.length === base2.parts.length,
        `${afterCancel.scene.parts.length} vs ${base2.parts.length}`)
      check('cancel: mode idle', afterCancel.mode === 'idle')

      // ---- 3b. a staged unit load previews its self-stacked pallet + cases --------------
      // it draws nothing of its own: its pieces exist only in the idle cargo batch, so a
      // staged load must stay in that batch (a staged box stays out: its visual is the preview)
      const base4 = store.getState().scene
      controller.beginCatalogPlace('part', 60, 60, 'oip.unit-load')
      controller.catalogPlaceMove(cx - 30, cy + 10, false)
      await sleep(50)
      controller.catalogPlaceMove(cx - 26, cy + 14, false)
      await sleep(50)
      const ulStaged = store.getState().scene.parts.find((p) => !base4.parts.some((b) => b.id === p.id))
      const rows = (view.idleCargoFrame?.partIds ?? []).filter((id) => id === ulStaged?.id).length
      check('unit load: staged preview shows its pallet + cases', rows === 16, `rows=${rows}`) // 1 pallet + 3 courses of 5
      const ulY0 = ulStaged?.position[1]
      controller.catalogPlaceMove(cx - 22, cy + 18, false) // a move over its own stack must not climb it
      await sleep(50)
      const ulY1 = store.getState().scene.parts.find((p) => p.id === ulStaged?.id)?.position[1]
      check('unit load: does not rest on its own cases', ulY0 !== undefined && Math.abs((ulY1 ?? NaN) - ulY0) < 0.05, `y ${ulY0} -> ${ulY1}`)
      check('unit load: staged preview not pickable', view.pickPart(cx - 22, cy + 18) !== ulStaged?.id)
      controller.cancelCatalogPlace()
      await sleep(50)
      check('unit load: cancel drops its pieces from the batch', !(view.idleCargoFrame?.partIds ?? []).includes(ulStaged?.id))

      // ---- 4. click-to-place arm: a card click (no travel) stays in placing mode --------
      const base3 = store.getState().scene
      controller.beginCatalogPlace('part', 60, 60, 'oip.rack')
      controller.endCatalogPlace(60, 60, false) // no travel ⇒ a click ⇒ stay placing
      await sleep(50)
      check('click-to-place: placing mode persists', store.getState().mode === 'placing')
      window.__stagingProbe = { base3Count: base3.parts.length, cx, cy }
      return out
    })

    // ---- click-to-place steer + commit via real pointer input --------------------------
    const probe = await page.evaluate(() => window.__stagingProbe)
    // pick two steer points that hit the canvas (docked panels such as the ST editor float
    // over parts of the canvas rect and would block the real pointer input)
    const spots = await page.evaluate(([cx, cy]) => {
      const candidates = [[cx - 140, cy], [cx + 140, cy], [cx, cy - 100], [cx + 220, cy], [cx - 220, cy], [cx, cy + 100]]
      return candidates.filter(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS')
    }, [probe.cx, probe.cy])
    if (spots.length < 2) throw new Error(`not enough clear canvas spots: ${JSON.stringify(spots)}`)
    const [spotA, spotB] = spots
    await page.mouse.move(spotA[0], spotA[1], { steps: 4 })
    await page.waitForTimeout(300)
    const steer = await page.evaluate(() => {
      const s = window.__oip.store.getState()
      return { count: s.scene.parts.length, mode: s.mode }
    })
    result.checks.push(`${steer.count === probe.base3Count + 1 ? 'PASS' : 'FAIL'} click-to-place: preview staged under cursor (${probe.base3Count} -> ${steer.count})`)
    if (steer.count !== probe.base3Count + 1) result.ok = false
    // first commit (mouse click on the viewport), mode must stay placing with a fresh session
    await page.mouse.down(); await page.mouse.up()
    await page.waitForTimeout(150)
    await page.mouse.move(spotB[0], spotB[1], { steps: 4 })
    await page.waitForTimeout(150)
    await page.mouse.down(); await page.mouse.up()
    await page.waitForTimeout(150)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    const finals = await page.evaluate((base3Count) => {
      const s = window.__oip.store.getState()
      const racks = s.scene.parts.filter((p) => p.packageId === 'oip.rack')
      return {
        count: s.scene.parts.length,
        mode: s.mode,
        rackIds: racks.map((p) => p.id),
      }
    }, probe.base3Count)
    const distinct = new Set(finals.rackIds).size === finals.rackIds.length
    result.checks.push(`${finals.rackIds.length === 2 && distinct ? 'PASS' : 'FAIL'} click-to-place: two commits, two distinct fresh ids (${JSON.stringify(finals.rackIds)})`)
    if (finals.rackIds.length !== 2 || !distinct) result.ok = false
    result.checks.push(`${finals.count === probe.base3Count + 2 ? 'PASS' : 'FAIL'} click-to-place: Esc after commits reverts only the preview (${probe.base3Count} + 2 = ${finals.count})`)
    if (finals.count !== probe.base3Count + 2) result.ok = false
    result.checks.push(`${finals.mode === 'idle' ? 'PASS' : 'FAIL'} click-to-place: Esc leaves placing mode`)
    if (finals.mode !== 'idle') result.ok = false

    for (const line of result.checks) console.log(line)
    console.log('page errors:', JSON.stringify(errors))
    if (!result.ok || errors.length > 0) {
      console.error('STAGING VERIFY: FAIL')
      process.exitCode = 1
    } else {
      console.log('STAGING VERIFY: ALL PASS')
    }
  } finally {
    await browser.close()
    vite.kill()
  }
}

// files being edited in parallel force full dev-server reloads that destroy the page's
// execution context mid-run; retry the whole flow a few times until one run is uninterrupted
async function run(attempt = 1) {
  try {
    await main()
  } catch (e) {
    if (attempt < 4 && /Execution context was destroyed|Target closed/.test(String(e?.message ?? e))) {
      console.log(`reload interrupted the run (attempt ${attempt}); retrying...`)
      return run(attempt + 1)
    }
    console.error(e)
    process.exit(1)
  }
}
run()
