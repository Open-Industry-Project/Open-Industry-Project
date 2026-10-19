// Builds the social-share card public/og-image.jpg (1200x630) = the real-sim hero
// poster + the official OIP wordmark on a caption band. Re-run after the video changes:
//   node scripts/gen-og-image.mjs   (depends on public/sim-loop-poster.jpg)
/* global console, process */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'

const root = join(import.meta.dirname, '..')
const poster = join(root, 'public', 'sim-loop-poster.jpg')
const logo = join(root, 'scripts', 'brand', 'oip-logo-horizontal-inv.png')
const out = join(root, 'public', 'og-image.jpg')

// cover-fit the poster to 1200x630, nudge it darker, lay a caption band across the
// bottom, then drop the wordmark (≈420px wide) into the band, bottom-left.
const filter = [
  '[0:v]scale=1200:630:force_original_aspect_ratio=increase,crop=1200:630,eq=brightness=-0.05[bg]',
  '[bg]drawbox=x=0:y=470:w=1200:h=160:color=black@0.55:t=fill[band]',
  '[1:v]scale=420:-1[logo]',
  '[band][logo]overlay=56:630-overlay_h-46',
].join(';')

const r = spawnSync(
  ffmpegPath,
  ['-y', '-i', poster, '-i', logo, '-filter_complex', filter, '-frames:v', '1', '-q:v', '3', out],
  { stdio: ['ignore', 'ignore', 'inherit'] },
)
if (r.status !== 0) process.exit(r.status ?? 1)
console.log('wrote public/og-image.jpg')
