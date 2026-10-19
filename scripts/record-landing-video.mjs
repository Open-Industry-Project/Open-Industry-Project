// Records the looping hero clip for the marketing landing from the real simulator:
// spins up the dev server, loads the PLC palletizing demo, hides the editor chrome,
// runs the sim with a slow auto-orbit, then trims to public/sim-loop.{mp4,webm} + a
// poster. Re-run after meaningful visual changes:  node scripts/record-landing-video.mjs
//
// `--still` shoots the README's picture instead (.github/readme-hero.jpg) and leaves the video files alone. Same
// scene, framing and orbit, but a real screenshot at 2x pixel density, never a frame of the clip: the clip is
// Playwright's screencast at 1x, a low-bitrate capture that is fine moving behind the landing and soft as a still.
// The still keeps the editor chrome, with the PLC panel open and the palletizer selected: a README reader is
// deciding whether to use the editor, so the picture shows the editor, not only the scene.
/* global process, console, fetch, setTimeout */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { chromium } from 'playwright'
import { withGpuArgs } from '../e2e/_gpuArgs.mjs'

const PORT = 5219
const URL = `http://localhost:${PORT}/app/`
const STILL = process.argv.includes('--still')
// 16:10, matches the hero panel. The still is larger so the docks leave the viewport room.
const W = STILL ? 1920 : 1440
const H = STILL ? 1200 : 900
const OUT_W = 1280
const OUT_H = 800
const WINDOW = 15 // seconds of sim action to keep
// The demo's own scene-tree groups that make up the working cell. Everything else in the scene is
// warehouse furniture - the "Set dressing" group with its "Storage" and "Truck parking" subgroups,
// and the building shell - and is framed out. See the framing note below for why this is a list of
// NAMES and not a coordinate window.
const CELL_GROUPS = ['Layer-forming line', 'Palletizer cell', 'Pallet outfeed']
// focusOn frames for the EDITOR (viewCamera.ts FOCUS_DISTANCE_FACTOR = 2.2 - when you focus a part you
// want context around it). A hero panel wants the opposite: the cell is a ~10 m span inside a 50×40 m
// shed, so at the editor's distance it reads as a small thing on a lot of empty floor. Give a
// quarter of the distance back once the focus animation has landed (2.2 → ~1.65). Anything much
// tighter and the orbit starts clipping the cell fence at the extremes of its swing.
const HERO_DOLLY = 0.25
// Seconds of the window BEFORE the turntable starts to slew - enough to see the finished load drive
// onto the deck first, so the turn reads as part of the line rather than a thing that just happens.
const LEAD_IN = 4
// Seconds recorded AFTER the window and thrown away. The capture stops updating while the context closes, so
// the last ~0.8 s of a recording is a still frame; trimmed flush to the end, that froze the loop at its seam.
const TAIL = 1
const TURN_TIMEOUT_MS = 300000
const OUT = join(import.meta.dirname, '..', 'public')
const STILL_OUT = join(import.meta.dirname, '..', '.github', 'readme-hero.jpg')
// Seconds after the turntable starts to slew: the load is mid-turn and the arm is working
const STILL_AFTER_TURN = 2
// The still's camera: the azimuth about the framed cell (radians, 0 looking toward -z) puts the arm in the
// foreground with the line, the turntable and the truck behind it, and no annotation chip over the arm. The dolly is
// on top of HERO_DOLLY, because the docks leave the viewport smaller than the clip's full-bleed frame.
const STILL_AZIMUTH = 3 * Math.PI / 4
const STILL_DOLLY = 0.2
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const SETTLE_HOLD = 6 // consecutive unchanged samples (x 400 ms) before the scene counts as landed

/**
 * Wait until the scene has finished loading, not until it merely looks quiet.
 *
 * Three signals, because each one alone gives a false "done" here. `assetsBusy()` counts fetches in flight, so
 * immediately after "Load demo" there often are none yet and waiting on it returns instantly. A
 * bare "the count stopped changing" hold samples one plateau of the staircase of arriving parts
 * (the same trap e2e/verify-draw-budget.mjs documents for its budget). And neither sees the
 * renderer's own warm queues, which are the WebGPU pipeline compiles that stutter the first
 * seconds. So: warm queues drained, no fetch outstanding, and the visible drawable count unchanged
 * across a sustained hold. This is a one-off render, so waiting too long is harmless and waiting too
 * little means a re-shoot.
 */
