// Ladder, while it runs: what the rungs draw is what the running program holds, and it keeps being that.
//
// The Ladder view does not redraw every rung on every poll of the variable image: that would rebuild the demo's 121
// rungs eight times a second to show, on an average poll, a change of half a rung (60 fps -> 14 on a dev server). A
// rung is redrawn only when the values it shows move, which it decides from `textsOf`: the list of operand texts its drawing
// asks `valueOf` for (LadderView.tsx).
//
// That list is written by hand beside the drawing, so it can fall behind it, and a text missing from it does not
// throw, does not log, and does not look wrong: the rung keeps the numbers it last had, which is what a ladder does
// most of the time anyway. No other gate would catch it: verify-ladder-view and verify-demo-ladder both read lit
// state once, so a view frozen a second after it was drawn passes them both.
//
// And it redraws only the rungs on screen (LadderView.tsx `liveSig` / `inView`; redrawing off-screen rungs cost a
// large program 1.9 s in every 10): a rung out of view keeps the numbers it had and is drawn with the current values
// the moment it comes into view. So "drawn" is judged where it can be seen - the rungs in the scroller's view - and
// the sheet is walked top, middle and bottom, so every rung is judged once it is.
//
// So this gate reads it over time, and compares against the authority rather than against itself:
//   - every plain contact's `data-on` must agree with its operand's value in `controller.plcWatch` - checked only on
//     contacts whose value has been settled for several samples, since the view lags the image by up to one poll;
//   - and it refuses to pass vacuously: some contact must have changed state during the window, or the view was never
//     asked to keep up with anything.
//
// What it does not guard: the numbers the blocks print (a timer's ET, a counter's CV). Three checks for
// them all passed with the box texts deliberately dropped from `textsOf` - "did some number
// change" (a rung redrawn because a contact on it moved refreshes its numbers too, and across 121 rungs enough do to
// hide the frozen ones), the settled-value comparison used for contacts below (an ET that counts every scan never
// settles, so those rows are excluded exactly when they would be informative), and following a moving value as a
// lagged sequence (only one row in the demo moves for long enough to follow). A check that cannot fail is worse than
// no check, so there is none here. The contact half below is proven: dropping the contact operand from `textsOf`
// fails it with 22 contacts drawn stale.
//
// Run: node e2e/verify-ladder-live-freshness.mjs
/* global console, process, window, document, localStorage */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { showPlcEditor } from './_plc.mjs'

let failures = 0
function expect(ok, what) {
  if (ok) console.log('  ok:', what)
  else {
    failures++
    console.error('  FAIL:', what)
  }
}

const SAMPLE_MS = 200
const MIN_SAMPLES = 15 // 3 s of the line
const MAX_SAMPLES = 75 // ...and up to 15 s waiting for a contact to move, before calling the run vacuous
const SETTLED = 4 // samples a contact's value must have held before its lit state is judged (the view lags by one poll)

/** One sample: the running program's image, and what the rungs are drawing of it. */
const takeSample = () => {
  const watch = window.__oip.controller.plcWatch ?? {}
  // the same name resolution the view uses (LadderView.tsx watchLookup): exact, else a unique `Instance.Name` tail
  const exact = new Map()
  const tails = new Map()
  for (const k of Object.keys(watch)) {
    const key = k.toUpperCase()
    exact.set(key, k)
    const dot = key.indexOf('.')
    if (dot > 0) {
      const tail = key.slice(dot + 1)
      tails.set(tail, tails.has(tail) ? null : k)
    }
  }
  const valueOf = (text) => {
    const key = text.replace(/\s+/g, '').toUpperCase()
    const k = exact.get(key) ?? tails.get(key) ?? null
    return k === null ? undefined : watch[k]
  }
  const contacts = []
  const scroller = document.querySelector('.ld-scroll')?.getBoundingClientRect()
  for (const el of document.querySelectorAll('[data-testid="ld-element"][data-kind="contact"]')) {
    const mode = el.dataset.mode
    if (mode !== 'open' && mode !== 'closed') continue // an edge contact is lit from a lowering temporary, not its variable
    const operand = el.querySelector('.ld-tag')?.textContent?.trim() ?? ''
    if (operand === '' || operand === '?') continue
    const v = valueOf(operand)
    const box = el.closest('[data-testid="ladder-rung"]')?.getBoundingClientRect()
    contacts.push({
      trail: el.dataset.trail ?? '',
      // its rung is where the person can see it (the view redraws the rungs in view, and those only)
      inView: !!scroller && !!box && box.bottom > scroller.top && box.top < scroller.bottom,
      operand,
      drawn: el.dataset.on === 'true',
      // item(): a contact is lit by a BOOL, and by nothing else
      expected: typeof v === 'boolean' ? (mode === 'closed' ? !v : v) : false,
      known: typeof v === 'boolean',
    })
  }
  return { contacts }
}

