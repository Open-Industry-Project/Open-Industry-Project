import { Box3, BufferGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry, DoubleSide, EdgesGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Quaternion, RepeatWrapping, SRGBColorSpace, Vector3 } from 'three'
import type { InstancedMesh, Material, Object3D, Texture } from 'three'
import { getPackage } from '../../../core/partRegistry'
import { arrayInstanceDeltas, legFrameDepth, MAX_DISTRIBUTE_INSTANCES, POSE_STRIDE, resolvedBoxSize, resolvedCylinder, resolvedMeshScale, resolvedOffset, rigLinkLocalPoseInto, rigPoseBuffer, rigWorldPosesInto, restQuatOf } from '../../../core/rigPose'
import { reportPartDiagnostic } from '../../../core/partDiagnostics'
import type { SeamContext } from '../../../core/rigPose'
import type { RollerGrid } from '../../../core/rollerGrid'
import type { RigParams, SubPose } from '../../../core/rigPose'
import { evalPartGeometry, geometryAnimates, partDeclaredLamps, partHasGeometry, resolvePartParams } from '../../../core/geometryEval'
import { rigInclineRad } from '../../../core/partGeometry'
import type { GuardOpenings } from '../../../core/guardOpenings'
import { keptSegments, rigFrameSide, rigGuardSide } from '../../../core/guardOpenings'
import type { GuardExtents } from '../../../core/guardExtents'
import { legRestDyAt } from '../../../core/legRests'
import type { LegRestRows } from '../../../core/legRests'
import { guardHolePanelDescription } from '../../../core/guardHoles'
import { extrudeDescription } from '../../../core/geometryShapes'
import { cutAt, mitreAt, railFlangeOffset } from '../../../core/guardExtents'
import type { GuardHoles } from '../../../core/guardHoles'
import { GUARD_HOLE_PANEL, GUARD_HOLE_RADIUS } from '../../../core/types'
import { cutPostDeltas, deckStripRects, isMultiInstance } from '../../../core/structureCuts'
import type { PlatformCut } from '../../../core/structureCuts'
import type { GeometryContext, MeshDescription, MeshPart, ParamValue } from '../../../core/partApi'
import type { MeshUvTile, PartAsset, PartMaterial, PartPackage, RigLegShape, RigLink, RigShape, Vec3Tuple } from '../../../core/partPackage'
import { subPosedLinkNames } from '../../../core/partPackage'
import type { SdkPart } from '../../../core/types'
import { realizeMeshDescription, rewriteMeshDescription } from '../meshDescriptionGeometry'

// A guard's sensor-beam hole panel (core/guardHoles.ts guardHolePanelDescription), one geometry per distinct plate
// shape (sheet height, hole height, thickness), shared by every rig guard in the scene and kept for the session:
// a scene has a handful of hole heights at most, and a geometry a recorded render bundle may still hold must never
// be freed (gpuRetire.ts), so these are not.
const holePanelGeometries = new Map<string, ReturnType<typeof realizeMeshDescription>>()
function guardHolePanelGeometry(y0: number, y1: number, holeY: number, thickness: number): ReturnType<typeof realizeMeshDescription> {
  const key = [y0, y1, holeY, thickness].map((v) => v.toFixed(4)).join('|')
  let g = holePanelGeometries.get(key)
  if (!g) {
    g = realizeMeshDescription(guardHolePanelDescription(y0, y1, holeY, thickness))
    holePanelGeometries.set(key, g)
  }
  return g
}
// A mitred guard end (core/guardExtents.ts GuardMitre) on a box link: the box stops square where the cut is deepest and
// this right-angle wedge carries the band on out to the cut. Unit legs along +x and +z, y centred, so one scale
// (c * thickness, height, thickness) and one of four proper rotations fits any end on either side. Shared scene-wide
// and never freed, like the hole panels.
const unitMitreWedge = realizeMeshDescription(extrudeDescription([[0, 0], [1, 0], [0, 1]], -0.5, 0.5, { axis: 'y' }))
/** which end ('hi': the piece lies at lower x) and which way is outward in link-local z -> the turn that lays the
 *  wedge's legs along "out of the piece" and "outward". All proper rotations: a mirror scale would turn the faces
 *  inside out under DoubleSide lighting (the instanceMirror trap). */
const MITRE_WEDGE_TURN: Record<string, Quaternion> = {
  'hi,out+': new Quaternion(),
  'hi,out-': new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI),
  'lo,out+': new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI),
  'lo,out-': new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI),
}
import { boltMaterial, scrollMaterial, createBeltSurface, createDeckSurface, deckTriplanarMaterial, createInstancePool, createLegSet, disposeLegSet, ensureInstanceCapacity, fillInstances, gapFillMaterial, guardMaterial, legMaterial, legStations, markTickUniformsAdvanced, railMaterial, ROLLER_MODEL_RADIUS, rollerMaterial, rollerSpinTick, shadowMesh, unitBox, writeLegs } from '../common'
import type { InstancePool } from '../common'
import type { LegPool } from '../common'
import type { DeckSurface, WalkFinish } from '../common'
import { BEAM_GREEN, BEAM_RED } from '../sensor'
import type { BeamProbe } from '../sensor'
import { addSensorBeam, removeSensorBeam } from '../../sensorBeamOverlay'
import type { SensorBeam } from '../../sensorBeamOverlay'
import type { Content } from './types'
import { FN_NEUTRAL, descEqual } from './shared'
import { attachMesh, buildMaterial, loadMeshAsset, prepareMeshInstance } from './materials'
import { realizeInstancedTemplate, syncBankEmptyVisibility, writeInstanceMatricesHeld } from '../instancedTemplate'
import { LampBank, lampBankMaterial } from '../lampBank'
import type { LampSlot } from '../lampBank'
import { LinkBank } from '../linkBank'
import type { LinkSlot } from '../linkBank'
import { bumpRepaintEpoch, bumpStructureVersion } from '../structureRev'
import { retireGeometry, retireInstancedMesh, retireInstancedMeshOnly, retireTexture } from '../../gpuRetire'
import { markLazyColliderBVH } from '../../bvh'
import { advanceBankSpins, bankSpinSign, spinUniformOf } from './bankSpin'
import type { BankSpin } from './bankSpin'
import { bumpPoseRev as bumpVisualPoseRev } from '../poseRev'
import { buildRigGizmo, posableJoints } from './rigGizmo'

// ---- rig -----------------------------------------------------------------

const unitCylinder = new CylinderGeometry(1, 1, 1, 16) // axis +Y, scale (r, h, r)
// A large cylinder (a turntable's deck plate and drum, ~1.1 m across) shows every one of 16 facets as a flat
// panel on its rim; 64 reads round at that size. Picked from the authored radius, once, at build (a sizeParams
// radius rescales the same mesh). Shared like unitCylinder, so copies still pool and the draw count is unchanged.
const unitCylinderFine = new CylinderGeometry(1, 1, 1, 64)
const FINE_CYLINDER_RADIUS = 0.2
const cylinderGeoFor = (radius: number): CylinderGeometry => (radius >= FINE_CYLINDER_RADIUS ? unitCylinderFine : unitCylinder)
const unitCone = new ConeGeometry(1, 1, 20) // apex +Y, base −Y, scale (r, h, r) - a downward cue rotates the link
const LAMP_OFF_COLOR = 0x2a2d31 // dark neutral an unlit lamp link shows when its lamp authors no `offColor`
const SQUASH_TAU = 0.05 // time constant (s) of the squash ease - a cup settles ~95% in ~0.15 s

/**
 * Rendered roller radius (m) of a rig's spinning-roller links. The no-slip visual spin rate is
 * speed / radius, so the spin tick must divide by the radius the rollers are drawn at: a 'roller'-finish
 * cylinder draws at its own (param-resolved) radius; a 'roller'-finish mesh keeps the model's native radius.
 */
export function rigRollerSpinRadius(geo: Extract<PartPackage['geometry'], { kind: 'rig' }>, params: RigParams): number {
  for (const l of geo.links) {
    if (l.finish === 'roller' && l.shape.kind === 'cylinder') return resolvedCylinder(l.shape, params).radius
  }
  return ROLLER_MODEL_RADIUS
}

/** the longest edge of a label's canvas, in texels; the short edge follows the plane's aspect */
const LABEL_TEXEL = 512
/** requested anisotropy for a caption; both backends clamp this to the device max, so it needs no capability probe */
const MAX_LABEL_ANISOTROPY = 16

/**
 * The canvas a label link draws into, sized to the plane's aspect. A square canvas on a non-square plane
 * stretches every glyph by the aspect ratio. Sizing the canvas to the plane lets a caption be as wide as the
 * surface it is printed on (a legend band above a pushbutton cap is wide and shallow, like a real engraved plate).
 */
function labelCanvasSize(w: number, h: number): { width: number; height: number } {
  const long = Math.max(w, h)
  const px = (n: number): number => Math.max(16, Math.round((LABEL_TEXEL * n) / long))
  return { width: px(w), height: px(h) }
}

/** the legend plate a caption is printed on: pale engraving stock, with a darker edge so it reads as a plate */
const LABEL_PLATE = '#e9e9e6'
const LABEL_PLATE_EDGE = '#8d8f92'

/**
 * Draw a label shape onto its canvas as an engraved plate: the plate colour edge to edge, with the text on top,
 * rather than bare glyphs on a transparent canvas. Empty text leaves the canvas clear (the link hides).
 * `color` is the ink, a CSS colour string.
 *
 * The plate is what makes the caption render. Bare glyphs on a transparent canvas are invisible under WebGPU,
 * while WebGL draws them. A solid fill on the same canvas shows at once (a red test fill did; black and white
 * text on transparent did not), so WebGPU sampling loses thin, mostly-transparent coverage. Headless runs have no
 * WebGPU adapter and fall back to WebGL, so gates and screenshots don't catch this. A solid plate also survives
 * minification: mip-averaging thin strokes over transparency fades a caption to nothing a couple of metres out,
 * while a plate keeps its contrast and just gets smaller. Verify captions on `msedge --enable-unsafe-webgpu`.
 *
 * The caption is fitted to both axes. It takes 72% of the plate height, then shrinks by measured width if it
 * would overrun the plate. A long caption stays inside a narrow plate, and a short one on a wide plate stays
 * as big as the height allows (a character count would ignore what the glyphs actually measure).
 */
function drawLabelText(ctx: CanvasRenderingContext2D, text: string, color: string): void {
  const { width, height } = ctx.canvas
  ctx.clearRect(0, 0, width, height)
  if (!text) return
  ctx.fillStyle = LABEL_PLATE
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = LABEL_PLATE_EDGE
  ctx.lineWidth = Math.max(2, Math.round(height * 0.05))
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, width - ctx.lineWidth, height - ctx.lineWidth)
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const font = (px: number): string => `bold ${px}px ui-sans-serif, system-ui, sans-serif`
  let size = height * 0.72
  ctx.font = font(size)
  const max = width * 0.9 // a margin either end, so the caption reads as printed ON the plate
  const measured = ctx.measureText(text).width
  if (measured > max) {
    size = Math.max(4, (size * max) / measured)
    ctx.font = font(size)
  }
  ctx.fillText(text, width / 2, height / 2 + size * 0.04)
}

function linkMesh(shape: Exclude<RigShape, { kind: 'mesh' } | { kind: 'frame' } | { kind: 'label' } | { kind: 'roller' } | { kind: 'leg' }>, material: Material): Mesh {
  const mesh = shape.kind === 'cylinder' ? new Mesh(cylinderGeoFor(shape.radius), material) : shape.kind === 'cone' ? new Mesh(unitCone, material) : new Mesh(unitBox, material)
  if (shape.kind === 'cylinder' || shape.kind === 'cone') mesh.scale.set(shape.radius, shape.height, shape.radius)
  else mesh.scale.set(shape.size[0], shape.size[1], shape.size[2])
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

// ---- rig link banks (arrayed primitives / arrayed meshes / lamps) --
// buildRig's per-link entry types + its closure-free rebuild helpers, hoisted to the top level so the
// ~1100-line builder below stays reviewable. Field semantics are documented at each entry array inside
// buildRig. The _inst temps are scratch reused per call (single-threaded render loop, like the
// beam temps below); never retained across calls.

type ArrayShape = Exclude<RigShape, { kind: 'mesh' } | { kind: 'frame' } | { kind: 'label' } | { kind: 'leg' }>
type MeshArrayLink = { group: Group; array: NonNullable<RigLink['array']>; showParam?: string; shape: Extract<RigShape, { kind: 'mesh' }>; template: Object3D | null; instances: Object3D[]; name: string; squash?: { frac: number; signal: string; anchorY: number; restY: number[]; cur: number; target: number } }
// C-emissive lamp-link material entry (see buildRig's lampMats)
// `bank`: a lamp drawn as an instance of a LampBank - painted through the bank's per-instance data, never `mat`
type LampMat = { name: string; mat: MeshStandardMaterial; color: Color; off: Color; opacity?: number; bank?: { bank: LampBank; index: number } }

// Write an array of grid deltas into a pool's InstancedMesh at one uniform scale (per-copy position varies,
// scale doesn't - a post run, a shelf stack). Grows the buffer as needed and refreshes bounds for culling.
const _instQuat = new Quaternion() // identity - the link group already carries the shape's rotation
const _instPos = new Vector3()
const _instScale = new Vector3()
const _instMat = new Matrix4()
function writeInstances(pool: InstancePool, deltas: readonly Vec3Tuple[], sx: number, sy: number, sz: number): void {
  ensureInstanceCapacity(pool, deltas.length)
  const mesh = pool.mesh
  _instScale.set(sx, sy, sz)
  for (let i = 0; i < deltas.length; i++) {
    _instPos.set(deltas[i]![0], deltas[i]![1], deltas[i]![2])
    _instMat.compose(_instPos, _instQuat, _instScale)
    mesh.setMatrixAt(i, _instMat)
  }
  mesh.count = deltas.length
  mesh.instanceMatrix.needsUpdate = true
  if (deltas.length > 0) mesh.computeBoundingSphere()
  syncBankEmptyVisibility(mesh) // gate-empty array (showParam off) ⇒ invisible, not a codegen-paying no-op draw
}
// A `distribute` array that reaches the instance ceiling is silently truncated by arrayInstanceDeltas (a
// roller bed or post run just stops mid-span). The ceiling is high enough that no realistic bed hits it, so
// this fires only on a pathological spacing/span - surface it once (partDiagnostics dedups the stable
// message, so a live drag can't storm it) with a message the author can act on, instead of geometry that
// just vanishes. partId is best-effort (set on the group before buildRig; absent for a catalog/thumbnail).
function warnIfCapped(deltas: readonly Vec3Tuple[], root: Group, packageId: string): void {
  if (deltas.length < MAX_DISTRIBUTE_INSTANCES) return
  reportPartDiagnostic({
    source: 'geometry',
    partId: typeof root.userData.partId === 'string' ? root.userData.partId : '',
    packageId,
    message: `A repeating rig element reached the ${MAX_DISTRIBUTE_INSTANCES}-instance safety ceiling; further copies were omitted. Increase the element spacing or reduce the span.`,
  })
}
// tileUv (RigMeshShape.tileUv): a stretched GLB member re-tiles its repeating texture instead of smearing it.
// Each matching mesh gets an owned geometry copy whose UV channel is the model's own times the stretch factor,
// rewritten in place on a param change (the attribute version bump is what the instance pool re-bakes on).
interface TiledMesh { tile: MeshUvTile; geo: BufferGeometry; base: Float32Array; attr: Float32BufferAttribute; k: number }
interface TiledMeshLink { sizeParams: NonNullable<Extract<RigShape, { kind: 'mesh' }>['sizeParams']>; tiles: MeshUvTile[]; meshes: TiledMesh[] }

function collectTiledMeshes(entry: TiledMeshLink, inst: Object3D): void {
  inst.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh) return
    const name = m.userData.glbMaterial as string | undefined
    const tile = name === undefined ? undefined : entry.tiles.find((t) => t.materials.includes(name))
    const uv = m.geometry.getAttribute('uv')
    if (!tile || !uv) return
    // an owned copy: the loaded geometry is shared by every part using this GLB, so rewriting its UVs in
    // place would re-tile them all at this part's length. Plain float UVs, because a quantized source
    // attribute (normalized ints) cannot hold a coordinate past 1.
    const geo = m.geometry.clone()
    const base = new Float32Array(uv.count * 2)
    for (let i = 0; i < uv.count; i++) { base[i * 2] = uv.getX(i); base[i * 2 + 1] = uv.getY(i) }
    const attr = new Float32BufferAttribute(base.slice(), 2)
    geo.setAttribute('uv', attr)
    m.geometry = geo
    entry.meshes.push({ tile, geo, base, attr, k: 1 })
  })
}

