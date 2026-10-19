// A program edit is one undo step, end to end through the real editor.
//
// Unit tests cover the store's side (src/editor/programUndo.test.ts): commitProgram records the code, scan time,
// table and wiring as one entry, and an edit whose code was typed over since is dropped. Only a browser run can
// check the editor's side: that the code a program edit changes reaches CodeMirror without an undo step of its
// own there, that Ctrl+Z pressed inside the code editor hands a program edit to the store only when nothing typed is
// newer, that typing and program edits then undo in the order they happened, and that a Ctrl+Z outside the editor
// undoes a table-only edit rather than an unrelated one. Edits are driven through the store rather than the
// organizer's DOM, so where the organizer is docked does not matter here.
// Run: node e2e/verify-st-program-undo.mjs [--headed]
/* global process, console, localStorage, window, document, HTMLElement */
import { startServer } from './_server.mjs'
import { showPlcEditor } from './_plc.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

const CODE = `VAR_INPUT Start : BOOL; END_VAR
VAR_OUTPUT Motor : BOOL; END_VAR
Motor := Start;`

const WITH_PROGRAM = `PROGRAM Sorter
VAR_OUTPUT Divert : BOOL; END_VAR
Divert := Motor;
END_PROGRAM

${CODE}`

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const programDoc = (page) =>
  page.evaluate(() => {
    const s = window.__oip.store.getState()
    return { source: s.stProgram, scanMs: s.stScanMs, controller: s.controller, notice: s.undoNotice }
  })
// the rendered lines of the code editor (the programs here are short enough that none is virtualized away)
const editorText = async (page) =>
  page.evaluate(() => {
    const lines = document.querySelectorAll('.cm-content .cm-line')
    return lines.length === 0 ? null : [...lines].map((l) => l.textContent).join('\n')
  })
const blur = (page) => page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
// focused rather than clicked: a floating panel may sit over the code, and the keys are what is under test
const focusCodeEnd = async (page) => {
  await page.locator('.cm-content').focus()
  await page.keyboard.press('Control+End')
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })

  try {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('oip-web/tutorial-done', '1')
      } catch {
        /* private mode */
      }
    })
    await page.goto(URL)
    await page.evaluate(() => localStorage.clear()).catch(() => {})
    await page.reload()
    await showPlcEditor(page)
    await page.waitForTimeout(800)
    await page.locator('.cm-content').focus()
    await page.keyboard.press('Control+A')
    await page.keyboard.insertText(CODE)
    await page.waitForTimeout(400)
    const start = await programDoc(page)
    check('the program starts as typed, with no table', start.source === CODE && start.controller === null)

    // ---- a table-only edit, undone from outside the code editor ----
    await page.evaluate(() => window.__oip.store.commitProgram('Retime task MainTask', { scanMs: 25 }))
    check('the program edit lands', (await programDoc(page)).scanMs === 25)
    await blur(page)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(200)
    const retimeUndone = await programDoc(page)
    check('Ctrl+Z outside the editor takes the program edit back', retimeUndone.scanMs === start.scanMs, `scan=${retimeUndone.scanMs}`)
    check('...and only it: the code is untouched', retimeUndone.source === CODE)

    // ---- a program edit that changes the code, undone from inside the code editor ----
    const table = {
      tasks: [{ name: 'MainTask', intervalMs: start.scanMs, priority: 10 }],
      programs: [{ name: 'Main', task: 'MainTask' }, { name: 'Sorter', type: 'Sorter', task: 'MainTask' }],
    }
    await page.evaluate((t) => window.__oip.store.commitProgram('Add program', { source: t.source, controller: t.table }), { source: WITH_PROGRAM, table })
    await page.waitForTimeout(200)
    check('the code a program edit changes reaches the editor', (await editorText(page)) === WITH_PROGRAM, ((await editorText(page)) ?? 'no editor').slice(0, 40))

    await focusCodeEnd(page)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(200)
    const inEditor = await programDoc(page)
    check('Ctrl+Z in the code editor takes back the code AND the table, as one step', inEditor.source === CODE && inEditor.controller === null)
    check('...and the editor shows the code it went back to', (await editorText(page)) === CODE)

    await page.keyboard.press('Control+y')
    await page.waitForTimeout(200)
    const redone = await programDoc(page)
    check('Ctrl+Y in the code editor puts both back', redone.source === WITH_PROGRAM && JSON.stringify(redone.controller) === JSON.stringify(table))

    // ---- typing after it: the typing undoes first, then the program edit ----
    await focusCodeEnd(page)
    // inserted in one transaction, so it is exactly one step of the editor's own history
    await page.keyboard.insertText('\n// typed after')
    await page.waitForTimeout(700)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(200)
    const typingUndone = await programDoc(page)
    check('the first Ctrl+Z in the editor undoes the typing, not the program edit', typingUndone.source === WITH_PROGRAM && typingUndone.controller !== null, typingUndone.source.slice(-30))
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(200)
    const thenProgram = await programDoc(page)
    check('the next one undoes the program edit', thenProgram.source === CODE && thenProgram.controller === null)

    // ---- typed over since: dropped with a notice, and nothing lost ----
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(200)
    await focusCodeEnd(page)
    await page.keyboard.insertText('\n// kept')
    await page.waitForTimeout(400)
    await blur(page)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(300)
    const dropped = await programDoc(page)
    check('a Ctrl+Z outside the editor leaves code typed since the program edit alone', dropped.source.endsWith('// kept') && dropped.controller !== null, dropped.source.slice(-20))
    check('...and says why nothing moved', (await page.locator('[data-testid="undo-notice"]').count()) === 1, dropped.notice?.title ?? 'no notice')

    const real = errors.filter((e) => !/favicon|DevTools|WebGPU|webgpu|GPU/i.test(e))
    check('no page errors', real.length === 0, real.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures === 0 ? '\nverify-st-program-undo: all checks passed' : `\nverify-st-program-undo: ${failures} check(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
