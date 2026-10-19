// A storing part's stock is authored (PartPackage.holds, core/heldStock): real cargo parts at its gripper positions,
// parented to it, so the stopped scene shows what a run starts with. The Inspector's Stock row is the way in: this
// drives it on the demo's pallet dispenser in the real editor.
//
// Checks:
//   - the dispenser's Stock row reads the demo's one authored pallet;
//   - Fill places a pallet in every empty position (real parts, parented), as one undo step;
//   - Empty removes them, and both buttons are disabled while the sim runs (authoring only).
// A shot of the filled magazine, stopped, is saved to e2e/shots/dispenser-stock-filled.png.
//   node e2e/verify-dispenser-stock.mjs
/* global process, console, window */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { cleanShot } from './_shot.mjs'

const { port: PORT, vite } = await startServer()
const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`) }

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 30000 })
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]))
  page.on('dialog', (d) => d.accept())
  try {
    await page.goto(`http://localhost:${PORT}/app/`); await waitForApp(page)
    await page.evaluate(() => localStorage.clear())
    await page.reload(); await waitForApp(page)
    const tut = page.locator('.tut-close')
    if (await tut.count()) await tut.first().click()
    await clickDemo(page)
    await page.waitForFunction(() => window.__oip.assetsBusy && window.__oip.assetsBusy() === false, { timeout: 120000 })

    const disp = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.packageId === 'oip.pallet-dispenser'))
    check('the demo has a pallet dispenser', !!disp)
    if (!disp) return
    const held = () => page.evaluate((id) => window.__oip.store.getState().scene.parts.filter((p) => p.parent === id && p.packageId === 'oip.pallet').length, disp.id)
    await page.evaluate((id) => window.__oip.store.select(id), disp.id)
    const row = page.locator('.inspector-holds')
    await row.waitFor({ timeout: 10000 })
    const text = async () => (await row.locator('.inspector-holds-count').textContent())?.trim()
    check('the Stock row reads the one authored pallet', (await text()) === 'Stock: 1 of 10' && (await held()) === 1, `${await text()}, ${await held()} parented pallet(s)`)

    // the demo's one pallet, stopped: it has to sit on the forks (the idle preview sees what the magazine holds), not
    // float over a carriage parked down on the conveyor
    await page.evaluate((p) => window.__oip.view.setCameraPose({ px: p[0] + 1.6, py: p[1] + 0.9, pz: p[2] - 2.2, tx: p[0], ty: p[1] + 0.3, tz: p[2] }, { instant: true }), disp.position)
    await page.waitForTimeout(1500)
    await cleanShot(page, 'e2e/shots/dispenser-stock-one.png')
    await page.evaluate((id) => window.__oip.store.select(id), disp.id) // cleanShot deselects, which closes the Inspector
    await row.waitFor({ timeout: 10000 })

    const fill = row.getByRole('button', { name: 'Fill' })
    const empty = row.getByRole('button', { name: 'Empty' })
    await fill.click()
    await page.waitForFunction((id) => window.__oip.store.getState().scene.parts.filter((p) => p.parent === id).length === 10, disp.id, { timeout: 10000 }).catch(() => {})
    check('Fill places a pallet in every empty position', (await held()) === 10 && (await text()) === 'Stock: 10 of 10', `${await held()} held, "${await text()}"`)
    check('...and Fill is disabled once it is full', await fill.isDisabled())
    // from the open (-Z) loading side, where the stack shows between the guides
    await page.evaluate((p) => window.__oip.view.setCameraPose({ px: p[0] + 3.2, py: p[1] + 1.8, pz: p[2] - 3.4, tx: p[0], ty: p[1] + 0.8, tz: p[2] }, { instant: true }), disp.position)
    await page.waitForTimeout(1500)
    await cleanShot(page, 'e2e/shots/dispenser-stock-filled.png')

    await page.evaluate(() => window.__oip.store.undo())
    check('one undo takes the whole Fill back', (await held()) === 1, `${await held()} held`)
    await page.evaluate((id) => window.__oip.store.select(id), disp.id)
    await empty.click()
    check('Empty removes the held pallets', (await held()) === 0 && (await text()) === 'Stock: 0 of 10', `${await held()} held, "${await text()}"`)

    await page.evaluate(() => window.__oip.store.setRunning(true))
    await page.waitForTimeout(500)
    await page.evaluate((id) => window.__oip.store.select(id), disp.id)
    check('while running, Fill and Empty are disabled', (await fill.isDisabled()) && (await empty.isDisabled()))
    await page.evaluate(() => window.__oip.store.setRunning(false))
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
  }
}

try {
  await main()
} catch (e) {
  console.log(`FAIL  harness: ${e?.message ?? e}`)
  results.push({ name: 'harness', ok: false })
} finally {
  vite.kill()
}
const failed = results.filter((r) => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : `\nALL ${results.length} PASSED`)
process.exit(failed.length ? 1 : 0)
