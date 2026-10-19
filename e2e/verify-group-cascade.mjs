// Verify Select as one / Select parts individually (the `grouped` flag: a viewport click redirects to the
// flagged root) and visibility
// cascade (hiding a parent hides + un-picks its children) in the running app.
// Run: node e2e/verify-group-cascade.mjs [--headed]
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

const waitForApp = (page) =>
  page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
const sceneOf = (page) => page.evaluate(() => window.__oip.store.getState().scene)
const selIds = (page) => page.evaluate(() => window.__oip.store.getState().selectedIds)
const partById = (scene, id) => scene.parts.find((p) => p.id === id)

async function worldToScreen(page, pos) {
  return page.evaluate((p) => {
    const v = window.__oip.view
    v.camera.updateMatrixWorld(true)
    const proj = v.camera.position.clone().set(p[0], p[1], p[2]).project(v.camera)
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

// click a part's body in the viewport (clearing the selection first so we exercise
// the select path, not the re-grab-to-free-translate path). The SDK roller conveyor
// has no solid bed mesh (open rollers over a hidden deck), so a ray at the exact
// origin can slip between rollers to the floor - scan outward for a pixel where the
// app's own picking actually hits the part, then click there.
async function clickPartBody(page, pos, id) {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(50)
  const s = await ensureVisible(page, pos)
  const hit = await page.evaluate(([cx, cy, want]) => {
    const v = window.__oip.view
    if (v.pickPart(cx, cy) === want) return { x: cx, y: cy }
    for (let r = 4; r <= 200; r += 4) for (let a = 0; a < 360; a += 10) {
      const x = cx + r * Math.cos((a * Math.PI) / 180), y = cy + r * Math.sin((a * Math.PI) / 180)
      if (v.pickPart(x, y) === want) return { x, y }
    }
    return null
  }, [s.x, s.y, id])
  if (!hit) { await clickWorld(page, pos); return } // fall back to the raw click (the check will say why)
  await page.mouse.move(hit.x, hit.y, { steps: 4 })
  await page.waitForTimeout(80)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(80)
}

const meshVisible = (page, id) => page.evaluate((i) => !!window.__oip.view.entries.get(i)?.visual.object.visible, id)
async function pickAt(page, pos) {
  const s = await ensureVisible(page, pos)
  return page.evaluate(([x, y]) => window.__oip.view.pickPart(x, y), [s.x, s.y])
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  // keep the onboarding tour off: localStorage.clear() below re-arms it, and it overlays both the
  // viewport (so body clicks never select) and the scene tree (so the row's eye button reports as
  // intercepted). An init script re-applies the flag on every navigation, surviving the reload.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('oip-web/tutorial-done', '1')
    } catch {
      // ignore blocked storage
    }
  })
  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.waitForTimeout(2000)
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(800)

    // scene: rc_1 @ origin, rc_2 offset - two SDK roller conveyors loaded directly via the store
    // (explicitly named = their ids, so the tree rows are addressable by 'rc_1'/'rc_2'; the tree shows
    // names, not ids), package embedded; then make rc_2 a child of rc_1
    await page.waitForFunction(() => !!window.__oip.getPackage?.('oip.roller-conveyor'), { timeout: 25000 })
    await page.evaluate(() => {
      const store = window.__oip.store
      const pkg = window.__oip.getPackage('oip.roller-conveyor')
      const conv = (id, x, z) => ({ id, name: id, type: 'part', packageId: 'oip.roller-conveyor', position: [x, 0.75, z], rotationY: 0,
        params: { length: 3, width: 0.6, speed: 0.5, standHeight: 0.75, leftGuard: true, rightGuard: true } })
      store.loadScene({ version: store.getState().scene.version, parts: [conv('rc_1', 0, 0), conv('rc_2', 3, 2)], packages: [pkg] })
    })
    await page.waitForTimeout(500)

    let scene = await sceneOf(page)
    const CID = scene.parts.filter((p) => p.packageId === 'oip.roller-conveyor').map((p) => p.id).find((i) => i !== 'rc_1')
    await page.evaluate((c) => window.__oip.store.reparent([c], 'rc_1'), CID)
    scene = await sceneOf(page)
    const childPos = partById(scene, CID).position
    check('setup: child reparented under rc_1', partById(scene, CID).parent === 'rc_1', `child=${CID}`)

    // ---- group: clicking the child should select the group root ----
    await clickPartBody(page, childPos, CID)
    check('ungrouped: clicking the child selects the child', JSON.stringify(await selIds(page)) === JSON.stringify([CID]))

    // group rc_1 via the real Ctrl+G shortcut
    await page.locator('.tree-row', { hasText: 'rc_1' }).first().click()
    await page.keyboard.press('Control+g')
    await page.waitForTimeout(100)
    scene = await sceneOf(page)
    check('Ctrl+G grouped rc_1', partById(scene, 'rc_1').grouped === true)
    // The grouped state is read off the tree row's context menu, which swaps its label: the tree is the
    // surface that makes the setGrouped call and the only one that can show which parts carry the flag.
    await page.locator('.tree-row', { hasText: 'rc_1' }).first().click({ button: 'right' })
    const ungroupItem = await page.locator('button.context-item', { hasText: 'Select Parts Individually' }).count()
    check('tree menu swapped to Select Parts Individually', ungroupItem === 1)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(80)
    const badge = await page.locator('.tree-row', { hasText: 'rc_1' }).first().locator('.tree-group-wrap').count()
    check('grouped row shows a group badge', badge === 1)

    await clickPartBody(page, childPos, CID)
    check('GROUPED: clicking the child selects the GROUP root (rc_1)', JSON.stringify(await selIds(page)) === JSON.stringify(['rc_1']))

    // ungroup via Ctrl+Shift+G, child becomes directly selectable again
    await page.locator('.tree-row', { hasText: 'rc_1' }).first().click()
    await page.keyboard.press('Control+Shift+g')
    await page.waitForTimeout(100)
    scene = await sceneOf(page)
    check('Ctrl+Shift+G ungrouped rc_1', partById(scene, 'rc_1').grouped === undefined)
    await clickPartBody(page, childPos, CID)
    check('ungrouped again: clicking the child selects the child', JSON.stringify(await selIds(page)) === JSON.stringify([CID]))

    // ---- visibility cascade: hiding the parent hides + un-picks the child ----
    check('before hide: child mesh visible', (await meshVisible(page, CID)) === true)
    check('before hide: child is pickable in the viewport', (await pickAt(page, childPos)) === CID)

    // hide rc_1 via its tree eye button
    await page.locator('.tree-row', { hasText: 'rc_1' }).first().locator('.tree-eye').click()
    await page.waitForTimeout(120)
    check('after hiding parent: CHILD mesh is hidden too (cascade)', (await meshVisible(page, CID)) === false)
    const pick = await pickAt(page, childPos)
    check('after hiding parent: child is no longer pickable', pick !== CID, `pickPart returned ${pick}`)
    const childRowHidden = await page.locator('.tree-row.hidden', { hasText: CID }).count()
    check('tree dims the inherited-hidden child row', childRowHidden === 1)
    // the child kept its own visibility flag (only the parent was hidden)
    scene = await sceneOf(page)
    check('child keeps its own visible flag (inherited, not set)', partById(scene, CID).visible === undefined)

    // show the parent again -> child reappears
    await page.locator('.tree-row', { hasText: 'rc_1' }).first().locator('.tree-eye').click()
    await page.waitForTimeout(120)
    check('after showing parent: child mesh visible again', (await meshVisible(page, CID)) === true)

    await page.screenshot({ path: join(import.meta.dirname, 'shots', 'group-cascade.png') })
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
