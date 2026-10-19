// Verify collision reposition (Shift+G) stands the SDK Belt Conveyor on its legs (deck at standHeight above
// the floor), like the built-in belt, instead of sinking the deck flush to the floor (legs through it).
// The bug this guards: the legged (rest:'surfaceBelow') SDK part falling back to restOnSurface
// (footprint-flush), which puts the deck at ~0.28 m. Run: node e2e/verify-belt-reposition.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim && window.__oip.controller), { timeout: 20000 })
}

let failed = false
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed = true
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.evaluate(() => window.localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1500)
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click().catch(() => {})
    await page.waitForTimeout(300)

    // open the SDK belt in its isolated edit scene + select it
    await page.evaluate(() => window.__oip.store.enterPackageEdit('oip.belt-conveyor'))
    await page.waitForTimeout(2500)
    const info = await page.evaluate(() => {
      const st = window.__oip.store
      const part = st.getState().scene.parts.find((p) => p.packageId === 'oip.belt-conveyor')
      if (!part) return { found: false }
      st.select(part.id)
      return { found: true, id: part.id, standHeight: part.params?.standHeight }
    })
    console.log('belt part:', JSON.stringify(info))
    check('SDK belt placed + selected', info.found)

    // Shift+G, then Alt: reposition onto the empty y=0 ground plane (Alt → flat ground move, no surface snap), then read
    // the live transient Y. Move the cursor to viewport centre (over ground) before pressing.
    const cx = 800, cy = 520
    await page.mouse.move(cx, cy, { steps: 4 })
    await page.waitForTimeout(80)
    // Shift+G enters the gesture, then Alt holds it off the surface. Modifier matching is exact
    // (core/keymap.ts: `place.reposition` is shift+KeyG, hint "then Alt ..."), so holding Alt across the
    // chord made it alt+shift+KeyG and matched nothing - the gesture never started.
    await page.keyboard.down('Shift')
    await page.keyboard.press('g')
    await page.keyboard.up('Shift')
    await page.keyboard.down('Alt')
    await page.waitForTimeout(100)
    const inRepos = await page.evaluate(() => !!window.__oip.controller.reposition)
    check('entered reposition gesture', inRepos)
    await page.mouse.move(cx + 40, cy + 20, { steps: 6 })
    await page.waitForTimeout(120)

    const y = await page.evaluate(() => {
      const p = window.__oip.store.getState().scene.parts.find((q) => q.packageId === 'oip.belt-conveyor')
      return p?.position?.[1] ?? null
    })
    await page.mouse.down(); await page.mouse.up()
    await page.keyboard.up('Alt')
    console.log(`reposition deck Y = ${y}`)

    // deck should stand standHeight above the floor (FLOOR_SURFACE_Y is 0) - not the ~0.28
    // footprint-flush sink. Tolerate snap/ground jitter generously; the bug delta (0.28 vs 0.75) is large.
    check('deck stands on its legs at ~standHeight, not sunk to footprint', y !== null && y > 0.6, `y=${y}`)
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  }
}

main()
  .then(() => process.exit(failed ? 1 : 0))
  .catch((e) => {
    console.error('verify-belt-reposition crashed:', e)
    process.exit(2)
  })
