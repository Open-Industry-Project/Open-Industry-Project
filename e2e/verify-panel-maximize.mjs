// Verify panel maximize (dockLayout.maximized): one panel enlarged to fill everything under
// the toolbar. It does not replace the main screen: the 3D viewport is never unmounted.
// The maximized panel shares the viewport's grid cell and paints over a canvas that keeps
// its live WebGL/WebGPU context (and the render bundles holding baked resource handles).
// So the assertions are:
//
//   - the same canvas element survives the round trip (a remount = a lost context)
//   - no uncaptured GPU errors from the resize the toggle causes (__oipGpuErrors)
//   - it works from the floating PLC window, not just a dock slot; restoring returns it to
//     that window, not to a dock
//   - Esc restores, but not while you're typing in the ST editor
//   - it does not persist across a reload
//
// Run: node e2e/verify-panel-maximize.mjs [--headed]
/* global process, console, window, document, localStorage */
import { startServer } from './_server.mjs'
import { FLOATING_PLC_LAYOUT } from './_plc.mjs'
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
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 20000 })
}

// Everything the toggle is supposed to move. `canvasTag` is a marker stamped onto the canvas
// element before the first maximize: if it's still there afterwards, React never unmounted the
// viewport and the GPU context is the same one.
async function metrics(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      if (!el) return { w: 0, h: 0 }
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height) }
    }
    const viewport = document.querySelector('.viewport')
    const canvas = document.querySelector('.viewport canvas')
    const max = document.querySelector('.dock-maximized')
    const cs = viewport ? getComputedStyle(viewport) : null
    return {
      hasMax: !!max,
      maxTitle: max?.querySelector('.dock-maximized-title')?.textContent ?? null,
      // does the maximized host actually hold a CodeMirror surface (the panel really rendered)
      maxHasEditor: !!max?.querySelector('.cm-editor'),
      max: rect(max),
      // the floating PLC window is the only position:fixed StEditor; find it by its drag header
      floatingPlc: !!document.querySelector('[aria-label="Dock panel"]'),
      dockSlots: document.querySelectorAll('.dock-slot').length,
      viewportHidden: cs?.visibility === 'hidden',
      viewport: rect(viewport),
      canvas: rect(canvas),
      // drawing-buffer size: 0 would mean the context was torn down / never resized back
      buffer: canvas ? { w: canvas.width, h: canvas.height } : null,
      canvasTag: canvas?.dataset?.oipTag ?? null,
      stored: JSON.parse(localStorage.getItem('oip-web/dock-layout') || '{}').maximized ?? null,
      gpuErrors: window.__oipGpuErrors?.count ?? 0,
    }
  })
}

