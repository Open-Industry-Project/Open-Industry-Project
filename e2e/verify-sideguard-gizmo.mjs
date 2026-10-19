// Verify guard-openings mode (G) end to end, through real pointer and keyboard input, on a bent belt:
//   - G enters it only with a guarded conveyor selected, shows the banner, and hides the move gizmo
//   - a press on the guard sweeps a new opening from the press to the release, on that wall only
//   - an edge dot resizes, a drag inside slides, a click selects, Delete removes, Ctrl+Z restores
//   - the snap grid steps the values; a grab on the inclined run reads back where the pointer is
//   - Esc backs out one level at a time, and a click away ends the mode with the selection
// Run: node e2e/verify-sideguard-gizmo.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const PKG = 'oip.belt-conveyor'
// a 3 m level run, then a 2 m run climbing 15 degrees
const SEGMENTS = [[3, 0], [2, 15]]
const WIDTH = 1
const GUARD_MID = 0.075 // half the guard height: where the gizmo's wall line runs
const GUARD_OUT = WIDTH / 2 + 0.01

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim), { timeout: 60000 })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && !benign(m.text()) && errors.push(m.text()))
  const fails = []
  const check = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
    if (!ok) fails.push(what)
  }
  const near = (a, b, tol = 0.04) => typeof a === 'number' && Math.abs(a - b) <= tol

  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.evaluate(() => window.localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1800)
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click().catch(() => {})
    await page.waitForFunction((pkg) => !!window.__oip.getPackage?.(pkg), PKG, { timeout: 60000 })

    await page.evaluate(
      ([pkgId, segments, width]) => {
        const st = window.__oip.store
        st.loadScene({
          version: st.getState().scene.version,
          parts: [{ id: 'b1', type: 'part', packageId: pkgId, position: [0, 1, 0], rotationY: 0, params: { segments, width, height: 0.2, guardOpenings: [] } }],
          packages: [window.__oip.getPackage(pkgId)],
        })
      },
      [PKG, SEGMENTS, WIDTH],
    )
    await page.waitForTimeout(600)

    // G with nothing selected: refused, and it says why
    await page.keyboard.press('g')
    await page.waitForTimeout(200)
    check((await page.evaluate(() => window.__oip.store.getState().sideGuardMode)) === false, 'G with nothing selected stays off')
    const hint = await page.evaluate(() => window.__oip.store.getState().viewportHint?.text ?? '')
    check(/conveyor with side guards/.test(hint), `and flashes why (${JSON.stringify(hint)})`)

    await page.evaluate(() => {
      window.__oip.store.select('b1')
      // high and to the +Z side, looking down at the belt: both walls and the incline in view
      window.__oip.view.setCameraPose({ px: 2.5, py: 6.5, pz: 4.5, tx: 2.5, ty: 1, tz: 0 })
    })
    await page.waitForTimeout(700)
    await page.keyboard.press('g')
    await page.waitForTimeout(300)
    check((await page.evaluate(() => window.__oip.store.getState().sideGuardMode)) === true, 'G enters guard-openings mode on the selected belt')
    check(await page.locator('[data-testid="guard-openings-banner"]').isVisible(), 'the banner says so')

    // the right wall's point at tail-relative s. Level run: x = s. Incline: past the 3 m corner, up 15 degrees
    // (the bend's fillet shifts this by millimetres, which the tolerances absorb).
    const onWall = async (s) =>
      page.evaluate(
        ([s, mid, out]) => {
          const a = (15 * Math.PI) / 180
          const x = s <= 3 ? s : 3 + Math.cos(a) * (s - 3) - Math.sin(a) * mid
          const y = s <= 3 ? mid : Math.sin(a) * (s - 3) + Math.cos(a) * mid
          return window.__oip.view.worldToScreen(x, 1 + y, out)
        },
        [s, GUARD_MID, GUARD_OUT],
      )
    const rows = () => page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'b1').params.guardOpenings)
    const selected = () => page.evaluate(() => window.__oip.store.getState().selectedGuardOpening)
    const drag = async (from, to) => {
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 })
      await page.mouse.move(to.x, to.y, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(250)
    }
    const click = async (p) => {
      await page.mouse.move(p.x, p.y)
      await page.mouse.down()
      await page.mouse.up()
      await page.waitForTimeout(200)
    }

    // the wall pick reads the value under the pointer, on the level run and on the incline
    for (const s of [0.8, 4.2]) {
      const p = await onWall(s)
      const hit = await page.evaluate(([x, y]) => window.__oip.view.pickGuardWall(x, y), [p.x, p.y])
      check(hit?.guard === 'right' && near(hit.s, s, 0.05), `the pointer on the right guard at ${s} m reads ${JSON.stringify(hit)}`)
    }
    // the move gizmo is hidden in the mode: nothing to grab at the part origin
    const origin = await page.evaluate(() => window.__oip.view.worldToScreen(0, 1, 0))
    check((await page.evaluate(([x, y]) => window.__oip.view.pickGizmoHandle(x, y), [origin.x, origin.y])) === null, 'the move gizmo is hidden')

    // 1) sweep a new opening along the right guard, 0.8 -> 2.0
    await drag(await onWall(0.8), await onWall(2.0))
    let r = await rows()
    check(r.length === 1 && r[0][2] === 1 && near(r[0][0], 0.8) && near(r[0][1], 2.0), `a sweep cuts [0.8, 2.0] on the right wall: ${JSON.stringify(r)}`)
    check((await selected())?.index === 0, 'and selects it')

    // 2) resize: drag its end dot 2.0 -> 2.5
    const endDot = await onWall(2.0)
    const handle = await page.evaluate(([x, y]) => window.__oip.view.pickResizeHandle(x, y), [endDot.x, endDot.y])
    check(handle?.guard === 'right' && handle.opening === 0 && handle.edge === 'end', `its end dot is pickable: ${JSON.stringify(handle)}`)
    await drag(endDot, await onWall(2.5))
    r = await rows()
    check(r.length === 1 && near(r[0][0], 0.8) && near(r[0][1], 2.5), `the end dot resizes it to [0.8, 2.5]: ${JSON.stringify(r)}`)

    // 3) slide: drag inside it by +0.3
    await drag(await onWall(1.5), await onWall(1.8))
    r = await rows()
    check(r.length === 1 && near(r[0][0], 1.1) && near(r[0][1], 2.8), `a drag inside slides it to [1.1, 2.8]: ${JSON.stringify(r)}`)

    // 4) click on solid guard clears the selection and writes nothing; a click inside selects
    await click(await onWall(4.2))
    check((await selected()) === null && (await rows()).length === 1, 'a click on solid guard clears the selection, writes nothing')
    await click(await onWall(2.0))
    check((await selected())?.index === 0, 'a click inside the opening selects it')

    // 5) Delete removes it (the belt stays); Ctrl+Z restores it
    await page.keyboard.press('Delete')
    await page.waitForTimeout(250)
    check((await rows()).length === 0, 'Delete removes the selected opening')
    check((await page.evaluate(() => window.__oip.store.getState().scene.parts.length)) === 1, 'and never the belt')
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(250)
    check((await rows()).length === 1, 'Ctrl+Z brings it back')

    // 6) the snap grid steps a sweep on the incline
    await page.evaluate(() => window.__oip.store.setGridSnap({ enabled: true, translate: 0.25 }))
    await drag(await onWall(3.33), await onWall(4.41))
    r = await rows()
    const snapped = r[1]
    check(!!snapped && near(snapped[0], 3.25, 0.001) && near(snapped[1], 4.5, 0.001), `with a 0.25 m grid the incline sweep lands on [3.25, 4.5]: ${JSON.stringify(snapped)}`)
    await page.evaluate(() => window.__oip.store.setGridSnap({ enabled: false }))

    // 7) Esc: first the selected opening, then the mode; the belt stays selected
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    let st = await page.evaluate(() => { const s = window.__oip.store.getState(); return { mode: s.sideGuardMode, sel: s.selectedGuardOpening, ids: s.selectedIds } })
    check(st.mode === true && st.sel === null, 'Esc first drops the selected opening')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    st = await page.evaluate(() => { const s = window.__oip.store.getState(); return { mode: s.sideGuardMode, ids: s.selectedIds } })
    check(st.mode === false && st.ids.includes('b1'), 'then leaves the mode, keeping the belt selected')
    check(!(await page.locator('[data-testid="guard-openings-banner"]').isVisible()), 'and the banner goes')

    // 8) a click on empty floor ends the mode along with the selection
    await page.keyboard.press('g')
    await page.waitForTimeout(200)
    check((await page.evaluate(() => window.__oip.store.getState().sideGuardMode)) === true, 'G re-enters the mode')
    // empty floor 2.5 m behind the belt, inside the viewport (a fixed corner pixel would hit the docks instead)
    await click(await page.evaluate(() => window.__oip.view.worldToScreen(2.5, 0, -2.5)))
    st = await page.evaluate(() => { const s = window.__oip.store.getState(); return { mode: s.sideGuardMode, ids: s.selectedIds, editor: s.mode } })
    check(st.mode === false && st.ids.length === 0 && st.editor === 'idle', `clicking away ends the mode with the selection: ${JSON.stringify(st)}`)

    // 9) a neighbour drawn right beside the guard keeps its own clicks: a roller parked 2 cm off the right guard,
    //    clicked on its near guard (well inside the 14 px the wall pick reaches), is selected, not swept into
    await page.evaluate(() => {
      const st = window.__oip.store
      const s = st.getState().scene
      const n1 = { id: 'n1', type: 'part', packageId: 'oip.roller-conveyor', position: [1.5, 1, 1.05], rotationY: 0, params: { length: 3, width: 1, guardOpenings: [] } }
      st.commit('e2e neighbour', { ...s, parts: [...s.parts, n1] })
      st.select('b1')
    })
    await page.waitForTimeout(800)
    await page.keyboard.press('g')
    await page.waitForTimeout(200)
    const rowsBefore = JSON.stringify(await rows())
    const onNeighbour = await page.evaluate(([mid]) => window.__oip.view.worldToScreen(1.5, 1 + mid, 0.56), [GUARD_MID])
    const wallHere = await page.evaluate(([x, y]) => {
      const s = window.__oip.store.getState()
      return { wall: window.__oip.view.pickGuardWall(x, y), mode: s.sideGuardMode, sel: s.selectedIds, ids: s.scene.parts.map((p) => p.id), under: window.__oip.view.pickPartsAt(x, y) }
    }, [onNeighbour.x, onNeighbour.y])
    check(wallHere.wall?.guard === 'right', `the point is within the wall pick's reach (else the step is vacuous): ${JSON.stringify(wallHere)}`)
    await click(onNeighbour)
    st = await page.evaluate(() => ({ ids: window.__oip.store.getState().selectedIds }))
    check(st.ids.length === 1 && st.ids[0] === 'n1', `a click on the neighbour beside the guard selects it: ${JSON.stringify(st)}`)
    check(JSON.stringify(await rows()) === rowsBefore, 'and cuts nothing in the belt')

    console.log(errors.length === 0 ? 'NO ERRORS' : `ERRORS:\n${errors.slice(0, 6).join('\n')}`)
    if (errors.length) fails.push('page errors')
    if (fails.length) {
      console.log(`RESULT FAIL\n - ${fails.join('\n - ')}`)
      process.exitCode = 1
    } else {
      console.log('RESULT PASS - guard-openings mode: sweep, resize, slide, select, delete, snap, exit')
    }
  } finally {
    await browser.close()
    vite.kill()
  }
}

main().catch((e) => {
  console.error('verify-sideguard-gizmo crashed:', e)
  process.exitCode = 2
  vite.kill()
})
