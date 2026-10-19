// Which dispose sites run while the scene is live (i.e. while a recorded render bundle could be
// holding what they free)? Patches BufferGeometry/InstancedMesh dispose as soon as the view exists,
// records a src/render call site per call, and prints them grouped - already-converted sites show
// gpuRetire.ts in the stack, so anything without it is still freeing inline.
//   Run: node e2e/probes/gpu-dispose-trace.mjs [--drag]
/* global process, console, window, localStorage, Error */
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'

const DRAG = process.argv.includes('--drag')

async function launchWebGPU() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) { try { return await chromium.launch(opts) } catch { /* next */ } }
  return null
}

const PATCH = () => {
  const view = window.__oip.view
  window.__disposeLog = []
  // walk up to whichever prototype actually owns `dispose` (BoxGeometry inherits it from
  // BufferGeometry; patching the subclass would shadow it for that subclass only)
  const ownerOf = (obj) => {
    let p = Object.getPrototypeOf(obj)
    while (p && !Object.prototype.hasOwnProperty.call(p, 'dispose')) p = Object.getPrototypeOf(p)
    return p
  }
  const protos = new Map()
  view.scene.traverse((o) => {
    if (o.geometry && !protos.has('geo')) protos.set('geo', ownerOf(o.geometry))
    if (o.isInstancedMesh && !protos.has('inst')) protos.set('inst', ownerOf(o))
    if (o.isMesh && !o.isInstancedMesh && !protos.has('mesh')) protos.set('mesh', ownerOf(o))
  })
  for (const [kind, proto] of protos) {
    if (!proto || !proto.dispose) continue
    const orig = proto.dispose
    proto.dispose = function (...a) {
      const stack = new Error().stack || ''
      const site = stack.split('\n')
        .map((l) => l.trim())
        .filter((l) => /\/src\/render\//.test(l))
        .slice(0, 3)
        .map((l) => l.replace(/^at\s+/, '').replace(/.*\/src\/render\//, 'render/').replace(/\?.*$/, ''))
        .join('  <-  ')
      window.__disposeLog.push({ kind, site: site || '(no src/render frame)' })
      return orig.apply(this, a)
    }
  }
  return protos.size
}

async function main() {
  const browser = await launchWebGPU()
  if (!browser) { console.log('no WebGPU browser'); return }
  const { port, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  try {
    await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ignore */ } })
    await page.goto(`http://localhost:${port}/app/?webgpu&scene=demo`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view), { timeout: 30000 })
    console.log('renderer:', await page.evaluate(() => (window.__oip.view.renderer.isWebGPURenderer ? 'WebGPU' : 'WebGL')))
    // patch as early as the view exists - the building assembly and pool bakes continue after this
    console.log('patched prototypes:', await page.evaluate(PATCH))
    await page.locator('text=Loading models').waitFor({ state: 'hidden', timeout: 60000 }).catch(() => {})
    await page.waitForFunction(() => window.__oip?.view?.incrementalWarmReady === true, { timeout: 90000 }).catch(() => {})
    await page.waitForTimeout(6000)

    const dump = await page.evaluate(() => {
      const by = new Map()
      for (const e of window.__disposeLog) {
        const key = `${e.kind}  ${e.site}`
        by.set(key, (by.get(key) ?? 0) + 1)
      }
      const gpu = globalThis.__oipGpuErrors
      return {
        rows: [...by.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${String(n).padStart(4)}x  ${k}`),
        gpuErrors: gpu ? gpu.count : 'watch missing',
      }
    })
    console.log(`\nGPU errors after load: ${dump.gpuErrors}\n`)
    console.log('dispose call sites while the scene was live (deferred ones show gpuRetire):')
    for (const r of dump.rows) console.log(r)
    void DRAG
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(0)
}
main()
