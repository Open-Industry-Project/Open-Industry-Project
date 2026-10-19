/* global console, process, window, URL */
// An old project still draws a part whose source model has been removed from public/.
//
// A copy of a built-in made before part assets were baked names its model by source path (`/models/Diverter.glb`), not
// by hash. When a part is redrawn in code, no current part names its model any more, and the source file is deleted
// (scripts/check-orphan-models.mjs fails the build until it is). The old copy is then fetched from the baked file the
// app last shipped for that path (core/shippedAssets.ts shippedFetchUrl; public/part-assets is append-only), without
// rewriting the copy, whose fingerprint would otherwise mark the part as edited.
//
// For every source path the baked table holds that no current part names (a retired path), this takes the part-corpus
// version that ships those bytes and places it twice: once as stored today (assets by hash), once rewritten the way a
// pre-bake project stored it (assets by source path). Both must draw the same meshes, and nothing may request a
// retired source path. Checked to fail with the fetch-time mapping switched off.
//
// Run: node e2e/verify-retired-model-sources.mjs [--headed]
import { chromium } from 'playwright'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './_server.mjs'

const HEADED = process.argv.includes('--headed')
const ROOT = fileURLToPath(new URL('..', import.meta.url))

let failures = 0
const check = (name, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`)
}

// ---- the retired paths and the corpus versions that ship their bytes -------------------------------------------
const table = JSON.parse(readFileSync(join(ROOT, 'src/core/shippedPartAssets.ts'), 'utf8').match(/= (\{[\s\S]*\}) as const/)[1])
const named = new Set()
for (const d of readdirSync(join(ROOT, 'examples/parts'), { withFileTypes: true }).filter((e) => e.isDirectory())) {
  for (const f of ['rig.json', 'manifest.json']) {
    const file = join(ROOT, 'examples/parts', d.name, f)
    if (existsSync(file)) for (const a of JSON.parse(readFileSync(file, 'utf8')).assets ?? []) if (typeof a.url === 'string') named.add(a.url)
  }
}
const retired = Object.entries(table).filter(([url]) => !named.has(url))
const pathOfSha = new Map(retired.map(([url, e]) => [e.sha256, url]))

// the newest corpus version of each part that ships a retired GLB
const subjects = []
for (const dir of readdirSync(join(ROOT, 'test-corpus/parts'))) {
  const versions = readdirSync(join(ROOT, 'test-corpus/parts', dir)).sort()
  for (const v of versions.reverse()) {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'test-corpus/parts', dir, v), 'utf8'))
    if (!(pkg.assets ?? []).some((a) => a.mime === 'model/gltf-binary' && pathOfSha.has(a.sha256))) continue
    const stored = { ...pkg, id: `${pkg.id}.stored`, name: `${pkg.name} (stored)` }
    // as a pre-bake project held it: every retired asset by its source path, with no hash
    const byPath = {
      ...pkg,
      id: `${pkg.id}.bypath`,
      name: `${pkg.name} (by path)`,
      assets: pkg.assets.map((a) => (pathOfSha.has(a.sha256) ? { id: a.id, mime: a.mime, url: pathOfSha.get(a.sha256) } : a)),
    }
    subjects.push({ part: pkg.id, version: v, stored, byPath })
    break
  }
}

async function main() {
  console.log(`retired source paths: ${retired.map(([u]) => u).join(', ') || '(none)'}`)
  if (subjects.length === 0) {
    // nothing retired yet is not a failure of the mechanism, but then this gate tests nothing, so fail visibly
    console.log('FAIL  HARNESS: no corpus version ships a retired model, so nothing was tested')
    process.exit(1)
  }
  const { port, vite } = await startServer()
  const browser = await chromium.launch({ headless: !HEADED })
  const requests = []
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
    page.on('request', (r) => requests.push(new URL(r.url()).pathname))
    const failed = []
    page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`) })
    await page.goto(`http://localhost:${port}/app/`)
    await page.waitForFunction(() => window.__oip?.store && window.__oip.view && window.__oip.assetsBusy, null, { timeout: 60000 })

    const packages = subjects.flatMap((s) => [s.stored, s.byPath])
    await page.evaluate((pkgs) => {
      const { store } = window.__oip
      const parts = pkgs.map((pkg, i) => {
        const params = {}
        for (const [k, spec] of Object.entries(pkg.params ?? {})) if (spec && 'default' in spec) params[k] = spec.default
        return { id: `p${i}`, type: 'part', packageId: pkg.id, position: [i * 6, 0, 0], rotationY: 0, name: pkg.name, params }
      })
      store.loadScene({ version: store.getState().scene.version, parts, packages: pkgs })
    }, packages)
    await page.waitForFunction(() => window.__oip.assetsBusy() === false, null, { timeout: 120000 })
    await page.waitForTimeout(500)

    // drawn triangles per placed part: every mesh under its visual, instanced ones by their count
    const drawn = await page.evaluate((n) => {
      const out = []
      for (let i = 0; i < n; i++) {
        const entry = window.__oip.view.entries.get(`p${i}`)
        let meshes = 0
        let tris = 0
        entry?.visual.object.traverse((o) => {
          if (!o.isMesh || !o.geometry) return
          const idx = o.geometry.index
          const t = (idx ? idx.count : o.geometry.getAttribute('position')?.count ?? 0) / 3
          meshes++
          tris += t * (o.isInstancedMesh ? o.count : 1)
        })
        out.push({ meshes, tris })
      }
      return out
    }, packages.length)

    subjects.forEach((s, i) => {
      const a = drawn[i * 2]
      const b = drawn[i * 2 + 1]
      const label = `${s.part} @ ${s.version}`
      check(`${label}: the stored copy draws`, a.tris > 0, `${a.meshes} meshes, ${a.tris} tris`)
      check(`${label}: the by-path copy draws the same as the stored one`, a.meshes === b.meshes && a.tris === b.tris, `stored ${a.meshes}/${a.tris}, by path ${b.meshes}/${b.tris}`)
    })
    // the stored copies already fetch the baked files, so requests for them say nothing about the by-path ones. The
    // check is that a by-path copy draws and no request names its source path (a dev server answers a missing file
    // with the app shell, so a raw fetch would not show up as a failed request)
    const asked = [...new Set(requests.filter((p) => retired.some(([url]) => p === url)))]
    check('no request names a retired source path', asked.length === 0, asked.join(', '))
    check('no asset request failed', failed.length === 0, failed.slice(0, 5).join(', '))
  } finally {
    await browser.close()
    vite.kill()
  }
  console.log(failures === 0 ? '\nPASS: old copies draw from the baked files' : `\nFAIL: ${failures} check(s)`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((e) => { console.error(e); process.exit(1) })
