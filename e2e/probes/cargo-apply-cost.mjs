// What does the CPU-side cargo instance update (SimBoxes.apply) actually cost per frame?
//
// apply() composes a TRS matrix, converts a colour and allocates a meta object per body, once per
// worker frame (SIM_HZ=60, <=MAX_BOXES=200 spawned bodies + any authored cargo). It is the candidate
// for "compose the matrix in the vertex shader instead", so this measures how much that could save
// before anyone builds the node-material path for both backends.
//
// Wraps view.boxes.apply with a timer (an own property shadowing the prototype method), samples a
// window while the sim runs, and reports self-time per call / per second next to the view's own
// cpuMs + gpuMs for comparison.
/* global process, console, window, localStorage, performance, requestAnimationFrame */
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'

const SECONDS = Number(process.argv[2] ?? 6)
const { port, vite } = await startServer()
const browser = await chromium.launch({
  headless: false,
  args: ['--disable-features=CalculateNativeWinOcclusion', '--enable-unsafe-webgpu'],
})
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const url = `http://localhost:${port}/app/?scene=demo&webgpu`
  const ready = () =>
    page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 60000 })
  await page.goto(url)
  await ready()
  await page.waitForTimeout(2000)
  await page.goto(url) // warm-vite re-goto, same as the balance probe
  await ready()
  await page.waitForFunction(() => window.__oip.view.stagedReveal === false, { timeout: 45000 })
  await page.waitForTimeout(3000)

  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForTimeout(8000) // let the spawners fill the line so bodies are at steady state

  const result = await page.evaluate(
    (secs) =>
      new Promise((res) => {
        const view = window.__oip.view
        const boxes = view.boxes
        if (!boxes || typeof boxes.apply !== 'function') {
          res({ error: 'view.boxes.apply not reachable - field renamed or minified' })
          return
        }
        const proto = Object.getPrototypeOf(boxes).apply
        let totalMs = 0
        let calls = 0
        let bodies = 0
        let maxBodies = 0
        const per = []
        // own property shadows the prototype method; deleted below to restore
        boxes.apply = function wrapped(frame) {
          const t0 = performance.now()
          proto.call(this, frame)
          const dt = performance.now() - t0
          totalMs += dt
          calls++
          bodies += frame.count
          if (frame.count > maxBodies) maxBodies = frame.count
          if (per.length < 4000) per.push(dt)
          return undefined
        }
        const t0 = performance.now()
        const done = () => {
          const wall = performance.now() - t0
          delete boxes.apply
          per.sort((a, b) => a - b)
          const s = view.getStats()
          res({
            windowSec: +(wall / 1000).toFixed(2),
            calls,
            callsPerSec: +(calls / (wall / 1000)).toFixed(1),
            avgBodies: calls ? Math.round(bodies / calls) : 0,
            maxBodies,
            applyMsPerCallMed: per.length ? +per[Math.floor(per.length / 2)].toFixed(4) : null,
            applyMsPerCallP90: per.length ? +per[Math.floor(per.length * 0.9)].toFixed(4) : null,
            applyMsPerSec: +(totalMs / (wall / 1000)).toFixed(3),
            applyPctOfOneCore: +((totalMs / wall) * 100).toFixed(2),
            viewCpuMs: +s.cpuMs.toFixed(2),
            viewGpuMs: s.gpuMs === null ? null : +s.gpuMs.toFixed(2),
            draws: s.drawCalls,
            tris: s.triangles,
          })
        }
        const poll = () => (performance.now() - t0 < secs * 1000 ? requestAnimationFrame(poll) : done())
        requestAnimationFrame(poll)
      }),
    SECONDS,
  )

  console.log(JSON.stringify(result, null, 2))
  if (!result.error) {
    const budget = result.viewCpuMs
    const perFrameEquiv = result.applyMsPerSec / 60 // apply cost amortised over a 60fps frame
    console.log(
      `\napply() = ${perFrameEquiv.toFixed(3)} ms per 60fps frame ` +
        `(${((perFrameEquiv / budget) * 100).toFixed(1)}% of the ${budget} ms render-CPU budget) ` +
        `at ${result.avgBodies} bodies.`,
    )
  }
} finally {
  await browser.close()
  vite.kill()
}
