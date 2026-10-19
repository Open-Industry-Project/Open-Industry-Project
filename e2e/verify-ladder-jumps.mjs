// Jumps, labels, RETURN and rung comments in the IEC ladder view, and durations and dates shown as their literals in
// the ST editor's inline values - what a person sees of both, which the unit tests cannot hold.
//
// The ladder: a rung's label is drawn in the gutter before the left rail (`ladder-label`), a jump or a RETURN at the
// end of its rung (`ladder-exit`), and the comment above a rung over it (`ladder-comment`). Retyping a rung as text
// (double-click its number) keeps its label and jump when the text still says them. While the program runs the jump
// really skips: the coil it steps over holds.
//
// The ST editor: a TIME is milliseconds underneath and a DATE / TOD / DT milliseconds from their origin, and the inline
// value boxes show each as the literal the program itself would write (stLang.ts `formatValue`), not a raw number.
//
// Runs in a browser: nothing here needs the desktop app.

import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'

const LADDER = `VAR
  Skip : BOOL := TRUE;
  Always : BOOL := TRUE;
  Hold : BOOL;
  Stepped, Landed, After : BOOL;
END_VAR
LADDER
  (* skip the next rung while Skip is on *)
  |Skip| >>Past;
  |Always| (Stepped);
  Past: |Always| (Landed);
  |Hold| RETURN;
  |Always| (After);
END_LADDER
`

const TIMES = `VAR
  t : TIME := T#1s500ms;
  d : DATE := D#2024-02-29;
  tod1 : TOD := TOD#07:05:09.5;
  x : DT;
  n : INT;
END_VAR
x := CONCAT_DATE_TOD(d, tod1);
n := n + 1;
`

let failures = 0
function expect(ok, what) {
  if (ok) console.log('  ok:', what)
  else {
    failures++
    console.error('  FAIL:', what)
  }
}

/** A fresh page with `program` in the store and the PLC panel open on it. */
async function open(browser, url, program) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(url)
  await page.waitForFunction(() => !!window.__oip?.store, null, { timeout: 60000, polling: 200 })
  await page.evaluate((src) => {
    const st = window.__oip.store
    st.loadScene({ version: st.getState().scene.version, parts: [] })
    st.setStProgram(src)
  }, program)
  await showPlcEditor(page, { face: 'as-is' })
  return { page, errors }
}

