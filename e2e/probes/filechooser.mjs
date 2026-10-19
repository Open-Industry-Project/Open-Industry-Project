// Why driving a hidden file input from a gate is fiddly here. Three findings, each of which cost a
// false FAIL in verify-import-project-command.mjs:
//
//   1. Only a trusted click opens a chooser. A programmatic .click() from page.evaluate opens nothing -
//      and the untouched scene picker behaves identically, so it is Chromium's user-activation rule,
//      not the app's wiring. dispatchEvent is out for the same reason.
//   2. locator.click() stalls. Actionability waits for the element's box to hold still across frames,
//      and this page draws ~2 fps once the scene settles, so a perfectly clickable button times out.
//      page.mouse.click() at the box centre is trusted and skips that wait.
//   3. An open chooser blocks the page. Until it is answered (setFiles([]) dismisses it) the next
//      keypress goes to the dialog and the next evaluate cannot run, so a palette that did close reads
//      as stuck open.
//
//   node e2e/probes/filechooser.mjs
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'
const { url, vite } = await startServer()
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu'] })
try {
  const page = await browser.newPage()
  let choosers = 0
  page.on('filechooser', (fc) => { choosers++; void fc.setFiles([]).catch((e) => console.log('  setFiles threw:', e.message.slice(0, 60))) })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window.__oip?.store?.getState().scene.parts.length ?? 0) > 0, null, { timeout: 60000 })
  await page.waitForFunction(() => window.__oip?.assetsBusy?.() === false, null, { timeout: 120000, polling: 250 }).catch(() => console.log('note: assetsBusy'))
  await page.evaluate(() => {
    window.__inputClicks = 0
    document.querySelector('input[data-testid="project-import"]').addEventListener('click', () => { window.__inputClicks++ })
  })

  const mouseClick = async (selector) => {
    const box = await page.locator(selector).boundingBox()
    if (!box) return console.log('  no box for', selector)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  }

  const b1 = choosers
  await mouseClick('button[aria-label="Import project"]')
  await page.waitForTimeout(1500)
  console.log('button via page.mouse -> input clicks:', await page.evaluate(() => window.__inputClicks), '| choosers:', choosers - b1)

  const b2 = choosers
  await page.keyboard.press('Control+Shift+P')
  await page.waitForTimeout(700)
  await page.fill('.palette-input', 'import project')
  await page.waitForTimeout(300)
  await mouseClick('.palette-item')
  await page.waitForTimeout(1500)
  console.log('palette via page.mouse -> input clicks:', await page.evaluate(() => window.__inputClicks), '| choosers:', choosers - b2)
  console.log('palette still open?', await page.evaluate(() => !!document.querySelector('.palette')))
} finally {
  await browser.close(); vite.kill()
}
