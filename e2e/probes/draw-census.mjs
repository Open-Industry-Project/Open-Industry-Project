/* global console, process, window */
// Draw-list census: what still costs a draw per object, bucketed by owner.
//
// Finds candidates for instancing like the sensor beams. It walks the live scene and buckets every drawable by the part /
// container that owns it, splitting plain Mesh (one draw each) from InstancedMesh + the pool
// (already batched), and counts distinct materials as the pipeline proxy. A bucket with many plain
// meshes over few distinct geometries+materials is the shape that instancing collapses.
//
// Run: node e2e/probes/draw-census.mjs [sceneKey]   (default: the bundled demo)
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'

const SCENE = process.argv[2] ?? 'demo'
const settle = async (page, ms) => { await page.waitForTimeout(ms); for (let i = 0; i < 6; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))) }

async function launchWebGPU() {
  for (const opts of [
    { channel: 'msedge', headless: false, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: false, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
  ]) { try { return await chromium.launch(opts) } catch { /* next */ } }
  return null
}

async function main() {
  const browser = await launchWebGPU()
  if (!browser) { console.log('SKIP: no browser'); return }
  const { port, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* */ } })
  try {
    await page.goto(`http://localhost:${port}/app/?scene=${SCENE}`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 40000 })
    await page.waitForSelector('.viewport-cover.ready', { timeout: 60000 }).catch(() => {})
    // a positive settle signal (AGENTS.md): part GLBs load async, and after a timed wait whole parts
    // can still be absent or un-pooled, so buckets change run to run
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000, polling: 500 })
    await settle(page, 4000)

    const census = await page.evaluate(() => {
      const v = window.__oip.view
      const st = window.__oip.store
      const byId = new Map(st.getState().scene.parts.map((p) => [p.id, p]))
      const buckets = new Map()
      // nearest ancestor carrying a partId names the bucket; else the top-level scene child does
      const ownerOf = (o) => {
        let cur = o
        let top = null
        while (cur && cur !== v.scene) {
          if (typeof cur.userData?.partId === 'string') {
            const p = byId.get(cur.userData.partId)
            return p ? (p.packageId ?? p.type) : 'part:?'
          }
          top = cur
          cur = cur.parent
        }
        return top ? (top.name || top.type || 'scene-child') : 'scene'
      }
      // How a material looks, as opposed to which object it is. Two clones with the same
      // fingerprint render identically, so meshes sharing (geometry, fingerprint) are mergeable;
      // if they differ only in `color`, they merge via instanceColor (the sensor-beam shape).
      const look = (m) => [m.type, m.map?.uuid ?? '-', m.normalMap?.uuid ?? '-', m.roughnessMap?.uuid ?? '-', m.emissiveMap?.uuid ?? '-', m.transparent, m.opacity, m.side, m.alphaTest, m.roughness, m.metalness, m.emissive?.getHexString?.() ?? '-'].join('|')
      const parts = new Map()
      v.scene.traverseVisible((o) => {
        if (!o.isMesh && !o.isInstancedMesh && !o.isLineSegments && !o.isLine && !o.isPoints) return
        const key = ownerOf(o)
        let b = buckets.get(key)
        if (!b) buckets.set(key, (b = { plain: 0, instanced: 0, instances: 0, lines: 0, geos: new Set(), mats: new Set(), looks: new Set(), slots: new Set(), colorSlots: new Set() }))
        if (o.isInstancedMesh) { b.instanced++; b.instances += o.count ?? 0 } else if (o.isMesh) b.plain++
        else b.lines++
        if (o.geometry) b.geos.add(o.geometry.uuid)
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!m) continue
          b.mats.add(m.uuid)
          b.looks.add(look(m))
          // a mergeable slot: same geometry + same look + same colour == one instanced draw
          b.slots.add(`${o.geometry?.uuid ?? '-'}#${look(m)}#${m.color?.getHexString?.() ?? '-'}`)
          // ...and if colour is the only difference, instanceColor merges them too
          b.colorSlots.add(`${o.geometry?.uuid ?? '-'}#${look(m)}`)
        }
      })
      for (const p of st.getState().scene.parts) {
        const k = p.packageId ?? p.type
        parts.set(k, (parts.get(k) ?? 0) + 1)
      }
      const rows = [...buckets].map(([k, b]) => ({
        owner: k, n: parts.get(k) ?? 0, plain: b.plain, lines: b.lines, instanced: b.instanced, instances: b.instances,
        geos: b.geos.size, mats: b.mats.size, looks: b.looks.size, slots: b.slots.size, colorSlots: b.colorSlots.size,
      }))
      rows.sort((a, b) => (b.plain + b.lines) - (a.plain + a.lines))
      const sum = (f) => rows.reduce((n, r) => n + f(r), 0)
      return { rows, totals: { plain: sum((r) => r.plain), lines: sum((r) => r.lines), instanced: sum((r) => r.instanced), instances: sum((r) => r.instances) } }
    })

    console.log(`\nscene=${SCENE}  visible drawables: ${census.totals.plain} plain mesh + ${census.totals.lines} line + ${census.totals.instanced} instanced (${census.totals.instances} instances)\n`)
    // slots  = draws if identical (geometry, material-look, colour) meshes were instanced
    // +tint  = draws if colour-only differences were folded onto instanceColor as well
    console.log('owner                             parts  plain  line  inst   geos  mats  looks | slots  +tint')
    for (const r of census.rows.slice(0, 28)) {
      const cols = [r.n, r.plain, r.lines, r.instanced, r.geos, r.mats, r.looks].map((x, i) => String(x).padStart(i === 0 ? 5 : i < 4 ? 6 : 6))
      console.log(`${r.owner.padEnd(32)}${cols.join('')} |${String(r.slots).padStart(6)}${String(r.colorSlots).padStart(7)}`)
    }
    const win = census.rows.filter((r) => r.plain >= 6 && r.colorSlots * 3 <= r.plain)
    console.log(`\ncollapsible (plain >= 6 and >= 3x fewer draws after instancing):`)
    for (const r of win) console.log(`  ${r.owner.padEnd(30)} ${r.plain} plain -> ${r.slots} exact / ${r.colorSlots} with per-instance tint`)
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
  }
}

main().catch((e) => { console.error('crashed:', e); process.exit(1) })
