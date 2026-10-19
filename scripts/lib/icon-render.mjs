// Shared icon rasterizer for the two icon authoring tools (gen-desktop-icon.mjs, gen-pwa-icons.mjs).
//
// Three things decide how a small icon looks. Each is easy to get wrong and only shows when the result is
// zoomed in:
//
//   1. Trim the artboard. Empty margin uses up resolution. The OIP mark has ~9% margin, which at 16px is
//      ~2 of the 16 pixels.
//   2. Never rasterize a vector straight to a tiny size. At that density librsvg has almost no coverage
//      to antialias with and the dark keyline disappears, so the boxes-on-a-pallet mark becomes a brown
//      blob. Render one big master and reduce it to size.
//   3. Sharpen after reduction, at small sizes only. A reduction filter lowers edge contrast and the
//      sharpen restores it. Above ~64px it only adds artefacts.
//
// Measured on this mark: (2) makes the biggest difference, then (1). Compared side by side at 16/24/32,
// a straight-to-size rasterization looks worse than a naive downscale.

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

export const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 }

/**
 * Rasterize `svgPath` once at high resolution and trim its transparent margin, so every size
 * derived from it is measured off real ink rather than the artboard.
 *
 * `width` must be at least 4x the largest icon you intend to render, so `renderIcon`'s supersample
 * step is a reduction rather than an upscale.
 */
export async function vectorMaster(svgPath, { width = 2048 } = {}) {
  const meta = await sharp(svgPath).metadata()
  const density = Math.round((72 * width) / meta.width)
  const raster = await sharp(svgPath, { density }).png().toBuffer()
  const buf = await sharp(raster).trim({ threshold: 1 }).png().toBuffer()
  const { width: w, height: h } = await sharp(buf).metadata()
  return { buf, width: w, height: h }
}

/**
 * One square icon from a `vectorMaster`.
 *
 * `scale` shrinks the mark inside the square (maskable icons need their content in a safe zone);
 * `background` fills what's left. Reduction runs in two hops - a 4x supersample, then lanczos3 -
 * because a single hop from the full master is filter-limited and loses the keyline.
 */
export async function renderIcon(master, size, { scale = 1, background = TRANSPARENT, sharpen } = {}) {
  const inner = Math.round(size * scale)
  const doSharpen = sharpen ?? size <= 64

  let pipe = sharp(master.buf)
  if (inner * 4 <= master.width) pipe = pipe.resize({ width: inner * 4, fit: 'inside' })
  let out = await pipe.resize({ width: inner, height: inner, fit: 'inside', kernel: 'lanczos3' }).toBuffer()
  if (doSharpen) out = await sharp(out).sharpen({ sigma: 0.6, m1: 1, m2: 2 }).toBuffer()

  // centre on an exact square: icon containers assume square, and the mark is slightly wider than tall
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: out, gravity: 'center' }])
    .png()
    .toBuffer()
}
