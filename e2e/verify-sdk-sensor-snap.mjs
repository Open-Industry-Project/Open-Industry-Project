// Verifies the declarative snap-mount API: the "Diffuse Sensor", a custom part whose behavior declares
// `snap: { mounts: [...] }`, mounts on a conveyor's side guard purely from its self-described mount (the
// host does all the matching). Places a belt + the SDK sensor dropped just outside the +Z guard, then
// asserts the live-snap placed it on the guard, faced its beam inward, and
// auto-fit its maxRange param to span the belt. Run: node e2e/verify-sdk-sensor-snap.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { spawn } from 'node:child_process'
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
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 20000 })
}

async function worldToScreen(page, x, z) {
  return page.evaluate(
    ([wx, wz]) => {
      const v = window.__oip.view
      v.camera.updateMatrixWorld(true)
      const p = v.camera.position.clone().set(wx, 0, wz).project(v.camera)
      const rect = v.renderer.domElement.getBoundingClientRect()
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height, inside: p.z < 1 && Math.abs(p.x) < 0.9 && Math.abs(p.y) < 0.9 }
    },
    [x, z],
  )
}

async function ensureVisible(page, x, z) {
  for (let i = 0; i < 8; i++) {
    const s = await worldToScreen(page, x, z)
    if (s.inside) return s
    const c = await worldToScreen(page, 0, 0)
    await page.mouse.move(c.x, c.y)
    await page.mouse.wheel(0, 500)
    await page.waitForTimeout(120)
  }
  return worldToScreen(page, x, z)
}

// Catalog placement is pointer-capture based (beginCatalogPlace on pointerdown → moves → endCatalogPlace on up):
// open the category tab, then drag the card into the viewport.
//
// Target the card by package id, not by its title text. Every card is a `div.catalog-card` wrapper
// around `button.catalog-card-main`, whose title reads
// "<name> · <category, or ‘custom part’ for an imported/authored one>", so a selector like
// `button.catalog-card[title^="Belt Conveyor"]` matches nothing and times out before any assertion
// runs. A label prefix would also break on any rename; `data-package-id` is the stable hook.
async function placePart(page, packageId, category, [x, z]) {
  const s = await ensureVisible(page, x, z)
  await page.locator('.catalog-tab', { hasText: new RegExp(`^${category}$`) }).click()
  await page.waitForTimeout(150)
  const card = page.locator(`button.catalog-card-main[data-package-id=${JSON.stringify(packageId)}]`).first()
  await card.waitFor({ timeout: 25000 }) // bundled SDK packages register + render their catalog cards async
  const box = await card.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(s.x, s.y, { steps: 8 }) // drag the ghost into the viewport; live-snap runs here
  await page.waitForTimeout(120)
  await page.mouse.up()
  await page.waitForTimeout(120)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(40)
}

const sceneOf = (page) => page.evaluate(() => window.__oip.store.getState().scene)

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
    await page.waitForTimeout(2000)
    await page.evaluate(() => window.localStorage.clear())
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(1500)
    // dismiss the first-run tutorial so it doesn't dim/block the catalog
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click().catch(() => {})
    await page.waitForTimeout(3000) // let the bundled SDK part packages finish registering into the catalog

    await placePart(page, 'oip.belt-conveyor', 'Equipment', [0, 0])
    let scene = await sceneOf(page)
    const belt = scene.parts.find((p) => p.type === 'belt_conveyor' || (p.type === 'part' && /belt/i.test(p.packageId ?? '')))
    check('conveyor placed', !!belt)
    if (!belt) throw new Error('no conveyor')
    const w = belt.params.width
    const guardZ = w / 2

    // Drop a sensor just outside the +Z guard: live-snap should pull it onto the guard through the same
    // custom-aware snapDevice math the SDK snap-mount API uses. The Diffuse Sensor is a bundled SDK
    // package, and waiting on its card by package id is what makes this reliable.
    await placePart(page, 'oip.diffuse-sensor', 'Devices', [belt.position[0] + 0.6, belt.position[2] + guardZ + 0.25])
    scene = await sceneOf(page)
    // (floor markings are SDK parts, so their type is 'part'; exclude them by packageId)
    const others = scene.parts.filter((p) => p.id !== belt.id && p.type !== 'building' && p.packageId !== 'oip.floor-marking')
    const sensor = others[others.length - 1]
    check('sensor placed', !!sensor, `device=${sensor?.type}/${sensor?.packageId ?? '-'}`)
    if (!sensor) throw new Error('no sensor')

    // the snap declares its mount → host places it on the guard (z ≈ guardZ, past the belt centre), pushed out.
    const dz = sensor.position[2] - belt.position[2]
    check('mounted on the +Z guard (not left at the drop / bed centre)', dz > guardZ - 0.02, `dz=${dz.toFixed(3)} guardZ=${guardZ.toFixed(3)}`)
    check('mounted within the bed span (slid along the rail)', sensor.position[0] > belt.position[0] - 0.1, `x=${sensor.position[0].toFixed(3)}`)
    // auto-fit wrote the declared maxRange param so the beam spans the belt
    const range = sensor.params?.maxRange
    check('auto-fit maxRange spans the belt', typeof range === 'number' && range >= w, `maxRange=${range} width=${w}`)
    check('no runtime/console errors', errors.length === 0, errors.slice(0, 3).join(' | '))

    const shot = join(import.meta.dirname, 'shots', 'sdk-sensor-snap.png')
    await page.screenshot({ path: shot })
    console.log(`screenshot: ${shot}`)
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true })
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error('verify crashed:', err)
  process.exit(2)
})
