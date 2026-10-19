// The main key light's shadow map is frozen (env.ts) and refreshed only on frames where something that casts
// into it can have moved (viewBundles.ts refreshKeyShadowIfDirty). The risk is a stale shadow: a part
// that moved while its shadow stayed where it was. Pixels are the only reliable check, so this A/Bs the
// frozen default against `?liveshadow` (the per-frame render) on one scene and one edit:
//   1. the default arm really runs frozen (else the A/B compares a thing with itself) and on WebGPU;
//   2. the edit is visible - moving a part changes the frame (else every later check is vacuous);
//   3. after the edit, frozen and live agree far more closely than the edit changed the frame. A missed
//      refresh leaves the old shadow in place, which differs from live about as much as the move did -
//      and a third arm with the refresh cut proves that difference shows (the negative control).
// Stopped sim on purpose: a running sim refreshes every frame anyway, so only parked edits can show the bug.
// Run: node e2e/verify-key-shadow-freeze.mjs
/* global process, console, window, document, Image */
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'

let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

const { port, vite } = await startServer()

async function launch() {
  for (const opts of [
    { channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: true, args: ['--enable-unsafe-webgpu'] },
  ]) {
    try { return await chromium.launch(opts) } catch { /* next */ }
  }
  throw new Error('no chromium')
}

// settle on positive signals (the staged reveal painted, the warm drained, every part GLB loaded)
async function boot(page, url) {
  await page.goto(url)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 60000 })
  await page.waitForTimeout(1500)
  // cold vite can trigger a dep re-optimize full reload mid-run - settle it, then re-goto
  await page.goto(url)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 60000 })
  await page.waitForFunction(() => {
    const v = window.__oip.view
    return v.renderer?.backend === undefined || v.incrementalWarmReady === true
  }, { timeout: 90000 })
  await page.waitForFunction(() => window.__oip.view.warming.size === 0 && window.__oip.view.warmQueue.size === 0, { timeout: 60000 })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, { timeout: 120000 })
  // pin the roof off so its camera-driven auto-hide can't differ between the two page loads
  await page.evaluate(() => {
    const store = window.__oip.store
    const s = store.getState().scene
    store.loadScene({ ...s, parts: s.parts.map((p) => (p.type === 'building' ? { ...p, params: { ...p.params, roofVisible: false } } : p)) })
  })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, { timeout: 120000 })
  await page.waitForTimeout(1500)
}

// the mover: the demo's palletizer robot (a big caster standing on open floor), else the first SDK part;
// deterministic across both loads of the same scene. Every demo part sits under a group, so no parent filter.
async function movePart(page) {
  return page.evaluate(() => {
    const store = window.__oip.store
    const s = store.getState().scene
    const target = s.parts.find((p) => p.type === 'part' && p.name === 'Palletizer') ?? s.parts.find((p) => p.type === 'part')
    if (!target) return null
    const moved = { ...target, position: [target.position[0], target.position[1], target.position[2] + 2.5] }
    store.commit('Move', { ...s, parts: s.parts.map((p) => (p.id === target.id ? moved : p)) })
    return target.id
  })
}

async function arm(browser, query, tag, { stale = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* private mode */ } })
  try {
    await boot(page, `http://localhost:${port}/app/?scene=demo${query}`)
    const info = await page.evaluate(() => {
      let frozen = null
      window.__oip.view.scene.traverse((o) => {
        if (o.isDirectionalLight && o.castShadow && o.shadow.camera.layers.isEnabled(0)) frozen = o.shadow.autoUpdate === false
      })
      return { frozen, webgpu: window.__oip.view.renderer?.backend?.isWebGPUBackend === true }
    })
    const before = readFileSync(await cleanShot(page, `e2e/shots/key-shadow-${tag}-before.png`))
    // the negative control: cut the refresh, so the frozen map keeps the pre-edit shadow
    if (stale) await page.evaluate(() => { window.__oip.view.env.refreshKeyShadow = () => {} })
    const moved = await movePart(page)
    await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, { timeout: 60000 })
    // well past the scene-activity frame the edit opens: a parked frame is what a stale shadow survives into
    await page.waitForTimeout(2500)
    const after = readFileSync(await cleanShot(page, `e2e/shots/key-shadow-${tag}-after.png`))
    return { ...info, moved, before, after }
  } finally {
    await page.close()
  }
}

// share of pixels whose max channel delta exceeds 12 (above PNG/dither noise, below any real shading change)
async function diffShare(browser, a, b) {
  const page = await browser.newPage()
  try {
    return await page.evaluate(async ([a, b]) => {
      const load = (s) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + s })
      const [ia, ib] = await Promise.all([load(a), load(b)])
      const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(ia, 0, 0); const da = ctx.getImageData(0, 0, c.width, c.height).data
      ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(ib, 0, 0); const db = ctx.getImageData(0, 0, c.width, c.height).data
      let bad = 0
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]))
        if (d > 12) bad++
      }
      return bad / (da.length / 4)
    }, [a.toString('base64'), b.toString('base64')])
  } finally {
    await page.close()
  }
}

const browser = await launch()
try {
  const frozen = await arm(browser, '', 'frozen')
  const live = await arm(browser, '&liveshadow', 'live')
  const stale = await arm(browser, '', 'stale', { stale: true })
  check('the default arm runs the main key shadow frozen', frozen.frozen === true, `autoUpdate=false: ${frozen.frozen}`)
  check('the ?liveshadow arm runs it live (the A/B has two arms)', live.frozen === false, `autoUpdate=false: ${live.frozen}`)
  check('both arms render on WebGPU (the bundled path is the one that decides when the shadow renders)', frozen.webgpu && live.webgpu, `frozen=${frozen.webgpu} live=${live.webgpu}`)
  check('both arms moved the same part', !!frozen.moved && frozen.moved === live.moved, `${frozen.moved} / ${live.moved}`)
  const edit = await diffShare(browser, frozen.before, frozen.after)
  const beforeArms = await diffShare(browser, frozen.before, live.before)
  const afterArms = await diffShare(browser, frozen.after, live.after)
  check('the edit is visible (guards the next check)', edit > 0.002, `${(edit * 100).toFixed(3)}% of pixels changed`)
  check('before the edit, frozen and live agree (the baseline noise between two loads)', beforeArms < 0.005, `${(beforeArms * 100).toFixed(3)}%`)
  // proves the check above can fail: with the refresh cut, the shadow must visibly lag the part
  const staleArms = await diffShare(browser, stale.after, live.after)
  check('[control] with the refresh cut, the shadow visibly lags the part (the check below can fail)',
    stale.moved === live.moved && staleArms > Math.max(0.002, beforeArms * 4), `${(staleArms * 100).toFixed(3)}% stale vs live`)
  check('after the edit, frozen and live still agree: the shadow followed the part', afterArms < Math.max(0.005, beforeArms * 2) && afterArms < edit / 4,
    `${(afterArms * 100).toFixed(3)}% vs edit ${(edit * 100).toFixed(3)}%`)
} finally {
  await browser.close()
  vite.kill()
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
process.exit(failures ? 1 : 0)
