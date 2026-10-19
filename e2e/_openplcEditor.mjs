// Drives the installed OpenPLC Editor (an Electron app) the way a person does: by the text on its buttons,
// fields found by their labels, mouse clicks at the control's centre, and paste through the clipboard.
//
// Why mouse clicks and not Playwright's locators: the Editor renders a hidden mobile layout beside the desktop
// one, and its locators resolve to the hidden copy and time out. Finding the visible element ourselves and
// clicking its centre is also closer to what the guide asks a reader to do.
//
// Two things a person does that a script cannot: pick a folder in the native "choose a directory" dialog (answered
// here from the main process with an empty folder), and see the Editor's window (it opens on screen for the run).
//
// Found on Editor 4.3.0. Its labels are the Editor's, not ours: when an Editor release renames one,
// this fails on that label, and the guide's OpenPLC click path is out of date for that release too.
/* global process, document, getComputedStyle, Node, setTimeout */

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'

/** Where the per-user Windows installer puts it, unless OPENPLC_EDITOR_EXE says otherwise. */
export function findEditor() {
  const exe = process.env.OPENPLC_EDITOR_EXE ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'open-plc-editor', 'OpenPLC Editor.exe')
  return existsSync(exe) ? exe : null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Launch the Editor with its own profile (`profileDir`, kept between runs so its first-run tool installs happen
 * once) and a folder picker that answers with a fresh empty folder. Returns the driver.
 */
export async function launchEditor({ exe, profileDir }) {
  mkdirSync(profileDir, { recursive: true })
  const projectDir = mkdtempSync(join(tmpdir(), 'openplc-guide-project-'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // set in some shells (VS Code's), and then the Editor starts as plain Node
  const app = await _electron.launch({ executablePath: exe, args: [`--user-data-dir=${profileDir}`], env, timeout: 60000 })
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, projectDir)
  // a splash window comes first and closes; the Editor proper is the one that stays
  const until = Date.now() + 60000
  let win = null
  while (!win && Date.now() < until) {
    for (const w of app.windows().filter((x) => !x.isClosed())) {
      if (await w.evaluate(() => /New Project/.test(document.body?.innerText ?? '')).catch(() => false)) win = w
    }
    if (!win) await sleep(500)
  }
  if (!win) throw new Error('the OpenPLC Editor never showed its start screen')
  return new EditorDriver(app, win, projectDir)
}

export class EditorDriver {
  constructor(app, win, projectDir) {
    this.app = app
    this.win = win
    this.projectDir = projectDir
  }

  text() {
    return this.win.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  }

  /** Wait until the screen shows `phrase`. */
  async waitForText(phrase, timeoutMs = 20000) {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      if ((await this.text()).includes(phrase)) return true
      await sleep(250)
    }
    return false
  }

  /**
   * Click the visible control whose own text, placeholder or accessible name is exactly `label`: a real control
   * first, otherwise the innermost element reading it (a wrapper reads the same text, but its centre can miss).
   * Returns false when nothing visible reads it.
   */
  async click(label) {
    const box = await this.win.evaluate((want) => {
      const all = [...document.querySelectorAll('button, [role=button], [role=tab], [role=menuitem], [role=option], a, li, label, span, div, p, input')]
      const matches = all.filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && (el.innerText?.trim() === want || el.placeholder === want || el.getAttribute('aria-label') === want)
      })
      const hit = matches.find((el) => el.matches('button, [role=button], [role=option], [role=menuitem], [role=tab], input')) ?? matches.find((el) => !matches.some((o) => o !== el && el.contains(o)))
      if (!hit) return null
      hit.scrollIntoView({ block: 'center' })
      const r = hit.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }, label)
    if (!box) return false
    await this.win.mouse.click(box.x, box.y)
    await sleep(600)
    return true
  }

  /** Type into the field labelled (or placeholdered) `label`, replacing what is there, then Tab out so it commits. */
  async fill(label, text) {
    const box = await this.win.evaluate((want) => {
      const visible = (el) => el && el.getBoundingClientRect().width > 0
      let hit = [...document.querySelectorAll('input, textarea')].find((el) => visible(el) && [el.placeholder, el.getAttribute('aria-label'), el.name].includes(want))
      if (!hit) {
        const lab = [...document.querySelectorAll('label')].find((l) => visible(l) && l.innerText.trim() === want)
        hit = lab?.control ?? (lab ? [...document.querySelectorAll('input, textarea')].find((el) => visible(el) && lab.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) : null) ?? null
      }
      if (!hit) return null
      const r = hit.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }, label)
    if (!box) return false
    await this.win.mouse.click(box.x, box.y)
    await this.win.keyboard.press('Control+A')
    await this.win.keyboard.type(text)
    await this.win.keyboard.press('Tab')
    await sleep(300)
    return true
  }

  /** What the field labelled `label` holds now. */
  value(label) {
    return this.win.evaluate((want) => {
      const visible = (el) => el && el.getBoundingClientRect().width > 0
      const lab = [...document.querySelectorAll('label')].find((l) => visible(l) && l.innerText.trim() === want)
      const el = lab?.control ?? (lab ? [...document.querySelectorAll('input, textarea')].find((e) => visible(e) && lab.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) : null)
      return el?.value ?? null
    }, label)
  }

  /**
   * Replace everything in the n-th of `of` visible code editors with `text`, the way a paste delivers it: one text
   * insertion, not keystrokes (typing would trip the editor's auto-closing and auto-indent). Not through the system
   * clipboard: that is the user's, and anything else on the machine can change it between the write and the paste.
   * Waits for all `of` editors to be on screen first: a code view mounts a beat after its button is clicked, and
   * pasting before then goes into whichever editor is there.
   */
  async paste(n, text, of = n + 1) {
    const until = Date.now() + 15000
    let box = null
    while (!box && Date.now() < until) {
      box = await this.win.evaluate(
        ({ i, count }) => {
          const eds = [...document.querySelectorAll('.monaco-editor')].filter((e) => e.getBoundingClientRect().height > 0)
          if (eds.length < count) return null
          const r = eds[i].getBoundingClientRect()
          return { x: r.x + 60, y: r.y + 10 }
        },
        { i: n, count: of },
      )
      if (!box) await sleep(250)
    }
    if (!box) return false
    await this.win.mouse.click(box.x, box.y)
    await this.win.keyboard.press('Control+A')
    await this.win.keyboard.insertText(text)
    // the Editor reads a code view's text back into its tables a beat after the edit: switching views before
    // then drops the paste (seen as an empty variables table and "No variable defined in main POU" at build)
    await sleep(2000)
    return true
  }

  screenshot(path) {
    return this.win.screenshot({ path, timeout: 10000 }).catch(() => {})
  }

  close() {
    return this.app.close().catch(() => {})
  }
}
