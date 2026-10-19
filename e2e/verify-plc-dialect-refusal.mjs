// A program written for a PLC dialect this build does not have (core/dialect.ts `stDialect`), through the real editor.
//
// The field exists before a second dialect does, so that a build shipped now refuses a later build's program instead of
// reading it as IEC. Unit tests (dialect.test.ts, dialectDocument.test.ts) check that the document keeps it byte for
// byte and that the attach refuses it. Only a browser run can check the panel: that the PLC panel says so over the code
// and will not take a keystroke, that the IEC lint marks nothing in text it cannot read, that the organizer offers no
// edit, that Problems lists one row rather than many IEC errors, that Play leaves the program unattached, and that
// loading an IEC program afterwards restores everything.
// Run: node e2e/verify-plc-dialect-refusal.mjs

/* global process, console, window, localStorage */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'

// not IEC: ladder text in another notation, which an IEC read would mark with many errors
const FOREIGN = `rung Start -> Motor;
rung !Stop & (Motor | Start) -> Run;
`
const IEC = `VAR_INPUT Start : BOOL; END_VAR
VAR_OUTPUT Motor : BOOL; END_VAR
Motor := Start;`

let failures = 0
function expect(ok, what) {
  if (ok) console.log('  ok:', what)
  else {
    failures++
    console.error('  FAIL:', what)
  }
}

const { url, vite } = await startServer()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.addInitScript(() => {
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(url)
  await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 250 })
  await showPlcEditor(page)
  await page.evaluate((src) => window.__oip.store.loadStProgram(src, { dialect: 's7' }), FOREIGN)
  await page.waitForTimeout(900) // the lint and the organizer's facts run on a quiet period

  console.log('--- the panel says so, and takes no keystroke ---')
  const banner = (await page.locator('[data-testid="st-foreign-dialect"]').textContent().catch(() => '')) ?? ''
  expect(/written for the 's7' dialect/.test(banner), `a banner over the code names the dialect (${banner.trim()})`)
  const code = page.locator('.cm-content').first()
  expect((await code.getAttribute('contenteditable')) === 'false', 'the code cannot be typed into')
  await code.click({ position: { x: 30, y: 10 } })
  await page.keyboard.insertText('CORRUPT')
  await page.waitForTimeout(300)
  expect((await page.evaluate(() => window.__oip.store.getState().stProgram)) === FOREIGN, 'and the program is untouched')
  expect((await page.locator('.cm-lintRange-error').count()) === 0, 'the IEC lint marks nothing in text it cannot read')

  console.log('--- the organizer is an index, and Problems one row ---')
  expect((await page.locator('[data-testid="org-readonly"]').count()) === 1 && (await page.locator('[data-testid="org-new"], [data-testid="org-new-task"]').count()) === 0, 'the organizer offers nothing to add, and says why')
  await page.evaluate(() => window.__oip.store.revealPanel('problems'))
  const rows = page.locator('.problems-row')
  await rows.first().waitFor({ timeout: 10000 }).catch(() => {})
  const texts = await rows.allTextContents()
  expect(texts.length === 1 && /'s7' dialect/.test(texts[0] ?? ''), `Problems lists the refusal, not IEC errors (${texts.length}: ${(texts[0] ?? '').slice(0, 80)})`)

  console.log('--- Play leaves it unattached ---')
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForTimeout(1500)
  const status = await page.evaluate(() => window.__oip.controller.programStatus)
  expect(!status.attached && /'s7' dialect/.test(status.error ?? ''), `the attach is refused with the reason (${status.error})`)
  await page.evaluate(() => window.__oip.controller.stop())
  await page.waitForTimeout(300)

  console.log('--- an IEC program afterwards puts everything back ---')
  await page.evaluate((src) => window.__oip.store.loadStProgram(src), IEC)
  await showPlcEditor(page)
  await page.waitForTimeout(900)
  expect((await page.locator('[data-testid="st-foreign-dialect"]').count()) === 0, 'no banner')
  expect((await page.locator('.cm-content').first().getAttribute('contenteditable')) === 'true', 'the code is editable again')
  expect((await page.locator('[data-testid="org-new"]').count()) === 1, 'and the organizer can add again')

  // the control for "the lint marks nothing": the same text, read as IEC, is marked
  await page.evaluate((src) => window.__oip.store.loadStProgram(src), FOREIGN)
  await page.locator('.cm-lintRange-error').first().waitFor({ timeout: 8000 }).catch(() => {})
  expect((await page.locator('.cm-lintRange-error').count()) > 0, '[control] the same text with no dialect is linted as IEC, and marked')

  expect(pageErrors.length === 0, `no page errors (${pageErrors.join('; ')})`)
} catch (err) {
  failures++
  console.error('  FAIL:', err)
} finally {
  await browser.close()
  vite.kill()
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall dialect-refusal checks passed')
