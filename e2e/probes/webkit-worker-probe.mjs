// Which worker construct does WebKit refuse under COEP? Companion probe to
// e2e/probes/webkit-mt-smoke.mjs: that smoke showed WebKit (isolated, SAB available) blocking the
// sim worker's module graph with "Worker load was blocked by Cross-Origin-Embedder-Policy"
// while Chromium passes. This isolates the failing layer: blob workers, plain same-origin
// module workers, or vite's dev-only ?worker_file module graph (which imports
// /node_modules/vite/dist/client/env.mjs - a file that does not exist in prod bundles).
// Run: node e2e/probes/webkit-worker-probe.mjs
/* global process, console, window, Worker, Blob, URL */
import { startServer } from '../_server.mjs'
import { chromium, webkit } from 'playwright'

const { port: PORT, vite } = await startServer()

async function probe(name, browserType) {
  const browser = await browserType.launch({ headless: true })
  const page = await browser.newPage()
  const errs = []
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().split('\n')[0]) })
  try {
    await page.goto(`http://localhost:${PORT}/app/`)
    const results = await page.evaluate(async (port) => {
      const tryWorker = (make, listenReady) => new Promise((resolve) => {
        let w
        const done = (v) => { try { w?.terminate() } catch { /* ok */ } resolve(v) }
        const t = setTimeout(() => done('TIMEOUT (no message/error in 20s)'), 20000)
        try {
          w = make()
          w.onmessage = (e) => { if (!listenReady || e.data?.type === 'ready') { clearTimeout(t); done('OK') } }
          w.onerror = (e) => { clearTimeout(t); done(`ERROR ${e.message || '(opaque)'}`) }
        } catch (e) { clearTimeout(t); done(`THROW ${String(e).split('\n')[0]}`) }
      })
      const blobUrl = (src, type) => URL.createObjectURL(new Blob([src], { type: type || 'text/javascript' }))
      const out = {}
      out.blobClassic = await tryWorker(() => new Worker(blobUrl('postMessage(1)')))
      out.blobModule = await tryWorker(() => new Worker(blobUrl('postMessage(1)'), { type: 'module' }))
      out.urlModule = await tryWorker(() =>
        new Worker(`http://localhost:${port}/node_modules/vite/dist/client/env.mjs`, { type: 'module' }))
      out.blobModuleImportingUrl = await tryWorker(() =>
        new Worker(blobUrl(`import 'http://localhost:${port}/node_modules/vite/dist/client/env.mjs'; postMessage(1)`), { type: 'module' }))
      // the exact construct the app uses (name 'jolt' = single-thread build; ready arrives
      // after the wasm compiles, hence the generous timeout above)
      out.appSimWorker = await tryWorker(
        () => new Worker(`/src/sim/worker.ts?worker_file&type=module`, { type: 'module', name: 'jolt' }),
        true,
      )
      return out
    }, PORT)
    return { name, results, errs: errs.slice(0, 8) }
  } finally {
    await browser.close()
  }
}

try {
  for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
    const { results, errs } = await probe(name, type)
    console.log(`\n=== ${name} ===`)
    for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(24)} ${v}`)
    for (const e of errs) console.log(`  ! ${e}`)
  }
} finally {
  vite.kill('SIGTERM')
}
process.exit(0)
