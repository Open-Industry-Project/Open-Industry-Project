// Verify scene annotations end to end: a note placed in the scene draws a chip over the viewport at the
// right spot, tracks the camera, rides its parent when that part is moved, and can be turned off.
//
// The unit tests own the culling/fade arithmetic. What only a browser can prove is the half around it: that
// the chip is actually mounted and positioned from a live projection, that clicking it selects the note (the
// chip is the hit target; there is nothing in the 3-D scene to click), and above all that parenting makes it
// follow. That is the reason to prefer a parented note over a fixed coordinate, and it depends on
// soft-parenting carrying a subtree through a drag, which this feature uses but does not own.
//
// Run: node e2e/verify-annotations.mjs [--headed]
/* global process, console, window, localStorage, document */
import { startServer } from './_server.mjs'
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

/** Where a chip is on screen, and what it says. */
const chipRect = (page, id) => page.evaluate((noteId) => {
  const el = document.querySelector(`.note-chip[data-note-id="${noteId}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.textContent, opacity: Number(getComputedStyle(el).opacity) }
}, id)

/** Where the note's world position projects to right now - the chip must agree with it. */
const projectOf = (page, id) => page.evaluate((noteId) => {
  const note = window.__oip.store.getState().scene.parts.find((p) => p.id === noteId)
  if (!note) return null
  return window.__oip.view.worldToScreen(note.position[0], note.position[1], note.position[2])
}, id)

/** The demo scene carries a note, so a plain boot of it is enough to catch a chip drawn over the cover. */
async function checkCoverBoot(browser) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    // Watch from the first paint. The bug this guards: a chip painting over the loading cover while the app
    // boots, from a fixed-position layer whose z-index competes at the page root, where the cover's (scoped
    // inside the viewport) can never outrank it. Polling afterwards would miss it: by then the cover is gone
    // and the chip is legitimately visible. So sample continuously from load and record the worst case.
    await page.addInitScript(() => {
      window.__coverViolation = null
      const tick = () => {
        const cover = document.querySelector('.viewport-cover')
        const chip = document.querySelector('.note-chip')
        // A cover that has not gone `ready` is still covering. The bug is a chip painting over it, which is a
        // question of stacking, not of existence. The reveal signal is capped at 4 s (render/renderReady.ts), so on
        // any load longer than that (every demo) chips legitimately exist while the cover is still up, and stay
        // underneath it (styles.css: .note-layer 4, the cover 7). Asserting mere presence would fail whenever the
        // notes exist before the cover lifts, without testing the stacking at all.
        if (cover && !cover.classList.contains('ready') && chip) {
          const zOf = (el) => {
            for (let n = el; n && n !== document.body; n = n.parentElement) {
              const z = Number.parseInt(getComputedStyle(n).zIndex, 10)
              if (Number.isFinite(z)) return z
            }
            return 0
          }
          if (zOf(chip) >= zOf(cover)) window.__coverViolation = window.__coverViolation ?? `${chip.textContent} (z ${zOf(chip)} >= cover ${zOf(cover)})`
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await page.goto(`${URL}?scene=demo`, { waitUntil: 'domcontentloaded' })
    // `view` exists only once a renderer has been built, so this wait is load-sized too, matching the 240 s
    // below. A shorter one fires where the load is slowest (software GL, OIP_E2E_SOFTWARE_GL=1) and kills the
    // script after every annotation check has already passed.
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.view), { timeout: 120000 })
    // A load-sized budget, polled on a timer rather than rAF: this is the script's second demo page, and
    // one demo load alone measures ~60 s here. 120 s with rAF polling times out after every check above
    // has passed, a red result that says nothing about annotations.
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 240000, polling: 250 })
    await page.waitForTimeout(1500)
    const violation = await page.evaluate(() => window.__coverViolation)
    check('no chip is drawn over the loading cover', violation === null, violation ? `saw ${JSON.stringify(violation)}` : '')
    // ...and the demo's own note is there once the cover has lifted, so the gate above cannot pass by
    // the overlay simply never rendering
    const after = await page.evaluate(() => document.querySelectorAll('.note-chip').length)
    check('...and the demo note appears once it has', after >= 1, `chips=${after}`)

    // An open part scene hides every other part (focusViewScene), and a note's chip must follow what the
    // viewport draws: gone outside the focused part, kept when the note hangs off it.
    const chipIds = () => page.evaluate(() => [...document.querySelectorAll('.note-chip')].map((e) => e.dataset.noteId).sort().join(','))
    const { host, hosted, other } = await page.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts
      const byId = new Map(parts.map((p) => [p.id, p]))
      const notes = parts.filter((p) => p.type === 'annotation' && p.parent)
      const holdsNote = (id) => notes.some((n) => { for (let c = n.parent; c; c = byId.get(c)?.parent) if (c === id) return true; return false })
      const host = notes[0]?.parent
      return { host, hosted: notes.filter((n) => n.parent === host).map((n) => n.id), other: parts.find((p) => p.type === 'part' && !holdsNote(p.id))?.id }
    })
    const all = await chipIds()
    await page.evaluate((id) => window.__oip.controller.openPartScene(id), other)
    await page.waitForTimeout(300)
    check('a part scene hides the notes outside it', other !== undefined && (await chipIds()) === '', `focused ${other}`)
    await page.evaluate(() => window.__oip.store.exitPartFocus())
    await page.evaluate((id) => window.__oip.controller.openPartScene(id), host)
    await page.waitForTimeout(300)
    const kept = await chipIds()
    check('...and keeps a note parented to the focused part', host !== undefined && hosted.every((id) => kept.split(',').includes(id)), `focused ${host}: ${kept}`)
    await page.evaluate(() => window.__oip.store.exitPartFocus())
    await page.waitForTimeout(300)
    check('...and leaving it brings every note back', (await chipIds()) === all, all)
  } finally {
    await page.close()
  }
}
async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.evaluate(() => {
      localStorage.clear()
      localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)

    // A conveyor with a note parented to it, plus a second free-standing note.
    const setup = await page.evaluate(() => {
      const { store, getPackage } = window.__oip
      const pkg = getPackage('oip.belt-conveyor')
      if (!pkg) return { ok: false, reason: 'oip.belt-conveyor not registered' }
      const params = {}
      for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
      store.loadScene({
        version: store.getState().scene.version,
        parts: [
          { id: 'conv1', type: 'part', packageId: 'oip.belt-conveyor', position: [0, 0, 0], rotationY: 0, name: 'Line 1', params },
          { id: 'note_1', type: 'annotation', position: [1, 1.2, 0], rotationY: 0, name: 'Note', parent: 'conv1', params: { text: 'Colour sort here', icon: 'info' } },
          { id: 'note_2', type: 'annotation', position: [6, 1.2, 4], rotationY: 0, name: 'Note', params: { text: 'Free standing', icon: 'warning' } },
        ],
        packages: [pkg],
      })
      return { ok: store.getState().scene.parts.filter((p) => p.type === 'annotation').length === 2 }
    })
    check('scene with two annotations loaded', setup.ok, setup.reason || '')
    if (!setup.ok) return
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 90000 })
    // Chips mount only once the loading cover has faded (AnnotationOverlay waits on whenCoverHidden), and settled
    // assets are not that: the cover still has its fade to run. A fixed short wait can land mid-fade and read
    // "no chip" for a note that appears a second later.
    await page.waitForFunction(() => !!document.querySelector('.note-chip'), null, { timeout: 30000, polling: 100 }).catch(() => {})

    // frame both notes
    await page.evaluate(() => {
      const { view } = window.__oip
      view.controls?.target?.set(3, 1, 2)
      view.camera.position.set(3, 6, 12)
      view.camera.lookAt(3, 1, 2)
      view.controls?.update?.()
    })
    await page.waitForTimeout(500)

    // ── 1. the chips exist, say the right thing, and sit where the projection says ──
    const c1 = await chipRect(page, 'note_1')
    check('the parented note drew a chip', !!c1, c1 ? c1.text : 'no chip')
    if (!c1) return
    check('...with the authored text and its icon', /Colour sort here/.test(c1.text) && /ℹ/.test(c1.text), JSON.stringify(c1.text))
    const p1 = await projectOf(page, 'note_1')
    // the chip hangs above its point (bottom-centre anchored), so x must match and y must sit above it
    check('the chip is horizontally centred on its world point', Math.abs(c1.x - p1.x) < 3, `chip=${c1.x.toFixed(1)} point=${p1.x.toFixed(1)}`)
    check('...and hangs above it, so the labelled thing is not covered', c1.y < p1.y, `chip=${c1.y.toFixed(1)} point=${p1.y.toFixed(1)}`)
    check('the second note drew its own chip', !!(await chipRect(page, 'note_2')))

    // ── 2. it tracks the camera ──
    await page.evaluate(() => {
      const { view } = window.__oip
      view.camera.position.set(-4, 5, 10)
      view.camera.lookAt(3, 1, 2)
      view.controls?.update?.()
    })
    await page.waitForTimeout(400)
    const moved = await chipRect(page, 'note_1')
    const movedP = await projectOf(page, 'note_1')
    check('the chip followed the camera', Math.abs(moved.x - c1.x) > 20, `${c1.x.toFixed(0)} -> ${moved.x.toFixed(0)}`)
    check('...and still agrees with the live projection', Math.abs(moved.x - movedP.x) < 3, `chip=${moved.x.toFixed(1)} point=${movedP.x.toFixed(1)}`)

    // ── 3. clicking the chip selects the note (the chip is the hit target) ──
    await page.locator('.note-chip[data-note-id="note_1"]').click()
    await page.waitForTimeout(200)
    const sel = await page.evaluate(() => window.__oip.store.getState().selectedIds)
    check('clicking the chip selects the annotation', sel.length === 1 && sel[0] === 'note_1', JSON.stringify(sel))

    // ── 3b. a middle drag that starts on a chip still moves the camera: only the left button is the chip's ──
    const poseBefore = await page.evaluate(() => window.__oip.view.cameraPose())
    const at = await chipRect(page, 'note_1')
    await page.mouse.move(at.x, at.y)
    await page.mouse.down({ button: 'middle' })
    for (let i = 1; i <= 10; i++) await page.mouse.move(at.x + i * 12, at.y + i * 6)
    await page.mouse.up({ button: 'middle' })
    await page.waitForTimeout(300)
    const poseAfter = await page.evaluate(() => window.__oip.view.cameraPose())
    const poseMoved = Math.hypot(poseAfter.px - poseBefore.px, poseAfter.py - poseBefore.py, poseAfter.pz - poseBefore.pz)
    check('a middle drag starting on a chip moves the camera', poseMoved > 0.05, `moved ${poseMoved.toFixed(3)}`)

    // ── 4. the chip re-projects when the note moves (the overlay half of "a note follows its machine";
    //      that a parent drag carries the note at all is subtreeIds' job, pinned in the unit test) ──
    const beforeMove = await chipRect(page, 'note_2')
    await page.evaluate(() => {
      const { store } = window.__oip
      const s = store.getState()
      const note = s.scene.parts.find((p) => p.id === 'note_2')
      store.loadScene({
        ...s.scene,
        parts: s.scene.parts.map((p) => (p.id === 'note_2' ? { ...note, position: [note.position[0] - 3, note.position[1], note.position[2]] } : p)),
      })
    })
    await page.waitForTimeout(400)
    const afterMove = await chipRect(page, 'note_2')
    const afterP = await projectOf(page, 'note_2')
    check('moving a note moves its chip', !!afterMove && Math.abs(afterMove.x - beforeMove.x) > 20, `${beforeMove.x.toFixed(0)} -> ${afterMove ? afterMove.x.toFixed(0) : 'gone'}`)
    check('...to wherever the new world point projects', Math.abs(afterMove.x - afterP.x) < 3, `chip=${afterMove.x.toFixed(1)} point=${afterP.x.toFixed(1)}`)

    // ── 5. distance culls, so a big layout doesn't become confetti ──
    await page.evaluate(() => {
      const { view } = window.__oip
      view.camera.position.set(3, 40, 90)
      view.camera.lookAt(3, 1, 2)
      view.controls?.update?.()
    })
    await page.waitForTimeout(400)
    check('a far-away note is culled entirely', (await chipRect(page, 'note_2')) === null)

    // ── 6. the View toggle ──
    await page.evaluate(() => {
      const { view } = window.__oip
      view.camera.position.set(3, 6, 12)
      view.camera.lookAt(3, 1, 2)
      view.controls?.update?.()
    })
    await page.waitForTimeout(400)
    check('back in close, the chip is drawn again', !!(await chipRect(page, 'note_2')))
    await page.evaluate(() => window.__oip.store.toggleShowNotes())
    await page.waitForTimeout(300)
    const off = await page.evaluate(() => document.querySelectorAll('.note-chip').length)
    check('Show Annotations off removes every chip', off === 0, `chips=${off}`)
    await page.evaluate(() => window.__oip.store.toggleShowNotes())
    await page.waitForTimeout(300)
    check('...and back on restores them', (await page.evaluate(() => document.querySelectorAll('.note-chip').length)) === 2)

    // ── 7. placement from the catalog: the preview, and where it lands ──
    // Neither is visible to a unit test. The preview needs the overlay to read the scene from the store
    // rather than from React props, because a staged placement is a transient that does not re-render the
    // chrome; read through props, the preview shows nothing.
    // The height needs the zero-footprint hover, or a note rests flat on the floor it was dropped over.
    await page.evaluate(() => window.__oip.store.loadScene({ version: window.__oip.store.getState().scene.version, parts: [] }))
    await page.waitForTimeout(300)
    await page.locator('.catalog-tab', { hasText: 'Structure' }).first().click()
    await page.waitForTimeout(300)
    const card = page.locator('.catalog-card[data-part-type="annotation"]')
    check('the catalog offers an Annotation card', (await card.count()) === 1)
    await card.click()
    await page.waitForTimeout(300)
    const vp = await page.locator('.viewport').boundingBox()
    await page.mouse.move(vp.x + vp.width / 2, vp.y + vp.height / 2)
    await page.waitForTimeout(300)
    const previewAt = (sel) => page.evaluate(() => { const el = document.querySelector('.note-chip'); return el ? Math.round(el.getBoundingClientRect().left) : null })
    const preview1 = await previewAt()
    check('a chip PREVIEWS while placing, before the drop', preview1 !== null, `left=${preview1}`)
    await page.mouse.move(vp.x + vp.width / 2 + 60, vp.y + vp.height / 2 + 20)
    await page.waitForTimeout(300)
    const preview2 = await previewAt()
    check('...and follows the pointer', preview2 !== null && Math.abs(preview2 - preview1) > 20, `${preview1} -> ${preview2}`)
    await page.mouse.click(vp.x + vp.width / 2 + 60, vp.y + vp.height / 2 + 20)
    await page.waitForTimeout(400)
    const dropped = await page.evaluate(() => { const n = window.__oip.store.getState().scene.parts.find((p) => p.type === 'annotation'); return n ? n.position.map((v) => +v.toFixed(2)) : null })
    check('it lands at chest height above the floor, not face-down on it', !!dropped && Math.abs(dropped[1] - 1.2) < 0.01, JSON.stringify(dropped))
    // ── 8. live PLC readout: a note bound to a tag shows the running program's value ──
    // The reason this is a browser test and not a unit test: the value has to travel program -> worker
    // -> frame -> plcGlobalTags -> the chip, and the blank-vs-zero rule is only meaningful at the end of
    // that chain. A note wired to a tag with nothing running must read `--`, not a confident 0 that looks
    // exactly like a stopped line.
    await page.evaluate(() => {
      const { store } = window.__oip
      store.loadScene({
        version: store.getState().scene.version,
        parts: [
          { id: 'note_9', type: 'annotation', position: [0, 1.2, 0], rotationY: 0, name: 'Rate',
            params: { text: 'Infeed', icon: 'count', tag: 'Rate', unit: '/min', decimals: 1 } },
        ],
      })
    })
    await page.waitForTimeout(300)
    // Frame the note through setCameraPose, which writes the rig and the orbit target together.
    // `camera.lookAt()` + `controls.update()` does not: update() re-derives the orientation from the
    // controls' target, which section 5 leaves at (3,1,2) while testing distance culling. The note at
    // the origin would then project off-screen (visible:false), no chip renders, and every readout
    // below reads null with the PLC chain working fine.
    await page.evaluate(() => {
      window.__oip.view.setCameraPose({ px: 0, py: 2, pz: 6, tx: 0, ty: 1.2, tz: 0 }, { instant: true })
    })
    await page.waitForTimeout(400)
    const readout = () => page.evaluate(() => document.querySelector('.note-chip-value')?.textContent ?? null)
    check('a bound tag with nothing running reads BLANK, not 0', (await readout()) === '--', JSON.stringify(await readout()))

    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => window.__oip.store.getState().running === true, { timeout: 15000 })
    await page.evaluate(() => window.__oip.controller.runProgram(['VAR_OUTPUT Rate : REAL; END_VAR', 'Rate := 17.25;'].join('\n')))
    await page.waitForTimeout(1200)
    check('a running program drives the note', (await readout()) === '17.3 /min', JSON.stringify(await readout()))

    await page.evaluate(() => window.__oip.controller.runProgram(['VAR_OUTPUT Rate : REAL; END_VAR', 'Rate := 42.0;'].join('\n')))
    await page.waitForTimeout(1200)
    check('...and the readout tracks it live', (await readout()) === '42.0 /min', JSON.stringify(await readout()))

    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForFunction(() => window.__oip.store.getState().running === false, { timeout: 10000 })
    await page.waitForTimeout(600)
    check('Stop returns it to blank - no stale number left on the layout', (await readout()) === '--', JSON.stringify(await readout()))

    // a note that binds no tag shows no value slot at all - a blank readout always means "bound to nothing"
    await page.evaluate(() => {
      const { store } = window.__oip
      const s = store.getState()
      store.loadScene({ ...s.scene, parts: s.scene.parts.map((p) => (p.id === 'note_9' ? { ...p, params: { ...p.params, tag: '' } } : p)) })
    })
    await page.waitForTimeout(400)
    check('a note with no tag shows no value slot', (await readout()) === null && (await page.evaluate(() => document.querySelectorAll('.note-chip').length)) === 1)
    await page.screenshot({ path: '.scratch/annotations.png' })

    // ── 9. boot: nothing over the loading cover ──
    await checkCoverBoot(browser)
  } finally {
    await browser.close()
  }
}

try {
  await main()
} finally {
  vite.kill()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
