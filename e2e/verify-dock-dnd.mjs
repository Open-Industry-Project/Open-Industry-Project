// Verify dock drag-and-drop: dragging a dock tab onto another slot moves the panel
// there (the drag affordance added alongside the ▾ move menu). HTML5 DnD can't be
// driven by mouse.move in headless, so we dispatch DragEvents sharing one DataTransfer
// - exactly what the browser does - and assert the persisted layout changed.
// Run: node e2e/verify-dock-dnd.mjs
/* global process, console, window, localStorage */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`

let failed = false
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) failed = true
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto(URL)
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })
  // wait for the dock chrome to mount
  await page.waitForSelector('.dock-slot-bottom', { timeout: 10000 })

  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('oip-web/dock-layout') || 'null'))
  ok(before && before.leftTop?.includes('tree'), `Scene starts in leftTop (got ${JSON.stringify(before?.leftTop)})`)

  // drag the "Scene" tab onto the bottom slot via a shared DataTransfer
  const dispatched = await page.evaluate(() => {
    const DND = 'application/x-oip-dock-panel'
    const tab = [...document.querySelectorAll('.dock-slot-tab')].find((b) => b.textContent.trim() === 'Scene')
    const target = document.querySelector('.dock-slot-bottom')
    if (!tab || !target) return { ok: false, err: `missing ${!tab ? 'tab' : 'target'}` }
    const dt = new DataTransfer()
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
    fire(tab, 'dragstart')
    fire(target, 'dragenter')
    fire(target, 'dragover')
    fire(target, 'drop')
    fire(tab, 'dragend')
    return { ok: true, payload: dt.getData(DND) }
  })
  ok(dispatched.ok, `dispatched drag events (${dispatched.err ?? 'ok'})`)
  ok(dispatched.payload === 'tree', `dragstart wrote panel id to DataTransfer (got "${dispatched.payload}")`)

  await page.waitForTimeout(250) // let setState + the save effect flush
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('oip-web/dock-layout') || 'null'))
  ok(after?.bottom?.includes('tree'), `Scene moved to bottom slot (got ${JSON.stringify(after?.bottom)})`)
  ok(!after?.leftTop?.includes('tree'), `Scene left its old slot (leftTop=${JSON.stringify(after?.leftTop)})`)
  ok(after?.active?.bottom === 'tree', `dropped panel became the active tab (got ${after?.active?.bottom})`)

  // bottom now ends in 'tree'; reorder by dragging the 'catalog' tab onto the right half of the
  // 'tree' tab → catalog should land right after tree, every other tab keeping its order
  const reordered = await page.evaluate(() => {
    const DND = 'application/x-oip-dock-panel'
    const tabs = [...document.querySelectorAll('.dock-slot-bottom .dock-slot-tab')]
    const src = tabs.find((b) => b.textContent.trim() === 'Parts')
    const tree = tabs.find((b) => b.textContent.trim() === 'Scene')
    if (!src || !tree) return { ok: false, err: 'missing tab' }
    const r = tree.getBoundingClientRect()
    const rightX = r.left + r.width * 0.8
    const dt = new DataTransfer()
    const fire = (el, type, x) =>
      el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x }))
    fire(src, 'dragstart', 0)
    fire(tree, 'dragover', rightX)
    fire(tree, 'drop', rightX)
    fire(src, 'dragend', 0)
    return { ok: true }
  })
  ok(reordered.ok, `dispatched reorder drag (${reordered.err ?? 'ok'})`)
  await page.waitForTimeout(250)
  const final = await page.evaluate(() => JSON.parse(localStorage.getItem('oip-web/dock-layout') || 'null'))
  // derived from the strip before the drag, not a literal: the bottom dock's default tabs grow over time
  const rest = (after?.bottom ?? []).filter((p) => p !== 'catalog')
  const want = [...rest.slice(0, rest.indexOf('tree') + 1), 'catalog', ...rest.slice(rest.indexOf('tree') + 1)]
  ok(
    JSON.stringify(final?.bottom) === JSON.stringify(want),
    `tab reordered within slot to ${JSON.stringify(want)} (got ${JSON.stringify(final?.bottom)})`,
  )
} finally {
  await browser.close()
  vite.kill()
}

console.log(failed ? '\nDOCK DND: FAIL' : '\nDOCK DND: OK')
process.exit(failed ? 1 : 0)
