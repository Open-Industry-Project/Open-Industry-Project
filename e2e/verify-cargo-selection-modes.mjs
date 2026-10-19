// Gate: the SimBoxes cargo selection channel (aSel).
// Selected cargo stays in the instanced batch - its rows carry the per-instance aSel tier the
// outline mask discards on (boxes.setSelectionTiers, the SimBoxes twin of
// instancePool.setSelectionTiers) - rather than leaving the batch as a standalone mesh
// (~3 draws/body: main + shadow + mask). Checks:
//  A) sim running: selected box keeps aSel>=1 while its row repacks per frame
//  B) multi-select ending on cargo puts that row on the active tier (aSel=2)
//  C) deselect clears every row back to aSel=0
// Run: node e2e/verify-cargo-selection-modes.mjs
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()

let failures = 0
const check = (name, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function boot(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await page.addInitScript(() => {
    try { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ignore */ }
  })
  await page.goto(url)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 60000 })
  await page.waitForTimeout(2500)
  return page
}

const rowTierFn = `(partId) => {
  const view = window.__oip.view
  for (const [mesh, meta] of [[view.boxes.mesh, view.boxes.boxMeta], [view.boxes.palletMesh, view.boxes.palletMeta]]) {
    const attr = mesh.geometry.getAttribute('aSel')
    if (!attr) return -1
    for (let i = 0; i < meta.length; i++) if (meta[i].partId === partId) return attr.array[i]
  }
  return -2
}`

async function main() {
  const browser = await chromium.launch({ headless: true })
  try {
    // ---- A + B: consolidated path ----
    let page = await boot(browser, `http://localhost:${PORT}/app/?scene=demo`)
    const boxId = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.packageId === 'oip.box')?.id)
    const otherId = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.type === 'part' && p.packageId !== 'oip.box' && p.packageId !== 'oip.pallet')?.id)

    // B: multi-select [other, box] - box is last-selected → active tier
    await page.evaluate(({ a, b }) => window.__oip.store.selectMany([a, b]), { a: otherId, b: boxId })
    await page.waitForTimeout(300)
    const tierActive = await page.evaluate(`(${rowTierFn})(${JSON.stringify(boxId)})`)
    check('B: last-selected cargo rides the ACTIVE tier (aSel=2)', tierActive === 2, `aSel=${tierActive}`)

    // A: run the sim, keep the box selected alone (regular tier), sample across frames
    await page.evaluate((id) => window.__oip.store.select(id), boxId)
    await page.evaluate(() => window.__oip.store.setRunning(true))
    await page.waitForTimeout(2500)
    const samples = []
    for (let s = 0; s < 4; s++) {
      samples.push(await page.evaluate(`(${rowTierFn})(${JSON.stringify(boxId)})`))
      await page.waitForTimeout(250)
    }
    check('A: selected cargo keeps aSel>=1 across live frames', samples.every((t) => t >= 1), `samples=${samples.join(',')}`)
    // the batch is the only place cargo draws from: nothing may escape it on selection
    const batchOnly = await page.evaluate(() => {
      const g = window.__oip.view.boxes.group
      return g.children.every((c) => c.isInstancedMesh === true)
    })
    check('A: cargo never leaves the instanced batch', batchOnly === true, `batchOnly=${batchOnly}`)

    // C: deselecting clears every aSel row back to 0
    await page.evaluate(() => window.__oip.store.select(null))
    await page.waitForTimeout(400)
    const anySelRow = await page.evaluate(() => {
      const view = window.__oip.view
      for (const mesh of [view.boxes.mesh, view.boxes.palletMesh]) {
        const attr = mesh.geometry.getAttribute('aSel')
        if (!attr) continue
        for (let i = 0; i < mesh.count; i++) if (attr.array[i] !== 0) return true
      }
      return false
    })
    check('C: deselect clears every aSel row', anySelRow === false, `anySelRow=${anySelRow}`)
    await page.close()

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
