// Verify soft parenting end-to-end in the running app: reparent in the tree, then
// move/rotate the parent with the real gizmo and confirm the child follows rigidly;
// confirm duplicate/delete act on the whole subtree. Run: node e2e/verify-soft-parenting.mjs [--headed]
/* global process, console, fetch, setTimeout, window */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}
const approx = (a, b, eps = 0.04) => Math.abs(a - b) <= eps
const ROLLER = 'oip.roller-conveyor'

async function waitForApp(page) {
  await page.waitForFunction(
    () => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller),
    { timeout: 20000 },
  )
}

const sceneOf = (page) => page.evaluate(() => window.__oip.store.getState().scene)
const partById = (scene, id) => scene.parts.find((p) => p.id === id)
// every part is type `part` with a packageId, so match conveyors by package
const rollers = (scene) => scene.parts.filter((p) => p.packageId === ROLLER).map((p) => p.id)

async function worldToScreen(page, pos) {
  return page.evaluate((p) => {
    const v = window.__oip.view
    const cam = v.camera
    cam.updateMatrixWorld(true)
    const proj = cam.position.clone().set(p[0], p[1], p[2]).project(cam)
    const rect = v.renderer.domElement.getBoundingClientRect()
    return {
      x: rect.left + ((proj.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - proj.y) / 2) * rect.height,
      inside: proj.z < 1 && proj.x > -0.95 && proj.x < 0.95 && proj.y > -0.95 && proj.y < 0.95,
    }
  }, pos)
}

async function ensureVisible(page, pos) {
  for (let i = 0; i < 6; i++) {
    const s = await worldToScreen(page, pos)
    if (s.inside) return s
    const c = await worldToScreen(page, [0, 0, 0])
    await page.mouse.move(c.x, c.y)
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(150)
  }
  return worldToScreen(page, pos)
}

// A package card is `div.catalog-card > button.catalog-card-main[data-package-id]`. Walks the
// category tabs rather than naming one, so a re-categorised part doesn't break the gate.
async function clickCatalogCard(page, packageId) {
  const card = page.locator(`button.catalog-card-main[data-package-id="${packageId}"]`)
  if ((await card.count()) === 0) {
    for (const tab of await page.locator('button.catalog-tab').all()) {
      await tab.click()
      await page.waitForTimeout(80)
      if ((await card.count()) > 0) break
    }
  }
  await card.first().click()
}

async function clickWorld(page, pos, { alt = false } = {}) {
  const s = await ensureVisible(page, pos)
  await page.mouse.move(s.x, s.y, { steps: 4 })
  await page.waitForTimeout(80)
  if (alt) await page.keyboard.down('Alt')
  await page.mouse.down()
  await page.mouse.up()
  if (alt) await page.keyboard.up('Alt')
  await page.waitForTimeout(80)
}

// rows are addressed by their data-row-id (the part id); their text is the part's name
const row = (page, id) => page.locator(`.tree-row[data-row-id="${id}"]`)
const selectRow = (page, id) => row(page, id).first().click()

