/* global console, process, window */
// Merge-coherence gate: checks that render batching stays correct.
//
// verify-draw-budget.mjs asserts the merges happen. This asserts they are correct: after every
// action that can move a merged source, the merged output on screen must still match the sources
// it was derived from. Every batching mechanism in src/render/ has to invalidate its merged copy
// when a source changes, and most bugs shipped in this area were missed invalidations, where the
// data changed and the pixels didn't: the railing that only opened on commit, the building
// visibility toggle that needed a bundle notify, showParam links that only vanished via an
// accidental pool rebuild, the floor grid not drawing under bundles. CI missed all of them, and
// they showed up as intermittent, GPU-dependent user reports.
//
// view.auditMergeCoherence() recomputes each mechanism's staleness signature over the live sources
// and compares it to what the last bake recorded. It uses the same walk as the bake, so it checks
// the exact invariant the bake's early-out relies on rather than a hand-copied approximation.
// Covered: instancePool, staticFold (per folded root), outlineMaskMerge, and the SimBoxes cargo
// aSel rows.
//
// Never sample mid-drag: the pool's write-through invalidates its signature until the release
// re-bakes, so asserting there would fail on correct behaviour. Every check below runs after the
// action has settled.
//
// Run: node e2e/verify-merge-coherence.mjs [--headed]
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

const HEADED = process.argv.includes('--headed')
const { port: PORT, vite } = await startServer()
// OIP_EXTRA_Q appends app query flags (e.g. OIP_EXTRA_Q=nostaticfold) so a render kill-switch can be
// A/B'd on one tree, without editing source between runs
const EXTRA_Q = process.env.OIP_EXTRA_Q ? `&${process.env.OIP_EXTRA_Q}` : ''

let failures = 0
const check = (name, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

/**
 * Boot and settle on positive signals only. A timed wait can end while the loading cover is up,
 * and then every check passes vacuously. Mirrors verify-draw-budget's boot: view exists, staged warm
 * finished, warm queues drained. The pool's settle rebuild runs async, so without this the audit
 * would read a half-pooled scene.
 */
async function boot(page, url) {
  await page.goto(url)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 60000 })
  await page.waitForTimeout(1500)
  await page.goto(url) // cold vite can dep-re-optimize and full-reload mid-run; settle then re-goto
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 60000 })
  await page.waitForFunction(() => {
    const v = window.__oip.view
    return v.renderer?.backend === undefined || v.incrementalWarmReady === true
  }, { timeout: 90000 })
  await page.waitForFunction(
    () => window.__oip.view.warming?.size === 0 && window.__oip.view.warmQueue?.size === 0,
    { timeout: 60000 },
  ).catch(() => {})
  await settle(page)
}

/**
 * Poll the visible-drawable count until two consecutive samples agree. The pool's settle rebuild
 * runs async (poolRebuildOnStructureSettled re-pools once a late burst of rig-child attaches stops),
 * so an audit taken before it finishes reads the pool mid-rebuild and reports an unfinished bake as
 * stale. Without this, the first post-boot select failed while select-all and deselect moments
 * later passed. verify-draw-budget uses the same check for the same reason.
 */
async function settle(page) {
  let last = -1
  for (let i = 0; i < 40; i++) {
    const n = await page.evaluate(() => {
      let total = 0
      window.__oip.view.scene.traverseVisible((o) => { if (o.isMesh || o.isInstancedMesh || o.isBatchedMesh) total++ })
      return total
    })
    if (n === last) return n
    last = n
    await page.waitForTimeout(400)
  }
  return last
}

/**
 * Audit, polling until every mechanism reports coherent or the deadline passes.
 *
 * The assertion is that the merges converge, not that they are correct instantly. Several re-bakes
 * are async by design (the pool's settle rebuild after an attach burst, the reveal-queue drain, the
 * mask merge's per-tick re-bake), so a single fixed-delay sample races them: with one, this gate
 * failed a different set of checks on each run with no code change. Polling checks that every
 * merged output ends up matching its sources. A mechanism with nothing scheduling its re-bake never
 * converges and still fails here. The "railing only opens on commit" bug was a merge that stayed
 * stale until an unrelated action, so this catches it.
 */
