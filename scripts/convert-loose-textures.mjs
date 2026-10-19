// One-time source migration: the model textures loaded by URL (building walls,
// six-axis robot, gantry) shipped as 4K lossless PNGs - ~16 MB. PNG barely
// compresses and resizing alone left them heavy; earlier palette quantization
// banded the flat wall/floor albedo. WebP fixes both: lossy q85 for BaseColor
// (visually near-lossless, no banding) and lossless for ORM/data maps (exact
// roughness/metalness, just resized). Originals remain in git history.
//
// Idempotent: once converted there are no PNGs left to convert. Run:
//   npm run convert-textures   (then the code references *.webp)

import { readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIRS = ['models/building/textures', 'models/sixaxis', 'models/gantry'].map((d) => join(ROOT, 'public', d))
const CAP = 2048

async function main() {
  let before = 0
  let after = 0
  let n = 0
  for (const dir of DIRS) {
    let files
    try { files = readdirSync(dir) } catch { continue }
    for (const f of files) {
      if (!/\.png$/i.test(f)) continue
      const src = join(dir, f)
      const dst = src.replace(/\.png$/i, '.webp')
      const isData = !/basecolor/i.test(f) // ORM / normal / data maps must stay lossless
      const pipe = sharp(src).resize(CAP, CAP, { fit: 'inside', withoutEnlargement: true })
      const buf = await (isData ? pipe.webp({ lossless: true, effort: 6 }) : pipe.webp({ quality: 85, effort: 6 })).toBuffer()
      const beforeSize = statSync(src).size
      writeFileSync(dst, buf)
      rmSync(src)
      before += beforeSize
      after += buf.length
      n++
      console.log(`  ${f} → ${f.replace(/\.png$/i, '.webp')}  ${(beforeSize / 1e6).toFixed(2)} → ${(buf.length / 1e6).toFixed(2)} MB${isData ? '  [lossless]' : ''}`)
    }
  }
  if (n === 0) {
    console.log('No PNGs to convert (already migrated).')
    return
  }
  console.log(`\n${n} textures: ${(before / 1e6).toFixed(1)} MB → ${(after / 1e6).toFixed(1)} MB`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
