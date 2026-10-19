// Post-build asset compressor: shrinks the model payload that ships to the CDN.
//
// Why this exists: dist/models is ~80 MB of mostly-uncompressed GLB geometry and
// lossless PNG textures. Localhost serves it instantly; a real network does not.
// This pass runs after `vite build` and rewrites dist in place — source assets in
// public/ stay pristine (lossless originals), and dist is regenerated each build,
// so the pass is effectively idempotent.
//
// Three classes of asset, three strategies:
//   1. Static GLBs (cloned whole-group at runtime)  -> full optimize: meshopt
//      geometry compression (+ quantization) + embedded textures -> WebP, resized.
//   2. Node-driven GLBs (robot/gantry/AGV + blade stop/chain transfer) -> textures
//      + DRACO. Their runtime code indexes meshes by node NAME and reshapes them via
//      authored LOCAL node transforms (rigged models place `rawGeometry` by authored
//      matrices — manipulatorModel.ts + sixAxisRobot.ts; blade stop/chain transfer
//      overwrite obj.scale.x/.z per frame — bladeStop.ts + chainTransfer.ts). meshopt
//      quantization bakes a compensating scale+translation onto every node, which
//      those overwrites then destroy → distorted models (in prod only). join/flatten
//      (rename or merge meshes) breaks the name lookup. Draco is the exception that
//      makes this class compressible: it quantizes inside its OWN bitstream and
//      dequantizes back into the authored coordinate space, so node transforms come out
//      byte-identical and mesh names are untouched (measured 2026-07-26: AGV 3.16 ->
//      1.04 MB, SixAxisRobot 1.98 -> 0.20, Gantry 0.50 -> 0.06, Diverter 0.35 -> 0.18).
//      The verify below enforces the actual invariant — every named node's TRS unchanged
//      — rather than trusting the flag set. DEAD_ATTRS additionally drops attributes no
//      shader samples, which shrinks what Draco has to encode.
//      (For the record, the tempting "keep positions float" meshopt route is NOT safe:
//      gltfpack -vpf -vtf -kn -km -ke -kv -cc still emits KHR_mesh_quantization and still
//      moved exactly the driven nodes — SixAxis Base/Linkage_05/Hydraulic_02, all four AGV
//      wheels, every Gantry beam, the Diverter arms — and dropped every mesh name.)
//   3. Loose .png/.jpg/.webp referenced by hardcoded URLs (building/, sixaxis/, eoat/,
//      gantry/, textures/) -> resized + re-encoded in place via sharp, keeping the
//      extension so the URLs stay valid.
//
// Cutting ACROSS all three GLB classes: DEAD_ATTRS drops vertex attributes no material on that model
// ever samples. Deleting an attribute renames nothing and moves no node transform, so it is safe
// where each class's own compression rule isn't — and it is the only lever that reaches the tangents
// the two texture-reapplying classes' blunt keep-everything guards (`--prune-attributes false`, `-kv`)
// are forced to preserve. See the table above DEAD_ATTRS for what that is worth per model.
//
// Every GLB is verified before replacing the original: node/mesh names must be preserved (catches
// accidental join/flatten), node-driven models must come out with every named node's TRS unchanged
// and must not gain a meshopt/quantization extension. A failed verify keeps the uncompressed
// original rather than shipping a broken model.
//
// The rendered result of the node-driven class is guarded end-to-end by
// `node e2e/verify-prod-draco-rigs.mjs` (after a build): it diffs dist (Draco) mesh-by-mesh and
// rig-link-by-rig-link against a recorded baseline of what the raw GLBs render, since dev never
// loads a compressed model. THAT BASELINE IS FINGERPRINTED BY THE SOURCE GLB SHAS — re-export a
// model in this class and the gate stops until you `npm run regen-rig-baseline` and commit it.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, statSync, readdirSync, rmSync, renameSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, extname, basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
// the eager-JS half of the budget block below lives in its own module: the census that says what
// is IN that graph reads the same list and the same ceilings (scripts/eager-census.mjs)
import { eagerJsChunks, EAGER_JS_BUDGET_BR_MB, EAGER_JS_BUDGET_RAW_MB } from './lib/eager-js.mjs'

const require = createRequire(import.meta.url)
const sharp = require('sharp')
// gltf-transform's document API, for the one edit its CLI can't express (DEAD_ATTRS below).
const { NodeIO } = await import('@gltf-transform/core')
const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js')
const GLTFPACK = join(ROOT, 'node_modules', 'gltfpack', 'cli.js')
const DIST = process.argv[2] ? join(ROOT, process.argv[2]) : join(ROOT, 'dist')
const MODELS_DIR = join(DIST, 'models')
const TEXTURES_DIR = join(DIST, 'textures')

