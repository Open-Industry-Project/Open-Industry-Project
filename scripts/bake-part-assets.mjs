// SHIPPED PART ASSETS: the optimized bytes of every model and texture a first-party part names, committed under their
// content hash, so a project's copy of a built-in can carry the very bytes the app ships (docs/part-sources.md,
// "Assets"). Dev serves public/ raw and only `npm run build` optimizes, so the bytes a copy carries could otherwise
// differ between a copy made in dev and one made in production (the AGV: 9.3 MB raw, 0.68 MB shipped).
//
//   node scripts/bake-part-assets.mjs           optimize each part asset (scripts/optimize-assets.mjs, the build's
//                                               own pass) and write public/part-assets/<sha256>.<ext> + the table
//   node scripts/bake-part-assets.mjs --check   fail if a part names an asset with no baked file, or one whose source
//                                               (or the optimizer) changed since it was baked
//
// What it writes:
//   public/part-assets/<sha256>.<ext>  the shipped bytes, named by their SHA-256. APPEND-ONLY: a project's copy names
//                                      a hash for good, so a file never leaves once any build has used it.
//   src/core/shippedPartAssets.ts      GENERATED: each source URL (`/models/AGV.glb`) -> the hash of its baked bytes,
//                                      plus the input version it was baked from (scripts/lib/asset-versions.mjs: the
//                                      source file and everything that turns it into the shipped one).
// The package build (sim/buildPackage.ts) points a part's asset at its baked file through that table.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeAssetVersions } from './lib/asset-versions.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')
const OUT_DIR = join(root, 'public', 'part-assets')
const TABLE = join(root, 'src', 'core', 'shippedPartAssets.ts')
const SCRATCH = '.part-assets-bake' // inside the repo: optimize-assets resolves its target against the repo root

/** every app-served URL a first-party part's manifest names */
function partAssetUrls() {
  const urls = new Set()
  const parts = join(root, 'examples', 'parts')
  for (const d of readdirSync(parts, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    for (const name of ['rig.json', 'manifest.json']) {
      const file = join(parts, d.name, name)
      if (!existsSync(file)) continue
      for (const a of JSON.parse(readFileSync(file, 'utf8')).assets ?? []) if (typeof a?.url === 'string' && a.url.startsWith('/')) urls.add(a.url)
    }
  }
  return [...urls].sort()
}

/** the table the last bake wrote (url -> { sha256, ext, input }), read back out of the generated module */
function readTable() {
  if (!existsSync(TABLE)) return {}
  const m = readFileSync(TABLE, 'utf8').match(/= (\{[\s\S]*\}) as const/)
  return m ? JSON.parse(m[1]) : {}
}

const urls = partAssetUrls()
const inputs = computeAssetVersions(root)
const table = readTable()

if (check) {
  const problems = []
  for (const url of urls) {
    const e = table[url]
    if (!e) problems.push(`${url}: never baked`)
    else if (e.input !== inputs[url]) problems.push(`${url}: its source or the optimizer changed since it was baked`)
    else if (!existsSync(join(OUT_DIR, `${e.sha256}${e.ext}`))) problems.push(`${url}: public/part-assets/${e.sha256}${e.ext} is missing`)
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`  ${p}`)
    console.error(`FAIL  ${problems.length} part asset(s) not baked as shipped. Run: node scripts/bake-part-assets.mjs`)
    process.exit(1)
  }
  console.log(`ok: all ${urls.length} part assets are baked as this build would ship them`)
  process.exit(0)
}

// 1. the part assets alone, at their own paths, in a scratch "dist" the build's optimizer runs over
const scratch = join(root, SCRATCH)
rmSync(scratch, { recursive: true, force: true })
for (const url of urls) {
  const src = join(root, 'public', url)
  if (!existsSync(src)) throw new Error(`${url}: no such file in public/`)
  mkdirSync(dirname(join(scratch, url)), { recursive: true })
  copyFileSync(src, join(scratch, url))
}
try {
  execFileSync(process.execPath, [join(root, 'scripts', 'optimize-assets.mjs'), SCRATCH], { cwd: root, stdio: 'inherit' })

  // 2. each optimized file under its hash, and the table
  mkdirSync(OUT_DIR, { recursive: true })
  // a url no first-party part names any more keeps its entry: older projects' copies still name its bytes, and
  // the table is how the app recognises them as its own (the file itself is append-only, below)
  const next = Object.fromEntries(Object.entries(table).filter(([url]) => !urls.includes(url)))
  let added = 0
  for (const url of urls) {
    const bytes = readFileSync(join(scratch, url))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const ext = extname(url).toLowerCase()
    const out = join(OUT_DIR, `${sha256}${ext}`)
    if (!existsSync(out)) {
      writeFileSync(out, bytes)
      added++
      console.log(`+ ${url} -> public/part-assets/${sha256}${ext} (${(bytes.length / 1024).toFixed(0)} KB)`)
    }
    next[url] = { sha256, ext, input: inputs[url] }
  }
  writeFileSync(
    TABLE,
    `// GENERATED by scripts/bake-part-assets.mjs - do not edit. Rerun it after changing a part's model or texture.
//
// Each app-served asset a first-party part names, by its source URL: the SHA-256 of the bytes the app ships for it
// (public/part-assets/<sha256><ext>, committed and append-only) and the input version they were baked from
// (scripts/lib/asset-versions.mjs). sim/buildPackage.ts points a part's asset at its baked file through this, so a
// project's copy of a built-in names exactly the bytes it was copied with (docs/part-sources.md, "Assets").

export interface ShippedPartAsset {
  sha256: string
  ext: string
  input: string
}

export const SHIPPED_PART_ASSETS: Readonly<Record<string, ShippedPartAsset>> = ${JSON.stringify(next, null, 2)} as const
`,
  )
  console.log(`${added} file(s) added to public/part-assets; ${urls.length} part assets in src/core/shippedPartAssets.ts`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