async function settleScene(page, label) {
  await page.waitForFunction(() => {
    const v = window.__oip.view
    return v.renderer?.backend === undefined || v.incrementalWarmReady === true
  }, { timeout: 90000 }).catch(() => {})
  await page.waitForFunction(
    () => window.__oip.view.warming?.size === 0 && window.__oip.view.warmQueue?.size === 0,
    { timeout: 60000 },
  ).catch(() => {})
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, { timeout: 90000 }).catch(() => {})
  const count = () => page.evaluate(() => {
    let n = 0
    window.__oip.view.scene.traverseVisible((o) => {
      if (o.isMesh || o.isInstancedMesh || o.isBatchedMesh || o.isLine || o.isLineSegments || o.isPoints) n++
    })
    return n
  })
  let last = -1
  let held = 0
  for (let i = 0; i < 150; i++) {
    const n = await count()
    held = n === last ? held + 1 : 0
    if (held >= SETTLE_HOLD) { console.log(`${label}: settled at ${n} drawables`); return n }
    last = n
    await wait(400)
  }
  console.log(`${label}: NEVER settled (last ${last} drawables) - the shot may open on a scene still arriving`)
  return last
}

async function startVite() {
  const root = join(import.meta.dirname, '..')
  const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  const proc = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  // a failed run exits through main().catch, which never reaches vite.kill(): leave nothing on the port
  process.on('exit', () => { if (proc.exitCode === null) proc.kill() })
  proc.stderr.on('data', (d) => process.stderr.write(d))
  const deadline = Date.now() + 40000
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`vite exited ${proc.exitCode}`)
    try {
      const res = await fetch(URL)
      if (res.ok) break
    } catch { /* not up yet */ }
    if (Date.now() > deadline) { proc.kill(); throw new Error('vite did not start') }
    await wait(300)
  }
  return proc
}

