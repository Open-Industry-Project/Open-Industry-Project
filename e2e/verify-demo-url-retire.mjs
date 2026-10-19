// Verify the ?scene=demo entry param is retired end-to-end in the real editor: booting /app/?scene=demo
// loads the demo (persist:false) and marks the session ephemeral; the first persisting edit (a part move,
// which forks the demo into a project of its own) strips scene=demo from the browser URL via history.replaceState - keeping the path + any other params -
// so a later reload can't re-open the demo over the user's own autosaved work. See store.retireDemoUrl.
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { url: BASE, vite } = await startServer()
const DEMO_URL = `${BASE}?scene=demo&keep=1` // 'keep' is an unknown param the app ignores - proves preservation
const log = (...a) => console.log(...a)
const hookReady = () => !!(window.__oip?.store && window.__oip.store.getState().scene.parts.length > 0)
// A cold vite can re-optimize deps mid-load and full-reload the page once; that noise is not the app breaking.
const isColdStartNoise = (t) => /Failed to fetch|custom-part mesh load failed|\[vite\]/.test(t)

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error' && !isColdStartNoise(m.text())) errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push('PAGEERR ' + String(e)))
  try {
    log('[goto]', DEMO_URL)
    await page.goto(DEMO_URL, { timeout: 60000 })
    await page.waitForFunction(hookReady, { timeout: 60000 })
    // Let a cold vite's one-time dep re-optimize + full reload settle, then re-acquire the hook, so the
    // edit below runs against a stable context (the reload destroys it otherwise). Harmless when warm.
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
    await page.waitForTimeout(800)
    await page.waitForFunction(hookReady, { timeout: 60000 })

    // 1) demo booted: the session is flagged ephemeral and the entry param is still in the URL
    const boot = await page.evaluate(() => ({ demoSession: window.__oip.store.demoSession }))
    const urlBefore = page.url()
    log('after boot:', JSON.stringify(boot), urlBefore)
    if (!boot.demoSession) throw new Error('expected store.demoSession === true after ?scene=demo boot')
    if (!/[?&]scene=demo(&|$)/.test(urlBefore)) throw new Error(`expected scene=demo in URL, got ${urlBefore}`)
    if (!/[?&]keep=1(&|$)/.test(urlBefore)) throw new Error(`expected keep=1 in URL, got ${urlBefore}`)

    // 2) the first persisting edit - a part moved through the path every editor gesture goes through. A project
    // holds one scene, so an edit to the demo itself (which forks it) is the case to test.
    await page.evaluate(() => {
      const store = window.__oip.store
      const scene = store.getState().scene
      const i = scene.parts.findIndex((p) => p.type !== 'building')
      const parts = scene.parts.slice()
      parts[i] = { ...parts[i], position: [parts[i].position[0] + 0.05, parts[i].position[1], parts[i].position[2]] }
      store.commit('Move part', { ...scene, parts })
    })
    await page.waitForFunction(() => !window.__oip.store.demoSession, null, { timeout: 20000, polling: 100 }).catch(() => {})
    await page.waitForTimeout(200)

    // 3) scene=demo is gone from the URL; the unrelated param + path survive; the flag cleared
    const after = await page.evaluate(() => ({ demoSession: window.__oip.store.demoSession }))
    const urlAfter = page.url()
    log('after the edit:', JSON.stringify(after), urlAfter)
    if (after.demoSession) throw new Error('expected store.demoSession === false after first persist')
    if (/[?&]scene=/.test(urlAfter)) throw new Error(`scene param NOT retired, still: ${urlAfter}`)
    if (!/[?&]keep=1(&|$)/.test(urlAfter)) throw new Error(`unrelated param keep=1 was dropped: ${urlAfter}`)
    if (!urlAfter.includes('/app/')) throw new Error(`path was mangled: ${urlAfter}`)

    if (errors.length) throw new Error('console/page errors:\n' + errors.join('\n'))
    log('PASS: ?scene=demo retired on first edit; /app/ path + keep=1 preserved')
    await browser.close()
  } catch (e) {
    await browser.close()
    throw e
  }
}

main()
  .then(() => vite.kill())
  .catch((e) => { console.error('FAIL', e); vite.kill(); process.exit(1) })
