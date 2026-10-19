// Measure the commit-frame hitch of a placement drop (WebGPU). It drags a hover-warmed part in, holds
// until pumpWarm settles (baseline frame gaps), drops, and samples the post-commit frame gaps. A gap on
// the first drop of a kind that is gone on its repeat drop is a cold pipeline compile.
// Run: node e2e/probes/commit-shadow-hitch.mjs
//
// MODE `glb` (node e2e/probes/commit-shadow-hitch.mjs glb): blank scene, mesh-GLB rigs (robot/gantry/AGV).
// Their real meshes land ASYNC (attachMesh .then) - after pumpWarm's synchronous projection - so the
// swapped-in meshes draw cold mid-drag. holdMaxGap is that stall: the before/after gauge for the
// warmPart GLB-swap re-compile fix.
/* global process, console, window, performance, document */
import { startServer } from '../_server.mjs'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const { port: PORT, vite } = await startServer()
const BASE = `http://localhost:${PORT}/app/`

async function launchHeaded() {
  // CalculateNativeWinOcclusion off: else a covered window throttles rAF and every gap reads huge
  const args = ['--disable-features=CalculateNativeWinOcclusion', '--enable-unsafe-webgpu']
  for (const channel of ['msedge', 'chrome', undefined]) {
    try { return await chromium.launch({ headless: false, channel, args }) } catch { /* next */ }
  }
  throw new Error('need Edge or Chrome')
}

// Runs entirely in the page. One gesture: hover-warm → drag in → hold (baseline) → drop → sample.
// opts: { packageId, spot }
async function measureInPage(opts) {
  const { view: V, controller: C, store: S } = window.__oip
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
  const now = () => performance.now()

  const canvas = document.querySelector('canvas')
  const rect = canvas.getBoundingClientRect()
  const spot = opts.spot ?? 0
  const vx = rect.left + rect.width * (0.28 + 0.13 * (spot % 4))
  const vy = rect.top + rect.height * (0.32 + 0.14 * Math.floor(spot / 4))

  // hover warm (assets + pipeline) - the realistic path; every run gets it so the color pipeline
  // is warm and the only first-of-its-kind cost left at commit is the shadow caster (+ commit work)
  C.warmCatalogPart('part', opts.packageId, true)
  for (let i = 0; i < 120; i++) await raf() // ~2s: asset fetch + color pipeline compile settle

  const before = new Set(S.getState().scene.parts.map((p) => p.id))
  C.beginCatalogPlace('part', rect.left - 120, vy, opts.packageId)
  for (let i = 1; i <= 10; i++) {
    const x = rect.left - 120 + (vx - (rect.left - 120)) * (i / 10)
    C.catalogPlaceMove(x, vy, false)
    await raf()
  }

  // HOLD: wait for the staged preview to be revealed (pumpWarm done) then sample a steady baseline.
  // Mid-hold gaps also catch the GLB-swap cold compile (the staged real part swaps its GLBs in async).
  let holdMaxGap = 0
  let tPrev = now()
  let revealed = false
  const holdDeadline = now() + 5000
  while (now() < holdDeadline) {
    await raf()
    const t = now()
    const stagedId = V.stagingId
    const obj = stagedId ? V.entries.get(stagedId)?.visual.object : null
    const warmingDone = !V.warming || V.warming.size === 0
    if (!revealed && obj && obj.visible && warmingDone) {
      revealed = true
      tPrev = t // reset: don't count the pre-reveal wait as a gap
      continue
    }
    if (revealed) {
      if (t - tPrev > holdMaxGap) holdMaxGap = t - tPrev
      // 90 steady frames after reveal = enough baseline; bail early
      if (t - tPrev < 40 && holdMaxGap >= 0 && t > holdDeadline - 3500) break
    }
    tPrev = t
  }
  // steady baseline: 45 more frames
  let baselineMaxGap = 0
  tPrev = now()
  for (let i = 0; i < 45; i++) {
    await raf()
    const t = now()
    if (t - tPrev > baselineMaxGap) baselineMaxGap = t - tPrev
    tPrev = t
  }

  C.endCatalogPlace(vx, vy, false)
  const tDrop = now()

  // POST-COMMIT: sample ~2s of frame gaps; the commit-frame stall (shadow pipeline codegen+compile,
  // pool rebuild, sync) shows as the max gap right after the drop
  let postMaxGap = 0
  let tPostMax = 0
  tPrev = tDrop
  for (let i = 0; i < 120; i++) {
    await raf()
    const t = now()
    if (t - tPrev > postMaxGap) { postMaxGap = t - tPrev; tPostMax = t - tDrop }
    tPrev = t
  }

  const after = S.getState().scene.parts
  const placed = after.find((p) => !before.has(p.id))
  let shadowMeshes = 0
  if (placed) {
    const obj = V.entries.get(placed.id)?.visual.object
    obj?.traverse((o) => { if (o.castShadow) shadowMeshes++ })
  }
  return {
    packageId: opts.packageId,
    placed: !!placed,
    holdMaxGapMs: Math.round(holdMaxGap),
    baselineMaxGapMs: Math.round(baselineMaxGap),
    postCommitMaxGapMs: Math.round(postMaxGap),
    postMaxAtMs: Math.round(tPostMax),
    shadowMeshesAfterCommit: shadowMeshes,
  }
}

