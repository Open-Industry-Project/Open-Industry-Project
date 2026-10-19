// Diagnostic: what occupies the main thread during the loading cover's 0.4 s fade.
//
// e2e/probes/cover-fade.mjs shows the fade freezing mid-curve behind a 170-250 ms long task; this names
// the function. Records a CDP sampling profile across the load, then attributes self-time for the
// samples that fall inside [cover lift, lift + 400 ms].
//
// Run: node e2e/probes/cover-fade-profile.mjs        (ARM=webgl|webgpu FLAGS=&gfx=low)
// FLAGS=&gfx=low forces the mobile tier, which warms the interaction extras behind the cover
// (viewWarmFlags.ts wantsDeferredWarm). It also switches the rest of the mobile quality preset.
/* global process, console, window, document, performance, requestAnimationFrame, localStorage */
import { startServer } from '../_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const ARM = process.env.ARM || 'webgl'
const FLAGS = process.env.FLAGS || ''
const SCENE = process.env.SCENE || 'demo'
const FADE_MS = 400

function probeInit() {
  const P = (window.__fp = { lift: null, done: false })
  const poll = () => {
    const now = performance.now()
    const cover = document.querySelector('.viewport-cover')
    if (cover && cover.classList.contains('ready') && P.lift == null) P.lift = now
    if (P.lift != null && now - P.lift > 600) { P.done = true; return }
    requestAnimationFrame(poll)
  }
  requestAnimationFrame(poll)
}

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => { try { localStorage.clear() } catch { /* pre-origin */ } })
  await page.addInitScript(probeInit)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 }) // 0.2 ms - fine enough for a 200 ms task
  const q = ARM === 'webgpu' ? '?webgpu' : '?nowebgpu'
  await cdp.send('Profiler.start')
  await page.goto(`http://localhost:${PORT}/app/${q}&scene=${SCENE}${FLAGS}`, { waitUntil: 'commit' })
  await page.waitForFunction(() => window.__fp && window.__fp.done, null, { timeout: 120000 })
  const lift = await page.evaluate(() => window.__fp.lift)
  const { profile } = await cdp.send('Profiler.stop')

  // Align the profiler clock (µs) to performance.now() (ms): the profile starts at page start, and
  // `lift` is measured from timeOrigin, so anchor on the profile's own start.
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const t0 = profile.startTime
  let t = t0
  const self = new Map()
  let inWindow = 0
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i] ?? 0
    const relMs = (t - t0) / 1000
    if (relMs < lift || relMs > lift + FADE_MS) continue
    inWindow++
    const n = byId.get(profile.samples[i])
    if (!n) continue
    const f = n.callFrame
    const key = `${f.functionName || '(anonymous)'}  ${String(f.url).split('/').slice(-1)[0]}:${f.lineNumber + 1}`
    self.set(key, (self.get(key) ?? 0) + ((profile.timeDeltas[i] ?? 0) / 1000))
  }
  console.log(`\n[${ARM}${FLAGS}] cover lift at ${Math.round(lift)}ms; ${inWindow} samples inside the ${FADE_MS}ms fade\n`)
  console.log('heaviest SELF time during the fade:')
  for (const [k, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
    console.log(`  ${ms.toFixed(1).padStart(7)} ms   ${k}`)
  }
  await page.close()
} finally {
  await browser.close()
  vite.kill()
}
