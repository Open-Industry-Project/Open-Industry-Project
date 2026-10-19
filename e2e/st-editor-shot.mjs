// Visual + behavioural check for the CodeMirror-backed Structured Text editor:
// confirms the panel mounts and tokenizes, that an invalid program raises an inline
// error squiggle (and a valid one clears it), and that comms tags from a loaded scene
// surface in autocomplete. Screenshots land in e2e/shots/. Run: node e2e/st-editor-shot.mjs [--headed]
/* global process, console, fetch, setTimeout, window, document, localStorage */
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { showPlcEditor } from './_plc.mjs'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const OUT = join(import.meta.dirname, 'shots')
const HEADED = process.argv.includes('--headed')

// a program with a function block, to check FB members (OnDelay.Q) get inline values too
const FB_PROGRAM = `VAR_INPUT
  Start : BOOL;
  Stop  : BOOL;
END_VAR
VAR_OUTPUT
  Motor : BOOL;
  Lamp  : BOOL;
END_VAR
VAR
  OnDelay : TON;
END_VAR
Motor := (Start OR Motor) AND NOT Stop;
OnDelay(IN := Motor, PT := T#2s);
Lamp := OnDelay.Q;`

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// Replace the whole buffer: focus, select all, insert as one edit (CM processes the input event).
// focus() rather than click(): once monitoring is on, the inline value widgets remount on every
// poll, so .cm-content never satisfies click()'s "stable bounding box" actionability check and
// the call hangs until timeout. focus() only waits for the element to be attached.
async function setDoc(page, text) {
  await page.locator('.cm-content').focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(text)
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  // Open Demo doesn't confirm() (it saves the project and reloads into the demo, sceneFile.openDemoScene), but
  // Playwright auto-dismisses dialogs, which would turn a click behind a confirm() into a no-op. Accepting
  // them keeps any other dialog from doing that.
  page.on('dialog', (d) => d.accept().catch(() => {}))

  try {
    // keep the onboarding tour off: it re-arms after localStorage.clear() and its modal
    // intercepts pointer events on the panel's buttons
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ } })
    await page.goto(URL)
    await page.evaluate(() => localStorage.clear()).catch(() => {})
    await page.reload()
    // the ST panel renders once a controller exists (desktop only), docked behind Parts; its editor is .cm-content
    await showPlcEditor(page)
    await page.waitForTimeout(800)

    // 1. a cleared first load leaves the buffer empty, showing the ghost-text skeleton.
    //    The placeholder renders inside .cm-content, so innerText reads the skeleton back
    //    and an "is a program loaded?" assertion on it always passes. Assert on the document
    //    (one empty line + a placeholder widget), and treat the text as ghost text.
    const fresh = await page.evaluate(() => ({
      lines: document.querySelectorAll('.cm-line').length,
      placeholders: document.querySelectorAll('.cm-placeholder').length,
    }))
    const text = (await page.locator('.cm-content').innerText()).replace(/ /g, ' ')
    check('fresh load: empty buffer showing the ST skeleton placeholder',
      fresh.lines === 1 && fresh.placeholders === 1 && /VAR/.test(text),
      `lines=${fresh.lines} placeholders=${fresh.placeholders} ghost=${JSON.stringify(text.slice(0, 24))}`)

    // 2. the stream tokenizer ran (highlighted tokens are <span>s inside the lines). Needs
    //    real content: the placeholder is a single unstyled span, so an empty buffer counts 1.
    await setDoc(page, FB_PROGRAM)
    await page.waitForTimeout(300)
    const spans = await page.locator('.cm-content .cm-line span').count()
    check('syntax tokenized (highlighted spans present)', spans > 5, `spans=${spans}`)

    await page.screenshot({ path: join(OUT, 'st-editor-default.png') })

    // 3. an invalid program raises an inline error squiggle (undeclared 'Missing').
    //    Wait on the condition, not a timer: the mark appears 300-900ms after the edit
    //    depending on what was in the buffer, so a fixed 600ms wait is flaky.
    await setDoc(page, 'VAR_OUTPUT Motor : BOOL; END_VAR\nMotor := Missing;')
    const errShown = await page.locator('.cm-lintRange-error').first()
      .waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)
    const errMarks = await page.locator('.cm-lintRange-error').count()
    check('error squiggle shown for an undeclared variable', errShown && errMarks > 0, `marks=${errMarks}`)
    await page.locator('.cm-editor').screenshot({ path: join(OUT, 'st-editor-error.png') })

    // 4. a valid program clears the squiggle (again: poll the condition, don't guess a delay)
    await setDoc(page, 'VAR_OUTPUT Motor : BOOL; END_VAR\nMotor := TRUE;')
    const cleared = await page
      .waitForFunction(() => document.querySelectorAll('.cm-lintRange-error').length === 0, null, { timeout: 5000 })
      .then(() => true).catch(() => false)
    const okMarks = await page.locator('.cm-lintRange-error').count()
    check('squiggle clears for a valid program', cleared && okMarks === 0, `marks=${okMarks}`)

    // 5. autocomplete offers the loaded scene's comms tags. Assert on the 'scene tag' detail
    //    that stCompletions sets on them, not on a specific tag name: the demo scene's tag
    //    names change, and a hardcoded name would fail the gate on a working feature.
    await clickDemo(page)
    await page.waitForTimeout(500)
    await showPlcEditor(page) // the demo opens on its ladder program; this step drives the text
    // focus(), not click(): click aims at the middle of the whole demo program, off the short docked scroller
    await page.locator('.cm-content').focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText('\nRun')
    await page.keyboard.press('Control+Space')
    await page.locator('.cm-tooltip-autocomplete').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    const sceneTags = await page.evaluate(() => [...document.querySelectorAll('.cm-tooltip-autocomplete li')]
      .filter((li) => li.querySelector('.cm-completionDetail')?.textContent?.includes('scene tag'))
      .map((li) => li.querySelector('.cm-completionLabel')?.textContent ?? ''))
    check('autocomplete surfaces the scene\'s comms tags', sceneTags.length > 0,
      `sceneTags=${JSON.stringify(sceneTags.slice(0, 5))}`)
    await page.locator('.cm-editor').screenshot({ path: join(OUT, 'st-editor-autocomplete.png') }).catch(() => {})
    // dismiss the completion popup: its <li> options overlay the panel's buttons and would
    // intercept the "Load demo" click below
    await page.keyboard.press('Escape')
    await page.locator('.cm-tooltip-autocomplete').waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {})

    // 6. online monitoring: pressing Play attaches the program, and the poll loop pushes
    //    the live variable image into the editor as inline value boxes after each variable
    await clickDemo(page)
    await page.waitForTimeout(400)
    await showPlcEditor(page) // inline values are drawn in the text view; the demo opens on its ladder
    // Values are drawn only on the lines in view, so go to the top-level variables at the end of the program.
    // "Show as text" opens at Palletizer's head, next to the truck block's body, whose locals belong to two
    // instances and so have no single value. (focus(), not click(), for the reason step 5 gives)
    await page.locator('.cm-content').focus()
    await page.keyboard.press('Control+End')
    await page.locator('button.run-button.play').click()
    const monitoring = await page.locator('.cm-st-value').first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)
    const boxes = await page.locator('.cm-st-value').count()
    check('inline runtime values shown while monitoring', monitoring && boxes > 0, `boxes=${boxes}`)
    await page.locator('.cm-editor').screenshot({ path: join(OUT, 'st-editor-monitoring.png') }).catch(() => {})

    // 7. FB members: swap in a program with a TON and Reload it; OnDelay.Q gets a value box too.
    //    The panel's Reload enables once the text on screen differs from what runs (StEditor.tsx).
    //    Use loadStProgram, not typing over the demo. A wholesale replacement drops the demo's controller table,
    //    which runs PROGRAMs this text does not have; typed over, the reload fails with "unknown PROGRAM".
    await page.evaluate((src) => window.__oip.store.loadStProgram(src), FB_PROGRAM)
    await page.locator('[data-testid="st-reload"]:not([disabled])').click()
    await page.waitForTimeout(600)
    const fbBoxes = await page.evaluate(() => {
      const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes('OnDelay.Q'))
      return line ? line.querySelectorAll('.cm-st-value').length : -1
    })
    // the Lamp := OnDelay.Q; line carries a box for Lamp AND for the FB member OnDelay.Q
    check('FB member (OnDelay.Q) shows an inline value', fbBoxes >= 2, `boxesOnLine=${fbBoxes}`)
    await page.locator('.cm-editor').screenshot({ path: join(OUT, 'st-editor-fb-members.png') }).catch(() => {})

    // 8. persistence: an edited program survives a full reload (no localStorage.clear)
    const marker = '(* persisted-marker-42 *)\nVAR_OUTPUT Beacon : BOOL; END_VAR\nBeacon := TRUE;'
    await setDoc(page, marker)
    await page.waitForTimeout(300) // let the save land
    await page.reload()
    await showPlcEditor(page)
    await page.waitForTimeout(500)
    const restored = await page.locator('.cm-content').innerText()
    check('edited program persists across reload', /persisted-marker-42/.test(restored) && /Beacon/.test(restored), `head=${JSON.stringify(restored.slice(0, 40))}`)

    const pageErrs = errors.filter((e) => !/favicon|manifest/i.test(e))
    check('no uncaught page errors', pageErrs.length === 0, pageErrs.slice(0, 3).join(' | '))

    console.log(`\nshots: ${OUT}`)
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
