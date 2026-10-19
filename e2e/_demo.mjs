// Open the built-in demo the way a user does, from the toolbar.
//
// It is one command (file.openDemo), in the project menu - or, on the mobile layout, the "More actions" overflow
// that carries the same rows (_projectMenu.mjs decides which).
//
// Opening the demo opens a project: the page reloads into `?scene=demo` (sceneFile.openDemoScene), so this resolves
// once the new page's editor is up with the demo on screen.
/* global window */
import { afterReload, runProjectMenu } from './_projectMenu.mjs'

/** Click the toolbar's Open Demo entry and wait for the page it reloads into to show the demo. */
export async function clickDemo(page, opts = {}) {
  // Already in the example (a `?scene=demo` boot): the menu leaves Open Demo out there (ProjectMenu.tsx), and
  // pressing it would only have reopened the same untouched demo.
  if (await page.evaluate(() => !!window.__oip?.store?.getState().demoSession && window.__oip.store.getState().scene.parts.length > 0)) return
  await afterReload(page, () => runProjectMenu(page, 'file.openDemo', opts))
  await page.waitForFunction(() => window.__oip.store.getState().demoSession && window.__oip.store.getState().scene.parts.length > 0, null, {
    timeout: 90_000,
    polling: 200,
  })
}
