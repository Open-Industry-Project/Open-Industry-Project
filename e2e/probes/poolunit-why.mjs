/* global console, process, window */
// Why aren't the big plain-mesh buckets pooled? Counts poolUnit tagging per package on the live
// demo scene, so the answer is measured rather than read off rig.ts's exclusion list.
// Run: node e2e/probes/poolunit-why.mjs
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'

const settle = async (page, ms) => { await page.waitForTimeout(ms); for (let i = 0; i < 6; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))) }

async function main() {
  const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] })
  const { port, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* */ } })
  try {
    await page.goto(`http://localhost:${port}/app/?scene=demo`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 40000 })
    await page.waitForSelector('.viewport-cover.ready', { timeout: 60000 }).catch(() => {})
    await settle(page, 4000)

    const out = await page.evaluate(() => {
      const v = window.__oip.view
      const st = window.__oip.store
      const byId = new Map(st.getState().scene.parts.map((p) => [p.id, p]))
      const rows = new Map()
      const ownerOf = (o) => {
        let cur = o
        while (cur && cur !== v.scene) {
          if (typeof cur.userData?.partId === 'string') { const p = byId.get(cur.userData.partId); return p ? (p.packageId ?? p.type) : '?' }
          cur = cur.parent
        }
        return 'scene'
      }
      v.scene.traverseVisible((o) => {
        if (!o.isMesh || o.isInstancedMesh) return
        const k = ownerOf(o)
        let r = rows.get(k)
        if (!r) rows.set(k, (r = { tagged: 0, untagged: 0, kids: 0, transparent: 0, offLayer: 0, multiMat: 0 }))
        if (o.userData.poolUnit === true) r.tagged++
        else {
          r.untagged++
          if (o.children.length > 0) r.kids++
          const m = Array.isArray(o.material) ? null : o.material
          if (!m) r.multiMat++
          else if (m.transparent) r.transparent++
          if (o.layers.mask !== 1) r.offLayer++
        }
      })
      return [...rows].map(([owner, r]) => ({ owner, ...r })).sort((a, b) => b.untagged - a.untagged)
    })

    console.log('\nplain visible meshes: poolUnit-tagged vs not, and which hard exclusions apply\n')
    console.log('owner                          tagged  untagged | has-kids  transparent  off-layer  multi-mat')
    for (const r of out.slice(0, 14)) {
      console.log(`${r.owner.padEnd(30)}${String(r.tagged).padStart(6)}${String(r.untagged).padStart(10)} |${String(r.kids).padStart(9)}${String(r.transparent).padStart(13)}${String(r.offLayer).padStart(11)}${String(r.multiMat).padStart(11)}`)
    }
    console.log('\n(untagged with NO hard exclusion => blocked only by rig.ts\'s material-state opt-out)')
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
  }
}

main().catch((e) => { console.error('crashed:', e); process.exit(1) })