function applyTiledMeshes(entry: TiledMeshLink, params: RigParams): void {
  const f = resolvedMeshScale(entry.sizeParams, params)
  for (const tm of entry.meshes) {
    const k = f[tm.tile.axis]
    if (k === tm.k) continue // unchanged: no rewrite, no version bump, no pool re-bake
    tm.k = k
    const arr = tm.attr.array as Float32Array
    for (let i = tm.tile.uv === 'u' ? 0 : 1; i < arr.length; i += 2) arr[i] = tm.base[i]! * k
    tm.attr.needsUpdate = true
  }
}

const _spinQ = new Quaternion()
const _spinV = new Vector3()
// squash: compress every clone along local Y by `frac·cur`, anchored at the cup rim (anchorY) so the
// contact lip that meets the workpiece stays put and the bellows fold up toward the mount - the box the
// vacuum grips stays sealed against the lip instead of the lip springing off it. newY = restY + anchorY·frac·cur.
function applyMeshSquash(entry: MeshArrayLink): void {
  const s = entry.squash
  if (!s) return
  const scaleY = 1 - s.frac * s.cur
  const shift = s.anchorY * s.frac * s.cur // keep local y = anchorY fixed as scaleY shrinks
  for (let i = 0; i < entry.instances.length; i++) {
    const inst = entry.instances[i]!
    inst.scale.y = scaleY
    inst.position.y = (s.restY[i] ?? inst.position.y) + shift
  }
}
// MeshPart.squash: a geometry() submesh (or a whole instanced bank) compressed along its link's Y, anchored at its
// lowest point, the same ease and anchor as a mesh link's clones above.
type ProcSquash = { mesh: Mesh; frac: number; signal: string; anchorY: number; cur: number; target: number }
function applyProcSquash(s: ProcSquash): void {
  s.mesh.scale.y = 1 - s.frac * s.cur
  s.mesh.position.y = s.anchorY * s.frac * s.cur
}

// (Re)build an arrayed mesh link's clones at each array delta. Shared with the async-load path.
function rebuildMeshArray(entry: MeshArrayLink, params: RigParams, seam: SeamContext | undefined): void {
  if (!entry.template) return
  const deltas = arrayInstanceDeltas(entry.array, params, seam, entry.showParam)
  while (entry.instances.length < deltas.length) {
    const inst = entry.template.clone(true)
    entry.group.add(inst)
    entry.instances.push(inst)
  }
  while (entry.instances.length > deltas.length) entry.group.remove(entry.instances.pop()!)
  // delta is relative to the template's own prepared position (0 for a node ref; a whole-scene ref may
  // carry a fitHeight centring offset the clones must keep)
  const base = entry.template.position
  for (let i = 0; i < deltas.length; i++) entry.instances[i]!.position.set(base.x + deltas[i]![0], base.y + deltas[i]![1], base.z + deltas[i]![2])
  // snapshot the rest layout + replay the current squash (a lit vacuum keeps its cups compressed across a
  // param edit that re-lays the grid)
  if (entry.squash) {
    entry.squash.restY = entry.instances.map((inst) => inst.position.y)
    applyMeshSquash(entry)
  }
}

// C-emissive: light/darken one lamp link's material (mirrors the built-in stack-light paintLens - lit =
// tint + emissive at full energy, a lamp `opacity` lens going translucent over its core; off = the unlit
// albedo, opaque).
function paintLamp(lm: LampMat, on: boolean): void {
  if (lm.bank) {
    lm.bank.bank.paint(lm.bank.index, on)
    return
  }
  if (on) {
    lm.mat.color.copy(lm.color)
    lm.mat.emissive.copy(lm.color)
    lm.mat.emissiveIntensity = 1
    if (lm.opacity !== undefined) {
      lm.mat.transparent = true
      lm.mat.opacity = lm.opacity
    }
  } else {
    lm.mat.color.copy(lm.off)
    lm.mat.emissive.setHex(0x000000)
    lm.mat.emissiveIntensity = 0
    if (lm.opacity !== undefined) {
      lm.mat.transparent = false
      lm.mat.opacity = 1
    }
  }
}

// reused per beam probe (single-threaded render loop, like sensor.ts's temps); never retained across frames
const _beamQ = new Quaternion()
const _beamOrigin = new Vector3()
const _beamDir = new Vector3()

// ---- rig build -------------------------------------------------------------

