// Generates the Electron desktop icon: apps/desktop/oip-logo.ico
//
// One-off authoring tool like gen-pwa-icons.mjs - the output is committed. Re-run with
// `npm run desktop-icon` if the mark changes.
//
// Source is public/oip-icon.svg (the boxes-on-a-pallet mark, true vector). Rendering rules and why
// they matter live in scripts/lib/icon-render.mjs - read that before changing how sizes are made.
//
// 24px is included: it's the Windows taskbar size at 100% scaling, and without it Windows
// synthesizes the most-looked-at icon in the OS from the 32 with its own cheap filter.
//
// Known limit: even done right, 16 and 24 are busy. Three boxes, a planked pallet and tape lines
// are more detail than those pixel counts can hold. Genuinely crisp small sizes need SIMPLIFIED art
// drawn for them (fewer boxes, heavier keyline, no plank detail) - a drawing task, not a pipeline one.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { renderIcon, vectorMaster } from './lib/icon-render.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.argv[2] || join(ROOT, 'public', 'oip-icon.svg')
const OUT = join(ROOT, 'apps', 'desktop', 'oip-logo.ico')

// Windows picks the nearest entry per surface: 16 title bar, 24 taskbar @100%, 32 alt-tab and
// taskbar @125-150%, 48 Explorer large, 256 extra-large + whatever a packaged .exe embeds.
const SIZES = [16, 24, 32, 48, 64, 128, 256]

/**
 * Packs PNG buffers into an .ico. Vista+ reads PNG-compressed entries directly, so there is no BMP
 * encoding to do and no dependency to add: 6-byte header, one 16-byte directory entry each, payloads.
 */
function packIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type 1 = icon
  header.writeUInt16LE(images.length, 4)

  const dir = Buffer.alloc(16 * images.length)
  let offset = header.length + dir.length
  images.forEach(({ size, buf }, i) => {
    const o = i * 16
    dir[o] = size === 256 ? 0 : size // 0 means 256 - a byte can't hold it
    dir[o + 1] = size === 256 ? 0 : size
    dir[o + 2] = 0 // palette size (0 = truecolour)
    dir[o + 3] = 0 // reserved
    dir.writeUInt16LE(1, o + 4) // colour planes
    dir.writeUInt16LE(32, o + 6) // bits per pixel
    dir.writeUInt32LE(buf.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += buf.length
  })
  return Buffer.concat([header, dir, ...images.map((i) => i.buf)])
}

async function main() {
  const master = await vectorMaster(SRC)
  console.log(`source ${SRC} -> trimmed master ${master.width}x${master.height}`)

  const images = []
  for (const size of SIZES) images.push({ size, buf: await renderIcon(master, size) })

  const ico = packIco(images)
  writeFileSync(OUT, ico)
  console.log(`wrote ${OUT} (${images.map((i) => i.size).join(', ')}) ${ico.length} bytes`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
