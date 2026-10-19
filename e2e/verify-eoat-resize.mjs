// Focused check: the Six-Axis robot's EOAT (end-of-arm tooling) resizes in the real app:
// placing the bundled robot draws the resizable vacuum plate (the behavior's geometry() on the `eoat` link:
// plate, rails, corner caps, adapter) with its 5×5 suction-cup bed; editing toolSizeX/Z rebuilds the frame at
// the new size and regenerates the cup grid; cupsEnabled=false empties the bed; the tool's LED lights green
// with the vacuum, and the cups compress off the same signal instead of glowing.
// Run: node e2e/verify-eoat-resize.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/?gfx=low`
const HEADED = process.argv.includes('--headed')
const SHOTS = join(import.meta.dirname, 'shots')
mkdirSync(SHOTS, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` - ${detail}` : ''}`)
}

// Inspect the placed robot's EOAT: the cup bank (the one InstancedMesh on the `eoat` link), the frame's outer
// extent in the eoat frame (the corner caps, 5 mm outside ±size/2), and the cups' colour.
const inspect = (page) =>
  page.evaluate(() => {
    const state = window.__oip.store.getState()
    const rid = state.scene.parts.find((p) => p.type === 'part')?.id
    const entry = rid && window.__oip.view.entries.get(rid)
    if (!entry) return { rid: null }
    const root = entry.visual.object
    root.updateMatrixWorld(true)
    let eoat = null
    root.traverse((o) => { if (o.userData.linkName === 'eoat') eoat = o })
    if (!eoat) return { rid, eoat: false }
    let cups = null
    let frameX = 0
    let frameZ = 0
    let meshes = 0
    for (const o of eoat.children) {
      if (!o.isMesh || !o.castShadow) continue // the rig gizmo's size dots ride this link too, casting no shadow
      meshes++
      if (o.isInstancedMesh) { cups = o; continue }
      o.geometry.computeBoundingBox()
      const b = o.geometry.boundingBox
      frameX = Math.max(frameX, -b.min.x, b.max.x)
      frameZ = Math.max(frameZ, -b.min.z, b.max.z)
    }
    const cupXs = []
    if (cups) {
      const m = new cups.matrix.constructor()
      for (let i = 0; i < cups.count; i++) { cups.getMatrixAt(i, m); cupXs.push(+m.elements[12].toFixed(3)) }
    }
    return {
      rid,
      eoat: true,
      meshes,
      cupCount: cups && cups.visible ? cups.count : 0,
      cupXsSpread: cupXs.length ? [Math.min(...cupXs), Math.max(...cupXs)] : null,
      frame: [+frameX.toFixed(4), +frameZ.toFixed(4)],
      cupEmissive: cups ? cups.material.emissive.toArray().map((v) => +v.toFixed(3)) : null,
    }
  })

const setParams = (page, over) =>
  page.evaluate((patch) => {
    const store = window.__oip.store
    const s = store.getState()
    const rid = s.scene.parts.find((p) => p.type === 'part').id
    store.commit('Edit EOAT params', {
      ...s.scene,
      parts: s.scene.parts.map((p) => (p.id === rid ? { ...p, params: { ...p.params, ...patch } } : p)),
    })
  }, over)

async function main() {
  const browser = await chromium.launch({ headless: !HEADED, args: ['--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text()) })
  try {
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller && window.__oip.view), { timeout: 30000 })
    // bundled catalog card → place at the viewport centre (the sixaxis smoke script's flow)
    const card = page.locator('[data-package-id="oip.six-axis-robot"]')
    await card.waitFor({ timeout: 15000 })
    const vp = await page.locator('.viewport').boundingBox()
    await page.evaluate(({ cx, cy }) => {
      // a card drag that drops at (cx, cy): one-shot, so placing mode exits (the verify-rig-gizmo idiom)
      const c = window.__oip.controller
      c.beginCatalogPlace('part', cx - 40, cy - 20, 'oip.six-axis-robot')
      c.catalogPlaceMove(cx, cy, false)
      c.endCatalogPlace(cx, cy, false)
    }, { cx: vp.x + vp.width / 2, cy: vp.y + vp.height / 2 })

    // the part lands async → poll until the cup grid materializes
    let s = { cupCount: -1 }
    for (let i = 0; i < 60 && s.cupCount < 25; i++) {
      await page.waitForTimeout(250)
      s = await inspect(page)
    }
    await page.screenshot({ path: join(SHOTS, 'eoat-default.png') })
    check('robot placed with the EOAT drawn on its link (plate, rails, adapter, bolts, LED bezel and lens, cups)', s.eoat && s.meshes === 7, `${s.meshes} meshes`)
    check('default 0.5 m tool grows a 5×5 cup bed', s.cupCount === 25, `${s.cupCount} cups`)
    check('cups span ±0.2 (usable/2)', !!s.cupXsSpread && Math.abs(s.cupXsSpread[0] + 0.2) < 1e-3 && Math.abs(s.cupXsSpread[1] - 0.2) < 1e-3, JSON.stringify(s.cupXsSpread))
    check('frame reaches ±0.255 (the caps, 5 mm outside the 0.5 m plate)', !!s.frame && s.frame[0] === 0.255 && s.frame[1] === 0.255, JSON.stringify(s.frame))

    // resize: 2 m × 1 m - the frame is rebuilt at the new size, the grid regenerates (usable 1.9×0.9 → 20×10)
    await setParams(page, { toolSizeX: 2, toolSizeZ: 1 })
    await page.waitForTimeout(400)
    s = await inspect(page)
    await page.screenshot({ path: join(SHOTS, 'eoat-2x1.png') })
    check('2×1 m tool: cup grid regenerates to 20×10', s.cupCount === 200, `${s.cupCount} cups`)
    check('frame rebuilt to ±1.005 × ±0.505', !!s.frame && s.frame[0] === 1.005 && s.frame[1] === 0.505, JSON.stringify(s.frame))

    // cups off (cupsEnabled): the bed empties
    await setParams(page, { cupsEnabled: false })
    await page.waitForTimeout(300)
    s = await inspect(page)
    await page.screenshot({ path: join(SHOTS, 'eoat-cups-off.png') })
    check('cupsEnabled=false empties the bed', s.cupCount === 0, `${s.cupCount} cups`)
    await setParams(page, { cupsEnabled: true })
    await page.waitForTimeout(300)

    // vacuum indicator: the green LED on the tool lights, and the cups compress instead of
    // glowing. Light the vacuumLamp signal directly (the sim routes frame.lamps here), tick the part as a running sim
    // would, and check the LED tint, the cups' squash, and that the cups stayed un-lit. The LED is a drawn submesh, so
    // it is found as the one mesh on the tool that turns green, after checking none is green before.
    const lamp = await page.evaluate(() => {
      const state = window.__oip.store.getState()
      const rid = state.scene.parts.find((p) => p.type === 'part').id
      const root = window.__oip.view.entries.get(rid).visual.object
      const green = () => {
        const lit = []
        root.traverse((m) => { if (m.isMesh && m.material?.emissive && m.material.emissive.g > 0.5 && m.material.emissive.g > m.material.emissive.r) lit.push(m) })
        return lit
      }
      const before = green().length
      root.userData.applyLamps({ vacuumLamp: true })
      root.userData.tick(1, true)
      const after = green()
      const led = before === 0 && after.length === 1 ? after[0].material.emissive.toArray() : null
      let cups = null
      root.traverse((o) => { if (o.isInstancedMesh && o.userData.poolMobile) cups = o })
      return { led, cups: cups ? cups.material.emissive.toArray() : null, squash: cups ? +cups.scale.y.toFixed(3) : null }
    })
    await page.screenshot({ path: join(SHOTS, 'eoat-vacuum-on.png') })
    check('vacuum-on lights the tool LED green (emissive green-dominant)', !!lamp.led && lamp.led[1] > 0.5 && lamp.led[1] > lamp.led[0], JSON.stringify(lamp.led))
    check('the cups do NOT glow (indicator moved off the rubber)', !!lamp.cups && lamp.cups[0] === 0 && lamp.cups[1] === 0 && lamp.cups[2] === 0, JSON.stringify(lamp.cups))
    check('the cups compress 15% while the vacuum holds', lamp.squash === 0.85, `scale.y=${lamp.squash}`)

    // the resize gizmo (robot_gizmo's orange EOAT dots): select the robot, find the size:toolSizeX dot's
    // screen position, and pointer-drag it outward along the tool's X axis - the param must follow.
    await setParams(page, { toolSizeX: 0.5, toolSizeZ: 0.5 })
    await page.waitForTimeout(300)
    await page.evaluate(() => {
      const store = window.__oip.store
      const rid = store.getState().scene.parts.find((p) => p.type === 'part').id
      store.cancelPlacing() // leave placing mode (custom placement doesn't auto-exit) so the rig gizmo arms
      store.select(rid)
    })
    await page.waitForTimeout(400) // the overlay lays the dots out on the next frames
    const drag = await page.evaluate(() => {
      const store = window.__oip.store
      const view = window.__oip.view
      const rid = store.getState().scene.parts.find((p) => p.type === 'part').id
      const root = view.entries.get(rid).visual.object
      root.updateMatrixWorld(true)
      // the size dots are drawn by the view's rig gizmo overlay (rigGizmoOverlay.ts): the toolSizeX one
      const dot = view.rigGizmoOverlay.handles().find((h) => h.handle === 'size:toolSizeX')
      if (!dot) return null
      const Vec3 = dot.pos.constructor // three's Vector3, reached without an import in page context
      const from = view.worldToScreen(dot.pos.x, dot.pos.y, dot.pos.z)
      // target: where the same handle would sit if the tool were ~1.5 m wide (eoat-local x 0.25 → 0.75)
      let eoat = null
      root.traverse((o) => { if (o.userData.linkName === 'eoat') eoat = o })
      const to = ((v) => view.worldToScreen(v.x, v.y, v.z))(eoat.localToWorld(new Vec3(0.75, -0.075, 0)))
      return { from, to, visible: view.rigGizmoOverlay.root.visible && view.robotGizmoId === rid }
    })
    check('size gizmo dot exists + is visible once the robot is selected', !!drag && drag.visible, JSON.stringify(drag && { from: drag.from, to: drag.to }))
    if (drag) {
      await page.mouse.move(drag.from.x, drag.from.y)
      await page.mouse.down()
      await page.mouse.move(drag.to.x, drag.to.y, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(300)
      const val = await page.evaluate(() => {
        const p = window.__oip.store.getState().scene.parts.find((q) => q.type === 'part')
        return p.params.toolSizeX
      })
      await page.screenshot({ path: join(SHOTS, 'eoat-gizmo-dragged.png') })
      check('dragging the dot grows toolSizeX to ≈1.5 m', typeof val === 'number' && val > 1.2 && val < 1.8, `toolSizeX=${val}`)
    }
  } catch (e) {
    console.log('RUN ERROR:', String(e).split('\n')[0])
    results.push(false)
  } finally {
    await browser.close()
    vite.kill()
  }
  const ok = results.length > 0 && results.every(Boolean)
  console.log(ok ? '\nPASS: EOAT resize behaves' : '\nFAIL: see diagnostics above')
  process.exitCode = ok ? 0 : 1
}

main().catch((e) => { console.error(e); process.exit(1) })