async function audit(page, deadlineMs = 6000) {
  const started = Date.now()
  let last
  for (;;) {
    await page.waitForTimeout(300)
    last = await page.evaluate(() => window.__oip.view.auditMergeCoherence())
    if (last.ok || Date.now() - started > deadlineMs) return last
  }
}

/** run `action` (with `arg`), settle, audit, and report - the shape of every case below */
async function step(page, name, action, arg) {
  await page.evaluate(action, arg)
  const r = await audit(page)
  const failed = (r.checks ?? []).filter((c) => !c.ok).map((c) => c.name).join(',')
  check(name, r.ok, r.ok ? `${(r.checks ?? []).length} checks` : `${r.reason}${failed ? ` [${failed}]` : ''}`)
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  try {
    await boot(page, `http://localhost:${PORT}/app/?scene=demo${EXTRA_Q}`)

    // baseline: a freshly loaded, settled scene must already be coherent. If this fails, every
    // check below is meaningless - the audit is reporting on a scene that never converged.
    const base = await audit(page)
    check('freshly loaded demo is coherent', base.ok, base.ok ? (base.checks ?? []).map((c) => c.name).join(', ') : base.reason)
    check('the audit actually ran something', (base.checks ?? []).length > 0, `${(base.checks ?? []).length} checks`)

    const someId = await page.evaluate(() => {
      const parts = window.__oip.store.getState().scene.parts
      return parts.find((p) => p.type === 'part' && p.packageId === 'oip.roller-conveyor')?.id
        ?? parts.find((p) => p.type === 'part')?.id
    })

    // Selection: parts stay pooled and outline from inside the merges (aSel + the mask merge),
    // so a select must leave every merged output matching its sources.
    await step(page, 'after selecting a part', (id) => window.__oip.store.select(id), someId)
    await step(page, 'after select-all', () => {
      const parts = window.__oip.store.getState().scene.parts.filter((p) => p.type === 'part')
      window.__oip.store.selectMany(parts.map((p) => p.id))
    })
    await step(page, 'after deselecting', () => window.__oip.store.select(null))

    // Building visibility: the staticFold's renderer-parity prune. Hiding a subtree must take its
    // leaves out of the merged copy. An earlier toggle bug failed exactly this.
    const hasBuilding = await page.evaluate(() => window.__oip.store.getState().scene.parts.some((p) => p.type === 'building'))
    if (hasBuilding) {
      for (const [label, param, value] of [
        ['roof hidden', 'roofVisible', false],
        ['roof shown', 'roofVisible', true],
        ['walls hidden', 'wallsVisible', false],
        ['walls shown', 'wallsVisible', true],
      ]) {
        await step(page, `after building ${label}`, ({ param, value }) => {
          const store = window.__oip.store
          const s = store.getState().scene
          store.loadScene({ ...s, parts: s.parts.map((p) => (p.type === 'building' ? { ...p, params: { ...p.params, [param]: value } } : p)) })
        }, { param, value })
      }
    } else {
      console.log('SKIP  building visibility (demo scene has no building)')
    }

    // Sim run/stop: the cargo batch repacks its rows every frame while running, and Stop resets
    // run poses; both must leave the aSel rows matching the tiers and the pool matching its sources.
    await step(page, 'after starting the sim', (id) => { window.__oip.store.select(id); window.__oip.store.setRunning(true) }, someId)
    await page.waitForTimeout(2500)
    const running = await audit(page)
    check('coherent with the sim RUNNING and cargo selected', running.ok, running.reason)
    await step(page, 'after stopping the sim', () => window.__oip.store.setRunning(false))

    // Structural edit: a duplicate adds parts (new pool members, new bundle structure); undo
    // removes them again. A missing invalidation on either side leaves merged copies behind.
    await step(page, 'after duplicating a part', (id) => { window.__oip.store.select(id); window.__oip.store.duplicateSelection() }, someId)
    await step(page, 'after undoing the duplicate', () => window.__oip.store.undo())

    const errs = await page.evaluate(() => window.__oipPageErrors ?? [])
    check('no uncaught page errors', errs.length === 0, errs.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
