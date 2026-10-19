/* global console, process */
// Flow arrows must survive a package edit / hot reload. sdkPart.rebuild strips every child of the
// part root whenever geomSignature moves (author-mode commitPackage, dev HMR of examples/parts,
// desktop watcher). An arrow parented there would be stripped, and since its own signature keys on
// params (length/speed), which such an edit doesn't move, it would stay detached for good ("flow
// arrows disappear shortly after becoming visible"). Arrows live in the view's shared instanced
// FlowArrowBank (never inside the part root, never inside a render bundle, drawn from the overlay
// sub-pass); this guards that a package edit keeps every arrow present + visible and that the
// toggle round-trips.
// Run: node e2e/verify-flow-arrow-package-edit.mjs
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const settle = async (page, ms) => { await page.waitForTimeout(ms); for (let i = 0; i < 4; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))) }

/** id → {arrow, visible} from the shared instanced bank (flowArrowBank), + the bank's draw state */
const probe = () => {
  const { view } = window.__oip
  const bank = view.flowArrowBank
  bank.flush() // the render loop flushes per frame; flush here so the read is deterministic
  const dbg = bank.debug()
  const out = {}
  for (const [id, entry] of view.entries) {
    if (entry.part.type !== 'part') continue
    const d = dbg[id]
    out[id] = { arrow: !!d && d.spans > 0, visible: d ? d.visible : false, sig: entry.flowSig }
  }
  let root = bank.group
  while (root.parent) root = root.parent
  out.__bank = {
    inScene: root.isScene === true && bank.group.visible,
    counts: bank.group.children.map((m) => m.count),
    meshesVisible: bank.group.children.map((m) => m.visible),
  }
  return out
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const { url, vite } = await startServer()
  const errors = []
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* */ } })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  const fail = (msg) => { console.error(`FAIL: ${msg}`); if (errors.length) console.error('errors:', errors.slice(0, 5)); process.exitCode = 1 }
  try {
    await page.goto(`${url}`)
    await page.waitForFunction(() => !!(window.__oip && window.__oip.view && window.__oip.store), { timeout: 30000 })

    // one belt (function geometry: behavior source is in geomSignature) + one roller (rig geometry:
    // link structure is in geomSignature) - the two rebuild triggers a part edit can take
    const ok = await page.evaluate(() => {
      const { store, getPackage } = window.__oip
      const belt = getPackage('oip.belt-conveyor')
      const roller = getPackage('oip.roller-conveyor')
      if (!belt || !roller) return false
      const defaults = (pkg) => {
        const params = {}
        for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
        return params
      }
      store.loadScene({
        version: store.getState().scene.version,
        parts: [
          { id: 'belt1', type: 'part', packageId: belt.id, position: [0, 0.5, -1.5], rotationY: 0, name: 'Belt', params: defaults(belt) },
          { id: 'roll1', type: 'part', packageId: roller.id, position: [0, 0.5, 1.5], rotationY: 0, name: 'Roller', params: defaults(roller) },
        ],
        packages: [belt, roller],
      })
      return true
    })
    if (!ok) return fail('belt/roller packages not registered')
    await settle(page, 2500)

    await page.evaluate(() => { window.__oip.store.setFlowArrows(true) })
    await settle(page, 300)
    const t0 = await page.evaluate(probe)
    for (const id of ['belt1', 'roll1']) {
      const r = t0[id]
      if (!r || !r.arrow || !r.visible) return fail(`${id} arrow wrong after toggle-on: ${JSON.stringify(r)}`)
    }
    if (!t0.__bank.inScene || !t0.__bank.counts.some((n) => n > 0)) return fail(`arrow bank not drawing after toggle-on: ${JSON.stringify(t0.__bank)}`)

    // author-edit both packages (behavior touch + a structural epsilon - moves geomSignature for
    // either geometry kind → sdkPart.rebuild strips the part roots' children, arrows included)
    await page.evaluate(() => {
      const { store, getPackage } = window.__oip
      for (const pid of ['oip.belt-conveyor', 'oip.roller-conveyor']) {
        const pkg = getPackage(pid)
        const geometry = JSON.parse(JSON.stringify(pkg.geometry))
        if (geometry.links) {
          const box = geometry.links.find((l) => l.shape && l.shape.kind === 'box' && Array.isArray(l.shape.size))
          if (box) box.shape.size[0] += 1e-6
        }
        store.commitPackage('verify: touch', { ...pkg, geometry, behavior: pkg.behavior + '\n// touch' })
      }
    })
    await settle(page, 600)
    const t1 = await page.evaluate(probe)
    for (const id of ['belt1', 'roll1']) {
      const r = t1[id]
      if (!r || !r.arrow || !r.visible) return fail(`${id} arrow lost by package edit: ${JSON.stringify(r)}`)
    }
    if (!t1.__bank.counts.some((n) => n > 0)) return fail(`arrow bank emptied by package edit: ${JSON.stringify(t1.__bank)}`)

    // the toggle still round-trips on the re-adopted arrows
    await page.evaluate(() => { window.__oip.store.setFlowArrows(false) })
    await settle(page, 200)
    const off = await page.evaluate(probe)
    if (off.belt1.visible || off.roll1.visible) return fail(`arrows still visible after toggle-off: ${JSON.stringify(off)}`)
    if (off.__bank.counts.some((n) => n > 0)) return fail(`bank still holds instances after toggle-off: ${JSON.stringify(off.__bank)}`)
    await page.evaluate(() => { window.__oip.store.setFlowArrows(true) })
    await settle(page, 200)
    const on = await page.evaluate(probe)
    for (const id of ['belt1', 'roll1']) {
      const r = on[id]
      if (!r.visible) return fail(`${id} arrow wrong after off/on cycle: ${JSON.stringify(r)}`)
    }
    if (!on.__bank.counts.some((n) => n > 0)) return fail(`bank empty after off/on cycle: ${JSON.stringify(on.__bank)}`)

    if (errors.length) return fail(`console/page errors present: ${errors.slice(0, 3).join(' | ')}`)
    console.log('PASS: flow arrows survive a package edit and keep toggling (instanced bank)')
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
