// Verify the History dock panel: a "History" tab stacked behind "Scene" in the left dock shows the
// edit feed (store.getEditHistory) - commits append labeled rows, the cursor row highlights, and
// clicking a row jumps the scene to that point (rows past the cursor grey out but stay redoable).
// Drives the real tab strip + row buttons with mouse clicks; edits go through store.commit (the
// same chokepoint every authoring path uses).
// Run: node e2e/verify-history-dock.mjs [--headed] [--shot <path>]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')
const shotIdx = process.argv.indexOf('--shot')
const SHOT = shotIdx !== -1 ? process.argv[shotIdx + 1] : null
let failures = 0
const check = (n, ok, info = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`) }

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  const benign = (s) => /GLTFLoader: Couldn't load texture/.test(s)
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()) })

  try {
    // warm-up visit: a cold vite may re-optimize deps and fully reload the page mid-script
    await page.goto(URL)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 60000 })
    await page.waitForTimeout(3000)
    errors.length = 0
    await page.reload()
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
    await page.waitForTimeout(800)
    const skip = page.locator('button', { hasText: /^Skip tour$/ })
    if (await skip.count()) await skip.first().click({ force: true }).catch(() => {})

    // ---- the tab exists, stacked with Scene in the left dock, Scene in front by default
    const historyTab = page.locator('.dock-slot-tab', { hasText: /^History$/ })
    check('History tab present in a dock', (await historyTab.count()) === 1)
    const sharesSlot = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('.dock-slot-tabs')].find((el) =>
        [...el.querySelectorAll('.dock-slot-tab')].some((b) => b.textContent === 'History'))
      const labels = tabs ? [...tabs.querySelectorAll('.dock-slot-tab')].map((b) => b.textContent) : []
      return { labels, sceneActive: !!tabs?.querySelector('.dock-slot-tab.active') && tabs.querySelector('.dock-slot-tab.active').textContent === 'Scene' }
    })
    check('stacked behind Scene (same slot, Scene active)', sharesSlot.labels.includes('Scene') && sharesSlot.sceneActive,
      `tabs=${sharesSlot.labels.join(',')}`)

    // ---- open it: empty feed message on a fresh scene
    await historyTab.click()
    check('empty feed message', await page.locator('.history-empty').isVisible())

    // ---- author a scene + two edits through the real commit chokepoint
    const loaded = await page.evaluate(() => {
      const st = window.__oip.store
      const scene = st.getState().scene
      const belt = st.getState().bundledPackages.find((p) => p.id === 'oip.belt-conveyor')
      if (!belt) return false
      st.loadScene({ ...scene, parts: [{ id: 'rc_1', type: 'part', packageId: belt.id, position: [0, 0.75, 0], rotationY: 0, params: {} }], packages: [belt] })
      return true
    })
    check('scene loaded (belt package found)', loaded)
    if (!loaded) throw new Error('bundled belt package missing')

    const movePart = (x, label) => page.evaluate(({ x, label }) => {
      const st = window.__oip.store
      const s = st.getState().scene
      st.commit(label, { ...s, parts: s.parts.map((p) => (p.id === 'rc_1' ? { ...p, position: [x, 0.75, 0] } : p)) })
    }, { x, label })
    const partX = () => page.evaluate(() => window.__oip.store.getState().scene.parts.find((p) => p.id === 'rc_1').position[0])
    const rows = () => page.evaluate(() => [...document.querySelectorAll('.history-row')].map((r) => ({
      label: r.querySelector('.history-label').textContent,
      current: r.classList.contains('current'),
      undone: r.classList.contains('undone'),
    })))

    await movePart(1, 'Move part')
    await movePart(2, 'Slide over')
    let r = await rows()
    check('rows appear per commit (baseline + 2 edits)', r.length === 3, r.map((e) => e.label).join(' | '))
    check('labels render in order', r[0]?.label === 'Project opened' && r[1]?.label === 'Move part' && r[2]?.label === 'Slide over')
    check('newest row is current', r[2]?.current === true)

    // ---- click-to-jump: an earlier row undoes, the newest restores, the baseline reverts all
    await page.locator('.history-row', { hasText: 'Move part' }).click()
    r = await rows()
    check('clicking an earlier row jumps back', (await partX()) === 1, `x=${await partX()}`)
    check('cursor moved, later row greyed (still listed)', r[1]?.current === true && r[2]?.undone === true)

    await page.locator('.history-row', { hasText: 'Slide over' }).click()
    check('clicking the newest row restores it', (await partX()) === 2, `x=${await partX()}`)

    if (SHOT) await page.screenshot({ path: SHOT }) // raw shot on purpose: we're verifying UI chrome

    await page.locator('.history-row', { hasText: 'Project opened' }).click()
    r = await rows()
    check('baseline row undoes everything', (await partX()) === 0 && r[0]?.current === true, `x=${await partX()}`)
    check('all edits stay listed (redoable)', r.length === 3 && r[1]?.undone === true && r[2]?.undone === true)

    check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures ? 1 : 0)
}
main()