export function buildRig(geo: Extract<PartPackage['geometry'], { kind: 'rig' }>, root: Group, assets: readonly PartAsset[], materials: readonly PartMaterial[], paramSpecs: PartPackage['params'], pkg: PartPackage): Content {
  const fallback = new MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.4, roughness: 0.5 })
  const matById = new Map(materials.map((m) => [m.id, buildMaterial(m, assets)]))
  const allMaterials: Material[] = [fallback, ...matById.values()]
  // a primitive link's `color` gives it its own tinted material (vs the shared gray fallback); disposed with the
  // rest. `metalness`/`roughness` override the default gloss (0.3/0.6) - a link mirroring a built-in's flat
  // non-metallic steel passes 0/0.8 so it shows its albedo instead of the environment reflection.
  const colorMaterial = (c: Vec3Tuple, metalness = 0.3, roughness = 0.6): MeshStandardMaterial => {
    const m = new MeshStandardMaterial({ color: new Color(c[0], c[1], c[2]), metalness, roughness })
    allMaterials.push(m)
    return m
  }
  // C-paramgeo colour: a link tinted by a `color` param (link.colorParam) gets its own material, re-tinted live
  // in refresh from the current param value - the same in-place repaint the belt's beltColor / a MeshPart's
  // colorParam get, generalized to a rig primitive. Seeded from the static `color` (else the neutral fallback)
  // so the first frame is right before refresh resolves the param. The refresh reads the hex as sRGB
  // (`.color.set`), matching the built-in barriers' `mat.color.set('#f2bd0f')`.
  // a mesh-lamp entry also carries its LampMat (`lamp`): the param then drives the lamp's unlit base and lit
  // colour together (the push button's `button color`: albedo = emission = button_color)
  const colorParamMats: { mat: MeshStandardMaterial; param: string; lamp?: LampMat }[] = []
  const colorParamMaterial = (param: string, base?: Vec3Tuple, metalness = 0.3, roughness = 0.6): MeshStandardMaterial => {
    const m = new MeshStandardMaterial({ color: base ? new Color(base[0], base[1], base[2]) : new Color(0x9aa3ad), metalness, roughness })
    allMaterials.push(m)
    colorParamMats.push({ mat: m, param })
    return m
  }
  // link role materials - the same textured metal/fabric the built-in conveyors use (railMaterial/guardMaterial/
  // legMaterial/boltMaterial/rollerMaterial + the scrolling belt fabric), so a rig SDK conveyor reads identically
  // to its built-in. Created lazily + cached per finish; the 'roller' materials are collected for the spin tick.
  const roleMats = new Map<string, Material>()
  const rollerMats: MeshStandardMaterial[] = []
  // finish:'tread' / 'deck' - the walking surfaces (steel tread plate, solid concrete deck), whose texture tiles per
  // metre. Every box link wearing one gets its own DeckSurface (deckSizeLinks), tiled from that link's resolved size
  // by its broad face: a stair's treads, risers and landing are three sizes, and one shared tiling would squeeze the
  // lugs on all but the link that set it last. The maps behind them are shared app-wide, so a surface adds one
  // material and no texture. A mesh link has no box size to tile by: it shares one surface per finish at the default tiling.
  const deckSurfaces: DeckSurface[] = []
  const newDeckSurface = (kind: WalkFinish): DeckSurface => {
    const s = createDeckSurface(kind)
    allMaterials.push(s.material)
    deckSurfaces.push(s)
    return s
  }
  const meshDeckSurfaces = new Map<WalkFinish, DeckSurface>()
  const deckSizeLinks: { size: Vec3Tuple; sizeParams?: Extract<RigShape, { kind: 'box' }>['sizeParams']; surface: DeckSurface }[] = []
  /** a box link's own walking-surface material, tiled from its size; null when the link wears no walking finish */
  const walkMaterial = (link: RigLink): Material | null => {
    if ((link.finish !== 'deck' && link.finish !== 'tread') || link.shape.kind !== 'box') return null
    const surface = newDeckSurface(link.finish)
    surface.setBoxExtent(link.shape.size) // the unparameterised size; refresh re-tiles a sizeParams box
    deckSizeLinks.push({ size: link.shape.size, ...(link.shape.sizeParams ? { sizeParams: link.shape.sizeParams } : {}), surface })
    return surface.material
  }
  const roleMaterial = (role: NonNullable<RigLink['finish']>): Material => {
    if (role === 'deck' || role === 'tread') {
      let s = meshDeckSurfaces.get(role)
      if (!s) meshDeckSurfaces.set(role, (s = newDeckSurface(role)))
      return s.material
    }
    let m = roleMats.get(role)
    if (!m) {
      if (role === 'belt') { const b = createBeltSurface(); b.material.side = DoubleSide; m = b.material }
      else if (role === 'roller') { const rm = rollerMaterial(); rollerMats.push(rm); m = rm }
      else m = role === 'frame' ? railMaterial() : role === 'guard' ? guardMaterial() : role === 'leg' ? legMaterial() : role === 'gapfill' ? gapFillMaterial() : role === 'mesh' ? FN_NEUTRAL() : boltMaterial()
      if (role === 'frame' || role === 'guard' || role === 'gapfill') m.side = DoubleSide
      allMaterials.push(m)
      roleMats.set(role, m)
    }
    return m
  }
  const linkGroups = new Map<string, Group>()
  const linkByName = new Map(geo.links.map((l) => [l.name, l]))
  const jointedLinks = new Set(geo.joints.map((j) => j.link))
  // A link nothing moves at runtime can pool across parts (the scene-global instance pool ingests plain
  // tagged meshes - see instancePool poolUnit); the pool bakes world matrices at rebuild time, so a link
  // that does move must render live or its pooled copy sits at rest while the real one travels. What
  // moves a link: a joint, an aim constraint, and a behavior's setSubPose by name (the push button's cap
  // depressing), which no geometry field declares. A dynamically-named call can't be resolved statically
  // and conservatively grounds the whole rig (subPosedLinkNames).
  const subPosed = subPosedLinkNames(pkg.behavior)
  const mobileLink = (l: RigLink): boolean => jointedLinks.has(l.name) || !!l.aim || subPosed.unresolved || subPosed.names.has(l.name)
  // Per link, not per rig: a whole-rig rule lets one joint keep every link of the part out, including
  // hardware that never moves (the turntable's legs, feet and base frame, a blade stop's housing). What
  // makes that safe is `poolMobile` below: a mobile link's group
  // carries it and instancePool.collectEligible prunes the whole subtree, so a static link riding a
  // moving one (the turntable's deck-mounted motor, a child of the rotating deck) stays live whatever
  // its own tag says. Link groups nest by `parent` (the pass after this loop), so the subtree IS the
  // kinematic chain.
  const poolableLink = (l: RigLink): boolean => !mobileLink(l)
  // The same rule applies to the instanced banks a link builds (array links). `poolUnit` above is an opt-in the
  // pool reads off plain meshes, so withholding it is enough there. A bank is an InstancedMesh, which the pool
  // ingests on sight, so a mobile link needs an opt-out of its own. `poolMobile` on the link group makes
  // instancePool.collectEligible prune the whole subtree, which covers a bank hanging off a jointed link's child.
  // Example: the turntable's holders + rim bolts are children of the roller link, which is a child of the rotating
  // deck. Pooled, they would stand still at the last-baked deck angle while the rollers (exempt via their spin
  // material) turn with the platter.
  // GLB node names each rendered by their own mesh link - so a parent node ref drops just these (its articulated
  // sub-nodes), keeping its own primitive meshes (see attachMesh's child-drop).
  const referencedNodes = new Set(geo.links.flatMap((l) => (l.shape.kind === 'mesh' && l.shape.node ? [l.shape.node] : [])))
  // param-driven box links (C-paramgeo): their mesh rescales on each refresh from the instance params
  const paramBoxes: { mesh: Mesh; size: Vec3Tuple; sizeParams: NonNullable<Extract<RigShape, { kind: 'box' }>['sizeParams']> }[] = []
  // splittable side box links on a straight roller/face-handle conveyor, remapped along local X in refresh:
  // a guard (role:'guard') gets gaps cut by a butting neighbour (host-computed openings) and its end span
  // remapped by the part's own snap extents; a frame rail (role:'frame' wall/flange, `frame: true`) takes
  // extents only - the host frame never opens, a flush side-merge instead retracts the
  // mover's rails to the host's outer wall plane (guardExtents, the spur extension mirrored). Built as one
  // box by default (a paramBox would do the same); refresh rebuilds each into the kept segments. `children`
  // is the live box-per-segment pool; the first child is the box `linkMesh` already made, extras cloned on
  // demand. A guard sheet (a link tall enough to hold a sensor-beam hole) is also split around each hole on its
  // side (guardHoles.ts), and `panels` is the pool of holed plates that fill those gaps; `offsetY` is the link's
  // centre height, which is how a sheet is told from the thin top return above it (which stays whole).
  const guardSplitLinks: { group: Group; size: Vec3Tuple; sizeParams: NonNullable<Extract<RigShape, { kind: 'box' }>['sizeParams']>; mat: Material; side: 'left' | 'right'; frame: boolean; offsetY: number; link: RigLink; children: Mesh[]; panels: Mesh[]; wedges: Mesh[] }[] = []
  // stair→platform structure-cut deck pool (docs/part-snap-stairs.md): a notchable box link's children are
  // (re)laid out per refresh as the complement strips around the cut's deck notches (deckStripRects - the same
  // pure rects the sim carves its colliders from), the 2-axis twin of guardSplitLinks. No cut ⇒ one full-size
  // child, identical to the plain param-box rescale it replaces. Done in place like the conveyor guard cut, so a
  // stair sliding along a deck edge never tears the rig down (a full rebuild per pointer-move causes snap lag). The railing half of the cut rides instancedArrayLinks (see `railing` there).
  // `walk`/`strips`: a walking-surface deck tiles each strip by its own size, so strip i wears strips[i] (strip 0 the
  // link's own surface; more are minted as a cut adds strips, and kept for reuse when it removes them)
  const deckCutLinks: { group: Group; size: Vec3Tuple; sizeParams?: Extract<RigShape, { kind: 'box' }>['sizeParams']; mat: Material; children: Mesh[]; walk?: WalkFinish; strips?: DeckSurface[] }[] = []
  // param-driven cylinder links (C-paramgeo): radius/height track a param (a roller's axle-length = belt width)
  const paramCylinders: { mesh: Mesh; shape: Extract<RigShape, { kind: 'cylinder' }> }[] = []
  // node scaling: a mesh-node link whose group stretches per-axis from a param (a GLB section that grows with a
  // width/length param). The factor multiplies the link group's scale (atop the node's fitHeight/scale base).
  const paramMeshes: { group: Group; sizeParams: NonNullable<Extract<RigShape, { kind: 'mesh' }>['sizeParams']> }[] = []
  // ...and those of them that re-tile a repeating texture along the stretch instead of smearing it (tileUv)
  const tiledMeshLinks: TiledMeshLink[] = []
  // a param-driven offset (C-paramgeo) or a whole-bed incline makes the refresh re-place the links (placeLinks)
  const paramPose = !!geo.inclineParam || geo.links.some((l) => !!l.offsetParams)
  // C-emissive: a link with a lamp (`lamps`) gets its own material so it can be lit per-tick. `off` is the
  // colour shown when dark - the lamp's authored `offColor` (its unlit albedo) else LAMP_OFF for a primitive, or a
  // mesh lamp's base (remapped) colour so e.g. a push-button cap reads as its matte colour when unlit, not a
  // dead grey. `opacity` (the lamp's own) makes the lit state translucent - a tinted lens over an inner
  // core, the built-in stack light's optics; off stays opaque.
  const lampMats: LampMat[] = []
  // showParam links: a boolean param gates the whole link's visibility (a structural side-guard toggle). Refresh
  // sets group.visible from the resolved param; the sim skips its collision body in parallel (world.buildRigBodies).
  const showParamLinks: { group: Group; param: string }[] = []
  // array-links: a count-driven primitive link (box/cylinder/cone) whose N copies share one uniform scale and
  // vary only in position - a bed of rollers/stubs, a platform's railing posts + support-column grid, a rack's
  // shelves + uprights, a stair's treads. Every such link collapses into one InstancedMesh (built-in instanced-draw
  // parity - a couple of draw calls no matter the count, not N separate meshes). `cast` skips the
  // shadow pass for tiny hardware (the axle stubs) that gives no useful self-shadow; structural arrays cast like
  // the built-ins did. The pool is created lazily on the first refresh.
  // `railing` marks a platform-perimeter link the stair→platform structure cut reshapes in place per refresh
  // (docs/part-snap-stairs.md): a post run (multi-instance array) drops instances in the railing gap + gains a
  // framing post at each gap edge (cutPostDeltas - shared with the sim's collider rewrite); a rail/toe box
  // (bare-gate or no array → `segment`) is laid out as one instance per kept segment with per-instance length.
  const instancedArrayLinks: { group: Group; shape: ArrayShape; array: NonNullable<RigLink['array']>; showParam?: string; pool: InstancePool | null; mat: Material; geom: BufferGeometry; cast: boolean; railing?: { edge: keyof PlatformCut['openings']; axis: 0 | 2; segment: boolean } }[] = []
  // kind:'leg' links: the built-in dual-post steel trestle (createLegSet + legStations + writeLegs), auto-spaced
  // along the spanParam length and reflowed on width/length change, the same legs the built-in parts use.
  const legLinks: { pool: LegPool; spanParam: string; widthParam: string; standParam: string; shape: RigLegShape; arc?: { radiusParam: string; sweepDeg: number } }[] = []
  // private texture copies minted for geometry() scroll channels (MeshPart.scroll). Not module-cached, so disposed with the part.
  const scrollTexClones: Texture[] = []
  // arrayed mesh links: the prepared GLB instance is a template cloned per array delta, (re)built in refresh -
  // the EOAT suction-cup grid (a `grid` array on a mesh link). Clones share the template's geometry/materials,
  // so a lamp material tint (the vacuum-on green) lights every cup at once.
  // `squash` (link.squash): while its driving lamp (`signal` = squash.lamp or the link's own lamp) is lit,
  // the clones compress along local Y anchored at the cup's rim (anchorY = template min-Y bound) - the vacuum
  // bellows collapsing while the contact lip stays seated on the workpiece. `restY` snapshots each clone's laid-out y so the eased scale/shift replays on top of the
  // rebuilt layout; `cur`→`target` (0..1) is eased by the tick; `signal` routes the lamp state to it (applyLamps).
  const meshArrayLinks: MeshArrayLink[] = []
  // the last refreshed params/seam, so a GLB that resolves after the first refresh lays its instances out on the
  // right grid (the async load can't see refresh's locals otherwise).
  let lastParams: RigParams = {}
  let lastSeam: SeamContext | undefined
  // the last applied neighbour-cut inputs (guard openings + platform structure cut). A change reshapes draws
  // that live inside a recorded WebGPU render bundle (instanced segment/post counts, strip children) on a part
  // that is not being dragged, so it was never bundle-ejected. Without a structural bump the bundle keeps
  // replaying the old railing/deck (the hole never closes until a dev restart). One bump per cut change.
  let lastCutKey = ''
  // C-label: render-only text planes (3D labels). Each carries a CanvasTexture redrawn on
  // refresh from a static `text` or a `textParam` (Inspector-editable); the plane hides when the text is empty.
  const labels: { shape: Extract<RigShape, { kind: 'label' }>; mesh: Mesh; ctx: CanvasRenderingContext2D; tex: CanvasTexture; last: string | null }[] = []
  const labelDisposables: (Texture | Material | BufferGeometry)[] = []
  // the display values last routed from the running frame (ctx.display) - what a live `textFrom` caption
  // shows. A name absent from the bag falls back to the authored plate, so a stopped scene reads as the
  // engraved legend rather than going blank.
  let displayValues: Readonly<Record<string, number | boolean | string>> = {}
  // per-link wireframe outline geometries (link.outline) - their LineBasicMaterial goes in allMaterials; these
  // EdgesGeometry buffers are per-instance and disposed with the part.
  const edgeGeoms: BufferGeometry[] = []
  // Pool opt-in for a static rig's GLB mesh links: the scene's repeated dressing (photo-eyes, push
  // buttons, beacons, bollards). A mesh link is an async-loaded subtree, not one mesh, so its leaves are
  // tagged. The pool ingests each as one instance at its world matrix (the same plain-mesh path the
  // primitives use). prepareMeshInstance's clone() shares the loaded geometry and the GLB's own materials
  // across parts, so N copies of one asset collapse to one draw per primitive. The saving grows with the
  // scene: 4 sensors are a dozen draws, a real plant layout's dressing is hundreds.
  //
  // Tagged per leaf, not per link, because one GLB link mixes materials this part mutates at runtime with the
  // GLB's own untouched ones (`shape.materials` remaps a single cap to a package lamp material). A
  // link-level test would either pool that lamp (its per-tick repaint would change its twins' colour
  // and churn the pool signature, which folds the tint, on every toggle) or exclude a whole housing
  // over one cap. `colorParam` tints are included, like the primitives: the merge key and the signature both
  // fold colour, so a repainted part regroups instead. Transparent leaves stay out (per-mesh draw
  // order); a leaf with children stays out (the pool copy clones none) while its children still tag.
  const tagPoolLeaves = (inst: Object3D): void => {
    inst.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh || m.children.length > 0) return
      const mat = m.material
      if (Array.isArray(mat) || !mat || mat.transparent === true) return
      if (lampMats.some((l) => l.mat === mat)) return // lit per tick - see above
      m.userData.poolUnit = true
    })
  }
  // Lamp banks (lampBank.ts): primitive lamp links that share a unit geometry and a parent link draw as the
  // instances of one InstancedMesh instead of a mesh + material each. A stack light's 8 lens tiers are one
  // draw, not 8 (5 of them zero-height slivers). Per-instance colour/glow/opacity carry what paintLamp
  // writes on a material. Only where two or more share a bank (a lone LED keeps its plain mesh), and never a
  // link whose own draw state the bank can't express per instance: a mobile link (FK places it per frame),
  // an author-hidden or showParam-gated one (a bank can't hide one instance), edges (the outline child), a
  // finish/side-wall/notchable/railing link (their own layout paths), or an array.
  const lampGeoOf = (shape: RigShape): BufferGeometry => (shape.kind === 'cylinder' ? cylinderGeoFor(shape.radius) : shape.kind === 'cone' ? unitCone : unitBox)
  const lampBankGroups = new Map<string, string[]>()
  for (const l of geo.links) {
    if (!l.lamps?.length || l.array || l.outline || l.hidden || l.showParam || l.finish || l.sideGuard || l.sideRail || l.notchable || l.onEdge || mobileLink(l)) continue
    if (l.shape.kind !== 'cylinder' && l.shape.kind !== 'cone' && l.shape.kind !== 'box') continue
    const key = `${l.parent ?? ''}|${lampGeoOf(l.shape).uuid}`
    const names = lampBankGroups.get(key)
    if (names) names.push(l.name)
    else lampBankGroups.set(key, [l.name])
  }
  const lampBanked = new Set([...lampBankGroups.values()].filter((n) => n.length >= 2).flat())
  // a banked link's unit-primitive mesh, kept out of the scene: refresh's param sizing still scales it, and
  // its bank reads the scale from it (LampSlot.shape)
  const lampCarriers = new Map<string, Mesh>()
  // Link banks (linkBank.ts): plain decorative primitive links riding a moving link (the turntable's deck-
  // mounted gearmotor, 31 painted pieces on a pivot that turns with the deck) that share a parent, a unit
  // geometry and a look draw as the instances of one InstancedMesh hung off that parent, which carries them
  // through the joint's motion. Only where the scene-global pool can't reach: a link nothing moves is left
  // to the pool (which merges across parts, and this can't), and a link that moves itself can't share its
  // parent's frame. Allow-listed, not excluded: a link banks only when it is nothing but a painted shape -
  // `collision: 'none'` decoration with no finish, lamp, cue, visibility gate, beam, zone or grab - so any link
  // feature the bank can't express, including one added later, keeps its own mesh by default.
  const BANKABLE_KEYS = new Set(['name', 'parent', 'shape', 'offset', 'rotation', 'quat', 'offsetParams', 'color', 'metalness', 'roughness', 'collision'])
  const ridesMobile = (l: RigLink): boolean => {
    for (let p = l.parent ? linkByName.get(l.parent) : undefined; p; p = p.parent ? linkByName.get(p.parent) : undefined) if (mobileLink(p)) return true
    return false
  }
  const linkBankKey = (l: RigLink): string | null => {
    if (l.collision !== 'none' || mobileLink(l) || !ridesMobile(l)) return null
    if (l.shape.kind !== 'box' && l.shape.kind !== 'cylinder' && l.shape.kind !== 'cone') return null
    if (Object.keys(l).some((k) => !BANKABLE_KEYS.has(k))) return null
    const look = l.color ? `${l.color.join(',')}|${l.metalness ?? ''}|${l.roughness ?? ''}` : 'fallback'
    return `${l.parent}|${lampGeoOf(l.shape).uuid}|${look}`
  }
  const linkBankGroups = new Map<string, string[]>()
  for (const l of geo.links) {
    const key = linkBankKey(l)
    if (key === null) continue
    const names = linkBankGroups.get(key)
    if (names) names.push(l.name)
    else linkBankGroups.set(key, [l.name])
  }
  // banked link → its bank key (groups of two or more; a lone piece keeps its plain mesh)
  const linkBanked = new Map([...linkBankGroups].filter(([, n]) => n.length >= 2).flatMap(([key, n]) => n.map((name) => [name, key] as const)))
  const linkBankMats = new Map<string, Material>() // one material per bank: its members share a look by construction
  const linkCarriers = new Map<string, Mesh>() // like lampCarriers: the detached unit mesh refresh still scales
  for (const link of geo.links) {
    const g = new Group()
    g.userData.linkName = link.name
    // FK moves this group every frame ⇒ nothing under it may merge into the world-space instance pool
    if (mobileLink(link)) g.userData.poolMobile = true
    // author-mode visibility toggle (Scene-tree eye): hide this link's render group (and its subtree); the
    // sim/collision body is still built (render-only, like a frame/label link the other way round).
    if (link.hidden) {
      g.visible = false
      g.userData.authorHidden = true
      // ...and because the body IS built, the hidden link is still solid to the walking pilot, whose wall
      // rays test render meshes and would otherwise pass straight through it. A platform railing is the case
      // that matters: the rails/posts/toe board are decoration (collision: 'none') and the barrier is this hidden
      // wall, so without the flag the pilot walks off the deck between the rails. `collision: 'none'` opts out -
      // a hidden link with no body (the safety gate's full-span `interact` Use volume) must stay walk-through.
      if (link.collision !== 'none') g.userData.collisionSolid = true
    }
    // param-gated structural toggle: refresh sets g.visible from the boolean param (the sim drops the body to match)
    if (link.showParam) showParamLinks.push({ group: g, param: link.showParam })
    if (link.shape.kind === 'label') {
      // a flat plane facing local +Z; the canvas/2d context may be absent (headless tests) - then the link is empty
      const shape = link.shape
      const [w, h] = shape.size ?? [0.05, 0.05]
      const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
      const c2d = canvas?.getContext('2d') ?? null
      if (canvas && c2d) {
        const size = labelCanvasSize(w, h)
        canvas.width = size.width
        canvas.height = size.height
        const tex = new CanvasTexture(canvas)
        tex.colorSpace = SRGBColorSpace
        // a caption is read at a glancing angle as often as head-on (walking a line, not standing at it), and
        // an unfiltered minified glyph washes out to nothing there - the plate keeps its text off-axis
        tex.anisotropy = MAX_LABEL_ANISOTROPY
        // Opaque: the plate covers its quad edge to edge, so there is nothing to blend and no reason to skip
        // depth. Transparent + depthWrite:false is what a bare-glyph caption would need, and that combination
        // loses the text under WebGPU (see drawLabelText). A solid quad standing clear of the surface behind it
        // needs neither.
        const mat = new MeshBasicMaterial({ map: tex, toneMapped: false })
        const geom = new PlaneGeometry(w, h)
        const mesh = new Mesh(geom, mat)
        mesh.visible = false // shown once the first refresh draws non-empty text
        g.add(mesh)
        labels.push({ shape, mesh, ctx: c2d, tex, last: null })
        labelDisposables.push(tex, mat, geom)
      }
    }
    else if (link.shape.kind === 'mesh') {
      // a finish overrides the GLB's own material with the host conveyor material (e.g. a 'roller'-finish GLB roller
      // gets the brushed roller metal + spin); else the shape's declared package material, else the GLB's own.
      const single = link.finish ? roleMaterial(link.finish) : link.shape.material ? matById.get(link.shape.material) : undefined
      // resolve the per-GLB-material remap (name → built package material), dropping any unresolved id
      const perMat = link.shape.materials
        ? new Map(Object.entries(link.shape.materials).flatMap(([glb, id]) => { const m = matById.get(id); return m ? [[glb, m] as [string, Material]] : [] }))
        : undefined
      // tileUv: the GLB loads async, so the owned UV copies are made in the load callback below and brought to
      // the current stretch there; refresh keeps them in sync after that
      const tiled: TiledMeshLink | undefined = link.shape.tileUv && link.shape.sizeParams
        ? { sizeParams: link.shape.sizeParams, tiles: link.shape.tileUv, meshes: [] }
        : undefined
      if (tiled) tiledMeshLinks.push(tiled)
      const prepareTiled = (inst: Object3D): void => {
        if (!tiled) return
        collectTiledMeshes(tiled, inst)
        applyTiledMeshes(tiled, lastParams)
      }
      // C-emissive on a mesh link (link.lamps): each lamp lights one remapped GLB material under its behavior
      // name, so an imported panel whose lenses share a node still gets a lamp per lens - the Diverter's LampRed
      // + LampGreen are two primitives of the same `Pusher` mesh, which hideNodes/keepNode (carving by node)
      // can't split into links. Off = that material's matte base colour (an unlit cap stays its own colour, not
      // a dead grey). Registered before attachMesh so tagPoolLeaves already sees these materials as lit-per-tick
      // and leaves them out of the static pool (a pooled copy would drag its twins' colour).
      for (const lamp of link.lamps ?? []) {
        const lampMat = matById.get(link.shape.materials?.[lamp.material ?? ''] ?? '')
        if (!lampMat) continue
        if (lamp.offColor) lampMat.color.setRGB(lamp.offColor[0], lamp.offColor[1], lamp.offColor[2]) // authored dark colour, else the material's own
        const lm: LampMat = { name: lamp.name ?? link.name, mat: lampMat, color: new Color(lamp.emissive[0], lamp.emissive[1], lamp.emissive[2]), off: lampMat.color.clone(), ...(lamp.opacity !== undefined ? { opacity: lamp.opacity } : {}) }
        lampMats.push(lm)
        // C-paramgeo colour on a mesh lamp: the colorParam re-tints the lamp's unlit base and lit colour in
        // refresh (the push button's `button color`: albedo = emission = button_color). Only
        // for a link's one lamp: a param names one colour, and a panel of several lenses has several.
        if (link.colorParam && link.lamps!.length === 1) colorParamMats.push({ mat: lampMat, param: link.colorParam, lamp: lm })
      }
      if (link.array) {
        // an arrayed mesh link: the prepared GLB instance becomes a template cloned per array delta (the EOAT
        // suction-cup grid). Loads async → rebuild once it arrives (using the last refreshed params/seam), and
        // bump structureVersion so a staged placement preview re-tags the new clones (like roller/chain links).
        const entry: MeshArrayLink = { group: g, array: link.array, ...(link.showParam ? { showParam: link.showParam } : {}), shape: link.shape, template: null, instances: [], name: link.name }
        // squash: the clones compress when their driving lamp lights - `squash.lamp` (the EOAT's vacuum-status
        // LED) or this link's own lamp. No lamp of its own required (the cups don't glow).
        // anchorY is filled from the template bounds once the GLB loads.
        if (link.squash) entry.squash = { frac: link.squash.amount, signal: link.squash.lamp ?? link.name, anchorY: 0, restY: [], cur: 0, target: 0 }
        meshArrayLinks.push(entry)
        const asset = assets.find((a) => a.id === entry.shape.asset)
        if (asset) {
          void loadMeshAsset(asset)
            .then((scene) => {
              entry.template = prepareMeshInstance(scene, entry.shape, single, perMat, referencedNodes)
              if (!entry.template) return
              prepareTiled(entry.template) // before the clones: they share the template's (now owned) geometry
              if (entry.squash) {
                entry.template.updateMatrixWorld(true)
                const box = new Box3().setFromObject(entry.template)
                entry.squash.anchorY = Number.isFinite(box.min.y) ? box.min.y : 0 // the cup rim (contact lip) - stays seated on the workpiece while the bellows fold up into the mount
              }
              rebuildMeshArray(entry, lastParams, lastSeam)
              bumpStructureVersion(root)
            })
            .catch((e) => console.error('[oip] custom-part mesh load failed', e))
        }
      } else {
        const poolable = poolableLink(link)
        attachMesh(g, root, link.shape, assets, single, perMat, referencedNodes, poolable || tiled ? (inst) => { prepareTiled(inst); if (poolable) tagPoolLeaves(inst) } : undefined)
      }
      if (!link.lamps?.length && link.colorParam && !link.finish && link.shape.material) {
        // C-paramgeo colour on a plain mesh link: tints its single package-material override (a `finish`'s shared
        // textured material and a GLB's own materials stay untouched - those aren't this part's to repaint)
        const m = matById.get(link.shape.material)
        if (m) colorParamMats.push({ mat: m, param: link.colorParam })
      }
      if (link.shape.sizeParams) paramMeshes.push({ group: g, sizeParams: link.shape.sizeParams })
    }
    else if (link.shape.kind === 'leg') {
      // the built-in trestle: two InstancedMeshes (boxes + hex bolts) sharing the leg/bolt metal; refresh writes
      // the per-station leg matrices (legStations cadence). The group is placed at the floor; legs grow up.
      const pool = createLegSet(g, roleMaterial('leg'), roleMaterial('bolt'))
      legLinks.push({ pool, spanParam: link.shape.spanParam, widthParam: link.shape.widthParam, standParam: link.shape.standParam, shape: link.shape, ...(link.shape.arc ? { arc: link.shape.arc } : {}) })
    }
    else if (link.shape.kind !== 'frame') {
      // a `railing`-tagged link participates in the stair→platform structure cut in refresh - including the
      // hidden collision walls: the walking pilot reads hidden-but-bodied links as walls (`collisionSolid`),
      // so an uncut invisible wall stops the pilot dead on the landing behind a rail that is open everywhere
      // else. A cut this rig applies to the rail must reach every link that makes up that rail.
      const railing = link.onEdge
        ? { edge: link.onEdge, axis: (link.onEdge === 'posX' || link.onEdge === 'negX' ? 2 : 0) as 0 | 2, segment: !isMultiInstance(link.array) }
        : undefined
      // a railing rail/toe box without an array still needs the per-segment instanced layout - an empty array
      // spec resolves to one instance at the origin
      if (link.array || (railing && link.shape.kind === 'box')) {
        // an array link is an empty container; refresh fills its one InstancedMesh with the resolved instance
        // count. Every arrayed primitive (rollers, axle stubs, railing posts, rack shelves, stair treads) is N
        // copies of one shape at a uniform scale → one draw call regardless of count (built-in instanced-draw
        // parity), instead of N meshes. Roller hardware (role:'roller' stubs) skips the shadow pass; structural
        // arrays cast like their built-ins did (linkMesh's default). geom pick mirrors linkMesh (prim-only).
        const arrMat = walkMaterial(link) ?? (link.finish ? roleMaterial(link.finish) : link.colorParam ? colorParamMaterial(link.colorParam, link.color, link.metalness, link.roughness) : link.color ? colorMaterial(link.color, link.metalness, link.roughness) : fallback)
        const geom = link.shape.kind === 'cylinder' ? cylinderGeoFor(link.shape.radius) : link.shape.kind === 'cone' ? unitCone : unitBox
        instancedArrayLinks.push({ group: g, shape: link.shape, array: link.array ?? {}, ...(link.showParam ? { showParam: link.showParam } : {}), pool: null, mat: arrMat, geom, cast: link.finish !== 'roller', ...(railing ? { railing } : {}) })
      } else {
        let mat: Material
        let cue = false // a translucent cue link - see the opacity branch (no shadow cast)
        const lamp = link.lamps?.[0] // a primitive carries at most one: its own material
        if (lamp && lampBanked.has(link.name)) {
          // an instance of its lamp bank (built after the parenting pass); the mesh below is only the detached
          // scale carrier, never drawn, so it takes the shared bank material rather than a per-link one
          mat = lampBankMaterial()
        } else if (lamp) {
          // its own lamp material; unlit shows the lamp's `offColor` (the lens/cup albedo) else the dark neutral
          const off = lamp.offColor ? new Color(lamp.offColor[0], lamp.offColor[1], lamp.offColor[2]) : new Color(LAMP_OFF_COLOR)
          const lm = new MeshStandardMaterial({ color: off.clone(), metalness: 0.1, roughness: 0.5 })
          allMaterials.push(lm)
          lampMats.push({ name: lamp.name ?? link.name, mat: lm, color: new Color(lamp.emissive[0], lamp.emissive[1], lamp.emissive[2]), off, ...(lamp.opacity !== undefined ? { opacity: lamp.opacity } : {}) })
          mat = lm
        } else if (link.opacity !== undefined && link.opacity < 1) {
          // a translucent cue (the spawner's drop cone): its own transparent material, never a shared role/fallback
          // (mutating those would fade every same-role link). depthWrite off so it doesn't occlude what's behind it.
          // An untinted cue falls back to a neutral grey - a part that wants a signature tint authors `color`.
          const c = link.color ?? [0.7, 0.7, 0.7]
          const tm = new MeshStandardMaterial({ color: new Color(c[0], c[1], c[2]), metalness: link.metalness ?? 0.2, roughness: link.roughness ?? 0.5, transparent: true, opacity: link.opacity, depthWrite: false })
          allMaterials.push(tm)
          mat = tm
          cue = true
        } else if (linkBanked.has(link.name)) {
          const key = linkBanked.get(link.name)!
          let bm = linkBankMats.get(key)
          if (!bm) linkBankMats.set(key, (bm = link.color ? colorMaterial(link.color, link.metalness, link.roughness) : fallback))
          mat = bm
        } else {
          // a walking surface of its own, host finish material, a param-driven tint, its own static tint, else shared gray
          mat = walkMaterial(link) ?? (link.finish ? roleMaterial(link.finish) : link.colorParam ? colorParamMaterial(link.colorParam, link.color, link.metalness, link.roughness) : link.color ? colorMaterial(link.color, link.metalness, link.roughness) : fallback)
        }
        const m = linkMesh(link.shape, mat) // 'frame' = transform-only, no mesh
        // A translucent cue is not a body, so it casts no shadow. three's shadow pass ignores
        // material.opacity, so a 25%-opaque volume would throw a 100%-opaque shadow (the
        // despawner's 2x1x2 mouth would paint a solid black rectangle onto the belt under it,
        // and the spawner marker a hard cube). The other cues follow the same rule (sensor beams,
        // flow arrows, guard walls), for the same reason as this material's depthWrite:false:
        // the cue does not occlude. receiveShadow stays on, so a marker in the building is still lit.
        if (cue) m.castShadow = false
        if (lampBanked.has(link.name)) lampCarriers.set(link.name, m)
        else if (linkBanked.has(link.name)) linkCarriers.set(link.name, m)
        else g.add(m)
        // pool opt-in (static rigs only): the mesh is a shared unit primitive with size in mesh.scale, so
        // identical links across parts merge in the scene-global pool. Exclude any link whose material
        // state can diverge per part at runtime in a way the pool's rebuild signature cannot see -
        // emissive lamps lit per-tick and translucent cues - and edges links (the pool copy would drop
        // the wireframe child). `colorParam` links are included: the merge key folds colour and the
        // signature tracks the tint, so a repainted rack regroups instead of changing its twins'
        // colour too. This is what pools the structural parts: a platform/stairs/rack is one unit
        // box repeated a dozen times with a colour param on it (e2e/probes/draw-census.mjs).
        if (poolableLink(link) && !link.lamps?.length && link.opacity === undefined && !link.outline) m.userData.poolUnit = true
        // C-edges: a crisp wireframe outline over the fill (the built-in spawner marker's light-blue edges).
        // A LineSegments child of the scaled mesh, so the outline tracks the link's size (incl. sizeParams).
        if (link.outline) {
          const eg = new EdgesGeometry(m.geometry)
          const em = new LineBasicMaterial({ color: new Color(link.outline[0], link.outline[1], link.outline[2]) })
          m.add(new LineSegments(eg, em))
          allMaterials.push(em)
          edgeGeoms.push(eg)
        }
        if (link.notchable && link.shape.kind === 'box') {
          // a deck slab is (re)laid out by the deck-cut pool: one full-size child normally, complement strips
          // around the notches a snapped stair carves - replaces its plain param-box rescale
          const own = link.finish === 'deck' || link.finish === 'tread' ? deckSizeLinks.find((d) => d.surface.material === mat)?.surface : undefined
          deckCutLinks.push({ group: g, size: link.shape.size, sizeParams: link.shape.sizeParams, mat, children: [m], ...(own && (link.finish === 'deck' || link.finish === 'tread') ? { walk: link.finish, strips: [own] } : {}) })
        }
        else if (link.shape.kind === 'box' && link.shape.sizeParams) {
          // a length-parametric side guard (sideGuard) or side rail (sideRail) is remapped at
          // neighbour junctions in refresh; other param boxes just rescale. One on a non-conveyor rig never
          // receives openings/extents (the scene resolvers only map conveyors), so it stays a single
          // full-span box - the same as a plain param box.
          const guardSide = rigGuardSide(link)
          const side = guardSide ?? rigFrameSide(link)
          if (side) guardSplitLinks.push({ group: g, size: link.shape.size, sizeParams: link.shape.sizeParams, mat, side, frame: guardSide === null, offsetY: link.offset[1], link, children: [m], panels: [], wedges: [] })
          else paramBoxes.push({ mesh: m, size: link.shape.size, sizeParams: link.shape.sizeParams })
        }
        else if (link.shape.kind === 'cylinder' && link.shape.sizeParams) paramCylinders.push({ mesh: m, shape: link.shape })
      }
    }
    linkGroups.set(link.name, g)
  }
  // parent + rest pose (a parent named but missing falls back to the root; validation rejects that case).
  // The rest rotation honors quat (else Euler) via the shared restQuatOf, so render matches the core FK.
  for (const link of geo.links) {
    const g = linkGroups.get(link.name)!
    ;(link.parent ? (linkGroups.get(link.parent) ?? root) : root).add(g)
    g.position.set(link.offset[0], link.offset[1], link.offset[2])
    const q = restQuatOf(link)
    g.quaternion.set(q[0], q[1], q[2], q[3])
  }
  // build the lamp banks now that every link group sits in its parent (the bank hangs off that shared parent,
  // so it rides whatever moves it) and register each instance as a lamp: applyLamps / a lamp's param paint it
  // through the bank. refresh re-places the instances after its param offsets + sizes (writeMatrices).
  const lampBanks: LampBank[] = []
  for (const names of lampBankGroups.values()) {
    if (names.length < 2) continue
    const first = linkByName.get(names[0]!)!
    const slots: LampSlot[] = names.map((name) => {
      const l = linkByName.get(name)!
      const lamp = l.lamps![0]!
      const e = lamp.emissive
      return {
        name: lamp.name ?? name,
        color: new Color(e[0], e[1], e[2]),
        off: lamp.offColor ? new Color(lamp.offColor[0], lamp.offColor[1], lamp.offColor[2]) : new Color(LAMP_OFF_COLOR),
        ...(lamp.opacity !== undefined ? { opacity: lamp.opacity } : {}),
        node: linkGroups.get(name)!,
        shape: lampCarriers.get(name)!,
      }
    })
    const bank = new LampBank(lampGeoOf(first.shape), slots)
    ;(first.parent ? (linkGroups.get(first.parent) ?? root) : root).add(bank.mesh)
    bank.writeMatrices()
    slots.forEach((s, index) => lampMats.push({ name: s.name, mat: bank.mesh.material as MeshStandardMaterial, color: s.color, off: s.off, ...(s.opacity !== undefined ? { opacity: s.opacity } : {}), bank: { bank, index } }))
    lampBanks.push(bank)
  }
  // ...and the link banks, the same way: each hangs off its members' shared (moving) parent
  const linkBanks: LinkBank[] = []
  for (const names of linkBankGroups.values()) {
    if (names.length < 2) continue
    const slots: LinkSlot[] = names.map((name) => ({ name, node: linkGroups.get(name)!, shape: linkCarriers.get(name)! }))
    const carrier = linkCarriers.get(names[0]!)!
    const bank = new LinkBank(carrier.geometry, carrier.material as Material, slots, carrier.castShadow)
    const parent = linkByName.get(names[0]!)!.parent!
    ;(linkGroups.get(parent) ?? root).add(bank.mesh)
    bank.writeMatrices()
    linkBanks.push(bank)
  }
  // a banked link's group moved outside refresh (a rest-pose reflow, a subPose the static scan missed)
  const replaceLinkBanks = (): void => {
    for (const lb of linkBanks) lb.writeMatrices()
  }

  // Transform-mutation tally for the matrix-freeze cache (viewMatrices.ts ensureFreshPose): every rig is
  // matrix-static, so each runtime mutator that moves a node transform outside apply() must bump the
  // root's poseRev: applyJoints/applySubPoses (frame routing, gizmo drag), squashTick (Stop-relax easing),
  // probeTick (beam stretch). apply()-driven moves (reflow, refresh, rebuild) are tallied by sdkPart's own
  // bump; a double bump is harmless. The bump goes through poseRev.ts, which also advances the global pose
  // epoch that the view's idle frozen-walk skip checks.
  const bumpPoseRev = (): void => {
    bumpVisualPoseRev(root)
  }

  // C-sensing beam visual: a link with a `beam` draws the same live beam line as the built-in sensors
  // (sensor.ts) and publishes the guard-hole segment each frame - probeTick, driven by view.ts's per-entry
  // probe loop. The line runs to the link's `beam.rangeParam` (default-resolved, the same length the sim senses
  // to; else its declared range) and hides when its `beam.showParam` is false; `beam.tint:'hit'` colours a
  // blocked beam with the detected cargo's tint instead of red (the colour sensor). `paramRange` / `shown` are
  // those two, resolved in refresh.
  const beamVisuals: { name: string; group: Group; beam: SensorBeam; axis: Vector3; range: number; rangeParam?: string; showParam?: string; paramRange: number | null; shown: boolean; tintHit: boolean; lastDist: number }[] = []
  for (const link of geo.links) {
    if (!link.beam) continue
    const g = linkGroups.get(link.name)!
    const axis = new Vector3(link.beam.axis?.[0] ?? 0, link.beam.axis?.[1] ?? 0, link.beam.axis?.[2] ?? 1).normalize()
    // Not a mesh under g: the beam renders in the overlay pass, so it must not sit inside the part's
    // rig (which is bundled under WebGPU, and bundles execute after every base draw, so they would paint
    // over it). Every beam in the scene is one instance of a shared bank instead: probeTick
    // writes its world aim + tint below, and `root` is passed so the bank can mirror the part's
    // visibility each frame. It stays collapsed/undrawn until that first probe, which keeps an
    // unprobed thumbnail rig out of the overlay gate. See sensorBeamOverlay.ts.
    beamVisuals.push({ name: link.name, group: g, beam: addSensorBeam(root), axis, range: link.beam.range, ...(link.beam.rangeParam !== undefined ? { rangeParam: link.beam.rangeParam } : {}), ...(link.beam.showParam !== undefined ? { showParam: link.beam.showParam } : {}), paramRange: null, shown: true, tintHit: link.beam.tint === 'hit', lastDist: -1 })
  }
  const probeTick = beamVisuals.length
    ? (probe: BeamProbe): boolean => {
        // hidden part: no beam (mirrors the built-in sensors). The guard holes a beam cuts are not drawn from here:
        // they are geometry, worked out from the scene (core/guardHoles.ts), so hiding a sensor leaves them. The show flags are
        // left alone - syncSensorBeams ANDs them with root.visible every frame, so
        // the beams come back with the part without needing another probe seam (WebGPU's staged
        // compile hides parts outside any seam; see sensorBeamOverlay.ts).
        if (!root.visible) return false
        let mutated = false // whether a beam visual changed (stretch/tint) - the view's bundle activity mark
        for (const bv of beamVisuals) {
          bv.group.getWorldPosition(_beamOrigin)
          _beamDir.copy(bv.axis).applyQuaternion(bv.group.getWorldQuaternion(_beamQ))
          const range = bv.paramRange ?? bv.range
          if (!bv.shown) {
            bv.beam.setShow(false)
            continue
          }
          const hit = probe(_beamOrigin, _beamDir, range, bv.name)
          const dist = hit ? Math.min(hit.distance, range) : range
          // tint only on a real change, so a steady beam doesn't mark its part dirty every probe pass
          const tint = bv.tintHit ? (hit ? hit.color : BEAM_GREEN) : hit ? BEAM_RED : BEAM_GREEN
          if (bv.beam.tint(tint)) mutated = true
          bv.beam.setShow(true)
          // World aim, rewritten every probe: the beam is an instance of the scene-level bank, so it
          // inherits nothing from the part and must re-derive its placement whenever the part moves,
          // not only when the hit distance changes. The beam is outside the matrix-frozen rig and
          // outside the bundle, so these few vector ops need no poseRev bump and no per-frame re-bake.
          bv.beam.aim(_beamOrigin, _beamDir, dist)
          // still change-gated: `mutated` is the view's activity mark, not the transform write
          if (dist !== bv.lastDist) {
            bv.lastDist = dist
            mutated = true
          }
        }
        return mutated
      }
    : undefined

  // ---- link placement: one resolver --------------------------------------------------------------------------
  // Every link group's pose comes from core's rig FK (rigWorldPosesInto) - the function the sim builds its bodies
  // from - run on the current geometry with the current joints, sub-poses, params and whole-bed incline, and
  // written back as each group's local transform (its parent's world pose inverted, times its own). Every layer
  // is in that one call: the authored rest pose, a param-driven offset (C-paramgeo), a joint, a setSubPose
  // override, an aim constraint (C-aim), the incline (legs excepted, as in core).
  //
  // Never re-derive a layer here from a copy of the rest pose taken at build time: an author edit to a node
  // would change the data while the next refresh puts the node back, and the visual could drift from the
  // sim's colliders. A new pose, from any source, is one call.
  const aimLinks = geo.links.filter((l) => l.aim)
  let poseGeo: Extract<PartPackage['geometry'], { kind: 'rig' }> = geo // what the groups are posed from
  let poseBuf = rigPoseBuffer(geo)
  // parent index per link (by position in links); structure is fixed for this build - applyRestPose only swaps poses
  const poseParent = Int32Array.from(geo.links.map((l) => (l.parent ? geo.links.findIndex((x) => x.name === l.parent) : -1)))
  let lastJoints: Record<string, number> = {} // the last-applied joint values (a refresh re-places with them)
  let lastSubPoses: Record<string, SubPose> = {} // every setSubPose override seen; a link keeps its last one
  let lastIncline = 0 // the whole-bed incline the last placeLinks resolved (params change only through a refresh)
  const placeLinks = (): void => {
    lastIncline = rigInclineRad(poseGeo, lastParams)
    rigWorldPosesInto(poseBuf, poseGeo, lastJoints, lastSubPoses, 1, lastParams, lastIncline)
    const b = poseBuf
    const links = poseGeo.links
    for (let i = 0; i < links.length; i++) {
      const grp = linkGroups.get(links[i]!.name)
      if (!grp) continue
      const o = i * POSE_STRIDE
      const pi = poseParent[i]!
      if (pi < 0) {
        grp.position.set(b[o]!, b[o + 1]!, b[o + 2]!)
        grp.quaternion.set(b[o + 3]!, b[o + 4]!, b[o + 5]!, b[o + 6]!)
        continue
      }
      // local = parent^-1 * world: rotate (world pos - parent pos) by the parent's conjugate, and conj(parent) * q
      const po = pi * POSE_STRIDE
      const cx = -b[po + 3]!, cy = -b[po + 4]!, cz = -b[po + 5]!, cw = b[po + 6]!
      const dx = b[o]! - b[po]!, dy = b[o + 1]! - b[po + 1]!, dz = b[o + 2]! - b[po + 2]!
      const tx = 2 * (cy * dz - cz * dy), ty = 2 * (cz * dx - cx * dz), tz = 2 * (cx * dy - cy * dx)
      grp.position.set(dx + cw * tx + (cy * tz - cz * ty), dy + cw * ty + (cz * tx - cx * tz), dz + cw * tz + (cx * ty - cy * tx))
      const qx = b[o + 3]!, qy = b[o + 4]!, qz = b[o + 5]!, qw = b[o + 6]!
      grp.quaternion.set(cw * qx + cx * qw + cy * qz - cz * qy, cw * qy + cy * qw + cz * qx - cx * qz, cw * qz + cz * qw + cx * qy - cy * qx, cw * qw - cx * qx - cy * qy - cz * qz)
    }
  }
  placeLinks() // the rest pose, with aim links connected, in case the rig is never driven (no gizmo/idle pose)

  // The per-frame paths (a joint tick, a sub-pose) can only change the local transform of the links they name, and
  // the scene graph carries every child along. So they re-pose just those, by core's own per-link rule
  // (rigLinkLocalPoseInto, the same math the full composition uses) on the current geometry. Placing all 57 links
  // of a one-joint turntable every frame costs ~60x what the joint itself does. A rig with aim links composes the
  // whole tree instead, since an aimed strut's rotation hangs on another link's world position.
  const localScratch = new Float64Array(POSE_STRIDE)
  const linkIndex = new Map(geo.links.map((l, i) => [l.name, i]))
  const jointedIdx = geo.joints.map((j) => linkIndex.get(j.link)).filter((i): i is number => i !== undefined)
  const placeOnly = (indices: Iterable<number>): void => {
    if (aimLinks.length > 0) {
      placeLinks()
      return
    }
    for (const i of indices) {
      const grp = linkGroups.get(poseGeo.links[i]!.name)
      if (!grp) continue
      const b = rigLinkLocalPoseInto(localScratch, poseGeo, i, lastJoints, lastSubPoses, lastParams, lastIncline)
      grp.position.set(b[0]!, b[1]!, b[2]!)
      grp.quaternion.set(b[3]!, b[4]!, b[5]!, b[6]!)
    }
  }

  const applyJoints = (values: Record<string, number>): void => {
    // command every declared joint each call; an un-commanded joint returns to rest (position control).
    lastJoints = values
    // a rig with nothing a joint value can move: nothing to place (and no pose bump)
    if (geo.joints.length === 0 && aimLinks.length === 0) return
    placeOnly(jointedIdx)
    // repeat-value spam is gated upstream (the view's frame routing); a call that reached here moved links
    bumpPoseRev()
  }

  // An author edit moved a link's rest pose (a node drag, an Inspector field, an undo) without changing the rig's
  // structure, so the groups are re-posed in place rather than rebuilt: the edited geometry becomes the one
  // placeLinks resolves from, and the refresh that follows in `apply` lays it out with the params.
  const applyRestPose = (g2: Extract<PartPackage['geometry'], { kind: 'rig' }>): void => {
    poseGeo = g2
    if (poseBuf.length < g2.links.length * POSE_STRIDE) poseBuf = rigPoseBuffer(g2)
    for (const link of g2.links) linkByName.set(link.name, link)
    placeLinks()
    replaceLinkBanks()
  }

  // Runtime backstop to the static setSubPose read (poolableLink): a link this actually moves must not
  // be pooled, whatever the source scan concluded. The scan is a whole-string-literal match - the same
  // best-effort convention as the rename cascade - so an obfuscated/computed name can slip it; here the
  // move is a fact. Untag the subtree, hand back anything the pool had hidden (so the moving link draws
  // live from this tick), and bump structureVersion, which is the async-attach signal the view already
  // re-pools on. Once per link: after the first move nothing is left tagged.
  const unpooled = new Set<string>()
  const unpoolSubtree = (name: string, g: Group): void => {
    if (unpooled.has(name)) return
    unpooled.add(name)
    let found = false
    // the group tag is what keeps the link's instanced banks out (they need no opt-in to be ingested,
    // so untagging poolUnit alone would leave them merged - and frozen); the pool prunes the subtree
    g.userData.poolMobile = true
    g.traverse((o) => {
      if (o.userData.poolUnit === true) delete o.userData.poolUnit
      else if (o.userData.poolHidden !== true) return
      if (o.userData.poolHidden === true) {
        delete o.userData.poolHidden
        o.visible = true
      }
      found = true
    })
    if (found) bumpStructureVersion(root)
  }

  const applySubPoses = (subPoses: Record<string, SubPose>): void => {
    // free-form pose overrides: a subPose overrides the link's rest + joint pose (core's rule); one placeLinks
    let moved = false
    for (const name in subPoses) {
      const g = linkGroups.get(name)
      if (!g || !linkByName.has(name)) continue
      unpoolSubtree(name, g)
      moved = true
    }
    if (!moved) return
    lastSubPoses = { ...lastSubPoses, ...subPoses }
    placeOnly(Object.keys(subPoses).map((n) => linkIndex.get(n)).filter((i): i is number => i !== undefined))
    if (linkBanks.length > 0) replaceLinkBanks()
    bumpPoseRev()
  }

  // squash links: the driving lamp's frame.lamps signal also sets the compression target (0/1), eased toward
  // by the tick (below). The signal is a different link than the squash (the cups squash off the tool's LED).
  const squashLinks = meshArrayLinks.filter((e) => !!e.squash)
  // the behavior's per-tick lamp state (frame.lamps), routed here by the view while the sim runs. A geometry()
  // submesh can be a lamp too (MeshPart.lamps) - those register on the first refresh, after this is built, so a rig
  // whose script has geometry() and declares lamps gets the hook up front (the loop reads lampMats at call time).
  const procMayLight = partHasGeometry(pkg.behavior) && partDeclaredLamps(pkg.behavior).length > 0
  // A geometry() submesh can squash too (MeshPart.squash): registered by the procedural refresh, eased by procTick.
  const procSquashes: ProcSquash[] = []
  const applyLamps = lampMats.length || squashLinks.length || procMayLight
    ? (lamps: Record<string, boolean>): void => {
        for (const lm of lampMats) paintLamp(lm, lamps[lm.name] === true)
        for (const e of squashLinks) e.squash!.target = lamps[e.squash!.signal] === true ? 1 : 0
        for (const s of procSquashes) s.target = lamps[s.signal] === true ? 1 : 0
      }
    : undefined
  // idle lit-state (a lamp's `param`): a lamp bound to a boolean param shows that param whenever the behavior isn't
  // driving it - painted by refresh (place, param edit, sim stop), like the built-ins' authored lamps.
  const lampParamOf = new Map(geo.links.flatMap((l) => (l.lamps ?? []).flatMap((lamp) => (lamp.param ? [[lamp.name ?? l.name, lamp.param] as [string, string]] : []))))
  /** Repaint the caption plates. A live caption (`textFrom`, published by the behavior) is shown while it is being
   *  published, else the authored `textParam`/`text` - so a stopped scene reads as the engraved legend instead
   *  of going blank. Returns whether anything changed (the bundle-refresh signal). */
  const paintLabels = (params: RigParams): boolean => {
    let changed = false
    for (const lb of labels) {
      const live = lb.shape.textFrom !== undefined ? displayValues[lb.shape.textFrom] : undefined
      const raw = live !== undefined ? live : lb.shape.textParam !== undefined ? params[lb.shape.textParam] : lb.shape.text
      const text = raw === undefined || raw === null ? '' : String(raw)
      const shown = text !== ''
      const redraw = text !== lb.last
      if (redraw) {
        lb.last = text
        const col = lb.shape.color
        drawLabelText(lb.ctx, text, col ? `rgb(${Math.round(col[0] * 255)},${Math.round(col[1] * 255)},${Math.round(col[2] * 255)})` : '#000000')
        lb.tex.needsUpdate = true
      }
      const flipped = lb.mesh.visible !== shown
      lb.mesh.visible = shown
      // Only a visibility flip is structural: a recorded render bundle bakes which draws exist. New text is
      // not. The canvas keeps the size it was made with, so three re-uploads into the same GPU texture (no
      // new handle for a bundle to go stale on), and the upload goes out with the part's dirty mark (`changed`
      // → the view marks the part, whose walked draw uploads the texture). Bumping here would re-record every
      // bundle and re-sign the instance pools each time a counter ticks.
      if (flipped) bumpStructureVersion(root)
      if (redraw || flipped) changed = true
    }
    return changed
  }

  // The behavior's per-tick display values (frame.displays), routed here by the view while the sim runs.
  // Not a full refresh: a running panel would then re-derive guards, legs and roller grids sixty
  // times a second just to repaint a number. It repaints only the two surfaces that read displays, off the
  // params the last real refresh already resolved.
  const applyDisplays = labels.some((l) => l.shape.textFrom !== undefined)
    ? (displays: Record<string, number | boolean | string>): boolean => {
        displayValues = displays
        return paintLabels(lastParams)
      }
    : undefined


  // roller spin: each 'roller'-finish material's brushed grain sweeps around the cylinder from the part's `speed`
  // (the built-in's rollerSpinTick), so an SDK roller bed animates like the built-in. rollerSpeed/-SpinRadius
  // are refreshed from the instance params; the no-slip rate is speed / rendered radius (rigRollerSpinRadius) -
  // the class radius for roller-GLB links, not the GLB's native 0.12 m (which would spin ~5× slow).
  let rollerSpeed = 0
  let liveRollerSpeed: number | null = null // frame-routed effective speed (m/s) while running; null = use the param
  let rollerSpinRadius = rigRollerSpinRadius(geo, resolvePartParams(paramSpecs, {}) as RigParams)
  const spinTicks = rollerMats.map((m) => rollerSpinTick(m, () => ({ speed: liveRollerSpeed ?? rollerSpeed, radius: rollerSpinRadius })))
  const rollerTick = spinTicks.length
    ? (dt: number, running: boolean): boolean => {
        if (!running) liveRollerSpeed = null // a stale live speed must not outlive the run
        let mutated = false
        for (const t of spinTicks) if (t(dt, running)) mutated = true
        return mutated
      }
    : undefined
  // squash ease: each frame draw `cur` toward its lamp target (0 while the sim is stopped, so a cup
  // relaxes on Stop) with a frame-rate-independent exponential, re-laying the clones when it moves.
  const squashTick = squashLinks.length
    ? (dt: number, running: boolean): boolean => {
        const k = 1 - Math.exp(-dt / SQUASH_TAU)
        let moved = false
        for (const e of squashLinks) {
          const s = e.squash!
          const target = running ? s.target : 0
          if (s.cur === target) continue
          s.cur += (target - s.cur) * k
          if (Math.abs(target - s.cur) < 1e-3) s.cur = target
          applyMeshSquash(e)
          moved = true
        }
        if (moved) bumpPoseRev() // the ease moved clone transforms (incl. the Stop-relax on a frozen part)
        return moved
      }
    : undefined
  // ---- geometry() animation channels: MeshPart.scroll (a texture moving along its U) and MeshPart.spin (a submesh
  // turning about an axis). A channel's speed is a reported value while the sim runs (applyValues: ctx.report, the
  // number the Inspector's live readout shows), so a program-commanded speed drives it; otherwise the part's param
  // of that name. The procedural refresh registers the channels as it emits the submeshes; the hook they run in has
  // to exist from the start, so it is built whenever the script's geometry() animates at its default params.
  const procMayAnimate = partHasGeometry(pkg.behavior) && geometryAnimates(pkg.behavior, paramSpecs)
  let liveValues: Record<string, number | boolean> | null = null
  let procResolved: Record<string, ParamValue> = {}
  // a scroll/spin channel names the param that turns it; left out, it is the conveyor's declared speed param
  // (conveyor.speedParam). A part that is no conveyor must name it (validatePart refuses one that doesn't), so
  // its empty key here only ever reads 0.
  const conveyorSpeedKey = pkg.conveyor?.speedParam
  const channelKey = (named: string | undefined): string => named ?? conveyorSpeedKey ?? ''
  const channelSpeed = (key: string): number => {
    if (key === '') return 0
    const live = liveValues?.[key]
    if (typeof live === 'number') return live
    const p = procResolved[key]
    return typeof p === 'number' ? p : 0
  }
  const procScrolls: { tex: Texture; src: Texture; srcVersion: number; tilesPerMeter: number; speed: string }[] = []
  const procSpins: { mesh: Mesh; axis: Vector3; center: Vector3; radius: number; speed: string; angle: number }[] = []
  const procBankSpins: BankSpin[] = [] // MeshPart.spin on an instanced bank: its material turns (bankSpin.ts)
  const procTick = procMayAnimate
    ? (dt: number, running: boolean): boolean => {
        if (!running) liveValues = null // a stale reported speed must not outlive the run
        let scrolled = false
        for (const sc of procScrolls) {
          // the shared texture decoded after this part's copy was made: the copy shares its image, but only the
          // copy's own version makes the renderer upload it
          if (sc.src.version !== sc.srcVersion) {
            sc.srcVersion = sc.src.version
            if (sc.src.image) sc.tex.needsUpdate = true // never flag an upload before there is an image to upload
          }
          if (!running) continue
          const v = channelSpeed(sc.speed)
          if (v === 0) continue
          sc.tex.offset.x = (sc.tex.offset.x - v * sc.tilesPerMeter * dt) % 1 // the pattern moves toward +U
          scrolled = true
        }
        // the scroll uses the shared tick uniform group on WebGPU (scrollNodeMaterial.ts): a direct upload, no mark
        if (scrolled) markTickUniformsAdvanced()
        let spun = false
        if (running) {
          for (const sp of procSpins) {
            const v = channelSpeed(sp.speed)
            if (v === 0 || sp.radius <= 0) continue
            sp.angle = (sp.angle + (v / sp.radius) * dt) % (Math.PI * 2)
            _spinQ.setFromAxisAngle(sp.axis, sp.angle)
            sp.mesh.quaternion.copy(_spinQ)
            // turn about `center`, not the mesh origin: p' = q(p - c) + c, so the mesh sits at c - q c
            sp.mesh.position.copy(sp.center).sub(_spinV.copy(sp.center).applyQuaternion(_spinQ))
            spun = true
          }
        }
        // squash ease, the mesh links' rule (squashTick): toward the lamp while running, relaxed when stopped
        let squashed = false
        const k = 1 - Math.exp(-dt / SQUASH_TAU)
        for (const s of procSquashes) {
          const target = running ? s.target : 0
          if (s.cur === target) continue
          s.cur += (target - s.cur) * k
          if (Math.abs(target - s.cur) < 1e-3) s.cur = target
          applyProcSquash(s)
          squashed = true
        }
        if (spun || squashed) bumpPoseRev()
        // a spinning bank turns its material's spin uniform, which rides the shared tick group: no pose, no mark
        if (running && advanceBankSpins(procBankSpins, channelSpeed, dt)) markTickUniformsAdvanced()
        return spun || squashed
      }
    : undefined
  const tick = rollerTick || squashTick || procTick
    ? (dt: number, running: boolean): boolean => {
        // no short-circuit: every sub-tick must run each frame; OR their mutation reports
        let mutated = false
        if (rollerTick?.(dt, running)) mutated = true
        if (squashTick?.(dt, running)) mutated = true
        if (procTick?.(dt, running)) mutated = true
        return mutated
      }
    : undefined

  const gizmo = buildRigGizmo(geo, root, linkGroups, applyJoints, paramSpecs)
  // the authored idle pose: a `pose` numberList param whose first row is [j1..j6] degrees (posable-joint
  // order; cosmetic self-driven joints are not in the row) → the rig's at-rest pose. Only an array is valid,
  // matching the numberList grid the Inspector edits; a legacy JSON string is ignored.
  const applyIdlePose = gizmo
    ? (poseParam: unknown): void => {
        const idle: Record<string, number> = {}
        const row = Array.isArray(poseParam) && Array.isArray(poseParam[0]) ? (poseParam[0] as unknown[]) : undefined
        if (row) posableJoints(geo).forEach((j, i) => { const d = row[i]; if (typeof d === 'number') idle[j.name] = (d * Math.PI) / 180 })
        gizmo.applyIdle(idle)
      }
    : undefined

  // ---- procedural rig-link geometry (MeshPart.link) ---------------------------------------------------------
  // A rig can be dressed by the part's geometry() output: each emitted MeshPart is realized into the group of
  // the rig link named by MeshPart.link (so it follows that link's joint/rest pose), or the rig root when
  // untagged. Collision still comes from the declarative link shapes (a `hidden` box = collision-only), so this
  // is render-only: the wire-mesh the built-in fence/gate draw over a solid barrier/leaf box. Each submesh's
  // material follows the same rules as the function tier (role / package material / a colorParam tint), so a
  // rig-dressed part looks identical to a function part. Lazy: a rig whose behavior declares no geometry()
  // does no work here (procDisabled latches after the first empty eval).
  const procRoleMat = (role: string): Material => {
    switch (role) {
      case 'frame': return railMaterial()
      case 'guard': return guardMaterial()
      case 'leg': return legMaterial()
      case 'bolt': return boltMaterial()
      case 'gapfill': return gapFillMaterial()
      case 'roller': return rollerMaterial()
      case 'belt': return createBeltSurface().material
      case 'deck': return deckTriplanarMaterial('deck')
      case 'tread': return deckTriplanarMaterial('tread')
      default: return FN_NEUTRAL()
    }
  }
  const procPkgMat = (id: string): Material => {
    const ref = materials.find((m) => m.id === id)
    return ref ? buildMaterial(ref, assets) : FN_NEUTRAL()
  }
  const procShared = new Map<string, Material>() // shared role/package materials (untinted submeshes)
  const procTintMats: { mat: MeshStandardMaterial; param: string; lamp?: LampMat }[] = []
  const procLampByName = new Map<string, MeshStandardMaterial>() // MeshPart.lamp: one material per lamp name
  const procTintByKey = new Map<string, MeshStandardMaterial>()
  const procScrollByKey = new Map<string, Material>() // MeshPart.scroll: one moving copy per (material, rate, speed)
  // DoubleSide variants for procedural rig submeshes (MeshPart.doubleSided) - own clone per base, like the
  // function tier; keeps shared role materials single-sided for the other links.
  const procDblVariants = new Map<Material, Material>()
  const asDoubleProc = (base: Material): Material => {
    let d = procDblVariants.get(base)
    if (!d) { d = base.clone(); d.side = DoubleSide; procDblVariants.set(base, d); allMaterials.push(d) }
    return d
  }
  const procBankSpinByKey = new Map<string, Material>() // spinning banks: one turning material per (material, radius, speed, sense)
  const procMatFor = (part: MeshPart): Material => {
    if (part.spin && part.instances) {
      // a spinning bank: its own material, whose object-space grain the tick turns about each instance's local Z
      // (bankSpin.ts). Shared by the banks that spin alike (a roller bed's bodies and its axle stubs).
      const sign = bankSpinSign(part.spin.axis)
      const speed = channelKey(part.spin.speed)
      const key = `${part.material ?? part.finish ?? 'mesh'}\0${part.spin.radius}\0${speed}\0${sign ?? 0}`
      let m = procBankSpinByKey.get(key)
      if (!m) {
        m = part.material ? procPkgMat(part.material) : procRoleMat(part.finish ?? 'mesh')
        const uniform = spinUniformOf(m)
        if (uniform && sign !== null) procBankSpins.push({ uniform, radius: part.spin.radius, speed, sign, angle: 0 })
        procBankSpinByKey.set(key, m)
        allMaterials.push(m)
      }
      return m
    }
    if (part.scroll) {
      // its own material over its own copy of the albedo (the package texture is shared by every part that uses
      // it), whose offset the tick moves. On WebGPU a node material samples through live offset uniforms
      // (scrollMaterial), since three never re-uploads a plain material's uv transform there.
      const speed = channelKey(part.scroll.speed)
      const key = `${part.material ?? part.finish ?? 'mesh'}\0${part.scroll.tilesPerMeter}\0${speed}`
      let m = procScrollByKey.get(key)
      if (!m) {
        const base = (part.material ? procPkgMat(part.material) : procRoleMat(part.finish ?? 'mesh').clone()) as MeshStandardMaterial
        if (base.map) {
          const tex = base.map.clone()
          tex.wrapS = RepeatWrapping
          tex.wrapT = RepeatWrapping
          // A URL texture is still loading when the part builds, and Texture.clone() (copy) flags the copy for upload
          // regardless, an upload with no image, which the renderer throws on. Hold it at version 0 (nothing to upload)
          // until there is an image; the tick flags it when the original's version moves.
          if (!base.map.image) tex.version = 0
          scrollTexClones.push(tex)
          m = scrollMaterial(base, tex)
          procScrolls.push({ tex, src: base.map, srcVersion: base.map.version, tilesPerMeter: part.scroll.tilesPerMeter, speed })
        } else {
          m = base // no texture: nothing to move, but still its own instance
        }
        procScrollByKey.set(key, m)
        allMaterials.push(m)
      }
      return m
    }
    const lamp = part.lamps?.[0]
    if (lamp) {
      // a lamp submesh: its own material, painted per tick by applyLamps (dark = its offColor else the material's
      // colour, lit = the emissive glow); a colorParam sets both, as it does for a mesh link's lamp
      let m = procLampByName.get(lamp.name)
      if (!m) {
        const base = part.material ? procPkgMat(part.material) : procRoleMat(part.finish ?? 'mesh')
        m = (part.material ? base : base.clone()) as MeshStandardMaterial // finish materials are shared singletons
        if (lamp.offColor) m.color.setRGB(lamp.offColor[0], lamp.offColor[1], lamp.offColor[2])
        const e = lamp.emissive
        const lm: LampMat = { name: lamp.name, mat: m, color: new Color(e[0], e[1], e[2]), off: m.color.clone(), ...(lamp.opacity !== undefined ? { opacity: lamp.opacity } : {}) }
        lampMats.push(lm)
        if (part.colorParam) procTintMats.push({ mat: m, param: part.colorParam, lamp: lm })
        procLampByName.set(lamp.name, m)
        allMaterials.push(m)
      }
      return m
    }
    if (part.colorParam) {
      // a tinted submesh gets its own material instance (shared role/pkg materials must not be repainted),
      // identity-stable across refreshes so a colour edit re-tints in place instead of rebuilding the mesh
      const key = `${part.material ?? part.finish ?? 'mesh'}\0${part.colorParam}`
      let m = procTintByKey.get(key)
      if (!m) {
        m = (part.material ? procPkgMat(part.material) : procRoleMat(part.finish ?? 'mesh')) as MeshStandardMaterial
        procTintByKey.set(key, m)
        procTintMats.push({ mat: m, param: part.colorParam })
        allMaterials.push(m)
      }
      return m
    }
    const key = part.material ? `m:${part.material}` : `r:${part.finish ?? 'mesh'}`
    let m = procShared.get(key)
    if (!m) {
      m = part.material ? procPkgMat(part.material) : procRoleMat(part.finish ?? 'mesh')
      procShared.set(key, m)
      allMaterials.push(m)
    }
    return m
  }
  // one realized submesh per emitted MeshPart (stable emit order), holding its target group + desc + material so
  // a refresh reuses the slot when none changed - only a target/role/geometry change re-realizes (a colour edit
  // keeps every mesh and just repaints, exactly like buildFunctionMesh).
  const procSlots: { group: Group; mesh: Mesh; desc: MeshDescription; mat: Material }[] = []
  // MeshPart.instances banks: one InstancedMesh per emitted bank (stable emit order among the banks), the function
  // tier's realization (instancedTemplate.ts) hung on the bank's link group
  const procBanks: { group: Group; mesh: InstancedMesh; desc: MeshDescription; mat: Material }[] = []
  let procKey = '' // last (behavior-source + resolved-params) key; re-emit only when it changes
  let procDisabled = false
  /** returns whether it actually removed anything (a draw-list change - see the bump below) */
  const clearProcSlots = (): boolean => {
    if (procSlots.length === 0 && procBanks.length === 0) return false
    // Retire, never dispose: a recorded render bundle holds this geometry's actual GPUBuffers, and
    // freeing them here would blank the whole main pass on replay. gpuRetire.ts holds each one
    // until a re-record has been requested and has run. The same applies to every procedural re-emit below,
    // since a resize drag runs this on every pointer-move.
    for (const s of procSlots) { s.group.remove(s.mesh); retireGeometry(s.mesh.geometry) }
    procSlots.length = 0
    for (const b of procBanks) { b.group.remove(b.mesh); retireInstancedMesh(b.mesh) }
    procBanks.length = 0
    return true
  }
  const realizeProceduralGeometry = (p: SdkPart, ctx: GeometryContext): void => {
    if (procDisabled) return
    const source = getPackage(p.packageId)?.behavior ?? pkg.behavior // fresh source so a geometry() hot-reload takes effect
    const resolved = resolvePartParams(paramSpecs, p.params as Record<string, ParamValue>)
    procResolved = resolved // the channels' fallback speed while no run reports one
    // The seam context is an input to geometry(), so every field of it belongs in the re-emit key alongside the
    // params. Otherwise a bed that slides along its own axis keeps the plate its old grid phase implied. Keyed
    // on the grid's endpoints + count (an arithmetic world-phase sequence, so those pin the whole array) and
    // the butt flags. The first refresh of a part runs before the scene resolve hands the rig its grid, so the
    // butt flags are the only thing that changes on the pass that learns the bed has a neighbour. Without them
    // that pass early-outs on an unchanged key and the seam geometry never appears. A part with no
    // world-phase bank contributes nothing here and keeps its param-only key, so nothing else re-emits more often.
    const d = ctx.deltas
    const b = ctx.butt
    const gridKey = d && d.length > 0 ? `${ctx.pitch ?? 0}|${d[0]![0]}|${d[d.length - 1]![0]}|${d.length}|${b?.head ? 1 : 0}${b?.tail ? 1 : 0}` : ''
    const key = `${source}\0${JSON.stringify(resolved)}\0${gridKey}`
    if (key === procKey) return
    procKey = key
    const emitted = evalPartGeometry(source, resolved, { partId: p.id, packageId: pkg.id }, ctx)
    // drop any meshes; latch off only when the part declares no geometry() at all. A geometry() that emitted
    // nothing for this param set (e.g. the transfer plate on a straight bed) must stay live so a later skew re-emits.
    if (!emitted) {
      if (clearProcSlots()) bumpStructureVersion(root)
      procDisabled = !partHasGeometry(source)
      return
    }
    const drawn = emitted.filter((mp) => mp.desc.positions.length > 0) // drop empty descs (render-only roller banks)
    const parts = drawn.filter((mp) => mp.instances === undefined)
    const bankParts = drawn.filter((mp) => mp.instances !== undefined)
    // adding / swapping / dropping a submesh is a draw-list change; an unchanged slot is not (see the bump below)
    let structural = false
    // instanced banks first (their materials are minted by procMatFor like any submesh's). Reuse a slot when the
    // template, material and link are unchanged and the count still fits its buffer: only the transforms rewrite,
    // which a recorded bundle replays. A bank's count is baked into the recorded draw, so a count change is
    // structural; a new template or an outgrown buffer mints a fresh mesh.
    for (let i = 0; i < bankParts.length; i++) {
      const part = bankParts[i]!
      const insts = part.instances!
      const group = (part.link ? linkGroups.get(part.link) : undefined) ?? root
      let mat = procMatFor(part)
      if (part.doubleSided) {
        if (part.lamps?.length || part.colorParam || part.scroll || part.spin) mat.side = DoubleSide
        else mat = asDoubleProc(mat)
      }
      const slot = procBanks[i]
      if (slot && slot.group === group && slot.mat === mat && descEqual(slot.desc, part.desc) && insts.length <= slot.mesh.instanceMatrix.count) {
        // a bed sliding along its world grid gains and loses a roller as it goes: hold the drawn count (see there)
        if (writeInstanceMatricesHeld(slot.mesh, insts)) structural = true
        continue
      }
      structural = true
      if (slot) { slot.group.remove(slot.mesh); retireInstancedMesh(slot.mesh) }
      const mesh = realizeInstancedTemplate(part.desc, insts, mat)
      if (part.castShadow === false) mesh.castShadow = false
      group.add(mesh)
      procBanks[i] = { group, mesh, desc: part.desc, mat }
    }
    for (let i = procBanks.length - 1; i >= bankParts.length; i--) {
      const b = procBanks.pop()!
      b.group.remove(b.mesh); retireInstancedMesh(b.mesh)
      structural = true
    }
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      const group = (part.link ? linkGroups.get(part.link) : undefined) ?? root
      let mat = procMatFor(part)
      // A lamp or tinted submesh already has its own material, and that instance is the one painted and retinted:
      // a double-sided clone of it would be what renders, and would never see the paint. Flip its side instead.
      if (part.doubleSided) {
        if (part.lamps?.length || part.colorParam || part.scroll) mat.side = DoubleSide
        else mat = asDoubleProc(mat)
      }
      const slot = procSlots[i]
      if (slot && slot.group === group && slot.mat === mat && descEqual(slot.desc, part.desc)) continue
      // Recycle first: a resize drag re-emits this on every pointer-move, and the usual re-emit is the
      // same topology at new coordinates. Rewriting the existing buffers frees nothing (so nothing can
      // be freed under a live recording) and keeps the recorded draw valid, so it needs no re-record
      // either - only a genuine topology change falls through to the swap (gpuRetire.ts).
      if (slot && slot.group === group && slot.mat === mat && rewriteMeshDescription(slot.mesh.geometry, part.desc)) {
        slot.desc = part.desc
        continue
      }
      structural = true
      if (slot) { slot.group.remove(slot.mesh); retireGeometry(slot.mesh.geometry) }
      const mesh = shadowMesh(realizeMeshDescription(part.desc), mat, part.castShadow !== false)
      // the pilot collides against this render mesh; let it build a tree when it does (bvh.ts)
      markLazyColliderBVH(mesh)
      group.add(mesh)
      procSlots[i] = { group, mesh, desc: part.desc, mat }
    }
    for (let i = procSlots.length - 1; i >= parts.length; i--) {
      const s = procSlots.pop()!
      s.group.remove(s.mesh); retireGeometry(s.mesh.geometry)
      structural = true
    }
    // spin channels: which slot meshes turn, and about what. Re-registered on every emit; a mesh keeps its angle,
    // and one that stopped spinning (its part changed) goes back to rest.
    const prevAngle = new Map(procSpins.map((sp) => [sp.mesh, sp.angle] as const))
    procSpins.length = 0
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!, mesh = procSlots[i]!.mesh
      if (part.spin) {
        const ax = new Vector3(part.spin.axis[0], part.spin.axis[1], part.spin.axis[2])
        if (ax.lengthSq() > 0) {
          const c = part.spin.center ?? [0, 0, 0]
          procSpins.push({ mesh, axis: ax.normalize(), center: new Vector3(c[0], c[1], c[2]), radius: part.spin.radius, speed: channelKey(part.spin.speed), angle: prevAngle.get(mesh) ?? 0 })
          continue
        }
      }
      if (prevAngle.has(mesh)) { mesh.quaternion.identity(); mesh.position.set(0, 0, 0) }
    }
    // squash channels: re-registered on every emit like the spins, a reused mesh keeping how far it is compressed (a
    // lit vacuum stays squashed across a resize). The anchor is the mesh's lowest point in its link's frame, which an
    // InstancedMesh's box measures across every instance. The pool must not bake a copy of a mesh that changes size.
    const prevSquash = new Map(procSquashes.map((s) => [s.mesh, s] as const))
    procSquashes.length = 0
    const squashed = [
      ...bankParts.map((part, i) => ({ part, mesh: procBanks[i]!.mesh as Mesh, bank: procBanks[i]!.mesh as InstancedMesh | null })),
      ...parts.map((part, i) => ({ part, mesh: procSlots[i]!.mesh, bank: null })),
    ]
    for (const { part, mesh, bank } of squashed) {
      const was = prevSquash.get(mesh)
      if (!part.squash || part.spin) {
        if (was) { mesh.scale.y = 1; mesh.position.y = 0; delete mesh.userData.poolMobile }
        continue
      }
      let minY: number | undefined
      if (bank) { bank.computeBoundingBox(); minY = bank.boundingBox?.min.y }
      else { mesh.geometry.computeBoundingBox(); minY = mesh.geometry.boundingBox?.min.y }
      const s: ProcSquash = { mesh, frac: part.squash.amount, signal: part.squash.lamp, anchorY: minY !== undefined && Number.isFinite(minY) ? minY : 0, cur: was?.cur ?? 0, target: was?.target ?? 0 }
      mesh.userData.poolMobile = true
      applyProcSquash(s)
      procSquashes.push(s)
    }
    // Pool opt-in, the function tier's rule (functionMesh.ts): identical dressing on identical parts (three racks,
    // two push buttons) merges in the scene-global pool, which matches by geometry content and folds each
    // source's geometry version into its bake, so the in-place rewrite above stays coherent. A submesh riding a
    // moving link is still kept live by that link's `poolMobile`. Out: a lamp (its material is painted per
    // tick) and the belt fabric (its own material, scrolled in place).
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      // ...and an animated one (MeshPart.scroll/spin): its texture or pose moves per part, which a merged copy can't
      if (part.lamps?.length || part.finish === 'belt' || part.scroll || part.spin || part.squash) delete procSlots[i]!.mesh.userData.poolUnit
      else procSlots[i]!.mesh.userData.poolUnit = true
    }
    // re-apply each colorParam tint from the resolved value (materials are identity-stable → in-place repaint)
    let repainted = false
    for (const t of procTintMats) {
      const v = resolved[t.param]
      if (typeof v === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) {
        const before = t.mat.color.getHex()
        if (t.lamp) {
          // a lamp: retint the unlit base and the glow, then repaint in its current state (lit keeps glowing)
          t.lamp.off.set(v.slice(0, 7))
          t.lamp.color.set(v.slice(0, 7))
          paintLamp(t.lamp, t.mat.emissiveIntensity > 0)
        } else {
          t.mat.color.set(v.slice(0, 7))
        }
        if (t.mat.color.getHex() !== before) repainted = true
      }
    }
    // A repaint moves render identity without moving the draw list: the bundle keeps drawing the right
    // pixels (same material object) and must not be re-recorded, but instancePool groups by a key that
    // includes colour, so its bake is stale. Hence the repaint epoch rather than a structural bump, and only
    // when a colour actually changed, so the common unchanged re-apply does nothing.
    if (repainted) bumpRepaintEpoch()
    // A recorded WebGPU render bundle bakes the draw list, so a mesh that entered/left/swapped here never
    // reaches the screen until something unrelated re-records (without the bump, the roller bed's skew transfer
    // plates would stay invisible after the edit that creates them; verify-roller-skew.mjs's live-edit check). Same rule (and
    // same seam) as the guard-split / deck-cut count changes below: bump the structural counter
    // view.syncBundleInvalidation polls. Only then: an unchanged re-emit (the common case, a param that
    // geometry() ignores) must not re-record, and a pure colorParam re-tint above is an in-place repaint,
    // not a draw-list change.
    if (structural) bumpStructureVersion(root)
  }

  return {
    materials: allMaterials,
    // C-paramgeo: reflow param-driven box sizes + link offsets when an instance param (e.g. width/length)
    // changes. Static rigs have neither, so this is a no-op for them (the rig is otherwise static at rest).
    refresh: (p: SdkPart, openings?: GuardOpenings, grid?: RollerGrid, extents?: GuardExtents, platformCut?: PlatformCut, legRests?: LegRestRows, holes?: GuardHoles): void => {
      // cache the belt/roller speed for the spin tick (before any early-out) so a static roller bed still spins
      const sp = conveyorSpeedKey !== undefined ? (p.params as Record<string, unknown>)[conveyorSpeedKey] : undefined
      rollerSpeed = typeof sp === 'number' ? sp : 0
      // keep the spin radius tracking a radius-parametric roller cylinder (default-resolved like the speed)
      if (spinTicks.length > 0) rollerSpinRadius = rigRollerSpinRadius(geo, resolvePartParams(paramSpecs, p.params as Record<string, ParamValue>) as RigParams)
      // cache the beam draw params + paint idle param-bound lamps (also before the early-out - a static
      // sensor/beacon rig has no param-driven links). Default-resolved, so a sparse instance (all defaults)
      // still shows the beam at its range param's default / its default-lit lamps.
      if (beamVisuals.length > 0 || lampParamOf.size > 0 || colorParamMats.length > 0 || showParamLinks.length > 0) {
        const rp = resolvePartParams(paramSpecs, p.params as Record<string, ParamValue>)
        if (beamVisuals.length > 0) {
          for (const bv of beamVisuals) {
            const v = bv.rangeParam !== undefined ? rp[bv.rangeParam] : undefined
            bv.paramRange = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
            bv.shown = bv.showParam === undefined || rp[bv.showParam] !== false
          }
        }
        // param-gated structural links: show the group unless its boolean param resolves false (the sim drops
        // the matching collision body). A hidden (author-eye) link stays hidden regardless.
        // A flip is a draw-list change (same rule as the guard-split/deck-cut counts below), so it must bump
        // the structural counter the view's bundle invalidation polls. Turning a side guard off re-records by
        // side effect: dropping the guard mesh from the instance pool fails tryUpdateParts' membership check and
        // forces a full poolRebuild, which notifies. Turning it back on has no such side effect (the mesh is no
        // longer a recorded member), so without the bump the bundle keeps replaying the hidden list and the
        // guard never comes back.
        for (const sp of showParamLinks) {
          if (sp.group.userData.authorHidden) continue
          const want = rp[sp.param] !== false
          if (sp.group.visible === want) continue
          sp.group.visible = want
          bumpStructureVersion(root)
        }
        for (const lm of lampMats) {
          const key = lampParamOf.get(lm.name)
          if (key !== undefined) paintLamp(lm, rp[key] === true)
        }
        // C-paramgeo colour: repaint each colorParam link from its (default-resolved) hex, read as sRGB so a
        // `#f2bd0f` default matches the built-in's linear steel. Runs before the param-geo early-out, so a
        // purely-static barrier (colours but no reflow) still re-tints.
        for (const cm of colorParamMats) {
          const v = rp[cm.param]
          // 8-digit #rrggbbaa (an alpha:true param) → strip alpha for the RGB-only .color.set
          if (typeof v === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) {
            if (cm.lamp) {
              // a mesh lamp: retint the unlit base and the lit colour, then repaint in the lamp's current state
              // (read from the material - lit mid-run keeps glowing in the new colour, off recolours the cap)
              cm.lamp.off.set(v.slice(0, 7))
              cm.lamp.color.set(v.slice(0, 7))
              paintLamp(cm.lamp, cm.lamp.mat.emissiveIntensity > 0)
            } else {
              cm.mat.color.set(v.slice(0, 7))
            }
          }
        }
      }
      // rigSize handles: keep the dots + tool outline at the resolved param values (default-resolved, so a
      // sparse instance shows the package defaults; streamed transient params track a live gizmo drag)
      gizmo?.setSizes?.(resolvePartParams(paramSpecs, p.params as Record<string, ParamValue>))
      const params = p.params as RigParams
      // Pass the part placement as the seam so world-phase beds (roller grids) align across butted parts;
      // the centred default ignores it (docs/seam-resolvers.md).
      const seam = { worldPos: p.position, worldRotY: p.rotationY, anchor: grid?.anchor }
      // Resolve the world-phase bed grid for geometry() (GeometryContext): the rollers and the plates that fill
      // between them are authored against this one array, so they cannot disagree about where a roller sits.
      // `butt` comes straight off the resolved grid: the edge nudge is suppressed exactly where the end abuts
      // a collinear roller neighbour, which is the same question "does my end geometry meet anything?" asks.
      // The grid is declared by a link that draws nothing - an arrayed `frame` - for a bed whose rollers its own
      // geometry() draws: the grid is the host's (it spans butted parts), the rollers are the part's.
      const bedArray = geo.links.find((l) => l.array?.distribute?.worldPhase)?.array
      const bedDeltas = bedArray ? arrayInstanceDeltas(bedArray, params, seam) : null
      const geoCtx: GeometryContext = bedDeltas
        ? { deltas: bedDeltas, pitch: bedArray!.distribute!.maxSpacing, butt: { head: grid ? !grid.nudgeHi : false, tail: grid ? !grid.nudgeLo : false } }
        : {}
      // (re)emit the behavior's geometry() into the rig links (MeshPart.link) - before the param-geo early-out,
      // so a purely-static procedural rig (a fence: dressing only, no param-driven primitive links) still draws.
      realizeProceduralGeometry(p, geoCtx)
      if (paramBoxes.length === 0 && guardSplitLinks.length === 0 && deckCutLinks.length === 0 && paramCylinders.length === 0 && !paramPose && instancedArrayLinks.length === 0 && legLinks.length === 0 && meshArrayLinks.length === 0 && paramMeshes.length === 0 && labels.length === 0) return
      // C-label: redraw each text plane from its static text or its (Inspector-editable) param value.
      //
      // A changed caption can invalidate the render bundle. Without a re-record every label is invisible under
      // WebGPU while WebGL shows it (headless gates and shots run WebGL, so they don't catch it). A label is
      // built with an empty canvas and `visible = false`, because the text only arrives on the first refresh.
      // At record time the plane is either out of the draw list or bound to a blank texture, and the replay
      // keeps showing that: the plate renders as a bare white rectangle. `?nobundle` shows the text.
      //
      // So the `visible` flip (the first non-empty caption, or back to empty) re-records: paintLabels bumps
      // structure for it. A later retype is not structural: the canvas keeps its size, three re-uploads into
      // the same GPU texture, and the edit's syncScene marks the part so the replay walks its draw and uploads
      // it. (Checked on WebGPU: an Inspector-style retype and a live `textFrom` counter both reach the screen
      // with no re-record.)
      paintLabels(params)
      for (const pb of paramBoxes) {
        const sz = resolvedBoxSize(pb.size, pb.sizeParams, params)
        pb.mesh.scale.set(sz[0], sz[1], sz[2])
      }
      // splittable side guards/frames: rebuild each into the kept segments of its span. The span defaults to
      // the full length (centre-origin ±L/2); the part's own snap extents override an end (a flush side-merge
      // retracts the mover's rails to the host wall plane - guardExtents). Guards additionally lose the
      // host-computed openings on their side; frames never do (the host frame never opens).
      // No openings/extents ⇒ one child at full length (identical to a plain param box). The child pool
      // grows/shrinks to one box per kept segment; each is scaled to the segment length and centred on it.
      // The link group already carries the incline tilt + ±width offset, so children ride it.
      for (const gs of guardSplitLinks) {
        const sz = resolvedBoxSize(gs.size, gs.sizeParams, params)
        const half = sz[0] / 2
        const backX = (gs.side === 'left' ? extents?.leftBack : extents?.rightBack) ?? -half
        const frontX = (gs.side === 'left' ? extents?.leftFront : extents?.rightFront) ?? half
        const open = gs.frame ? [] : ((gs.side === 'left' ? openings?.left : openings?.right) ?? [])
        // sensor-beam holes: only a guard sheet holds one - a link whose height spans the hole's disc (the thin
        // top return above it stays whole) - and only inside the span it keeps after openings and extents
        const y0 = gs.offsetY - sz[1] / 2, y1 = gs.offsetY + sz[1] / 2
        const sideHoles = gs.frame ? [] : ((gs.side === 'left' ? holes?.left : holes?.right) ?? [])
        const panelHoles = sideHoles.filter(([hx, hy]) => hy - GUARD_HOLE_RADIUS >= y0 && hy + GUARD_HOLE_RADIUS <= y1
          && keptSegments(backX, frontX, open).some(([lo, hi]) => hx - GUARD_HOLE_PANEL / 2 >= lo && hx + GUARD_HOLE_PANEL / 2 <= hi))
        const segs = keptSegments(backX, frontX, [...open, ...panelHoles.map(([hx]): [number, number] => [hx - GUARD_HOLE_PANEL / 2, hx + GUARD_HOLE_PANEL / 2])])
        const proto = gs.children[0]!
        const before = gs.children.length + gs.panels.length + gs.wedges.length
        while (gs.panels.length < panelHoles.length) {
          const panel = new Mesh(unitBox, gs.mat)
          panel.castShadow = proto.castShadow
          panel.receiveShadow = proto.receiveShadow
          panel.userData.guardHolePanel = true // gates count the holes a guard actually draws
          // pool like the sheet it replaces: every panel cut at one hole height, scene-wide, shares one geometry,
          // so the instance pool draws them all as one bank instead of a draw per hole
          if (proto.userData.poolUnit === true) panel.userData.poolUnit = true
          gs.group.add(panel)
          gs.panels.push(panel)
        }
        while (gs.panels.length > panelHoles.length) gs.group.remove(gs.panels.pop()!)
        let panelGeometryChanged = false
        for (let i = 0; i < panelHoles.length; i++) {
          const [hx, hy] = panelHoles[i]!
          const panel = gs.panels[i]!
          // the plate is built in the link's frame: y about its centre, z from 0 through its thickness
          const geom = guardHolePanelGeometry(y0 - gs.offsetY, y1 - gs.offsetY, hy - gs.offsetY, sz[2])
          if (panel.geometry !== geom) { panel.geometry = geom; panelGeometryChanged = true }
          panel.position.set(hx, 0, -sz[2] / 2)
        }
        while (gs.children.length < segs.length) {
          const extra = new Mesh(unitBox, gs.mat)
          extra.castShadow = proto.castShadow
          extra.receiveShadow = proto.receiveShadow
          // a split piece is the same unit box as the first, so it pools with it (and every other guard in the scene);
          // untagged, each piece a hole or an opening split off would be a draw of its own
          if (proto.userData.poolUnit === true) extra.userData.poolUnit = true
          gs.group.add(extra)
          gs.children.push(extra)
        }
        for (let i = gs.children.length - 1; i >= Math.max(segs.length, 1); i--) {
          gs.group.remove(gs.children[i]!)
          gs.children.pop()
        }
        // a guard fully covered by openings (segs empty) collapses its one remaining child to nothing
        if (segs.length === 0) gs.children[0]!.scale.set(0, 0, 0)
        // Cut ends where this part meets another conveyor. A guard end is mitred on the plane the two guards share
        // (core/guardExtents.ts GuardMitre: the host's mitres come with its openings, a mover's with its extents). A mover's
        // frame rail end is cut to fit against the host's frame, which stays whole (GuardExtents.railCuts): the wall on
        // the host's outer wall face, the top flange a flange width further out. Either way the cut is a line across
        // this link's band, d0..d1 out from the guard line, at `c` along the bed per metre out: the box stops square
        // where the cut is deepest, and a wedge carries it out to the cut from the face where it reaches furthest.
        const cuts = gs.frame ? extents?.railCuts : (openings?.mitres ?? extents?.mitres)
        const cutOf = (x: number): number | null => (gs.frame
          ? cutAt(extents?.railCuts, gs.side, x)
          : mitreAt(openings?.mitres, gs.side, x) || mitreAt(extents?.mitres, gs.side, x) || null)
        // the link as it is now (an author edit may have moved it since the build), not the build-time copy
        const nowLink = linkByName.get(gs.link.name) ?? gs.link
        const linkZ = cuts ? resolvedOffset(nowLink.offset, nowLink.offsetParams, params)[2] : 0
        const out = linkZ < 0 ? -1 : 1 // outward is away from the bed centreline
        const d0 = cuts ? Math.abs(linkZ) - sz[2] / 2 - cuts.inner : 0
        const d1 = d0 + sz[2]
        const flangeOffset = (c: number) => (gs.frame && d0 >= -1e-4 ? railFlangeOffset(c) : 0) // the top flange band
        const pull = (c: number | null) => (c === null ? 0 : Math.max(c * d0, c * d1) + flangeOffset(c))
        const wedgeAt: { x: number; hi: boolean; c: number }[] = []
        for (let i = 0; i < segs.length; i++) {
          let [lo, hi] = segs[i]!
          if (cuts) {
            const cLo = cutOf(lo), cHi = cutOf(hi)
            if ((cLo !== null || cHi !== null) && hi - lo > pull(cLo) + pull(cHi)) {
              if (cLo !== null) {
                lo += pull(cLo)
                if (Math.abs(cLo) > 1e-6) wedgeAt.push({ x: lo, hi: false, c: cLo })
              }
              if (cHi !== null) {
                hi -= pull(cHi)
                if (Math.abs(cHi) > 1e-6) wedgeAt.push({ x: hi, hi: true, c: cHi })
              }
            }
          }
          const c = gs.children[i]!
          c.scale.set(hi - lo, sz[1], sz[2])
          c.position.x = (lo + hi) / 2
        }
        while (gs.wedges.length < wedgeAt.length) {
          const w = new Mesh(unitMitreWedge, gs.mat)
          w.castShadow = proto.castShadow
          w.receiveShadow = proto.receiveShadow
          if (proto.userData.poolUnit === true) w.userData.poolUnit = true
          gs.group.add(w)
          gs.wedges.push(w)
        }
        while (gs.wedges.length > wedgeAt.length) gs.group.remove(gs.wedges.pop()!)
        for (let i = 0; i < wedgeAt.length; i++) {
          const { x, hi, c } = wedgeAt[i]!
          const w = gs.wedges[i]!
          // the right-angle corner sits at the square end on the face where the cut reaches furthest out of the piece:
          // the inner face when c > 0 (its leg runs outward), the outer one when c < 0 (its leg runs back in)
          const leg = c > 0 ? out : -out
          w.quaternion.copy(MITRE_WEDGE_TURN[`${hi ? 'hi' : 'lo'},out${leg > 0 ? '+' : '-'}`]!)
          w.scale.set(Math.abs(c) * sz[2], sz[1], sz[2])
          w.position.set(x, 0, (-leg * sz[2]) / 2)
        }
        // a segment-, panel- or wedge-count change (or a panel re-cut to a new hole height) alters the draw list - a
        // recorded WebGPU render bundle would keep replaying the old pieces; bump the structural counter the
        // bundle invalidation polls
        if (gs.children.length + gs.panels.length + gs.wedges.length !== before || panelGeometryChanged) bumpStructureVersion(root)
      }
      // walking surfaces: retile the texture to the slab's resolved metre extents (X→U, Z→V), so a
      // resized/non-square deck keeps a fixed ~0.5 m crop instead of stretching (createDeckSurface.setExtent)
      for (const dl of deckSizeLinks) {
        if (dl.sizeParams) dl.surface.setBoxExtent(resolvedBoxSize(dl.size, dl.sizeParams, params))
      }
      // deck-cut pool: lay the deck out as the complement strips around a snapped stair's notches (guardSplit's
      // 2-axis twin, deckStripRects = the sim's collider rects). No cut ⇒ one full-size child (a plain rescale).
      for (const dc of deckCutLinks) {
        const sz = dc.sizeParams ? resolvedBoxSize(dc.size, dc.sizeParams, params) : dc.size
        const rects = deckStripRects(sz[0] / 2, sz[2] / 2, platformCut?.notches ?? [])
        const proto = dc.children[0]!
        const before = dc.children.length
        while (dc.children.length < rects.length) {
          const i = dc.children.length
          if (dc.walk && dc.strips && !dc.strips[i]) dc.strips[i] = newDeckSurface(dc.walk)
          const extra = new Mesh(unitBox, dc.strips?.[i]?.material ?? dc.mat)
          extra.castShadow = proto.castShadow
          extra.receiveShadow = proto.receiveShadow
          dc.group.add(extra)
          dc.children.push(extra)
        }
        for (let i = dc.children.length - 1; i >= Math.max(rects.length, 1); i--) {
          dc.group.remove(dc.children[i]!)
          dc.children.pop()
        }
        // a deck fully covered by notches (rects empty) collapses its one remaining child to nothing
        if (rects.length === 0) proto.scale.set(0, 0, 0)
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i]!
          const c = dc.children[i]!
          c.scale.set(r.x1 - r.x0, sz[1], r.z1 - r.z0)
          c.position.set((r.x0 + r.x1) / 2, 0, (r.z0 + r.z1) / 2)
          dc.strips?.[i]?.setExtent(r.x1 - r.x0, r.z1 - r.z0) // after deckSizeLinks: a strip tiles by its own size
        }
        // adding/removing strip meshes changes the draw list. Without a bump a recorded WebGPU render bundle keeps
        // replaying the old one (a removed strip keeps drawing, so the hole never closes), so a count change must bump the
        // structural counter the view's bundle invalidation polls
        if (dc.children.length !== before) bumpStructureVersion(root)
      }
      // node scaling: stretch each param-scaled mesh node's group per-axis (atop its fitHeight/scale base)
      for (const pm of paramMeshes) {
        const f = resolvedMeshScale(pm.sizeParams, params)
        pm.group.scale.set(f[0], f[1], f[2])
      }
      for (const tl of tiledMeshLinks) applyTiledMeshes(tl, params)
      for (const pc of paramCylinders) {
        const { radius, height } = resolvedCylinder(pc.shape, params)
        pc.mesh.scale.set(radius, height, radius)
      }
      // place every link from the one resolver, with these params: param-driven offsets (a hinge at -length/2, the
      // blade stop's airPressureHeight mount on a jointed link) and the whole-bed incline (deck, rollers, walls and
      // guards climb the grade; the legs, below, stay vertical) both come out of it, from the current geometry.
      // inclineRad/cosIncline/sinIncline are read again by the leg layout; 0 ⇒ flat.
      lastParams = params
      placeLinks()
      const inclineRad = rigInclineRad(geo, params)
      const cosIncline = Math.cos(inclineRad)
      const sinIncline = Math.sin(inclineRad)
      // array-links: (re)build the container's instance meshes to the resolved count, place + scale each.
      // (`seam` - the part placement that aligns world-phase beds across butted parts - is built at the top
      // of the refresh, because geometry() takes the grid it resolves; docs/seam-resolvers.md.)
      lastParams = params // remembered so an async GLB load lays out on the right grid after this refresh
      lastSeam = seam
      for (const ml of meshArrayLinks) rebuildMeshArray(ml, params, seam)
      // kind:'leg': (re)write the trestle instances at each station, reflowing with length + width, and the leg
      // height auto-adjusting to the stand param (deck→floor) minus the frame depth - so raising/lowering the deck
      // (or dropping it on a platform) regrows the legs to reach.
      for (const ll of legLinks) {
        const width = typeof params[ll.widthParam] === 'number' ? (params[ll.widthParam] as number) : 1
        const frameDepth = legFrameDepth(ll.shape, params)
        const stand = typeof params[ll.standParam] === 'number' ? (params[ll.standParam] as number) : frameDepth
        const height = Math.max(0.05, stand - frameDepth)
        if (ll.arc) {
          // Curved conveyor: fan the trestles around the arc (centreline radius r, sweep) at the legStations
          // cadence, each yawed radially - the SDK curved's convention: point (r·cos t, −r·sin t), yaw t+π/2.
          const r = typeof params[ll.arc.radiusParam] === 'number' ? (params[ll.arc.radiusParam] as number) : 1.5
          const sweep = (ll.arc.sweepDeg * Math.PI) / 180
          const angles = legStations(r * sweep).map((s) => s / r) // arc-length stations → sweep angles
          writeLegs(ll.pool, width, angles.map((t) => ({ base: new Matrix4().makeRotationY(t + Math.PI / 2).setPosition(r * Math.cos(t), 0, -r * Math.sin(t)), height })), frameDepth)
        } else {
          const span = typeof params[ll.spanParam] === 'number' ? Math.max(0, params[ll.spanParam] as number) : 0
          const stations = legStations(span, -span / 2) // centre-origin: legs run −span/2 … +span/2
          // whole-bed incline: legs stay vertical but each foot slides to x·cos and the post grows/shrinks by
          // x·sin so it still reaches the tilted deck underside (head legs taller, tail legs shorter). Flat ⇒ x,height.
          // Per-leg footing (legRests rows, part-local X = this group's X): a station over a platform deck
          // lifts its foot by dy and shortens the post; one overhanging past the part's own deck drops to the
          // warehouse floor (dy < 0). A footed leg squeezed under 5 cm is dropped (the bed rests on the deck
          // there), while the row-less flat layout keeps the legacy 5 cm clamp.
          // Knee braces lean toward the middle of the bed, and only on a level one: a brace drawn along a tilted
          // bed would meet the frame a slope's rise away from where it was aimed.
          const specs: { base: Matrix4; height: number; dir: number }[] = []
          for (const x of stations) {
            const dy = legRestDyAt(legRests, x)
            const h = height + x * sinIncline - dy
            if (dy !== 0 && h <= 0.05) continue
            const dir = Math.abs(sinIncline) > 1e-3 ? 0 : x <= 0 ? 1 : -1
            specs.push({ base: new Matrix4().makeTranslation(x * cosIncline, dy, 0), height: Math.max(0.05, h), dir })
          }
          writeLegs(ll.pool, width, specs, frameDepth)
        }
      }
      // arrayed primitive links (rollers/stubs/railings/shelves/treads): one InstancedMesh at a uniform per-copy
      // scale (from the shape's size + any sizeParams), only the grid delta varies per copy. `cast` was decided
      // at build time (roller hardware skips the shadow pass; structural arrays cast like the built-ins).
      for (const ial of instancedArrayLinks) {
        let deltas = arrayInstanceDeltas(ial.array, params, seam, ial.showParam)
        warnIfCapped(deltas, root, pkg.id)
        if (!ial.pool) ial.pool = createInstancePool(ial.group, ial.geom, ial.mat, Math.max(deltas.length, 16), ial.cast)
        let sx = 1, sy = 1, sz = 1
        if (ial.shape.kind === 'box') {
          const s = ial.shape.sizeParams ? resolvedBoxSize(ial.shape.size, ial.shape.sizeParams, params) : ial.shape.size
          sx = s[0]; sy = s[1]; sz = s[2]
        } else if (ial.shape.kind === 'cylinder' || ial.shape.kind === 'cone') {
          const c = ial.shape.kind === 'cylinder' && ial.shape.sizeParams ? resolvedCylinder(ial.shape, params) : { radius: ial.shape.radius, height: ial.shape.height }
          sx = c.radius; sy = c.height; sz = c.radius
        }
        // stair→platform railing cut, applied in place like the conveyor guard merge (no rig rebuild):
        // a rail/toe box (`segment`) becomes one instance per kept segment of its run, each scaled to the
        // segment length; a post run drops instances in the gap + gains a framing post at each gap edge
        // (cutPostDeltas - the same pure transform the sim rewrites its collider links with).
        const open = ial.railing ? (platformCut?.openings[ial.railing.edge] ?? []) : []
        if (ial.railing?.segment && deltas.length > 0) {
          const axis = ial.railing.axis
          const full = axis === 2 ? sz : sx
          const segs = open.length > 0 ? keptSegments(-full / 2, full / 2, open) : ([[-full / 2, full / 2]] as const)
          const base = deltas[0]!
          fillInstances(ial.pool, segs.map(([lo, hi]) => ({
            x: base[0] + (axis === 0 ? (lo + hi) / 2 : 0),
            y: base[1],
            z: base[2] + (axis === 2 ? (lo + hi) / 2 : 0),
            sx: axis === 0 ? hi - lo : sx,
            sy,
            sz: axis === 2 ? hi - lo : sz,
          })))
          continue
        }
        if (ial.railing && !ial.railing.segment && open.length > 0) {
          const { kept, framing } = cutPostDeltas(deltas, ial.railing.axis, open)
          deltas = [...kept, ...framing] as Vec3Tuple[]
        }
        writeInstances(ial.pool, deltas, sx, sy, sz)
      }
      // a changed neighbour cut reshaped draws that live inside this part's recorded render bundle (instanced
      // rail segments/posts, deck strips) while the part itself was never dragged/ejected. Bump the structural
      // counter so the bundle re-records, or WebGPU keeps replaying the old railing/deck until a dev restart.
      // One bump per cut change; an idle refresh with the same cut bumps nothing.
      // lamp banks: re-place their instances from the links' freshly resolved offsets + sizes
      for (const lb of lampBanks) lb.writeMatrices()
      replaceLinkBanks()
      const cutKey = (openings || platformCut || legRests) ? JSON.stringify([openings ?? null, platformCut ?? null, legRests ?? null]) : ''
      if (cutKey !== lastCutKey) {
        lastCutKey = cutKey
        bumpStructureVersion(root)
      }
    },
    applyJoints,
    applySubPoses,
    applyRestPose,
    ...(applyLamps ? { applyLamps } : {}),
    ...(applyDisplays ? { applyDisplays } : {}),
    // per-frame animation: roller-bed spin + squash cup ease (combined). Roller beds also follow the
    // frame's live effective speed (a tag-stopped roller stops spinning).
    ...(tick ? { tick } : {}),
    ...(rollerTick ? { applyConveyorSpeed: (v: number): void => { liveRollerSpeed = v } } : {}),
    // geometry() channels take the behavior's reported values (a program-commanded speed), not the deck's surface
    // speed: a chain transfer's deck runs across its chains while raised, so frame.conveyorSpeeds reads 0 exactly then
    ...(procTick ? { applyValues: (v: Record<string, number | boolean>): void => { liveValues = v } } : {}),
    ...(probeTick ? { probeTick } : {}),
    ...(gizmo ? { gizmo: gizmo.api, applyIdlePose } : {}),
    dispose: () => {
      for (const m of allMaterials) m.dispose() // textures are module-cached/shared, like meshCache - not disposed
      // beams are instances of the scene-level bank, not children of this rig, so disposing the part
      // doesn't detach them - they'd linger in the scene forever. (The bank owns the shared geometry
      // and the one beam material; neither is per-part, so neither is disposed here.)
      for (const bv of beamVisuals) removeSensorBeam(bv.beam)
      for (const s of deckSurfaces) s.dispose() // a walking surface's material (its maps are shared app-wide)
      clearProcSlots() // dispose the procedural rig-link geometries (their materials are in allMaterials, above)
      for (const tl of tiledMeshLinks) for (const tm of tl.meshes) retireGeometry(tm.geo) // tileUv's owned UV copies (the source GLB geometry is shared, never freed here)
      for (const ial of instancedArrayLinks) retireInstancedMeshOnly(ial.pool?.mesh) // array-link InstancedMesh buffers; mesh-only: the geom is shared (unitBox / unitCone / cylinderGeoFor), mats are in allMaterials
      for (const lb of lampBanks) lb.dispose() // lamp-bank instance buffers + cloned geometry (retired; the material is shared)
      for (const lb of linkBanks) lb.dispose() // link-bank instance buffers (retired; shared unit geometry, material in allMaterials)
      for (const ll of legLinks) disposeLegSet(ll.pool) // the trestle InstancedMesh buffers
      // label canvas textures/materials/geometries are per-instance. Textures + geometries retire (a recording may
      // still bind them, gpuRetire.ts); a material's dispose is already safe (bindings.deleteForRender).
      for (const d of labelDisposables) {
        if ((d as Texture).isTexture) retireTexture(d as Texture)
        else if ((d as BufferGeometry).isBufferGeometry) retireGeometry(d as BufferGeometry)
        else d.dispose()
      }
      for (const t of scrollTexClones) retireTexture(t) // private scroll-channel texture copies (not the shared package texture)
      for (const eg of edgeGeoms) retireGeometry(eg) // per-link wireframe outline buffers (link.outline); their material is in allMaterials
    },
  }
}
