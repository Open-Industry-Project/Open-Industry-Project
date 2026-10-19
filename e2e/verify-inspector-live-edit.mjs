// Verify the Inspector's number fields: continuous gestures stream as one live edit, and only a ranged field drags.
//
// If every step of lengthening a conveyor from the Inspector is a full commit, the whole gesture hitches: a
// whole-App React render, a synchronous whole-project autosave (then one every 400 ms), a full instance-pool
// rebuild whenever a roller or leg count moves, and on WebGPU a render-bundle re-record per step (the flow
// arrow's signature tracks length, and only a pointer drag ejects the part from the bundles). A field that
// drag-scrubs at 5 steps per pixel whatever the range moves Length half a metre per pixel.
//
// What this checks (fields.tsx SpinSlider, store.beginLiveEdit):
//   A. a held spin arrow on Length streams as one live edit: the part is ejected from the pool and bundles
//      while it runs, React isn't notified per step, and the release is one undo step
//   B. Length is open-ended, so dragging across it changes nothing (its continuous control is the viewport
//      handle); a click still focuses it to type
//   C. Width has a real range (0.2-3 m), so it is a slider: a drag moves it in proportion to the range (the
//      field's width spans it all), as one undo step, and Escape mid-drag puts it back
// Reported, not enforced: frame times for the held arrow with the live edit and with it switched off.
// Run: node e2e/verify-inspector-live-edit.mjs [--headed] [--baseline-first]
/* global process, console, window, localStorage, requestAnimationFrame, performance */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/?scene=demo`
const HEADED = process.argv.includes('--headed')
// time the per-commit baseline first (the live arm then runs warm): the first gesture on a fresh page has one-off
// costs (first ejection, first draw of the unbundled path) that would otherwise fall on whichever arm goes first
const BASELINE_FIRST = process.argv.includes('--baseline-first')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

const row = (key) => `.prop-row[data-param="${key}"]`
const input = (key) => `${row(key)} .spin-input`

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  page.setDefaultTimeout(30000)
  // an HMR full reload (someone saving src/render/ mid-run) swaps the page under the gate: say so, don't
  // read it as a verdict on the code
  let loads = 0
  page.on('load', () => loads++)
  const waitForApp = () => page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), null, { timeout: 90000, polling: 250 })
  const param = (id, key) => page.evaluate(([i, k]) => window.__oip.store.getState().scene.parts.find((p) => p.id === i).params[k], [id, key])
  const history = () => page.evaluate(() => window.__oip.store.getEditHistory().cursor)
  const ejected = (id) => page.evaluate((i) => {
    const v = /** @type {any} */ (window.__oip.view)
    return { pool: !!v.poolDragEject?.has(i), bundle: !!v.bundleDragEjected?.has(i) }
  }, id)
  // count React-channel notifies and record frame deltas from here on
  const startWatch = () => page.evaluate(() => {
    const w = /** @type {any} */ (window)
    w.__react = 0
    w.__unsub?.()
    w.__unsub = window.__oip.store.subscribe(() => w.__react++)
    w.__fr = []
    w.__frOn = true
    let last = performance.now()
    const loop = (t) => { if (!w.__frOn) return; w.__fr.push(t - last); last = t; requestAnimationFrame(loop) }
    requestAnimationFrame(loop)
  })
  const reactCount = () => page.evaluate(() => /** @type {any} */ (window).__react)
  const stopWatch = () => page.evaluate(() => {
    const w = /** @type {any} */ (window)
    w.__frOn = false
    w.__unsub?.()
    const f = w.__fr.slice(2).sort((a, b) => a - b) // the first deltas straddle the recorder's start
    const q = (p) => Math.round(f[Math.min(f.length - 1, Math.floor(f.length * p))] ?? 0)
    return { react: w.__react, p50: q(0.5), p95: q(0.95), max: q(1) }
  })

  // hold the field's up arrow for `ms` (the arrows are hover-revealed: hover the field first)
  const holdUp = async (key, ms, midProbe) => {
    await page.hover(input(key))
    const up = await page.locator(`${row(key)} .spin-up`).boundingBox()
    await page.mouse.move(up.x + up.width / 2, up.y + up.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(ms / 2)
    const mid = midProbe ? await midProbe() : null
    const reactMid = await reactCount()
    await page.waitForTimeout(ms / 2)
    await page.mouse.up()
    await page.mouse.move(0, 0) // off the arrow (a pointerleave also ends a hold)
    return { mid, reactMid }
  }
  // press on the field and drag right by `px` in 2 px moves; `beforeUp` runs while the button is still down
  const drag = async (key, px, beforeUp) => {
    const box = await page.locator(input(key)).boundingBox()
    const x0 = box.x + box.width / 2
    const y0 = box.y + box.height / 2
    await page.mouse.move(x0, y0)
    await page.mouse.down()
    for (let x = 2; x <= px; x += 2) await page.mouse.move(x0 + x, y0)
    if (beforeUp) await beforeUp()
    await page.mouse.up()
    await page.waitForTimeout(300)
  }

  try {
    await page.goto(URL)
    await waitForApp()
    await page.evaluate(() => localStorage.setItem('oip-web/tutorial-done', '1'))
    await page.reload()
    await waitForApp()
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 180000, polling: 250 }).catch(() => {})

    const id = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => /roller-conveyor$/.test(p.packageId ?? '') && typeof p.params?.length === 'number')?.id ?? null)
    check('the demo has a roller conveyor with a Length param', id !== null)
    if (id === null) return
    await page.evaluate((i) => window.__oip.store.select(i), id)
    await page.waitForSelector(input('length'))
    await page.waitForTimeout(1000)
    const loads0 = loads
    // the per-commit baseline: the same held arrow with the live edit switched off
    const baselineHold = async () => {
      await page.evaluate(() => { const st = /** @type {any} */ (window.__oip.store); st.beginLiveEdit = () => {} })
      await startWatch()
      const b = await holdUp('length', 1400)
      const stats = await stopWatch()
      await page.evaluate(() => { const st = /** @type {any} */ (window.__oip.store); delete st.beginLiveEdit; st.undo() })
      await page.waitForTimeout(500)
      return { ...stats, reactMid: b.reactMid }
    }
    const early = BASELINE_FIRST ? await baselineHold() : null

    // ── A. held arrow on Length: one live edit ──
    const len0 = await param(id, 'length')
    let h0 = await history()
    await startWatch()
    const held = await holdUp('length', 1400, () => ejected(id))
    const heldStats = await stopWatch()
    const len1 = await param(id, 'length')
    check('A holding the up arrow lengthens the conveyor by several steps', len1 >= len0 + 0.25, `${len0} -> ${len1}`)
    check('A mid-hold the part is ejected from the instance pool', held.mid?.pool === true, JSON.stringify(held.mid))
    check('A mid-hold the part is ejected from the render bundles (or bundles are off)',
      held.mid?.bundle === true || !(await page.evaluate(() => 'bundleDragEjected' in /** @type {any} */ (window.__oip.view))), JSON.stringify(held.mid))
    check('A React is not notified per step', held.reactMid === 0, `${held.reactMid} notifies mid-hold`)
    check('A ... and a handful of times for the release', heldStats.react >= 1 && heldStats.react <= 5, `${heldStats.react}`)
    await page.waitForTimeout(300)
    const after = await ejected(id)
    check('A after the release the part is back in the pool and the bundles', !after.pool && !after.bundle, JSON.stringify(after))
    check('A the whole hold is one undo step', (await history()) === h0 + 1, `history ${h0} -> ${await history()}`)
    await page.evaluate(() => window.__oip.store.undo())
    await page.waitForTimeout(300)
    check('A undo restores the original length', (await param(id, 'length')) === len0, `${await param(id, 'length')}`)

    // ── B. Length is open-ended: no drag, click still types ──
    h0 = await history()
    await drag('length', 60)
    check('B dragging across the open-ended Length changes nothing', (await param(id, 'length')) === len0 && (await history()) === h0, `${await param(id, 'length')}`)
    check('B Length draws no slider fill', (await page.$(`${row('length')} .spin-fill`)) === null)
    await page.keyboard.press('Escape') // the drag's release focused the field (a press that ends where it began is a click)
    await page.click(input('length'))
    await page.keyboard.press('Control+A'); await page.keyboard.type('20ft'); await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    check('B a click types into Length, and "20ft" lands as 6.096 m', Math.abs((await param(id, 'length')) - 6.096) < 1e-9, `${await param(id, 'length')}`)
    await page.evaluate(() => window.__oip.store.undo())
    await page.waitForTimeout(300)

    // ── C. Width is ranged: a slider ──
    const w0 = await param(id, 'width')
    const fieldW = await page.locator(`${row('width')} .spin`).evaluate((e) => e.getBoundingClientRect().width)
    h0 = await history()
    await drag('width', 40)
    const w1 = await param(id, 'width')
    // 40 px of a field that spans 0.2-3 m, less the 4 px grab threshold's worth never applied (it is counted)
    const expect = w0 + (40 / fieldW) * 2.8
    check('C dragging Width moves it in proportion to its range', Math.abs(w1 - expect) <= 0.05 + 1e-9, `${w0} -> ${w1}, expected ~${expect.toFixed(3)} over a ${Math.round(fieldW)} px field`)
    check('C the slide is one undo step', (await history()) === h0 + 1, `history ${h0} -> ${await history()}`)
    await page.evaluate(() => window.__oip.store.undo())
    await page.waitForTimeout(300)
    h0 = await history()
    await drag('width', 40, () => page.keyboard.press('Escape'))
    check('C Escape mid-slide puts Width back', (await param(id, 'width')) === w0, `${await param(id, 'width')}`)
    check('C ... and keeps the part selected', (await page.evaluate(() => window.__oip.store.getState().selectedIds.join(','))) === id)

    const baseStats = early ?? (await baselineHold())
    check('baseline arm really commits per step (the A/B is not vacuous)', baseStats.reactMid >= 3, `${baseStats.reactMid} notifies mid-hold`)
    check('HARNESS: the page did not reload mid-gate', loads === loads0, `${loads - loads0} reload(s)`)
    console.log(`note  order: ${BASELINE_FIRST ? 'baseline first' : 'live edit first'}`)
    console.log(`note  frame ms over a held arrow, live edit : p50 ${heldStats.p50}  p95 ${heldStats.p95}  max ${heldStats.max}`)
    console.log(`note  frame ms over a held arrow, per-commit: p50 ${baseStats.p50}  p95 ${baseStats.p95}  max ${baseStats.max}`)
  } catch (e) {
    check('the gate ran to completion', false, String(e).split('\n')[0])
  } finally {
    await browser.close().catch(() => {})
    vite.kill()
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
    process.exit(failures ? 1 : 0)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
