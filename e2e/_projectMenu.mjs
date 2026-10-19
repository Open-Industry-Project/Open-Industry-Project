// Run a file action the way a user does, from the toolbar - and reach the projects list (the shelf).
//
// The file actions are the project menu's (src/editor/components/ProjectMenu.tsx): the project's name at the left
// of the row opens them, on every layout. Rows are found by command id (data-command), not by label: a row's
// accessible name includes its chord ("Save Ctrl+S"), and a relabel should not break a gate that only means "this
// action". A project holds one scene (format 4), so the menu lists no scenes. The built-in demo is a project of its
// own (the projects list's Examples): Open Demo reloads into it, and leaving it is opening another project.
//
// The projects list (components/ProjectsOverlay.tsx) is where another project is opened or made; both reload the
// page into that document, so the helpers below wait for the new page's app, not for a paint.
/* global window, document */

/** open the project menu (if it is not already) */
export async function openProjectMenu(page, opts = {}) {
  const button = page.getByTestId('project-menu')
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click(opts)
}

/** the menu's row for `commandId`, with the menu open */
export async function projectMenuItem(page, commandId, opts = {}) {
  await openProjectMenu(page, opts)
  return page.locator(`[role="menu"] [data-command="${commandId}"]`)
}

/** open the menu and click `commandId` in it */
export async function runProjectMenu(page, commandId, opts = {}) {
  await (await projectMenuItem(page, commandId, opts)).click(opts)
}

/**
 * Open the projects list through the command palette. The row is clicked rather than Enter pressed - the
 * palette ranks parts and catalog cards alongside commands - and every wait polls on a timer: a settled viewport
 * renders on demand, so a rAF-scheduled poll can stall (see verify-project-shelf.mjs).
 */
export async function openProjectsList(page) {
  await page.keyboard.press('Control+Shift+P')
  await page.waitForFunction(() => !!document.querySelector('.palette-input'), null, { polling: 100, timeout: 15_000 })
  await page.fill('.palette-input', 'projects')
  await page.waitForFunction(
    () => [...document.querySelectorAll('.palette-item .palette-label')].some((e) => (e.textContent ?? '').startsWith('Projects')),
    null,
    { polling: 100, timeout: 15_000 },
  )
  await page
    .locator('.palette-item', { has: page.locator('.palette-label', { hasText: /^Projects/ }) })
    .first()
    .click({ force: true })
  await page.waitForFunction(() => document.querySelectorAll('.projects-row').length > 0, null, { polling: 100, timeout: 15_000 })
}

/** run `action`, which reloads the page into another document, and wait until that page's editor is up */
export async function afterReload(page, action, timeout = 90_000) {
  await page.evaluate(() => ((window.__oipReloadMark = true), undefined))
  await action()
  await page.waitForFunction(() => window.__oipReloadMark === undefined && !!window.__oip?.controller && !!window.__oip?.view, null, {
    timeout,
    polling: 200,
  })
}

/** the projects list's row button for the project named exactly `name` ("Line" must not match "Line 2") */
export const projectRow = (page, name) =>
  page.locator('.projects-name:not([data-testid="projects-example-demo"])').filter({ has: page.locator('.projects-label').getByText(name, { exact: true }) })

/** make a new project named `name` from the projects list; resolves once the page has reloaded into it */
export async function createProject(page, name) {
  await openProjectsList(page)
  await page.locator('.projects-new').click({ force: true })
  await page.fill('.projects-input', name)
  await afterReload(page, () => page.locator('.projects-confirm').click({ force: true }))
}

/** open the stored project named `name` from the projects list; resolves once the page has reloaded into it */
export async function openProjectNamed(page, name) {
  await openProjectsList(page)
  await afterReload(page, () => projectRow(page, name).first().click({ force: true }))
}
