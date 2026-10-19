// Gate for the shader-integrated belt scroll (beltFabricBank.ts): a running belt must cost the same
// per-frame host work as a stopped one.
//
// A CPU accumulator re-filled into a per-instance attribute every frame, per belt, would mark the part
// dirty on each upload, so every running belt would drag its whole subtree through bundleReplayRefresh's
// per-object walk - host cost scaling with (running belts × their draws) for an animation that is just
// `∫rate·dt`. The banks carry [base, rate] and the vertex shader integrates against one shared clock
// uniform, so running should add ~nothing over stopped:
//
//   1. part1Walked/frame (the bundle replay's per-object update chain) - running ≈ stopped.
//   2. tick uploads stay O(1)-ish: the shared tick group uploads the clock as one byte upload.
//   3. cpuMs (the view's tick EMA) - running ≈ stopped.
//   4. the beds still scroll on screen and still freeze on stop.
//
// WebGPU + bundles is the path under test (bundles are where the per-object walk lives).
//
// `--kind=` swaps what fills the scene, which is how the sweep tells the per-frame animation classes
// apart (all measured at 150 parts, WebGPU+bundles):
//   belt   (default, the contract) - 2-instance bed: a per-frame CPU write is below noise here
//                                    (A/B flat at 60 and 300 belts), so this run is a regression gate
//   spur - ~40-instance bed: the A/B is clear, 910 objects/frame and +3.57 ms running with the
//            per-frame write, 610 and +1.88 ms with the shader scroll
//   roller - no fabric bank; a per-part spin material. tickUploads 289/frame while running (~2 per
//            part), the O(parts) uniform-upload term the same rebase would remove
// Run: node e2e/verify-belt-scroll-idle-cpu.mjs [--headed] [--kind=belt|spur|roller] [--belts=N]
/* global process, console, window, localStorage, performance, requestAnimationFrame, Image, OffscreenCanvas */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'

const BELTS = Number(process.argv.find((a) => a.startsWith('--belts='))?.slice(8) ?? 60)
const HEADED = process.argv.includes('--headed')
// Which conveyor to fill the scene with. Each exercises a different per-frame animation, which is
// what the sweep compares:
//   belt - 2-instance fabric bed (the O(instances) attribute write, tiny)
//   spur - ~40-instance staircased bed (same write, 20× the instances)
//   roller - no fabric bank at all: a per-part spin material whose uniform ticks every frame
//            (rollerMaterial() is a factory, so ticking materials scale with part count)
const KINDS = {
  belt: { packageId: 'oip.belt-conveyor', params: { shapePreset: 'straight', segments: [[4, 0]], width: 1.524, height: 0.5, standHeight: 2, speed: 2, beltColor: '#ffffff' } },
  spur: { packageId: 'oip.spur-conveyor', params: { length: 2, width: 1.524, angleFrontDeg: 30, angleBackDeg: 0, speed: 2, standHeight: 2 } },
  roller: { packageId: 'oip.roller-conveyor', params: { length: 4, width: 1.524, standHeight: 2, speed: 2 } },
}
const KIND = process.argv.find((a) => a.startsWith('--kind='))?.slice(7) ?? (process.argv.includes('--spur') ? 'spur' : 'belt')
const PROBE_KIND = KIND !== 'belt' // non-default kinds are PROBE runs, not the pass/fail contract

const belts = (n) => {
  const { packageId, params } = KINDS[KIND] ?? KINDS.belt
  const parts = []
  const cols = Math.ceil(Math.sqrt(n))
  for (let i = 0; i < n; i++) {
    // y = standHeight: a conveyor's root origin is its deck plane, so a bed placed at y=0 sits in
    // the floor - invisible, and the pixel checks below would measure floor
    parts.push({ id: `belt${i}`, type: 'part', packageId, position: [(i % cols) * 6, 2, Math.floor(i / cols) * 6], rotationY: 0, params })
  }
  return parts
}

// screen-space rect over a belt's bed: project the part-root origin (the bed's top surface passes
// through it) through the live camera. Clipping matters - a bed's motion measured over the whole
// canvas is diluted ~250× by static pixels and reads as noise.
const bedRect = (page, partId) =>
  page.evaluate((id) => {
    const view = window.__oip.view
    let root = null
    view.scene.traverse((o) => { if (!root && o.userData?.partId === id) root = o })
    if (!root) return null
    const v = root.position.clone()
    v.project(view.camera)
    const r = document.querySelector('canvas').getBoundingClientRect()
    return {
      x: Math.max(0, Math.round(r.left + (v.x * 0.5 + 0.5) * r.width) - 60),
      y: Math.max(0, Math.round(r.top + (-v.y * 0.5 + 0.5) * r.height) - 20),
      width: 120, height: 40,
    }
  }, partId)

