// Verify the face engine end-to-end: (1) a generic box dragged near another box ends up flush against its
// face (the no-declared-snap fallback); (2) a push button dragged near a rack face-mounts onto it and
// attaches (soft-parents under the host, one undo entry with the pose); (3) moving the host carries the
// attached button; undo unwinds the carry and then the attachment. Run: node e2e/verify-face-snap.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim && window.__oip.controller), { timeout: 20000 })
}

let failed = false
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed = true
}

async function worldToScreen(page, x, y, z) {
  return page.evaluate(([wx, wy, wz]) => {
    const v = window.__oip.view
    const cam = v.camera
    cam.updateMatrixWorld(true)
    const p = cam.position.clone().set(wx, wy, wz).project(cam)
    const rect = v.renderer.domElement.getBoundingClientRect()
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height, inside: p.z < 1 && Math.abs(p.x) < 0.95 && Math.abs(p.y) < 0.95 }
  }, [x, y, z])
}

/** Shift+G reposition part `id`: select it, hover at (wx, wy, wz) (wy 0 = a floor point), start the
 *  gesture, settle, click to commit. Returns the engaged candidate plus which part the gesture actually
 *  steered and whether it truly closed - so a phase can assert its own preconditions instead of
 *  inheriting a broken one. */
async function reposition(page, id, wx, wz, wy = 0) {
  await page.evaluate((pid) => window.__oip.store.select(pid), id)
  const at = await worldToScreen(page, wx, wy, wz)
  if (!at.inside) return { ok: false, why: 'offscreen' }
  await page.mouse.move(at.x, at.y, { steps: 4 })
  await page.waitForTimeout(80)
  // Pointer-event delivery guard: DOM overlays (floating PLC editor, HUD chips) can cover parts of the
  // canvas and eat the steering events. If the controller's lastPointer lags the intended point, make
  // whatever covers it click-through (visuals kept) and retry once.
  const delivered = async () => {
    const lp = await page.evaluate(() => window.__oip.controller.lastPointer)
    return lp && Math.abs(lp.x - at.x) <= 2 && Math.abs(lp.y - at.y) <= 2 ? null : lp
  }
  let lag = await delivered()
  if (lag) {
    await page.evaluate(([px, py]) => {
      const canvas = window.__oip.view.renderer.domElement
      for (let i = 0; i < 8; i++) {
        const el = document.elementFromPoint(px, py)
        if (!el || el === canvas || canvas.contains(el) || el.contains(canvas)) break
        el.style.pointerEvents = 'none'
      }
    }, [at.x, at.y])
    await page.mouse.move(at.x - 5, at.y, { steps: 2 })
    await page.mouse.move(at.x, at.y, { steps: 2 })
    await page.waitForTimeout(80)
    lag = await delivered()
    if (lag) return { ok: false, why: `moves not reaching canvas (lastPointer ${lag.x.toFixed(0)},${lag.y.toFixed(0)} vs ${at.x.toFixed(0)},${at.y.toFixed(0)})` }
  }
  await page.keyboard.down('Shift')
  await page.keyboard.press('g')
  await page.keyboard.up('Shift')
  await page.waitForTimeout(120)
  const started = await page.evaluate(() => window.__oip.controller.reposition?.id ?? null)
  if (started === null) return { ok: false, why: 'gesture did not start' }
  if (started !== id) return { ok: false, why: `steering ${started}, wanted ${id}` }
  // small settle wiggle so the live snap evaluates at the final cursor
  await page.mouse.move(at.x - 10, at.y, { steps: 4 })
  await page.waitForTimeout(100)
  await page.mouse.move(at.x, at.y, { steps: 4 })
  await page.waitForTimeout(150)
  const candidate = await page.evaluate(() => {
    const c = window.__oip.controller.snap.candidate
    return c ? { targetId: c.targetId, attach: c.attach ?? null } : null
  })
  await page.mouse.down(); await page.mouse.up()
  await page.waitForTimeout(200)
  const closed = await page.evaluate(() => window.__oip.controller.reposition === null)
  if (!closed) return { ok: false, why: 'gesture did not close', candidate }
  return { ok: true, candidate }
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.goto(URL)
    await waitForApp(page)
    // kill the onboarding tour before it renders - its overlay swallows canvas pointer events
    await page.evaluate(() => {
      window.localStorage.clear()
      window.localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1500)
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click().catch(() => {})
    await page.waitForTimeout(300)

    // Scene: two cargo boxes (A target, B mover), a rack (the button's host), a push button, and
    // an inclined roller conveyor (the flank-flush host). Parts built from registered packages' defaults.
    const setup = await page.evaluate(() => {
      const st = window.__oip.store
      // No shipped part declares ambient face-flush (on box/pallet/rack, cargo tiles itself against every
      // neighbour, which is too eager). So the gate builds a synthetic declarer, a plain box clone plus the
      // declaration, and drags that as the mover. These phases then test the SDK capability, not one
      // built-in's opt-in, and stay green whichever way a future part decides. The target stays a stock box:
      // flush is mover-side only, and an undeclared target still receiving the snap is the behaviour to pin.
      const boxPkg = window.__oip.getPackage('oip.box')
      if (boxPkg) {
        window.__oip.registerPackage(
          { ...boxPkg, id: 'test.flush-box', name: 'Flush Box', snap: { ...(boxPkg.snap ?? {}), flush: true } },
          true,
        )
      }
      const mk = (pid, id, pos, rot = 0, overrides = {}) => {
        const pkg = window.__oip.getPackage(pid)
        if (!pkg) return null
        const params = Object.fromEntries(Object.entries(pkg.params ?? {}).map(([k, s]) => [k, s.default]))
        return { id, type: 'part', packageId: pid, position: pos, rotationY: rot, params: { ...params, ...overrides } }
      }
      const rackB = window.__oip.getPackage('oip.rack')?.geometry?.bounds
      const slB = window.__oip.getPackage('oip.stack-light')?.geometry?.bounds
      const roller = mk('oip.roller-conveyor', 'roller1', [0, 0.75, 5], 0, { tiltDeg: 15 })
      const parts = [
        mk('oip.box', 'box_a', [0, 0.2, 0]),
        mk('test.flush-box', 'box_b', [2.5, 0.2, 0.1]),
        mk('oip.rack', 'rack1', [5, 0, -2]),
        mk('oip.push-button', 'btn1', [2, 0, -4]),
        mk('oip.stack-light', 'sl1', [3, 0, 5]),
        roller,
      ]
      if (parts.some((p) => !p) || !rackB || !slB) return { ok: false }
      st.loadScene({ version: st.getState().scene.version, parts }, { persist: false })
      return { ok: true, rackHx: rackB.length / 2, rollerHw: (roller.params.width ?? 0.6) / 2, slHz: slB.width / 2 }
    })
    check('scene loaded (2 boxes, rack, button, stack light, inclined roller)', setup.ok, `rack hx=${setup.rackHx}`)
    await page.waitForTimeout(1200)
    // a session with the PLC editor floated (e.g. a stored layout) has that panel
    // over the viewport (fixed, z-30), swallowing pointer events over the left half of the scene; it
    // can mount late, so poll-hide it
    let hid = 0
    for (let i = 0; i < 8 && hid === 0; i++) {
      hid = await page.evaluate(() => {
        let n = 0
        for (const el of document.querySelectorAll('div')) {
          if (el.style.position === 'fixed' && el.querySelector('[data-testid="plc-header"]')) {
            el.style.display = 'none'
            n++
          }
        }
        return n
      })
      if (hid === 0) await page.waitForTimeout(300)
    }
    console.log(`PLC float: ${hid > 0 ? `hidden (${hid})` : 'not present'}`)

    // --- Phase 1: declared flush - steer box B next to box A's +X face; it ends up flush (x = 0.3+0.3) ---
    const r1 = await reposition(page, 'box_b', 0.85, 0.1)
    check('flush gesture ran', r1.ok, r1.why)
    check('flush snap engaged on box A mid-drag', r1.candidate?.targetId === 'box_a', JSON.stringify(r1.candidate))
    const b = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'box_b'))
    check('box B landed FLUSH on A\'s face (x ≈ 0.6)', b && Math.abs(b.position[0] - 0.6) < 0.02, `x=${b?.position?.[0]}`)
    check('box B yaw 90°-stepped (≈ 0)', b && Math.abs(b.rotationY) < 1e-6, `rot=${b?.rotationY}`)
    check('flush never parents', b && b.parent === undefined, `parent=${b?.parent}`)

    // --- Phase 1b: the face-snap toggle (Shift+N / Snap Settings) gates the ambient flush ---
    await page.evaluate(() => window.__oip.store.setFaceSnap(false))
    const r1b = await reposition(page, 'box_b', 0.85, 0.1)
    check('toggle-off gesture ran', r1b.ok, r1b.why)
    check('face snap OFF: no flush candidate engages', r1b.candidate === null, JSON.stringify(r1b.candidate))
    await page.evaluate(() => window.__oip.store.setFaceSnap(true))

    // --- Phase 1c: flush against an inclined conveyor's flank (clear of the bed), never when over it ---
    // approach the +Z flank: the default camera sits in the +X/+Z quadrant, so the floor strip past the
    // +Z flank is visible - steering rays to the −Z side would hit the raised bed and rest the box on it
    const flankZ = 5 + setup.rollerHw + 0.2 // roller +Z flank + box half-width
    const r1c = await reposition(page, 'box_b', 0, flankZ + 0.12)
    check('conveyor-flank gesture ran', r1c.ok, r1c.why)
    check('flush engaged on the inclined roller', r1c.candidate?.targetId === 'roller1', JSON.stringify(r1c.candidate))
    const bC = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'box_b'))
    check('box butts the inclined flank (z flush)', bC && Math.abs(bC.position[2] - flankZ) < 0.02, `z=${bC?.position?.[2]}, want=${flankZ}`)
    check('box stayed on the floor (Y kept)', bC && Math.abs(bC.position[1] - 0.2) < 0.05, `y=${bC?.position?.[1]}`)
    // steer over the bed (aim at a point on the inclined bed top - a floor-aimed ray would clip the tall
    // proxy's head-end corner and put the box off the bed): rest-on-belt flow, no flank grab
    const r1d = await reposition(page, 'box_b', 0.5, 5, 0.9)
    check('over-bed gesture ran', r1d.ok, r1d.why)
    check('no flush while OVER the bed (drop-on-belt flow wins)', r1d.candidate === null, JSON.stringify(r1d.candidate))
    // the plain drop seats the level box corner-first on the physics-true inclined surface - not hovering
    // on the padded pick proxy (a +5 cm float that drops at Run), and never buried into the slope
    const overBed = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'box_b'))
    const nI = { x: -Math.sin(Math.PI / 12), y: Math.cos(Math.PI / 12) }
    const dI = 0 * nI.x + 0.75 * nI.y // plane through the roller origin (0, 0.75, 5); n.z = 0
    let minContact = Infinity
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      minContact = Math.min(minContact, (overBed.position[0] + sx * 0.3) * nI.x + (overBed.position[1] + sy * 0.2) * nI.y - dI)
    }
    check('plain drop seats corner-first ON the true roller surface', Math.abs(minContact) < 0.01, `contact=${minContact.toFixed(4)}, pos=${overBed.position.map((n) => n.toFixed(3))}`)

    // --- Phase 2: face mount + attach - steer the button next to the rack's +X face ---
    const bx = 5 + setup.rackHx + 0.3 // on the floor just off the rack's +X face
    const r2 = await reposition(page, 'btn1', bx, -2)
    check('button gesture ran', r2.ok, r2.why)
    check('face-mount snap engaged on the rack with attach', r2.candidate?.targetId === 'rack1' && r2.candidate?.attach === true, JSON.stringify(r2.candidate))
    const btn = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'btn1'))
    const wantX = 5 + setup.rackHx + 0.03 // back plate (local z −0.03) on the face plane
    check('button back plate seats ON the face plane', btn && Math.abs(btn.position[0] - wantX) < 0.02, `x=${btn?.position?.[0]}, want=${wantX}`)
    check('button ATTACHED (soft-parented under the rack)', btn?.parent === 'rack1', `parent=${btn?.parent}`)

    // --- Phase 3: the host carries the attached button; undo unwinds carry, then attachment ---
    const before = await page.evaluate(() => {
      const s = window.__oip.store.getState().scene.parts
      return { rack: s.find((p) => p.id === 'rack1').position, btn: s.find((p) => p.id === 'btn1').position }
    })
    const r3 = await reposition(page, 'rack1', 5, 1) // move the rack ~3 m in +Z
    check('rack carry gesture ran', r3.ok, r3.why)
    const after = await page.evaluate(() => {
      const s = window.__oip.store.getState().scene.parts
      return { rack: s.find((p) => p.id === 'rack1').position, btn: s.find((p) => p.id === 'btn1').position }
    })
    const dz = after.rack[2] - before.rack[2]
    const btnDz = after.btn[2] - before.btn[2]
    check('rack actually moved', Math.abs(dz) > 0.5, `dz=${dz.toFixed(2)}`)
    check('attached button RODE the rack (same delta)', Math.abs(btnDz - dz) < 0.02 && Math.abs(after.btn[0] - before.btn[0] - (after.rack[0] - before.rack[0])) < 0.02, `btn dz=${btnDz.toFixed(2)} vs rack dz=${dz.toFixed(2)}`)

    await page.keyboard.press('Control+z') // undo the rack move (button rides back)
    await page.waitForTimeout(150)
    await page.keyboard.press('Control+z') // undo the button mount (pose + parent, one entry)
    await page.waitForTimeout(150)
    const undone = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'btn1'))
    check('undo restored the button pose', Math.abs(undone.position[0] - 2) < 0.02 && Math.abs(undone.position[2] - -4) < 0.02, `pos=${undone.position}`)
    check('undo detached the button (parent gone with the same entry)', undone.parent === undefined, `parent=${undone.parent}`)

    // --- Phase 4: Shift+G + Alt face snap (collision-reposition alignment) - an undeclared part
    // (stack light) backs onto a crate's face at the picked height, and Z picks the alignment axis.
    await page.evaluate(() => window.__oip.store.select('sl1'))
    const face = await worldToScreen(page, 0.301, 0.25, 0) // a point on box A's +X face
    check('face point on screen', face.inside, `(${face.x.toFixed(0)},${face.y.toFixed(0)})`)
    await page.mouse.move(face.x, face.y, { steps: 4 })
    await page.waitForTimeout(80)
    await page.keyboard.down('Shift')
    await page.keyboard.press('g')
    await page.keyboard.up('Shift')
    await page.waitForTimeout(120)
    const r4started = await page.evaluate(() => window.__oip.controller.reposition?.id ?? null)
    check('align gesture steering the stack light', r4started === 'sl1', `steering ${r4started}`)
    await page.keyboard.down('Alt')
    await page.waitForTimeout(120)
    await page.mouse.move(face.x + 2, face.y, { steps: 2 })
    await page.mouse.move(face.x, face.y, { steps: 2 })
    await page.waitForTimeout(150)
    await page.keyboard.press('z') // axis key: +Z turns toward the face normal (+X) → yaw 90°
    await page.waitForTimeout(120)
    const aligned = await page.evaluate(() => {
      const p = window.__oip.store.getState().scene.parts.find((q) => q.id === 'sl1')
      return { pos: p.position, rot: p.rotationY }
    })
    check('stack light BACKED ONTO the face (x just outside the plane)', aligned.pos[0] > 0.3 && aligned.pos[0] < 0.7, `x=${aligned.pos[0].toFixed(3)}`)
    check('…hanging at the PICKED height, not resting on floor/top', aligned.pos[1] > 0.08 && aligned.pos[1] < 0.42, `y=${aligned.pos[1].toFixed(3)}`)
    check('axis key aligned +Z to the surface normal (yaw ≈ 90°)', Math.abs(aligned.rot - Math.PI / 2) < 1e-6, `rot=${aligned.rot.toFixed(4)}`)
    await page.mouse.down(); await page.mouse.up() // commit while Alt held
    await page.keyboard.up('Alt')
    await page.waitForTimeout(200)
    const sl = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'sl1'))
    check('aligned pose committed', sl && Math.abs(sl.position[0] - aligned.pos[0]) < 0.02 && Math.abs(sl.rotationY - aligned.rot) < 1e-6, `pos=${sl?.position}`)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(150)
    const slUndone = await page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'sl1'))
    check('undo restored the stack light (one entry)', Math.abs(slUndone.position[0] - 3) < 0.02 && Math.abs(slUndone.position[2] - 5) < 0.02, `pos=${slUndone.position}`)

    // --- Phase 4b: Alt face snap onto the inclined roller bed - the box tilts to lie flat on the rollers
    // (full-orientation alignment: local +Y onto the bed normal → rotationZ = the 15° incline).
    await page.evaluate(() => window.__oip.store.select('box_b'))
    const bed = await worldToScreen(page, 0.5, 0.9, 5) // a point on the inclined bed's top surface
    check('bed point on screen', bed.inside, `(${bed.x.toFixed(0)},${bed.y.toFixed(0)})`)
    await page.evaluate(([px, py]) => {
      const canvas = window.__oip.view.renderer.domElement
      for (let i = 0; i < 8; i++) {
        const el = document.elementFromPoint(px, py)
        if (!el || el === canvas || canvas.contains(el) || el.contains(canvas)) break
        el.style.pointerEvents = 'none'
      }
    }, [bed.x, bed.y])
    await page.mouse.move(bed.x, bed.y, { steps: 4 })
    await page.waitForTimeout(80)
    await page.keyboard.down('Shift')
    await page.keyboard.press('g')
    await page.keyboard.up('Shift')
    await page.waitForTimeout(120)
    check('bed-align gesture steering box B', await page.evaluate(() => window.__oip.controller.reposition?.id ?? null) === 'box_b')
    await page.keyboard.down('Alt')
    await page.waitForTimeout(120)
    await page.mouse.move(bed.x + 3, bed.y, { steps: 2 })
    await page.mouse.move(bed.x, bed.y, { steps: 2 })
    await page.waitForTimeout(150)
    const tilted = await page.evaluate(() => {
      const p = window.__oip.store.getState().scene.parts.find((q) => q.id === 'box_b')
      return { pos: p.position, rotZ: p.rotationZ ?? 0, rotX: p.rotationX ?? 0 }
    })
    check('box TILTED flat onto the inclined rollers (rotationZ ≈ 15°)', Math.abs(tilted.rotZ - Math.PI / 12) < 0.03 && Math.abs(tilted.rotX) < 0.03, `rotZ=${tilted.rotZ.toFixed(4)}, rotX=${tilted.rotX.toFixed(4)}`)
    // Exact seating: the box's bottom face centre (origin − normal × half-height) must lie on the true
    // conveying surface (y = 0.75 + x·tan15°), not the padded pick proxy 5 cm above it, which would make
    // the box hover and then drop when the sim starts
    const th15 = Math.PI / 12
    const bottomX = tilted.pos[0] + 0.2 * Math.sin(th15)
    const bottomY = tilted.pos[1] - 0.2 * Math.cos(th15)
    const surfY = 0.75 + bottomX * Math.tan(th15)
    check('…bottom face EXACTLY on the roller surface (no float, no drop on Run)', Math.abs(bottomY - surfY) < 0.01, `bottom=${bottomY.toFixed(3)}, surface=${surfY.toFixed(3)}`)
    await page.mouse.down(); await page.mouse.up() // commit while Alt held
    await page.keyboard.up('Alt')
    await page.waitForTimeout(200)
    const tiltedDone = await page.evaluate(() => {
      const p = window.__oip.store.getState().scene.parts.find((q) => q.id === 'box_b')
      return { rotZ: p.rotationZ ?? 0 }
    })
    check('tilt COMMITTED with the pose', Math.abs(tiltedDone.rotZ - Math.PI / 12) < 0.03, `rotZ=${tiltedDone.rotZ.toFixed(4)}`)

    // --- Phase 5: Alt face snap while placing from the catalog - the ghost aligns onto the inclined bed
    // and the click commits the tilted, exactly-seated part (the downhill half; box_b parks uphill).
    const bedLo = await worldToScreen(page, -0.5, 0.62, 5)
    check('placement bed point on screen', bedLo.inside, `(${bedLo.x.toFixed(0)},${bedLo.y.toFixed(0)})`)
    await page.evaluate(([px, py]) => {
      const canvas = window.__oip.view.renderer.domElement
      for (let i = 0; i < 8; i++) {
        const el = document.elementFromPoint(px, py)
        if (!el || el === canvas || canvas.contains(el) || el.contains(canvas)) break
        el.style.pointerEvents = 'none'
      }
    }, [bedLo.x, bedLo.y])
    await page.evaluate(() => {
      window.__oip.controller.pendingPackageId = 'oip.box'
      window.__oip.store.startPlacing('part', 'oip.box')
    })
    await page.waitForTimeout(300)
    await page.keyboard.down('Alt')
    await page.mouse.move(bedLo.x + 2, bedLo.y, { steps: 2 })
    await page.mouse.move(bedLo.x, bedLo.y, { steps: 4 })
    await page.waitForTimeout(250)
    await page.mouse.down(); await page.mouse.up() // one click places the aligned ghost
    await page.waitForTimeout(300)
    await page.keyboard.up('Alt')
    await page.keyboard.press('Escape') // leave placing mode so nothing else places
    await page.waitForTimeout(200)
    const placed5 = await page.evaluate(() =>
      window.__oip.store.getState().scene.parts
        .filter((p) => p.packageId === 'oip.box' && p.id !== 'box_a' && p.id !== 'box_b')
        .map((p) => ({ pos: p.position, rotZ: p.rotationZ ?? 0 })),
    )
    const aligned5 = placed5.find((p) => Math.abs(p.rotZ - Math.PI / 12) < 0.03)
    check('catalog Alt-placement landed the ALIGNED box (rotZ ≈ 15°)', !!aligned5, `boxes=${JSON.stringify(placed5.map((p) => +p.rotZ.toFixed(3)))}`)
    if (aligned5) {
      const bx5 = aligned5.pos[0] + 0.2 * Math.sin(Math.PI / 12)
      const by5 = aligned5.pos[1] - 0.2 * Math.cos(Math.PI / 12)
      check('placed box seated EXACTLY on the rollers', Math.abs(by5 - (0.75 + bx5 * Math.tan(Math.PI / 12))) < 0.01, `bottom=${by5.toFixed(3)}, surf=${(0.75 + bx5 * Math.tan(Math.PI / 12)).toFixed(3)}`)
    }

    check('no uncaught page errors', errors.filter((e) => !/favicon|manifest/i.test(e)).length === 0, errors.slice(0, 2).join(' | '))
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  }
}

main()
  .then(() => process.exit(failed ? 1 : 0))
  .catch((e) => { console.error('verify-face-snap crashed:', e); process.exit(2) })
