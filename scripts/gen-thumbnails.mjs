// Offline catalog-thumbnail generator.
//
// Rendering every part type in-browser on startup would mean downloading ~11 MB
// of part GLBs (six-axis robot, AGV, stack light, …) just to draw the parts
// catalog's 120 px icons. This script renders those icons once, headless,
// using the same offscreen renderer the app uses (window.__oip.getPartThumbnails),
// and writes them to public/thumbnails/<type>.webp. The catalog then loads those
// tiny static images instantly, and the GLBs only download when a part is placed.
//
// The first-party BUNDLED custom-part cards get the same treatment via
// window.__oip.getBundledThumbnails → public/thumbnails/pkg/<packageId>.webp, so
// they don't spin up an offscreen render (a second WebGPU device - measured seconds
// on the cold-load critical path) in every browser session. Loaded (desktop-folder)
// and in-app authored parts are inherently dynamic and still render at runtime.
//
// Run locally whenever the models or part set change, then commit the results:
//   npm run thumbnails                  render and write every picture
//   npm run thumbnails -- --stale       write only the part pictures whose sources changed (npm run parts:record runs it)
//   npm run thumbnails -- --check       no browser: list those pictures and exit 1 if there are any
//
// Each part picture written records the hash of its sources (scripts/lib/thumbnail-sources.mjs), and
// thumbnailSources.test.ts fails when a part changes without a new picture.
//
// CI does not run this - it just serves the committed images - so no headless
// browser is needed in the deploy build.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
import { pkgThumbFile, RECORD_FILE, readRecord, staleThumbnails, thumbnailSources } from './lib/thumbnail-sources.mjs'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'thumbnails')
const PORT = 5197
const URL = `http://localhost:${PORT}/app/`
const SIZE = 128 // px; catalog cards are small, hi-dpi covered by this
// `--libraries`: only the first-party library parts (libraries/<lib>/<part>/thumbnail.webp), so adding one does not
// re-render every built-in's picture
const LIBRARIES_ONLY = process.argv.includes('--libraries')
const LIBS = join(ROOT, 'libraries')
const STALE_ONLY = process.argv.includes('--stale')
const CHECK_ONLY = process.argv.includes('--check')

/** a written file's key in the source record: its path from the repo root, with forward slashes */
const recordKey = (file) => relative(ROOT, file).split('\\').join('/')

/** Record the current source hash of each picture written, and drop entries for parts that no longer exist. */
function updateRecord(written) {
  const sources = thumbnailSources(ROOT)
  const record = readRecord(ROOT)
  for (const key of written) if (sources[key]) record[key] = sources[key]
  const kept = Object.keys(sources).filter((key) => record[key]).map((key) => [key, record[key]])
  writeFileSync(join(ROOT, RECORD_FILE), JSON.stringify(Object.fromEntries(kept), null, 2) + '\n')
}

// Encode one data-URL PNG to a SIZE×SIZE webp on disk; returns false on an empty URL.
async function writeWebp(dir, name, dataUrl) {
  const b64 = dataUrl.split(',')[1]
  if (!b64) return false
  const png = Buffer.from(b64, 'base64')
  const webp = await sharp(png).resize(SIZE, SIZE, { fit: 'inside' }).webp({ quality: 82 }).toBuffer()
  writeFileSync(join(dir, name), webp)
  return true
}

async function startVite() {
  // A server already on the port would answer the readiness probe below while our own vite dies on
  // --strictPort, and the run would render against whatever that server is (a leftover from a crashed run
  // rendered every textured part black and dropped the GLB parts). Refuse instead.
  const taken = await fetch(URL).then(() => true, () => false)
  if (taken) throw new Error(`port ${PORT} is already in use: stop whatever is serving ${URL} and rerun`)
  const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stderr.on('data', (d) => process.stderr.write(d))
  const deadline = Date.now() + 120000 // a cold vite optimizes its deps first
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`vite exited ${proc.exitCode}`)
    try {
      const res = await fetch(URL)
      if (res.ok) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      proc.kill()
      throw new Error('vite did not start')
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return proc
}