// mean |Δ| per byte between two captures of the bed - "is the bed moving". Goes through
// cleanShot, not a raw page.screenshot: a clipped screenshot captures the composited page, so a
// dock floating over that part of the canvas (the ST editor sits right over mid-canvas) is baked
// into both frames and the diff reads ~0 no matter what the belt is doing.
const SHOT_DIR = join(tmpdir(), 'oip-belt-scroll-gate')
async function bedDiff(page, clip, tag, settleMs = 400) {
  const a = await cleanShot(page, join(SHOT_DIR, `${tag}-a.png`), { clip })
  await page.waitForTimeout(settleMs)
  const b = await cleanShot(page, join(SHOT_DIR, `${tag}-b.png`), { clip })
  return page.evaluate(async ([b64a, b64b]) => {
    const decode = async (b64) => {
      const img = new Image()
      img.src = 'data:image/png;base64,' + b64
      await img.decode()
      const c = new OffscreenCanvas(img.width, img.height)
      const ctx = c.getContext('2d')
      ctx.drawImage(img, 0, 0)
      return ctx.getImageData(0, 0, img.width, img.height).data
    }
    const [da, db] = await Promise.all([decode(b64a), decode(b64b)])
    let sum = 0
    const n = Math.min(da.length, db.length)
    for (let i = 0; i < n; i++) sum += Math.abs(da[i] - db[i])
    return sum / n
  }, [readFileSync(a).toString('base64'), readFileSync(b).toString('base64')])
}

