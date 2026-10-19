// STRING support, end to end through the real editor: a program using STRING declarations,
// literals, CONCAT and INT_TO_STRING must compile with no squiggle, tokenize its literals as
// strings, and, once running, show its STRING variables as inline value boxes.
//
// The unit suite covers the language semantics (src/plc/plc.test.ts) and that the interpreter
// and the emitter agree (conformance.test.ts). Only a real run covers the UI path: a string
// value has to survive the sim worker's structured-clone boundary and come back through the
// watch table, which no node test exercises.
// Run: node e2e/verify-st-string.mjs [--headed]
/* global process, console, window, document, localStorage */
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const OUT = join(import.meta.dirname, 'shots')
const HEADED = process.argv.includes('--headed')

// exercises every surface at once: a bounded declaration with a literal initialiser, a
// capacity that truncates, CONCAT, a conversion, and a comparison
const STRING_PROGRAM = `VAR
  Prefix : STRING[8] := 'LINE';
  Cut : STRING[3] := 'abcdef';
  Count : INT := 7;
END_VAR
VAR_OUTPUT
  Label : STRING[16];
  Long : BOOL;
END_VAR
Label := CONCAT(Prefix, INT_TO_STRING(Count));
Long := LEN(Label) > 4;`

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// same reason as st-editor-shot.mjs: once monitoring is on the value widgets remount every
// poll, so .cm-content never stabilises for click(); focus() only needs it attached
async function setDoc(page, text) {
  await page.locator('.cm-content').focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(text)
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ headless: !HEADED })
  // dark: the token colours below are the dark scheme's, and the app follows the OS (editor/appearance.ts 'system'),
  // which headless Chromium reports as light
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('dialog', (d) => d.accept().catch(() => {}))

  try {
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ } })
    await page.goto(URL)
    await page.evaluate(() => localStorage.clear()).catch(() => {})
    await page.reload()
    await showPlcEditor(page)
    await page.waitForTimeout(800)

    await setDoc(page, STRING_PROGRAM)

    // 1. it compiles. Poll the condition rather than guessing a delay: the lint pass finishes
    //    300-900ms after the edit depending on what the buffer held before.
    const clean = await page
      .waitForFunction(() => document.querySelectorAll('.cm-lintRange-error').length === 0, null, { timeout: 6000 })
      .then(() => true).catch(() => false)
    const marks = await page.evaluate(() =>
      [...document.querySelectorAll('.cm-lintRange-error')].map((n) => n.textContent).slice(0, 3))
    check('a STRING program compiles with no error squiggle', clean, `marks=${JSON.stringify(marks)}`)

    // 2. the tokenizer colours literals as strings, not as stray identifiers/operators.
    //    CodeMirror generates opaque class names from the HighlightStyle, so assert the
    //    computed colour against the palette's string entry (#98c379) instead.
    const litColor = await page.evaluate(() => {
      const span = [...document.querySelectorAll('.cm-content .cm-line span')]
        .find((s) => s.textContent === "'LINE'")
      return span ? window.getComputedStyle(span).color : null
    })
    check('string literals tokenize as strings', litColor === 'rgb(152, 195, 121)', `color=${litColor}`)

    await page.locator('.cm-editor').screenshot({ path: join(OUT, 'st-string-editor.png') }).catch(() => {})

    // 3. run it, and read the inline value boxes back. This is the main assertion: the value
    //    is produced in the sim worker and travels back as a tag, so a string reaching the
    //    box shows the whole watch path carries text, not just numbers.
    await page.locator('button.run-button.play').click()
    const monitoring = await page.locator('.cm-st-value').first()
      .waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)
    check('monitoring attaches and pushes values', monitoring)

    // Read the boxes as a set, not per line: each widget renders inside the .cm-line it
    // annotates, so a line's textContent has the value spliced into the middle of the code
    // ("Label'LINE7' := CONCAT(...") and any search string spanning that point misses.
    // The values here are distinctive enough that membership is the whole assertion.
    // The boxes first show the declared initial values (Label '', Long FALSE) and only take the scan's values once the
    // worker publishes them, so wait for the computed Label before reading. A program that never runs still fails below.
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-st-value')].some((b) => b.textContent === "'LINE7'"), null, { timeout: 15000 }).catch(() => {})
    const boxes = await page.evaluate(() => [...document.querySelectorAll('.cm-st-value')].map((b) => b.textContent))
    // CONCAT('LINE', INT_TO_STRING(7)) = 'LINE7'; formatValue quotes it, ST-style
    check('a STRING variable shows its text inline', boxes.includes("'LINE7'"), `boxes=${JSON.stringify(boxes)}`)
    // STRING[3] := 'abcdef' truncated at the declared capacity, in the live image
    check('a store truncated to the declared capacity', boxes.includes("'abc'"), `boxes=${JSON.stringify(boxes)}`)
    check('LEN feeds an ordinary BOOL result', boxes.includes('TRUE'), `boxes=${JSON.stringify(boxes)}`)

    await page.locator('.cm-editor').screenshot({ path: join(OUT, 'st-string-monitoring.png') }).catch(() => {})

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
