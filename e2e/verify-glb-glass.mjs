// Verify an imported GLB's glass doesn't freeze the viewport. Glass exported as KHR_materials_transmission
// loads as a MeshPhysicalMaterial, and three renders transmission with a mid-pass framebuffer copy that a
// WebGPU render-bundle encoder can't make: every frame throws `currentPass.end is not a function` and the
// view drops to ~9 fps, unorbitable. GLB adoption swaps it for a translucent standard material
// (materials.ts replaceTransmission). Builds a tiny GLB per variant, loads it through the app's own
// loadMeshAsset into the bundled parts group, orbits, and asserts: no errors, no transmission material in
// the scene, and the image moves. Headed (WebGPU). Run: node e2e/verify-glb-glass.mjs [--webgl] [--only=<variant>]
/* global process, console, window, document, requestAnimationFrame, performance, Buffer, setTimeout */
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

const WEBGL = process.argv.includes('--webgl')
const { port: PORT } = await startServer()
const BASE = `http://localhost:${PORT}/app/${WEBGL ? '?webgl' : ''}`

// one cube, one material; the material JSON is the variant
function cubeGlb(material, extensionsUsed = []) {
  const p = [], n = [], idx = []
  const faces = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]
  for (const [ax, s] of faces) {
    const u = (ax + 1) % 3, v = (ax + 2) % 3, base = p.length / 3
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const q = [0, 0, 0]; q[ax] = s * 0.5; q[u] = a * 0.5; q[v] = b * 0.5
      p.push(...q); const nn = [0, 0, 0]; nn[ax] = s; n.push(...nn)
    }
    if (s > 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    else idx.push(base, base + 2, base + 1, base, base + 3, base + 2)
  }
  const pos = Buffer.from(new Float32Array(p).buffer), nor = Buffer.from(new Float32Array(n).buffer)
  const ind = Buffer.from(new Uint16Array(idx).buffer)
  const bin = Buffer.concat([pos, nor, ind, Buffer.alloc((4 - ((pos.length + nor.length + ind.length) % 4)) % 4)])
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'Cage' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [material], extensionsUsed,
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.length },
      { buffer: 0, byteOffset: pos.length, byteLength: nor.length },
      { buffer: 0, byteOffset: pos.length + nor.length, byteLength: ind.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: p.length / 3, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: n.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
  }
  let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)])
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8)
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b }
  return Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin]).toString('base64')
}

const pbr = { baseColorFactor: [0.8, 0.9, 1, 0.3], metallicFactor: 0, roughnessFactor: 0.05 }
const VARIANTS = {
  opaque: cubeGlb({ name: 'Opaque', pbrMetallicRoughness: { ...pbr, baseColorFactor: [0.8, 0.8, 0.8, 1] } }),
  blend: cubeGlb({ name: 'Glass - Default', alphaMode: 'BLEND', pbrMetallicRoughness: pbr }),
  transmission: cubeGlb({ name: 'Glass - Default', pbrMetallicRoughness: pbr, extensions: { KHR_materials_transmission: { transmissionFactor: 1 } } }, ['KHR_materials_transmission']),
  ior: cubeGlb({ name: 'Glass - Default', alphaMode: 'BLEND', pbrMetallicRoughness: pbr, extensions: { KHR_materials_transmission: { transmissionFactor: 0.9 }, KHR_materials_ior: { ior: 1.5 }, KHR_materials_volume: { thicknessFactor: 0.01 } } }, ['KHR_materials_transmission', 'KHR_materials_ior', 'KHR_materials_volume']),
}

async function launch() {
  const args = ['--disable-features=CalculateNativeWinOcclusion', '--enable-unsafe-webgpu']
  for (const channel of ['msedge', 'chrome', undefined]) {
    try { return await chromium.launch({ headless: WEBGL, channel, args }) } catch { /* next */ }
  }
  throw new Error('no browser')
}

