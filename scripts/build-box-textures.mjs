// Generates the cardboard box's textures (public/textures/BoxCardboard*.webp) for the mesh built in
// src/render/parts/cargoBoxMesh.ts. Rerun it after changing that mesh's layout.
//
// Run: node scripts/build-box-textures.mjs [--preview <dir>]
//
// Every texel is computed here, from seeded noise and SVG drawn in this file, so the box's textures
// have no source but this script (THIRD_PARTY_NOTICES.md "3D models, textures and other media"). The
// label is fictional: no real company, and its numbers follow no real carrier's format.
//
// Nothing is painted in UV space. The mesh's own UV triangles are rasterized, each texel keeps the
// box-space position and normal it maps to, and the cardboard, seams, tape, label and symbols are
// drawn in BOX space: they land on the right face whatever the unwrap, and the noise is seamless
// across island borders.
//
// Box space: the mesh spans -1..1 on each axis (the renderer halves it to a unit cube, which the
// part's length/width/height then stretch). The demo box is 0.6 x 0.4 x 0.4 m (L x H x W), so decals
// on the +-Z faces are drawn 1.5x narrower in s to come out square on the default box.
//
// The colour map ships at 1024 and the normal and roughness maps at 512: at 512 the label print and
// corrugation smear in close-ups, while the normal and roughness maps show no difference
// (32.6 / 35.5 dB PSNR resampled to 512 and back).
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEXTURES = join(repo, 'public', 'textures')
const SIZE = 1024
const DETAIL_SIZE = 512
const previewAt = process.argv.indexOf('--preview')
const PREVIEW = previewAt > 0 ? process.argv[previewAt + 1] : null

// ---------------------------------------------------------------- seeded noise

let seed = 0x0b0c5eed
function rand() {
  // mulberry32
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

function hash3(x, y, z) {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f)
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}
const smooth = (t) => t * t * (3 - 2 * t)
function valueNoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z)
  const u = smooth(x - xi), v = smooth(y - yi), w = smooth(z - zi)
  const lerp = (a, b, t) => a + (b - a) * t
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz)
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  )
}
function fbm(x, y, z, octaves) {
  let sum = 0, amp = 0.5, f = 1, norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * f + i * 17.3, y * f - i * 9.1, z * f + i * 5.7)
    norm += amp
    amp *= 0.5
    f *= 2.03
  }
  return sum / norm
}

// ---------------------------------------------------------------- decals (SVG -> RGBA)

const INK = '#1d1914'
async function rasterSvg(svg, w, h) {
  const { data } = await sharp(Buffer.from(svg)).resize(w, h).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, w, h }
}

function barcodeBars(x, y, w, h, count) {
  // decorative bars, no symbology: widths drawn at random
  let out = '', cx = x
  const unit = w / (count * 2.6)
  while (cx < x + w - unit * 3) {
    const bw = unit * (1 + Math.floor(rand() * 3))
    out += `<rect x="${cx.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${h}" fill="${INK}"/>`
    cx += bw + unit * (1 + Math.floor(rand() * 3))
  }
  return out
}

function labelSvg() {
  const f = 'font-family="Arial, Helvetica, sans-serif"'
  const line = (y) => `<line x1="20" y1="${y}" x2="580" y2="${y}" stroke="${INK}" stroke-width="3"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="760">
  <rect x="0" y="0" width="600" height="760" rx="10" fill="#efeae0"/>
  <text x="30" y="70" ${f} font-weight="bold" font-size="46" fill="${INK}">OIP SAMPLE FREIGHT</text>
  <text x="30" y="108" ${f} font-size="24" fill="${INK}">DEMONSTRATION CARGO - NOT A SHIPMENT</text>
  ${line(130)}
  <text x="30" y="168" ${f} font-size="22" fill="${INK}">SHIP TO</text>
  <text x="30" y="210" ${f} font-weight="bold" font-size="34" fill="${INK}">LINE 3 - OUTBOUND DOCK</text>
  <text x="30" y="252" ${f} font-size="22" fill="${INK}">FROM  RECEIVING, BAY 2</text>
  ${line(276)}
  ${barcodeBars(40, 300, 520, 150, 34)}
  <text x="300" y="490" ${f} font-size="26" text-anchor="middle" fill="${INK}">SAMPLE-0410-27</text>
  ${line(516)}
  <text x="30" y="560" ${f} font-size="22" fill="${INK}">CARTON</text>
  <text x="30" y="608" ${f} font-weight="bold" font-size="44" fill="${INK}">3 OF 12</text>
  <line x1="300" y1="530" x2="300" y2="630" stroke="${INK}" stroke-width="3"/>
  <text x="320" y="560" ${f} font-size="22" fill="${INK}">WEIGHT</text>
  <text x="320" y="608" ${f} font-weight="bold" font-size="44" fill="${INK}">9.8 KG</text>
  ${line(640)}
  ${barcodeBars(40, 660, 330, 70, 22)}
  <text x="390" y="705" ${f} font-size="24" fill="${INK}">LOT 27-B</text>
</svg>`
}

