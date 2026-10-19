// Generates the wooden pallet's textures (public/textures/PalletWood*.webp) for the mesh built in
// src/render/parts/palletMesh.ts. Rerun it after changing that mesh's pieces or packing.
//
// Run: node scripts/build-pallet-textures.mjs [--preview <dir>]
//
// Every texel is computed here, from seeded noise, so the textures have no source but this script
// (THIRD_PARTY_NOTICES.md "3D models, textures and other media"). As for the box
// (build-box-textures.mjs), nothing is painted in UV space: the mesh's UV triangles are rasterized, each
// texel keeps the pallet-space position,
// normal and piece it maps to, and the wood is drawn in pallet space, with its grain along each piece's
// long axis. The contact shadows where boards meet are baked into the colour map: a few short rays from
// each texel, tested against the pieces.
//
// The colour map ships at 1024 and the normal and roughness maps at 512, as the model's maps did
// (scripts/optimize-assets.mjs: albedo kept for the nail heads, the detail maps lose nothing at 512).
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

const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})
let mesh, PIECES
try {
  const mod = await vite.ssrLoadModule('/src/render/parts/palletMesh.ts')
  mesh = mod.palletMesh()
  PIECES = mod.PALLET_PIECES
} finally {
  await vite.close()
}

// ---------------------------------------------------------------- seeded noise

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

// ---------------------------------------------------------------- rasterize the UV atlas

const N = SIZE * SIZE
const covered = new Uint8Array(N)
const posBuf = new Float32Array(N * 3)
const nrmBuf = new Float32Array(N * 3)
const pieceBuf = new Uint8Array(N)
{
  const P = mesh.positions, Nn = mesh.normals, T = mesh.uvs, I = mesh.indices
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
        pieceBuf[k] = mesh.piece[ids[0]]
        for (let c = 0; c < 3; c++) {
          posBuf[k * 3 + c] = w0 * P[ids[0] * 3 + c] + w1 * P[ids[1] * 3 + c] + w2 * P[ids[2] * 3 + c]
          nrmBuf[k * 3 + c] = w0 * Nn[ids[0] * 3 + c] + w1 * Nn[ids[1] * 3 + c] + w2 * Nn[ids[2] * 3 + c]
        }
      }
    }
  }
}

// ---------------------------------------------------------------- contact shadows

// Fixed hemisphere directions about +Z (cosine-weighted spiral), rotated onto each texel's normal.
const AO_DIRS = []
{
  const n = 16
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n)
    const a = i * 2.39996
    AO_DIRS.push([r * Math.cos(a), r * Math.sin(a), Math.sqrt(1 - r * r)])
  }
}
const AO_STEPS = [0.004, 0.01, 0.02, 0.035]
const boxes = PIECES.map((p) => [0, 1, 2].flatMap((k) => [p.center[k] - p.half[k], p.center[k] + p.half[k]]))
function inside(x, y, z) {
  for (const b of boxes) if (x > b[0] && x < b[1] && y > b[2] && y < b[3] && z > b[4] && z < b[5]) return true
  return false
}
function occlusion(p, n) {
  // a tangent frame about n
  const t = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  let bx = n[1] * t[2] - n[2] * t[1], by = n[2] * t[0] - n[0] * t[2], bz = n[0] * t[1] - n[1] * t[0]
  const bl = Math.hypot(bx, by, bz)
  bx /= bl; by /= bl; bz /= bl
  const cx = n[1] * bz - n[2] * by, cy = n[2] * bx - n[0] * bz, cz = n[0] * by - n[1] * bx
  let hit = 0
  for (const d of AO_DIRS) {
    const dx = bx * d[0] + cx * d[1] + n[0] * d[2]
    const dy = by * d[0] + cy * d[1] + n[1] * d[2]
    const dz = bz * d[0] + cz * d[1] + n[2] * d[2]
    for (let s = 0; s < AO_STEPS.length; s++) {
      const l = AO_STEPS[s]
      if (inside(p[0] + n[0] * 0.0008 + dx * l, p[1] + n[1] * 0.0008 + dy * l, p[2] + n[2] * 0.0008 + dz * l)) {
        hit += 1 - s / AO_STEPS.length // nearer blockers shade more
        break
      }
    }
  }
  return hit / AO_DIRS.length
}

// ---------------------------------------------------------------- the wood, in pallet space

const WOOD = [124, 95, 62] // sRGB, before contact shadows and weathering
const NAIL = [88, 84, 78]
const NAIL_R = 0.0035

// Nail heads: two per crossing of a deck board over a stringer, on the deck board's outer face.
const nails = []
{
  const decks = PIECES.filter((p) => p.kind === 'deck')
  const stringers = PIECES.filter((p) => p.kind === 'stringer')
  for (const d of decks) {
    const top = d.center[1] > 0
    for (const s of stringers) {
      if ((s.center[1] > 0) !== top) continue
      for (const off of [-0.026, 0.026]) nails.push({ x: d.center[0] + off * (d.half[0] / 0.05), z: s.center[2] + off * 0.4, y: d.center[1] + (top ? d.half[1] : -d.half[1]), top })
    }
  }
}
function nailAt(p, n) {
  if (Math.abs(n[1]) < 0.9) return 0
  for (const nl of nails) {
    if ((n[1] > 0) !== nl.top || Math.abs(p[1] - nl.y) > 0.002) continue
    const r = Math.hypot(p[0] - nl.x, p[2] - nl.z)
    if (r < NAIL_R + 0.0015) return Math.max(0, Math.min(1, (NAIL_R + 0.0015 - r) / 0.0015))
  }
  return 0
}

const albedo = new Float32Array(N * 3)
const height = new Float32Array(N)
const rough = new Float32Array(N)