let failed = 0
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7)
for (const [name, data] of Object.entries(VARIANTS)) {
  if (only && only !== name) continue
  const browser = await launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text().slice(0, 300)}`) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`))
  await page.goto(BASE)
  await page.waitForFunction(() => document.querySelector('.viewport-cover.ready') != null && window.__oip?.assetsBusy?.() === false, null, { timeout: 90000 })
  const before = errors.length
  const res = await page.evaluate(async (b64) => {
    const frames = (k) => new Promise((r) => { let f = 0; const t = () => (++f < k ? requestAnimationFrame(t) : r()); requestAnimationFrame(t) })
    const { loadMeshAsset } = await import('/src/render/parts/sdk/materials.ts')
    const { notifyBundleStructureChanged } = await import('/src/render/bundleGroups.ts')
    const view = window.__oip.view
    const scene = await loadMeshAsset({ id: 'probe', mime: 'model/gltf-binary', data: b64 })
    const inst = scene.clone()
    let mat = null
    inst.traverse((o) => { if (o.isMesh) mat = o.material })
    const t = view.controls.target
    inst.position.set(t.x, t.y + 0.6, t.z)
    inst.scale.setScalar(1.5)
    inst.updateMatrixWorld(true)
    view.partsGroup.add(inst)
    notifyBundleStructureChanged()
    const r = view.renderer
    const backend = r.isWebGPURenderer ? (r.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2(fallback)') : 'WebGL'
    // frame-rate: count renderer.render calls via info
    const c0 = r.info?.render?.frame ?? r.info?.frame ?? 0
    const t0 = performance.now()
    await frames(30)
    const c1 = r.info?.render?.frame ?? r.info?.frame ?? 0
    return { backend, type: mat?.type, transparent: mat?.transparent, depthWrite: mat?.depthWrite, transmission: mat?.transmission, ms30: Math.round(performance.now() - t0), renderFrames: c1 - c0, gpuErrors: globalThis.__oipGpuErrors ?? null }
  }, data)
  const shot = async () => (await page.locator('canvas').first().screenshot()).toString('base64')
  const a = await shot()
  const pose = await page.evaluate(() => { const c = window.__oip.view.camera.position, t = window.__oip.view.controls.target; return { px: c.x, py: c.y, pz: c.z, tx: t.x, ty: t.y, tz: t.z } })
  await page.evaluate((p) => window.__oip.view.setCameraPose({ ...p, px: p.tx + (p.pz - p.tz), pz: p.tz - (p.px - p.tx) }, { instant: true }), pose)
  await page.waitForTimeout(1500)
  const b = await shot()
  const after = await page.evaluate(async () => {
    const r = window.__oip.view.renderer
    const c0 = r.info?.render?.frame ?? r.info?.frame ?? 0
    await new Promise((res) => setTimeout(res, 1000))
    return { renderFramesPerSec: (r.info?.render?.frame ?? r.info?.frame ?? 0) - c0, gpuErrors: globalThis.__oipGpuErrors ?? null }
  })
  console.log(`\n== ${name}`, JSON.stringify(res), '\n   orbit changed image:', a !== b, ' after:', JSON.stringify(after))
  for (const e of errors.slice(before, before + 8)) console.log('   ', e)
  if (errors.length - before > 8) console.log(`    ... ${errors.length - before - 8} more`)
  const bad = []
  if (errors.slice(before).some((e) => !e.startsWith('warning'))) bad.push('errors while rendering')
  if (res.transmission > 0) bad.push('a transmission material reached the scene')
  if (a === b) bad.push('orbit did not change the image')
  if (!WEBGL && res.backend !== 'WebGPU') bad.push(`expected WebGPU, got ${res.backend}`)
  console.log(bad.length ? `   FAIL ${name}: ${bad.join('; ')}` : `   PASS ${name}`)
  failed += bad.length ? 1 : 0
  await browser.close()
}
console.log(failed ? `${failed} variant(s) FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