// Handling marks, drawn here in our own shapes (the ideas are generic packaging marks).
const frame = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
  <rect x="8" y="8" width="184" height="184" rx="16" fill="none" stroke="${INK}" stroke-width="9"/>${inner}</svg>`
const keepDrySvg = frame(`
  <path d="M40 112 A60 60 0 0 1 160 112 Q145 100 130 112 Q115 100 100 112 Q85 100 70 112 Q55 100 40 112 Z" fill="${INK}"/>
  <path d="M100 112 V158 Q100 172 86 172 Q74 172 74 160" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>
  ${[[60, 34], [92, 26], [124, 30], [150, 44], [74, 56], [136, 60]].map(([x, y]) => `<path d="M${x} ${y} l-5 12" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>`).join('')}`)
const thisWayUpSvg = frame(`
  ${[70, 130].map((x) => `<path d="M${x} 150 V70 M${x - 22} 92 L${x} 62 L${x + 22} 92" fill="none" stroke="${INK}" stroke-width="12" stroke-linejoin="round" stroke-linecap="round"/>`).join('')}
  <path d="M40 166 H160" stroke="${INK}" stroke-width="12" stroke-linecap="round"/>`)
// three arcs chasing each other round a circle, each ending in an arrowhead
function chasingArrows(cx, cy, r) {
  const pt = (deg, rad = r) => [cx + rad * Math.cos((deg * Math.PI) / 180), cy + rad * Math.sin((deg * Math.PI) / 180)]
  let out = ''
  for (const start of [-150, -30, 90]) {
    const end = start + 80
    const [x0, y0] = pt(start), [x1, y1] = pt(end)
    out += `<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" fill="none" stroke="${INK}" stroke-width="13"/>`
    const tip = pt(end + 22), wingOut = pt(end, r + 17), wingIn = pt(end, r - 17)
    out += `<path d="M${wingOut.map((v) => v.toFixed(1)).join(' ')} L${tip.map((v) => v.toFixed(1)).join(' ')} L${wingIn.map((v) => v.toFixed(1)).join(' ')} Z" fill="${INK}"/>`
  }
  return out
}
const recycleSvg = frame(chasingArrows(100, 100, 52))

// ---------------------------------------------------------------- rasterize the UV atlas

const N = SIZE * SIZE
const covered = new Uint8Array(N)
const posBuf = new Float32Array(N * 3)
const nrmBuf = new Float32Array(N * 3)
{
  const vite = await createServer({
    configFile: false,
    root: repo,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  })
  let mesh
  try {
    mesh = (await vite.ssrLoadModule('/src/render/parts/cargoBoxMesh.ts')).cargoBoxMesh()
  } finally {
    await vite.close()
  }
  const P = mesh.positions
  const Nn = mesh.normals
  const T = mesh.uvs
  const I = mesh.indices
  for (let t = 0; t < I.length; t += 3) {
    const ids = [I[t], I[t + 1], I[t + 2]]
    const px = ids.map((i) => T[i * 2] * SIZE - 0.5)
    const py = ids.map((i) => T[i * 2 + 1] * SIZE - 0.5)
    const area = (px[1] - px[0]) * (py[2] - py[0]) - (px[2] - px[0]) * (py[1] - py[0])
    if (Math.abs(area) < 1e-9) continue
    const x0 = Math.max(0, Math.floor(Math.min(...px)) - 1), x1 = Math.min(SIZE - 1, Math.ceil(Math.max(...px)) + 1)
    const y0 = Math.max(0, Math.floor(Math.min(...py)) - 1), y1 = Math.min(SIZE - 1, Math.ceil(Math.max(...py)) + 1)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const w0 = ((px[1] - x) * (py[2] - y) - (px[2] - x) * (py[1] - y)) / area
        const w1 = ((px[2] - x) * (py[0] - y) - (px[0] - x) * (py[2] - y)) / area
        const w2 = 1 - w0 - w1
        const eps = -0.02 // half a texel of slack, so island edges are fully covered
        if (w0 < eps || w1 < eps || w2 < eps) continue
        const k = y * SIZE + x
        covered[k] = 1
        for (let c = 0; c < 3; c++) {
          posBuf[k * 3 + c] = w0 * P[ids[0] * 3 + c] + w1 * P[ids[1] * 3 + c] + w2 * P[ids[2] * 3 + c]
          nrmBuf[k * 3 + c] = w0 * Nn[ids[0] * 3 + c] + w1 * Nn[ids[1] * 3 + c] + w2 * Nn[ids[2] * 3 + c]
        }
      }
    }
  }
}