const shellH = (m) => m.viewport.h // the cell everything below the toolbar shares

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    // floated on purpose: the default docks the PLC editor, and the floating window is the form that has to maximize
    // without being docked first (the docked form is covered further down)
    await page.evaluate((layout) => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1') // no tour modal over the chrome
      localStorage.setItem('oip-web/dock-layout', layout)
    }, FLOATING_PLC_LAYOUT)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.waitForSelector('.dock-slot-bottom .dock-slot-tab')
    // stamp the canvas so a later remount is detectable
    await page.evaluate(() => {
      document.querySelector('.viewport canvas').dataset.oipTag = 'orig'
    })

    // ---------------------------------------------------------------- baseline
    const base = await metrics(page)
    check('starts restored: docks up, no maximized host', !base.hasMax && base.dockSlots >= 2, `${base.dockSlots} slots`)
    check('starts with the floating PLC window', base.floatingPlc)
    check('viewport visible', !base.viewportHidden)

    // ------------------------------------------- maximize from the floating window
    // by title: every dock tab strip carries a "Maximize panel" aria-label too, and the
    // left column's comes first in DOM order
    await page.locator('[title="Maximize (Esc to restore)"]').click()
    await page.waitForTimeout(200)
    const big = await metrics(page)
    check('maximized host appears', big.hasMax)
    check('titled after the panel', big.maxTitle === 'PLC', String(big.maxTitle))
    check('the PLC editor really rendered into it', big.maxHasEditor)
    check('the floating window stands down (no duplicate mount)', !big.floatingPlc)
    check('every dock slot is gone', big.dockSlots === 0, `${big.dockSlots} slots`)
    check(
      'the panel fills the shell below the toolbar',
      big.max.h > base.viewport.h && big.max.w > base.viewport.w,
      `${base.viewport.w}x${base.viewport.h} -> ${big.max.w}x${big.max.h}`,
    )
    // the key invariant: the viewport is hidden, never unmounted
    check('viewport hidden, not unmounted', big.viewportHidden && big.viewport.h > 0, `h=${big.viewport.h}`)
    check('same canvas element (context survived)', big.canvasTag === 'orig', String(big.canvasTag))
    check('drawing buffer still real', !!big.buffer && big.buffer.w > 0 && big.buffer.h > 0, JSON.stringify(big.buffer))
    check('no uncaptured GPU errors', big.gpuErrors === 0, `${big.gpuErrors}`)
    await page.screenshot({ path: 'e2e/out/panel-maximized-plc.png' })

    // ------------------------------------------------ Esc must not restore while typing
    await page.locator('.dock-maximized .cm-content').click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    check('Esc inside the ST editor does not restore', (await metrics(page)).hasMax)

    // ------------------------------------------------------------ Esc restores
    await page.locator('.dock-maximized-title').click() // focus off the editor
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    const back = await metrics(page)
    check('Esc restores', !back.hasMax)
    check('the floating PLC window comes back (a zoom, not a relocation)', back.floatingPlc)
    check('docks come back', back.dockSlots === base.dockSlots, `${base.dockSlots} -> ${back.dockSlots}`)
    check('viewport visible again, same size', !back.viewportHidden && shellH(back) === shellH(base), `${shellH(base)} -> ${shellH(back)}`)
    check('still the same canvas after the round trip', back.canvasTag === 'orig', String(back.canvasTag))
    check('no GPU errors from the round trip', back.gpuErrors === 0, `${back.gpuErrors}`)

    // -------------------------------- only MAXIMIZABLE_PANELS (= the PLC editor) get a ⛶
    // A side dock is already full height, so maximizing the tree/Inspector would only add width
    // neither uses, and the Parts catalog's wrapping grid is sized for the short, wide bottom
    // dock. A button that produces a bad layout makes people stop trusting it.
    const strips = await page.evaluate(() =>
      [...document.querySelectorAll('.dock-slot')].map((s) => ({
        front: s.querySelector('.dock-slot-tab.active')?.textContent ?? null,
        max: !!s.querySelector('.dock-slot-max-btn'),
        menu: !!s.querySelector('.dock-slot-menu-btn'),
      })),
    )
    check('no dock offers a ⛶ while PLC floats', strips.every((s) => !s.max), JSON.stringify(strips))
    check('every dock still has its ▾ move menu', strips.every((s) => s.menu), JSON.stringify(strips))

    // ------------------------------------------- maximize from a dock tab strip (⛶)
    // dock the PLC editor into the bottom dock; the ⛶ has to follow it there
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('oip-web/dock-layout') || '{}')
      raw.bottom = ['catalog', 'st']
      raw.floating = []
      raw.active = { ...raw.active, bottom: 'catalog' }
      localStorage.setItem('oip-web/dock-layout', JSON.stringify(raw))
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.waitForSelector('.dock-slot-bottom .dock-slot-tab')
    await page.evaluate(() => {
      // the reload built a new canvas; re-stamp so the checks below still mean
      // "React never unmounted the viewport", not "the page never navigated"
      document.querySelector('.viewport canvas').dataset.oipTag = 'orig'
    })
    check(
      'front tab = Parts: still no ⛶ (the button acts on the FRONT tab)',
      (await page.locator('.dock-slot-bottom .dock-slot-max-btn').count()) === 0,
    )
    await page.locator('.dock-slot-bottom .dock-slot-tab', { hasText: 'PLC' }).click()
    await page.waitForTimeout(150)
    check(
      'switching to the PLC tab reveals the ⛶',
      (await page.locator('.dock-slot-bottom .dock-slot-max-btn').count()) === 1,
    )
    // the bottom dock takes the front panel's height (dockLayout's DEFAULT_BOTTOM_HEIGHT; the PLC editor's is
    // taller than Parts'), so ❐ has to restore this layout, not the Parts-in-front one `base` measured
    const plcFront = await metrics(page)
    await page.locator('.dock-slot-bottom .dock-slot-max-btn').click()
    await page.waitForTimeout(200)
    const dockBig = await metrics(page)
    check('dock ⛶ maximizes the front tab', dockBig.hasMax && dockBig.maxTitle === 'PLC', String(dockBig.maxTitle))
    check('dock ⛶: viewport hidden not unmounted', dockBig.viewportHidden && dockBig.canvasTag === 'orig')
    await page.screenshot({ path: 'e2e/out/panel-maximized-docked-plc.png' })

    // ------------------------------------------------------ ❐ restores it again
    await page.locator('[aria-label="Restore panel"]').click()
    await page.waitForTimeout(200)
    const dockBack = await metrics(page)
    check('❐ restores', !dockBack.hasMax && dockBack.dockSlots === base.dockSlots)
    check('bottom dock keeps its height', shellH(dockBack) === shellH(plcFront), `${shellH(plcFront)} -> ${shellH(dockBack)}`)

    // ------------------------------------------------------ not persisted
    await page.locator('.dock-slot-bottom .dock-slot-max-btn').click()
    await page.waitForTimeout(200)
    const stored = await metrics(page)
    check('maximized state is never written to storage', stored.stored === null, String(stored.stored))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.waitForSelector('.dock-slot-bottom .dock-slot-tab')
    const reloaded = await metrics(page)
    check('reloads restored, with a viewport', !reloaded.hasMax && !reloaded.viewportHidden)
    check('reloads with the docks intact', reloaded.dockSlots === base.dockSlots, `${reloaded.dockSlots} slots`)
    check('no GPU errors overall', reloaded.gpuErrors === 0, `${reloaded.gpuErrors}`)

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
  }
}

try {
  await main()
} finally {
  vite.kill()
}
process.exit(failures === 0 ? 0 : 1)