// Name-indexed + reshaped via authored local node transforms, so geometry must never be quantized
// INTO THE SCENE GRAPH (see header note 2): meshopt bakes a compensating scale/translation onto each
// node, and these runtimes overwrite obj.scale/.position by name and corrupt it. Draco keeps its
// quantization inside the bitstream, so this class takes Draco instead of meshopt.
//   AGV/Gantry/SixAxisRobot — rigged: rawGeometry placed by authored local matrices.
//   EOATSuction — rig mesh-node refs: sdkPart RESETS each node transform (the link owns placement), so a
//   baked compensating quantization scale would be dropped; UVs must also survive (textures reapplied at
//   runtime from the package materials).
//   Diverter — the SAME sdkPart node-ref rig (Pusher housing + 3 telescoping arms on prismatic joints).
//   prepareMeshInstance resets each `node:` link to identity so the rig owns placement, which drops the
//   meshopt-baked per-node translation → the arms render mis-placed (the pusher looks stuck EXTENDED) in prod
//   only, dev serves public/ raw. Its GLB keeps its own materials, so textures-only is the safe pass here too.
const TEXTURE_ONLY = new Set(['AGV', 'Gantry', 'SixAxisRobot', 'EOATSuction', 'Diverter'])
// Static GLBs that ship placeholder solid-color materials and REAPPLY BaseColor maps
// at runtime — by glTF material name, or a loose webp keyed on it — onto the authored
// UVs (exactly like the building modules, but via the static meshopt path instead of
// gltfpack). The static optimize's prune step treats those UVs as "unused" (no
// baseColorTexture references them) and strips TEXCOORD_0 from every primitive, so the
// runtime texture then samples a single texel → dark dock-door wall + untextured auto
// leveler in prod ONLY (dev serves public/ raw, UVs intact). `--prune-attributes false`
// keeps the UVs; the verify below guards them. See dockDoor.ts applyDockMaterial +
// buildLeveler.
const REAPPLY_TEXTURES = new Set(['DockDoor', 'AutoLeveler', 'ContainerTrailer'])
// Vertex attributes NO shader ever samples, per model. Applies to ALL THREE classes: deleting an
// attribute touches no node transform and renames nothing, so it is safe even where the class's own
// rule (no geometry compression / no prune) isn't. It is also the ONLY way to get these attributes
// off the two texture-reapplying classes, whose runtimes force the blunt guards that keep them:
// `--prune-attributes false` on the static path and `-kv` on the building path both exist to save
// TEXCOORD_0 from a prune that can't see the runtime, and both are all-or-nothing.
//
// What an attribute costs is decided by the material that ends up on it, which for most of these is
// NOT the material in the GLB:
//   TANGENT     — read only for normal mapping. Neither `sixaxis` nor the gantry's std/trim/tool
//                 declares a normal map (buildMaterial, render/parts/sdk/materials.ts, sets map +
//                 roughnessMap/metalnessMap and nothing else), and neither building.ts's
//                 applyDesktopMaterial nor dockDoor.ts's applyDockMaterial/buildLeveler assigns
//                 `normalMap` at all — see editor/deadAttrs.test.ts, which pins that.
//                 (EOATSuction's eoatBaked/eoatTrim DO declare one — it stays off this list.)
//   COLOR_0/1   — three applies vertex colours only under material.vertexColors, never set.
//   TEXCOORD_1  — a second UV set is read only by aoMap/lightMap, never assigned. Every texture
//                 reference in these GLBs is texCoord 0.
// TEXCOORD_0 must SURVIVE: the package/building/dock textures are reapplied onto exactly those UVs,
// so dropping it is the same de-texturing trap REAPPLY_TEXTURES guards. The verify below enforces
// both halves — the dead attributes gone, the kept ones intact.
//
// Measured 2026-08-21, each by re-running that model's OWN branch with the strip in front. The rigs
// came first because their GLBs embed no images at all, so the texture pass found nothing to do and
// they shipped byte-for-byte identical to source. The rest were found by auditing every shipped GLB's
// attribute set against what its material actually samples — DockDoor is the one that matters, since
// it is 73,127 vertices of unused tangent on the largest single file GATING THE LOADING COVER:
//   DockDoor        483.4 -> 243.8 KB (-50%)      Roof_A     239.3 -> 196.9 KB (-18%)
//   AutoLeveler      49.1 ->  34.9 KB (-29%)      Roof_B     199.1 -> 163.0 KB (-18%)
//   ContainerTrailer 168.2 -> 123.9 KB (-26%)     Wall_C      57.0 ->  48.9 KB (-14%)
//   AGV            1056.6 -> 1022.9 KB (-3%)      Wall_A/B   ~109  -> ~ 96   KB (-11%)
const DEAD_ATTRS = new Map([
  ['SixAxisRobot', ['TANGENT', 'COLOR_0', 'COLOR_1', 'TEXCOORD_1']],
  ['Gantry', ['TANGENT', 'COLOR_0', 'COLOR_1', 'TEXCOORD_1']],
  ['AGV', ['TEXCOORD_1']], // its normalTexture is real, so TANGENT stays
  ['DockDoor', ['TANGENT']],
  ['AutoLeveler', ['TANGENT']],
  ['ContainerTrailer', ['TANGENT', 'COLOR_0', 'COLOR_1']],
  ['Roof_A', ['TANGENT', 'TEXCOORD_1']],
  ['Roof_B', ['TANGENT', 'TEXCOORD_1']],
  ['Wall_A', ['TANGENT']],
  ['Wall_B', ['TANGENT']],
  ['Wall_C', ['TANGENT']],
  ['Wall_D', ['TANGENT']],
])
const KEEP_ATTRS = ['POSITION', 'NORMAL', 'TEXCOORD_0']
const TEX_CAP = 2048 // max texture dimension (px) for both embedded and loose textures
// Per-directory override of TEX_CAP, for the LOOSE package textures (the embedded-GLB passes above
// use the flat cap). The dock-door bay is the BUILDING's own scenery — building.ts loads it at
// module scope and its textures are gated behind the loading cover (dockDoor.ts), so their bytes
// sit squarely on first paint: 1.6 MB across five 2048² BaseColor maps, on a warehouse wall, a
// leveler and a parked trailer that are background at every camera the editor opens with. At 1024
// that is ~0.45 MB. Raise a specific entry back if a prop ever becomes a close-up subject.
//
// The building shell, the gantry package and the robot's packed ORM map are here for a SECOND
// reason: VRAM, not bytes. A webp decodes to RGBA8 + mips on the GPU, so size on the wire says
// nothing about size in memory — a 2048² map is 21.3 MB resident no matter that it compressed to
// 40 KB. Measured on the demo scene before this list grew: 44 textures, 399 MB resident, thirteen
// 2048² maps accounting for 277 MB of it. The mobile tier (render/quality.ts) only touches pixel
// ratio, MSAA and shadows, so a phone paid all of it. Halving a map quarters its residency.
//
// The entries below are the ones that measurably carry no 2048-level detail: resampled to 1024 and
// back, every building and gantry map lands at 39.9-48.0 dB PSNR (mean abs error < 1.2/255), i.e.
// visually identical. Packed ORM maps score LOWER on that test (31-33 dB) but still belong, because
// what they lose is roughness/AO micro-noise — nothing in those channels carries an edge the eye
// tracks — which is why sixaxis/ORM has shipped at 1024 since 2026-07-26.
//
// sixaxis/BaseColor is the deliberate exception: 38.9 dB says it would survive too, but the robot is
// the one close-up subject in the default demo scene and its albedo is what you actually look at.
// Albedo on a part the camera gets close to does NOT belong on this list.
const TEX_CAP_BY_DIR = [
  [/[\\/]dockDoor[\\/]textures[\\/]/, 1024],
  [/[\\/]building[\\/]textures[\\/]/, 1024],
  [/[\\/]gantry[\\/]/, 1024],
  [/[\\/]sixaxis[\\/]ORM\.webp$/, 1024],
]
const texCapFor = (file) => TEX_CAP_BY_DIR.find(([re]) => re.test(file))?.[1] ?? TEX_CAP
// The same cap for textures EMBEDDED in a GLB, which TEX_CAP_BY_DIR never reached: the GLB passes
// below used the flat TEX_CAP, so the models carrying their own maps shipped them at authored size —
// AGV 3 x 2048² (64 MB resident), Box and Pallet 3 x 1024² (16 MB each), for a vehicle and two pieces
// of cargo. Keyed by GLB basename; each rule is [texture-name glob, cap], applied in order, and a
// resize never enlarges, so a specific rule ahead of a broader one wins.
//
// ALBEDO IS NOT CAPPED on any of them, and that was measured, not assumed: capping every map was
// tried first, and in shot-part --focus close-ups (prod assets, side by side) the AGV's hazard decal
// greyed out and its CAUTION text blurred at 1024, the Box's label print and corrugation smeared at
// 512, and the Pallet lost its nail heads. Walk mode gets that close. The normal and ORM maps showed
// no difference in the same shots — same reasoning as the packed ORM entries above.
// PSNR of what IS capped, resampled to the cap and back:
//   AGV     Normal 58.3 dB @512 (effectively flat) · ORM 29.8 dB @1024
//   Pallet  Normal 32.4 / ORM 28.3 dB @512
//   Box     Normal 32.6 / Roughness 35.5 dB @512 (generated: scripts/build-box-textures.mjs)
// Residency: AGV 64 -> 28 MB, Box and Pallet 16 -> 8 MB each.
const GLB_TEX_CAPS = new Map([
  ['AGV', [['Normal', 512], ['ORM', 1024]]],
  ['Box', [['Normal', 512], ['Roughness', 512]]],
  ['Pallet', [['Normal', 512], ['ORM', 512]]],
])
/** Resize `input`'s embedded textures to its GLB_TEX_CAPS rules into `output`; false = no rules. */
function capEmbeddedTextures(name, input, output) {
  const rules = GLB_TEX_CAPS.get(name)
  if (!rules) return false
  let from = input
  for (const [pattern, cap] of rules) {
    runCli(['resize', from, output, '--pattern', pattern, '--width', String(cap), '--height', String(cap)])
    from = output
  }
  return true
}
const GEOM_EXTS = ['EXT_meshopt_compression', 'KHR_mesh_quantization']
// Draco settings for the node-driven class. Quantization is per-mesh-bounds (the CLI default
// `--quantization-volume mesh`), so a part-sized mesh gets sub-0.1 mm positions at the default
// 14 bits. Two defaults are raised: NORMAL 10 -> 12 for the same reason the building pass uses
// gltfpack -vn 12 (10-bit normals band on these large flat metal panels), and TEXCOORD 12 -> 14
// for headroom, because several of these rigs have their package textures reapplied onto the
// GLB's authored UVs at runtime (materials.ts buildMaterial) rather than sampling in [0,1].
const DRACO_ARGS = ['--quantize-normal', '12', '--quantize-texcoord', '14']
// Static GLBs whose SOURCE is at or above this take Draco instead of meshopt (static branch below).
// In practice that is everything but the tiny, hottest units — the roller-conveyor roller (13 KB,
// instanced thousands of times) and the push button — which keep meshopt's much faster decode.
const DRACO_MIN_BYTES = 200_000

