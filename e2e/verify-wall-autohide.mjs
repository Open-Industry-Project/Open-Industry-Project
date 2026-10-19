// Gate for the near-wall auto-hide (src/render/parts/wallAutoHide.ts + building.ts viewTick): the
// perimeter runs an orbiting camera is behind drop out of the way, and the whole shell comes back
// once the camera is far enough out to be looking at the building.
//
// wallAutoHide.test.ts already pins the rule as arithmetic. Only a browser can check that the rule
// is wired to the right objects and that flipping them is safe on this renderer:
//
//   1. the runs are hidden per side. Hiding by facing-halves (A = -Z and +X, B = +Z and -X, the
//      buckets of an earlier wall lighting) drops the two runs of an L together, so a corner view
//      takes the whole building with it. A gate that only asserted "some walls hid" would pass that.
//   2. the merge mechanisms stay coherent across the flips. Each side group is its own static-fold
//      root (the one visibility seam the fold treats as live), and a hidden subtree also leaves
//      the instance pool's eligible set. A re-shown subtree that never re-pools is a permanent
//      auditMergeCoherence failure (the roof auto-hide has hit exactly this), so every pose here is
//      audited, including the ones that put walls back.
//   3. no uncaptured GPU errors, which _gpuGuard.mjs reports at exit: hiding a subtree that a
//      recorded render bundle still holds shows up as a black viewport while every other gate passes.
//
//   4. first person keeps the whole shell. A person walking the plant is not a camera that ended up
//      somewhere it did not mean to be, so the rule does not act (wallAutoHide.ts). This arm is not
//      vacuous: the pilot spawns at the editor camera's XZ (computePilotSpawn), so an ordinary orbit
//      outside the shell puts a walker outside it. If view.ts does not pass the flag the decision
//      reads, the near runs stay dropped for the whole walk. Round-tripped: exiting the walk at the
//      same spot must drop them again.
//
//   5. the parked trailers never hide. They stand outside the wall line, so flying the camera into
//      one puts it outside the footprint, behind that run; a trailer grouped with the run's bay would
//      vanish around the camera.
//
// Run: node e2e/verify-wall-autohide.mjs   (WebGL headless in CI; --headed for the WebGPU config)
/* global process, console, window, localStorage */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'

const { port: PORT, vite } = await startServer()
const OUT = join(import.meta.dirname, 'out')
mkdirSync(OUT, { recursive: true })

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

const frames = (page, n) =>
  page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let i = 0
        const tick = () => (++i >= count ? resolve() : requestAnimationFrame(tick))
        requestAnimationFrame(tick)
      }),
    n,
  )

/** the shell's footprint, from the scene rather than from a constant that could drift */
const shell = (page) =>
  page.evaluate(() => {
    const b = window.__oip.store.getState().scene.parts.find((p) => p.type === 'building')
    if (!b) throw new Error('no building in the scene')
    return { id: b.id, cx: b.position[0], cz: b.position[2], hx: (b.params.lengthSections * 10) / 2, hz: (b.params.widthSections * 10) / 2, rotY: b.rotationY ?? 0 }
  })

/**
 * The hidden set once it has settled on `want`, or whatever it settled on instead, so a real
 * disagreement still fails with what it saw.
 *
 * A fixed frame count cannot be the wait here. The rule is applied by the building's own tick, which
 * takes a few dozen frames to take effect. At ~1 fps (SwiftShader, OIP_E2E_SOFTWARE_GL=1) six frames
 * are seconds of wall-clock and it has happened by then; at ~20 fps (a real adapter, e2e/_gpuArgs.mjs)
 * six frames are 300 ms and it has not. Waiting for the condition works on either.
 */
async function settledHidden(page, want, budgetMs = 8000) {
  const target = [...want].sort().join(',')
  const deadline = Date.now() + budgetMs
  for (;;) {
    const now = await hiddenSides(page)
    if (now.join(',') === target || Date.now() > deadline) return now
    await frames(page, 4)
  }
}

