// Ladder keys on the IEC sheet: Tab / Shift+Tab step element to element (where the arrows walk a block's fields one at
// a time), and Ctrl+D on a selected rung edits its comment, written into the program as a comment above the rung.
// Run: node e2e/verify-ladder-describe.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}
const stored = (page) => page.evaluate(() => window.__oip?.store?.getState?.().stProgram ?? '')
const selected = (page) => page.locator('[data-testid="ld-element"].sel').first().getAttribute('data-trail').catch(() => null)

// one IEC ladder section and nothing around it, so the panel opens on its rungs
const PROGRAM = `VAR_INPUT A, B : BOOL; END_VAR
VAR_OUTPUT Q : BOOL; END_VAR
VAR T1 : TON; END_VAR
LADDER
  |A| T1(IN, PT := T#2s) (Q);
  |/A| |B| (Q);
END_LADDER
`

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ } })
    await page.goto(URL)
    await page.evaluate(() => localStorage.clear()).catch(() => {})
    await page.reload()
    await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
    await page.evaluate((src) => {
      const st = window.__oip.store
      st.loadScene({ version: st.getState().scene.version, parts: [] })
      st.loadStProgram(src)
    }, PROGRAM)
    await showPlcEditor(page, { face: 'as-is' })
    await page.locator('[data-testid="ladder-view"]').waitFor({ state: 'visible', timeout: 30000 })
    const cells = page.locator('[data-testid="ld-element"]')

    // ---- Tab walks elements, a box counting as one stop ----
    await cells.nth(0).click()
    await page.keyboard.press('Tab')
    check('Tab steps to the next element', (await selected(page)) === '0/0/1', String(await selected(page)))
    await page.keyboard.press('Tab')
    check('...past a box in one step, not through its fields', (await selected(page)) === '0/0/2', String(await selected(page)))
    await page.keyboard.press('Tab')
    check('...and on onto the next rung', (await selected(page)) === '0/1/0', String(await selected(page)))
    await page.keyboard.press('Shift+Tab')
    check('Shift+Tab steps back', (await selected(page)) === '0/0/2', String(await selected(page)))

    // ---- Ctrl+D on a rung: its comment ----
    await page.locator('[data-testid="ladder-rung"]').nth(0).locator('[data-testid="ladder-rung-num"]').click()
    await page.keyboard.press('Control+d')
    const comment = page.locator('.ld-comment-input')
    check('Ctrl+D on a rung opens its comment', await comment.isVisible().catch(() => false))
    await comment.fill('Motor seal')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    check('...and the comment is the rung\'s, written above it', /\(\*\s*Motor seal\s*\*\)\s*\n\s*\|A\| T1\(/.test(await stored(page)), (await stored(page)).slice(0, 200))
    check('...and drawn over it', (await page.locator('[data-testid="ladder-rung"]').nth(0).locator('[data-testid="ladder-comment"]').innerText().catch(() => '')).includes('Motor seal'))

    // Escape leaves it as it was
    await page.locator('[data-testid="ladder-rung"]').nth(1).locator('[data-testid="ladder-rung-num"]').click()
    await page.keyboard.press('Control+d')
    await comment.fill('nothing')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    check('Escape discards the edit', !/nothing/.test(await stored(page)))

    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
  }
}

try {
  await main()
} finally {
  vite.kill()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