const { url, vite } = await startServer()
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.addInitScript(() => {
    localStorage.setItem('oip-web/tutorial-done', '1')
  })
  await page.goto(url)
  await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
  await clickDemo(page)
  await page.waitForFunction(() => window.__oip.store.getState().demoSession === true, null, { timeout: 30000 })
  // the demo's controller runs Palletizer, a ladder, so the panel opens on its rungs (StEditor openingFace)
  await showPlcEditor(page, { face: 'as-is' })

  console.log('--- the demo, on its rungs, running its ladder ---')
  await page.locator('[data-testid="ladder-view"]').waitFor({ timeout: 20000 })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000, polling: 500 }).catch(() => {})

  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => window.__oip.store.getState().running, null, { timeout: 60000, polling: 250 })
  await page.waitForFunction(() => Object.keys(window.__oip.controller.plcWatch ?? {}).some((k) => k.startsWith('Main.LD_')), null, { timeout: 60000, polling: 250 })
  await page.waitForTimeout(2000)
  const rungs = await page.locator('[data-testid="ladder-rung"]').count()
  expect(rungs > 50, `the ladder is drawn and attached (${rungs} rungs)`)

  /** Sample while the line runs, and judge the contacts in view: settled ones must be drawn as the program holds them. */
  const judgeWindow = async (where, { needMove }) => {
    const samples = []
    let moved = false
    while (samples.length < MAX_SAMPLES && (samples.length < MIN_SAMPLES || (needMove && !moved))) {
      samples.push(await page.evaluate(takeSample))
      const n = samples.length
      if (n > 1) {
        const prev = new Map(samples[n - 2].contacts.map((c) => [c.trail, c.expected]))
        if (samples[n - 1].contacts.some((c) => prev.has(c.trail) && prev.get(c.trail) !== c.expected)) moved = true
      }
      await page.waitForTimeout(SAMPLE_MS)
    }
    const last = samples[samples.length - 1]
    const seen = last.contacts.filter((c) => c.inView)
    console.log(`  (${where}: ${samples.length} samples over ${((samples.length * SAMPLE_MS) / 1000).toFixed(1)} s, ${seen.length} contacts in view of ${last.contacts.length})`)
    if (needMove) {
      // not vacuous: the view had something to keep up with, and was keeping up with it
      expect(samples[0].contacts.length > 0, `plain contacts are drawn and resolve to program variables (${samples[0].contacts.length})`)
      expect(moved, 'at least one contact changed state during the window, so the view was asked to keep up')
    }
    // settled contacts in view: a contact whose value has held for several samples must be drawn as that value
    const held = (trail) => {
      const vals = samples.slice(-SETTLED).map((s) => s.contacts.find((c) => c.trail === trail))
      return vals.every((c) => c && c.known && c.expected === vals[0].expected)
    }
    const judged = seen.filter((c) => c.known && held(c.trail))
    const stale = judged.filter((c) => c.drawn !== c.expected)
    expect(judged.length > 0, `${where}: settled contacts in view to judge (${judged.length})`)
    expect(
      stale.length === 0,
      stale.length === 0
        ? `${where}: every settled contact in view is drawn as the program holds it (${judged.length} checked)`
        : `${where}: ${stale.length} contact(s) drawn stale, e.g. ${stale
            .slice(0, 4)
            .map((c) => `${c.operand}@${c.trail} drawn ${c.drawn} want ${c.expected}`)
            .join('; ')}`,
    )
  }
  const scrollTo = (at) => page.evaluate((f) => {
    const sc = document.querySelector('.ld-scroll')
    if (sc) sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * f
  }, at)

  console.log('--- sampled while the line runs, top, middle and bottom of the sheet ---')
  // "top" is the first rungs that hold contacts: the demo opens on its light curtains' muting blocks, three tall boxes
  // that fill the view on their own, so the sheet is brought to the first rung with a plain contact on it
  await page.evaluate(() => {
    const sc = document.querySelector('.ld-scroll')
    const first = [...document.querySelectorAll('[data-testid="ld-element"][data-kind="contact"]')].find((el) => el.dataset.mode === 'open' || el.dataset.mode === 'closed')
    const rung = first?.closest('[data-testid="ladder-rung"]')
    if (sc && rung) sc.scrollTop += rung.getBoundingClientRect().top - sc.getBoundingClientRect().top
  })
  await judgeWindow('top', { needMove: true })
  // rungs that come into view are drawn with the current values: the part the view must not get wrong
  await scrollTo(0.5)
  await judgeWindow('middle', { needMove: false })
  await scrollTo(1)
  await judgeWindow('bottom', { needMove: false })

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
console.log('\nall ladder live-freshness checks passed')