/** which perimeter runs are currently hidden, read off the named side groups the visual builds */
const hiddenSides = (page) =>
  page.evaluate(() => {
    // the placed building's side groups, not the non-content backdrop shell's (which carries no partId)
    const ownedByPart = (o) => {
      for (let p = o.parent; p; p = p.parent) if (p.userData?.partId) return true
      return false
    }
    const sides = []
    window.__oip.view.scene.traverse((o) => {
      if (o.name.startsWith('WallSide_') && ownedByPart(o)) sides.push(o)
    })
    if (sides.length === 0) throw new Error('building wall side groups not found')
    const out = []
    for (const c of sides) if (!c.visible) out.push(c.name.slice('WallSide_'.length))
    return out.sort()
  })

/**
 * Whether the parked trailers are drawn: the DockTrailers root holds meshes and nothing up its
 * chain is hidden. They stand outside the wall line, so a camera flown into one is outside the
 * footprint and behind its run; grouped with that run's bay they would vanish around the camera.
 */
const trailersShown = (page) =>
  page.evaluate(() => {
    let root = null
    window.__oip.view.scene.traverse((o) => {
      if (o.name === 'DockTrailers' && !root) {
        for (let p = o; p; p = p.parent) if (p.userData?.partId) root = o
      }
    })
    if (!root) return { ok: false, why: 'no DockTrailers group' }
    let meshes = 0
    root.traverse((o) => { if (o.isMesh) meshes++ })
    for (let p = root; p; p = p.parent) if (!p.visible) return { ok: false, why: `hidden at ${p.name || p.type}` }
    return { ok: meshes > 0, why: `${meshes} meshes` }
  })

/**
 * Look at the shell's centre from `dist` metres outside the named run, at eye height for the
 * plant. `dist` is measured from the wall plane, which is what the rule's band is measured in.
 *
 * The run names (`WallSide_px` ...) are the building's own axes, so the offset is laid out in them and
 * turned by the building's rotationY into the world. Laid out in world axes it only agrees with an
 * unturned shell. The demo's is turned a quarter (it faces its receiving dock at the line), so a
 * camera outside world +x is outside local +z; the building correctly drops `pz`, and a world-axes
 * offset would report every side off by 90 degrees.
 */
async function look(page, geom, dist, sides) {
  const { cx, cz, hx, hz, rotY } = geom
  let lx = 0
  let lz = 0
  if (sides.includes('px')) lx = hx + dist
  if (sides.includes('nx')) lx = -hx - dist
  if (sides.includes('pz')) lz = hz + dist
  if (sides.includes('nz')) lz = -hz - dist
  // three's rotationY: local (x, z) -> world (x cos + z sin, -x sin + z cos)
  const c = Math.cos(rotY), s = Math.sin(rotY)
  const px = cx + lx * c + lz * s
  const pz = cz - lx * s + lz * c
  await page.evaluate((pose) => window.__oip.view.setCameraPose(pose), { px, py: 8, pz, tx: cx, ty: 3, tz: cz })
  await frames(page, 6)
}

/**
 * Boot and settle on positive signals. The re-goto is not redundant: a cold vite can
 * dep-re-optimize and full-reload the page mid-run, which interrupts a page.evaluate and fails
 * the script ("Execution context was destroyed"). Settling first, then re-navigating, gets that
 * reload over with before the assertions start.
 */
async function boot(page, url) {
  await page.goto(url)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 60000 })
  await page.waitForTimeout(1500)
  await page.goto(url)
  await page.waitForFunction(() => !!(window.__oip?.store && window.__oip?.view), { timeout: 60000 })
  await page.waitForSelector('.viewport-cover.ready', { timeout: 90000 }).catch(() => {})
  await page.waitForFunction(() => {
    const v = window.__oip.view
    return v.renderer?.backend === undefined || v.incrementalWarmReady === true
  }, { timeout: 90000 }).catch(() => {})
  await frames(page, 10)
}

/** every merge mechanism's staleness audit: anything not converged is a stale-pixels bug */
async function audited(page, label) {
  // the pool's settle rebuild runs a frame or two after the structure epoch moves, so give the
  // audit the same chance to converge that verify-merge-coherence gives it
  let last = null
  for (let i = 0; i < 12; i++) {
    last = await page.evaluate(() => window.__oip.view.auditMergeCoherence())
    if (last.ok) break
    await page.waitForTimeout(250)
  }
  check(`merges stay coherent ${label}`, last.ok, last.reason)
}

