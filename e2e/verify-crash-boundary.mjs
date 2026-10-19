// Verifies the whole-app crash boundary (src/editor/components/CrashDialog.tsx).
//
// The failure it guards is silent by construction: without the boundary, a throw anywhere in the React
// tree unmounts the editor and leaves an empty #root, with no message, no export, nothing to say the
// document still exists. A blank page is also what a gate sees when the app never booted, so the
// regression could ship green.
//
// The probe corrupts one UI-only field of the store snapshot and notifies React, which is a genuine
// render-phase throw - the class the boundary exists for - and touches no production code path to do
// it. The document is left intact: that is the common crash, and it is the one where the
// dialog's Export must actually produce a file.
//
// Run: node e2e/verify-crash-boundary.mjs
/* global process, console, window, document */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()

let failures = 0
function expect(cond, msg) {
  if (cond) console.log('  ok:', msg)
  else {
    failures++
    console.error('  FAIL:', msg)
  }
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  // React logs the caught error; that is the boundary working, not a test failure
  page.on('pageerror', () => {})
  await page.goto(`http://localhost:${PORT}/app/`)
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller), { timeout: 30000 })

  expect((await page.locator('.crash-backdrop').count()) === 0, 'no crash dialog on a healthy boot')

  await page.evaluate(() => {
    const store = window.__oip.store
    // new object identity so useSyncExternalStore actually re-renders; a UI-only field is corrupted so
    // the render throws while the document stays intact - the common case, and the one where Export must work
    store.state = { ...store.getState(), selectedIds: undefined }
    for (const cb of store.listeners) cb()
  })

  const dialog = page.locator('.crash-backdrop')
  await dialog.waitFor({ state: 'visible', timeout: 10000 })
  expect(true, 'crash dialog replaced the blank page')

  const text = await page.locator('.crash-dialog').innerText()
  expect(/stopped/i.test(text), 'dialog says the editor stopped')
  expect(/not lost/i.test(text), 'dialog tells the author their work survives')
  expect(!text.includes('—'), 'no em dash in the dialog copy (house style)')

  const buttons = await page.locator('.crash-action').allInnerTexts()
  expect(buttons.some((b) => /export/i.test(b)), 'offers Export project')
  expect(buttons.some((b) => /copy/i.test(b)), 'offers Copy details')
  expect(buttons.some((b) => /reload/i.test(b)), 'offers Reload')
  expect(/export/i.test(buttons[0] ?? ''), 'Export leads: get the work out before reloading')

  const report = await page.locator('.crash-report').innerText()
  expect(report.startsWith('OIP Web crash report'), 'the pasteable report is on screen even before Copy')
  expect(/error: /.test(report), 'report names what threw')
  expect(/\bstack:/.test(report), 'report carries a stack')
  expect(/url: http/.test(report), 'report carries the page url')

  // the export path must work off a snapshot, not off the broken view layer
  const download = page.waitForEvent('download', { timeout: 20000 })
  await page.locator('.crash-action.primary').click()
  const file = await download
  expect(/\.oip$/.test(file.suggestedFilename()), `Export produced a project file (${file.suggestedFilename()})`)
  await page.locator('.crash-note').waitFor({ state: 'visible', timeout: 10000 })
  expect(/exported/i.test(await page.locator('.crash-note').innerText()), 'export reports success inline')

  // and the app must come back on reload rather than staying dead
  await page.reload()
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store), { timeout: 30000 })
  expect((await page.locator('.crash-backdrop').count()) === 0, 'reload recovers into a working editor')
  // Wait for the canvas rather than sampling the instant the store exists: the store is published early in boot and
  // the viewport is built after a renderer is chosen, which probes WebGPU and falls back to WebGL first. That probe
  // is unhurried on a real adapter (Dawn reports a D3D12 device failure before the fallback), so the canvas arrives
  // a beat after `__oip.store` does - and this read predates headless having an adapter at all (e2e/_gpuArgs.mjs).
  const canvasBack = await page
    .waitForFunction(() => !!document.querySelector('canvas'), null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false)
  expect(canvasBack, 'the viewport is back after reload')
} finally {
  await browser.close()
  vite.kill()
}

console.log(failures === 0 ? '\nPASS verify-crash-boundary' : `\nFAIL verify-crash-boundary (${failures})`)
process.exit(failures === 0 ? 0 : 1)
