// Verify the scene-tree part-type toggle: the dim type subtitle shows by default; the head's tag
// button hides the whole column (type moves to the row's hover tooltip); the choice persists across
// reload (oip-web/tree-types). Run: node e2e/verify-tree-types-toggle.mjs [--headed]
/* global process, console, window */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const URL = `http://localhost:${PORT}/app/`
const HEADED = process.argv.includes('--headed')

async function waitForApp(page) {
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 20000 })
}

let failed = false
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed = true
}

/** the tree rows' name/type/title triples, keyed by visible label */
async function readRows(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('.scene-tree .tree-row')]
    return rows.map((r) => ({
      name: r.querySelector('.tree-name')?.textContent ?? '',
      type: r.querySelector('.tree-type')?.textContent ?? '',
      title: r.getAttribute('title') ?? '',
    }))
  })
}

async function toggleState(page) {
  return page.evaluate(() => {
    const b = document.querySelector('.tree-types-toggle')
    return b ? { found: true, active: b.classList.contains('active'), pressed: b.getAttribute('aria-pressed') } : { found: false }
  })
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.goto(URL)
    await waitForApp(page)
    await page.evaluate(() => {
      window.localStorage.clear()
      window.localStorage.setItem('oip-web/tutorial-done', '1')
    })
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(800)

    // Scene: two named parts (name differs from the type, so the subtitle renders) + one unnamed box
    // (its label already is the type name, so its subtitle stays dropped in both modes).
    const setup = await page.evaluate(() => {
      const st = window.__oip.store
      const mk = (pid, id, name, pos) => {
        const pkg = window.__oip.getPackage(pid)
        if (!pkg) return null
        const params = Object.fromEntries(Object.entries(pkg.params ?? {}).map(([k, s]) => [k, s.default]))
        return { id, type: 'part', packageId: pid, ...(name ? { name } : {}), position: pos, rotationY: 0, params }
      }
      const parts = [
        mk('oip.belt-conveyor', 'belt1', 'Infeed', [0, 0.75, 0]),
        mk('oip.roller-conveyor', 'roller1', 'Takeaway', [0, 0.75, 3]),
        mk('oip.box', 'box1', null, [5, 0.2, 0]),
      ]
      if (parts.some((p) => !p)) return { ok: false }
      st.loadScene({ version: st.getState().scene.version, parts }, { persist: false })
      return { ok: true }
    })
    check('scene loaded (2 named parts + 1 unnamed box)', setup.ok)
    await page.waitForTimeout(400)

    // --- Phase 1: default = types visible ---
    const t0 = await toggleState(page)
    check('head toggle rendered, default ON', t0.found && t0.active && t0.pressed === 'true', JSON.stringify(t0))
    let rows = await readRows(page)
    const infeed = () => rows.find((r) => r.name === 'Infeed')
    const box = () => rows.find((r) => r.name !== 'Infeed' && r.name !== 'Takeaway')
    check('named part shows its type subtitle', infeed()?.type === 'Belt Conveyor', JSON.stringify(infeed()))
    check('named part row has no tooltip while types show', (infeed()?.title ?? '') === '', `title="${infeed()?.title}"`)
    // the unnamed box may or may not carry a subtitle (dropped only when its label is the bare type
    // name); record which, and assert the tooltip mirrors it once the column hides
    const boxType = box()?.type ?? ''

    // --- Phase 2: click the toggle -> column hidden, type moves to the hover tooltip ---
    await page.click('.tree-types-toggle')
    await page.waitForTimeout(200)
    const t1 = await toggleState(page)
    check('toggle reads OFF after click', t1.active === false && t1.pressed === 'false', JSON.stringify(t1))
    rows = await readRows(page)
    check('all type subtitles hidden', rows.every((r) => r.type === ''), JSON.stringify(rows.map((r) => r.type)))
    check('hidden type moved to the row tooltip', infeed()?.title === 'Belt Conveyor', `title="${infeed()?.title}"`)
    check('unnamed part tooltip mirrors its former subtitle', (box()?.title ?? '') === boxType, `title="${box()?.title}" was type="${boxType}"`)
    const stored = await page.evaluate(() => window.localStorage.getItem('oip-web/tree-types'))
    check('preference persisted as false', stored === 'false', `stored=${stored}`)

    // --- Phase 3: reload -> still hidden (scene resets; any named row must still show no subtitle) ---
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(800)
    const t2 = await toggleState(page)
    check('toggle still OFF after reload', t2.found && t2.active === false, JSON.stringify(t2))
    rows = await readRows(page)
    check('subtitles still hidden after reload', rows.every((r) => r.type === ''), JSON.stringify(rows.map((r) => r.type)))

    // --- Phase 4: click back on -> subtitles return, preference flips ---
    await page.click('.tree-types-toggle')
    await page.waitForTimeout(200)
    const t3 = await toggleState(page)
    check('toggle reads ON again', t3.active === true, JSON.stringify(t3))
    const storedOn = await page.evaluate(() => window.localStorage.getItem('oip-web/tree-types'))
    check('preference persisted as true', storedOn === 'true', `stored=${storedOn}`)

    check('no page errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
}

await main()
process.exit(failed ? 1 : 0)
