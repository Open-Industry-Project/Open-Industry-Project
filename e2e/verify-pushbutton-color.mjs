// End-to-end check: the push button's `buttonColor` param tints the cap (unlit base and lit colour).
// Loads the PLC demo and confirms the Start cap is green ('#14b30f', the demo's buttonColor) while Stop
// is black ('#1a1a1a'), retints Stop live via a param edit (Inspector path = store.commit), then presses
// Play and waits for StartLamp (the Start cap's lampTag) to go true before confirming the lit cap
// glows green, not the authored red seed. Wait for the signal, never a fixed sleep: the program controls
// StartLamp, and a lamp rule can correctly stay dark for the first ~17 s of a run.
// Run: node e2e/verify-pushbutton-color.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { cleanShot } from './_shot.mjs'
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

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller && window.__oip.view), { timeout: 20000 })
}

// The cap is the only saturated red/green/blue MeshStandardMaterial under a push button's visual (the GLB
// housing is yellow, its bolts grey, the label a MeshBasicMaterial). Classify every standard material's
// linear albedo by dominant channel and return the strongest hit per family, plus any lit material's
// emissive family (emissiveIntensity > 0), the colour the lamp actually glows.
const capColors = (page, id) => page.evaluate((pid) => {
  const entry = window.__oip.view.entries.get(pid)
  if (!entry) return null
  const out = { red: 0, green: 0, blue: 0, black: false, litFamily: null, litLum: 0, mats: 0 }
  entry.visual.object.traverse((o) => {
    const m = o.material
    if (!m || !m.isMeshStandardMaterial) return
    out.mats++
    const { r, g, b } = m.color
    // saturated single-channel colours only (excludes the yellow housing r≈g and the grey bolts r≈g≈b)
    if (r > 0.2 && g < 0.1 && b < 0.1) out.red = Math.max(out.red, r)
    if (g > 0.2 && r < 0.1 && b < 0.1) out.green = Math.max(out.green, g)
    if (b > 0.2 && r < 0.1 && g < 0.1) out.blue = Math.max(out.blue, b)
    // a black cap: '#1a1a1a' is ~0.01 linear, well under the grey bolts
    if (Math.max(r, g, b) < 0.03) out.black = true
    if (m.emissive && typeof m.emissiveIntensity === 'number' && m.emissiveIntensity > 0) {
      const er = m.emissive.r
      const eg = m.emissive.g
      const eb = m.emissive.b
      const lum = (er + eg + eb) * m.emissiveIntensity
      if (lum > 0.02 && lum > out.litLum) {
        out.litLum = lum
        out.litFamily = eg >= er && eg >= eb ? 'green' : er >= eg && er >= eb ? 'red' : 'blue'
      }
    }
  })
  return out
}, id)

