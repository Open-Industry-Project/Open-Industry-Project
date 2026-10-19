/* global console, process, window, Image, OffscreenCanvas */
// Verify the instanced spur belt conveyor (examples/parts/spur-conveyor/behavior.ts, using the belt banks):
//
//   1. pooling - 3 spurs' bed banks merge into scene-global pool copies (a band bucket + a 16-seg
//      nose-wrap bucket, 240 loop pieces), per-part banks hidden; pool fabricUv is the vec4
//      [uMul, uAdd, vMul, vAdd] (beltFabricBank.ts) whose v pair slices the cross-belt weave per strip.
//   2. scroll - per-spur scroll advances through the pool's merged buffer (each bucket holds 40
//      instances per spur: the two moving spurs' 80 advance, the speed-0 spur's 40 stay 0), and pixels
//      move while running / freeze on stop (arrows weave, full-frame changed-pixel count).
//   3. cross-part pooling - a straight belt's 2 band instances go into the same bucket as the spurs'
//      (byte-identical band template + same (variant, colour) bank material).
//   4. draw scaling - 3→6 spurs adds only the plain meshes (gap-fill prism + 2 collision guards).
//
// Run: node e2e/verify-spur-banks.mjs   (WebGL via ?nowebgpu - deterministic headless; the shared bank
// machinery's WebGPU twin is covered by verify-belt-fabric-banks.mjs)
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'
import { cleanShot } from './_shot.mjs'
import { join } from 'node:path'

const { port, vite } = await startServer()
const url = `http://localhost:${port}/app/`