async function main() {
  const vite = await startVite()
  const vidDir = mkdtempSync(join(tmpdir(), 'oip-rec-'))
  // HEADLESS on the machine's real adapter (withGpuArgs adds --use-angle=d3d11 on Windows): ~50 fps on the demo.
  // A headed window renders at ~2 fps once the screen is locked or the window covered, whatever the
  // anti-throttling flags say - so the clip came out a slideshow and the turntable wait timed out.
  const browser = await chromium.launch(withGpuArgs({ headless: true }))
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    // 2 is also the desktop preset's pixel-ratio cap (render/quality.ts), so the canvas really renders 2x
    deviceScaleFactor: STILL ? 2 : 1,
    // dark appearance (the app's default 'system' follows this, appearance.ts), to sit in the dark
    // landing; in this shot it only reaches the annotation chips, since the viewport has no theme
    colorScheme: 'dark',
    ...(STILL ? {} : { recordVideo: { dir: vidDir, size: { width: W, height: H } } }),
  })
  const page = await context.newPage()

  try {
    const ready = () => page.waitForFunction(
      () => !!(globalThis.__oip && __oip.store && __oip.controller && __oip.view),
      { timeout: 120000 },
    )
    await page.goto(URL, { timeout: 120000 }) // a fresh vite transforms the whole graph on this first load
    await ready()
    // the onboarding tour stays shut, so its card is never in the still
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('oip-web/tutorial-done', '1') })
    // load the demo by deep link, the way the gates do (the PLC panel's old "Load demo" button is gone)
    await page.goto(`${URL}?scene=demo`, { timeout: 120000 })
    await ready()

    // wait out the building load-cover so the clip never shows the loading screen
    await page.waitForFunction(() => {
      const c = document.querySelector('.viewport-cover')
      return !c || c.classList.contains('ready')
    }, { timeout: 90000 })
    await wait(800)
    // the demo's part GLBs land async, and the framing below measures RENDERED bounds - so framing
    // early frames a scene with whole machines still missing, and the clip opens on them popping in
    await settleScene(page, 'demo loaded')

    // strip the editor chrome to a full-bleed viewport, kill the grid + flow arrows,
    // and frame the working cell (not the building or the dressing) for a clean cinematic shot.
    // The line runs continuous-flow, so the box spawner must KEEP feeding it
    // (dropping the spawner starves this scene). Instead hide just the
    // spawner's helper visual by setting visible:false: syncScene recomputes the hidden set from
    // scene.parts on every (re)sync (viewSync.ts effectivelyHiddenSet), so the helper stays hidden
    // through the run's async re-sync - while the sim still spawns from the part regardless of
    // visibility (world.ts builds spawners from params). There are no despawners in this scene.
    await page.evaluate(() => {
      const st = __oip.store.getState()
      // the box source is the bundled SDK spawner (a custom oip.box-spawner part)
      // Annotations: keep the ones that read a tag, drop plain captions. A chip showing the running program's
      // infeed speed is the one frame here where a viewer sees the control logic and the machinery together,
      // which a cinematic orbit cannot otherwise show. A caption adds nothing. The demo has no captions, so this
      // is a guard: it keeps one added later out of the marketing video. `visible: false` hides them.
      const parts = st.scene.parts.map((p) => {
        if (p.type === 'part' && p.packageId === 'oip.box-spawner') return { ...p, visible: false }
        if (p.type === 'annotation' && !p.params.tag) return { ...p, visible: false }
        return p
      })
      __oip.store.loadScene({ ...st.scene, parts })
    })
    // loadScene re-syncs every part, so the visuals rebuild - settle a second time before framing
    await settleScene(page, 'visibility applied')

    if (STILL) {
      // open the PLC panel before framing, so the framing measures the viewport the docks leave. The demo's
      // program is a ladder, so the panel opens on the rungs, which show power flow once the line runs.
      await page.evaluate(() => __oip.store.revealPanel('st'))
      await page.waitForFunction(
        () => [...document.querySelectorAll('.cm-content, [data-testid="ladder-view"]')].some((el) => el.getBoundingClientRect().height > 0),
        null,
        { timeout: 30000, polling: 250 },
      )
      // the palletizer is the cell's centrepiece, so its Inspector is the one worth showing. The select tool
      // draws no transform gizmo, which would otherwise ring the arm.
      await page.evaluate(() => {
        const robot = __oip.store.getState().scene.parts.find((p) => p.packageId === 'oip.six-axis-robot')
        if (!robot) throw new Error('no oip.six-axis-robot in the demo scene - pick another part to select')
        __oip.store.setTool('select')
        __oip.store.select(robot.id)
      })
      await wait(800)
      // the tree scrolls only far enough to show the selected row, which leaves it at the bottom under a run of
      // trailer cases. Put its group row at the top instead, and take focus off whatever field the Inspector
      // focused, so no caret is in the shot.
      await page.evaluate(() => {
        const tree = document.querySelector('.scene-tree')
        const row = tree?.querySelector('.tree-row.selected')
        if (tree && row) {
          const pitch = row.getBoundingClientRect().height
          tree.scrollTop += row.getBoundingClientRect().top - tree.getBoundingClientRect().top - pitch
        }
        document.activeElement?.blur?.()
      })
      await wait(400)
    }

    const framed = await page.evaluate(({ CELL_GROUPS, STILL }) => {
      const app = document.querySelector('.app')
      const view = __oip.view
      const vp = app.querySelector('.viewport')
      if (!STILL) {
        for (const ch of Array.from(app.children)) {
          if (!ch.classList.contains('viewport')) ch.style.display = 'none'
        }
        app.style.gridTemplateColumns = '1fr'
        app.style.gridTemplateRows = '1fr'
        app.style.gridTemplateAreas = '"viewport"'
      }
      if (vp && !STILL) {
        vp.style.gridArea = 'viewport'
        // keep the main WebGL canvas AND the note layer - everything else goes: the orbit-gizmo's
        // separate Canvas2D overlay, the tool toolbar, stats, menus, and the load cover. The note
        // layer is the exception because a scene's annotation chips are a DOM overlay ('.note-layer',
        // a sibling of the canvas - App.tsx), so "hide every child that isn't the canvas" was quietly
        // throwing away the tag chip the visibility pass above keeps.
        const canvas = (view.renderer && view.renderer.domElement) || vp.querySelector('canvas')
        const notes = vp.querySelector('.note-layer')
        for (const ch of Array.from(vp.children)) if (ch !== canvas && ch !== notes) ch.style.display = 'none'
      }
      view.setGridVisible(false)
      view.setFlowArrowsVisible(false)
      // Frame ONLY the working cell, not the warehouse dressing: the cell sits in a 50×40 m shell,
      // so framing the whole scene shrinks it to a corner.
      //
      // A COORDINATE WINDOW (|x| ≤ 5, on the premise that "the dressing lives out past 5.7") is
      // silently outgrown by the demo - the palletizing cell sits on +x, so such a window drops the
      // palletizer (x = 5.9), its pedestal and gate, the entire pallet outfeed and both trucks: 153
      // of 204 parts, framed on the infeed half plus set dressing, with the arm hanging out of shot.
      // Nothing fails; the shot just quietly gets worse.
      //
      // So frame by MEMBERSHIP - the scene tree's own cell groups and everything under them. The
      // demo can grow in any direction without this drifting, and the one thing that WOULD break it
      // (a renamed or deleted group) throws here instead of silently reframing the video.
      const parts = __oip.store.getState().scene.parts
      const wanted = new Set(CELL_GROUPS.map((name) => {
        const g = parts.find((p) => p.type === 'group' && p.name === name)
        if (!g) throw new Error(`framing group "${name}" is not in the demo scene - update CELL_GROUPS`)
        return g.id
      }))
      // parts are not ordered parent-before-child, so walk the tree to a fixed point
      for (let grew = true; grew;) {
        grew = false
        for (const p of parts) if (p.parent && wanted.has(p.parent) && !wanted.has(p.id)) { wanted.add(p.id); grew = true }
      }
      // The trucks are the one member that must not frame the shot: they belong to the outfeed group
      // but ROAM the floor, and one is parked out at the racks (x ≈ 22) at t=0 - enough on its own to
      // zoom back out to the whole warehouse. Frame the FIXED machinery; the trucks drive into shot
      // under their own program. focusOn accounts for each part's real bounds, so the long infeed and
      // the staging lanes still fit fully.
      const line = parts.filter((p) => wanted.has(p.id) && p.packageId !== 'oip.agv')
      view.focusOn(line.map((p) => p.id))
      return line.length
    }, { CELL_GROUPS, STILL })
    console.log(`framed ${framed} cell parts from ${CELL_GROUPS.length} groups (dressing, building + roaming trucks excluded)`)
    await wait(1200) // let the resize + focus animation settle

    // start the line (the spawner helper was already hidden above and stays hidden across the
    // run's re-sync, so nothing extra to clean up here)
    await page.evaluate(() => __oip.controller.run())
    await wait(600)
    await page.evaluate(({ HERO_DOLLY, STILL, STILL_AZIMUTH, STILL_DOLLY }) => {
      const c = __oip.view.controls
      if (c) {
        c.object.position.lerp(c.target, HERO_DOLLY) // tighten the editor framing to a hero framing
        c.autoRotate = !STILL
        c.autoRotateSpeed = 0.55 // gentle orbit for life
        if (STILL) {
          // A still holds one fixed view. Where an orbit stops depends on when the turntable fires, and from some
          // sides the "Pallets" chip over the dispenser covers the arm.
          const o = c.object.position.clone().sub(c.target).multiplyScalar(1 - STILL_DOLLY)
          const h = Math.hypot(o.x, o.z)
          c.object.position.set(c.target.x + h * Math.sin(STILL_AZIMUTH), c.target.y + o.y, c.target.z + h * Math.cos(STILL_AZIMUTH))
        }
        c.update()
      }
    }, { HERO_DOLLY, STILL, STILL_AZIMUTH, STILL_DOLLY })

    // Hold the window open until the turntable is actually indexing a load. The deck turns once per
    // load, when it reaches the plate, so the interval between turns is a property of the LINE (case
    // rate, layer pattern, AGV round trip), not a constant this script could sleep on. Waiting on the
    // tag means the shot keeps showing the turn even after the line's timing changes; a sleep would
    // silently drift off it. `TurnCmd` is the command the program writes (-90 = across to the lane).
    const tRun = Date.now()
    // Poll from node, not with page.waitForFunction: on this page that never resolved even while the
    // tag sat at -90 for ~8 s every ~80 s (measured), and its timeout reads exactly like "no turn".
    let sawTurn = false
    while (!sawTurn && Date.now() - tRun < TURN_TIMEOUT_MS) {
      sawTurn = await page.evaluate(() => Number(__oip.controller.plcGlobalTags?.TurnCmd ?? 0) <= -89)
      if (!sawTurn) await wait(200)
    }
    console.log(sawTurn
      ? `turntable indexed ${((Date.now() - tRun) / 1000).toFixed(1)}s into the run - window opens ${LEAD_IN}s before it`
      : `WARNING: no turntable index within ${TURN_TIMEOUT_MS / 1000}s - recording the line as it stands`)
    if (STILL) {
      await wait(STILL_AFTER_TURN * 1000)
      // the whole editor window is the shot
      await page.evaluate(() => document.activeElement?.blur?.())
      await page.screenshot({ path: STILL_OUT, type: 'jpeg', quality: 88 })
      console.log(`wrote ${STILL_OUT}`)
      // closing the context with the full editor running never returns (twice, more than 5 minutes each), and the
      // picture is already on disk, so give the close a few seconds and then leave
      await Promise.race([browser.close(), wait(10000)])
      vite.kill()
      rmSync(vidDir, { recursive: true, force: true })
      process.exit(0)
    }
    // from here to the context close is the tail of the window; the head is the LEAD_IN seconds
    // already recorded before the turn (the trim below takes the WINDOW seconds before the last TAIL)
    await wait((WINDOW - LEAD_IN + TAIL) * 1000)
  } finally {
    await context.close() // flushes the .webm
  }

  const raw = await page.video().path()
  await browser.close()
  vite.kill()

  // Trim the window from the END of the recording, never from a wall-clock offset.
  //
  // Playwright's video timeline is not a clock: while the page stalls on load it neither drops nor
  // pads frames in sync with real time, so a wall-clock offset points somewhere arbitrary. A cut
  // taken that way opens on a half-built scene, machines popping in for ~4 s, even though the app
  // settled well before the orbit started. The last WINDOW seconds need no
  // such mapping: the orbit is the last thing this script does before closing the context, and the
  // page renders continuously throughout it.
  mkdirSync(OUT, { recursive: true })
  const probe = spawnSync(ffmpegPath, ['-hide_banner', '-i', raw], { encoding: 'utf8' })
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.stderr || '')
  const rawSecs = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0
  if (rawSecs < WINDOW + TAIL + 1) throw new Error(`raw recording is ${rawSecs.toFixed(1)}s, need more than ${WINDOW}s`)
  console.log(`raw recording ${rawSecs.toFixed(1)}s - keeping ${WINDOW}s, ending ${TAIL}s before the close`)
  const vf = `scale=${OUT_W}:${OUT_H}:flags=lanczos,fps=30,setsar=1`
  const run = (args, label) => {
    console.log(`ffmpeg ${label}…`)
    const r = spawnSync(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'inherit'] })
    if (r.status !== 0) throw new Error(`ffmpeg ${label} failed (${r.status})`)
  }

  // AV1 is the primary source the landing serves (see index.html <source> order): ~1/3 the
  // bytes of VP9 at the same quality, so most visitors fetch ~1.2 MB instead of ~4 MB. libaom
  // is slow - cpu-used 5 trades encode time for quality on this one-off render; bump it up if
  // you're iterating. The webm/mp4 below stay as fallbacks for browsers without AV1 decode.
  run(['-y', '-sseof', `-${WINDOW + TAIL}`, '-t', String(WINDOW), '-i', raw, '-vf', vf,
    '-c:v', 'libaom-av1', '-crf', '40', '-b:v', '0', '-cpu-used', '5', '-row-mt', '1',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
    join(OUT, 'sim-loop.av1.mp4')], 'av1')
  // h264/VP9 fallbacks: CRFs one notch above the common 23/34 - for a muted background loop
  // the quality loss is invisible but trims the fallback files ~25%.
  run(['-y', '-sseof', `-${WINDOW + TAIL}`, '-t', String(WINDOW), '-i', raw, '-vf', vf,
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '26', '-movflags', '+faststart', '-an',
    join(OUT, 'sim-loop.mp4')], 'mp4')
  run(['-y', '-sseof', `-${WINDOW + TAIL}`, '-t', String(WINDOW), '-i', raw, '-vf', vf,
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '37', '-row-mt', '1', '-an',
    join(OUT, 'sim-loop.webm')], 'webm')
  run(['-y', '-sseof', `-${WINDOW + TAIL - 3}`, '-i', raw, '-frames:v', '1',
    '-vf', `scale=${OUT_W}:${OUT_H}:flags=lanczos`, '-q:v', '4',
    join(OUT, 'sim-loop-poster.jpg')], 'poster')

  rmSync(vidDir, { recursive: true, force: true })

  // A held frame reads as a hitch in a loop, and the capture drops them now and then on its own (a 0.23 s one
  // landed just before a pick once, and did not come back on a re-record). The 25 -> 30 fps resample repeats one
  // frame in six, which is 33 ms and well under this threshold. Not fatal: say where, so a re-run can be judged.
  const fd = spawnSync(ffmpegPath, ['-hide_banner', '-i', join(OUT, 'sim-loop.mp4'), '-vf', 'freezedetect=n=0.003:d=0.12', '-f', 'null', '-'], { encoding: 'utf8' })
  const freezes = [...(fd.stderr || '').matchAll(/freeze_start: ([\d.]+)/g)].map((m) => Number(m[1]).toFixed(2))
  if (freezes.length) console.log(`WARNING: the clip holds a frame at ${freezes.join(', ')}s - a capture stall; re-run for a clean take`)
  console.log('wrote public/sim-loop.av1.mp4, public/sim-loop.webm, public/sim-loop.mp4, public/sim-loop-poster.jpg')
}

main().catch((e) => { console.error(e); process.exit(1) })
