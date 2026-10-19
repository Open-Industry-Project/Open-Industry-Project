// Verifies the in-app layout check (src/core/checkLayout.ts, listed by the Problems dock) end to end in a
// real browser:
//   - the Check Layout command is offered whenever there are parts, tests or not (unlike Run Project
//     Tests, which a project with no tests cannot reach, and no tests is exactly where a stray part hides)
//   - it brings the Problems dock forward, from behind the tab that starts in front of it
//   - a scene whose parts are all seated has no Layout row
//   - a part that declares it seats on a host and has none is a Layout error, named as the author named it,
//     so it shows without turning warnings on
//   - clicking the row selects that part, so the verdict is actionable rather than informational
//
// The check has no dialog of its own; it lives in Problems so one check has one home: that dock exists so
// checks do not each have a different one.
//
// This gate is the reason the seam is worth having in the app at all: `npm run check-layout` needs a
// repo checkout, so without this the one check that catches bad placement (the thing an AI agent is
// worst at) could not reach the person who owns the project.
//
// Run: node e2e/verify-layout-check-ui.mjs
/* global process, console, window, document, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

// A sensor declares `snap.mounts`, so it is a guest: placed with no host it is unambiguously wrong.
// A roller conveyor is an ordinary part and can carry one. Both are first-party, so the packages the
// scene needs are already registered by the app's own catalog load.
const SEATED = {
  version: 4,
  parts: [
    { id: 'conv', type: 'part', packageId: 'oip.roller-conveyor', name: 'Line', position: [0, 1, 0], rotationY: 0, params: { length: 4, width: 1.524, standHeight: 1 } },
    { id: 'eye', type: 'part', packageId: 'oip.diffuse-sensor', name: 'Release eye', position: [0, 1.05, 0.8], rotationY: 0, params: { maxRange: 1.2 } },
  ],
}
// the same scene with the sensor moved far away: nothing within reach of it
const STRAY = {
  version: 4,
  parts: [
    SEATED.parts[0],
    { ...SEATED.parts[1], position: [40, 1.05, 0.8] },
  ],
}

async function runFromPalette(page, query) {
  await page.keyboard.press('Control+Shift+P')
  await page.waitForFunction(() => !!document.querySelector('.palette-input'), { timeout: 5000 })
  await page.evaluate((q) => {
    const input = document.querySelector('.palette-input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, q)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
  }, query)
  await page.waitForTimeout(200)
  await page.keyboard.press('Enter')
}

const problemsShown = (page) => page.evaluate(() => !!document.querySelector('.problems-panel'))
/** the Layout rows, as [group, subject, message] */
const layoutRows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.problems-row')]
      .map((r) => [r.querySelector('.problems-group')?.textContent, r.querySelector('.problems-subject')?.textContent, r.querySelector('.problems-message')?.textContent, r.className])
      .filter(([group]) => group === 'Layout'),
  )

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.on('pageerror', (e) => {
      failures++
      console.error('  FAIL: page error:', e.message)
    })
    await page.addInitScript(() => {
      try {
        localStorage.clear()
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        /* private-mode storage: harmless here */
      }
    })
    await page.goto(`http://localhost:${PORT}/app/`)
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), { timeout: 30000 })
    // the first-party catalog has to be registered before a scene referring to it can resolve
    await page.waitForFunction(() => !!window.__oip.getPackage?.('oip.diffuse-sensor'), { timeout: 30000 })

    console.log('--- a scene whose parts are all seated ---')
    await page.evaluate((s) => window.__oip.store.loadScene(s), SEATED)
    await page.waitForFunction(() => !window.__oip.assetsBusy?.(), { timeout: 30000 }).catch(() => {})
    // no tests in this project at all: the reason for a separate command
    expect(await page.evaluate(() => window.__oip.store.getState().testCount === 0), 'the project carries no tests')
    // Problems starts as a background tab behind Parts, and a background tab is not mounted
    expect(!(await problemsShown(page)), 'control: the Problems dock is not in front before the command')
    await runFromPalette(page, 'Check Layout')
    await page.waitForFunction(() => !!document.querySelector('.problems-panel'), { timeout: 8000 }).catch(() => {})
    expect(await problemsShown(page), 'Check Layout brings the Problems dock forward')
    expect((await layoutRows(page)).length === 0, 'a fully seated scene has no Layout row')

    console.log('--- the same scene with the sensor placed nowhere ---')
    await page.evaluate((s) => window.__oip.store.loadScene(s), STRAY)
    await page.waitForFunction(() => !window.__oip.assetsBusy?.(), { timeout: 30000 }).catch(() => {})
    await page.waitForFunction(() => [...document.querySelectorAll('.problems-group')].some((g) => g.textContent === 'Layout'), { timeout: 8000 }).catch(() => {})
    const rows = await layoutRows(page)
    expect(rows.length === 1, `the stray part is one Layout row (got ${rows.length})`)
    const [, subject, message, cls] = rows[0] ?? []
    expect(subject === 'Release eye', `the row names the part the way the author labelled it (got ${subject})`)
    expect(/mounts onto a host surface/.test(message ?? ''), 'it says what the part expected, not which field it declared')
    expect(/\berror\b/.test(cls ?? ''), 'it is an error, so it shows with warnings hidden')

    console.log('--- and the row is actionable ---')
    await page.evaluate(() => window.__oip.store.setState({ selectedIds: [] }))
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.problems-row')].find((r) => r.querySelector('.problems-group')?.textContent === 'Layout')
      row.click()
    })
    await page.waitForTimeout(200)
    expect(
      await page.evaluate(() => window.__oip.store.getState().selectedIds.includes('eye')),
      'clicking the row selects the offending part',
    )
  } finally {
    await browser.close()
    vite.kill()
  }
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('\nall layout-check UI checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