const fmt = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`
const sizeOf = (f) => statSync(f).size

/** Recursively collect files under `dir` matching `test(name)`. */
function walk(dir, test, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, test, out)
    else if (test(e.name)) out.push(p)
  }
  return out
}

/** Parse a .glb's JSON chunk without decoding geometry. */
function glbMeta(file) {
  const buf = readFileSync(file)
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`not a GLB: ${file}`)
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
  const names = [
    ...(json.nodes ?? []).map((n) => n.name),
    ...(json.meshes ?? []).map((m) => m.name),
  ].filter(Boolean).sort()
  const attrs = new Set()
  const uvTypes = new Set()
  for (const m of json.meshes ?? [])
    for (const p of m.primitives ?? []) {
      for (const a of Object.keys(p.attributes ?? {})) attrs.add(a)
      const uv = p.attributes?.TEXCOORD_0
      if (uv !== undefined) uvTypes.add(json.accessors?.[uv]?.componentType)
    }
  const mats = new Set((json.materials ?? []).map((m) => m.name).filter(Boolean))
  // Authored local transform per NAMED node — the invariant the node-driven class actually needs
  // (see header note 2). Serialized so a plain string compare catches any component moving, and
  // keyed by name because that is how the runtime finds these nodes.
  const nodeTrs = new Map()
  for (const n of json.nodes ?? [])
    if (n.name) nodeTrs.set(n.name, JSON.stringify([n.translation ?? null, n.rotation ?? null, n.scale ?? null, n.matrix ?? null]))
  return { names, ext: new Set(json.extensionsUsed ?? []), attrs, mats, uvTypes, nodeTrs }
}

function runCli(args) {
  execFileSync(process.execPath, [CLI, ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
}

function runGltfpack(args) {
  try {
    execFileSync(process.execPath, [GLTFPACK, ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (err) {
    // gltfpack's CLI writes its log to stdout and calls process.exit() at once. On Windows, Node can then abort in
    // libuv while that write is still closing ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", exit 127),
    // AFTER the output file is complete - every time for some inputs (Wall_C, 2026-10-09). That one abort, with the
    // output written, is a finished pack; the verify step after this checks the file like any other.
    const out = args[args.indexOf('-o') + 1]
    if (/UV_HANDLE_CLOSING/.test(err.stderr?.toString() ?? '') && out && existsSync(out)) return
    throw err
  }
}

const glbIO = new NodeIO().registerExtensions(ALL_EXTENSIONS)

/**
 * Delete `attrs` from every primitive of `file`, in place. Done through the document API rather
 * than the CLI because `prune --keep-attributes false` is the wrong tool here: it drops whatever
 * the GLB's OWN materials don't reference, and these models carry no textures of their own, so it
 * would take TEXCOORD_0 — the UVs the runtime reapplies the package textures onto — with it.
 */
async function stripAttributes(file, attrs) {
  const doc = await glbIO.read(file)
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives())
      for (const a of attrs) if (prim.getAttribute(a)) prim.setAttribute(a, null)
  // drop the accessors those attributes were the only user of (Root still holds one ref)
  for (const acc of doc.getRoot().listAccessors()) if (acc.listParents().length <= 1) acc.dispose()
  await glbIO.write(file, doc)
}

const failures = []

/** Transform one GLB to a temp file, verify it, then replace the original. */
async function processGlb(file) {
  const name = basename(file, '.glb')
  const texOnly = TEXTURE_ONLY.has(name)
  const dead = DEAD_ATTRS.get(name) ?? []
  const building = /[\\/]building[\\/]/.test(file)
  const keepUVs = REAPPLY_TEXTURES.has(name) // reapplies textures at runtime → UVs must survive prune
  const before = glbMeta(file)
  const beforeSize = sizeOf(file)
  const tmp = file.replace(/\.glb$/, '.opt.glb')

  // The input the static/building branches read from: `file` itself, or a stripped copy at `tmp`
  // when this model has dead attributes. Stripping FIRST means gltfpack/optimize simplify and encode
  // only the attributes something samples, rather than spending bits on a tangent nothing reads.
  // (The texOnly branch strips mid-chain instead — see below — so its verified order is untouched.)
  const strippedInput = async () => {
    if (!dead.length) return file
    copyFileSync(file, tmp)
    await stripAttributes(tmp, dead)
    return tmp
  }

  try {
    if (texOnly) {
      // textures, then the attributes nothing samples, then Draco — none of the three
      // renames a node/mesh or rewrites a node transform (header note 2; verified below)
      runCli(['resize', file, tmp, '--width', String(TEX_CAP), '--height', String(TEX_CAP)])
      capEmbeddedTextures(name, tmp, tmp)
      runCli(['webp', tmp, tmp, '--quality', '90'])
      if (dead.length) await stripAttributes(tmp, dead)
      // last, so it encodes the already-trimmed attribute set
      runCli(['draco', tmp, tmp, ...DRACO_ARGS])
    } else if (building) {
      // The building modules are uncompressed float geometry (~9 MB total) and
      // dominate first-load, so meshopt-compress them (the loader sets
      // MeshoptDecoder). gltfpack -vn 12 keeps normals at 12 bits (4096 levels,
      // smooth) — the 8-bit normal banding from gltf-transform's meshopt is why
      // this used to ship raw; gltfpack's tunable precision removes that objection.
      //
      // -kv keeps the (texture-less) UVs and -km the material names. building.ts
      // ships placeholder solid colors and reapplies BaseColor maps by glTF
      // material name onto these UVs at runtime, so both must survive or the
      // building renders flat/untextured — the verify below enforces both.
      //
      // -vtf (float texcoords) is REQUIRED: gltfpack otherwise quantizes UVs into
      // a tiny [0,~0.06] range and stores the compensating ~16x scale as a texture
      // transform on the GLB's own material. building.ts swaps in its own BaseColor
      // map (no transform), so the quantized UVs would sample a dark texture corner
      // → dark walls. Float UVs stay in the authored [0,1] range, no transform.
      //
      // -si SIMPLIFY: the modules are tiled across many cells (a 5×4 warehouse instances
      // Roof_A ~10× + Roof_B ~10× + the wall ring), so their per-module triangles multiply
      // into the scene's dominant geometry cost — the un-decimated shell was ~1.9 M tris
      // (83% of the demo), re-rasterized every frame in the main pass AND the key light's
      // shadow map. -slb LOCKS BORDERS so a decimated module keeps its outer edge verts and
      // abutting tiles don't crack open at the seams; only interior detail (panel corrugation,
      // framing) collapses. The roof is overhead background (auto-hides in top-down views) so
      // it takes an aggressive ratio; the walls are seen up close in walkthrough, so gentler.
      // Simplify preserves node/material names, UV channels + their float type, and every
      // vertex attribute, so the verify below (names/mats/attrs/float-UV) still passes.
      //
      // -kv keeps EVERY vertex attribute, including the tangents nothing samples, which is why the
      // dead-attribute strip (DEAD_ATTRS) runs in front of gltfpack rather than relying on a flag.
      const roof = /Roof_/.test(basename(file))
      runGltfpack(['-i', await strippedInput(), '-o', tmp, '-kv', '-km', '-vn', '12', '-vtf', '-cc', '-si', roof ? '0.3' : '0.5', '-slb'])
    } else {
      // Draco for the big static models, meshopt for the tiny hot ones. Draco is roughly 2-3x better
      // per byte but decodes slower, so the split is by size: where bytes dominate the wait, take
      // Draco; where decode latency on a thousand instances matters more than a few KB, keep meshopt.
      // The dock-door bay is why this pays — it is BUILDING scenery sitting in front of the loading
      // cover, and it was 1.2 MB of it: DockDoor 0.86 -> 0.49 MB, ContainerTrailer 0.27 -> 0.17,
      // AutoLeveler 0.09 -> 0.05, and the sensors ~-40% each.
      // Draco goes on as a SECOND step (below), not via `--compress draco`: the optimize command
      // exposes no per-attribute quantization flags, and its default 12-bit texcoords are too
      // coarse for the REAPPLY_TEXTURES models — whose runtime-reapplied maps land on exactly
      // these UVs — which is precisely the set that trips this threshold.
      const bigStatic = beforeSize >= DRACO_MIN_BYTES
      const input = await strippedInput()
      runCli([
        'optimize', capEmbeddedTextures(name, input, tmp) ? tmp : input, tmp,
        '--compress', bigStatic ? 'false' : 'meshopt',
        '--texture-compress', 'webp',
        '--texture-size', String(TEX_CAP),
        // REAPPLY_TEXTURES models reapply BaseColor maps at runtime onto authored UVs;
        // those UVs look unused here (placeholder materials carry no texture), so the
        // default prune would strip them → de-textured in prod. Keep them — but note the
        // flag is ALL-OR-NOTHING, so it also keeps the tangents the same placeholder
        // materials make look used; DEAD_ATTRS strips those explicitly, in front of this
        // call (that is what halves DockDoor). meshopt still
        // quantizes the in-[0,1] UVs to normalized shorts (three.js dequantizes natively)
        // and leaves tiling UVs float; geometry compression is unaffected.
        ...(keepUVs ? ['--prune-attributes', 'false'] : []),
        // keep the scene graph intact: these are what rename/merge/distort meshes
        '--flatten', 'false',
        '--join', 'false',
        '--instance', 'false',
        '--palette', 'false',
        // NOT simplified: the dock-door family (DockDoor/ContainerTrailer/AutoLeveler) was
        // tried (ratio 0.5, lock-border, 1% error) but the ContainerTrailer's flat door panels
        // distort visibly on BOTH backends — flat/planar prop geometry decimates far worse than
        // the building's detailed modules, and the verify (names/UVs/mats) doesn't catch shape
        // warp. Left off unless a per-part, visually-verified ratio is dialed in later.
        '--simplify', 'false',
      ])
      if (bigStatic) runCli(['draco', tmp, tmp, ...DRACO_ARGS])
    }
  } catch (err) {
    failures.push(`${name}: gltf-transform failed — ${err.stderr?.toString().trim() || err.message}`)
    try { rmSync(tmp) } catch { /* nothing to clean */ }
    return { name, beforeSize, afterSize: beforeSize, skipped: true }
  }

  // verify before committing the replacement
  const after = glbMeta(tmp)
  const sameNames = texOnly
    ? after.names.length === before.names.length && after.names.every((n, i) => n === before.names[i])
    : after.names.every((n) => before.names.includes(n)) // static: prune may drop unused; no NEW names
  // Still banned for the node-driven class: meshopt/quantization is what bakes compensating
  // node transforms. Draco (KHR_draco_mesh_compression) is deliberately NOT in this set — it is
  // the compression this class takes, and `movedNodes` below is what actually polices the result.
  const gainedGeomExt = GEOM_EXTS.some((x) => after.ext.has(x) && !before.ext.has(x))
  // THE invariant for the node-driven class: every named node's authored local transform must be
  // untouched. The runtime overwrites obj.scale/.position (bladeStop/chainTransfer) or resets each
  // rig link to identity (sdkPart node refs), so any baked-in compensation is destroyed at runtime
  // and the model renders distorted or mis-placed — in prod only. Cheap, direct, and it does not
  // care WHICH tool moved the node, so it also guards future flag changes.
  const movedNodes = texOnly ? [...before.nodeTrs].filter(([n, trs]) => after.nodeTrs.get(n) !== trs).map(([n]) => n) : []
  // building + REAPPLY_TEXTURES runtimes reapply textures by material NAME onto the UVs,
  // so dropping either silently de-textures them (see the building branch + REAPPLY_TEXTURES
  // above) — never ship that. The prune-attributes guard makes this a regression backstop.
  // texOnly is held to the same rule: Draco must round-trip every attribute it did not
  // deliberately drop (`dead`), since the package materials decide what gets sampled.
  const reapplyTex = building || keepUVs
  const lostAttrs = reapplyTex || texOnly ? [...before.attrs].filter((a) => !after.attrs.has(a) && !dead.includes(a)) : []
  const lostMats = reapplyTex ? [...before.mats].filter((m) => !after.mats.has(m)) : []
  // building reapplies its own BaseColor map onto these UVs, so quantized UVs
  // (gltfpack without -vtf: normalized shorts + a texture transform the runtime
  // swap drops) sample a dark texture corner → dark walls. UVs must stay FLOAT.
  const FLOAT = 5126
  const quantUV = building ? [...after.uvTypes].some((t) => t !== FLOAT) : false
  // DEAD_ATTRS models: both halves of the strip must hold — the dead attributes actually gone,
  // and the ones the package materials sample (above all TEXCOORD_0) still there.
  const keptDead = dead.filter((a) => after.attrs.has(a))
  const lostKeep = dead.length ? KEEP_ATTRS.filter((a) => before.attrs.has(a) && !after.attrs.has(a)) : []

  if (!sameNames || (texOnly && gainedGeomExt) || movedNodes.length || lostAttrs.length || lostMats.length || quantUV || keptDead.length || lostKeep.length) {
    const why = !sameNames
      ? 'mesh names changed'
      : movedNodes.length
        ? `node transforms rewritten [${movedNodes.slice(0, 6).join(', ')}] — a node-driven rig would render distorted`
        : lostAttrs.length
          ? `dropped vertex attributes [${lostAttrs.join(', ')}]`
          : lostMats.length
            ? `dropped materials [${lostMats.join(', ')}]`
            : quantUV
              ? 'quantized UVs (building needs gltfpack -vtf — would de-texture walls)'
              : lostKeep.length
                ? `attribute strip took SAMPLED attributes [${lostKeep.join(', ')}]`
                : keptDead.length
                  ? `attribute strip missed [${keptDead.join(', ')}]`
                  : 'geometry was recompressed'
    failures.push(`${name}: verification failed (${why}) — kept original`)
    rmSync(tmp)
    return { name, beforeSize, afterSize: beforeSize, skipped: true }
  }

  const afterSize = sizeOf(tmp)
  if (afterSize >= beforeSize) {
    rmSync(tmp) // no win (e.g. already optimized) — keep original
    return { name, beforeSize, afterSize: beforeSize, skipped: true }
  }
  renameSync(tmp, file)
  return { name, beforeSize, afterSize, texOnly, dead: dead.length > 0 }
}

/** Resize + re-encode a loose texture in place, keeping its extension. */
async function processImage(file) {
  const ext = extname(file).toLowerCase()
  const input = readFileSync(file)
  let pipe = sharp(input, { failOn: 'none' })
  const meta = await pipe.metadata()
  const cap = texCapFor(file)
  if ((meta.width ?? 0) > cap || (meta.height ?? 0) > cap) {
    pipe = pipe.resize({ width: cap, height: cap, fit: 'inside', withoutEnlargement: true })
  }
  let out
  if (ext === '.png') {
    // lossless re-encode (resize is the real win) — palette quantization banded
    // the flat wall/floor albedo, so albedo maps stay full-colour
    out = await pipe.png({ compressionLevel: 9, effort: 10 }).toBuffer()
  } else if (ext === '.webp') {
    // Loose .webp used to be skipped by this pass entirely (the walk below matched only
    // png/jpg), so the rig packages' hand-exported LOSSLESS webps shipped raw — 2.2 MB for one
    // 2048² ORM map on the robot, 3.3 MB across the gantry's two. Quality 90 is the SAME lossy
    // encode the embedded-texture pass has always applied (`webp --quality 90` above): ~-85% on
    // these, mean per-channel error ~2/255, which packed ORM (AO/rough/metal) absorbs fine.
    // Already-lossy sources re-encode LARGER; the size guard below keeps those originals.
    out = await pipe.webp({ quality: 90 }).toBuffer()
  } else {
    out = await pipe.jpeg({ quality: 85, mozjpeg: true }).toBuffer()
  }
  const beforeSize = input.length
  if (out.length < beforeSize) {
    writeFileSync(file, out)
    return { name: relative(DIST, file), beforeSize, afterSize: out.length }
  }
  return { name: relative(DIST, file), beforeSize, afterSize: beforeSize, skipped: true }
}

function report(title, rows) {
  const before = rows.reduce((s, r) => s + r.beforeSize, 0)
  const after = rows.reduce((s, r) => s + r.afterSize, 0)
  console.log(`\n${title}`)
  for (const r of rows.sort((a, b) => b.beforeSize - a.beforeSize)) {
    const pct = r.beforeSize ? Math.round((1 - r.afterSize / r.beforeSize) * 100) : 0
    const tag = r.skipped ? '  (kept)' : `  -${pct}%${r.texOnly ? (r.dead ? '  [textures + dead attrs + draco]' : '  [textures + draco]') : ''}`
    console.log(`  ${r.name.padEnd(34)} ${fmt(r.beforeSize).padStart(9)} -> ${fmt(r.afterSize).padStart(9)}${tag}`)
  }
  console.log(`  ${'TOTAL'.padEnd(34)} ${fmt(before).padStart(9)} -> ${fmt(after).padStart(9)}`)
  return { before, after }
}

// ---- asset budgets -------------------------------------------------------------------------
// A ratchet, not a suggestion: `npm run build` FAILS when the shipped asset payload grows past
// these. First-load performance is bandwidth-bound for anyone not near a warm edge cache, so a
// megabyte is real seconds on a slow link — and
// a new prop with three 2048² maps costs that with no test noticing. Ordering fixes (guarded by
// e2e/verify-first-load.mjs) are all spent; from here only bytes move the number.
//
// COVER budget = the set that gates the loading cover: the building shell and its dock-door bay
// scenery (dockDoor.ts registers those textures with the cover gate). Nothing in it is optional —
// the user stares at a logo until it lands.
// TOTAL budget = every shipped model + texture, i.e. what a fully-explored session downloads.
//
// Raising one is a legitimate decision, not a defeat — but do it deliberately: bump the number in
// the same commit as the asset, and say in the message what the user gets for the extra seconds.
// A ratchet cuts BOTH ways: these came down 3.2 -> 2.8 and 8.0 -> 7.5 when the dead-attribute strip
// widened to the building + dock bay (2026-08-21), keeping the same headroom over the new measurement
// as before. Recovered bytes that stay inside an unchanged budget are just quietly re-spent by the
// next asset, which is the same silence the budget exists to break.
const BUDGET_COVER_MB = 2.8 // measured 1.90 MB after the dead-attr strip (2.32 before it, 2.67 before the texture caps)
const BUDGET_TOTAL_MB = 7.5 // measured 5.50 MB (5.95 before the strip, 6.27 before the metal textures went webp)
// The EAGER JS budget is the third one, and it lives in scripts/lib/eager-js.mjs — it is measured
// two ways (raw for the parse/compile cost, brotli for the wire) and the census that says what is
// IN that graph reads the same module. Lazy chunks are deliberately NOT counted either way, since
// deferring work is the intended way to stay under it.
const isCoverAsset = (f) => {
  const rel = relative(DIST, f).replace(/\\/g, '/')
  return rel.startsWith('models/building/') || rel.startsWith('models/dockDoor/')
}

/** Fail the build when the shipped payload exceeds its budget, naming the biggest contributors. */
function checkBudgets() {
  const files = [
    ...walk(MODELS_DIR, () => true),
    ...walk(TEXTURES_DIR, () => true),
  ]
  const bytes = (f) => files.filter(f).reduce((s, x) => s + sizeOf(x), 0)
  const sets = [
    { label: 'cover-gating (building + dock bay)', got: bytes(isCoverAsset), budget: BUDGET_COVER_MB, pick: isCoverAsset },
    { label: 'all models + textures', got: bytes(() => true), budget: BUDGET_TOTAL_MB, pick: () => true },
  ]
  console.log('\nAsset budgets:')
  let over = false
  for (const s of sets) {
    const mb = s.got / 1e6
    const ok = mb <= s.budget
    console.log(`  ${s.label.padEnd(36)} ${mb.toFixed(2)} MB / ${s.budget.toFixed(2)} MB  ${ok ? 'ok' : 'OVER BUDGET'}`)
    if (ok) continue
    over = true
    console.log('    biggest contributors:')
    for (const f of files.filter(s.pick).sort((a, b) => sizeOf(b) - sizeOf(a)).slice(0, 10)) {
      console.log(`      ${(sizeOf(f) / 1024).toFixed(0).padStart(6)} KB  ${relative(DIST, f).replace(/\\/g, '/')}`)
    }
  }
  // the eager JS is measured differently (from the shell's own preload list, and on two axes), so
  // it gets its own lines rather than being folded into the byte sets above
  const eager = eagerJsChunks(DIST)
  if (eager.length) {
    const axes = [
      { label: 'eager JS raw (parse cost)', mb: eager.reduce((s, x) => s + x.raw, 0) / 1e6, budget: EAGER_JS_BUDGET_RAW_MB },
      { label: 'eager JS brotli (wire cost)', mb: eager.reduce((s, x) => s + x.br, 0) / 1e6, budget: EAGER_JS_BUDGET_BR_MB },
    ]
    let overJs = false
    for (const a of axes) {
      const ok = a.mb <= a.budget
      if (!ok) overJs = true
      console.log(`  ${a.label.padEnd(36)} ${a.mb.toFixed(2)} MB / ${a.budget.toFixed(2)} MB  ${ok ? 'ok' : 'OVER BUDGET'}`)
    }
    if (overJs) {
      over = true
      console.log('    chunks:')
      for (const x of eager) console.log(`      ${(x.raw / 1024).toFixed(0).padStart(6)} KB raw ${(x.br / 1024).toFixed(0).padStart(6)} KB br  ${x.url}`)
      console.log('    what is IN them: npm run eager-census')
    }
  }

  if (over) {
    failures.push(
      'asset budget exceeded — see the table above (asset budgets live at the top of scripts/optimize-assets.mjs,' +
        ' the eager-JS pair in scripts/lib/eager-js.mjs)',
    )
  }
  return over
}

// MIT/Apache "include the notice in all copies" travels with the source repo, but the
// deployed bundle is its own copy. These live at the repo root (single source of truth);
// vite only copies public/, so copy them into dist/ here so they're reachable at
// /LICENSE and /THIRD_PARTY_NOTICES.md on the live site (the landing footer links them).
function copyLegalNotices() {
  for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const src = join(ROOT, f)
    if (existsSync(src)) copyFileSync(src, join(DIST, f))
    else failures.push(`${f}: not found at repo root — not copied into dist`)
  }
}

async function main() {
  const glbs = walk(MODELS_DIR, (n) => n.toLowerCase().endsWith('.glb'))
  if (glbs.length === 0) {
    console.error(`No GLBs found under ${MODELS_DIR} — did "vite build" run first?`)
    process.exit(1)
  }
  console.log(`Optimizing ${glbs.length} models in ${relative(ROOT, DIST)} …`)

  const glbRows = []
  for (const glb of glbs) glbRows.push(await processGlb(glb))

  const images = [
    ...walk(MODELS_DIR, (n) => /\.(png|jpe?g|webp)$/i.test(n)),
    ...walk(TEXTURES_DIR, (n) => /\.(png|jpe?g|webp)$/i.test(n)),
  ]
  const imgRows = []
  for (const img of images) imgRows.push(await processImage(img))


  copyLegalNotices()

  const g = report('GLB models:', glbRows)
  const t = report('Loose textures:', imgRows)

  const before = g.before + t.before
  const after = g.after + t.after
  console.log(`\n==> model payload: ${fmt(before)} -> ${fmt(after)} (${Math.round((1 - after / before) * 100)}% smaller)`)


  const overBudget = checkBudgets()

  if (failures.length) {
    console.log(`\n⚠ ${failures.length} problem(s):`)
    for (const f of failures) console.log(`  - ${f}`)
  }
  // A failed per-asset verify DEGRADES (ships the uncompressed original, still correct) so it stays
  // a warning. Being over budget is a decision someone has to make, so it fails the build.
  if (overBudget) {
    console.error('\n✖ asset budget exceeded — raise the budget deliberately or shrink the assets.')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('optimize-assets failed:', err)
  process.exit(1)
})
