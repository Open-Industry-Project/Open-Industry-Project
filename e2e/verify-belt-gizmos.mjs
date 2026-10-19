// Verify the SDK Belt Conveyor shows the built-in's resize gizmos (docs/part-gizmos.md): the width (Z)
// face dots - centred at mid-length - plus the belt tail + per-segment dots, driven by the part's declared
// `face`/`path` handles. Places + selects the belt and screenshots the orange handles.
// Run: node e2e/verify-belt-gizmos.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const OUT = 'e2e/shots/belt-gizmos.png'

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.sim), { timeout: 20000 })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && !benign(m.text()) && errors.push(m.text()))

  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.evaluate(() => window.localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1800)
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click().catch(() => {})
    await page.waitForTimeout(300)

    // place + focus the SDK belt in isolation (its catalog card is shadowed by the built-in belt)
    const placed = await page.evaluate(() => {
      try {
        return window.__oip.store.enterPackageEdit('oip.belt-conveyor')
      } catch (e) {
        return 'ERR:' + e.message
      }
    })
    console.log('enterPackageEdit:', placed)
    await page.waitForTimeout(2500) // build geometry, settle the focus camera, decode the fabric

    // select the belt so the resize handles attach, then report what the engine decided
    const info = await page.evaluate(() => {
      const st = window.__oip.store
      const part = st.getState().scene.parts.find((p) => p.packageId === 'oip.belt-conveyor')
      if (!part) return { found: false }
      st.select(part.id)
      return { found: true, id: part.id, type: part.type, segments: part.params?.segments, width: part.params?.width }
    })
    console.log('belt part:', JSON.stringify(info))
    // near top-down camera so both the belt's X (length) and Z (width) axes sit in the screen plane - a
    // focus camera viewing down the belt foreshortens the cross-belt Z axis, making a width drag map to ~0m.
    await page.evaluate(() => {
      const v = window.__oip.view
      const p = window.__oip.store.getState().scene.parts.find((q) => q.packageId === 'oip.belt-conveyor')
      v.setCameraPose({ px: p.position[0] + 1.5, py: p.position[1] + 7, pz: p.position[2] + 2.2, tx: p.position[0] + 1.5, ty: p.position[1], tz: p.position[2] })
    })
    await page.waitForTimeout(700)
    await page.screenshot({ path: OUT })
    console.log(`screenshot -> ${OUT}`)

    // project a part-local (x,z) point at deck height to CSS screen coords (visible flag included)
    const toScreen = (lx, lz) =>
      page.evaluate(
        ([lx, lz]) => {
          const v = window.__oip.view
          const p = window.__oip.store.getState().scene.parts.find((q) => q.packageId === 'oip.belt-conveyor')
          const c = Math.cos(p.rotationY), s = Math.sin(p.rotationY)
          const wx = p.position[0] + (lx * c + lz * s) // rotateXZ(local, rotationY)
          const wz = p.position[2] + (-lx * s + lz * c)
          return v.worldToScreen(wx, p.position[1], wz)
        },
        [lx, lz],
      )
    const pickAt = (x, y) => page.evaluate(([x, y]) => JSON.stringify(window.__oip.view.pickResizeHandle(x, y) ?? null), [x, y])

    // The projected centre is near the dot; spiral out until pickResizeHandle reports a matching handle,
    // so we grab the actual proxy regardless of footprint-half rounding.
    async function findPixel(local, match) {
      const seed = await toScreen(local[0], local[1])
      for (let r = 0; r <= 36; r += 4) {
        for (let a = 0; a < 360; a += 30) {
          const x = seed.x + r * Math.cos((a * Math.PI) / 180)
          const y = seed.y + r * Math.sin((a * Math.PI) / 180)
          const h = JSON.parse(await pickAt(x, y))
          if (h && match(h)) return { x, y }
          if (r === 0) break
        }
      }
      return null
    }

    async function dragHandle(local, match, screenDelta, label) {
      const from = await findPixel(local, match)
      if (!from) return console.log(`${label}: could not locate handle (pick returned null around projection)`)
      const picked = JSON.parse(await pickAt(from.x, from.y))
      console.log(`${label}: located handle ${JSON.stringify(picked)} at ${Math.round(from.x)},${Math.round(from.y)}`)
      const to = { x: from.x + screenDelta.x, y: from.y + screenDelta.y }
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 })
      await page.mouse.move(to.x, to.y, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(250)
    }

    const readParams = () =>
      page.evaluate(() => {
        const p = window.__oip.store.getState().scene.parts.find((q) => q.packageId === 'oip.belt-conveyor')
        return { segments: p.params.segments, width: p.params.width }
      })

    // screen-space +X / +Z directions (so the drag follows the belt even at the focus camera's angle)
    const dirX = await page.evaluate(() => {
      const v = window.__oip.view, p = window.__oip.store.getState().scene.parts.find((q) => q.packageId === 'oip.belt-conveyor')
      const a = v.worldToScreen(p.position[0], p.position[1], p.position[2])
      const b = v.worldToScreen(p.position[0] + 1, p.position[1], p.position[2])
      const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1
      return { x: dx / l, y: dy / l }
    })
    const dirZ = await page.evaluate(() => {
      const v = window.__oip.view, p = window.__oip.store.getState().scene.parts.find((q) => q.packageId === 'oip.belt-conveyor')
      const a = v.worldToScreen(p.position[0], p.position[1], p.position[2])
      const b = v.worldToScreen(p.position[0], p.position[1], p.position[2] + 1)
      const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1
      return { x: dx / l, y: dy / l }
    })

    // 1) drag the head segment-end dot (handle {belt:0}) along +X by ~90px → segment 0 lengthens
    await dragHandle([3, 0], (h) => h.belt === 0, { x: dirX.x * 90, y: dirX.y * 90 }, 'length drag')
    const afterLen = await readParams()
    console.log('after length drag:', JSON.stringify(afterLen))

    // 2) drag the +Z width dot (handle {axis:'z'}) outward → width grows. Try +Z, then -Z if no change.
    await dragHandle([1.5, 0.5], (h) => h.axis === 'z', { x: dirZ.x * 110, y: dirZ.y * 110 }, 'width drag +Z')
    let afterWidth = await readParams()
    if (afterWidth.width <= 1.05) {
      await dragHandle([1.5, 0.5], (h) => h.axis === 'z', { x: -dirZ.x * 110, y: -dirZ.y * 110 }, 'width drag -Z')
      afterWidth = await readParams()
    }
    console.log('after width drag:', JSON.stringify(afterWidth))

    await page.screenshot({ path: 'e2e/shots/belt-gizmos-after.png' })

    const lengthGrew = afterLen.segments[0][0] > 3.05
    const widthGrew = afterWidth.width > 1.05
    console.log(`RESULT length-handle ${lengthGrew ? 'WORKS' : 'NO-OP'}; width-handle ${widthGrew ? 'WORKS' : 'NO-OP'}`)
    console.log(errors.length === 0 ? 'NO ERRORS' : `ERRORS:\n${errors.slice(0, 6).join('\n')}`)
    if (!lengthGrew || !widthGrew) process.exitCode = 1
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  }
}

main().catch((e) => {
  console.error('verify-belt-gizmos crashed:', e)
  process.exit(2)
})