let failures = 0
const check = (name, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${info ? ` - ${info}` : ''}`)
}

// full-frame screenshot diff: mean |Δ| per byte + count of bytes moving more than JPEG-noise
async function frameDiff(page, settleMs = 450) {
  const a = await page.screenshot()
  await page.waitForTimeout(settleMs)
  const b = await page.screenshot()
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
    let changed = 0
    for (let i = 0; i < da.length; i++) if (Math.abs(da[i] - db[i]) > 12) changed++
    return changed
  }, [a.toString('base64'), b.toString('base64')])
}

const fabricCensus = (page) =>
  page.evaluate(() => {
    const out = { pools: [], itemSizes: [], live: { visible: 0, hidden: 0 } }
    window.__oip.view.scene.traverse((o) => {
      if (o.isInstancedMesh && o.geometry?.attributes?.fabricScroll) {
        if (o.userData.instancePool === true) {
          out.pools.push(o.count)
          out.itemSizes.push(o.geometry.attributes.fabricUv.itemSize)
        } else if (o.visible) out.live.visible++
        else out.live.hidden++
      }
    })
    out.pools.sort((a, b) => b - a)
    return out
  })

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } })
  try {
    await page.goto(`${url}?nowebgpu`)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), { timeout: 30000 })
    await page.waitForTimeout(1000)

    // three spurs, speeds 1 / 2.5 / 0; spurA on the arrows weave so scrolling is unmissable on pixels
    await page.evaluate(() => {
      const s = window.__oip.store
      const scene = s.getState().scene
      const mk = (id, dz, speed, weave) => ({
        id, type: 'part', packageId: 'oip.spur-conveyor', position: [0, 2, dz], rotationY: 0,
        params: { length: 2, width: 1.524, angleFrontDeg: 30, angleBackDeg: 0, speed, standHeight: 2, beltTexture: weave },
      })
      s.commit('spur-bank-test', { ...scene, parts: [...scene.parts, mk('spurA', 0, 1, 'alternate'), mk('spurB', 4, 2.5, 'standard'), mk('spurC', -4, 0, 'standard')] })
      s.select(null)
    })
    await page.waitForTimeout(3500)

    // 1. pooling census. spurA's 'alternate' weave keys a different bank material, so its 2 banks are
    // the only members of their (template, material) groups, and the pool leaves a lone mesh live (nothing
    // to merge with). The two standard spurs pool: a band bucket + a nose-wrap bucket of 80 pieces each.
    const census = await fabricCensus(page)
    check('standard spurs pool into band + nose-wrap buckets', census.pools.length === 2, JSON.stringify(census.pools))
    check('buckets hold both standard spurs’ 160 loop pieces', census.pools[0] === 80 && census.pools[1] === 80, JSON.stringify(census.pools))
    check('pooled banks hidden, lone alternate-weave banks live', census.live.visible === 2 && census.live.hidden === 4, JSON.stringify(census.live))
    check('pool fabricUv is vec4', census.itemSizes.every((s) => s === 4), JSON.stringify(census.itemSizes))

    // 2. scroll. The sim worker takes a couple of seconds to boot (Jolt WASM + scene build) before the
    // first behavior step; wait for a live bank to actually move before sampling.
    await page.evaluate(() => { window.__oip.view.focusOn(['spurA']) })
    await page.waitForTimeout(1200)
    await page.evaluate(() => window.__oip.controller.run())
    await page.waitForFunction(() => {
      let moving = false
      window.__oip.view.scene.traverse((o) => {
        // fabricScroll is vec2 [base, rate]; a live bed is "moving" once it carries a nonzero rate
        if (o.isInstancedMesh && o.geometry?.attributes?.fabricScroll && o.userData.instancePool !== true && o.geometry.attributes.fabricScroll.array[1] !== 0) moving = true
      })
      return moving
    }, { timeout: 15000 })
    await page.waitForTimeout(500)

    // data level: the biggest standard bucket (80 = spurB moving 40 + spurC still 40)
    const poolScroll = () =>
      page.evaluate(() => {
        let best = null
        window.__oip.view.scene.traverse((o) => {
          if (o.isInstancedMesh && o.userData.instancePool === true && o.geometry?.attributes?.fabricScroll) {
            const a = o.geometry.attributes.fabricScroll
            if (!best || o.count > best.count) best = { count: o.count, itemSize: a.itemSize, values: Array.from(a.array.slice(0, o.count * a.itemSize)) }
          }
        })
        return best
      })
    const s1 = await poolScroll()
    await page.waitForTimeout(600)
    const s2 = await poolScroll()
    check('pool scroll buffer present (largest standard bucket)', !!s1 && !!s2 && s1.count === 80, s1 ? `${s1.count}` : 'none')
    if (s1 && s2) {
      check('pooled scroll is vec2 [base, rate]', s1.itemSize === 2 && s1.values.length === 160, `itemSize ${s1.itemSize}, ${s1.values.length} floats`)
      // the shared belt clock drives the scroll, so a running bed must not rewrite its buffer per frame
      const churned = s2.values.filter((v, i) => v !== s1.values[i]).length
      check('running spur does not rewrite the scroll buffer per frame', churned === 0, `${churned} floats churned`)
      const rates = s2.values.filter((_, i) => i % 2 === 1)
      const moving = rates.filter((r) => Math.abs(r) > 1e-4).length
      const stillZero = rates.filter((r) => r === 0).length
      check('running spur carries a pooled scroll rate (40 instances)', moving === 40, `moving ${moving}/80`)
      check('speed-0 spur scroll rate stays 0 (40 instances)', stillZero === 40, `${stillZero}`)
    }
    // pixel level: arrows weave scrolling on spurA, camera already framed on it
    const dRun = await frameDiff(page)
    check('running spur bed scrolls on screen', dRun > 1500, `${dRun} changed bytes`)
    await page.evaluate(() => window.__oip.controller.stop())
    await page.waitForTimeout(1000)
    const dStop = await frameDiff(page)
    check('stop freezes the bed', dStop < 200, `${dStop} changed bytes`)

    // 3. cross-part pooling: a straight belt's 2 band instances join the spurs' standard band bucket
    const before = await fabricCensus(page)
    await page.evaluate(() => {
      const s = window.__oip.store
      const scene = s.getState().scene
      const belt = {
        id: 'beltX', type: 'part', packageId: 'oip.belt-conveyor', position: [6, 0.75, 0], rotationY: 0,
        params: { segments: [[3, 0]], width: 1.0, height: 0.28, speed: 1, standHeight: 0.75 },
      }
      s.commit('add-belt', { ...scene, parts: [...scene.parts, belt] })
      s.select('spurA'); s.select(null) // force a pool rebuild
    })
    await page.waitForTimeout(2500)
    const after = await fabricCensus(page)
    check('belt bands join the spur band bucket (shared template + material)', after.pools[0] === before.pools[0] + 2,
      `${JSON.stringify(before.pools)} → ${JSON.stringify(after.pools)}`)

    // 4. draw scaling: back to 3 spurs, then +3 more - only the plain meshes (gap-fill + 2 guards) add draws
    await page.evaluate(() => {
      const s = window.__oip.store
      const scene = s.getState().scene
      s.commit('rm-belt', { ...scene, parts: scene.parts.filter((p) => p.id !== 'beltX') })
      s.select('spurA'); s.select(null)
    })
    await page.waitForTimeout(1500)
    const draws3 = await page.evaluate(() => window.__oip.view.getStats().drawCalls)
    await page.evaluate(() => {
      const s = window.__oip.store
      const scene = s.getState().scene
      const mk = (id, dz) => ({
        id, type: 'part', packageId: 'oip.spur-conveyor', position: [6, 2, dz], rotationY: 0,
        params: { length: 2, width: 1.524, angleFrontDeg: 30, angleBackDeg: 0, speed: 1, standHeight: 2 },
      })
      s.commit('more-spurs', { ...scene, parts: [...scene.parts, mk('spurD', 0), mk('spurE', 4), mk('spurF', -4)] })
      s.select(null)
    })
    await page.waitForTimeout(3000)
    await page.evaluate(() => { window.__oip.store.select('spurD'); window.__oip.store.select(null) })
    await page.waitForTimeout(1200)
    const draws6 = await page.evaluate(() => window.__oip.view.getStats().drawCalls)
    check('3→6 spurs adds only the plain meshes (≤ ~7/spur)', draws6 - draws3 <= 21, `${draws3} → ${draws6} (Δ${draws6 - draws3})`)

    await page.evaluate(() => window.__oip.view.focusOn(['spurA']))
    await page.waitForTimeout(1200)
    await cleanShot(page, join(import.meta.dirname, 'shots', 'spur-banks.png'))

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  } finally {
    await browser.close()
    vite.kill()
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
