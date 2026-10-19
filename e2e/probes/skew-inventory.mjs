// Debug: inventory of a roller conveyor's drawn meshes over time - on load, and across a live skew edit.
// Reports every visible mesh under the part (name/role/tri count) plus what the instance pool has
// hidden and what it re-emits, so "which pieces are missing, and until when" is a fact not a guess.
// Headed (WebGPU). Run: node e2e/probes/skew-inventory.mjs [--nobundle] [--nopool]
/* global process, console, window, localStorage */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'
import { cleanShot } from '../_shot.mjs'

const { port, vite } = await startServer()
const SHOTDIR = 'e2e/shots'
const NOBUNDLE = process.argv.includes('--nobundle')
const NOPOOL = process.argv.includes('--nopool')
const log = (...a) => console.log(...a)

const SCENE = (skew) => ({
  version: 1,
  parts: [{ id: 'bed', type: 'part', packageId: 'oip.roller-conveyor', name: 'bed', position: [0, 2, 0], rotationY: 0, params: { length: 4, width: 1.524, skew } }],
})

function inventory(page) {
  return page.evaluate(() => {
    const v = window.__oip.view
    let group = null
    v.scene.traverse((o) => {
      if (o.userData && o.userData.partId === 'bed') group = o
    })
    if (!group) return { found: false }
    const own = []
    let hiddenByPool = 0
    group.traverse((o) => {
      if (!o.isMesh) return
      // effective visibility: any hidden ancestor kills the draw
      let vis = true
      for (let n = o; n; n = n.parent) if (!n.visible) { vis = false; break }
      if (o.userData.poolHidden === true) hiddenByPool++
      if (!vis) return
      const pos = o.geometry?.getAttribute?.('position')
      own.push({
        inst: !!o.isInstancedMesh,
        count: o.isInstancedMesh ? o.count : 1,
        verts: pos ? pos.count : 0,
        dbl: o.material?.side === 2,
        shadow: o.castShadow === true,
      })
    })
    // the pool's output rows attributed to this part
    let poolRows = 0
    v.scene.traverse((o) => {
      if (o.userData?.instancePool === true && o.isInstancedMesh && o.visible) poolRows += o.count
    })
    return {
      found: true,
      ownDrawn: own.length,
      ownInstanced: own.filter((o) => o.inst).length,
      ownPlain: own.filter((o) => !o.inst).length,
      plate: own.some((o) => !o.inst && o.dbl && !o.shadow),
      hiddenByPool,
      poolRows,
      records: globalThis.__oipBundleCam?.records ?? null,
    }
  })
}

async function main() {
  const browser = await chromium.launch({ headless: false, args: ['--disable-features=CalculateNativeWinOcclusion', '--disable-gpu-vsync'] })
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  try {
    await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
    const url = `http://localhost:${port}/app/?webgpu${NOBUNDLE ? '&nobundle' : ''}${NOPOOL ? '&noinstancepool' : ''}`
    await page.goto(url)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 30000 })
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 30000 })
    await page.waitForTimeout(800)

    mkdirSync(SHOTDIR, { recursive: true })
    const tag = `${NOBUNDLE ? 'nb' : 'b'}${NOPOOL ? '-np' : ''}`
    log(`mode: ${NOBUNDLE ? 'nobundle' : 'bundle'}${NOPOOL ? ' + nopool' : ''}   backend=${await page.evaluate(() => window.__oip.view.renderer?.constructor?.name)}`)

    await page.evaluate((s) => window.__oip.store.loadScene(s), SCENE(0))
    await page.evaluate(() => window.__oip.view.setCameraPose({ px: 2.6, py: 3.6, pz: 2.6, tx: 0.9, ty: 2.0, tz: 0 }))
    log('\n--- after loadScene(skew 0) ---')
    log('  t(ms)  ownDrawn  plain  inst  plate  poolHidden  poolRows  records')
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(500)
      const inv = await inventory(page)
      log(`  ${String((i + 1) * 500).padStart(5)}  ${String(inv.ownDrawn).padStart(8)}  ${String(inv.ownPlain).padStart(5)}  ${String(inv.ownInstanced).padStart(4)}  ${String(inv.plate).padStart(5)}  ${String(inv.hiddenByPool).padStart(10)}  ${String(inv.poolRows).padStart(8)}  ${String(inv.records).padStart(7)}`)
    }
    await cleanShot(page, `${SHOTDIR}/skewinv-${tag}-straight.png`)

    log('\n--- after commit(skew 35) ---')
    await page.evaluate((s) => window.__oip.store.commit('Edit skew', s), SCENE(35))
    log('  t(ms)  ownDrawn  plain  inst  plate  poolHidden  poolRows  records')
    for (let i = 0; i < 16; i++) {
      await page.waitForTimeout(500)
      const inv = await inventory(page)
      log(`  ${String((i + 1) * 500).padStart(5)}  ${String(inv.ownDrawn).padStart(8)}  ${String(inv.ownPlain).padStart(5)}  ${String(inv.ownInstanced).padStart(4)}  ${String(inv.plate).padStart(5)}  ${String(inv.hiddenByPool).padStart(10)}  ${String(inv.poolRows).padStart(8)}  ${String(inv.records).padStart(7)}`)
      if (i === 0) await cleanShot(page, `${SHOTDIR}/skewinv-${tag}-skew-t500.png`)
      if (i === 3) await cleanShot(page, `${SHOTDIR}/skewinv-${tag}-skew-t2000.png`)
    }
    await cleanShot(page, `${SHOTDIR}/skewinv-${tag}-skew-final.png`)
    const errs = errors.filter((e) => !/GLTFLoader|Couldn't load texture/i.test(e))
    if (errs.length) log('\nconsole errors:', JSON.stringify(errs.slice(0, 6)))
  } finally {
    await browser.close()
    vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
