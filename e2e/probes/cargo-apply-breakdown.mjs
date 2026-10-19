// Where inside SimBoxes.apply does the per-body time go?
//
// e2e/probes/cargo-apply-cost.mjs measures the whole call (~1.3 us/body, far more than a TRS compose
// should cost). That number decides whether a "compose matrices in the vertex shader" port targets
// the right term. This captures one real frame and replays it through variant loops, each dropping
// one piece, so the cost splits by cause:
//
//   compose+setMatrixAt | setColorAt (sRGB transform!) | the per-body {id,partId} allocation
//
// A GPU port only removes the first. If most of the time is in the other two, the fix is plain CPU work.
/* global process, console, window, localStorage, performance, requestAnimationFrame */
import { chromium } from 'playwright'
import { startServer } from '../_server.mjs'

const REPS = Number(process.argv[2] ?? 2000)
const { port, vite } = await startServer()
const browser = await chromium.launch({
  headless: false,
  args: ['--disable-features=CalculateNativeWinOcclusion', '--enable-unsafe-webgpu'],
})
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
  const url = `http://localhost:${port}/app/?scene=demo&webgpu`
  const ready = () =>
    page.waitForFunction(() => !!(window.__oip?.view && window.__oip?.store?.getState().scene.parts.length > 0), { timeout: 60000 })
  await page.goto(url, { timeout: 90000 })
  await ready()
  await page.waitForTimeout(2000)
  await page.goto(url, { timeout: 90000 }) // warm-vite re-goto (dep re-optimize can reload mid-nav)
  await ready()
  await page.waitForFunction(() => window.__oip.view.stagedReveal === false, { timeout: 45000 })
  await page.waitForTimeout(3000)
  await page.evaluate(() => window.__oip.controller.run())
  await page.waitForTimeout(8000)

  const result = await page.evaluate(
    (reps) =>
      new Promise((res) => {
        const view = window.__oip.view
        const boxes = view.boxes
        const proto = Object.getPrototypeOf(boxes).apply
        // grab one real frame, then stop intercepting
        boxes.apply = function capture(frame) {
          proto.call(this, frame)
          delete boxes.apply
          window.__capturedFrame = frame
          return undefined
        }
        const wait = () => {
          if (!window.__capturedFrame) { requestAnimationFrame(wait); return }
          try { run() } catch (err) { res({ error: String(err && err.stack ? err.stack : err) }) }
        }
        const run = () => {
          const frame = window.__capturedFrame
          const n = frame.count
          const mesh = boxes.mesh
          const THREE = mesh.instanceMatrix.constructor // not used; kept for clarity
          void THREE
          // mirror the real loop's scratch objects
          const M = mesh.matrixWorld.constructor // Matrix4
          const tmpMat = new M()
          const pos = mesh.position.constructor // Vector3
          const tmpPos = new pos()
          const tmpScale = new pos()
          const quat = mesh.quaternion.constructor // Quaternion
          const tmpQuat = new quat()
          // Color ctor: the batch material may be an array / a NodeMaterial, so borrow it from any
          // light in the scene (every Light owns a real three Color) rather than from the material
          let Col = null
          view.scene.traverse((o) => { if (!Col && o.isLight && typeof o.color?.setRGB === 'function') Col = o.color.constructor })
          if (!Col) { res({ error: 'could not reach a three Color constructor' }); return }
          const tmpColor = new Col()
          const SRGB = 'srgb'
          const meta = []

          const bench = (label, fn) => {
            for (let w = 0; w < 200; w++) fn() // warm
            const t0 = performance.now()
            for (let r = 0; r < reps; r++) fn()
            const ms = performance.now() - t0
            return { label, msPerCall: +(ms / reps).toFixed(4), usPerBody: +((ms / reps / n) * 1000).toFixed(3) }
          }

          const readPose = (i) => {
            const pi = i * 3
            const qi = i * 4
            tmpPos.set(frame.positions[pi], frame.positions[pi + 1], frame.positions[pi + 2])
            tmpQuat.set(frame.quats[qi], frame.quats[qi + 1], frame.quats[qi + 2], frame.quats[qi + 3])
            tmpScale.set(frame.halfExtents[pi] * 2, frame.halfExtents[pi + 1] * 2, frame.halfExtents[pi + 2] * 2)
          }

          const rows = []
          rows.push(bench('read pose only (typed-array loads)', () => {
            for (let i = 0; i < n; i++) readPose(i)
          }))
          rows.push(bench('+ compose + setMatrixAt', () => {
            for (let i = 0; i < n; i++) { readPose(i); tmpMat.compose(tmpPos, tmpQuat, tmpScale); mesh.setMatrixAt(i, tmpMat) }
          }))
          rows.push(bench('+ setColorAt (sRGB convert)', () => {
            for (let i = 0; i < n; i++) {
              readPose(i); tmpMat.compose(tmpPos, tmpQuat, tmpScale); mesh.setMatrixAt(i, tmpMat)
              const pi = i * 3
              tmpColor.setRGB(frame.colors[pi], frame.colors[pi + 1], frame.colors[pi + 2], SRGB)
              mesh.setColorAt(i, tmpColor)
            }
          }))
          rows.push(bench('+ per-body {id,partId} alloc (= full loop)', () => {
            for (let i = 0; i < n; i++) {
              readPose(i); tmpMat.compose(tmpPos, tmpQuat, tmpScale); mesh.setMatrixAt(i, tmpMat)
              const pi = i * 3
              tmpColor.setRGB(frame.colors[pi], frame.colors[pi + 1], frame.colors[pi + 2], SRGB)
              mesh.setColorAt(i, tmpColor)
              meta[i] = { id: frame.ids[i], partId: frame.partIds[i] ?? null }
            }
          }))
          // what a GPU-compose port would leave behind: raw typed-array copies into instanced attrs
          const posBuf = new Float32Array(n * 3)
          const quatBuf = new Float32Array(n * 4)
          const sclBuf = new Float32Array(n * 3)
          rows.push(bench('GPU-port floor: 3 array.set() copies', () => {
            posBuf.set(frame.positions.subarray(0, n * 3))
            quatBuf.set(frame.quats.subarray(0, n * 4))
            sclBuf.set(frame.halfExtents.subarray(0, n * 3))
          }))

          res({ bodies: n, reps, rows })
        }
        requestAnimationFrame(wait)
      }),
    REPS,
  )

  console.log(`bodies=${result.bodies}  reps=${result.reps}\n`)
  let prev = 0
  for (const r of result.rows) {
    const delta = r.label.startsWith('GPU-port') ? null : +(r.msPerCall - prev).toFixed(4)
    console.log(
      `${r.label.padEnd(44)} ${String(r.msPerCall).padStart(8)} ms/call  ${String(r.usPerBody).padStart(7)} us/body` +
        (delta !== null ? `   (+${delta} ms)` : ''),
    )
    if (!r.label.startsWith('GPU-port')) prev = r.msPerCall
  }
} finally {
  await browser.close()
  vite.kill()
}