// ---------------------------------------------------------------- shade each texel in box space

const label = await rasterSvg(labelSvg(), 600, 760)
const keepDry = await rasterSvg(keepDrySvg, 200, 200)
const thisWayUp = await rasterSvg(thisWayUpSvg, 200, 200)
const recycle = await rasterSvg(recycleSvg, 200, 200)

/** Sample a decal's alpha-weighted colour at face coords (s right, t up) inside rect [s0,s1]x[t0,t1]. */
function decalAt(d, s, t, s0, s1, t0, t1) {
  if (s < s0 || s > s1 || t < t0 || t > t1) return null
  const x = Math.min(d.w - 1, Math.floor(((s - s0) / (s1 - s0)) * d.w))
  const y = Math.min(d.h - 1, Math.floor(((t1 - t) / (t1 - t0)) * d.h))
  const i = (y * d.w + x) * 4
  return [d.data[i], d.data[i + 1], d.data[i + 2], d.data[i + 3] / 255]
}

// Which decals sit on which face. s = right, t = up as seen from outside the box, -1..1.
// +-Z are the long sides (1.5x wider on the default box), so their decals are 1.5x narrower in s.
const square = (cs, ct, h, aspect = 1) => [cs - h / aspect, cs + h / aspect, ct - h, ct + h]
const DECALS = {
  // beside the tape fold (s ~ 0, |t| > 0.55), never under it
  '+x': [[label, ...[0.16, 0.9, -0.47, 0.47]]],
  '-x': [[keepDry, ...square(0.62, 0.6, 0.2)], [recycle, ...square(-0.68, -0.7, 0.13)]],
  '+z': [[thisWayUp, ...square(-0.72, 0.6, 0.22, 1.5)], [keepDry, ...square(-0.4, 0.6, 0.22, 1.5)], [recycle, ...square(0.8, -0.72, 0.13, 1.5)]],
  '-z': [[thisWayUp, ...square(0.72, 0.6, 0.22, 1.5)], [recycle, ...square(-0.8, -0.72, 0.13, 1.5)]],
  '+y': [],
  '-y': [],
}

// Packing tape: a 48 mm strip along X over the flap seam (z ~ 0.03), top and bottom, folding
// 0.45 down each end face. 48 mm on the default 0.4 m width is 0.24 in box units.
const TAPE_Z = 0.03, TAPE_HALF = 0.12, TAPE_DROP = 0.45
function tapeAt(p, axis) {
  if (Math.abs(p[2] - TAPE_Z) > TAPE_HALF) return 0
  if (axis === 1) return 1 // top or bottom face
  if (axis === 0) return Math.abs(p[1]) > 1 - TAPE_DROP ? 1 : 0 // the folds on the end faces
  return 0
}

// Seam lines in box units. Each is ~2 texels wide, so `band` blends its edges over SEAM_SOFT
// instead of stepping, or the line would alias from texel to texel along its length.
const LID_SEAM_Y0 = 0.945, LID_SEAM_Y1 = 0.956
const FLAP_GAP_Z0 = 0.023, FLAP_GAP_Z1 = 0.036
const SEAM_SOFT = 0.004
const SEAM_INK = 40 // sRGB
function band(x, lo, hi) {
  const inside = Math.min(x - lo, hi - x)
  return Math.max(0, Math.min(1, inside / SEAM_SOFT + 0.5))
}

