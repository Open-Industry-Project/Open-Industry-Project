// Generates the warning label on the diverter (examples/parts/diverter):
//
//   public/textures/DiverterLabel.webp   on the bearing block's back face
//
// Run: node scripts/build-diverter-textures.mjs [--preview <dir>]
//
// Every texel is computed here, from SVG drawn in this file, so the texture has no source but this script
// (THIRD_PARTY_NOTICES.md "3D models, textures and other media"). The lettering is a stroke font defined below rather
// than a system font, so the output is the same on every machine. The wording is generic: no maker, no model number.
//
// The decal is a whole box face, which the geometry builder maps 0..1 in u and v. The loader samples with
// flipY = false, so image row 0 is the BOTTOM of the face: the image is drawn upright and flipped on the way out.
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(process.cwd(), 'public', 'textures')
const pi = process.argv.indexOf('--preview')
const PREVIEW = pi > 0 ? process.argv[pi + 1] : null

// ---------------------------------------------------------------- stroke font
// Each glyph is polylines on a 4-wide, 6-tall grid, y down. Only the letters the decals use.

const GLYPHS = {
  A: [[[0, 6], [0, 2], [2, 0], [4, 2], [4, 6]], [[0, 3.5], [4, 3.5]]],
  C: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
  G: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3], [2, 3]]],
  I: [[[1, 0], [3, 0]], [[2, 0], [2, 6]], [[1, 6], [3, 6]]],
  K: [[[0, 0], [0, 6]], [[4, 0], [0, 3.5]], [[1.5, 2.6], [4, 6]]],
  L: [[[0, 0], [0, 6], [4, 6]]],
  M: [[[0, 6], [0, 0], [2, 3], [4, 0], [4, 6]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  O: [[[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]]],
  P: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]]],
  R: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]], [[2, 3], [4, 6]]],
  S: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 2], [1, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  V: [[[0, 0], [2, 6], [4, 0]]],
  ' ': [],
}

/** `text` as SVG polylines, centred on (cx, baseline-top y), each glyph `h` px tall */
function lettering(text, cx, y, h, color) {
  const s = h / 6
  const advance = 5.4 * s
  const width = text.length * advance - 1.4 * s
  let x = cx - width / 2
  const out = []
  for (const ch of text) {
    const g = GLYPHS[ch]
    if (!g) throw new Error(`no glyph for ${JSON.stringify(ch)}`)
    for (const line of g) {
      const pts = line.map(([gx, gy]) => `${(x + gx * s).toFixed(2)},${(y + gy * s).toFixed(2)}`).join(' ')
      out.push(`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${(s * 0.95).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`)
    }
    x += advance
  }
  return out.join('')
}

// ---------------------------------------------------------------- the warning label

const YELLOW = '#f2b705'
const BLACK = '#141414'

function label() {
  const W = 512, H = 512, BAND = 34
  const stripes = []
  // a hazard-striped band round the edge: 45-degree bars, clipped to the frame
  for (let i = -H; i < W + H; i += 48) stripes.push(`<polygon points="${i},0 ${i + 24},0 ${i + 24 - H},${H} ${i - H},${H}" fill="${BLACK}"/>`)
  const tri = { cx: W / 2, top: 74, side: 250 }
  const th = tri.side * 0.866
  const triPts = (inset) => {
    const h = th - inset * 3
    const w = tri.side - inset * 2 * 1.732
    const top = tri.top + inset * 2
    return `${tri.cx},${top} ${tri.cx + w / 2},${top + h} ${tri.cx - w / 2},${top + h}`
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="${YELLOW}"/>
    <clipPath id="band"><path d="M0,0H${W}V${H}H0Z M${BAND},${BAND}V${H - BAND}H${W - BAND}V${BAND}Z" clip-rule="evenodd"/></clipPath>
    <g clip-path="url(#band)">${stripes.join('')}</g>
    <rect x="${BAND}" y="${BAND}" width="${W - 2 * BAND}" height="${H - 2 * BAND}" fill="none" stroke="${BLACK}" stroke-width="4"/>
    <polygon points="${triPts(0)}" fill="${BLACK}" stroke="${BLACK}" stroke-width="10" stroke-linejoin="round"/>
    <polygon points="${triPts(16)}" fill="${YELLOW}"/>
    <rect x="${tri.cx - 11}" y="${tri.top + 70}" width="22" height="88" rx="9" fill="${BLACK}"/>
    <circle cx="${tri.cx}" cy="${tri.top + th - 40}" r="13" fill="${BLACK}"/>
    ${lettering('KEEP CLEAR', W / 2, 352, 44, BLACK)}
    ${lettering('MOVING PARTS', W / 2, 414, 34, BLACK)}
  </svg>`
  return { svg, w: W, h: H }
}

// ---------------------------------------------------------------- write

mkdirSync(OUT, { recursive: true })
if (PREVIEW) mkdirSync(PREVIEW, { recursive: true })
async function write(name, { svg, w, h }) {
  // drawn upright, flipped so image row 0 lands at the bottom of the face (flipY = false)
  const img = sharp(Buffer.from(svg)).resize(w, h).flip()
  await img.clone().webp({ quality: 90 }).toFile(join(OUT, name))
  if (PREVIEW) await sharp(Buffer.from(svg)).resize(w, h).png().toFile(join(PREVIEW, name.replace(/\.webp$/, '.png')))
  console.log(`wrote public/textures/${name}`)
}
await write('DiverterLabel.webp', label())
