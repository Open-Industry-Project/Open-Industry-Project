// What actually lives in material.userData across the demo? Grounds the denylist for a generic
// render-identity hash: which keys are render state (must split a merge) vs engine bookkeeping
// (must not), and how many distinct values each key takes (a key with one value per material
// would over-split every pool if hashed).
//   Run: node e2e/probes/material-userdata-census.mjs
/* global process, console, window, localStorage */
import { startServer } from '../_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu'] })
try {
  for (const [tag, q] of [['webgl', 'nowebgpu'], ['webgpu', 'webgpu']]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
    await page.goto(`http://localhost:${PORT}/app/?scene=demo&${q}`)
    await page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 90000 })
    await page.waitForFunction(() => window.__oip.view.stagedReveal === false, { timeout: 90000 }).catch(() => {})
    await page.waitForTimeout(7000)
    const r = await page.evaluate(() => {
      const v = window.__oip.view
      const mats = new Set()
      v.scene.traverse((o) => {
        const list = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
        for (const m of list) if (m) mats.add(m)
      })
      const describe = (x) => {
        if (x === null) return 'null'
        const t = typeof x
        if (t !== 'object' && t !== 'function') return t
        if (t === 'function') return 'function'
        if (x.isTexture) return 'Texture'
        if (x.isColor) return 'Color'
        if (x.isVector2) return 'Vector2'
        if (x.isVector3) return 'Vector3'
        if (x.isMatrix4) return 'Matrix4'
        if (Array.isArray(x)) return `Array(${x.length})`
        return x.constructor?.name ?? 'object'
      }
      const stable = (x) => {
        if (x === null || typeof x !== 'object') return String(x)
        if (x.isColor) return `c${x.getHex()}`
        if (x.isVector2) return `${x.x},${x.y}`
        if (x.isVector3) return `${x.x},${x.y},${x.z}`
        if (x.isTexture) return `t${x.uuid}`
        if (Array.isArray(x)) return `[${x.length}]`
        return describe(x)
      }
      const keys = new Map()
      for (const m of mats) {
        for (const k of Object.keys(m.userData ?? {})) {
          const e = keys.get(k) ?? { types: new Set(), values: new Set(), mats: 0 }
          e.types.add(describe(m.userData[k]))
          e.values.add(stable(m.userData[k]))
          e.mats++
          keys.set(k, e)
        }
      }
      return {
        backend: v.renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl',
        materials: mats.size,
        keys: [...keys].map(([k, e]) => ({ k, types: [...e.types].join('|'), distinct: e.values.size, mats: e.mats })).sort((a, b) => b.mats - a.mats),
      }
    })
    console.log(`\n[${r.backend}] ${r.materials} materials in the scene`)
    console.log('  key                         onMats  distinctValues  types')
    for (const x of r.keys) console.log(`  ${x.k.padEnd(26)} ${String(x.mats).padStart(6)} ${String(x.distinct).padStart(15)}  ${x.types}`)
    await page.close()
  }
} finally { await browser.close().catch(() => {}); vite.kill() }