for (let k = 0; k < N; k++) {
  if (!covered[k]) continue
  const p = [posBuf[k * 3], posBuf[k * 3 + 1], posBuf[k * 3 + 2]]
  let n = [nrmBuf[k * 3], nrmBuf[k * 3 + 1], nrmBuf[k * 3 + 2]]
  const nl = Math.hypot(n[0], n[1], n[2])
  n = n.map((v) => v / nl)
  const pi = pieceBuf[k]
  const piece = PIECES[pi]
  // grain runs along the piece's longest horizontal axis
  const L = piece.half[0] >= piece.half[2] ? 0 : 2
  const A = L === 0 ? 2 : 0 // across, horizontally
  const along = p[L] - piece.center[L]
  const across = p[A] - piece.center[A]
  const up = p[1] - piece.center[1]
  const seed = pi * 7.31
  const tone = 0.78 + 0.3 * hash3(pi, 3, 7) // one board lighter than the next
  const hueShift = (hash3(pi, 11, 5) - 0.5) * 0.12
  const ringFreq = 38 + 30 * hash3(pi, 4, 9) // growth rings per metre, by board

  const endGrain = Math.abs(n[L]) > 0.7
  let shade, h, r
  if (endGrain) {
    // growth rings about a pith off to one side of the board
    const cx = (hash3(pi, 1, 1) - 0.5) * 0.12, cy = -0.03 - 0.05 * hash3(pi, 2, 2)
    const rr = Math.hypot(across - cx, up - cy)
    const ring = 0.5 + 0.5 * Math.sin(rr * Math.PI * 2 * 140 + 3 * fbm(across * 40, up * 40, seed, 2))
    shade = 0.78 - 0.1 * ring + 0.06 * fbm(across * 120, up * 120, seed, 3)
    h = 0.4 + 0.3 * ring
    r = 0.88
  } else {
    // long grain: growth lines across the board that waver and fade along it, over slower figure and streaks
    const warp = 0.012 * (fbm(along * 1.6, seed, across * 8, 3) - 0.5) + 0.004 * Math.sin(along * 5 + seed)
    const lines = 0.5 + 0.5 * Math.sin((across + up * 0.5 + warp) * Math.PI * 2 * ringFreq)
    const lineStrength = 0.5 + 0.8 * fbm(along * 3, across * 20, seed, 2)
    const late = Math.pow(lines, 6) * lineStrength
    const figure = fbm(along * 2.5, across * 30, up * 30 + seed, 4)
    const streak = fbm(along * 0.9, across * 45, up * 45 + seed, 3)
    const fibre = fbm(along * 40, across * 400, up * 400 + seed, 2)
    const mottle = fbm(along * 6, across * 12, up * 12 + seed * 3, 4)
    shade = 1.0 + 0.12 * (figure - 0.5) - 0.09 * late - 0.22 * Math.max(0, streak - 0.55) - 0.16 * (mottle - 0.5) - 0.05 * fibre
    h = 0.55 - 0.3 * late + 0.15 * fibre
    r = 0.76 + 0.1 * fibre
  }
  // weathering: dirty, greyed blotches and darker, worn arrises
  const weather = fbm(p[0] * 3 + 5, p[1] * 3, p[2] * 3 - 1, 4)
  const grime = fbm(p[0] * 9 - 2, p[1] * 9, p[2] * 9 + 4, 3)
  const arris = 1 - Math.max(Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2]))
  shade *= tone * (1 - 0.3 * Math.max(0, weather - 0.45)) * (1 - 0.22 * Math.max(0, grime - 0.5)) * (1 - 0.6 * arris)
  const grey = 0.45 * Math.max(0, weather - 0.4)
  let rgb = WOOD.map((c, i) => {
    const v = c * shade * (1 + (i === 0 ? hueShift : i === 2 ? -hueShift : 0))
    return v * (1 - grey) + 120 * shade * grey
  })
  r = Math.min(0.95, r + 0.1 * grey)

  const nail = nailAt(p, n)
  if (nail > 0) {
    rgb = rgb.map((v, i) => v * (1 - nail) + NAIL[i] * nail)
    h = h * (1 - nail) + 0.9 * nail
    r = r * (1 - nail) + 0.45 * nail
  }

  const ao = 1 - 0.75 * occlusion(p, n)
  rgb = rgb.map((v) => v * ao)

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
    albedo[k * 3] = WOOD[0]; albedo[k * 3 + 1] = WOOD[1]; albedo[k * 3 + 2] = WOOD[2]
    height[k] = 0.5
    rough[k] = 0.8
  }
}

// ---------------------------------------------------------------- encode

const toByte = (v) => Math.max(0, Math.min(255, Math.round(v)))
const colorPx = Buffer.alloc(N * 3)
const normalPx = Buffer.alloc(N * 3)
const roughPx = Buffer.alloc(N * 3)
const STRENGTH = 2.4 // height units per texel -> slope
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
    const rv = toByte(rough[k] * 255)
    roughPx[k * 3] = rv
    roughPx[k * 3 + 1] = rv
    roughPx[k * 3 + 2] = rv
  }
}

// Lossless, like every source texture in public/: the production build re-encodes them (optimize-assets.mjs).
const raw = (px) => sharp(px, { raw: { width: SIZE, height: SIZE, channels: 3 } })
const outputs = [
  ['PalletWood.webp', raw(colorPx)],
  ['PalletWoodNormal.webp', raw(normalPx).resize(DETAIL_SIZE, DETAIL_SIZE)],
  ['PalletWoodRoughness.webp', raw(roughPx).resize(DETAIL_SIZE, DETAIL_SIZE)],
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