const setButtonColor = (page, id, hex) =>
  page.evaluate(({ pid, value }) => {
    const store = window.__oip.store
    const s = store.getState()
    store.commit('Edit button color', {
      ...s.scene,
      parts: s.scene.parts.map((p) => (p.id === pid ? { ...p, params: { ...p.params, buttonColor: value } } : p)),
    })
  }, { pid: id, value: hex })

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('dialog', (d) => d.accept()) // "Load demo" confirms before replacing the scene

  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.waitForTimeout(1500)
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') })
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1000)

    // 1. Load the demo; find the two buttons
    await clickDemo(page)
    await page.waitForTimeout(400)
    const scene = await page.evaluate(() => window.__oip.store.getState().scene)
    const start = scene.parts.find((p) => p.name === 'Start')
    const stop = scene.parts.find((p) => p.name === 'Stop')
    check('demo scene has Start + Stop push buttons', !!(start && stop))
    check("demo START authors buttonColor '#14b30f'", start?.params?.buttonColor === '#14b30f', `buttonColor=${start?.params?.buttonColor}`)
    // black, not the package's default red: red is kept for the E-stop beside it (IEC 60204-1)
    check("demo STOP authors a black cap '#1a1a1a'", stop?.params?.buttonColor === '#1a1a1a', `buttonColor=${stop?.params?.buttonColor}`)

    // 2. Unlit tints once the GLBs load: Start cap green, Stop cap black
    await page.waitForFunction((pid) => {
      const e = window.__oip.view.entries.get(pid)
      if (!e) return false
      let n = 0
      e.visual.object.traverse((o) => { if (o.material && o.material.isMeshStandardMaterial) n++ })
      return n > 0
    }, start.id, { timeout: 15000 })
    await page.waitForTimeout(500)
    let sc = await capColors(page, start.id)
    let tc = await capColors(page, stop.id)
    check('START cap renders GREEN at rest', sc !== null && sc.green > 0.2 && sc.red === 0, `green=${sc?.green?.toFixed(3)} red=${sc?.red?.toFixed(3)} mats=${sc?.mats}`)
    check('STOP cap renders BLACK at rest', tc !== null && tc.black && tc.red === 0 && tc.green === 0, `black=${tc?.black} red=${tc?.red?.toFixed(3)} green=${tc?.green?.toFixed(3)} mats=${tc?.mats}`)

    // 3. Live retint: edit Stop's buttonColor to blue via the Inspector path (store.commit); the cap
    //    material repaints in place, no rebuild needed
    await setButtonColor(page, stop.id, '#1450b3')
    await page.waitForTimeout(400)
    tc = await capColors(page, stop.id)
    check('editing buttonColor retints the cap live (STOP now BLUE)', tc !== null && tc.blue > 0.2 && tc.red === 0, `blue=${tc?.blue?.toFixed(3)} red=${tc?.red?.toFixed(3)}`)
    await setButtonColor(page, stop.id, '#1a1a1a') // restore the demo's black for the shot
    await page.waitForTimeout(300)

    // 4. Lit colour follows the param: the demo program lights the Start cap through `lampTag: 'StartLamp'`,
    //    and the glow must be green, not the authored red emissive seed.
    //
    //    Wait for the signal, not the clock. StartLamp is steady while the line runs (it flashes only while a
    //    tripped line waits for a Start), and the run lamp under it is `safe`, so it rises on the first scan after Play.
    //    A rule like `safe AND NOT palletFull` is dark through every pallet change and for the first ~17 s of
    //    a run, and a fixed 3 s sleep would sample a cap that is correctly dark and report it as a lamp bug.
    //    Waiting on the tag keeps this check independent of the program's rule.
    await page.locator('button.run-button.play').click()
    await page.waitForFunction(() => window.__oip.store.getState().running === true, { timeout: 6000 })
    const runLampOn = await page
      .waitForFunction(() => window.__oip.sim.plcState?.watch?.StartLamp === true, null, { timeout: 90000, polling: 250 })
      .then(() => true)
      .catch(() => false)
    check('the demo program raises StartLamp (the START cap\'s lampTag)', runLampOn, runLampOn ? '' : 'never true in 90 s - that is the program / its pallet-feed sequence, not the lamp')
    // let the sim frame carrying ctx.lamps reach the material, then read the tag and the cap together:
    // the program can change StartLamp at any time, so a lone stale sample would misreport it.
    await page.evaluate(() => { for (let i = 0; i < 12; i++) window.__oip.controller.tick(0.05) })
    await page.waitForTimeout(500)
    const stillOn = await page.evaluate(() => window.__oip.sim.plcState?.watch?.StartLamp === true)
    sc = await capColors(page, start.id)
    check('LIT START cap glows GREEN (lit colour follows buttonColor)', sc !== null && sc.litFamily === 'green' && sc.litLum > 0.05, `litFamily=${sc?.litFamily} litLum=${sc?.litLum?.toFixed(3)} StartLamp=${stillOn}`)

    // close-up of the operator station for the record (cleanShot - scene content only, overlays hidden).
    // Set the orbit controls' target too, or they restore their own framing over a bare lookAt.
    await page.evaluate(() => {
      const v = window.__oip.view
      v.camera.position.set(-1.45, 1.1, 2.1)
      v.controls.target.set(-1.45, 0.8, 0.84)
      v.camera.lookAt(-1.45, 0.8, 0.84)
      v.controls.update()
    })
    await page.waitForTimeout(400)
    await cleanShot(page, join(import.meta.dirname, 'shots', 'pushbutton-color.png'))

    const pageErrs = errors.filter((e) => !/favicon|manifest|GLTFLoader.*texture|Couldn't load texture/i.test(e))
    check('no uncaught page errors', pageErrs.length === 0, pageErrs.slice(0, 3).join(' | '))

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