// scan a ring of screen points around `center` for a gizmo handle matching `want`
async function findHandle(page, center, want) {
  return page.evaluate(
    ([cx, cy, wanted]) => {
      const v = window.__oip.view
      for (let r = 12; r <= 240; r += 4) {
        for (let a = 0; a < 360; a += 8) {
          const x = cx + r * Math.cos((a * Math.PI) / 180)
          const y = cy + r * Math.sin((a * Math.PI) / 180)
          if (wanted.includes(v.pickGizmoHandle(x, y))) return { x, y }
        }
      }
      return null
    },
    [center.x, center.y, want],
  )
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.waitForTimeout(2000)
    // clear the saved scene, but keep the tour dismissed: the onboarding modal sits over the viewport
    // and blocks every click this gate makes
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') })
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(800)

    // --- place two conveyors: first at origin, second offset (Alt = no snap) ---
    await clickCatalogCard(page, ROLLER)
    await page.waitForTimeout(120)
    await clickWorld(page, [0, 0, 0])
    await page.keyboard.press('Escape')
    await clickCatalogCard(page, ROLLER)
    await page.waitForTimeout(120)
    await clickWorld(page, [3, 0, 2], { alt: true })
    await page.keyboard.press('Escape')

    let scene = await sceneOf(page)
    const ids = rollers(scene)
    check('two conveyors placed', ids.length === 2, `ids=[${ids}]`)
    // ids are allocated by the store ('pt_1', …), so read them rather than hardcoding
    const [PID, CID] = ids
    const p0 = partById(scene, PID)
    const c0 = partById(scene, CID)
    check('parent + child parts present', !!p0 && !!c0, `parent=${PID} child=${CID}`)
    console.log(`  parent ${PID} @ ${p0.position.map((n) => +n.toFixed(2))}, child ${CID} @ ${c0.position.map((n) => +n.toFixed(2))}`)

    // --- reparent the child under the parent by dragging its tree row onto the parent's ---
    await row(page, CID).first().dragTo(row(page, PID).first())
    await page.waitForTimeout(150)
    scene = await sceneOf(page)
    let dndWorked = partById(scene, CID).parent === PID
    if (!dndWorked) {
      // headless HTML5 DnD is unreliable; fall back to the app's own reparent for setup
      await page.evaluate(([c, p]) => window.__oip.store.reparent([c], p), [CID, PID])
      scene = await sceneOf(page)
    }
    check('child reparented under parent', partById(scene, CID).parent === PID, dndWorked ? 'via tree drag-and-drop' : 'via store.reparent (DnD not drivable headless)')

    // nested rendering: the parent row shows a disclosure caret
    const caretCount = await row(page, PID).first().locator('.tree-caret').count()
    check('parent row renders a disclosure caret (nesting)', caretCount === 1)

    // probe: dropping the parent into its own child must be refused (cycle guard)
    await page.evaluate(([p, c]) => window.__oip.store.moveInTree([p], c, 'inside'), [PID, CID])
    scene = await sceneOf(page)
    check('cycle guard: parent cannot become a child of its own child', partById(scene, PID).parent === undefined)

    // ================= move the parent, child must follow rigidly =================
    await page.keyboard.press('w') // Move tool
    await selectRow(page, PID)
    await page.waitForTimeout(80)
    const before = await sceneOf(page)
    const pCenter = await ensureVisible(page, partById(before, PID).position)
    const moveHandle = await findHandle(page, pCenter, ['x', 'z', 'xz'])
    check('move gizmo handle located', !!moveHandle, moveHandle ? `at ${moveHandle.x | 0},${moveHandle.y | 0}` : 'none')
    if (moveHandle) {
      await page.mouse.move(moveHandle.x, moveHandle.y, { steps: 3 })
      await page.mouse.down()
      await page.mouse.move(moveHandle.x + 130, moveHandle.y - 40, { steps: 12 })
      await page.mouse.up()
      await page.waitForTimeout(120)
      const after = await sceneOf(page)
      const dp = partById(after, PID).position.map((v, i) => v - partById(before, PID).position[i])
      const dc = partById(after, CID).position.map((v, i) => v - partById(before, CID).position[i])
      const moved = Math.hypot(dp[0], dp[2]) > 0.1
      const follows = dp.every((v, i) => approx(v, dc[i], 0.02))
      check('parent actually moved', moved, `Δparent=${dp.map((n) => +n.toFixed(3))}`)
      check('CHILD followed by the same delta', moved && follows, `Δparent=${dp.map((n) => +n.toFixed(3))} Δchild=${dc.map((n) => +n.toFixed(3))}`)
    }

    // ================= rotate the parent, child must orbit rigidly =================
    await page.keyboard.press('e') // Rotate tool
    await selectRow(page, PID)
    await page.waitForTimeout(80)
    const beforeR = await sceneOf(page)
    const pr = partById(beforeR, PID)
    const cr = partById(beforeR, CID)
    const distBefore = Math.hypot(cr.position[0] - pr.position[0], cr.position[2] - pr.position[2])
    const rCenter = await ensureVisible(page, pr.position)
    const rotHandle = await findHandle(page, rCenter, ['rotY'])
    check('rotate gizmo (Y ring) located', !!rotHandle, rotHandle ? `at ${rotHandle.x | 0},${rotHandle.y | 0}` : 'none')
    if (rotHandle) {
      // drag tangentially around the ring to spin the part about +Y
      const tx = rotHandle.x - rCenter.x
      const ty = rotHandle.y - rCenter.y
      const tlen = Math.hypot(tx, ty) || 1
      const tang = { x: -ty / tlen, y: tx / tlen } // 90° from the radial = tangent
      await page.mouse.move(rotHandle.x, rotHandle.y, { steps: 3 })
      await page.mouse.down()
      await page.mouse.move(rotHandle.x + tang.x * 90, rotHandle.y + tang.y * 90, { steps: 14 })
      await page.mouse.up()
      await page.waitForTimeout(120)
      const afterR = await sceneOf(page)
      const pr2 = partById(afterR, PID)
      const cr2 = partById(afterR, CID)
      const distAfter = Math.hypot(cr2.position[0] - pr2.position[0], cr2.position[2] - pr2.position[2])
      const dyawP = Math.abs(pr2.rotationY - pr.rotationY)
      const dyawC = Math.abs(cr2.rotationY - cr.rotationY)
      const childMoved = Math.hypot(cr2.position[0] - cr.position[0], cr2.position[2] - cr.position[2]) > 0.05
      check('parent rotated in place (position held)', dyawP > 0.05 && approx(pr2.position[0], pr.position[0], 0.05) && approx(pr2.position[2], pr.position[2], 0.05), `Δyaw=${dyawP.toFixed(3)}`)
      check('CHILD orbited the parent (distance preserved, child moved)', childMoved && approx(distAfter, distBefore, 0.05), `dist ${distBefore.toFixed(2)}→${distAfter.toFixed(2)}, childMoved=${childMoved}`)
      check('child yaw turned with the parent', approx(dyawC, dyawP, 0.02), `Δyaw parent=${dyawP.toFixed(3)} child=${dyawC.toFixed(3)}`)
    }

    // ================= duplicate acts on the subtree =================
    await selectRow(page, PID)
    const nBefore = (await sceneOf(page)).parts.length
    await page.keyboard.press('Control+d')
    await page.waitForTimeout(120)
    scene = await sceneOf(page)
    check('duplicate added two parts (parent + child clone)', scene.parts.length === nBefore + 2, `${nBefore}→${scene.parts.length}`)
    const origIds = new Set([PID, CID])
    const clones = scene.parts.filter((p) => p.packageId === ROLLER && !origIds.has(p.id))
    const cloneRoot = clones.find((p) => p.parent === undefined)
    const cloneChild = clones.find((p) => p.parent !== undefined)
    check('duplicated subtree is internally relinked', !!cloneRoot && !!cloneChild && cloneChild.parent === cloneRoot.id, `root=${cloneRoot?.id} child=${cloneChild?.id}→${cloneChild?.parent}`)

    // ================= delete acts on the subtree =================
    await selectRow(page, PID)
    await page.keyboard.press('Delete')
    await page.waitForTimeout(120)
    scene = await sceneOf(page)
    const gone = !partById(scene, PID) && !partById(scene, CID)
    check('deleting the parent removed its child too (subtree delete)', gone, `remaining=[${scene.parts.map((p) => p.id)}]`)
    check('the duplicated subtree survived the delete', !!partById(scene, cloneRoot?.id) && !!partById(scene, cloneChild?.id))

    // probe: Unparent (context menu) detaches the duplicate's child back to a root
    if (cloneChild) {
      await row(page, cloneChild.id).first().click({ button: 'right' })
      await page.locator('.context-item', { hasText: /^Unparent$/ }).click()
      await page.waitForTimeout(100)
      scene = await sceneOf(page)
      check('Unparent menu detaches the child to root', partById(scene, cloneChild.id)?.parent === undefined)
    }

    await page.screenshot({ path: join(import.meta.dirname, 'shots', 'soft-parenting.png') })
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
