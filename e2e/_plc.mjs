/* global document, window */
// Bring the PLC editor on screen before a script drives it.
//
// The PLC editor docks as a background tab behind Parts by default (src/editor/dockLayout.ts), and a
// background tab is not mounted, so there is no CodeMirror in the page until the tab comes forward.
// This calls store.revealPanel, as the tutorial and the Problems dock's jump-to-code do, so it also
// opens a collapsed bottom dock, and it is a no-op for a panel that is floating, popped out or already
// in front.
//
// The front tab persists with the layout, so a plain reload keeps the editor up; a script that
// clears localStorage and reloads is back on the default and calls this again.

/**
 * A stored dock layout with the PLC editor floating and everything else at its default, for a script that needs the
 * code on screen beside a bottom-dock panel (Problems) - docked, the two share one strip. Write it to
 * 'oip-web/dock-layout' before a reload. Stamped with the layout version, or the load would treat the float as an
 * old default and dock it (dockLayout.ts migrateDockLayout).
 */
export const FLOATING_PLC_LAYOUT = JSON.stringify({ version: 2, floating: ['st'] })

/**
 * Reveal the PLC panel and wait for one of its faces to be on screen.
 *
 * The panel opens on the face of its main POU (StEditor `openingFace`: the PROGRAM the controller runs, else the first
 * block), so a program that is a ladder opens as rungs and there is no visible CodeMirror to wait for. A caller that
 * drives the code gets the text face brought up for it, which is what most callers of this helper want; a script
 * testing which face the panel chose passes `face: 'as-is'` and reads it.
 */
export async function showPlcEditor(page, { timeout = 30000, face = 'text' } = {}) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store), null, { timeout })
  await page.evaluate(() => window.__oip.store.revealPanel('st'))
  // the header row is the panel's own marker: it renders in either face and at any width
  await page.locator('[data-testid="plc-header"]').first().waitFor({ state: 'attached', timeout })
  // ...and then a face, each one a lazy chunk
  await page.waitForFunction(
    () => [...document.querySelectorAll('.cm-content, [data-testid="ladder-view"]')].some((el) => el.getBoundingClientRect().height > 0),
    null,
    { timeout, polling: 250 },
  )
  if (face !== 'text') return
  const code = page.locator('.cm-content').first()
  if (!(await code.isVisible())) await showText(page, { timeout })
  await code.waitFor({ state: 'visible', timeout })
}

/**
 * From the ladder sheet to the text. The Text/Ladder switch when there is one (a POU mixes the two), else a ladder
 * POU's "Show as text" in the organizer - the way a reader gets there, since every other row opens its POU in its own
 * language.
 */
export async function showText(page, { timeout = 30000 } = {}) {
  // Click with the mouse at the element's box, not locator.click(): a locator waits for its target to hold still
  // across animation frames. On a software renderer (CI, or any machine without an adapter) the demo draws at about
  // 1 fps headless, and two such waits (the chip, then its menu) exceed a 10 s timeout. Windows headless runs get the
  // real adapter (~20 fps, e2e/_gpuArgs.mjs).
  const press = async (locator, button = 'left') => {
    await locator.waitFor({ state: 'visible', timeout })
    const b = await locator.boundingBox({ timeout })
    if (!b) throw new Error('showText: the element has no box')
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button })
  }
  const toText = page.locator('[data-testid="plc-view-text"]')
  if (await toText.isVisible()) return press(toText)
  // the organizer beside the code (a narrow panel keeps it closed until asked)
  if (!(await page.locator('[data-testid="plc-organizer"]').isVisible())) await press(page.locator('[data-testid="plc-organizer-toggle"]'))
  // the rows' language tags trail a load by a quarter second (StEditor LADDER_MARK_DELAY_MS)
  await press(page.locator(':is([data-testid="org-pou"], [data-testid="org-top"])[data-lang="LD"]').first(), 'right')
  await press(page.locator('[data-testid="org-show-text"]'))
}

/**
 * Maximize the docked PLC panel, as a person does with its Maximize button, for a script whose geometry wants the
 * room (rung wrapping, drop positions). The panel's layout is the person's: nothing maximizes it by itself. A no-op
 * when it is already maximized.
 */
export async function maximizePlc(page, { timeout = 30000 } = {}) {
  if ((await page.locator('.dock-maximized [data-testid="plc-header"]').count()) > 0) return
  await page.locator('button[title="Maximize PLC"]').click({ timeout })
  await page.locator('.dock-maximized [data-testid="plc-header"]').waitFor({ state: 'attached', timeout })
}