const KRAFT = [188, 143, 94] // sRGB
const albedo = new Float32Array(N * 3)
const height = new Float32Array(N)
const rough = new Float32Array(N)

for (let k = 0; k < N; k++) {
  if (!covered[k]) continue
  const p = [posBuf[k * 3], posBuf[k * 3 + 1], posBuf[k * 3 + 2]]
  const n = [nrmBuf[k * 3], nrmBuf[k * 3 + 1], nrmBuf[k * 3 + 2]]
  const an = n.map(Math.abs)
  const axis = an[0] >= an[1] && an[0] >= an[2] ? 0 : an[1] >= an[2] ? 1 : 2
  const sign = n[axis] >= 0 ? 1 : -1
  const bevel = 1 - an[axis] // 0 on a flat face, up to ~0.4 on the rounded edges

  // flutes: vertical on the sides, along X on the top and bottom
  const across = axis === 1 ? p[2] : axis === 0 ? p[2] : p[0]
  const flute = 0.5 + 0.5 * Math.sin(across * Math.PI * 24)
  const fibre = axis === 1
    ? fbm(p[0] * 5, p[1] * 60, p[2] * 90, 3)
    : fbm(p[0] * 90, p[1] * 5, p[2] * 90, 3)
  const blotch = fbm(p[0] * 1.6 + 3, p[1] * 1.6, p[2] * 1.6 - 2, 4)
  const speck = valueNoise(p[0] * 260, p[1] * 260, p[2] * 260)
  // face coords as seen from outside: right = (-n) x up
  let s, t
  if (axis === 0) { s = -sign * p[2]; t = p[1] }
  else if (axis === 2) { s = sign * p[0]; t = p[1] }
  else { s = p[0]; t = -sign * p[2] }
  const edge = Math.max(Math.abs(s), Math.abs(t))
  const wear = Math.max(0, (edge - 0.9) / 0.1) * 0.5 + bevel * 0.9

  let shade = 0.93 + 0.1 * fibre + 0.03 * flute - 0.16 * Math.max(0, blotch - 0.55) - 0.12 * wear
  if (speck > 0.985) shade -= 0.25
  let rgb = KRAFT.map((c) => c * shade)
  let h = 0.35 * flute + 0.45 * fibre + 0.2 * blotch
  let r = 0.8 + 0.12 * fibre

  const tape = tapeAt(p, axis)
  if (tape) {
    const tapeCol = [214, 182, 124]
    rgb = rgb.map((c, i) => c * 0.35 + tapeCol[i] * 0.65 * (0.97 + 0.04 * blotch))
    h = 1.2 + 0.05 * flute
    r = 0.38
  }

  // Seams, as grooves: the lid line round the top edge where the flaps fold over, and the gap
  // between the flaps along X, top and bottom. Dark in the open, a shade under the tape.
  const seam = Math.max(
    band(p[1], LID_SEAM_Y0, LID_SEAM_Y1),
    p[1] > LID_SEAM_Y0 || p[1] < -0.999 ? band(p[2], FLAP_GAP_Z0, FLAP_GAP_Z1) : 0,
  )
  if (seam > 0) {
    const a = seam * (tape ? 0.8 : 1)
    rgb = rgb.map((v) => v * (1 - a) + SEAM_INK * a)
    h -= 0.7 * seam
    r = r * (1 - a) + 0.5 * a
  }

  const key = (sign > 0 ? '+' : '-') + 'xyz'[axis]
  if (bevel < 0.15) {
    for (const [d, s0, s1, t0, t1] of DECALS[key]) {
      const c = decalAt(d, s, t, s0, s1, t0, t1)
      if (!c || c[3] === 0) continue
      const a = c[3]
      if (d === label) {
        // paper, slightly grubby, then its print
        const grime = 0.9 + 0.08 * blotch
        rgb = rgb.map((v, i) => v * (1 - a) + c[i] * grime * a)
        h = h * (1 - a) + 0.9 * a
        r = r * (1 - a) + (c[0] < 128 ? 0.55 : 0.7) * a
      } else {
        // printed straight onto the board: ink at ~85%, a little patchy
        const inkA = a * (0.78 + 0.12 * fibre) * (c[0] < 128 ? 1 : 0)
        rgb = rgb.map((v) => v * (1 - inkA) + 30 * inkA)
        r = r * (1 - inkA) + 0.6 * inkA
      }
    }
  }

  albedo[k * 3] = rgb[0]
  albedo[k * 3 + 1] = rgb[1]
  albedo[k * 3 + 2] = rgb[2]
  height[k] = h
  rough[k] = r
}

