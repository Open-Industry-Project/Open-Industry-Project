// Import Project (an .oip, or a scene file), on every surface that should offer it.
//
// Import lives in the command registry beside Export. Outside it (a hidden <input> owned by one component
// plus an icon button), there is no palette entry and no native File menu item, because main renders what
// DESKTOP_MENU names. The folder commands point here (a browser with no directory picker is told to use
// Export Project (.oip) instead), so import is the return leg of that round trip and must be findable.
//
// commands.test.ts pins the registry and the menu model. What only a browser can prove is the wiring:
// one picker, mounted in App, reached from the palette and from the project menu's row through the same
// command, and greyed on both by the one enablement rule.
//
//   node e2e/verify-import-project-command.mjs

import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { projectMenuItem } from './_projectMenu.mjs'

let failed = false
const check = (label, ok, detail = '') => {
  if (!ok) failed = true
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`)
}

const LABEL = 'Import Project…'

// A chooser must be answered or the page stays blocked (an unanswered one makes the next click read as
// a no-op). setFiles([]) dismisses it without picking anything, which the input's handler ignores.
// Only a real user gesture opens one at all: a programmatic .click() from evaluate opens nothing here,
// and the untouched scene picker behaves identically (e2e/probes/filechooser.mjs), so that is Chromium's
// user-activation rule rather than anything about this command.
const { url, vite } = await startServer()
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu'] })
try {
  const page = await browser.newPage()
  let choosers = 0
  let answered = 0
  page.on('filechooser', (fc) => {
    choosers++
    void fc.setFiles([]).then(
      () => answered++,
      (e) => {
        answered++
        console.log('note: dismissing a chooser failed:', String(e.message).slice(0, 80))
      },
    )
  })
  // a real click that opens a chooser can outlast Playwright's post-click settle, so the counter is the
  // assertion and a timeout on the click itself is not a failure
  const opensPicker = async (label, act) => {
    const before = choosers
    // never swallow the reason: the first version caught an intercepted click and reported it as a bare
    // "0 chooser(s)", which looks like broken wiring and is not
    let why = ''
    await act().catch((e) => {
      why = String(e.message).slice(0, 160)
    })
    for (let i = 0; i < 40 && choosers === before; i++) await page.waitForTimeout(100)
    // An open chooser blocks the page, so the next keypress goes to the dialog and the next evaluate
    // cannot run. Returning before it is answered makes the palette look stuck open.
    for (let i = 0; i < 40 && answered < choosers; i++) await page.waitForTimeout(100)
    check(label, choosers > before, choosers > before ? `${choosers - before} chooser(s)` : why || 'no chooser, no error')
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window.__oip?.store?.getState().scene.parts.length ?? 0) > 0, null, { timeout: 60000 })
  // Parts existing is not the app being clickable: the loading cover is still up, and a click it eats is
  // indistinguishable from a command that did nothing. Wait on the positive settle signal (assetsBusy,
  // per AGENTS.md) and on the cover actually standing down.
  await page
    .waitForFunction(() => window.__oip?.assetsBusy?.() === false, null, { timeout: 120000, polling: 250 })
    .catch(() => console.log('note: assetsBusy never went quiet; continuing'))
  await page
    .waitForFunction(() => !!document.querySelector('.viewport-cover.ready') || !document.querySelector('.viewport-cover'), null, { timeout: 60000, polling: 250 })
    .catch(() => console.log('note: the loading cover never stood down; continuing'))

  // Poll on a timer, not rAF: once the scene settles the viewport paints on demand and an rAF-scheduled
  // poller never runs again (the palette gate hit this).
  const palette = (present) =>
    page
      .waitForFunction((want) => !!document.querySelector('.palette') === want, present, { timeout: 5000, polling: 100 })
      .then(() => true)
      .catch(() => false)
  const mouseClick = async (selector) => {
    const box = await page.locator(selector).boundingBox()
    if (!box) throw new Error(`no box for ${selector}`)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  }
  const rowState = () =>
    page.evaluate((label) => {
      const row = [...document.querySelectorAll('.palette-item')].find(
        (b) => b.querySelector('.palette-label')?.textContent === label,
      )
      return { present: !!row, disabled: !!row?.disabled }
    }, LABEL)

  // ── the picker itself: one input, in App, accepting .oip ─────────────────────────────────────────
  const picker = await page.evaluate(() => {
    const all = [...document.querySelectorAll('input[data-testid="project-import"]')]
    return { count: all.length, accept: all[0]?.accept ?? null }
  })
  check('the project picker is mounted exactly once', picker.count === 1, JSON.stringify(picker))
  check('it accepts .oip', (picker.accept ?? '').includes('.oip'), picker.accept ?? 'no input')

  // ── the project menu reaches it, through the command ─────────────────────────────────────────────
  // (not on the scene switcher, which manages scenes, not projects)
  check('the scene switcher no longer carries a project import', (await page.locator('button[aria-label="Import project"]').count()) === 0)
  const row = await projectMenuItem(page, 'file.importProject')
  check('the project menu offers Import Project', (await row.count()) === 1)
  // a block with nothing to show (the waiting scenes, usually) must not leave its separator behind: none first or
  // last, and never two in a row (ProjectMenu renders its blocks as one list for this)
  const seps = await page.evaluate(() => {
    const kids = [...document.querySelectorAll('[role="menu"] > *')].map((e) => (e.getAttribute('role') === 'separator' ? '|' : 'r'))
    return kids.join('')
  })
  check('the project menu has no doubled, leading or trailing separator', !/\|\||^\||\|$/.test(seps) && seps.includes('r'), seps)
  await opensPicker('the row opens the picker (row -> command -> ui seam -> input)', () => row.click())

  // ── the palette offers it, which it never did before ────────────────────────────────────────────
  await page.keyboard.press('Control+Shift+P')
  check('Ctrl+Shift+P opens the palette', await palette(true))
  const idle = await rowState()
  check('the palette lists Import Project, enabled while idle', idle.present && !idle.disabled, JSON.stringify(idle))
  // Control: the command is findable by name, the way a user reaches it
  await page.fill('.palette-input', 'import project')
  const firstHit = await page.textContent('.palette-item .palette-label')
  check('searching "import project" finds it first', firstHit === LABEL, firstHit ?? 'no hit')

  await opensPicker('the palette entry opens the same picker', () => mouseClick('.palette-item'))
  // The palette must be gone before anything else is clicked: answering a chooser defers the run that
  // closes it, and a lingering .palette-backdrop silently intercepts the next click (e.g. Play, as an
  // uncaught interception rather than a failed check).
  await page.keyboard.press('Escape')
  check('the palette closes behind it', await palette(false))

  // ── one enablement rule, both surfaces: a run must stop first ───────────────────────────────────
  await mouseClick('button.run-button.play')
  await page.waitForFunction(() => window.__oip?.store?.getState().running === true, null, { timeout: 15000 })
  const runningRow = await projectMenuItem(page, 'file.importProject')
  check('the project menu row greys while the sim runs', await runningRow.isDisabled())
  check(
    'and says why, from the surface fallback',
    ((await runningRow.getAttribute('title')) ?? '').includes('Stop the simulation'),
    (await runningRow.getAttribute('title')) ?? 'no title',
  )
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Shift+P')
  await palette(true)
  const running = await rowState()
  check('the palette row greys too, by the same rule', running.present && running.disabled, JSON.stringify(running))
} finally {
  await browser.close()
  vite.kill()
}
console.log(failed ? '\nFAIL' : '\nAll checks passed')
process.exit(failed ? 1 : 0)
