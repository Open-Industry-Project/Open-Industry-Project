// Verifies the transport's keys (core/keymap.ts sim.playPause / sim.stop, bound in editor/App.tsx) in all
// three engines, because what can go wrong is browser behaviour, not ours:
//   - Space starts a stopped sim, then pauses and resumes it; Shift+Space stops
//   - a held Space toggles once (auto-repeat must not flicker between paused and running)
//   - with a toolbar button focused (where a mouse click leaves it), Space toggles the run exactly once. The
//     browser presses a focused button on Space too, on keydown in some engines and keyup in others, so the
//     listener holds back both. A miss shows as the Pause button toggling it a second time (net: no change)
//   - Space typed into a text field is text, and Space in free fly is the boost: neither touches the run
// Firefox and WebKit are skipped with a note when Playwright's build of them isn't installed
// (`npx playwright install firefox webkit`); the verdict names what actually ran.
// Run: node e2e/verify-transport-keys.mjs
/* global process, console, window, document, localStorage, HTMLElement */
import { startServer } from './_server.mjs'
import { chromium, firefox, webkit } from 'playwright'

const { port: PORT, vite } = await startServer()

let failures = 0
const ran = []
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

const run = (page) =>
  page.evaluate(() => {
    const s = window.__oip.store.getState()
    return { running: s.running, paused: s.paused }
  })

/** settle, then read: a command takes effect on the next store commit, not synchronously with the key */
async function after(page, ms = 250) {
  await page.waitForTimeout(ms)
  return run(page)
}

/** a neutral focus: nothing focused, so a key goes to the document the way it does after a canvas click */
const blur = (page) => page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))

async function check(name, browserType) {
  let browser
  try {
    browser = await browserType.launch()
  } catch (err) {
    console.log(`note: ${name} not available (${String(err.message).split('\n')[0]}) - skipped`)
    return
  }
  ran.push(name)
  console.log(`--- ${name} ---`)
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.addInitScript(() => {
      try {
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        /* private-mode storage - the tour just shows up */
      }
    })
    await page.goto(`http://localhost:${PORT}/app/`)
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), null, { timeout: 60000 })
    await page.waitForTimeout(500)
    await blur(page)

    let s = await run(page)
    expect(!s.running, 'starts stopped')

    await page.keyboard.press('Space')
    s = await after(page, 600)
    expect(s.running && !s.paused, 'Space starts the simulation')

    await page.keyboard.press('Space')
    s = await after(page)
    expect(s.running && s.paused, 'Space pauses a running simulation')

    await page.keyboard.press('Space')
    s = await after(page)
    expect(s.running && !s.paused, 'Space resumes it')

    // held: one real press, then auto-repeat keydowns (Playwright marks a second down of a held key repeat)
    await page.keyboard.down('Space')
    await page.keyboard.down('Space')
    await page.keyboard.down('Space')
    await page.keyboard.up('Space')
    s = await after(page)
    expect(s.running && s.paused, 'a held Space toggles once, not once per repeat')
    await page.keyboard.press('Space')
    s = await after(page)
    expect(s.running && !s.paused, '(resumed for the next checks)')

    // a focused button: where a mouse click on Pause leaves the focus
    for (const sel of ['button.run-button.pause', 'button.run-button.speed']) {
      const before = await run(page)
      await page.locator(sel).focus()
      await page.keyboard.press('Space')
      s = await after(page)
      expect(s.running && s.paused !== before.paused, `Space with ${sel} focused toggles the run exactly once`)
      const speed = await page.evaluate(() => window.__oip.store.getState().timeScale)
      expect(speed === 1, `... and does not press the focused button (speed ${speed}x)`)
    }
    await blur(page)
    if ((await run(page)).paused) await page.keyboard.press('Space')

    // a text field: the palette's search box. Space is text there.
    await page.keyboard.press('Control+Shift+P')
    await page.waitForTimeout(300)
    const typing = await page.evaluate(() => {
      const el = document.activeElement
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    })
    expect(typing, 'the command palette takes the focus into its search field')
    s = await run(page)
    await page.keyboard.type('a b')
    const after2 = await after(page)
    expect(after2.paused === s.paused && after2.running, 'Space typed into a text field leaves the run alone')
    const typed = await page.evaluate(() => document.activeElement && 'value' in document.activeElement ? document.activeElement.value : '')
    expect(typed === 'a b', `... and reaches the field as text (${JSON.stringify(typed)})`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    await blur(page)

    // free fly: Space is the boost there
    await page.mouse.move(700, 450)
    await page.keyboard.press('Shift+F')
    await page.waitForTimeout(200)
    const flying = await page.evaluate(() => window.__oip.view.isNavigating())
    if (flying) {
      s = await run(page)
      await page.keyboard.press('Space')
      const f = await after(page)
      expect(f.paused === s.paused && f.running, 'Space in free fly boosts and leaves the run alone')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    } else {
      console.log('  note: free fly did not engage here (Shift+F) - the fly guard was not exercised')
    }
    await blur(page)

    await page.keyboard.press('Shift+Space')
    s = await after(page, 600)
    expect(!s.running, 'Shift+Space stops')

    await page.keyboard.press('Shift+Space')
    s = await after(page)
    expect(!s.running, 'Shift+Space on a stopped sim does nothing (it never starts one)')
  } catch (err) {
    failures++
    console.error(`  FAIL: ${name} threw: ${err.message}`)
  } finally {
    await browser.close()
  }
}

try {
  await check('chromium', chromium)
  await check('firefox', firefox)
  await check('webkit', webkit)
} finally {
  vite.kill()
}

console.log(`\nengines run: ${ran.join(', ') || 'none'}`)
if (failures || ran.length === 0) {
  console.error(`FAIL: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('PASS: transport keys')