// ---------------------------------------------------------------- pad the gutters

// Copy each island's edge texels outward so mipmaps and bilinear filtering never pull in gutter.
{
  const filled = covered.slice()
  let frontier = []
  for (let k = 0; k < N; k++) if (filled[k]) frontier.push(k)
  for (let pass = 0; pass < 24 && frontier.length; pass++) {
    const next = []
    for (const k of frontier) {
      const x = k % SIZE, y = (k / SIZE) | 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
        const j = ny * SIZE + nx
        if (filled[j]) continue
        filled[j] = 1
        albedo[j * 3] = albedo[k * 3]; albedo[j * 3 + 1] = albedo[k * 3 + 1]; albedo[j * 3 + 2] = albedo[k * 3 + 2]
        height[j] = height[k]
        rough[j] = rough[k]
        next.push(j)
      }
    }
    frontier = next
  }
  for (let k = 0; k < N; k++) {
    if (filled[k]) continue
    albedo[k * 3] = KRAFT[0]; albedo[k * 3 + 1] = KRAFT[1]; albedo[k * 3 + 2] = KRAFT[2]
    height[k] = 0.5
    rough[k] = 0.85
  }
}

// ---------------------------------------------------------------- encode

const toByte = (v) => Math.max(0, Math.min(255, Math.round(v)))
const colorPx = Buffer.alloc(N * 3)
const normalPx = Buffer.alloc(N * 3)
const roughPx = Buffer.alloc(N * 3)
const STRENGTH = 3.2 // height units per texel -> slope
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const k = y * SIZE + x
    colorPx[k * 3] = toByte(albedo[k * 3])
    colorPx[k * 3 + 1] = toByte(albedo[k * 3 + 1])
    colorPx[k * 3 + 2] = toByte(albedo[k * 3 + 2])
    // glTF tangent space: +X = +u (right), +Y = up in the image (toward row 0)
    const hx = height[y * SIZE + Math.min(SIZE - 1, x + 1)] - height[y * SIZE + Math.max(0, x - 1)]
    const hy = height[Math.min(SIZE - 1, y + 1) * SIZE + x] - height[Math.max(0, y - 1) * SIZE + x]
    let nx = -hx * STRENGTH * 0.5, ny = hy * STRENGTH * 0.5, nz = 1
    const len = Math.hypot(nx, ny, nz)
    nx /= len; ny /= len; nz /= len
    normalPx[k * 3] = toByte((nx * 0.5 + 0.5) * 255)
    normalPx[k * 3 + 1] = toByte((ny * 0.5 + 0.5) * 255)
    normalPx[k * 3 + 2] = toByte((nz * 0.5 + 0.5) * 255)
    // metallicRoughness: roughness in G; B (metallic) is ignored at metallicFactor 0
    const rv = toByte(rough[k] * 255)
    roughPx[k * 3] = rv
    roughPx[k * 3 + 1] = rv
    roughPx[k * 3 + 2] = rv
  }
}
// Lossless, like every source texture in public/: the production build re-encodes them (optimize-assets.mjs).
const raw = (px) => sharp(px, { raw: { width: SIZE, height: SIZE, channels: 3 } })
const outputs = [
  ['BoxCardboard.webp', raw(colorPx)],
  ['BoxCardboardNormal.webp', raw(normalPx).resize(DETAIL_SIZE, DETAIL_SIZE)],
  // three samples roughness from G
  ['BoxCardboardRoughness.webp', raw(roughPx).resize(DETAIL_SIZE, DETAIL_SIZE)],
]
for (const [name, img] of outputs) {
  const file = join(TEXTURES, name)
  const info = await img.webp({ lossless: true, effort: 6 }).toFile(file)
  console.log(`wrote ${file}: ${info.width}x${info.height}, ${info.size} B`)
}

if (PREVIEW) {
  mkdirSync(PREVIEW, { recursive: true })
  await Promise.all([
    raw(colorPx).png().toFile(join(PREVIEW, 'BaseColor.png')),
    raw(normalPx).png().toFile(join(PREVIEW, 'Normal.png')),
    raw(roughPx).png().toFile(join(PREVIEW, 'Roughness.png')),
  ])
}
