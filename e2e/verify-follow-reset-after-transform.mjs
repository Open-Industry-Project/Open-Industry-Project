/* global console, process, window, localStorage */
// Guard for the consecutive-F run ending when a transform commits.
//
// F on a selection focuses it, a second F starts following it, a third stops. The count belongs to
// the selection, so without a reset, moving the part leaves the run going: F, move the part, F again
// starts following instead of re-focusing on where the part now is. The fix resets
// the count when a transform commits - but only when not following, and that half matters here too: the
// selection-change handler reads the same count to decide whether an active follow retargets to the
// new selection, so a reset that ignored follow mode would quietly turn "follow a part, move it,
// click the next part" into a stop.
//
// Driven through snapSelectedToFloor (PageDown), a real controller transform commit that needs no
// pointer choreography. Each half carries its own control:
//   1. double-F follows in this harness at all (else "not following" below proves nothing);
//   2. F, transform, F -> focused, not following (fails without the reset);
//   3. F, F, transform, select another part -> still following (fails with an unguarded reset).
// Run: node e2e/verify-follow-reset-after-transform.mjs [--headed]
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const HEADED = process.argv.includes('--headed')
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: !HEADED, args: ['--disable-features=CalculateNativeWinOcclusion'] },
    { headless: !HEADED },
  ]) {
    try {
      return await chromium.launch(opts)
    } catch {
      // that channel is not installed here; try the next one
    }
  }
  return null
}

async function main() {
  const browser = await launch()
  if (!browser) { console.log('SKIP: no chromium available'); return }
  const { url, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => {
    try {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    } catch {
      // storage blocked: the tutorial may open, which the checks below do not depend on
    }
  })
  try {
    await page.goto(`${url}`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
    await page.waitForTimeout(1000)

    // two boxes hanging in the air, so snap-to-floor has somewhere to drop each of them
    const loaded = await page.evaluate(() => {
      const { store } = window.__oip
      const box = window.__oip.getPackage('oip.box')
      if (!box) return { error: 'missing package oip.box' }
      const params = { length: 0.4, height: 0.4, width: 0.4 }
      store.loadScene({
        parts: [
          { id: 'boxA', type: 'part', packageId: box.id, position: [0, 2, 0], rotationY: 0, params: { ...params, color: '#00ff00' } },
          { id: 'boxB', type: 'part', packageId: box.id, position: [2, 2, 0], rotationY: 0, params: { ...params, color: '#ff8800' } },
        ],
        packages: [box],
      })
      store.setState({ selectedIds: [] })
      return { ok: true }
    })
    check('scene loaded', !loaded.error, loaded.error || '')
    if (loaded.error) return
    await page.waitForTimeout(800)

    const following = () => page.evaluate(() => window.__oip.view.isFollowing())
    const heightOf = (id) => page.evaluate((id) => window.__oip.store.getState().scene.parts.find((p) => p.id === id).position[1], id)
    const select = async (id) => {
      await page.evaluate((id) => window.__oip.store.select(id), id)
      await page.waitForTimeout(250)
    }
    const pressF = async () => {
      await page.keyboard.press('f')
      await page.waitForTimeout(450) // FOCUS_DURATION is 0.25 s
    }
    const snapToFloor = async () => {
      await page.evaluate(() => window.__oip.controller.snapSelectedToFloor())
      await page.waitForTimeout(250)
    }

    // keyboard focus on the page body, then select programmatically (a click would deselect)
    await page.mouse.click(640, 60)

    // --- 1. control: double-F follows, a third F stops ------------------------
    await select('boxB')
    await pressF()
    check('control: one F focuses without following', (await following()) === false)
    await pressF()
    check('control: a second F follows (so the checks below are not vacuous)', (await following()) === true)
    await pressF()
    check('control: a third F stops following', (await following()) === false)

    // --- 2. F, transform, F: re-focus, not follow ------------------------------
    await select('boxA')
    await pressF()
    const aBefore = await heightOf('boxA')
    await snapToFloor()
    const aAfter = await heightOf('boxA')
    check('the transform really committed (boxA dropped)', aAfter < aBefore - 0.5, `${aBefore.toFixed(2)} -> ${aAfter.toFixed(2)} m`)
    await pressF()
    check('F after moving the part re-focuses instead of starting follow', (await following()) === false)

    // --- 3. follow, transform, select another part: follow survives ------------
    await select('boxB')
    await pressF()
    await pressF()
    check('following boxB', (await following()) === true)
    const bBefore = await heightOf('boxB')
    await snapToFloor()
    const bAfter = await heightOf('boxB')
    check('the transform really committed (boxB dropped)', bAfter < bBefore - 0.5, `${bBefore.toFixed(2)} -> ${bAfter.toFixed(2)} m`)
    check('a transform while following does not stop the follow', (await following()) === true)
    await select('boxA')
    check('selecting another part still retargets the follow (the run was kept)', (await following()) === true)

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