const GLB_MODE = process.argv[2] === 'glb'

async function main() {
  const browser = await launchHeaded()
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    page.on('console', (m) => { const t = m.text(); if (/warn|error|pipeline/i.test(t)) console.log('  [page]', t) })
    await page.goto(BASE + (GLB_MODE ? '?webgpu' : '?webgpu&scene=demo'))
    await page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.controller && window.__oip?.store), { timeout: 30000 })
    await page.waitForTimeout(10000) // let compileStaged settle so we measure incremental adds only

    // pick heavy kinds not already in the demo scene (first-of-its-kind = cold shadow pipeline)
    const pkgInfo = await page.evaluate(() => {
      const S = window.__oip.store.getState()
      const inScene = new Set(S.scene.parts.map((p) => p.packageId).filter(Boolean))
      return (S.bundledPackages ?? []).map((p) => ({ id: p.id, inScene: inScene.has(p.id) }))
    })
    const fresh = (id) => pkgInfo.some((p) => p.id === id && !p.inScene)
    console.log('fresh heavy candidates:', ['oip.belt-conveyor', 'oip.spur-conveyor', 'oip.curved-roller-conveyor', 'oip.turntable-conveyor', 'oip.six-axis-robot'].filter(fresh).join(', ') || '(none!)')

    const results = []
    let spot = 0
    const run = async (label, packageId) => {
      const r = await page.evaluate(measureInPage, { spot: spot++, packageId })
      console.log(`[${label}] ${JSON.stringify(r)}`)
      results.push({ label, ...r })
      await page.waitForTimeout(400)
      return r
    }

    if (GLB_MODE) {
      // mesh-GLB rigs on a blank scene: everything first-of-its-kind; holdMaxGap = the mid-drag
      // cold compile of the async-swapped real meshes (the warmPart GLB-swap fix's target)
      await run('G robot   fresh  ', 'oip.six-axis-robot')
      await run('H robot   repeat ', 'oip.six-axis-robot')
      await run('I gantry  fresh  ', 'oip.gantry')
      await run('J agv     fresh  ', 'oip.agv')
    } else {
      // fresh vs repeat per kind: a cold compile shows as a big fresh gap and a small repeat gap
      await run('A belt    fresh ', 'oip.belt-conveyor')
      await run('B belt    repeat', 'oip.belt-conveyor')
      await run('C spur    fresh ', 'oip.spur-conveyor')
      await run('D spur    repeat', 'oip.spur-conveyor')
      await run('E curved  fresh ', 'oip.curved-roller-conveyor')
      await run('F turntbl fresh ', 'oip.turntable-conveyor')
    }

    console.log('\n=== SUMMARY (postCommitMaxGap = the commit hitch; holdMaxGap = mid-drag GLB-swap compile) ===')
    for (const r of results) {
      console.log(
        `  ${r.label} hold=${String(r.holdMaxGapMs).padStart(4)}ms  base=${String(r.baselineMaxGapMs).padStart(3)}ms  postCommit=${String(r.postCommitMaxGapMs).padStart(4)}ms @${String(r.postMaxAtMs).padStart(4)}ms  shadowMeshes=${r.shadowMeshesAfterCommit}${r.placed ? '' : '  !! NOT PLACED'}`,
      )
    }
    await page.close()
  } finally {
    await browser.close()
  }
}

main()
  .catch((e) => { console.error('crashed:', e); process.exitCode = 2 })
  .finally(() => { vite.kill('SIGTERM'); spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { shell: true }) })
