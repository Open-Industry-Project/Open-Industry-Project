// Verify author-mode rig-node rename (double-click a rig row in the SceneTree):
//   1. Structural cascade - rename a six-axis-robot link that has children + a joint
//      ('basePivot'), and confirm the new name reaches every child's `parent` and the
//      driving joint's `link`. Its behavior uses identifier grips/joints (no string
//      literal 'basePivot'), so no confirm dialog appears.
//   2. Guarded behavior rewrite - rename the push-button's 'cap' link, which the script
//      references as a string literal (setSubPose('cap', …), lamps:['cap']). A confirm
//      appears; accepting rewrites the whole-literal 'cap' occurrences to the new name,
//      while the unrelated material id 'cap' (a non-link ref) is left untouched.
// Run: node e2e/verify-rig-rename.mjs
/* global process, console, window */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`

let failed = false
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) failed = true
}

// Open a bundled part in author mode via the catalog ✎ ("Edit as its own scene") button;
// no viewport placement needed. Search first so the card shows regardless of its category.
async function openPartEdit(page, pkgName) {
  const search = page.locator('input.catalog-search')
  await search.fill('')
  await search.fill(pkgName)
  const card = page
    .locator('.catalog-card-custom')
    .filter({ has: page.locator('.catalog-card-label', { hasText: new RegExp(`^${pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
  await card.first().waitFor({ timeout: 10000 }) // let the search filter the card in before clicking
  const editBtn = card.locator('.catalog-card-edit').first()
  await editBtn.click()
  // the part scene opens with its rig auto-expanded; the rows render from geometry (no GLB wait). Retry the
  // ✎ click once if they don't appear: a cold catalog can drop the first click before the card settles.
  try {
    await page.waitForSelector('.tree-row.rig-node', { timeout: 8000 })
  } catch {
    await editBtn.click()
    await page.waitForSelector('.tree-row.rig-node', { timeout: 10000 })
  }
  await page.waitForTimeout(200)
}

// Double-click the rig row whose link name === oldName, then type newName + Enter.
async function renameRig(page, oldName, newName) {
  const row = page
    .locator('.tree-row.rig-node')
    .filter({ has: page.locator('.tree-name', { hasText: new RegExp(`^${oldName}$`) }) })
  await row.first().dblclick()
  const input = page.locator('input.tree-rename')
  await input.waitFor({ timeout: 5000 })
  await input.fill(newName)
  await input.press('Enter')
  await page.waitForTimeout(150)
}

// Read a registered package's live geometry + behavior from the registry.
const pkgState = (page, id) =>
  page.evaluate((pid) => {
    const p = window.__oip.getPackage(pid)
    if (!p || p.geometry.kind !== 'rig') return null
    return {
      links: p.geometry.links.map((l) => ({ name: l.name, parent: l.parent ?? null, aim: l.aim?.target ?? null })),
      joints: p.geometry.joints.map((j) => ({ name: j.name, link: j.link })),
      behavior: p.behavior,
      materialIds: (p.materials ?? []).map((m) => m.id),
    }
  }, id)

