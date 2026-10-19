// Verify the Inspector's rig shape selector: an in-app author can change a rig node's kind (box →
// cylinder → cone → frame) and pick the kind that ＋ Add child node adds. Without it, every node the panel
// makes is a box and cannot be converted, so a browser-authored part would be boxes only.
// Drives the real DOM selects (not the controller) so the wiring (panel → editRigLink → package) is what
// is under test; the dimension carry-over itself is unit-tested in src/editor/rigTree.test.ts.
// Run: node e2e/verify-rig-shape-picker.mjs [--headed]
/* global process, console, window, localStorage */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
}

/** the live shape of a link, straight out of the package registry: what the panel is supposed to edit */
const shapeOf = (page, packageId, linkName) =>
  page.evaluate(
    ([id, name]) => {
      const pkg = window.__oip.getPackage(id)
      const link = pkg && pkg.geometry.kind === 'rig' ? pkg.geometry.links.find((l) => l.name === name) : undefined
      return link ? link.shape : null
    },
    [packageId, linkName],
  )

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    // clean slate + no onboarding tour modal over the docks
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)

    // ＋ New part: one 'body' box link, opened as its own scene with that node selected
    const packageId = await page.evaluate(() => window.__oip.controller.createBlankPart())
    check('＋ New part created a package', !!packageId, String(packageId))
    const born = await shapeOf(page, packageId, 'body')
    check('the new part is born a box', born && born.kind === 'box', JSON.stringify(born))

    const kindSelect = page.locator('label.field:has(.field-label:text-is("Kind")) select.rig-select')
    await kindSelect.waitFor({ state: 'visible', timeout: 10000 })
    check('the Inspector shows a shape Kind selector', await kindSelect.isVisible())
    check("it opens on the node's real kind", (await kindSelect.inputValue()) === 'box', await kindSelect.inputValue())

    // --- the conversions, each asserted against the live package -------------------------------------
    await kindSelect.selectOption('cylinder')
    let s = await shapeOf(page, packageId, 'body')
    // born a 0.6 cube -> r 0.3, h 0.6: the size the author had is carried across, not reset
    check('box → cylinder rewrote the link, carrying its size', s && s.kind === 'cylinder' && Math.abs(s.radius - 0.3) < 1e-9 && Math.abs(s.height - 0.6) < 1e-9, JSON.stringify(s))

    await kindSelect.selectOption('cone')
    s = await shapeOf(page, packageId, 'body')
    check('cylinder → cone kept radius + height', s && s.kind === 'cone' && Math.abs(s.radius - 0.3) < 1e-9 && Math.abs(s.height - 0.6) < 1e-9, JSON.stringify(s))

    // a cone must show its dimension fields, or it cannot be sized
    const coneRadius = page.locator('label.field:has(.field-label:text-is("Radius")) input')
    check('a cone exposes its Radius field', await coneRadius.isVisible())

    await kindSelect.selectOption('frame')
    s = await shapeOf(page, packageId, 'body')
    check('cone → frame drops the geometry (a pure pivot)', s && s.kind === 'frame' && s.radius === undefined, JSON.stringify(s))

    await kindSelect.selectOption('box')
    s = await shapeOf(page, packageId, 'body')
    check('frame → box restarts at the default 0.3 m cube', s && s.kind === 'box' && s.size.every((v) => Math.abs(v - 0.3) < 1e-9), JSON.stringify(s))

    // the sim/render side has to have actually rebuilt, not just the data
    const links = await page.evaluate((id) => {
      const geo = window.__oip.getPackage(id).geometry
      return geo.kind === 'rig' ? geo.links.length : -1
    }, packageId)
    check('the rig still has exactly its one link after 4 conversions', links === 1, String(links))

    // --- ＋ Add child node adds the kind chosen beside it --------------------------------------------
    const addSelect = page.locator('label.field:has(.field-label:text-is("New node")) select.rig-select')
    await addSelect.waitFor({ state: 'visible', timeout: 10000 })
    check('the add-node row has its own kind selector', await addSelect.isVisible())
    check('it defaults to box (what the scene-tree menu adds)', (await addSelect.inputValue()) === 'box')

    await addSelect.selectOption('cylinder')
    await page.locator('.rig-script-actions button:text-is("Add child node")').click()
    const added = await page.evaluate((id) => {
      const geo = window.__oip.getPackage(id).geometry
      const links = geo.kind === 'rig' ? geo.links : []
      return links.length === 2 ? { name: links[1].name, shape: links[1].shape, parent: links[1].parent } : null
    }, packageId)
    check('＋ Add child node added a CYLINDER, not a box', added && added.shape.kind === 'cylinder', JSON.stringify(added))
    check('...parented to the selected node', added && added.parent === 'body', added ? String(added.parent) : '')

    // and the panel follows the selection onto the new node, reading its kind
    await page.waitForTimeout(200)
    check('the picker now reads the newly selected node', (await kindSelect.inputValue()) === 'cylinder', await kindSelect.inputValue())

    await page.screenshot({ path: 'e2e/out/rig-shape-picker.png' })
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures === 0 ? String.fromCharCode(10)+"ALL PASS" : String.fromCharCode(10)+failures+" FAILURE(S)")
  process.exit(failures === 0 ? 0 : 1)
}

main()
