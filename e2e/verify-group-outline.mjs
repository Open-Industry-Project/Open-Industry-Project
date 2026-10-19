// End-to-end check: selecting a parent/group node outlines the whole subtree.
// Loads the PLC demo, selects a group holding conveyors + cargo, and inspects the real
// consolidated outline pass (regular + active object sets) and the SimBoxes aSel
// selection channel to confirm belts + carried boxes are all outlined as one unit
// (carried cargo stays in the instanced batch - its rows get aSel >= 1; nothing is
// promoted to a standalone mesh on the consolidated path).
// Run: node e2e/verify-group-outline.mjs [--headed]
/* global process, console, fetch, setTimeout, window */
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/?scene=demo`
const HEADED = process.argv.includes('--headed')

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip && window.__oip.store && window.__oip.controller && window.__oip.view), { timeout: 20000 })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  try {
    await page.addInitScript(() => {
      try { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ignore */ }
    })
    // warm-up visit: cold vite may re-optimize deps and fully reload the page, dropping __oip
    await page.goto(URL)
    await waitForApp(page)
    await page.waitForTimeout(1200)
    await page.goto(URL)
    await waitForApp(page)
    await page.waitForTimeout(1500)
    // the re-goto aborts the warm-up's in-flight GLB fetches ("Failed to fetch" noise) - count
    // only errors from the session under test
    errors.length = 0

    // resolve the group under test + its expected subtree (walk parent links in-page). Chosen by
    // content, not name, so a demo edit that renames groups doesn't break it: the biggest group whose
    // subtree holds both a conveyor and cargo, since those are the two outline paths (per-object set,
    // and the batch's aSel channel) this gate is about.
    const info = await page.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts
      const byParent = new Map()
      for (const p of parts) { const a = byParent.get(p.parent) ?? []; a.push(p); byParent.set(p.parent, a) }
      // every demo part is a bundled SDK `custom` part - match by package id (any conveyor: belt or roller)
      const isCargo = (p) => p.type === 'part' && (p.packageId === 'oip.box' || p.packageId === 'oip.pallet')
      const isBelt = (p) => p.type === 'part' && /conveyor/.test(p.packageId || '')
      let best = null
      for (const g of parts.filter((p) => p.type === 'group')) {
        const sub = new Set([g.id])
        const walk = (id) => { for (const c of byParent.get(id) ?? []) if (!sub.has(c.id)) { sub.add(c.id); walk(c.id) } }
        walk(g.id)
        const inSub = parts.filter((p) => sub.has(p.id))
        const belts = inSub.filter(isBelt).map((p) => ({ id: p.id, name: p.name }))
        const cargo = inSub.filter(isCargo).map((p) => p.id)
        if (belts.length === 0 || cargo.length === 0) continue
        if (!best || sub.size > best.total) best = { lineId: g.id, name: g.name, subtree: [...sub], belts, cargoIds: cargo, total: sub.size }
      }
      return best
    })
    check('demo loaded with a group holding conveyors and cargo', !!info, info ? `"${info.name}" subtree=${info.total} parts` : 'no such group')
    if (!info) throw new Error('no demo group holds both a conveyor and cargo')
    check('subtree contains a conveyor', info.belts.length > 0, info.belts.map((b) => b.name).join(', '))
    check('subtree contains carried cargo (boxes/pallets)', info.cargoIds.length > 0, `cargo=${info.cargoIds.length}`)

    // select the group node, then read the REAL outline pass + cargo promotion
    await page.evaluate((id) => window.__oip.store.select(id), info.lineId)
    await page.waitForTimeout(300)

    const res = await page.evaluate(({ lineId, subtree, beltIds, cargoIds }) => {
      const view = window.__oip.view
      const ol = view.outline
      // Whichever outline is live. The app picks by what the adapter can do: a composer pass
      // (regularObjects/activeObjects, with the stock OutlinePass's selectedObjects as its own fallback) on a
      // software rasteriser, and the mask pipeline (consolidatedOutlineNode.ts, regularRoots/activeRoots - Sets of
      // the same root objects, plus their expanded *Meshes) on a real adapter. Reading only the first reports
      // regCount=0 when headless runs on the machine's GPU (e2e/_gpuArgs.mjs).
      const set = (v) => (v instanceof Set ? [...v] : (v ?? []))
      const reg = ol?.pass?.regularObjects ?? ol?.pass?.selectedObjects ?? set(ol?.regularRoots)
      const act = ol?.pass?.activeObjects ?? ol?.activePass?.selectedObjects ?? set(ol?.activeRoots)
      const outlined = new Set([...reg, ...act])
      const objFor = (id) => view.entries.get(id)?.visual.object
      // every mesh-bearing descendant's object should be in the outline set (cargo objects are
      // hidden stubs outlined via the batch's aSel channel instead, so exclude them here)
      const meshIds = subtree.filter((id) => { const p = window.__oip.store.getState().scene.parts.find((q) => q.id === id); return p && p.type !== 'group' && !(p.type === 'part' && (p.packageId === 'oip.box' || p.packageId === 'oip.pallet')) })
      const missing = meshIds.filter((id) => { const o = objFor(id); return !o || !outlined.has(o) })
      const beltsOutlined = beltIds.every((id) => { const o = objFor(id); return o && outlined.has(o) })
      const groupActive = act.includes(objFor(lineId)) // clicked node = hot/active tier
      // carried cargo: stays in the instanced batch, its rows tiered via the aSel selection
      // channel. Map each subtree cargo part to its batch row and read the channel; nothing
      // may leave the batch as a standalone proxy.
      const rowTier = (partId) => {
        for (const [mesh, meta] of [[view.boxes.mesh, view.boxes.boxMeta], [view.boxes.palletMesh, view.boxes.palletMeta]]) {
          const attr = mesh.geometry.getAttribute('aSel')
          if (!attr) return -1
          for (let i = 0; i < meta.length; i++) if (meta[i].partId === partId) return attr.array[i]
        }
        return -2 // not in any batch
      }
      const tiers = cargoIds.map(rowTier)
      const cargoTiered = tiers.every((t) => t >= 1)
      // cargo must never escape the batch on selection: the group holds InstancedMeshes only
      const escapees = view.boxes.group.children.filter((c) => c.isInstancedMesh !== true).length
      return {
        regCount: reg.length, actCount: act.length,
        meshCount: meshIds.length, missing,
        beltsOutlined, groupActive,
        cargoTiered, tierSample: tiers.slice(0, 6), escapees,
      }
    }, { lineId: info.lineId, subtree: info.subtree, beltIds: info.belts.map((b) => b.id), cargoIds: info.cargoIds })

    check('every mesh descendant is in the outline set', res.missing.length === 0, `meshes=${res.meshCount} missing=${res.missing.length}`)
    check('its conveyors are outlined', res.beltsOutlined, `regCount=${res.regCount} actCount=${res.actCount}`)
    check('the clicked group node is the active (hot) tier', res.groupActive)
    check('carried cargo rows carry aSel >= 1 (outlined from inside the batch)', res.cargoTiered, `tiers=${res.tierSample.join(',')}`)
    check('cargo never leaves the instanced batch on selection', res.escapees === 0, `escapees=${res.escapees}`)

    // contrast: selecting a single childless leaf must not pull in a subtree
    const leaf = await page.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts
      const hasChild = new Set(parts.map((p) => p.parent).filter(Boolean))
      const l = parts.find((p) => p.type === 'part' && p.packageId === 'oip.stack-light' && !hasChild.has(p.id))
      if (!l) return null
      window.__oip.store.select(l.id)
      const view = window.__oip.view
      // (whichever outline is live - see the note on the group read above)
      const asArray = (v) => (v instanceof Set ? [...v] : (v ?? []))
      const reg = view.outline?.pass?.regularObjects ?? view.outline?.pass?.selectedObjects ?? asArray(view.outline?.regularRoots)
      const act = view.outline?.pass?.activeObjects ?? view.outline?.activePass?.selectedObjects ?? asArray(view.outline?.activeRoots)
      // regular set is just the leaf object; no active tier
      const onlyLeaf = act.length === 0 && reg.includes(view.entries.get(l.id)?.visual.object)
      return { onlyLeaf, regCount: reg.length, actCount: act.length }
    })
    check('childless leaf select stays single-node (no subtree, no hot tier)', !!leaf && leaf.onlyLeaf, leaf ? `reg=${leaf.regCount} act=${leaf.actCount}` : 'no leaf')

    // re-select the group for the screenshot, frame it, and capture
    // focusOn is the view's framing API. Nothing asserts on the image, but an unframed one is
    // useless to inspect.
    await page.evaluate((id) => { window.__oip.store.select(id); window.__oip.view.focusOn([id]) }, info.lineId)
    await page.waitForFunction(() => window.__oip.view.focusAnim == null, { timeout: 15000 })
    await page.waitForTimeout(400)
    // deselect: false - the group outline is the subject of the artifact
    await cleanShot(page, join(import.meta.dirname, 'shots', 'group-outline.png'), { deselect: false })

    const pageErrs = errors.filter((e) => !/favicon|manifest/i.test(e))
    check('no uncaught page errors', pageErrs.length === 0, pageErrs.slice(0, 3).join(' | '))

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