async function main() {
  let browser = null
  for (const opts of [
    { channel: 'msedge', headless: !HEADED, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
    { headless: !HEADED, args: ['--enable-unsafe-webgpu', '--disable-features=CalculateNativeWinOcclusion'] },
  ]) { try { browser = await chromium.launch(opts); break } catch { /* next */ } }
  if (!browser) { console.log('SKIP: no suitable browser'); return }
  const { port, vite } = await startServer()
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } })
  await page.addInitScript(() => { try { localStorage.setItem('oip-web/tutorial-done', '1') } catch { /* ok */ } })
  const fails = []
  const check = (label, cond, detail = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${detail ? ` - ${detail}` : ''}`)
    if (!cond) fails.push(label)
  }
  try {
    const url = `http://localhost:${port}/app/?webgpu`
    await page.goto(url)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 40000 })
    if (!(await page.evaluate(() => !!window.__oip.view.renderer.isWebGPURenderer))) { console.log('SKIP: WebGPU not active'); return }
    if (!(await page.evaluate(() => !!globalThis.__oipBundleCam))) { console.log('SKIP: bundle replay refresh not active'); return }

    await page.evaluate((parts) => {
      const s = window.__oip.store
      s.commit('belt-scroll-idle', { ...s.getState().scene, parts })
      s.select(null)
    }, belts(BELTS))
    await page.waitForTimeout(4000)
    await page.waitForFunction(() => window.__oip.view.stagedReveal === false, { timeout: 60000 })
    // stagedReveal only covers the pipeline warm - pooling, GLB arrivals and the bundle re-record
    // trail it, and at high part counts those hitches otherwise fall inside the sample window (a
    // 150-spur scene can sample 4 frames in 3 s). Scale the settle with the scene.
    await page.waitForTimeout(3000 + BELTS * 60)
    const n = await page.evaluate(() => window.__oip.store.getState().scene.parts.length)
    check(`scene holds ${BELTS} belts`, n === BELTS, `${n}`)
    // frame one bed so the pixel checks below have weave detail to resolve (at the default camera the
    // 8×8 belt grid is sub-pixel and a scrolling bed is indistinguishable from a frozen one)
    await page.evaluate(() => window.__oip.view.focusOn(['belt0']))
    await page.waitForTimeout(1500) // focus ease-in settles

    // window-diff the bundle-walk counters + the view's cpu EMA over a fixed frame count
    const sample = (label) =>
      page.evaluate(
        (lbl) =>
          new Promise((res) => {
            const cam = globalThis.__oipBundleCam
            const w0 = cam.part1Walked, u0 = cam.uploads, t0 = cam.tickUploads
            let frames = 0
            const start = performance.now()
            const tick = () => {
              frames++
              if (performance.now() - start < 3000) requestAnimationFrame(tick)
              else res({
                label: lbl,
                frames,
                walkedPerFrame: +((cam.part1Walked - w0) / frames).toFixed(2),
                uploadsPerFrame: +((cam.uploads - u0) / frames).toFixed(2),
                tickUploadsPerFrame: +((cam.tickUploads - t0) / frames).toFixed(2),
                cpuMs: +window.__oip.view.getStats().cpuMs.toFixed(2),
              })
            }
            requestAnimationFrame(tick)
          }),
        label,
      )

    const stopped = await sample('stopped')
    console.log(`  stopped: ${JSON.stringify(stopped)}`)
    const clip = await bedRect(page, 'belt0')
    check('belt0 bed located on screen', !!clip, JSON.stringify(clip))
    const dStop = await bedDiff(page, clip, "stopped")

    await page.evaluate(() => window.__oip.controller.run())
    // Wait for the signal, not a timeout: the worker takes a variable couple of seconds to boot
    // (Jolt WASM + scene build), and under load it can overrun a fixed 4 s wait. The sample then
    // catches a scene that is not running yet: the beds "don't scroll" and the walk counters are
    // meaningless. Sim steps first, then (for the fabric kinds) a bank actually carrying a rate.
    await page.waitForFunction(() => (window.__oip.sim?.stepStats?.steps ?? 0) > 60, { timeout: 40000 })
    if (KIND !== 'roller') {
      await page.waitForFunction(() => {
        let moving = false
        window.__oip.view.scene.traverse((o) => {
          const a = o.isInstancedMesh ? o.geometry?.attributes?.fabricScroll : null
          if (a && a.array[1] !== 0) moving = true
        })
        return moving
      }, { timeout: 40000 })
    }
    await page.waitForTimeout(1500) // let the frame cadence settle before the EMA window
    const running = await sample('running')
    console.log(`  running: ${JSON.stringify(running)}`)

    // 1. the per-object bundle walk must not grow with running belts.
    //    Non-belt kinds are probes, not the contract: a running spur still marks itself dirty every
    //    frame for a reason unrelated to the fabric scroll (measured: 150 spurs walk ~610
    //    objects/frame without the scroll write, ~910 with it). Report, don't fail.
    const walkDelta = running.walkedPerFrame - stopped.walkedPerFrame
    const walkDetail = `${stopped.walkedPerFrame} → ${running.walkedPerFrame} objects/frame (${BELTS} ${KIND}s)`
    if (PROBE_KIND) console.log(`PROBE: per-object bundle walk - ${walkDetail} (known non-scroll churn for this kind)`)
    else check('running adds ~no per-object bundle walk', walkDelta < BELTS / 2, walkDetail)
    // 2. the shared clock goes up as a handful of byte uploads, not one per belt. Also a probe on the
    //    non-belt kinds: `roller` legitimately uploads ~2/part/frame (its per-part spin material's
    //    uniform ticks) - a real O(parts) term, but a different one from the fabric scroll.
    const upDetail = `${running.tickUploadsPerFrame}/frame (${BELTS} ${KIND}s)`
    if (PROBE_KIND) console.log(`PROBE: tick uniform uploads - ${upDetail}`)
    else check('tick uploads stay O(materials), not O(belts)', running.tickUploadsPerFrame < BELTS / 2, upDetail)
    // 3. host frame cost must not scale with running belts (probe kinds carry the churn above, so
    //    they get the looser bound their measured residual sits under)
    check(
      'running cpuMs ≈ stopped cpuMs',
      running.cpuMs < stopped.cpuMs + (PROBE_KIND ? 3 : 2.5),
      `${stopped.cpuMs} → ${running.cpuMs} ms`,
    )
    // 4. …and the beds are genuinely animating (a frozen belt would pass 1-3 trivially)
    const dRun = await bedDiff(page, clip, "running")
    check('beds actually scroll while running', dRun > 0.15, `stopped ${dStop.toFixed(3)} → running ${dRun.toFixed(3)}`)
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(800)
    const dAfter = await bedDiff(page, clip, "after-stop")
    check('stop freezes the beds', dAfter < 0.1, `diff ${dAfter.toFixed(3)}`)
  } catch (e) {
    fails.push('exception')
    console.log('FAIL: exception —', e.message)
  } finally {
    await page.close().catch(() => {})
    vite.kill()
    await browser.close().catch(() => {})
  }
  console.log(fails.length === 0 ? '\nALL PASS' : `\n${fails.length} FAILURE(S): ${fails.join('; ')}`)
  if (fails.length > 0) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exit(1) })
