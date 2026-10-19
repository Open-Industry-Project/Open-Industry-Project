// Generates the PWA / browser icon set from the Open Industry Project mark.
//
// Source is public/oip-icon.svg - the boxes-on-a-pallet mark as true vector. The raster
// scripts/assets/oip-splash.png would cost quality at BOTH ends of the size range: the mark is only
// 356x324 in that file, so pwa-512x512 would be a 1.44x UPSCALE, while favicon-16 would be a
// single-hop downscale that dissolves the mark into a brown blob. Rendering rules and why they
// matter live in scripts/lib/icon-render.mjs.
//
// Outputs (referenced by index.html, app/index.html and the manifest in vite.config.ts):
//   public/icons/pwa-192x192.png        any   (transparent)
//   public/icons/pwa-512x512.png        any   (transparent)
//   public/icons/pwa-maskable-512x512.png  maskable (mark inside the safe zone on the theme bg)
//   public/apple-touch-icon.png         iOS home screen (opaque theme bg)
//   public/favicon-32.png, favicon-16.png
//
// This is a one-off authoring tool (like gen-thumbnails.mjs) - the outputs are committed to
// public/. Re-run with `npm run pwa-icons` if the mark changes.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { renderIcon, vectorMaster } from './lib/icon-render.mjs'
import { writeFile } from 'node:fs/promises'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.argv[2] || join(ROOT, 'public', 'oip-icon.svg')
const PUB = join(ROOT, 'public')
const ICONS = join(PUB, 'icons')

// the app background (--bg / the manifest's background_color) - this is the icon's field to
// sit on, NOT the status bar's tint, which is theme-color and follows the toolbar instead
const THEME = { r: 0x17, g: 0x18, b: 0x1b, alpha: 1 }

// scale = how much of the square the mark fills. 0.88 leaves the small breathing room a free-standing
// icon wants; maskable must survive an aggressive circular crop, and iOS rounds its own corners.
const OUTPUTS = [
  { path: join(ICONS, 'pwa-512x512.png'), size: 512, scale: 0.88 },
  { path: join(ICONS, 'pwa-192x192.png'), size: 192, scale: 0.88 },
  { path: join(ICONS, 'pwa-maskable-512x512.png'), size: 512, scale: 0.62, background: THEME },
  { path: join(PUB, 'apple-touch-icon.png'), size: 180, scale: 0.8, background: THEME },
  // favicons fill the box: at 32 and 16 every pixel of margin is one you can't spend on the mark
  { path: join(PUB, 'favicon-32.png'), size: 32, scale: 1 },
  { path: join(PUB, 'favicon-16.png'), size: 16, scale: 1 },
]

async function main() {
  mkdirSync(ICONS, { recursive: true })
  const master = await vectorMaster(SRC)
  console.log(`source ${SRC} -> trimmed master ${master.width}x${master.height}`)

  for (const { path, size, scale, background } of OUTPUTS) {
    await writeFile(path, await renderIcon(master, size, { scale, background }))
    console.log(`  ${size.toString().padStart(3)}px @${scale}  ${path.slice(ROOT.length + 1)}`)
  }
  console.log('wrote icons to', PUB)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