async function main() {
  const headed = process.argv.includes('--headed')
  const browser = await chromium.launch({
    headless: !headed,
    args: headed ? ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] : [],
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* */ } })
  try {
    await boot(page, `http://localhost:${PORT}/app/?scene=demo`)

    const geom = await shell(page)
    console.log(`shell: ${geom.hx * 2} x ${geom.hz * 2} m at (${geom.cx}, ${geom.cz}) - band ${Math.max(geom.hx, geom.hz)} m\n`)

    // --- inside: the enclosure is the view ---
    await page.evaluate((g) => window.__oip.view.setCameraPose({ px: g.cx, py: 6, pz: g.cz, tx: g.cx + 8, ty: 3, tz: g.cz + 4 }), geom)
    const inside = await settledHidden(page, [])
    check('inside the shell, every run stands', inside.length === 0, inside.join(','))

    // --- just outside one run: that run alone drops ---
    for (const side of ['px', 'nx', 'pz', 'nz']) {
      await look(page, geom, 6, [side])
      const hid = await settledHidden(page, [side])
      check(`6 m outside ${side}: only that run drops`, hid.length === 1 && hid[0] === side, `hid [${hid.join(',')}]`)
      const tr = await trailersShown(page)
      check(`6 m outside ${side}: the parked trailers stay drawn`, tr.ok, tr.why)
    }
    await audited(page, 'after stepping out through each run')
    await cleanShot(page, join(OUT, 'wall-autohide-one-side.png'))

    // --- a corner: the two runs in the way drop, the two behind the plant stand ---
    // the main case this gate covers: at facing-half granularity this would hide all four
    await look(page, geom, 6, ['px', 'pz'])
    const corner = await settledHidden(page, ['px', 'pz'])
    check('at a corner: exactly the two runs in the way drop', corner.length === 2 && corner.includes('px') && corner.includes('pz'), `hid [${corner.join(',')}]`)
    await cleanShot(page, join(OUT, 'wall-autohide-corner.png'))

    // --- first person: the whole shell stands, whatever the camera was doing before ---
    await look(page, geom, 6, ['px']) // walls dropped, then a person picks the camera up
    check('precondition: px dropped before entering the walk', (await settledHidden(page, ['px'])).join(',') === 'px')
    await page.evaluate(() => window.__oip.store.enterPilot())
    const walking = await settledHidden(page, [])
    check('entering the walk outside a run puts every run back', walking.length === 0, `hid [${walking.join(',')}]`)
    await page.waitForTimeout(500) // and stays back while the walk continues
    const stillWhole = await hiddenSides(page)
    check('the shell stays whole while walking', stillWhole.length === 0, stillWhole.join(','))
    await audited(page, 'after the walk restored the runs')
    await cleanShot(page, join(OUT, 'wall-autohide-pilot.png'))
    await page.evaluate(() => window.__oip.store.exitPilot())
    const backToOrbit = await settledHidden(page, ['px'])
    check('leaving the walk at the same spot drops the run again', backToOrbit.join(',') === 'px', `hid [${backToOrbit.join(',')}]`)

    // --- far enough out to be looking at the building: the shell is whole ---
    await look(page, geom, Math.max(geom.hx, geom.hz) + 20, ['pz'])
    const framed = await settledHidden(page, [])
    check('backed off to frame the shell, every run stands', framed.length === 0, framed.join(','))
    await audited(page, 'after backing off so the walls return')
    await cleanShot(page, join(OUT, 'wall-autohide-exterior.png'))

    // --- the kill-switch reverts to the always-solid shell ---
    await boot(page, `http://localhost:${PORT}/app/?scene=demo&nowallhide`)
    await look(page, geom, 6, ['px', 'pz'])
    const killSwitch = await settledHidden(page, [])
    check('?nowallhide keeps every run standing', killSwitch.length === 0, killSwitch.join(','))
  } finally {
    await browser.close()
    vite.kill('SIGTERM')
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures ? 1 : 0)
}

main().catch((err) => { console.error('verify crashed:', err); process.exit(2) })