async function main() {
  const stale = new Set(staleThumbnails(ROOT))
  if (CHECK_ONLY || STALE_ONLY) {
    for (const key of stale) console.log(`  stale: ${key}`)
    if (stale.size === 0) {
      console.log('part thumbnails are current')
      return
    }
    if (CHECK_ONLY) {
      console.error(`FAIL  ${stale.size} part thumbnail(s) rendered from older sources. Run: npm run thumbnails -- --stale`)
      process.exit(1)
    }
  }
  // in --stale mode only the stale part pictures are written
  const wanted = (key) => !STALE_ONLY || stale.has(key)
  const recorded = []
  mkdirSync(OUT, { recursive: true })
  const vite = await startVite()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  try {
    await page.goto(URL, { timeout: 180000 }) // the first page load of a cold vite transforms the whole graph
    // Wait for both generator hooks AND the bundled packages to have loaded + registered (the viewport
    // effect calls loadBundledExamples after mount), so getBundledThumbnails renders a populated catalog.
    await page.waitForFunction(
      () =>
        !!(
          window.__oip &&
          window.__oip.getPartThumbnails &&
          window.__oip.getBundledThumbnails &&
          window.__oip.store &&
          window.__oip.store.getState().bundledPackages.length > 0
        ),
      { timeout: 20000 },
    )
    // renders every part type offscreen from the real visual factories
    const entries = LIBRARIES_ONLY || STALE_ONLY ? [] : await page.evaluate(async () => {
      const map = await window.__oip.getPartThumbnails()
      return [...map.entries()] // [type, "data:image/png;base64,…"][]
    })
    if (entries.length === 0 && !LIBRARIES_ONLY && !STALE_ONLY) throw new Error('no thumbnails produced (WebGL unavailable?)')

    let written = 0
    for (const [type, dataUrl] of entries) {
      if (await writeWebp(OUT, `${type}.webp`, dataUrl)) written++
      else console.warn(`  skip ${type}: empty data URL`)
    }
    console.log(`Wrote ${written}/${entries.length} thumbnails to public/thumbnails`)

    // Bundled custom-part cards, rendered through the same offscreen factory, keyed by package id.
    const pkgOut = join(OUT, 'pkg')
    mkdirSync(pkgOut, { recursive: true })
    const pkgEntries = LIBRARIES_ONLY ? [] : await page.evaluate(async () => window.__oip.getBundledThumbnails())
    let pkgWritten = 0
    for (const [id, dataUrl] of pkgEntries) {
      const name = `${pkgThumbFile(id)}.webp`
      if (!wanted(recordKey(join(pkgOut, name)))) continue
      if (await writeWebp(pkgOut, name, dataUrl)) {
        pkgWritten++
        recorded.push(recordKey(join(pkgOut, name)))
      } else console.warn(`  skip pkg ${id}: empty data URL`)
    }
    console.log(`Wrote ${pkgWritten} package thumbnails to public/thumbnails/pkg`)

    // First-party library parts (libraries/<lib>/<part>, docs/part-libraries.md): no built-in, so the page builds each
    // from its source and renders it; the picture goes beside the source, where npm run build-library packs it.
    const sources = []
    for (const lib of existsSync(LIBS) ? readdirSync(LIBS, { withFileTypes: true }).filter((e) => e.isDirectory()) : []) {
      for (const dir of readdirSync(join(LIBS, lib.name), { withFileTypes: true }).filter((e) => e.isDirectory())) {
        const at = join(LIBS, lib.name, dir.name)
        if (!existsSync(join(at, 'manifest.json')) || !existsSync(join(at, 'behavior.js'))) continue
        if (!wanted(recordKey(join(at, 'thumbnail.webp')))) continue
        sources.push({ at, manifest: JSON.parse(readFileSync(join(at, 'manifest.json'), 'utf8')), behavior: readFileSync(join(at, 'behavior.js'), 'utf8').replace(/\r\n/g, '\n') })
      }
    }
    if (sources.length > 0) {
      const libEntries = await page.evaluate(async (list) => window.__oip.getSourceThumbnails(list), sources.map(({ manifest, behavior }) => ({ manifest, behavior })))
      const byId = new Map(libEntries)
      let libWritten = 0
      for (const src of sources) {
        const dataUrl = byId.get(src.manifest.id)
        if (dataUrl && (await writeWebp(src.at, 'thumbnail.webp', dataUrl))) {
          libWritten++
          recorded.push(recordKey(join(src.at, 'thumbnail.webp')))
        } else console.warn(`  skip library part ${src.manifest.id}: no picture`)
      }
      console.log(`Wrote ${libWritten}/${sources.length} library part thumbnails beside their sources (libraries/)`)
    }
    updateRecord(recorded)

    const total = readdirSync(OUT)
      .filter((f) => f.endsWith('.webp'))
      .reduce((s, f) => s + require('node:fs').statSync(join(OUT, f)).size, 0)
    console.log(`Total: ${(total / 1024).toFixed(0)} KB`)
  } finally {
    await browser.close()
    // `shell: true` makes vite a grandchild: on Windows proc.kill() only ends the shell, leaving vite
    // listening and holding this process open forever. Tree-kill it instead.
    // Synchronous: a failed run exits right after this, before an async taskkill finishes, and leaks vite.
    if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(vite.pid)], { stdio: 'ignore' })
    else vite.kill()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
