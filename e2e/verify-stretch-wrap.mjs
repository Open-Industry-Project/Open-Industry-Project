// Every finished load leaves the demo cell stretch-wrapped. That is a claim about what is drawn, which the unit
// tests (src/sim/stretchWrapper.test.ts, src/core/cargoWrap.test.ts) cannot see. The film is a translucent band the
// renderer places off the pallet's pose each frame (render/viewport/wrapFilm.ts), so a frame can carry a wrap the
// view never draws, or the view can draw it somewhere the load is not.
//
// Checks, in the real editor on the demo:
//   - stopped: every wrapped unit load (the rack stock, the dock lanes) shows a band, before anything has run;
//   - running: the first finished load stops under the wrapper's arm, gets a band that grows up it while the arm
//     turns, with a web of film drawn from the carriage's roll to the load, and carries that band on down the
//     outfeed once the wrapper lets it go (the web gone with the arm parked);
//   - the view draws exactly as many bands as the frame carries wraps, each one standing on its load.
// Shots of the wrap in progress and the racks land in e2e/shots/stretch-wrap-*.png.
//   node e2e/verify-stretch-wrap.mjs
/* global process, console, window */
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { clickDemo } from './_demo.mjs'
import { cleanShot } from './_shot.mjs'

const { port: PORT, vite } = await startServer()
const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`) }

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.sim && window.__oip.view), { timeout: 30000 })
}

/** bands the view is drawing, and the wraps the frame it drew from carried (with each anchor's position) */
const filmState = (page) => page.evaluate(() => {
  const film = window.__oip.view.boxes?.dressing
  const f = window.__lastFrame
  const wraps = (f?.dressings ?? []).map((w) => {
    const i = Array.from(f.ids).indexOf(w.anchor)
    return { top: w.max[1], x: f.positions[i * 3], y: f.positions[i * 3 + 1], z: f.positions[i * 3 + 2] }
  })
  const c = film ? film.counts() : { dressings: -1, webs: -1 }
  return { drawn: c.dressings, webs: c.webs, wrapWebs: (f?.dressings ?? []).filter((w) => w.web).length, wraps }
})

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().split('\n')[0]))
  page.on('dialog', (d) => d.accept())
  try {
    await page.goto(`http://localhost:${PORT}/app/`); await waitForApp(page)
    await page.evaluate(() => localStorage.clear())
    await page.reload(); await waitForApp(page)
    const tut = page.locator('.tut-close')
    if (await tut.count()) await tut.first().click()
    await clickDemo(page)
    await page.waitForFunction(() => window.__oip.assetsBusy && window.__oip.assetsBusy() === false, { timeout: 120000 })

    // stopped: the racked stock is already wrapped
    const wrapper = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.packageId === 'oip.stretch-wrapper'))
    check('the demo has a stretch wrapper on the outfeed', !!wrapper, wrapper ? `at ${wrapper.position.map((v) => v.toFixed(2)).join(',')}` : 'none')
    const idle = await page.evaluate(() => window.__oip.view.boxes.dressing.counts().dressings)
    const wrappedLoads = await page.evaluate(() => window.__oip.store.getState().scene.parts
      .filter((p) => p.packageId === 'oip.unit-load' && p.params.wrapped === true).length)
    check('stopped, every wrapped unit load draws a band of film', wrappedLoads > 6 && idle === wrappedLoads, `${idle} bands / ${wrappedLoads} wrapped loads`)
    await page.evaluate(() => window.__oip.view.setCameraPose({ px: 17, py: 3.6, pz: 6.2, tx: 16.8, ty: 2.1, tz: 1.3 }, { instant: true }))
    await page.waitForTimeout(800)
    await cleanShot(page, 'e2e/shots/stretch-wrap-racks-idle.png')

    // running: watch the first built load through the wrapper
    await page.evaluate(() => {
      const sim = window.__oip.sim, prior = sim.onFrame
      sim.onFrame = (f) => { prior(f); window.__lastFrame = f }
    })
    await page.evaluate(() => window.__oip.controller.run())
    const [wx, , wz] = wrapper.position
    const atStation = (w) => Math.abs(w.x - wx) < 0.5 && Math.abs(w.z - wz) < 0.5
    // the opening load: stopped on the station eye, then wrapped while the arm turns
    let partial = null
    let full = null
    let webSeen = null
    const t0 = Date.now()
    while (Date.now() - t0 < 180000) {
      const s = await filmState(page)
      const here = s.wraps.find(atStation)
      if (here && !webSeen && s.webs > 0) webSeen = s
      if (here && !partial && here.top < 1.0 && s.webs > 0) {
        partial = { ...s, here }
        await page.evaluate(([x, z]) => window.__oip.view.setCameraPose({ px: x + 3.2, py: 3.0, pz: z + 3.4, tx: x, ty: 1.6, tz: z }, { instant: true }), [wx, wz])
        await page.waitForTimeout(400)
        await cleanShot(page, 'e2e/shots/stretch-wrap-in-progress.png')
      }
      if (here && here.top > 1.2) { full = { ...s, here }; break }
      await page.waitForTimeout(250)
    }
    check('the first load gets film under the arm, partway up before it is all the way up', !!partial && !!full,
      partial && full ? `band top ${partial.here.top.toFixed(2)} -> ${full.here.top.toFixed(2)} m` : `partial ${!!partial}, full ${!!full}`)
    if (full) check('...and the view draws one band per wrap the frame carries', full.drawn === full.wraps.length, `${full.drawn} drawn / ${full.wraps.length} wraps`)
    check('while it wraps, a web of film runs from the roll to the load, one per web the frame carries', !!webSeen && webSeen.webs === webSeen.wrapWebs,
      webSeen ? `${webSeen.webs} drawn / ${webSeen.wrapWebs} in the frame` : 'no web drawn')
    await cleanShot(page, 'e2e/shots/stretch-wrap-done.png')

    // it leaves with its film: the wrapped load, found again down the outfeed or on the turntable, still wrapped
    let away = null
    const t1 = Date.now()
    while (Date.now() - t1 < 120000) {
      const s = await filmState(page)
      away = s.wraps.find((w) => w.top > 1.2 && Math.abs(w.x - wx) < 1.5 && w.z < wz - 1.5)
      if (away) break
      await page.waitForTimeout(250)
    }
    check('the wrapped load carries its film on down the line', !!away, away ? `band now at z ${away.z.toFixed(2)}` : 'not seen past the station')
    const after = await filmState(page)
    check('...and with the arm parked no web is drawn', after.webs === after.wrapWebs && after.wrapWebs === 0, `${after.webs} drawn`)
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch((e) => { console.error(e); process.exitCode = 1; vite.kill() })