const dialogs = []

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  // auto-accept the behavior-rewrite confirm + record what was asked
  page.on('dialog', (d) => {
    dialogs.push(d.message())
    d.accept()
  })
  await page.goto(URL)
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller && window.__oip.getPackage), { timeout: 20000 })

  // Baseline: the base scene is not a definition session, so no scope banner and no panel rail.
  ok((await page.locator('.scene-def-scope').count()) === 0, 'base scene shows NO definition-scope banner')
  ok((await page.locator('.scene-tree-panel.definition-scope').count()) === 0, 'base scene panel has no definition rail')

  // ---- 1. Structural cascade: six-axis 'basePivot' (3 children + joint j1) → 'column' ----
  const SIX = 'oip.six-axis-robot'
  const before6 = await pkgState(page, SIX)
  ok(!!before6, 'six-axis package is registered as a rig')
  const childrenOfBasePivot = before6.links.filter((l) => l.parent === 'basePivot').map((l) => l.name)
  ok(childrenOfBasePivot.length === 3, `basePivot has 3 children before (${childrenOfBasePivot.join(', ')})`)
  ok(before6.joints.some((j) => j.name === 'j1' && j.link === 'basePivot'), 'joint j1 drives basePivot before')

  await openPartEdit(page, 'Six-Axis Robot')

  // ---- opening a part definition (Catalog ✎ = package-edit) shows the scope banner + instance count ----
  const banner = page.locator('.scene-def-scope')
  await banner.waitFor({ timeout: 5000 })
  const bannerText = (await banner.innerText()).replace(/\s+/g, ' ').trim()
  console.log('  [def-banner]', JSON.stringify(bannerText))
  ok(/definition/i.test(bannerText), `definition-scope banner is shown ("${bannerText}")`)
  // instance count: the tooltip always states it; the chip renders only when instances exist
  const bannerTitle = (await banner.getAttribute('title')) ?? ''
  ok(/\d+ instances?/i.test(bannerTitle), `banner tooltip states the instance blast radius ("${bannerTitle}")`)
  const chipText = (await page.locator('.scene-def-scope-count').allInnerTexts()).join(' ').trim()
  ok(chipText === '' || /[1-9]\d* instances?/i.test(chipText), chipText ? `count chip shows a real blast radius ("${chipText}")` : 'no instances placed → count chip hidden (count lives in the tooltip)')
  ok((await page.locator('.scene-tree-panel.definition-scope').count()) === 1, 'panel shows the definition rail in a definition session')

  await renameRig(page, 'basePivot', 'column')

  const after6 = await pkgState(page, SIX)
  ok(after6.links.some((l) => l.name === 'column'), 'link renamed basePivot → column')
  ok(!after6.links.some((l) => l.name === 'basePivot'), 'no link named basePivot remains')
  const newChildren = after6.links.filter((l) => l.parent === 'column').map((l) => l.name)
  ok(newChildren.length === 3 && childrenOfBasePivot.every((c) => newChildren.includes(c)), `all 3 children now parent → column (${newChildren.join(', ')})`)
  ok(!after6.links.some((l) => l.parent === 'basePivot'), 'no child still points at the old parent name')
  ok(after6.joints.some((j) => j.name === 'j1' && j.link === 'column'), 'joint j1 now drives column (link ref cascaded)')
  ok(after6.behavior === before6.behavior, 'six-axis behavior UNCHANGED (no string-literal refs → no prompt)')
  ok(dialogs.length === 0, `no confirm dialog for the structural-only rename (saw ${dialogs.length})`)

  // ---- 2. Guarded behavior rewrite: push-button 'cap' (string-literal refs) → 'button' ----
  const PB = 'oip.push-button'
  const beforePB = await pkgState(page, PB)
  const capLiteralsBefore = (beforePB.behavior.match(/(['"`])cap\1/g) || []).length
  ok(capLiteralsBefore >= 1, `push-button behavior has ${capLiteralsBefore} whole-literal 'cap' ref(s) before`)
  ok(beforePB.materialIds.includes('cap'), "push-button has a MATERIAL also named 'cap' (must NOT be touched)")

  await openPartEdit(page, 'Push Button')
  await renameRig(page, 'cap', 'button')

  const afterPB = await pkgState(page, PB)
  ok(afterPB.links.some((l) => l.name === 'button'), 'cap link renamed → button')
  ok(dialogs.length === 1, `exactly one confirm dialog fired (saw ${dialogs.length})`)
  ok(/button/.test(dialogs[0] ?? '') === false && /cap/.test(dialogs[0] ?? ''), `dialog asked about the OLD name 'cap': "${dialogs[0]}"`)
  const capLiteralsAfter = (afterPB.behavior.match(/(['"`])cap\1/g) || []).length
  const buttonLiteralsAfter = (afterPB.behavior.match(/(['"`])button\1/g) || []).length
  ok(capLiteralsAfter === 0, `all whole-literal 'cap' refs rewritten in behavior (0 left, was ${capLiteralsBefore})`)
  ok(buttonLiteralsAfter === capLiteralsBefore, `'button' literals now == old 'cap' count (${buttonLiteralsAfter})`)
  ok(afterPB.materialIds.includes('cap'), "MATERIAL id 'cap' left intact (cascade didn't bleed into non-link refs)")

  // ---- 3. Rig-row context menu (offers the same actions as scene rows) ----
  // push-button is still open in author mode; right-click its 'label' link row (a static link the rename left alone).
  const baseRow = page
    .locator('.tree-row.rig-node')
    .filter({ has: page.locator('.tree-name', { hasText: /^label$/ }) })
  await baseRow.first().click({ button: 'right' })
  const menu = page.locator('.context-menu').last()
  await menu.waitFor({ timeout: 5000 })
  const items = (await menu.locator('.context-item').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
  console.log('  [menu]', JSON.stringify(items))
  for (const label of ['Rename', 'Add Child Node', 'Hide', 'Lock', 'Delete']) {
    ok(items.some((t) => t.startsWith(label)), `rig context menu has "${label}"`)
  }

  // Add Child Node → push-button gains a link parented under 'label'
  const linksBeforeAdd = (await pkgState(page, PB)).links.length
  await menu.locator('.context-item', { hasText: 'Add Child Node' }).click()
  await page.waitForTimeout(200)
  const afterAdd = await pkgState(page, PB)
  ok(afterAdd.links.length === linksBeforeAdd + 1, `Add Child Node added a node (${linksBeforeAdd} → ${afterAdd.links.length})`)
  const added = afterAdd.links.find((l) => !beforePB.links.some((b) => b.name === l.name) && l.name !== 'button')
  ok(!!added && added.parent === 'label', `new node is parented under 'label' (${added?.name} ← ${added?.parent})`)

  // the new node is auto-selected; right-click it and Delete → back to the prior count
  const newRow = page
    .locator('.tree-row.rig-node')
    .filter({ has: page.locator('.tree-name', { hasText: new RegExp(`^${added.name}$`) }) })
  // a fresh add re-renders the rig forest; wait for the new row to settle before right-clicking it
  await newRow.waitFor({ timeout: 5000 })
  await page.waitForTimeout(150)
  await newRow.first().click({ button: 'right' })
  const menu2 = page.locator('.context-menu').last()
  await menu2.waitFor({ timeout: 5000 })
  await menu2.locator('.context-item', { hasText: /^Delete/ }).click()
  await page.waitForTimeout(200)
  const afterDel = await pkgState(page, PB)
  ok(afterDel.links.length === linksBeforeAdd, `Delete removed the added node (${afterAdd.links.length} → ${afterDel.links.length})`)
  ok(!afterDel.links.some((l) => l.name === added.name), `node '${added.name}' is gone`)

  // ---- 4. The same menu serves a scene/part row with the full part item set ----
  // right-click the part row (the custom part itself, a non-rig tree row) and confirm part-only items show
  // and the rig-only "Add Child Node" does not: one capability-driven menu, not two.
  const partRow = page.locator('.tree-row:not(.rig-node)').first()
  await partRow.click({ button: 'right' })
  const partMenu = page.locator('.context-menu').last()
  await partMenu.waitFor({ timeout: 5000 })
  const partItems = (await partMenu.locator('.context-item').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
  console.log('  [part-menu]', JSON.stringify(partItems))
  for (const label of ['Cut', 'Copy', 'Paste', 'Duplicate', 'Rename', 'Delete']) {
    ok(partItems.some((t) => t.startsWith(label)), `part context menu has "${label}"`)
  }
  ok(!partItems.some((t) => t.startsWith('Add Child Node')), 'part menu omits rig-only "Add Child Node"')
} catch (e) {
  console.error(e)
  failed = true
} finally {
  await browser.close()
  vite.kill()
}

console.log(failed ? '\nRIG RENAME: FAIL' : '\nRIG RENAME: OK')
process.exit(failed ? 1 : 0)
