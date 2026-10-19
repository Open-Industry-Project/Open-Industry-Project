// The command palette, in the browser, where it matters most: a web user has no native menu, so
// without the palette some actions (Select All Parts, Reset Panel Layout) are unreachable and the rest
// only by chord. This gate proves the palette is that path: it opens on Ctrl+Shift+P, finds a command
// by name, runs it against the real store, and greys what isn't currently allowed.
//
//   node e2e/verify-command-palette.mjs

import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { afterReload } from './_projectMenu.mjs'

let failed = false
const check = (label, ok, detail = '') => {
  if (!ok) failed = true
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`)
}

const { url, vite } = await startServer()
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu'] })
try {
  const page = await browser.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window.__oip?.store?.getState().scene.parts.length ?? 0) > 0, null, { timeout: 60000 })

  // Poll on a timer, not Playwright's default rAF: once the scene settles the viewport renders on
  // demand, the page stops painting, and an rAF-scheduled poller simply never runs again - the DOM
  // node is right there and waitForSelector still times out.
  const waitForPalette = (present) =>
    page
      .waitForFunction((want) => !!document.querySelector('.palette') === want, present, { timeout: 5000, polling: 100 })
      .then(() => true)
      .catch(() => false)

  // ── opens on the chord ──────────────────────────────────────────────────────────────────────────
  await page.keyboard.press('Control+Shift+P')
  check('Ctrl+Shift+P opens the palette', await waitForPalette(true))

  // ── it lists the web surface, not the desktop one ───────────────────────────────────────────────
  const listed = await page.evaluate(() => [...document.querySelectorAll('.palette-label')].map((el) => el.textContent))
  check('lists commands with no button anywhere', listed.includes('Select All Parts') && listed.includes('Reset Panel Layout'), `${listed.length} commands`)
  // Only Open is desktop-only: Save to Folder has a browser implementation (File System Access)
  // and no shellOnly flag, since linking a folder is the one way an agent's edits reach the web app.
  check(
    'hides the desktop-only ones in a browser',
    !listed.some((l) => l === 'Open Project Folder…'),
    listed.filter((l) => l.includes('Project')).join(' · ') || 'none listed',
  )
  check('but keeps the ones the browser can actually do', listed.includes('Save Project to Folder…'))

  // ── disabled commands stay visible and greyed, rather than lying ────────────────────────────────
  const stopState = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.palette-item')].find((b) => b.querySelector('.palette-label')?.textContent === 'Stop')
    return { present: !!row, disabled: !!row?.disabled }
  })
  check('Stop is listed but disabled while the sim is idle', stopState.present && stopState.disabled, JSON.stringify(stopState))

  // ── search + run ────────────────────────────────────────────────────────────────────────────────
  await page.fill('.palette-input', 'select all')
  const firstHit = await page.textContent('.palette-item .palette-label')
  check('typing filters to the command', firstHit === 'Select All Parts', String(firstHit))

  await page.keyboard.press('Enter')
  await waitForPalette(false)
  const selected = await page.evaluate(() => {
    const s = window.__oip.store.getState()
    return { selected: s.selectedIds.length, parts: s.scene.parts.length }
  })
  check('Enter runs it against the real store', selected.selected === selected.parts && selected.parts > 0, JSON.stringify(selected))
  check('running a command closes the palette', (await page.locator('.palette').count()) === 0)

  // ── Escape backs out without running anything ───────────────────────────────────────────────────
  await page.keyboard.press('Control+Shift+P')
  await waitForPalette(true)
  await page.keyboard.press('Escape')
  check('Escape closes it', await waitForPalette(false))

  // ── Quick Open: the palette finds things, not just actions ──────────────────────────────────────
  // Like VS Code's Ctrl+P and Blender's F3, it finds objects, so "go to that diverter" and "place a
  // spur" don't need a trip to the mouse (the Scene tree's filter box, the catalog's tabs) from a
  // keyboard gesture the user already has open. Run against the demo, because
  // the ranking is only interesting when there is a real scene and a real catalog to rank.
  const qo = await browser.newPage()
  try {
    await qo.goto(`${url}?scene=demo`, { waitUntil: 'domcontentloaded' })
    await qo.waitForFunction(() => (window.__oip?.store?.getState().scene.parts.length ?? 0) > 20, null, { timeout: 60000 })
    const waitQo = (present) =>
      qo
        .waitForFunction((want) => !!document.querySelector('.palette') === want, present, { timeout: 5000, polling: 100 })
        .then(() => true)
        .catch(() => false)
    const rows = () => qo.evaluate(() => [...document.querySelectorAll('.palette-item')].map((b) => ({
      group: b.querySelector('.palette-group')?.textContent,
      label: b.querySelector('.palette-label')?.textContent,
      kind: b.dataset.kind,
    })))

    // A part whose display name is unique, so "Enter picks the one I meant" is a real assertion.
    // Most of the demo's names are not: partDisplayName numbers unnamed parts among their siblings,
    // so the seven pallet stacks each contain a "Box 15". That collision is checked separately below.
    const target = await qo.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts
      const counts = {}
      for (const p of parts) {
        const n = (p.name ?? '').trim()
        if (n) counts[n] = (counts[n] ?? 0) + 1
      }
      const p = parts.find((x) => (x.name ?? '').trim().length > 3 && counts[(x.name ?? '').trim()] === 1)
      return p ? { id: p.id, name: p.name.trim() } : null
    })
    check('the demo has a uniquely named part to look for', !!target, JSON.stringify(target))

    await qo.keyboard.press('Control+Shift+P')
    await waitQo(true)
    await qo.locator('.palette-input').fill(target.name, { force: true })
    await qo.waitForTimeout(200)
    const hits = await rows()
    check('an exact part name ranks first, above any command that shares its letters', hits[0]?.label === target.name, JSON.stringify(hits.slice(0, 3)))
    check('and it is labelled as coming from the scene', hits[0]?.group === 'Scene', String(hits[0]?.group))

    await qo.keyboard.press('Enter')
    await waitQo(false)
    const sel = await qo.evaluate(() => window.__oip.store.getState().selectedIds)
    check('Enter selects that part in the scene', sel.length === 1 && sel[0] === target.id, JSON.stringify(sel))

    // Same-named parts must be distinguishable. The demo has seven "Box 15" (one per pallet stack),
    // because partDisplayName numbers unnamed parts among their siblings - correct in the tree, where
    // you can see the parent, and useless in a flat list. Each row carries where it lives, the way VS
    // Code's Quick Open disambiguates same-named files by folder.
    const dupName = await qo.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts
      const counts = {}
      for (const p of parts) {
        const n = (p.name ?? '').trim()
        if (n) counts[n] = (counts[n] ?? 0) + 1
      }
      const hit = Object.entries(counts).find(([, n]) => n > 1)
      return hit ? hit[0] : null
    })
    if (dupName) {
      await qo.keyboard.press('Control+Shift+P')
      await waitQo(true)
      await qo.locator('.palette-input').fill(dupName, { force: true })
      await qo.waitForTimeout(200)
      const dupRows = await qo.evaluate((name) =>
        [...document.querySelectorAll('.palette-item[data-kind="part"]')]
          .filter((b) => b.querySelector('.palette-label')?.textContent === name)
          .map((b) => b.querySelector('.palette-chord')?.textContent ?? ''),
      dupName)
      check(`same-named parts are told apart by where they live ("${dupName}" x${dupRows.length})`, dupRows.length > 1 && new Set(dupRows).size > 1, JSON.stringify(dupRows.slice(0, 4)))
      await qo.keyboard.press('Escape')
      await waitQo(false)
    } else {
      check('the demo has same-named parts to disambiguate', false, 'none found - this check went vacuous')
    }

    // a catalog row starts placing - it must not silently drop geometry somewhere off-screen
    await qo.keyboard.press('Control+Shift+P')
    await waitQo(true)
    await qo.locator('.palette-input').fill('belt', { force: true })
    await qo.waitForTimeout(200)
    const beltRows = await rows()
    const catalogRow = beltRows.findIndex((r) => r.kind === 'catalog')
    check('the catalog is searchable from the palette', catalogRow >= 0, JSON.stringify(beltRows.slice(0, 5)))
    const before = await qo.evaluate(() => window.__oip.store.getState().scene.parts.length)
    await qo.locator('.palette-item[data-kind="catalog"]').first().click({ force: true })
    await waitQo(false)
    const placing = await qo.evaluate(() => {
      const s = window.__oip.store.getState()
      return { mode: s.mode, type: s.placingType, parts: s.scene.parts.length }
    })
    check('choosing a catalog row enters placing mode', placing.mode === 'placing', JSON.stringify(placing))
    check('and drops nothing until the user clicks', placing.parts === before, `${before} -> ${placing.parts}`)

    // a populous scene must not crowd the commands out of the list
    await qo.keyboard.press('Escape')
    await qo.keyboard.press('Control+Shift+P')
    await waitQo(true)
    await qo.locator('.palette-input').fill('c', { force: true })
    await qo.waitForTimeout(200)
    const broad = await rows()
    check('a one-letter query still shows commands beside the parts', broad.some((r) => r.kind === 'command'), `${broad.length} rows`)
    check('and caps the part rows so they cannot flood it', broad.filter((r) => r.kind === 'part').length <= 8, String(broad.filter((r) => r.kind === 'part').length))
  } finally {
    await qo.close()
  }

  // ── the same registry, rendered by a different surface ──────────────────────────────────────────
  // A phone uses the project menu, like every layout, rather than its own hand-written copy of
  // New/Save/Load/Demo and their disabled rules. Its rows are the same command ids, so this is the check that the list - not just the palette - is what every
  // surface renders, on the narrowest one.
  await page.setViewportSize({ width: 400, height: 800 })
  await page.waitForFunction(() => document.querySelector('.app')?.classList.contains('phone') === true, null, {
    timeout: 10000,
    polling: 100,
  })
  await page.getByTestId('project-menu').click()
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.project-popover [data-command]')].map((b) => b.getAttribute('data-command')),
  )
  check(
    'the phone project menu renders the same file commands',
    ['file.newProject', 'file.save', 'file.importProject', 'file.openDemo', 'file.exportProject'].every((id) => rows.includes(id)),
    rows.join(' · '),
  )

  // Opening the demo is opening the built-in example project: the page reloads into it (afterReload), and it is
  // not a project of the user's until it is edited, so pressing Demo creates nothing and cannot ladder "Palletizing demo 2,
  // 3, 4" into the projects list. The observables: the session flag and the same open document underneath.
  const before = await page.evaluate(() => localStorage.getItem('oip-web/document-id'))
  const opened = await afterReload(page, () => page.locator('.project-popover [data-command="file.openDemo"]').click())
    .then(() => page.waitForFunction(() => window.__oip.store.getState().demoSession === true, null, { timeout: 30000, polling: 200 }))
    .then(() => true)
    .catch(() => false)
  check('a menu row runs its command', opened)
  const after = await page.evaluate(() => localStorage.getItem('oip-web/document-id'))
  check('and opening the demo costs no project', after === before, `${before} -> ${after}`)
} catch (err) {
  failed = true
  console.log('FAIL', err?.message || err)
} finally {
  await browser.close()
  vite.kill()
}

console.log(failed ? '\nFAIL' : '\nPASS')
process.exit(failed ? 1 : 0)
