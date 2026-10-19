// A definition session (Catalog ✎, controller.editPartPackage) swaps the document's scene for one holding just the
// part being edited. The document's parts are held while it is open (view.setHoldDeparted), not disposed, and Back
// puts the same visuals back instead of rebuilding every part (~0.7 s on the demo scene, shader recompiles included).
// This gate checks that the only visible difference is the speed:
//   - Back restores every part with the same visual object, nothing stays held, no shader program was released and
//     recompiled, and every merge layer (instance pool, part batch, building folds, outline mask, scene consumers)
//     audits coherent
//   - an edit to the package made inside the session reaches the document's copies of that part on Back
//     (refreshPackage only reaches live entries, so the restore has to notice the package changed)
// The close time is reported, not enforced (machine-dependent, AGENTS.md).
// Run: node e2e/verify-part-session-holds-scene.mjs
/* global process, console, window, performance, requestAnimationFrame */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const { port, vite } = await startServer()
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))

const settle = () => page.waitForFunction(() => window.__oip.assetsBusy?.() === false && !window.__oip.view.focusAnim, null, { timeout: 120000 })
/** the merge layers, polled until coherent (a rebuild may land a frame later) or a deadline */
const audit = async () => {
  const t0 = Date.now()
  for (;;) {
    const r = await page.evaluate(() => window.__oip.view.auditMergeCoherence())
    if (r.ok || Date.now() - t0 > 8000) return r
    await page.waitForTimeout(300)
  }
}
const snapshot = () => page.evaluate(() => {
  const v = window.__oip.view
  return {
    ids: [...v.entries.keys()].sort(),
    objects: Object.fromEntries([...v.entries].map(([id, e]) => [id, e.visual.object.uuid])),
    held: v.held.size,
    programs: v.renderer.info.programs?.length ?? -1,
  }
})
/** run a controller call and time it to the next frame */
const timed = (src) => page.evaluate(async (s) => {
  const t0 = performance.now()
  ;(0, eval)(s)()
  await new Promise((r) => requestAnimationFrame(r))
  return Math.round(performance.now() - t0)
}, src)

try {
  await page.goto(`http://localhost:${port}/app/?scene=demo`)
  await page.waitForFunction(() => !!window.__oip?.controller, null, { timeout: 60000 })
  await settle()
  await page.waitForTimeout(1500)
  const a0 = await audit()
  check('the demo scene audits coherent before any session', a0.ok, a0.reason)
  const before = await snapshot()

  // ---- open a definition and come back
  await timed("() => window.__oip.controller.editPartPackage('oip.belt-conveyor')")
  await settle()
  const during = await snapshot()
  check('while the session is open the document\'s parts are held, not live', during.held === before.ids.length && during.ids.length === 1, `${during.held} held, ${during.ids.length} live`)
  const closeMs = await timed('() => window.__oip.controller.closePartScene()')
  await settle()
  const after = await snapshot()
  check('Back brings every part back', JSON.stringify(after.ids) === JSON.stringify(before.ids), `${after.ids.length} of ${before.ids.length}`)
  const rebuilt = before.ids.filter((id) => after.objects[id] !== before.objects[id])
  check('...as the SAME visuals, not rebuilt ones', rebuilt.length === 0, rebuilt.length ? `${rebuilt.length} rebuilt, e.g. ${rebuilt.slice(0, 3).join(' ')}` : '')
  check('...with nothing left held', after.held === 0, `${after.held}`)
  // the scene's programs stay alive while it is held (three releases a program only when nothing uses it), so the
  // count never dips. A dip on open means Back has to recompile them. The session's own part may add a few.
  check('...and no shader program of the scene was released while it was held', during.programs >= before.programs && after.programs >= before.programs, `${before.programs} -> ${during.programs} in the session -> ${after.programs}`)
  const a1 = await audit()
  check('every merge layer audits coherent after Back', a1.ok, a1.reason)
  console.log(`note  Back took ${closeMs} ms to the next frame (reported, not enforced)`)

  // ---- an edit made in the session reaches the document's copies on Back
  const roller = await page.evaluate(() => {
    const p = window.__oip.store.getState().scene.parts.find((q) => q.packageId === 'oip.roller-conveyor')
    return p ? { id: p.id, at: window.__oip.view.rigLinkGizmo(p.id, 'roller')?.worldPos ?? null } : null
  })
  check('the demo has a roller conveyor to watch', roller !== null && roller.at !== null, roller?.id)
  if (roller && roller.at) {
    await page.evaluate(() => {
      const c = window.__oip.controller
      c.editPartPackage('oip.roller-conveyor')
      const link = window.__oip.getPackage('oip.roller-conveyor').geometry.links.find((l) => l.name === 'roller')
      c.editRigLink('oip.roller-conveyor', 'roller', { offset: [link.offset[0], link.offset[1] + 0.25, link.offset[2]] })
    })
    await settle()
    await page.evaluate(() => window.__oip.controller.closePartScene())
    await settle()
    const moved = await page.evaluate((id) => window.__oip.view.rigLinkGizmo(id, 'roller')?.worldPos ?? null, roller.id)
    const dy = moved ? moved[1] - roller.at[1] : NaN
    check('a link moved 0.25 m in the session is moved on the demo\'s roller conveyor after Back', Math.abs(dy - 0.25) < 0.01, `dy ${dy.toFixed(3)} m`)
    const a2 = await audit()
    check('...and the merge layers still audit coherent', a2.ok, a2.reason)
  }
  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (e) {
  check('run', false, String(e).split('\n')[0])
} finally {
  await browser.close()
  vite.kill()
}
const ok = results.length > 0 && results.every(Boolean)
console.log(ok ? '\nAll checks passed.' : `\n${results.filter((x) => !x).length} check(s) FAILED`)
process.exitCode = ok ? 0 : 1