const { url, vite } = await startServer()
const browser = await chromium.launch()
try {
  console.log('--- the ladder: label, jump, RETURN and comment drawn ---')
  const { page, errors } = await open(browser, url, LADDER)
  await page.locator('[data-testid="ladder-view"]').waitFor({ timeout: 20000 })
  const labels = await page.locator('[data-testid="ladder-label"]').allTextContents()
  expect(labels.length === 1 && labels[0].trim() === 'Past:', `one label, Past: (${JSON.stringify(labels)})`)
  const exits = await page.locator('[data-testid="ladder-exit"]').allTextContents()
  expect(exits.length === 2 && exits[0].includes('Past') && exits[1].includes('RETURN'), `a jump to Past and a RETURN (${JSON.stringify(exits)})`)
  const comments = await page.locator('[data-testid="ladder-comment"]').allTextContents()
  expect(comments.some((c) => c.includes('skip the next rung')), `the comment over the jump rung (${JSON.stringify(comments)})`)
  // the label sits on the third rung, the jump ends the first
  const labelRung = await page.locator('[data-testid="ladder-rung"]').nth(2).locator('[data-testid="ladder-label"]').count()
  const jumpRung = await page.locator('[data-testid="ladder-rung"]').nth(0).locator('[data-testid="ladder-exit"]').count()
  expect(labelRung === 1 && jumpRung === 1, 'on the rungs they belong to')
  // a label must not push its rung's rail over: every left rail stands at one x down the sheet
  const rails = await page.locator('[data-testid="ladder-rung"] .ld-line > .ld-rail:first-child').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)))
  expect(rails.length === 5 && new Set(rails).size === 1, `the left rails line up (${rails.join(', ')})`)

  console.log('--- running: the jump steps over its rung ---')
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForFunction(() => window.__oip.controller.plcWatch?.Landed === true, null, { timeout: 20000 })
  const watch = await page.evaluate(() => ({ ...window.__oip.controller.plcWatch }))
  expect(watch.Stepped === false && watch.Landed === true && watch.After === true, `Stepped held off, Landed and After on (${JSON.stringify({ Stepped: watch.Stepped, Landed: watch.Landed, After: watch.After })})`)
  await page.evaluate(() => window.__oip.controller.stop())

  console.log('--- retyping a rung keeps its label, and says its new elements ---')
  await page.locator('[data-testid="ladder-rung-num"]').nth(2).dblclick()
  const draft = page.locator('[data-testid="ladder-text-edit"]')
  await draft.waitFor({ timeout: 10000 })
  const before = await draft.inputValue()
  expect(before.startsWith('Past:'), `the draft shows the label (${before})`)
  await draft.fill(before.replace('(Landed)', '(Landed) (After)'))
  await draft.press('Enter')
  await page.waitForFunction(() => window.__oip.store.getState().stProgram.includes('Past: |Always| (Landed) (After);'), null, { timeout: 10000 }).then(
    () => expect(true, 'the text now says Past: |Always| (Landed) (After);'),
    async () => expect(false, `the text says the retyped rung (${await page.evaluate(() => window.__oip.store.getState().stProgram)})`),
  )
  const afterLabels = await page.locator('[data-testid="ladder-label"]').count()
  const afterExits = await page.locator('[data-testid="ladder-exit"]').count()
  expect(afterLabels === 1 && afterExits === 2, `label and exits still drawn (${afterLabels}, ${afterExits})`)

  console.log('--- Label, Jump and Return from the bar ---')
  const text = () => page.evaluate(() => window.__oip.store.getState().stProgram)
  const hasLine = async (line) => {
    await page.waitForFunction((l) => window.__oip.store.getState().stProgram.includes(l), line, { timeout: 10000 }).catch(() => {})
    return (await text()).includes(line)
  }
  // Label: the rung's text opens with a free name selected, and typing replaces it
  await page.locator('[data-testid="ladder-rung-num"]').nth(1).click()
  await page.locator('[data-testid="ladder-add-label"]').click()
  await draft.waitFor({ timeout: 10000 })
  const picked = await draft.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd))
  expect(picked === 'L1', `the label's name is selected to type over (${picked})`)
  await page.keyboard.type('Mid')
  await page.keyboard.press('Enter')
  expect(await hasLine('Mid: |Always| (Stepped);'), 'Label names the rung Mid')
  // Jump: offers the next label below, which Enter takes
  await page.locator('[data-testid="ladder-rung-num"]').nth(1).click()
  await page.locator('[data-testid="ladder-add-jump"]').click()
  await draft.waitFor({ timeout: 10000 })
  const target = await draft.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd))
  expect(target === 'Past', `the jump offers the label below it (${target})`)
  await draft.press('Enter')
  expect(await hasLine('Mid: |Always| (Stepped) >>Past;'), 'Jump ends the rung in >>Past')
  // Return: set outright
  await page.locator('[data-testid="ladder-rung-num"]').nth(4).click()
  await page.locator('[data-testid="ladder-add-return"]').click()
  expect(await hasLine('|Always| (After) RETURN;'), 'Return ends the last rung in RETURN')
  expect(errors.length === 0, `no page errors (${errors.join(' | ')})`)
  await page.close()

  console.log('--- the ST editor shows durations and dates as their literals ---')
  const st = await open(browser, url, TIMES)
  await st.page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('CONCAT_DATE_TOD'), null, { timeout: 20000 })
  await st.page.evaluate(() => window.__oip.controller.run())
  await st.page.waitForFunction(() => document.querySelectorAll('.cm-st-value').length > 0, null, { timeout: 20000 })
  // let a few pushes land
  await st.page.waitForTimeout(600)
  const shown = await st.page.locator('.cm-st-value').allTextContents()
  for (const want of ['T#1s500ms', 'D#2024-02-29', 'TOD#07:05:09.500', 'DT#2024-02-29-07:05:09.500']) {
    expect(shown.includes(want), `${want} shown (${JSON.stringify([...new Set(shown)])})`)
  }
  expect(shown.some((s) => /^\d+$/.test(s)), 'an INT still shows as a plain number')
  expect(!shown.some((s) => /^\d{9,}$/.test(s)), 'no raw millisecond count left')
  await st.page.evaluate(() => window.__oip.controller.stop())
  expect(st.errors.length === 0, `no page errors (${st.errors.join(' | ')})`)
} finally {
  await browser.close()
  vite.kill()
}
console.log(failures === 0 ? 'PASS verify-ladder-jumps' : `FAIL verify-ladder-jumps: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
