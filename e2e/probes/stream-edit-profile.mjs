// Where a streamed edit's time goes in a big scene (prod build): demo, everything duplicated, cargo duplicated again,
// then a CPU profile over a conveyor-speed stream through store.setTransient. Inclusive ms under setTransient.
//   Run: npm run build && node e2e/probes/stream-edit-profile.mjs
/* global console, window, localStorage, performance, requestAnimationFrame, setTimeout */
import { chromium } from 'playwright'
import { serveDist } from '../_edge-server.mjs'

const { port, close } = await serveDist()
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ignore */ } })
  await page.goto(`http://localhost:${port}/app/?scene=demo&hook`)
  await page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 90000 })
  await page.waitForFunction(() => window.__oip.view.stagedReveal === false, { timeout: 60000 })
  await page.waitForTimeout(3000)
  await page.evaluate(async () => {
    const store = window.__oip.store
    store.selectMany(store.getState().scene.parts.filter((p) => p.type === 'part' && !/^oip.(box|pallet)$/.test(p.packageId ?? '')).map((p) => p.id))
    store.duplicateSelection()
    store.clearSelection()
    await new Promise((r) => setTimeout(r, 3000))
    store.selectMany(store.getState().scene.parts.filter((p) => /^oip\.(box|pallet|unit-load)$/.test(p.packageId ?? '')).map((p) => p.id))
    store.duplicateSelection()
    store.clearSelection()
    await new Promise((r) => setTimeout(r, 3000))
  })
  await page.waitForTimeout(3000)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
  await cdp.send('Profiler.start')
  const ms = await page.evaluate(async () => {
    const store = window.__oip.store
    const start = store.getState().scene
    const target = start.parts.find((p) => p.packageId === 'oip.roller-conveyor')
    const out = []
    for (let i = 1; i <= 120; i++) {
      const scene = { ...start, parts: start.parts.map((p) => (p.id === target.id ? { ...p, params: { ...p.params, speed: 1 + 0.01 * i } } : p)) }
      const t = performance.now()
      store.setTransient(scene)
      out.push(performance.now() - t)
      await new Promise((r) => requestAnimationFrame(r))
    }
    store.setTransient(start)
    out.sort((a, b) => a - b)
    return { median: out[60], parts: start.parts.length }
  })
  const { profile } = await cdp.send('Profiler.stop')
  console.log(`parts ${ms.parts}, median ${ms.median.toFixed(2)} ms per step`)
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const parent = new Map()
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  const dt = new Map()
  for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000)
  const key = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*\/assets\//, '')}:${n.callFrame.lineNumber + 1}:${n.callFrame.columnNumber + 1}`
  // inclusive time per function, counting only samples with setTransient on the stack
  const incl = new Map()
  const self = new Map()
  for (const [id, t] of dt) {
    const stack = []
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) stack.push(byId.get(cur))
    if (!stack.some((n) => n.callFrame.functionName === 'setTransient')) continue
    const s0 = key(stack[0])
    self.set(s0, (self.get(s0) ?? 0) + t)
    const seen = new Set()
    for (const n of stack) {
      const k = key(n)
      if (seen.has(k)) continue
      seen.add(k)
      incl.set(k, (incl.get(k) ?? 0) + t)
    }
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `  ${(v / 120).toFixed(2).padStart(6)} ms/step  ${k}`).join('\n')
  console.log('INCLUSIVE under setTransient:\n' + top(incl, 40))
  console.log('SELF under setTransient:\n' + top(self, 20))
} finally {
  await browser.close().catch(() => {})
  await close?.()
}
