// Shadow quality is a per-client preference, not scene data.
//
// As a param on the Building part, a shared scene (or any peer in a collab room) would dictate how
// much shadow memory every other viewer allocates, and changing it resizes a live shadow map, which
// blacks out the WebGPU bundled pass (docs/three-coupling.md). It lives in localStorage and is
// read once at boot by src/render/quality.ts.
//
// The viewport toolbar has no control for it: a setting that only takes effect on the next load does
// not belong among the toolbar's instant toggles (the Settings dialog has it; see verify-settings.mjs).
//
// This gate checks four things: the param is not in the Inspector, no Graphics gear is on the
// toolbar, a stored preference is honoured at boot, and ?shadow= overrides it for one load without
// overwriting what the user stored.
// Run: node e2e/verify-shadow-quality-pref.mjs [--headed]
/* global process, console, window, document, localStorage */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

const SCENE = JSON.stringify({
  version: 4,
  parts: [{ id: 'bld_1', type: 'building', position: [0, 0, 0], rotationY: 0, params: {} }],
})

// Read the main key light's shadow map: the shadow-casting directional whose shadow camera sees the
// default layer 0. With the building walls' light baked it is the only shadow caster, but the layer
// test keeps this reading the scene's key light if a layer-scoped caster is ever added.
const keyShadowSize = () => {
  const view = window.__oip?.view
  if (!view) return null
  let size = null
  view.scene.traverse((o) => {
    if (o.isDirectionalLight && o.castShadow && o.shadow.camera.layers.isEnabled(0)) size = o.shadow.mapSize.x
  })
  return size
}

const browser = await chromium.launch({ headless: !HEADED })
const { port, vite } = await startServer()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
try {
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ } })
  await page.goto(`http://localhost:${port}/app/`)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.loadSceneText), { timeout: 30000 })

  // ---- 1. the building's Inspector shows its authored lighting, and no resolution setting ----
  await page.evaluate((text) => window.__oip.loadSceneText(text), SCENE)
  await page.waitForTimeout(600)
  await page.evaluate(() => window.__oip.store.selectMany(['bld_1']))
  await page.waitForTimeout(500)
  // Lighting is a collapsible Inspector group; open it if the params aren't showing
  if (!/Brightness/i.test(await page.evaluate(() => document.body.innerText))) {
    await page.getByText('Lighting', { exact: true }).first().click().catch(() => {})
    await page.waitForTimeout(300)
  }
  const insp = await page.evaluate(() => document.body.innerText)
  // guards the next check: if the Lighting group never opened, "no Shadow quality" would be vacuous
  check('the building Inspector still shows its authored lighting params', /Brightness/i.test(insp) && /Background Color/i.test(insp),
    `Brightness=${/Brightness/i.test(insp)} BackgroundColor=${/Background Color/i.test(insp)} - the group may not have opened`)
  check('the building Inspector no longer offers Shadow quality', !/Shadow quality/i.test(insp))

  // ---- 2. no Graphics gear on the viewport toolbar ----
  check('no Graphics gear on the viewport toolbar', (await page.locator('[data-graphics-gear]').count()) === 0)
  // titles, not innerText: these buttons are icon-only, so innerText is '' and the check would pass
  // vacuously. `titles` non-empty also shows we read a real, populated toolbar.
  const titles = await page.evaluate(() =>
    [...document.querySelectorAll('.viewport-toolbar button')].map((b) => b.getAttribute('title') ?? ''))
  check('the toolbar rendered its buttons (guards the next check)', titles.length > 10, `${titles.length} buttons`)
  check('and no remaining toolbar button offers shadow quality', !titles.some((t) => /shadow/i.test(t)),
    titles.filter((t) => /shadow/i.test(t)).join(' | '))

  // ---- 3. a stored preference is still honoured at boot (resolution resolves once, on load) ----
  await page.evaluate(() => localStorage.setItem('oip-web/shadowquality', 'high'))
  await page.reload()
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 30000 })
  await page.waitForTimeout(1500)
  check('the key light allocates a 4096 shadow map', (await page.evaluate(keyShadowSize)) === 4096,
    `mapSize.x = ${await page.evaluate(keyShadowSize)}`)

  // ---- 4. ?shadow= takes precedence for one load, without overwriting the stored value ----
  await page.goto(`http://localhost:${port}/app/?shadow=low`)
  await page.waitForFunction(() => !!window.__oip?.view, { timeout: 30000 })
  await page.waitForTimeout(1500)
  const forced = await page.evaluate(keyShadowSize)
  check('?shadow=low overrides the stored 4k for that load', forced === 1024, `mapSize.x = ${forced}`)
  const kept = await page.evaluate(() => localStorage.getItem('oip-web/shadowquality'))
  check('the URL override leaves the stored preference alone', kept === 'high', `localStorage = ${kept}`)
} finally {
  await page.close().catch(() => {})
  await browser.close().catch(() => {})
  vite.kill()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
