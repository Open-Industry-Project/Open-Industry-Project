import type { Finish, ParamSchema, SnapSpec, UnitLoadDecl } from './partApi'
import { evalPartGeometry } from '../geometry/geometryEval'
import { resolvePartParams } from './partScript'

// A custom part as a portable, distributable artifact, authored in a real IDE against the part SDK
// (src/sdk) and then imported by the web or native runtime. Neither surface is an authoring surface. Both
// just load + run packages. One self-contained unit: metadata + the exported-param schema (baked so the
// Inspector needs no code run) + the behavior script source + a geometry/collision spec.

export type Vec3Tuple = [number, number, number]
/** A quaternion (x, y, z, w) - used for a rig link's rest rotation when an Euler angle can't express it. */
export type Vec4Tuple = [number, number, number, number]

/**
 * A param-driven geometry override: one axis tracks an instance param as `params[param] * scale
 * + add` (scale default 1, add default 0), optionally clamped to `[min, max]`. Used two ways: a box link's
 * `sizeParams` (a `width`/`length` param resizing a link) and any link's `offsetParams` (a param positioning
 * a sub-part, e.g. a hinge/leaf at `±length/2`). The static `size`/`offset` axis is the fallback (used when
 * the param is missing/non-numeric, and by the param-less `shapeHalfExtents`). Resolved in render (the visual
 * reflows on a param edit) and sim (the kinematic collision body is built + placed at the resolved geometry).
 */
/** A value that tracks an instance param: `params[param] × scale + add`, clamped to `[min, max]` - the one-axis
 *  twin of {@link SizeParamRef} (a joint limit, a reach). */
export type ParamRef = Omit<SizeParamRef, 'axis'>

export interface SizeParamRef {
  /** 0 = x, 1 = y, 2 = z */
  axis: 0 | 1 | 2
  /** the instance param name whose (numeric) value drives this axis */
  param: string
  /** multiply by a second param's value before `scale`/`add`: a product of two params, which the single linear
   *  map can't express (the chain transfer's deck width = `chains` × `distance`). The entry is skipped (static axis
   *  stands) when either param is missing/non-numeric. */
  mulParam?: string
  /** multiply the param value (default 1) */
  scale?: number
  /** add after scaling (default 0) */
  add?: number
  /** clamp the resolved value from below (after scale+add) - a floor a linear map can't express, e.g. the
   *  Blade Stop's corner sections stop at the centreline instead of crossing it on a very narrow lane */
  min?: number
  /** clamp the resolved value from above (after scale+add) - the mirror floor for a negative-side offset */
  max?: number
}

/** One indicator lamp a rig link carries ({@link RigLink.lamps}): a light the behavior switches with
 *  `ctx.lamps[name]`, render-only. On a primitive link the lamp is the link's own material (at most one); on a
 *  mesh link each lamp lights one GLB material the link remaps, so a model whose lenses share a node (the
 *  Diverter's red + green) carries several. Lit = full emissive at `emissive`; off = the unlit base colour (a
 *  primitive's `color`, else a dark neutral; a mesh lamp's remapped material colour). */
export interface RigLamp {
  /** the `ctx.lamps` key; defaults to the link's name. Unique across the rig; required for a second lamp on a
   *  link, since two cannot share the default */
  name?: string
  /** lit colour [r, g, b] (0..1, linear) */
  emissive: Vec3Tuple
  /** the colour it shows while dark [r, g, b] (0..1, linear): the lens or cup seen unlit. Omit for the host's dark
   *  neutral on a primitive link, or the material's own base colour on a mesh link (an unlit cap stays its colour).
   *  Package format 3 took a primitive lamp link's `color` for this. */
  offColor?: Vec3Tuple
  /** Mesh links only, and required there: the GLB material this lamp lights, a key of the shape's `materials`
   *  remap (an un-remapped material is shared with every part using the model, so lighting it would light theirs) */
  material?: string
  /** lit-state opacity (0..1] for a lens-style lamp: when lit it goes translucent at this opacity (tinted glass
   *  over an inner core, the stack light's optics). Omit for an opaque lamp. Off is always opaque */
  opacity?: number
  /** the key of a boolean param that lights this lamp whenever the behavior isn't driving it: at rest in the
   *  editor and right after Stop (the stack light's authored tiers, a gantry's vacuum lamp). While the sim runs
   *  the behavior's `ctx.lamps` commands take precedence each tick; a missing or non-boolean param reads as off */
  param?: string
}

/**
 * A gripper link's pickup volume ({@link RigLink.grip}): a box `zone`, or a `radius` sphere. A gripper holds every
 * cargo body inside its volume, each with its own captured offset, so the group rides rigidly in formation - a
 * layer head's formed layer, a loaded fork's pallet and stack. The count is therefore not a mode but a consequence of
 * the volume.
 */
export interface RigGrip {
  /** the volume as an oriented box (`size` = [w, h, d]) in the link's frame, centred on the link's origin unless
   *  `offset` (link-local metres) moves it to where the tool engages (a fork's load rides on the tines, ahead of the
   *  grab frame). `sizeParams` (same shape as a box's) tracks a tool-size param. The right model of a
   *  vacuum plate: a sphere big enough to span a 1.2 m plate also swallows cargo standing beside or under the tool,
   *  so declare a zone on any gripper wider than the thing it grips. With a zone the radius is not read. */
  zone?: { size: Vec3Tuple; offset?: Vec3Tuple; sizeParams?: SizeParamRef[] }
  /** without a zone: the reach (metres) beyond the link's max half-extent (a `frame` gripper has none, so this is its
   *  whole reach), measured to each body's box surface so a cup that only brushes a case still seals. Default 0.2. */
  radius?: number
  /** Param-driven reach: each entry resolves `params[param] x scale + add` (clamped; `axis` is ignored for a
   *  sphere) and the reach is the largest resolved value, `radius` the fallback. */
  radiusParams?: SizeParamRef[]
  /** This gripper is a pair of forks whose blades run along the link's +X. When it takes a pallet the host checks
   *  the face the blades went in through against the pallet's fork channels, and reports it on the part when they
   *  do not fit (they would land on its blocks). `spread` is blade centre to centre, `spreadParam` a number param
   *  that sets it instead. */
  forks?: { spread?: number; spreadParam?: string; bladeWidth: number; bladeThickness: number }
}

/** A shape for a rig link: a primitive, a transform-only 'frame', or a 'mesh' that renders an embedded GLB.
 *  Each kind is its own interface below, so its rules are documented where an author (or an editor hover) looks. */
export type RigShape = RigBoxShape | RigCylinderShape | RigConeShape | RigFrameShape | RigMeshShape | RigLabelShape | RigLegShape

/** A box primitive with a collision body, centred on its link's origin. `size` is the full [x, y, z] extent (m). */
export interface RigBoxShape {
  kind: 'box'
  size: Vec3Tuple
  /** make an axis track an instance param (a `width`/`length` param resizing the link) */
  sizeParams?: SizeParamRef[]
}

/** A cylinder primitive with a collision body; its length runs along the link's local +Y. */
export interface RigCylinderShape {
  kind: 'cylinder'
  radius: number
  height: number
  /** an entry whose axis is 1 tracks the height (the cylinder's local +Y length, e.g. a roller's
   *  axle length following the belt `width`); axis 0 or 2 tracks the radius. */
  sizeParams?: SizeParamRef[]
}

/** A render-only cone - no collision body (like `frame`/`label`), so cargo passes straight through it. The
 *  schematic "cargo drops here" cue the built-in spawner draws (a translucent marker cone). `radius` is the
 *  base radius, `height` the apex height; three's convention is apex +Y / base −Y, so a downward drop cue
 *  rotates the link 180° about X. Pair with the link's `opacity` for the translucent look; a `color` tints it. */
export interface RigConeShape {
  kind: 'cone'
  radius: number
  height: number
}

/** A transform-only link: no geometry, no collision - a pure pivot/frame node in the kinematic tree (a joint
 *  origin or a fixed offset between driven links). The articulated robot is built from these: a frame per
 *  joint pivot, mesh links hung off them. Also the usual parent of a moving mesh: put the joint on the frame. */
export interface RigFrameShape {
  kind: 'frame'
}

/**
 * A visual mesh from a GLB (see PartPackage.assets). **Render-only unless `collision` is set** - for anything
 * cargo must hit, prefer hidden (`hidden: true`) primitive `box` links sized to the real surfaces: the visual
 * mesh / primitive collider split every built-in uses.
 *
 * Two ways to take geometry from the GLB, and they place it differently:
 * - **`node`** takes one named node's geometry in its mesh-local frame (its node transform is reset), so the
 *   link's `offset`/`rotation` alone place it. One GLB of an articulated model (a robot) supplies a mesh per rig
 *   link this way; you transcribe each node's transform into the rig.
 * - **Whole scene** (no `node`): the GLB as authored, optionally normalised by `fitHeight`, then carved by
 *   `hideNodes` / `keepNode`. Carved pieces keep identical scale and placement, so links cut from the same GLB
 *   line up without transcribing anything. This is the simplest route for an imported device: `hideNodes` the moving nodes
 *   on the base link, and put them on a second mesh link under a `frame` that carries the joint.
 */
export interface RigMeshShape {
  kind: 'mesh'
  /** a PartPackage.assets[].id (the GLB) */
  asset: string
  /** use just this named GLB node, in its mesh-local frame (its node transform is reset, see above) */
  node?: string
  /** uniform scale applied to the mesh */
  scale?: number
  /** whole-scene refs only: uniformly scale the GLB to this height (m), centre it in XZ and rest its underside
   *  on y=0 - how the built-in device parts normalise a raw GLB, so an import's native scale/origin doesn't
   *  have to be hand-transcribed. Applied before `hideNodes`/`keepNode`,
   *  to the full scene, which is what keeps carved pieces aligned. */
  fitHeight?: number
  /** node scaling: each entry stretches the mesh on one axis by a param-driven factor
   *  `params[param] * scale + add` (a multiplier on top of `scale`/`fitHeight`), so an imported model section
   *  can grow with a `width`/`length` param - the mesh equivalent of a box's sizeParams. Tune `scale`/`add` so
   *  the factor is ~1 at the default param. Drives both the render mesh and (with `collision`) the collider;
   *  pairs with the link's `offsetParams` (which slides edge nodes out). */
  sizeParams?: SizeParamRef[]
  /** re-tile instead of stretch, for a `sizeParams` stretch: each entry multiplies one UV channel of the listed
   *  GLB materials by the resolved stretch factor on its axis, so a texture that repeats along the member (a
   *  trim-sheet strip: a rail's bolt holes, a tube's seam) keeps its real spacing at any length instead of
   *  smearing. Only for a model whose UVs run 0..1 along the stretched axis on those materials; list just
   *  those, since a UV island that does not repeat (an end cap sampling one spot of an atlas) would wander off
   *  it. Matched by the GLB material name, before any `materials` remap. Render-only. */
  tileUv?: MeshUvTile[]
  /** a PartPackage.materials[].id overriding the GLB's own material on every mesh */
  material?: string
  /** remap per GLB material name → a PartPackage.materials[].id, so a model that ships several named materials
   *  can recolour each one individually */
  materials?: Record<string, string>
  /** whole-scene refs: remove these nodes and their subtrees (applied after `fitHeight`) */
  hideNodes?: string[]
  /** whole-scene refs: keep only this one node's subtree, re-based into the fitted frame (works even when the
   *  node is nested under a housing node). A moving piece made of several sibling nodes can't be named here -
   *  use `hideNodes` listing everything else instead. */
  keepNode?: string
}

/** One `tileUv` entry on a mesh link: which stretch axis re-tiles which UV channel, on which GLB materials. */
export interface MeshUvTile {
  /** the `sizeParams` axis whose stretch factor re-tiles (0 = x, 1 = y, 2 = z) */
  axis: 0 | 1 | 2
  /** the UV channel that runs along that axis in the model */
  uv: 'u' | 'v'
  /** GLB material names (as authored, before any `materials` remap) whose UVs repeat along the axis */
  materials: string[]
}

/** A render-only text label: a flat plane (local +Z facing) carrying canvas-drawn text, the rig equivalent of
 *  a 3-D text label (e.g. a push button's face caption). No collision. Empty resolved text hides it. */
export interface RigLabelShape {
  kind: 'label'
  /** a static caption */
  text?: string
  /** names an instance param so the label is Inspector-editable (the resolved param value is drawn) */
  textParam?: string
  /** the live form: names a display the behavior publishes (`ctx.display`) and the caption follows it every
   *  tick - a totaliser, a weight on a scale, a status word. Takes precedence over `text`/`textParam` while the
   *  sim runs; falls back to them when nothing is published, so a stopped scene still reads as authored. */
  textFrom?: string
  /** the plane [width, height] in metres (default 0.05 × 0.05) */
  size?: [number, number]
  /** text colour [r, g, b] 0..1 (default black) */
  color?: Vec3Tuple
}

/** A conveyor support leg (the built-in dual-post steel trestle), rendered from the shared `legPieces` builder,
 *  so an SDK conveyor gets the exact built-in legs. One `leg` link becomes a row: legs auto-space along the
 *  `spanParam` length (tail/head insets + a spacing grid). `widthParam` sets the trestle's cross width (posts at
 *  ±width/2). The leg height adjusts itself: it tracks `standParam` (the deck-above-floor stand height, a
 *  `rest:'surfaceBelow'` param the host fills at drop/snap) minus `frameDepth` (deck→frame bottom). The link's
 *  own offset y should track −standParam (offsetParams) so the feet sit on the floor. Render-only. `arc` makes
 *  it a curved conveyor's fanned leg row: trestles fan around an arc of centreline radius `arc.radiusParam` over
 *  `arc.sweepDeg`, each yawed radially. */
export interface RigLegShape {
  kind: 'leg'
  spanParam: string
  widthParam: string
  standParam: string
  /** deck → frame bottom (m): where the leg tops meet the frame */
  frameDepth: number
  /** make the frame depth track a param (a bed whose frame depth is authored, so the legs still meet its
   *  bottom); `frameDepth` stands while the param is missing or non-numeric */
  frameDepthParam?: ParamRef
  arc?: { radiusParam: string; sweepDeg: number }
}

/**
 * A PBR material a mesh link can reference (by id) to override the embedded GLB's own material. An
 * ORM material recipe: a base-color (albedo) texture + a packed occlusion-roughness-metalness
 * texture (G=roughness, B=metalness) + an optional normal map, each an embedded PartPackage.assets[].id.
 * Scalar fallbacks (color/metalness/roughness) cover a textureless material.
 */
export interface PartMaterial {
  /** referenced by a mesh RigShape's `material` */
  id: string
  /** asset id of the base-color (albedo) texture; sampled sRGB */
  albedo?: string
  /** asset id of a packed occlusion-roughness-metalness texture (G=roughness, B=metalness); sampled linear */
  orm?: string
  /** asset id of a normal map (optional) */
  normal?: string
  /** flat base color [r, g, b] in 0..1 when there's no albedo texture */
  color?: Vec3Tuple
  /** scalar metalness when there's no orm texture (default 1 with an orm map, else 0) */
  metalness?: number
  /** scalar roughness when there's no orm texture (default 1 with an orm map, else 0.6) */
  roughness?: number
  /**
   * Sample the `albedo` texture triplanar - projected on the world/object planes and blended by the surface
   * normal - instead of by the mesh's own UVs. The fix for an imported GLB whose UVs don't progress along a
   * long axis, so a baked texture pins into stretched streaks (the Diverter arms' brushed metal). `space`:
   * 'object' locks the grain to the geometry (a telescoping/moving part doesn't swim); 'world' tiles at a
   * fixed density across parts. `scale` = texture tiles per metre; `boost` brightens the sampled albedo (a
   * colour tint), default 1. Requires `albedo` or `pattern`; `metalness`/`roughness`/`color` still apply as the tint.
   */
  triplanar?: { space: 'object' | 'world'; scale: number; boost?: number }
  /**
   * A two-colour pattern the host draws, in place of an `albedo` image: hazard stripes, a painted band, a checker.
   * Plain data, so a part needs no texture file for it. One repeat of the pattern is one texture tile: with
   * `triplanar` it is projected at `triplanar.scale` repeats per metre (the usual choice: builder ops' UVs are not
   * in metres), else it follows the mesh's UVs, one repeat per UV unit. Without an `orm`, it defaults to a painted
   * finish (`metalness` 0, `roughness` 0.6). Not with `albedo`. See {@link PartPattern}.
   */
  pattern?: PartPattern
}

/**
 * A two-colour pattern ({@link PartMaterial.pattern}). Colours are linear r,g,b 0..1, like a rig link's `color`.
 * - `'stripes'`: alternating bands, `colors[0]` taking `ratio` of each repeat (default 0.5). `angle` is the way the
 *   bands run, in degrees from the tile's U axis: 0, 45, 90 or 135 (default 0). Hazard tape is 45.
 * - `'checker'`: a 2 x 2 checkerboard per repeat.
 */
export interface PartPattern {
  kind: 'stripes' | 'checker'
  colors: [Vec3Tuple, Vec3Tuple]
  /** stripes: the share of each repeat in `colors[0]`, between 0 and 1 (default 0.5) */
  ratio?: number
  /** stripes: the way the bands run, degrees from the tile's U axis (default 0) */
  angle?: 0 | 45 | 90 | 135
}

/**
 * A binary asset (a GLB mesh or a texture) a part references by id. Two flavors:
 *  - `data` (base64): embedded - the part is self-contained/portable (a shared third-party part).
 *  - `url`: referenced - points at an app-served asset (e.g. "/models/foo.glb"). For first-party bundled
 *    examples that reuse already-shipped public/ assets, so they don't duplicate megabytes into the bundle.
 * Exactly one of `data` / `url` is set.
 */
export interface PartAsset {
  /** referenced by a mesh RigShape's `asset` (or a material's albedo/orm/normal) */
  id: string
  /** e.g. "model/gltf-binary" or "image/webp" */
  mime: string
  /** base64-encoded bytes (embedded, portable) */
  data?: string
  /** URL of an app-served asset (referenced, not embedded) */
  url?: string
  /** SHA-256 (64 hex) of the asset's bytes, when they are known. An asset that has one is identified by those bytes, whether it
   *  holds them (`data`, or a project folder's `assets/<sha256>.*` file) or names where they are served (`url`): a
   *  part's fingerprint identifies it by this alone. A first-party asset gets it from the app's table of shipped
   *  assets, with `url` pointing at `/part-assets/<sha256>.<ext>`. */
  sha256?: string
}

/** One axis of a grid array-link (see RigLink.array.grid): the params giving the lattice's full span,
 *  per-edge inset, and desired spacing along this axis. The static `size`/`pitch`/`margin` are the
 *  fallbacks when a param is missing or non-numeric (e.g. an instance saved without that param), the
 *  same rule as every other param-driven size or offset. */
export interface GridAxisSpec {
  /** param holding the full span (m) the lattice covers (e.g. the EOAT's toolSizeX) */
  sizeParam: string
  /** param holding the desired instance spacing (m); count = floor(usable/pitch)+1. Optional when `maxSpacing`
   *  is set (which uses ceil/OSHA spacing instead of a param-driven pitch). */
  pitchParam?: string
  /** param holding the inset (m) kept off each edge of the span (usable = size − 2·margin); omit for none */
  marginParam?: string
  /** static span fallback (m) when `sizeParam` doesn't resolve (default 0 - a single centred instance) */
  size?: number
  /** static pitch fallback (m) when `pitchParam` doesn't resolve (default 0.1) */
  pitch?: number
  /** static margin fallback (m) when `marginParam` doesn't resolve (default 0) */
  margin?: number
  /** ceil/OSHA spacing (m): a fixed max gap. count = spans+1 where spans = max(1, ceil(usable/maxSpacing)),
   *  so every gap stays ≤ this (never exceeds it), edges included. The structure-grid mode (support columns
   *  at max column spacing); mirrors a 1-D `distribute`. Takes precedence over pitchParam when set. */
  maxSpacing?: number
}

/** One sub-part of a multi-body rig: a shape at a local transform under an optional parent link. */
export interface RigLink {
  /** unique within the rig; referenced by joints and child links */
  name: string
  /** parent link name; omitted = attached to the rig root */
  parent?: string
  shape: RigShape
  /** local position relative to the parent (or rig origin), metres */
  offset: Vec3Tuple
  /** local rotation (Euler XYZ, radians) relative to the parent; omitted = identity */
  rotation?: Vec3Tuple
  /** local rotation as a quaternion (x, y, z, w); takes precedence over `rotation` when an arbitrary
   *  rotation matrix (e.g. an axis permutation from a CAD export) doesn't map cleanly to Euler angles */
  quat?: Vec4Tuple
  /** per-axis overrides that make this link's `offset` track an instance param (e.g. a hinge at
   *  `-length/2`), so a length/width param repositions the sub-part per instance */
  offsetParams?: SizeParamRef[]
  /** The base material colour [r, g, b] (0..1, linear) of this primitive link - gives it its own tinted
   *  material instead of the shared neutral fallback (so a belt reads as steel, a rack's shelves as wood,
   *  etc.). Not on a lamp link: a lamp's colours are its own, lit `emissive` and dark `offColor` ({@link RigLamp}).
   *  Render-only; ignored on mesh/frame links (a mesh keeps its GLB/`material`). */
  color?: Vec3Tuple
  /** Param-driven colour: the name of a `color`/string param whose `#rrggbb` value tints this primitive link's
   *  albedo, editable in the Inspector + live on the running frame (the barriers' `steel color`, a platform's
   *  deck tint). The hex is read as sRGB and converted to linear (three's `.color.set`), so a param default of
   *  `#f2bd0f` matches the built-in's `mat.color.set('#f2bd0f')` exactly. Overrides the static `color` for the
   *  albedo (still the lamp unlit base when `emissive` is also set). On a mesh link it tints the link's own
   *  package material: the `lamp` material when one is declared - both the unlit base and the lit colour follow
   *  the param (the push button's `button color` sets albedo = emission) - else the
   *  single `material` override. Ignored on `finish`/`frame` links (a finish keeps its shared textured material)
   *  and on a mesh link that keeps the GLB's own materials. Render-only. */
  colorParam?: string
  /** Render-only PBR finish for a `color`/`colorParam` primitive link: `metalness` and `roughness` (each 0..1)
   *  of its MeshStandardMaterial, overriding the SDK default (0.3 / 0.6). A link that mirrors a built-in's flat
   *  non-metallic steel sets `metalness: 0, roughness: 0.8` so it shows its albedo instead of the environment
   *  reflection the default gloss adds - the built-in rack's "keep the uprights non-metallic" note.
   *  Ignored on `finish`/`mesh`/`frame`/`emissive` links (those own their material/lamp finish). */
  metalness?: number
  roughness?: number
  /** Render-only idle translucency (0..1] for a `color`/`colorParam` primitive link: below 1 the link gets its
   *  own transparent material at this opacity (depth-write off), so it reads as a schematic cue rather than solid
   *  equipment - the built-in spawner's translucent drop marker, a light-curtain plane, a ghost preview. Distinct
   *  from a lamp's `opacity` (a lit lens); this is the unlit base finish. 1 / omitted = opaque. Ignored
   *  on `finish`/`mesh`/`frame` links and lamp links (those own their material). */
  opacity?: number
  /** Render-only wireframe outline colour [r, g, b] (0..1, linear) for a primitive link: draws the crisp edge
   *  lines of its box/cylinder/cone on top of the fill (three's EdgesGeometry, the built-in spawner marker's
   *  light-blue outline). Reads as a schematic/diagram edge, and gives a translucent {@link opacity} link
   *  definition it would otherwise lack. Omit for no outline. Ignored on `mesh`/`frame` links. */
  outline?: Vec3Tuple
  /** The link's look, from the host's built-in finishes instead of a flat `color`: the same textured metal and
   *  fabric the built-in conveyors use, so an SDK part looks the same as a built-in.
   *  `'frame'`/`'guard'`/`'leg'`/`'bolt'` = the steel materials (Metal.webp), `'roller'` = the brushed roller
   *  metal (RollerMetal.webp, spun by the part's `speed`; casts no shadow), `'belt'` = the scrolling fabric,
   *  `'tread'` = steel tread plate (TreadPlate.webp) and `'deck'` = a solid concrete deck (BuildingFloor.webp), the
   *  two walking surfaces, each tiled per metre from the link's resolved box size (a box link's X/Z sizeParams
   *  drive the tiling). {@link finishParam} lets an instance choose between finishes.
   *  Works on primitive and mesh links. Takes precedence over `color`. Omit for a flat tint.
   *  A finish is only a look: what the host does with the link is declared on its own ({@link sideGuard},
   *  {@link sideRail}, {@link bed}, {@link notchable}). Package format 3 called this `role`, and it also
   *  switched those on. */
  finish?: Finish
  /** The name of an `'enum'` param whose option values are finishes (`'tread'`, `'deck'`, ...): the instance's choice
   *  is this link's finish, so the Inspector picks the look (a platform's "Deck surface": tread plate for an access
   *  platform, a solid deck for one carrying equipment). `finish` is what shows when the param holds no finish.
   *  Only the look changes; the link's body is the same either way. */
  finishParam?: string
  /** This box is one of a straight conveyor's side guard walls, on its `'left'` (-Z) or `'right'` (+Z) side (the
   *  bed runs along +X). The host treats it as a guard: a neighbouring conveyor whose end butts that side opens a
   *  gap in it, a flush side merge retracts it to the neighbour's wall, it merges with a collinear neighbour's
   *  guard into one wall, its collider takes the shared guard cross-section, and it has no friction so cargo
   *  slides along it. */
  sideGuard?: 'left' | 'right'
  /** This box is one of a straight conveyor's below-deck side rails (a frame wall or flange) on its `'left'` (-Z)
   *  or `'right'` (+Z) side: a flush side merge retracts it to the neighbour's wall, like a guard, but a butting
   *  neighbour never opens it (the host frame stays closed). */
  sideRail?: 'left' | 'right'
  /** On a conveying rig (one with a `conveys` link): this solid belongs to the conveyor bed, so cargo sliding
   *  across it from a conveying surface (a diverter kick onto a takeaway, a load stepping off a turntable lane)
   *  does not snag on its edges. It joins the conveyor contact gates with no surface velocity. A guard must stop
   *  cargo, so a {@link sideGuard} never needs it. */
  bed?: boolean
  /** This box is the part's walking deck: its resolved size is the deck's extent, and where a neighbour's edge
   *  mount `notch`es the deck, the host carves the box into the strips around the stairwell. */
  notchable?: boolean
  /** The indicator lamps this link carries, each switched by the behavior's `ctx.lamps` ({@link RigLamp}): one on
   *  a primitive link (its own material), one per lit material on a mesh link. Render-only. */
  lamps?: RigLamp[]
  /** This mesh link compresses along its local Y by `amount` (0..1] while `lamp` is lit (default: the
   *  link's own lamp). The suction cup's bellows collapsing as the vacuum grips, the EOAT's physical grip tell:
   *  anchored at the link's rim (the contact lip, −Y-most in its local frame, from its mesh bounds) so the lip
   *  stays seated on the workpiece while the bellows fold toward the mount; eased over ~120 ms each way and
   *  released when the sim stops. `lamp` names any lamp in the rig, so cups with no glow of their own can
   *  compress off the tool's vacuum-status LED and one `ctx.lamps` signal drives both. Render-only. */
  squash?: { amount: number; lamp?: string }
  /** Two-point look-at: override this link's rotation each evaluation so its local +Z (model front,
   *  glTF convention) points at `target` link's origin, with roll fixed by `up` (default the parent's world
   *  +Y). For struts/cables that must stay connected as a
   *  driven parent moves (e.g. the robot's hydraulics). The authored `quat`/`rotation` is the fallback, used
   *  only when the target can't be resolved or the two origins coincide. Honored by both render + sim FK. */
  aim?: { target: string; up?: Vec3Tuple }
  /** A sensor beam emitted from this link's origin along `axis` (link-local, default +Z) for
   *  `range` metres. The host casts it against cargo each tick; the behavior reads the nearest hit via
   *  `ctx.sense(linkName)` (presence / distance / colour) and drives a PLC tag. The render draws the beam
   *  line (green clear / red blocked, like the built-in sensors) out to that length; `tint: 'hit'` colours the
   *  blocked beam with the detected cargo's tint instead of red (a colour-classifying sensor).
   *  `rangeParam` names a `number` param that sets the beam's length - the sensing range and the drawn line
   *  both, so an Inspector slider (or a snap's auto-fit, `mount.fitRangeParam`) reaches the part's real
   *  detection distance; `range` is the length without one, and the fallback when the param is not > 0.
   *  `showParam` names a `boolean` param that hides the drawn line when false (a viewing aid only: sensing is
   *  unchanged). A beam sees cargo and the walking pilot, never the part's own links. Package format 4 had no
   *  `showParam`, and drew to a param that happened to be named `maxRange` / hid on one named `showBeam`. */
  beam?: { range: number; rangeParam?: string; showParam?: string; axis?: Vec3Tuple; tint?: 'hit' }
  /** A box detection and removal zone (`size` = [w, h, d]) centred on this link's origin. The host
   *  counts cargo inside it each tick (`ctx.zone(linkName)`) and removes that cargo when the behavior calls
   *  `ctx.despawn(linkName)`: an exit or sink that reports throughput and clears cargo from the line. `sizeParams`
   *  (same shape as a box's) makes the trigger volume resize with a param, so a despawner's
   *  length, height and width sliders grow the detection box the way the built-in despawner's do. */
  zone?: { size: Vec3Tuple; sizeParams?: SizeParamRef[] }
  /** This (box) link is a weighing platform: a load cell under it. The host reads the vertical force the cargo
   *  resting on it puts through it each tick, and the behavior reads it with `ctx.weight(linkName)`, in kg. The
   *  force comes from the physics: every body touching the link's top and everything stacked on it, at its own mass,
   *  with the vertical acceleration it has this tick, so a load landing on the platform or riding a lift reads more
   *  for a moment, as on a real scale. A load resting on this link alone counts in full, even one hanging past its
   *  edge. A load that also rests on something else (a case crossing the seam onto a weigh belt, a pallet bridging two
   *  scales) is shared between them by where its centre of gravity falls between the two, so the reading ramps as a
   *  case comes on. Works on a `conveys` deck (a checkweigher's weigh belt) and on a plain solid box (a platform
   *  scale). */
  loadCell?: boolean
  /** This link grips: its pickup volume, where cargo is taken when the behavior closes it (`ctx.setGrip` /
   *  `ctx.grips`). Any link can be commanded to grip; this block sizes what it takes ({@link RigGrip}). Omit it and
   *  the link picks within the host's 0.2 m default reach. Package format 3 spelled these `grabZone`,
   *  `grabRadius` and `grabParams` on the link. */
  grip?: RigGrip
  /** Is this link solid, and as what? Omitted = the shape's own default: a `box` / `cylinder` collides as itself,
   *  and a `mesh` (a model), `cone`, `frame`, `label` or `leg` does not.
   *  - `'none'`: render it but build no body. For cosmetic geometry that must not touch cargo: a roller
   *    conveyor's rollers (the separate `conveys` deck is the real surface), a railing's decorative rails.
   *  - `{ box: [x, y, z] }` (a `mesh` link only): collide as a box of that full size, **centred on the link
   *    origin** (not on the model's bounds). For an off-centre model, use a hidden `box` link at the right offset.
   *  A drawn submesh says the same thing with `collision: 'box' | 'hull'` (partApi `MeshPart`). */
  collision?: 'none' | { box: Vec3Tuple }
  /** This (box) link is a conveyor surface: its top face carries cargo at the velocity the behavior
   *  sets via `ctx.setSurfaceVelocity` (a powered belt/roller deck). The host builds it as a static conveyor
   *  body, so cargo rides it; other links (frame, guards) stay normal. A `conveys` link under a joint (a lift's
   *  carriage, a pop-up transfer) is built kinematic instead and follows the joint each tick, carrying its cargo
   *  with it: a vertical lift is a `conveys` deck on a prismatic joint. A `conveys` link turned in the part is built
   *  at that turn, and its running face is its local +Y wherever that points: a side belt is a `conveys` box stood
   *  on its edge. A running face meeting cargo from the side needs a firm squeeze to grip it: a contact up to
   *  2 mm deep on a sideways face reads as a seam snag between butted conveyors and is ignored. */
  conveys?: boolean
  /** Author-mode visibility: when true the link (and its subtree, via the render group) is hidden in the
   *  rendered part - the Scene-tree eye toggle. Render-only: the sim/collision body is still built, like a
   *  `frame`/`label` link is visual-only the other way round. A persisted authoring property (every instance
   *  hides it), not per-instance state. */
  hidden?: boolean
  /** Param-gated structural toggle: the name of a boolean param that must be true for this link to exist. When
   *  it resolves false, the link is omitted entirely: no rendered mesh and no collision body (both, unlike the
   *  render-only `hidden`), so a part can drop an optional structural member from the Inspector, like the
   *  belt/curved conveyors' side-guard toggles (roller-conveyor `leftGuard`/`rightGuard`). Resolved with the
   *  param default, so an unset default-true param keeps the link. A missing/non-boolean param reads as shown. */
  showParam?: string
  /** This link runs on the named edge of the part's deck surface (a railing post array, rail, toe board or infill
   *  wall), so a neighbour that meets that edge and {@link SnapEdgeMount.opens} it cuts the link around the gap:
   *  boxes split into the solid spans left, array posts in the gap drop out. A link without
   *  it is never cut. Package format 2 called this `railing`. */
  onEdge?: 'posX' | 'negX' | 'posZ' | 'negZ'
  /** `'floor'`: when a connection lifts this part (an edge mount's `lift`, raising a flight flush onto a deck),
   *  this link stretches back down so it still stands on the floor: a plain box grows downward by the lift, and an
   *  array link (a riser row) also gains a filler plate under its first instance. Links without it rise with the lift.
   *  Package format 2 called this `stairFoot: true`. */
  anchor?: 'floor'
  /** When a connection mounts this part on a deck (an edge mount's `lift` meeting a deck edge), this link is
   *  omitted, mesh and collision body both: the deck takes its place. A stair's own top landing, which the
   *  platform it climbs to replaces. Freestanding, the link is built as usual. */
  dropWhenMounted?: boolean
  /** array-links: repeat this link into N static instances, a count-driven sub-part array (a
   *  belt's legs, a roller bed's rollers, a fence's posts, a rack's shelves). Three forms:
   *   - `distribute`: spread instances evenly along `axis`, centred on the link offset, across the span the
   *     `spanParam` gives (count = ceil(span/maxSpacing)+1 - e.g. fence posts auto-spaced as the length grows).
   *     `spanAdd` (metres) lengthens that span past the param (a railing whose posts stand just outside the deck
   *     runs `2 × that offset` further, so each end post stands on the true corner).
   *     Set `worldPhase` (axis 0 only) to lock copies to the world pitch grid instead (`maxSpacing` becomes the
   *     exact pitch), so collinear beds (butted roller conveyors) share grid lines without the snap having to
   *     pass anything between them. Falls back to the centred spread when the host has no placement to lock to.
   *   - `count` + `step`: place `params[count]` instances `step` apart (optionally `centered`) - e.g. rack
   *     shelves stacked by a numShelves param. `stepParams` (same shape as sizeParams) makes a `step` axis track
   *     an instance param (the chain transfer's lane spacing following `distance`), the static `step` the fallback.
   *   - `grid`: a 2-D X×Z lattice with param-driven span + pitch (the EOAT suction-cup bed).
   *     Per axis: usable = max(params[sizeParam] − 2·params[marginParam], 0),
   *     count = floor(usable/params[pitchParam]) + 1 (clamped 1..64), instances
   *     spread edge-to-edge across ±usable/2 (actual spacing = usable/(count−1) ≈ pitch). Uniquely usable on a
   *     `mesh` link (the cup GLB node cloned per cell).
   *  To switch the whole array off with a param, give the link a {@link showParam}: false ⇒ zero instances, mesh
   *  and collision (format 3's `enabledParam` inside the array).
   *  Each instance is a copy of the shape (sizeParams applied uniformly). Render + sim build N meshes/bodies. */
  array?: {
    distribute?: { axis: 0 | 1 | 2; spanParam: string; spanAdd?: number; maxSpacing: number; worldPhase?: boolean }
    count?: string
    step?: Vec3Tuple
    stepParams?: SizeParamRef[]
    centered?: boolean
    /** Drop the first / last instance of a 1-D array (`distribute` or `count`) when the named boolean param is
     *  true, so two barriers butt end-to-end without a doubled post at the shared junction (the built-in guard
     *  rail / fence / safety gate's omitPostStart / omitPostEnd). "First" = the low end of `axis` (−span/2 for
     *  `distribute`); "last" = the high end. Ignored on the 2-D `grid` form. */
    omitFirstParam?: string
    omitLastParam?: string
    grid?: {
      x: GridAxisSpec
      z: GridAxisSpec
    }
  }
}

/**
 * A kinematic joint that moves one link relative to its parent - the articulation a behavior commands
 * via `ctx.setJoint(name, value)`. Position-controlled (revolute angle / prismatic extension), the
 * deterministic default for an industrial twin; physical joints can come later as another kind.
 */
export interface RigJoint {
  /** the setJoint() name */
  name: string
  /** the link this joint drives (relative to its parent) */
  link: string
  type: 'revolute' | 'prismatic'
  /** joint axis in the link's local frame */
  axis: Vec3Tuple
  /** command limits - revolute radians, prismatic metres; the host clamps setJoint() to [min, max]. With
   *  {@link minParam} / {@link maxParam} these are the outer envelope (the widest any instance may travel) */
  min: number
  max: number
  /** make a limit track an instance param, as a size or an offset does: resolves `params[param] × scale + add`
   *  (clamped to the ref's own `[min, max]`, then kept inside the joint's static envelope). A gantry carriage whose
   *  travel is its frame's length less an inset: `maxParam: { param: 'frameLength', scale: 0.5, add: -0.06 }`. The
   *  host enforces it everywhere the joint is posed (the sim, the rendered FK, `ctx.measured.joints`), so the
   *  behavior needs no clamp of its own. The static limit stands when the param is missing. */
  minParam?: ParamRef
  maxParam?: ParamRef
  /** Self-driven dressing the behavior animates from its own state (an AGV's rolling wheels, a piston that
   *  tracks the lift at a ratio), not an author-commandable axis. The rig gizmo skips it (no ring, never the
   *  IK end-effector) and the authored idle `pose` row indexes only non-cosmetic joints. FK/sim treat it like
   *  any other joint. */
  cosmetic?: boolean
  /** The settled (idle/held) value the behavior slews this joint to, as a param binding: resolves
   *  `params[param] × scale + add` in the joint's native unit (revolute radians, prismatic metres) - e.g. a
   *  turntable's `{ param: 'deckAngleDeg', scale: π/180 }`. Lets the host mirror the at-rest pose without
   *  running the behavior (the pilot's surface-carry direction on a settled deck). Omit for joints that rest
   *  at 0 or whose rest isn't a single param's function. */
  rest?: { param: string; scale?: number; add?: number }
  /** A servo: the host drives this joint as a motion axis instead of taking a position
   *  from the behavior each tick. The behavior commands it through `ctx.servos.<name>` (power, moveAbsolute,
   *  moveVelocity, halt, ...) and the host runs the profile inside the joint's limits ({@link min} / {@link max},
   *  narrowed by {@link minParam} / {@link maxParam}). The caps are in the joint's native unit, per second
   *  (revolute radians, prismatic metres); a command asking for more is held to them. */
  servo?: RigServo
}

/** The rig's servo joints as the JSON a behavior instance is created with (embeddedBehavior `create`'s
 *  `servosJson`), or undefined when it has none: every host that runs a rig's behavior hands it these, so the
 *  servos move the same in a run, an idle preview and a stopped Use. */
export function servoJointsJson(geometry: PartPackageGeometry): string | undefined {
  if (geometry.kind !== 'rig') return undefined
  const servos = geometry.joints.filter((j) => j.servo)
  return servos.length ? JSON.stringify(servos) : undefined
}

export interface RigServo {
  maxVelocity: number
  maxAccel: number
  /** defaults to maxAccel */
  maxDecel?: number
  /** a revolute servo that turns without end, its position wrapping at this many radians (2π for a full turn); the
   *  joint's min / max then do not limit it */
  modulo?: number
}

/**
 * Rename one rig link, cascading the new name through every structural reference in the rig: child links'
 * `parent`, two-point look-at targets (`aim.target`), and joints' `link`. A link name is a reference key,
 * not just a label, so a bare relabel would orphan those. Joint names are left untouched: they're a separate
 * identifier the behavior commands via `setJoint`. Returns the rewritten links+joints, or `null` when the rename
 * is a no-op or invalid: a blank/unchanged name, an unknown source link, or a name already taken by another link.
 * Pure, and in core so the editor and any headless authoring path share one cascade. Behavior-script references
 * to the link by name (setGrip/setSubPose string args) are not rewritten here. The caller adds that guarded
 * source-edit step separately.
 */
export function renameRigLink(
  geometry: { links: RigLink[]; joints: RigJoint[] },
  oldName: string,
  rawName: string,
): { links: RigLink[]; joints: RigJoint[] } | null {
  const newName = rawName.trim()
  if (newName === '' || newName === oldName) return null
  if (!geometry.links.some((l) => l.name === oldName)) return null
  if (geometry.links.some((l) => l.name === newName)) return null
  const links = geometry.links.map((l): RigLink => {
    let next = l
    if (l.name === oldName) next = { ...next, name: newName }
    if (l.parent === oldName) next = { ...next, parent: newName }
    if (l.aim?.target === oldName) next = { ...next, aim: { ...l.aim, target: newName } }
    return next
  })
  const joints = geometry.joints.map((j): RigJoint => (j.link === oldName ? { ...j, link: newName } : j))
  return { links, joints }
}

/**
 * Does a behavior script mention a joint (or any rig name) at all? This is the crudest test: the name appearing
 * anywhere in the source, comments included. It guards a rename that does not rewrite the script. A joint is commanded as `ctx.setJoint('shoulder', …)`, as `ctx.joints.shoulder`, as
 * `ctx.measured.joints.shoulder`, and declared in `definePart({ joints: [...] })`, and a literal-only rewrite like
 * {@link renameRigNameRefs} would miss the property forms and leave a joint that silently stops moving. A false
 * "mentioned" only keeps a name read-only; a false "not mentioned" would break a part.
 */
export function behaviorMentions(source: string, name: string): boolean {
  return name !== '' && source.includes(name)
}

/**
 * Rename one rig joint (its `name`, the identifier the behavior commands it by). Nothing else in a rig points at
 * a joint by name - joints point at links - so the geometry half is just the joint itself. Returns the rewritten
 * joints, or `null` for a no-op or invalid rename: a blank/unchanged name, an unknown joint, or a name another
 * joint already has. The script half is the caller's: it may only rename a joint the script never mentions
 * ({@link behaviorMentions}). Pure (core), like {@link renameRigLink}.
 */
export function renameRigJoint(joints: readonly RigJoint[], oldName: string, rawName: string): RigJoint[] | null {
  const newName = rawName.trim()
  if (newName === '' || newName === oldName) return null
  if (!joints.some((j) => j.name === oldName)) return null
  if (joints.some((j) => j.name === newName)) return null
  return joints.map((j) => (j.name === oldName ? { ...j, name: newName } : j))
}

/**
 * The guarded other half of a rig-link rename ({@link renameRigLink} handles geometry): rewrite references to
 * the link by name in a behavior script. A link name reaches behavior only as a string argument -
 * `setGrip('hand', …)`, `setSubPose('hand', …)` - so only whole-string-literal occurrences of `oldName` are
 * rewritten (`'oldName'`, `"oldName"`, or a template whose entire content is the name), quote style preserved.
 * A bare identifier, a substring (`'hand-tip'`) or a built name is left alone: a wrong rewrite of freeform JS is
 * worse than a missed one, which is why the caller applies this only behind an explicit confirm. Returns the
 * rewritten source plus the match `count` so the caller can decide whether to prompt. Pure + portable (core).
 */
/**
 * Filename-safe form of a package id, for `public/thumbnails/pkg/<file>.webp` - the catalog card's image and
 * the boot warm both resolve a card's thumbnail through this, so they cannot disagree about where it lives.
 *
 * `scripts/gen-thumbnails.mjs` keeps a hand-copied mirror of this rule (a plain .mjs cannot import the TS):
 * change both together, or a card 404s and silently falls back to the offscreen renderer.
 */
export function packageThumbFile(id: string): string {
  return id.replace(/[^a-z0-9._-]/gi, '_')
}

/**
 * Every lamp name a rig offers the behavior: each link's {@link RigLink.lamps} (named, else the link's name)
 * plus the lamps its geometry() draws. The only complete answer to "is `ctx.lamps.x` a real lamp?", which is
 * why the typo guard (sim/validatePart.ts) asks here.
 */
export function rigLampNames(geometry: PartPackageGeometry | undefined, drawnLamps: Iterable<string> = []): Set<string> {
  // drawnLamps: the lamps the part's geometry() draws (core/geometry/geometryEval geometryLampNames) - a code-built lamp
  const out = new Set<string>(drawnLamps)
  if (!geometry || geometry.kind !== 'rig') return out
  for (const link of geometry.links) for (const lamp of link.lamps ?? []) out.add(lamp.name ?? link.name)
  return out
}

/**
 * The rig links a behavior script can move at runtime through `ctx.setSubPose`: the static half of
 * "is this link really static?", read by the render layer to keep such a link out of the scene-global
 * instance pool. A jointless rig's meshes otherwise merge across parts with world matrices baked at rebuild,
 * so a per-tick subPose (the push button's cap depressing) would leave the merged copy drawing the rest pose.
 * Joints and `aim` are declared in the geometry; a subPose is named only in the script, hence this read.
 *
 * Same whole-string-literal convention as {@link renameRigNameRefs}. A call whose first argument is not a plain
 * literal can't be resolved statically, so it sets `unresolved` and the caller must treat every link as movable:
 * over-excluding costs a merged draw, under-excluding renders a part visibly stuck. Pure + portable (core), so
 * both shells decide this identically.
 */
export function subPosedLinkNames(source: string | undefined): { names: Set<string>; unresolved: boolean } {
  const names = new Set<string>()
  let unresolved = false
  if (!source) return { names, unresolved }
  // every `setSubPose(` call site, capturing its first argument only when it's a whole string literal
  for (const m of source.matchAll(/setSubPose\s*\(\s*(?:(['"`])([^'"`]*)\1)?/g)) {
    const name = m[2]
    // a template with a substitution (`${x}`) is a literal to the regex but a dynamic name in fact
    if (name === undefined || name.includes('${')) unresolved = true
    else names.add(name)
  }
  return { names, unresolved }
}

export function renameRigNameRefs(source: string, oldName: string, newName: string): { source: string; count: number } {
  const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // ([quote]) <oldName> \1 - the backreference forces matching open/close quotes and the anchored content
  // forces a whole-literal (not substring) match across all three JS string-literal forms.
  const re = new RegExp('([\'"`])' + esc + '\\1', 'g')
  let count = 0
  const out = source.replace(re, (_m, q: string) => {
    count++
    return q + newName + q
  })
  return { source: out, count }
}

/** A part's geometry - `kind` discriminates. Each kind is its own interface below so its rules are documented
 *  where an author (or an editor hover) looks. */
export type PartPackageGeometry = RigGeometry | DrawnGeometry | CargoGeometry

/** The part's footprint box (m) - what the Inspector, snapping and placement use without running code. `length`
 *  runs along local X, `width` along Z, centred on the origin unless `centerX` / `centerZ` move the box; y spans
 *  [`bottom`, `top`] in the part's own frame. So an imported model belongs with its XZ centre on the origin (offset
 *  its links, or use a mesh's `fitHeight`), or declares where its centre is. Package format 3 spelled the vertical
 *  extent `height` (above the origin) and `floorY` (below it). */
export interface PartBounds {
  length: number
  width: number
  /** the highest point, y in the part's frame (above the origin for a floor-standing part) */
  top: number
  /** the lowest point, y in the part's frame; default 0 (a floor-standing part whose origin is its underside). A
   *  conveyor-mounted rig (blade stop, chain transfer) has its origin at the belt surface and its housing hanging
   *  below, so its bottom is negative: a free-standing drop rests that underside on the floor instead of sinking
   *  the origin to it. */
  bottom?: number
  /** the box's centre along local X, m from the origin (default 0): a part whose origin is not its middle, like a
   *  pusher whose origin sits on the guard it mounts to */
  centerX?: number
  /** the box's centre along local Z, m from the origin (default 0) */
  centerZ?: number
  /** param-driven fields, so the box follows the part's own size params: each entry replaces one field with
   *  `params[param] [× mulParam] × scale + add`, clamped to `[min, max]`, the same rule as a link's `sizeParams`.
   *  The static fields above are what stands while the param is missing, and what a host that cannot see params
   *  reads. A resolved length or width must be positive and a resolved top above the bottom, or that field keeps
   *  its static value. An axis with a `face` resize handle reads the handle's param instead. */
  params?: BoundsParamRef[]
}

/** One {@link PartBounds.params} entry: the bounds `field` it drives, and the param it is a linear map of. */
export interface BoundsParamRef {
  field: 'length' | 'width' | 'top' | 'bottom' | 'centerX' | 'centerZ'
  /** the instance param name whose (numeric) value drives the field */
  param: string
  /** multiply by a second param's value before `scale`/`add` */
  mulParam?: string
  /** multiply the param value (default 1) */
  scale?: number
  /** add after scaling (default 0) */
  add?: number
  /** clamp the resolved value from below (after scale+add) */
  min?: number
  /** clamp the resolved value from above (after scale+add) */
  max?: number
}

/** A cargo box's size (m), centred on its origin: `length` along X, `height` along Y, `width` along Z. */
export interface CargoSize {
  length: number
  width: number
  height: number
}

/** A multi-body rig: a tree of links + kinematic joints (robots, gates, AGVs, imported devices). */
export interface RigGeometry {
  kind: 'rig'
  links: RigLink[]
  joints: RigJoint[]
  /** Opts the rig into the in-scene teach-by-pose gizmo (joint rings + IK end-effector handle, shown whenever the
   *  placed part is selected: pose the arm, then Inspector → Capture Pose). Set it only for manipulators you
   *  hand-teach (robot / gantry / AGV lift). Leave it off for parts whose joints are driven by the sim/PLC (safety
   *  gate, diverter, blade-stop, turntable); an interactive pose gizmo there is a false affordance. Omitted/false
   *  = no in-scene pose gizmo (the joints still articulate; FK/sim are unaffected). */
  posable?: boolean
  /** Marks the rig a whole-bed incline conveyor: names a `number` param (degrees) that tilts the whole bed about
   *  the rig root, around local +Z (cross-bed), so the +X head lifts by run·sin while the origin stays put
   *  The host tilts render + collision from the one param, regrows the trestle legs
   *  to the floor, and carries cargo up the slope. `leg` links stay vertical. Omitted = flat. */
  inclineParam?: string
  /** clamps `inclineParam` (default 30 - rollers shed product on a steep grade, unlike belts) */
  maxInclineDeg?: number
  /** The footprint box ({@link PartBounds}); omitted = a unit box until the author declares one. */
  bounds?: PartBounds
}

/** Procedural geometry from the behavior's `geometry(g, params)` callback (Tier 2 in the part authoring guide),
 *  for shapes the static `mesh` sweep can't list (a bent multi-segment belt, a lofted or revolved profile).
 *  The shape lives in code: the host runs `geometry()` to get a MeshDescription and runs it again on a param
 *  change. `bounds` is the baked footprint, so the Inspector, snapping and placement work without running code.
 *  `conveys` marks it a powered conveyor surface (the sim builds a deck body sized to `bounds`). `material`
 *  optionally overrides the surface. */
export interface DrawnGeometry {
  kind: 'drawn'
  bounds: PartBounds
  material?: string
  conveys?: boolean
}

/** Dynamic cargo: the part is a piece of cargo, not a machine. The host builds one dynamic body for
 *  it and the part goes through the same pipeline as the built-in box and pallet. `cargoKind` picks the physics and
 *  visual family: 'box' (size from the instance's length/height/width params, falling back to `size`, drawn with the
 *  shared Box model), 'pallet' (a block pallet at the footprint its `size` param picks) or 'tote' (an open-top
 *  plastic container at the standard size its `size` param picks). Centre origin, like the built-ins. The behavior
 *  is passive by convention (an empty step), because cargo is payload. */
export interface CargoGeometry {
  kind: 'cargo'
  cargoKind: 'box' | 'pallet' | 'tote'
  /** the box, centred (package format 3 called it `bounds`) */
  size: CargoSize
}

/** A mark a machine leaves on cargo (ctx.mark): a small fact other parts can read (ctx.marked, a beam's hit). */
export type CargoMarkValue = number | boolean | string


/**
 * What kind of conveyor a part is, declared (package format 4; format 3 inferred it from drag handles). Only a
 * declared conveyor is one to its neighbours: guard openings where another conveyor butts it, end-to-end and
 * side-merge snapping, deck merging, and the host's matching of guards and roller grids where two conveyors meet.
 *
 * - `bed`: the shape of the conveying bed, which decides how neighbours meet it. Each kind names the declaration
 *   that gives its geometry, and a missing one is a validation error:
 *   - `'straight'`: a centre-origin rectangle, sized by the `number` params carrying `face` handles on x (length)
 *     and z (width). The roller conveyor.
 *   - `'spur'`: a straight bed whose ends splay: the length face handle also names `angleFrontParam` /
 *     `angleBackParam`. The spur conveyors.
 *   - `'path'`: a tail-origin bent belt, its segments edited by a `path` handle. The belt conveyor.
 *   - `'arc'`: a curve, swept by an `arc` handle. The curved conveyors.
 *   - `'turntable'`: a deck turning on a revolute joint whose link is a cylinder (its rim is where neighbours butt).
 *   Omit `bed` for a part that conveys but is not a conveyor to its neighbours (a powered deck inside a machine).
 * - `surface`: what cargo rides on, which sets its grip: `'belt'` when cargo rests on a surface that moves with it (a
 *   belt, slats, a mat-top chain), `'roller'` when it rides over rollers or wheels that turn under it (also the
 *   default for a conveying part that declares no `conveyor`).
 * - `speedParam`: the `number` param that is the conveying speed (m/s, negative = reverse). The host mirrors it
 *   outside the behavior's tick (belt scroll and roller spin, the flow arrow, the pilot riding the surface, a
 *   spawner's "is my conveyor running" before the first tick); without it those stay still until the behavior runs.
 * - `reverseParam`: a hidden `boolean` param the snap flips to turn a curve's flow around when it mates two ends
 *   that both discharge into the junction (rotating a curve 180 degrees would swap its radii). The effective speed
 *   is `speed x (reverse ? -1 : 1)`; the behavior folds it the same way.
 *
 * The handles are only the viewport's drag affordances; they don't decide what a part is.
 */
export interface ConveyorDecl {
  bed?: 'straight' | 'spur' | 'path' | 'arc' | 'turntable'
  surface: 'belt' | 'roller'
  speedParam?: string
  reverseParam?: string
}

export interface PartPackage {
  /** package format version, the literal of PACKAGE_FORMAT (spelled out, not `typeof`: the generated SDK carries
   *  this file's types but not its constants). A stored package of an older one is carried forward by
   *  upgradeStoredPackage; see PACKAGE_UPGRADES for when to bump it. */
  format: 6
  /** stable globally-unique id, e.g. "acme.spiral-belt" */
  id: string
  /** display name in the catalog */
  name: string
  /** optional catalog grouping */
  category?: string
  /** exported params, baked from the behavior's definePart (so importers show the Inspector without running code) */
  params: ParamSchema
  /** the behavior script source - an import-free script that calls definePart(...) */
  behavior: string
  /** collision/visual footprint */
  geometry: PartPackageGeometry
  /** embedded GLB meshes referenced by mesh shapes (by id); absent when the part uses only primitives */
  assets?: PartAsset[]
  /** PBR materials a mesh shape can reference (by id) to override its GLB's own material */
  materials?: PartMaterial[]
  /** optional data-URL thumbnail for the catalog */
  thumbnail?: string
  /** The behavior reads `ctx.used()` (declared `interactive: true`), so the editor offers a
   *  "Use" prompt and routes a pilot-mode click to it. Baked from the behavior when the package is built. */
  interactive?: boolean
  /** The boolean param that is the device's hand state (declared `useParam`): the state a run starts from, set
   *  in the Inspector; Use never writes it, and step() reports its live value. Baked + validated at package build. */
  useParam?: string
  /** This part is a unit load product type (definePart `unit`): its children are one load. Baked from the behavior. */
  unit?: UnitLoadDecl
  /** Declarative snap features - the connection geometry the editor's snap engine matches across parts (a device's
   *  mount onto a host surface). Declared in the manifest. See {@link SnapSpec}. */
  snap?: SnapSpec
  /** what kind of conveyor this part is, if any ({@link ConveyorDecl}) */
  conveyor?: ConveyorDecl
  /** the `boolean` param that switches this part's PLC link: while it is false the part's tags are disconnected
   *  (it runs on its authored params), and the PLC panel's comms toggle writes it. Omit it and the part's tags are
   *  always connected. Package format 3 read a param named `enableComms` for this. */
  commsParam?: string
  /** the cargo this part stores, held on its grippers ({@link HoldsDecl}) */
  holds?: HoldsDecl
  /** this part is cargo with its own body: its rig moves as one rigid body ({@link CargoDecl}) */
  cargo?: CargoDecl
  /** Where this project's copy came from ({@link PartOrigin}). Absent on a part made here, and on a copy made before
   *  these records existed. */
  origin?: PartOrigin
  /** Who made it, for a copy from a part library ({@link PartCredit}). Written by the app, never by the part. */
  credit?: PartCredit
  /** The Part SDK level this part was last changed under ({@link PartSdkStamp}), written by the app. */
  sdk?: PartSdkStamp
}

/**
 * Who made a part a project copied from a part library, kept with the copy so the credit goes wherever the part does
 * (an exported project, a room, a part file). Its models are under CC BY 4.0, whose one condition is attribution, and
 * the people who publish parts should be named where they are used. Written by the app from the library's listing:
 * `by` is the publisher the parts repository's checks confirmed (a GitHub account or organization), or the Open
 * Industry Project for the project's own libraries. Not part of what the part is (its fingerprint leaves it out), so
 * a credit never makes a copy read as edited. Kept through edits and Save as New Part, since a changed part is still
 * based on the publisher's work.
 */
export interface PartCredit {
  /** the publisher; absent for a library that names none */
  by?: string
  /** the library's name, e.g. "Community" */
  library: string
  /** where to find the publisher: their GitHub page, or the project's site */
  url?: string
}

/**
 * The Part SDK level a part was last changed under, written by the app. An app older than `level`
 * may lack something the part uses, so it warns. `of` is the part's fingerprint when it was stamped: the stamp only
 * counts while the part is unchanged, so an edit made by an app that does not stamp never keeps an old level.
 */
export interface PartSdkStamp {
  level: number
  of: string
}

/**
 * Cargo with its own body: declared on a `rig` geometry, it makes the part payload that moves
 * as one rigid body, the way a box, pallet or tote does, but with the rig's own shape. Its collider is the rig's
 * colliding links at rest pose (a box per box link, a round cylinder per cylinder link, so a drum rolls), and it draws
 * as its own rig. The rig has no joints, and its links' bounds are centred on the part's origin, like every cargo.
 *
 * - `friction`: the body's friction (default 0.5, a box's).
 * - `massParam`: the `number` param that is its mass in kg (default `mass`; 10 kg when the part has no such param).
 * - `colorParam`: the colour param that tints it (default `color`).
 *
 * What it is, to the machines around it (each is off unless declared). A built-in box, pallet or tote that declares
 * none has the ones its kind always had:
 * - `forkPockets`: it has a block pallet's fork channels at its footprint, so forks that take it are told when their
 *   spread does not fit a face. A pallet's.
 * - `heavy`: it bears loads (a pallet under a stack). The physics solver works harder on it so a stack does not sink
 *   into it, and it is never counted as dropped or tipped. A pallet's.
 * - `loadBase`: a load is wrapped from it (a stretch wrapper's film starts at its mid-height), and
 *   it anchors a unit load before any other piece. A pallet's.
 * - `separateContacts`: its sub-shapes keep their own contacts, so a floor that hovers over its foot does not sink
 *   into what it stands on. A tote's.
 * - `nestDepth`: a body of its shape set on it sits this far lower than its height (m), its foot inside the rim
 *   below. A stacking tote's foot.
 */
export interface CargoDecl {
  friction?: number
  massParam?: string
  colorParam?: string
  forkPockets?: boolean
  heavy?: boolean
  loadBase?: boolean
  separateContacts?: boolean
  nestDepth?: number
}

/** Is this package cargo: a box, pallet or tote (`geometry.kind: 'cargo'`), or a rig with its own cargo body? */
export function isCargoPackage(pkg: Pick<PartPackage, 'geometry' | 'cargo'>): boolean {
  return pkg.geometry.kind === 'cargo' || (pkg.cargo !== undefined && pkg.geometry.kind === 'rig')
}

/**
 * Where a project's copy of a part came from, per source: the fingerprint of the version that
 * source had when the copy was made, so the app can tell whether the source, this project, or both have changed it
 * since. One copy can have more than one: a project's version of a built-in that is also on
 * the shelf. Package format 5 spelled `app` as `basedOn` and `shelf` as `fromShelf`.
 *
 * - `app`: this is a project's own version of the built-in part of the same id, or, with
 *   `appPart`, of the built-in `appPart` names: a variant made from it under its own id ("Save as a New Part").
 * - `appPart`: the id of the built-in a variant was made from. Absent on a copy of the same id.
 * - `shelf`: this was copied from the parts shelf.
 * - `library`: this was installed from a part library. Read through the index signature.
 *
 * A key this build does not know is kept and ignored, so a later source does not make an older build refuse the part.
 */
export interface PartOrigin {
  app?: string
  appPart?: string
  shelf?: string
  [source: string]: string | undefined
}

/**
 * The cargo a part stores: a magazine, a buffer, a rack position. The stored items are real cargo held on the part's
 * grippers, one per position (never despawned and remade), so what a run starts with is authored like any other
 * cargo: parts of `part` placed at the positions, parented to the holder. The editor's Fill / Empty place and remove
 * them; the behavior grips what it finds there when the run starts.
 *
 * - `part`: the package id of the cargo part a position holds (`'oip.pallet'`).
 * - `positions`: gripper link names, bottom first (the order they fill in). Each must be a rig link with a
 *   `grip.zone`; the item stands at the zone's centre, at the part's rest pose.
 * - `limitParam`: a `number` param capping how many positions are in use (a magazine's capacity). Absent = all.
 * - `params`: params Fill gives each item it places, from the holder's own: `{ size: 'palletSize' }` places pallets
 *   of the size the magazine is set to. Item param name -> holder param name.
 */
export interface HoldsDecl {
  part: string
  positions: string[]
  limitParam?: string
  params?: Record<string, string>
}

/** What a unit load stored before it declared its pieces ({@link UnitLoadDecl.pieces}) stacks. */
const UNDECLARED_UNIT_PIECES = { pallet: 'oip.pallet', case: 'oip.box' } as const

/** The pallet and case parts a unit load that stacks itself is made of; undefined when `pkg` is not a unit load. */
export function unitPiecesOf(pkg: PartPackage): { pallet: string; case: string } | undefined {
  return pkg.unit ? (pkg.unit.pieces ?? UNDECLARED_UNIT_PIECES) : undefined
}

/**
 * The other parts `pkg` names, by package id: the cargo it holds ({@link HoldsDecl}), a unit load's pieces, and the
 * default of each product param ({@link productRefsOf} covers what an instance sets instead). A project that uses
 * `pkg` needs them too, so it holds copies of them (docs/part-sources.md).
 */
export function packageDependencies(pkg: PartPackage): string[] {
  const out: string[] = []
  if (pkg.holds) out.push(pkg.holds.part)
  const pieces = unitPiecesOf(pkg)
  if (pieces) out.push(pieces.pallet, pieces.case)
  for (const spec of Object.values(pkg.params)) {
    if (spec.type === 'string' && spec.product === true && typeof spec.default === 'string' && spec.default) out.push(spec.default)
  }
  return [...new Set(out)].filter((id) => id !== pkg.id)
}

/** The products an instance of `pkg` names in its product params ({@link ParamSpec.product}): its own values, else
 *  the defaults. A spawner set to make totes needs the tote in the project, and in the run. */
export function productRefsOf(params: Readonly<Record<string, unknown>>, pkg: PartPackage): string[] {
  const out: string[] = []
  for (const [key, spec] of Object.entries(pkg.params)) {
    if (spec.type !== 'string' || spec.product !== true) continue
    const v = params[key] ?? spec.default
    if (typeof v === 'string' && v && v !== pkg.id) out.push(v)
  }
  return out
}

export interface PackageProblem {
  field: string
  message: string
}

/** Structural validation of an untrusted, imported package. Returns [] when OK. */
export function validatePartPackage(pkg: unknown): PackageProblem[] {
  const problems: PackageProblem[] = []
  const p = pkg as Partial<PartPackage> | null | undefined
  const need = (cond: boolean, field: string, message: string): void => {
    if (!cond) problems.push({ field, message })
  }
  const format = (p as { format?: unknown } | null | undefined)?.format
  need(
    format === PACKAGE_FORMAT,
    'format',
    typeof format === 'number' && format > PACKAGE_FORMAT
      ? `saved by a newer version (package format ${format}; this build reads up to ${PACKAGE_FORMAT})`
      : `unsupported or missing package format (expected ${PACKAGE_FORMAT})`,
  )
  need(typeof p?.id === 'string' && p.id.length > 0, 'id', 'id must be a non-empty string')
  need(typeof p?.name === 'string' && p.name.length > 0, 'name', 'name must be a non-empty string')
  need(typeof p?.behavior === 'string' && p.behavior.length > 0, 'behavior', 'behavior source is required')
  need(!!p?.params && typeof p.params === 'object', 'params', 'params schema is required (may be empty)')
  const assetIds = validateAssets((p as { assets?: unknown } | undefined)?.assets, problems)
  const materialIds = validateMaterials((p as { materials?: unknown } | undefined)?.materials, problems, assetIds)
  const g = p?.geometry as { kind?: unknown; length?: unknown; width?: unknown } | undefined
  if (g?.kind === RETIRED_SWEEP_KIND) need(false, 'geometry.kind', `geometry.kind "${RETIRED_SWEEP_KIND}" (a swept bed) was retired: ${RETIRED_SWEEP_ADVICE}`)
  else if (g?.kind === 'function') need(false, 'geometry.kind', 'geometry.kind "function" was renamed "drawn" (package format 4)')
  else if (g?.kind === 'deck') need(false, 'geometry.kind', 'geometry.kind "deck" was retired (package format 4): a rig with one `conveys` box link is the same conveyor, and can resize')
  else need(!!g && (g.kind === 'rig' || g.kind === 'drawn' || g.kind === 'cargo'), 'geometry', 'geometry.kind must be "rig", "drawn" or "cargo"')
  if (g && g.kind === 'rig') {
    if ((g as { bounds?: unknown }).bounds !== undefined) validateBounds((g as { bounds?: unknown }).bounds, problems)
    validateRig(g as { links?: unknown; joints?: unknown }, problems, assetIds, materialIds)
  } else if (g && g.kind === 'drawn') {
    validateDrawnGeometry(g as { bounds?: unknown; material?: unknown; conveys?: unknown }, problems, materialIds)
  } else if (g && g.kind === 'cargo') {
    validateCargoGeometry(g as { cargoKind?: unknown; bounds?: unknown }, problems)
  }
  validateSnap((p as { snap?: unknown } | undefined)?.snap, problems)
  validateConveyor(p as Record<string, unknown> | undefined, problems)
  validateSetpoints(p?.params, problems)
  validateTagSignals(p?.params, problems)
  validateAttributes(p?.params, problems)
  validateUnit(p, problems)
  validateHolds(p, problems)
  validateCargoDecl(p as Record<string, unknown> | undefined, problems)
  const origin = (p as { origin?: unknown } | undefined)?.origin
  need(
    origin === undefined || (!!origin && typeof origin === 'object' && !Array.isArray(origin) && Object.values(origin).every((v) => typeof v === 'string' && v !== '')),
    'origin',
    'origin must map each source to a non-empty fingerprint string',
  )
  const credit = (p as { credit?: unknown } | undefined)?.credit
  need(credit === undefined || isPartCredit(credit), 'credit', 'credit must name a library, and may name who made the part and an https link')
  return problems
}

/** A holds declaration names a cargo package, its own gripper links (each with a grip zone), and a number param. */
/**
 * A part's `cargo` declaration ({@link CargoDecl}): only on a rig with no joints, and its named params of the right
 * type. Whether the rig has a colliding link centred on its origin is the author's check (sim/validatePart.ts), so a
 * stored part is never dropped for it.
 */
function validateCargoDecl(p: Record<string, unknown> | undefined, problems: PackageProblem[]): void {
  const c = p?.cargo
  if (c === undefined) return
  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    problems.push({ field: 'cargo', message: 'cargo must be an object: { friction?, massParam?, colorParam?, forkPockets?, heavy?, loadBase?, separateContacts?, nestDepth? }' })
    return
  }
  const geo = p?.geometry as { kind?: unknown; joints?: unknown } | undefined
  if (geo?.kind !== 'rig') problems.push({ field: 'cargo', message: 'cargo is declared on a rig geometry: its links are the cargo body' })
  else if (Array.isArray(geo.joints) && geo.joints.length > 0) problems.push({ field: 'cargo', message: 'cargo moves as one rigid body, so its rig has no joints' })
  const d = c as { friction?: unknown; massParam?: unknown; colorParam?: unknown; nestDepth?: unknown } & Record<string, unknown>
  if (d.friction !== undefined && !(typeof d.friction === 'number' && Number.isFinite(d.friction) && d.friction >= 0)) {
    problems.push({ field: 'cargo.friction', message: 'cargo.friction must be a number >= 0' })
  }
  for (const flag of ['forkPockets', 'heavy', 'loadBase', 'separateContacts'] as const) {
    if (d[flag] !== undefined && typeof d[flag] !== 'boolean') problems.push({ field: `cargo.${flag}`, message: `cargo.${flag} must be true or false` })
  }
  if (d.nestDepth !== undefined && !(typeof d.nestDepth === 'number' && Number.isFinite(d.nestDepth) && d.nestDepth > 0)) {
    problems.push({ field: 'cargo.nestDepth', message: 'cargo.nestDepth must be a number > 0 (m)' })
  }
  const params = (p?.params ?? {}) as Record<string, { type?: unknown } | undefined>
  for (const [field, type, fallback] of [['massParam', 'number', 'mass'], ['colorParam', 'color', 'color']] as const) {
    const name = d[field]
    if (name !== undefined && (typeof name !== 'string' || name === '')) {
      problems.push({ field: `cargo.${field}`, message: `cargo.${field} must name a param` })
      continue
    }
    const key = typeof name === 'string' ? name : fallback
    const spec = params[key]
    if (spec !== undefined ? spec.type !== type : name !== undefined) {
      problems.push({ field: `cargo.${field}`, message: `cargo.${field} must name a \`${type}\` param of this part` })
    }
  }
}

function validateHolds(p: Partial<PartPackage> | null | undefined, problems: PackageProblem[]): void {
  const h = (p as { holds?: unknown } | null | undefined)?.holds as { part?: unknown; positions?: unknown; limitParam?: unknown; params?: unknown } | undefined
  if (h === undefined) return
  if (!h || typeof h !== 'object') {
    problems.push({ field: 'holds', message: 'holds must be an object: { part, positions, limitParam? }' })
    return
  }
  if (typeof h.part !== 'string' || !h.part) problems.push({ field: 'holds.part', message: "holds.part must name the cargo part's package id" })
  const geo = p?.geometry as { kind?: unknown; links?: { name?: unknown; grip?: { zone?: unknown } }[] } | undefined
  const gripping = new Set((geo?.kind === 'rig' ? (geo.links ?? []) : []).filter((l) => l.grip?.zone).map((l) => l.name))
  if (!Array.isArray(h.positions) || h.positions.length === 0) problems.push({ field: 'holds.positions', message: 'holds.positions must list one or more gripper links, bottom first' })
  else
    h.positions.forEach((n: unknown, i: number) => {
      if (typeof n !== 'string' || !gripping.has(n)) problems.push({ field: `holds.positions[${i}]`, message: `must name a rig link with a grip.zone (got ${JSON.stringify(n)})` })
    })
  if (h.limitParam !== undefined) {
    const spec = typeof h.limitParam === 'string' ? (p?.params as Record<string, { type?: unknown } | undefined> | undefined)?.[h.limitParam] : undefined
    if (spec?.type !== 'number') problems.push({ field: 'holds.limitParam', message: 'holds.limitParam must name a `number` param of this part' })
  }
  if (h.params !== undefined) {
    const own = (p?.params ?? {}) as Record<string, unknown>
    if (!h.params || typeof h.params !== 'object' || Array.isArray(h.params)) problems.push({ field: 'holds.params', message: "holds.params must map an item param to one of this part's params, e.g. { size: 'palletSize' }" })
    else
      for (const [k, v] of Object.entries(h.params as Record<string, unknown>)) {
        if (typeof v !== 'string' || !Object.hasOwn(own, v)) problems.push({ field: `holds.params.${k}`, message: `must name a param of this part (got ${JSON.stringify(v)})` })
      }
  }
}

/** A unit-load declaration names its own params and materials; each must exist and be of the kind it is used as. */
function validateUnit(p: Partial<PartPackage> | null | undefined, problems: PackageProblem[]): void {
  const u = (p as { unit?: unknown } | null | undefined)?.unit as { joinWhen?: unknown; dress?: unknown; pieces?: unknown } | undefined
  if (u === undefined) return
  if (!u || typeof u !== 'object') {
    problems.push({ field: 'unit', message: 'unit must be an object' })
    return
  }
  const params = (p?.params ?? {}) as Record<string, { type?: unknown } | undefined>
  const need = (field: string, name: unknown, type: string): void => {
    if (name === undefined) return
    if (typeof name !== 'string' || params[name]?.type !== type) problems.push({ field, message: `must name a ${type} param (got ${JSON.stringify(name)})` })
  }
  need('unit.joinWhen', u.joinWhen, 'boolean')
  if (u.pieces !== undefined) {
    const pc = u.pieces as { pallet?: unknown; case?: unknown } | null
    if (!pc || typeof pc !== 'object' || typeof pc.pallet !== 'string' || pc.pallet === '' || typeof pc.case !== 'string' || pc.case === '') {
      problems.push({ field: 'unit.pieces', message: 'pieces names a pallet and a case part by package id' })
    }
  }
  if (u.dress === undefined) return
  if (!Array.isArray(u.dress)) {
    problems.push({ field: 'unit.dress', message: 'dress must be an array' })
    return
  }
  const mats = new Set((p?.materials ?? []).map((m) => m.id))
  u.dress.forEach((d: unknown, i: number) => {
    const at = `unit.dress[${i}]`
    const x = d as { id?: unknown; material?: unknown; when?: unknown; colorParam?: unknown; opacityParam?: unknown } | null
    if (!x || typeof x.id !== 'string' || !x.id) problems.push({ field: `${at}.id`, message: 'a dressing needs an id' })
    if (!x || typeof x.material !== 'string' || !mats.has(x.material)) problems.push({ field: `${at}.material`, message: "a dressing names one of this package's materials" })
    if (!x) return
    need(`${at}.when`, x.when, 'boolean')
    need(`${at}.colorParam`, x.colorParam, 'color')
    need(`${at}.opacityParam`, x.opacityParam, 'number')
  })
}

/** A param flagged `attribute` is a product fact (a mark), so it must be one of the kinds a mark can hold. */
function validateAttributes(params: unknown, problems: PackageProblem[]): void {
  if (!params || typeof params !== 'object') return
  for (const [key, spec] of Object.entries(params as Record<string, { type?: unknown; attribute?: unknown } | undefined>)) {
    if (!spec || spec.attribute === undefined) continue
    if (typeof spec.attribute !== 'boolean') problems.push({ field: `params.${key}.attribute`, message: 'attribute must be a boolean' })
    else if (spec.attribute && spec.type !== 'boolean' && spec.type !== 'number' && spec.type !== 'string') {
      problems.push({ field: `params.${key}.attribute`, message: 'only a boolean, number or string param can be a product attribute' })
    }
  }
}

/**
 * A `'tag'` param's `setpointFor` must name a declared `'number'` param - the value it replaces while bound.
 * The host trusts that link blindly (it swaps the live commanded value into that field), so a typo has to be
 * a build error rather than a silently dead readout. Same-units is a contract the validator can't check.
 */
function validateSetpoints(params: unknown, problems: PackageProblem[]): void {
  if (!params || typeof params !== 'object') return
  const schema = params as Record<string, { type?: unknown; setpointFor?: unknown } | undefined>
  for (const key of Object.keys(schema)) {
    const spec = schema[key]
    if (!spec || spec.setpointFor === undefined) continue
    if (spec.type !== 'tag') {
      problems.push({ field: `params.${key}.setpointFor`, message: 'setpointFor is only valid on a tag param' })
    } else if (typeof spec.setpointFor !== 'string' || schema[spec.setpointFor]?.type !== 'number') {
      problems.push({
        field: `params.${key}.setpointFor`,
        message: `must name a number param (got ${JSON.stringify(spec.setpointFor)})`,
      })
    }
  }
}

/**
 * A `'tag'` param's declared signal: `dir` (which way it flows, from the part's perspective) and `stType`
 * (what it carries). The pair is the part's machine-readable PLC interface, so a half-declared or misspelled
 * one has to fail rather than silently drop out of the catalog: a direction with no type can't be typed into ST,
 * and a type with no direction can't be wired. Neither is accepted here, though an authored part must declare
 * both (core/parts/partAuthoringChecks.ts): this validator also judges stored packages, and one saved before that rule
 * is not worth dropping a placed part over. The wiring check reports it as `undeclared` instead (plc/wiring.ts).
 */
function validateTagSignals(params: unknown, problems: PackageProblem[]): void {
  if (!params || typeof params !== 'object') return
  const schema = params as Record<string, { type?: unknown; dir?: unknown; stType?: unknown } | undefined>
  for (const key of Object.keys(schema)) {
    const spec = schema[key]
    if (!spec || (spec.dir === undefined && spec.stType === undefined)) continue
    if (spec.type !== 'tag') {
      problems.push({ field: `params.${key}`, message: 'dir/stType are only valid on a tag param' })
      continue
    }
    if (spec.dir !== 'in' && spec.dir !== 'out') {
      problems.push({ field: `params.${key}.dir`, message: `must be 'in' or 'out' (got ${JSON.stringify(spec.dir)})` })
    }
    if (spec.stType !== 'BOOL' && spec.stType !== 'INT' && spec.stType !== 'DINT' && spec.stType !== 'REAL') {
      problems.push({ field: `params.${key}.stType`, message: `must be 'BOOL', 'INT', 'DINT' or 'REAL' (got ${JSON.stringify(spec.stType)})` })
    }
  }
}

/** Validate the optional declarative snap features ({@link SnapSpec}) - lenient: only present fields are checked. */
function validateSnap(snap: unknown, problems: PackageProblem[]): void {
  if (snap === undefined) return
  if (typeof snap !== 'object' || snap === null) {
    problems.push({ field: 'snap', message: 'snap must be an object' })
    return
  }
  const track = (snap as { track?: unknown }).track
  if (track !== undefined) {
    if (typeof track !== 'object' || track === null) {
      problems.push({ field: 'snap.track', message: 'snap.track must be an object' })
    } else {
      const fit = (track as { fitWidthParam?: unknown }).fitWidthParam
      if (fit !== undefined && (typeof fit !== 'string' || !fit)) {
        problems.push({ field: 'snap.track.fitWidthParam', message: 'track.fitWidthParam must be a non-empty param name' })
      }
      const fitScale = (track as { fitWidthScale?: unknown }).fitWidthScale
      if (fitScale !== undefined && (typeof fitScale !== 'number' || !Number.isFinite(fitScale) || fitScale <= 0)) {
        problems.push({ field: 'snap.track.fitWidthScale', message: 'track.fitWidthScale must be a positive finite number' })
      }
      const tly = (track as { targetLocalY?: unknown }).targetLocalY
      if (tly !== undefined && (typeof tly !== 'number' || !Number.isFinite(tly))) {
        problems.push({ field: 'snap.track.targetLocalY', message: 'track.targetLocalY must be a finite number' })
      }
      const lanes = (track as { lanes?: unknown }).lanes
      if (lanes !== undefined) {
        if (typeof lanes !== 'object' || lanes === null) {
          problems.push({ field: 'snap.track.lanes', message: 'track.lanes must be an object' })
        } else {
          const count = (lanes as { countParam?: unknown }).countParam
          if (typeof count !== 'string' || !count) {
            problems.push({ field: 'snap.track.lanes.countParam', message: 'track.lanes.countParam must be a non-empty param name' })
          }
          const pitch = (lanes as { pitchParam?: unknown }).pitchParam
          if (pitch !== undefined && (typeof pitch !== 'string' || !pitch)) {
            problems.push({ field: 'snap.track.lanes.pitchParam', message: 'track.lanes.pitchParam must be a non-empty param name' })
          }
        }
      }
    }
  }
  const surfaces = (snap as { surfaces?: unknown }).surfaces
  if (surfaces !== undefined) {
    if (!Array.isArray(surfaces)) {
      problems.push({ field: 'snap.surfaces', message: 'snap.surfaces must be an array' })
    } else {
      surfaces.forEach((s, i) => {
        for (const key of ['kind', 'lengthParam', 'widthParam'] as const) {
          const v = (s as Record<string, unknown>)?.[key]
          if (typeof v !== 'string' || !v) {
            problems.push({ field: `snap.surfaces[${i}].${key}`, message: `surface.${key} must be a non-empty string` })
          }
        }
        const hp = (s as { heightParam?: unknown })?.heightParam
        if (hp !== undefined && (typeof hp !== 'string' || !hp)) {
          problems.push({ field: `snap.surfaces[${i}].heightParam`, message: 'surface.heightParam must be a non-empty param name' })
        }
      })
    }
  }
  if ((snap as { edges?: unknown }).edges !== undefined) problems.push({ field: 'snap.edges', message: 'snap.edges was renamed snap.tile (package format 4)' })
  const tile = (snap as { tile?: unknown }).tile
  if (tile !== undefined) {
    if (typeof tile !== 'object' || tile === null) {
      problems.push({ field: 'snap.tile', message: 'snap.tile must be an object' })
    } else {
      for (const key of ['group', 'lengthParam', 'widthParam'] as const) {
        const v = (tile as Record<string, unknown>)[key]
        if (typeof v !== 'string' || !v) {
          problems.push({ field: `snap.tile.${key}`, message: `tile.${key} must be a non-empty string` })
        }
      }
      const cf = (tile as { cornerFlush?: unknown }).cornerFlush
      if (cf !== undefined && typeof cf !== 'boolean') {
        problems.push({ field: 'snap.tile.cornerFlush', message: 'tile.cornerFlush must be a boolean' })
      }
    }
  }
  const chain = (snap as { chain?: unknown }).chain
  if (chain !== undefined) {
    if (typeof chain !== 'object' || chain === null) {
      problems.push({ field: 'snap.chain', message: 'snap.chain must be an object' })
    } else {
      for (const key of ['group', 'lengthParam'] as const) {
        const v = (chain as Record<string, unknown>)[key]
        if (typeof v !== 'string' || !v) {
          problems.push({ field: `snap.chain.${key}`, message: `chain.${key} must be a non-empty string` })
        }
      }
      const reach = (chain as { reach?: unknown }).reach
      if (typeof reach !== 'number' || !Number.isFinite(reach) || reach <= 0) {
        problems.push({ field: 'snap.chain.reach', message: 'chain.reach must be a positive finite number' })
      }
      for (const key of ['omitStartParam', 'omitEndParam'] as const) {
        const v = (chain as Record<string, unknown>)[key]
        if (v !== undefined && (typeof v !== 'string' || !v)) {
          problems.push({ field: `snap.chain.${key}`, message: `chain.${key} must be a non-empty param name` })
        }
      }
    }
  }
  const edgeMount = (snap as { edgeMount?: unknown }).edgeMount
  if (edgeMount !== undefined) {
    if (typeof edgeMount !== 'object' || edgeMount === null) {
      problems.push({ field: 'snap.edgeMount', message: 'snap.edgeMount must be an object' })
    } else {
      for (const key of ['accepts', 'alongParam'] as const) {
        const v = (edgeMount as Record<string, unknown>)[key]
        if (typeof v !== 'string' || !v) {
          problems.push({ field: `snap.edgeMount.${key}`, message: `edgeMount.${key} must be a non-empty string` })
        }
      }
      const reach = (edgeMount as { reach?: unknown }).reach
      if (typeof reach !== 'number' || !Number.isFinite(reach) || reach <= 0) {
        problems.push({ field: 'snap.edgeMount.reach', message: 'edgeMount.reach must be a positive finite number' })
      }
      const oo = (edgeMount as { outwardOffset?: unknown }).outwardOffset
      if (oo !== undefined && (typeof oo !== 'number' || !Number.isFinite(oo))) {
        problems.push({ field: 'snap.edgeMount.outwardOffset', message: 'edgeMount.outwardOffset must be a finite number' })
      }
      validateEdgeMountReach(edgeMount as Record<string, unknown>, problems)
    }
  }
  if ((snap as { stairMount?: unknown }).stairMount !== undefined) {
    problems.push({
      field: 'snap.stairMount',
      message: "snap.stairMount was replaced (package format 3) by edgeMount { facing: 'into', at, atParams, fromFloor, opens, notch, lift }: see docs/part-snap-cuts.md",
    })
  }
  for (const key of RETIRED_SNAP_KINDS) {
    if ((snap as Record<string, unknown>)[key] !== undefined) {
      problems.push({ field: `snap.${key}`, message: `snap.${key} was retired before any part used it: remove it. ${RETIRED_SNAP_ADVICE}` })
    }
  }
  const mounts = (snap as { mounts?: unknown }).mounts
  if (mounts === undefined) return
  if (!Array.isArray(mounts)) {
    problems.push({ field: 'snap.mounts', message: 'snap.mounts must be an array' })
    return
  }
  mounts.forEach((m, i) => {
    const at = (m as { at?: unknown })?.at
    if (!Array.isArray(at) || at.length !== 3 || !at.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      problems.push({ field: `snap.mounts[${i}].at`, message: 'mount.at must be 3 finite numbers' })
    }
    if (typeof (m as { accepts?: unknown })?.accepts !== 'string' || !(m as { accepts: string }).accepts) {
      problems.push({ field: `snap.mounts[${i}].accepts`, message: 'mount.accepts must be a non-empty surface-kind string' })
    }
    // The rest of the mount surface. Each field degrades silently rather than failing: seatOnRail reads `face`
    // as `m.face !== 'out'`, so a misspelled 'outward' means inward (a diverter pushing the wrong way), and a
    // string offset propagates NaN into the pose.
    const face = (m as { face?: unknown }).face
    if (face !== undefined && face !== 'in' && face !== 'out') {
      problems.push({ field: `snap.mounts[${i}].face`, message: `mount.face must be 'in' or 'out' (got ${JSON.stringify(face)})` })
    }
    for (const key of ['outwardOffset', 'yOffset'] as const) {
      const v = (m as Record<string, unknown>)[key]
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
        problems.push({ field: `snap.mounts[${i}].${key}`, message: `mount.${key} must be a finite number` })
      }
    }
    const frp = (m as { fitRangeParam?: unknown }).fitRangeParam
    if (frp !== undefined && (typeof frp !== 'string' || !frp)) {
      problems.push({ field: `snap.mounts[${i}].fitRangeParam`, message: 'mount.fitRangeParam must be a non-empty param name' })
    }
    const attach = (m as { attach?: unknown }).attach
    if (attach !== undefined && typeof attach !== 'boolean') {
      problems.push({ field: `snap.mounts[${i}].attach`, message: 'mount.attach must be a boolean' })
    }
    const opens = (m as { opens?: unknown }).opens
    if (opens !== undefined && typeof opens !== 'boolean') {
      problems.push({ field: `snap.mounts[${i}].opens`, message: 'mount.opens must be a boolean' })
    }
  })
}

/** The options an edge mount adds for meeting a deck from the floor and cutting it (SnapEdgeMount). Structure only:
 *  that `fromFloor.param` drives an axis-1 `atParams` entry is checked here too, because the fit is solved from
 *  that entry and silently snaps nowhere without it. Param names are checked with the others (SNAP_PARAM_REFS). */
function validateEdgeMountReach(em: Record<string, unknown>, problems: PackageProblem[]): void {
  const add = (field: string, message: string): void => {
    problems.push({ field: `snap.edgeMount.${field}`, message })
  }
  const into = em.facing === 'into'
  if (em.facing !== undefined && em.facing !== 'along' && !into) add('facing', "edgeMount.facing must be 'along' or 'into'")
  if (em.at !== undefined && !isVec3(em.at)) add('at', 'edgeMount.at must be 3 finite numbers')
  const atParams = em.atParams
  if (atParams !== undefined) {
    if (!Array.isArray(atParams)) add('atParams', 'edgeMount.atParams must be an array')
    else {
      atParams.forEach((r: unknown, i: number) => {
        const ref = r as { axis?: unknown; param?: unknown; scale?: unknown; add?: unknown; min?: unknown; max?: unknown } | null
        if (!ref || ![0, 1, 2].includes(ref.axis as number)) add(`atParams[${i}].axis`, 'atParams axis must be 0, 1 or 2')
        if (!ref || typeof ref.param !== 'string' || !ref.param) add(`atParams[${i}].param`, 'atParams param must be a non-empty param name')
        for (const k of ['scale', 'add', 'min', 'max'] as const) if (ref?.[k] !== undefined && !isFiniteNum(ref[k])) add(`atParams[${i}].${k}`, `atParams ${k} must be a finite number`)
      })
    }
  }
  const fromFloor = em.fromFloor as { param?: unknown } | undefined
  if (fromFloor !== undefined) {
    if (!into) add('fromFloor', "edgeMount.fromFloor needs facing: 'into' (a part standing on the floor climbs INTO the deck)")
    if (!fromFloor || typeof fromFloor.param !== 'string' || !fromFloor.param) add('fromFloor.param', 'edgeMount.fromFloor.param must be a non-empty param name')
    else {
      const rise = Array.isArray(atParams) && atParams.find((r: { axis?: unknown; param?: unknown; scale?: unknown }) => r?.axis === 1 && r.param === fromFloor.param)
      if (!rise || !isFiniteNum((rise as { scale?: unknown }).scale) || !((rise as { scale: number }).scale > 0)) {
        add('fromFloor.param', `edgeMount.fromFloor.param "${fromFloor.param}" must drive an axis-1 atParams entry with a positive scale (the rise per unit it is fitted by)`)
      }
    }
  }
  for (const k of ['opens', 'notch', 'lift'] as const) if (em[k] !== undefined && typeof em[k] !== 'boolean') add(k, `edgeMount.${k} must be a boolean`)
  if ((em.notch === true || em.lift === true) && !into) add(em.notch === true ? 'notch' : 'lift', "edgeMount notch and lift need facing: 'into' (they act on a part climbing from the floor)")
}

/** safe descent into an unknown blob - the file's house style, so the ref table below needs no `any` */
const sub = (v: unknown, key: string): unknown => (v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** every snap field that names a param, with the param type it must name - the table validateSnapParamRefs walks */
const SNAP_PARAM_REFS: { field: string; type: 'number' | 'boolean'; names: (snap: unknown) => unknown[] }[] = [
  { field: 'snap.track.fitWidthParam', type: 'number', names: (s) => [sub(sub(s, 'track'), 'fitWidthParam')] },
  { field: 'snap.track.lanes.countParam', type: 'number', names: (s) => [sub(sub(sub(s, 'track'), 'lanes'), 'countParam')] },
  { field: 'snap.track.lanes.pitchParam', type: 'number', names: (s) => [sub(sub(sub(s, 'track'), 'lanes'), 'pitchParam')] },
  { field: 'snap.surfaces[].lengthParam', type: 'number', names: (s) => list(sub(s, 'surfaces')).map((x) => sub(x, 'lengthParam')) },
  { field: 'snap.surfaces[].widthParam', type: 'number', names: (s) => list(sub(s, 'surfaces')).map((x) => sub(x, 'widthParam')) },
  { field: 'snap.surfaces[].heightParam', type: 'number', names: (s) => list(sub(s, 'surfaces')).map((x) => sub(x, 'heightParam')) },
  { field: 'snap.tile.lengthParam', type: 'number', names: (s) => [sub(sub(s, 'tile'), 'lengthParam')] },
  { field: 'snap.tile.widthParam', type: 'number', names: (s) => [sub(sub(s, 'tile'), 'widthParam')] },
  { field: 'snap.chain.lengthParam', type: 'number', names: (s) => [sub(sub(s, 'chain'), 'lengthParam')] },
  { field: 'snap.chain.omitStartParam', type: 'boolean', names: (s) => [sub(sub(s, 'chain'), 'omitStartParam')] },
  { field: 'snap.chain.omitEndParam', type: 'boolean', names: (s) => [sub(sub(s, 'chain'), 'omitEndParam')] },
  { field: 'snap.edgeMount.alongParam', type: 'number', names: (s) => [sub(sub(s, 'edgeMount'), 'alongParam')] },
  { field: 'snap.edgeMount.atParams[].param', type: 'number', names: (s) => list(sub(sub(s, 'edgeMount'), 'atParams')).map((r) => sub(r, 'param')) },
  { field: 'snap.edgeMount.fromFloor.param', type: 'number', names: (s) => [sub(sub(sub(s, 'edgeMount'), 'fromFloor'), 'param')] },
  { field: 'snap.mounts[].fitRangeParam', type: 'number', names: (s) => list(sub(s, 'mounts')).map((m) => sub(m, 'fitRangeParam')) },
]

/**
 * A snap declaration that names a param must name one that exists, with the right type.
 *
 * The failure this catches is silent by construction: the engine resolves every one of these through
 * `numParamOf` / `getPackage().params`, which yields null for a name that isn't there, and a null makes the
 * snap return null. So a misspelled `lengthParam` is a part that never snaps, with nothing logged and
 * nothing to see in the Inspector - the same shape as the missing-declaration bug, one layer down.
 *
 * Not folded into {@link validatePartPackage}. A package problem drops the package on load
 * (scene.ts and project.ts record an error and skip it), so making a typo fatal would turn "this part doesn't
 * snap" into "this part and every instance of it are gone from the scene" - strictly worse than the bug, and
 * it would hit projects saved before the check existed. This runs on the authoring path instead
 * (sim/validatePart), where the author is looking at the part and can fix it.
 */
export function validateSnapParamRefs(pkg: unknown): PackageProblem[] {
  const problems: PackageProblem[] = []
  const p = pkg as { snap?: unknown; params?: unknown } | undefined
  const snap = p?.snap
  if (!snap || typeof snap !== 'object') return problems
  const schema = (p?.params && typeof p.params === 'object' ? p.params : {}) as Record<string, { type?: unknown } | undefined>
  for (const ref of SNAP_PARAM_REFS) {
    for (const name of ref.names(snap)) {
      if (name === undefined || name === null) continue
      if (typeof name !== 'string' || !name) continue // shape is validateSnap's job; only resolve real names here
      const spec = schema[name]
      if (!spec) {
        problems.push({ field: ref.field, message: `names "${name}", which is not a declared param (the snap will silently never engage)` })
      } else if (spec.type !== ref.type) {
        problems.push({ field: ref.field, message: `names "${name}", a '${String(spec.type)}' param, but must name a '${ref.type}' one` })
      }
    }
  }
  return problems
}

/** Validate a `function` geometry (docs/procedural-geometry.md, Tier 2): the mesh comes from the behavior's
 *  `geometry()` callback at realize time, so there is no static sweep/links to check - only the baked
 *  `bounds` (the footprint shown without running code), the optional `conveys` flag, and a `material` ref.
 *  The geometry source's own correctness (determinism, vertex budget) is enforced where it runs
 *  (core/geometry/geometryEval + embeddedBehavior), not here - structural validation can't execute the script. */
function validateDrawnGeometry(g: { bounds?: unknown; material?: unknown; conveys?: unknown }, problems: PackageProblem[], materialIds: Set<string>): void {
  validateBounds(g.bounds, problems)
  if (g.conveys !== undefined && typeof g.conveys !== 'boolean') problems.push({ field: 'geometry.conveys', message: 'function conveys must be a boolean' })
  if (g.material !== undefined && (typeof g.material !== 'string' || !materialIds.has(g.material))) problems.push({ field: 'geometry.material', message: 'function material must reference a declared material id' })
}

/** Validate a `cargo` geometry (C-cargo): a box/pallet/tote cargo kind + the positive baked bounds the
 *  footprint/placement read without running code (a box's live size still tracks its instance params). */
function validateCargoGeometry(g: { cargoKind?: unknown; bounds?: unknown; size?: unknown }, problems: PackageProblem[]): void {
  if (g.cargoKind !== 'box' && g.cargoKind !== 'pallet' && g.cargoKind !== 'tote') problems.push({ field: 'geometry.cargoKind', message: 'cargo cargoKind must be "box", "pallet" or "tote"' })
  if (g.bounds !== undefined) problems.push({ field: 'geometry.bounds', message: "a cargo box's `bounds` is now its `size` { length, width, height } (package format 4)" })
  const b = g.size as { length?: unknown; width?: unknown; height?: unknown } | undefined
  const dim = (v: unknown): boolean => typeof v === 'number' && v > 0
  if (!b || !dim(b.length) || !dim(b.width) || !dim(b.height)) problems.push({ field: 'geometry.size', message: 'cargo geometry needs a positive numeric size {length, width, height}' })
}

/** A rig's or drawn part's footprint box ({@link PartBounds}). */
function validateBounds(bounds: unknown, problems: PackageProblem[]): void {
  const b = bounds as { length?: unknown; width?: unknown; top?: unknown; bottom?: unknown; height?: unknown; floorY?: unknown } | undefined
  if (!b || typeof b !== 'object') {
    problems.push({ field: 'geometry.bounds', message: 'geometry needs bounds { length, width, top, bottom? }' })
    return
  }
  if (b.height !== undefined) problems.push({ field: 'geometry.bounds.height', message: 'bounds.height is now bounds.top: the highest point, y in the part\'s frame (package format 4)' })
  if (b.floorY !== undefined) problems.push({ field: 'geometry.bounds.floorY', message: 'bounds.floorY is now bounds.bottom: the lowest point, y in the part\'s frame (package format 4)' })
  if (!isFiniteNum(b.length) || !isFiniteNum(b.width) || !isFiniteNum(b.top)) problems.push({ field: 'geometry.bounds', message: 'bounds needs numeric length, width and top' })
  if (b.bottom !== undefined && (!isFiniteNum(b.bottom) || (isFiniteNum(b.top) && b.bottom > b.top))) problems.push({ field: 'geometry.bounds.bottom', message: 'bounds.bottom must be a number no higher than top' })
  const c = bounds as { centerX?: unknown; centerZ?: unknown; params?: unknown }
  if (c.centerX !== undefined && !isFiniteNum(c.centerX)) problems.push({ field: 'geometry.bounds.centerX', message: 'bounds.centerX must be a number' })
  if (c.centerZ !== undefined && !isFiniteNum(c.centerZ)) problems.push({ field: 'geometry.bounds.centerZ', message: 'bounds.centerZ must be a number' })
  if (c.params === undefined) return
  if (!Array.isArray(c.params)) {
    problems.push({ field: 'geometry.bounds.params', message: 'bounds.params must be an array' })
    return
  }
  const FIELDS = ['length', 'width', 'top', 'bottom', 'centerX', 'centerZ']
  c.params.forEach((raw, i) => {
    const r = raw as { field?: unknown } | null
    const where = `geometry.bounds.params[${i}]`
    if (typeof r?.field !== 'string' || !FIELDS.includes(r.field)) problems.push({ field: `${where}.field`, message: `field must be one of ${FIELDS.join(', ')}` })
  })
  // the rest of each entry is a link sizeParams entry without its axis
  validateSizeParams(
    c.params.map((r) => ({ ...(r as object), axis: 0 })),
    'geometry.bounds.params',
    (field, message) => problems.push({ field, message }),
  )
}

/** Validate the PBR materials; returns the set of valid material ids for mesh-shape refs. */
function validateMaterials(materials: unknown, problems: PackageProblem[], assetIds: Set<string>): Set<string> {
  const ids = new Set<string>()
  if (materials === undefined) return ids
  if (!Array.isArray(materials)) {
    problems.push({ field: 'materials', message: 'materials must be an array' })
    return ids
  }
  materials.forEach((raw, i) => {
    const m = raw as { id?: unknown; albedo?: unknown; orm?: unknown; normal?: unknown; color?: unknown; metalness?: unknown; roughness?: unknown; triplanar?: unknown; pattern?: unknown }
    const at = `materials[${i}]`
    if (typeof m?.id !== 'string' || m.id === '') problems.push({ field: `${at}.id`, message: 'material id must be a non-empty string' })
    else if (ids.has(m.id)) problems.push({ field: `${at}.id`, message: `duplicate material id "${m.id}"` })
    else ids.add(m.id)
    for (const tex of ['albedo', 'orm', 'normal'] as const) {
      const ref = m?.[tex]
      if (ref !== undefined && (typeof ref !== 'string' || !assetIds.has(ref))) {
        problems.push({ field: `${at}.${tex}`, message: `material.${tex} must reference an embedded package asset id` })
      }
    }
    if (m?.color !== undefined && !isVec3(m.color)) problems.push({ field: `${at}.color`, message: 'color must be 3 finite numbers' })
    if (m?.metalness !== undefined && !isFiniteNum(m.metalness)) problems.push({ field: `${at}.metalness`, message: 'metalness must be a finite number' })
    if (m?.roughness !== undefined && !isFiniteNum(m.roughness)) problems.push({ field: `${at}.roughness`, message: 'roughness must be a finite number' })
    if (m?.triplanar !== undefined) {
      const t = m.triplanar as { space?: unknown; scale?: unknown; boost?: unknown }
      if (typeof t !== 'object' || t === null || Array.isArray(t)) {
        problems.push({ field: `${at}.triplanar`, message: 'triplanar must be an object' })
      } else {
        if (t.space !== 'object' && t.space !== 'world') problems.push({ field: `${at}.triplanar.space`, message: "triplanar.space must be 'object' or 'world'" })
        if (!isFiniteNum(t.scale) || t.scale <= 0) problems.push({ field: `${at}.triplanar.scale`, message: 'triplanar.scale must be a positive number (tiles per metre)' })
        if (t.boost !== undefined && !isFiniteNum(t.boost)) problems.push({ field: `${at}.triplanar.boost`, message: 'triplanar.boost must be a finite number' })
        if (m.albedo === undefined && m.pattern === undefined) problems.push({ field: `${at}.triplanar`, message: 'triplanar needs an albedo texture or a pattern to sample' })
      }
    }
    if (m?.pattern !== undefined) validatePattern(m.pattern, `${at}.pattern`, m.albedo !== undefined, problems)
  })
  return ids
}

const PATTERN_ANGLES = [0, 45, 90, 135]

function validatePattern(raw: unknown, at: string, hasAlbedo: boolean, problems: PackageProblem[]): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push({ field: at, message: 'pattern must be an object' })
    return
  }
  const p = raw as { kind?: unknown; colors?: unknown; ratio?: unknown; angle?: unknown }
  if (hasAlbedo) problems.push({ field: at, message: 'a material takes an albedo texture or a pattern, not both' })
  if (p.kind !== 'stripes' && p.kind !== 'checker') problems.push({ field: `${at}.kind`, message: "pattern.kind must be 'stripes' or 'checker'" })
  if (!Array.isArray(p.colors) || p.colors.length !== 2 || !p.colors.every(isVec3)) {
    problems.push({ field: `${at}.colors`, message: 'pattern.colors must be two [r, g, b] colours' })
  }
  if (p.ratio !== undefined && !(isFiniteNum(p.ratio) && p.ratio > 0 && p.ratio < 1)) {
    problems.push({ field: `${at}.ratio`, message: 'pattern.ratio must be a number between 0 and 1' })
  }
  if (p.angle !== undefined && !PATTERN_ANGLES.includes(p.angle as number)) {
    problems.push({ field: `${at}.angle`, message: 'pattern.angle must be 0, 45, 90 or 135' })
  }
}

/** Validate the embedded asset blobs; returns the set of valid asset ids for mesh-shape refs. */
function validateAssets(assets: unknown, problems: PackageProblem[]): Set<string> {
  const ids = new Set<string>()
  if (assets === undefined) return ids
  if (!Array.isArray(assets)) {
    problems.push({ field: 'assets', message: 'assets must be an array' })
    return ids
  }
  assets.forEach((raw, i) => {
    const a = raw as { id?: unknown; mime?: unknown; data?: unknown; url?: unknown }
    const at = `assets[${i}]`
    if (typeof a?.id !== 'string' || a.id === '') problems.push({ field: `${at}.id`, message: 'asset id must be a non-empty string' })
    else if (ids.has(a.id)) problems.push({ field: `${at}.id`, message: `duplicate asset id "${a.id}"` })
    else ids.add(a.id)
    if (typeof a?.mime !== 'string' || a.mime === '') problems.push({ field: `${at}.mime`, message: 'asset mime must be a non-empty string' })
    // exactly one of data / url
    const hasData = typeof a?.data === 'string' && a.data !== ''
    const hasUrl = typeof a?.url === 'string' && a.url !== ''
    if (hasData === hasUrl) problems.push({ field: `${at}.data`, message: 'asset needs exactly one of data (base64) or url' })
    const sha = (raw as { sha256?: unknown } | null)?.sha256
    if (sha !== undefined && (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha))) problems.push({ field: `${at}.sha256`, message: 'asset sha256 must be 64 lowercase hex characters' })
  })
  return ids
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
function isVec3(v: unknown): v is Vec3Tuple {
  return Array.isArray(v) && v.length === 3 && v.every(isFiniteNum)
}

// --- the workspace / part-folder manifest ---------------------------------------------------------

/**
 * The authored half of a part: everything except the behavior script and the fields baked from that
 * script (`format`, `params`, `interactive`). This is the `manifest.json` of the on-disk part
 * folder layout (`manifest.json` + `behavior.js`) shared by the desktop parts workspace
 * and a project folder's `parts/`. When the app builds the part it bakes those fields again by running the
 * behavior, so the script is always the source of truth for them.
 */
export interface PackageManifest {
  id: string
  name: string
  category?: string
  geometry: PartPackageGeometry
  /** embedded GLB meshes referenced by mesh shapes (by id) - carried into the package so it stays self-contained */
  assets?: PartAsset[]
  /** PBR materials a mesh shape can reference (by id) */
  materials?: PartMaterial[]
  thumbnail?: string
  /** what kind of conveyor this part is, if any ({@link ConveyorDecl}) */
  conveyor?: ConveyorDecl
  /** the boolean param that switches this part's PLC link (see {@link PartPackage.commsParam}) */
  commsParam?: string
  /** how this part connects to others: the snap engine's connectors ({@link SnapSpec}). Structure, like the rig: it
   *  lives here, beside the geometry whose params it names. Package format 3 declared it in `definePart`. */
  snap?: SnapSpec
  /** the cargo this part stores on its grippers ({@link HoldsDecl}) */
  holds?: HoldsDecl
  /** this part is cargo with its own body ({@link CargoDecl}) */
  cargo?: CargoDecl
  /** where a project's copy came from, written by the app ({@link PartOrigin}) */
  origin?: PartOrigin
  /** who made a copy from a part library, written by the app ({@link PartCredit}) */
  credit?: PartCredit
  /** the Part SDK level the part was last changed under, written by the app ({@link PartSdkStamp}) */
  sdk?: PartSdkStamp
}

/**
 * The manifest half of a built package - the inverse of buildPackage's input. `params` (and the other
 * behavior-baked fields) are intentionally omitted: buildPackage re-bakes them from the behavior source,
 * exactly like a hand-authored folder, so writing them would only risk drift.
 */
export function manifestOfPackage(pkg: PartPackage): PackageManifest {
  return {
    id: pkg.id,
    name: pkg.name,
    ...(pkg.category !== undefined ? { category: pkg.category } : {}),
    geometry: pkg.geometry,
    ...(pkg.assets !== undefined ? { assets: pkg.assets } : {}),
    ...(pkg.materials !== undefined ? { materials: pkg.materials } : {}),
    ...(pkg.thumbnail !== undefined ? { thumbnail: pkg.thumbnail } : {}),
    ...(pkg.conveyor !== undefined ? { conveyor: pkg.conveyor } : {}),
    ...(pkg.commsParam !== undefined ? { commsParam: pkg.commsParam } : {}),
    ...(pkg.snap !== undefined ? { snap: pkg.snap } : {}),
    ...(pkg.holds !== undefined ? { holds: pkg.holds } : {}),
    ...(pkg.cargo !== undefined ? { cargo: pkg.cargo } : {}),
    ...(pkg.origin !== undefined ? { origin: pkg.origin } : {}),
    ...(pkg.credit !== undefined ? { credit: pkg.credit } : {}),
    ...(pkg.sdk !== undefined ? { sdk: pkg.sdk } : {}),
  }
}
function isVec4(v: unknown): v is Vec4Tuple {
  return Array.isArray(v) && v.length === 4 && v.every(isFiniteNum)
}

/** Validate a box's optional param-driven size overrides (C-paramgeo). */
function validateSizeParams(sizeParams: unknown, at: string, add: (field: string, message: string) => void): void {
  if (sizeParams === undefined) return
  if (!Array.isArray(sizeParams)) {
    add(at, 'sizeParams must be an array')
    return
  }
  sizeParams.forEach((raw, i) => {
    const sp = raw as { axis?: unknown; param?: unknown; mulParam?: unknown; scale?: unknown; add?: unknown; min?: unknown; max?: unknown }
    const where = `${at}[${i}]`
    if (sp?.axis !== 0 && sp?.axis !== 1 && sp?.axis !== 2) add(`${where}.axis`, 'axis must be 0, 1 or 2')
    if (typeof sp?.param !== 'string' || sp.param === '') add(`${where}.param`, 'param must be a non-empty string')
    if (sp?.mulParam !== undefined && (typeof sp.mulParam !== 'string' || sp.mulParam === '')) add(`${where}.mulParam`, 'mulParam must be a non-empty string')
    if (sp?.scale !== undefined && !isFiniteNum(sp.scale)) add(`${where}.scale`, 'scale must be a finite number')
    if (sp?.add !== undefined && !isFiniteNum(sp.add)) add(`${where}.add`, 'add must be a finite number')
    if (sp?.min !== undefined && !isFiniteNum(sp.min)) add(`${where}.min`, 'min must be a finite number')
    if (sp?.max !== undefined && !isFiniteNum(sp.max)) add(`${where}.max`, 'max must be a finite number')
    if (isFiniteNum(sp?.min) && isFiniteNum(sp?.max) && (sp.min as number) > (sp.max as number)) add(`${where}.min`, 'min must be <= max')
  })
}

/** Validate a mesh link's `tileUv` (see MeshUvTile): each entry must re-tile an axis the link actually stretches. */
function validateTileUv(tileUv: unknown, sizeParams: unknown, at: string, add: (field: string, message: string) => void): void {
  if (tileUv === undefined) return
  if (!Array.isArray(tileUv) || tileUv.length === 0) {
    add(at, 'tileUv must be a non-empty array of { axis, uv, materials }')
    return
  }
  const stretched = new Set(Array.isArray(sizeParams) ? sizeParams.map((sp) => (sp as { axis?: unknown })?.axis) : [])
  tileUv.forEach((raw, i) => {
    const t = raw as { axis?: unknown; uv?: unknown; materials?: unknown } | null
    const where = `${at}[${i}]`
    if (t?.axis !== 0 && t?.axis !== 1 && t?.axis !== 2) add(`${where}.axis`, 'axis must be 0, 1 or 2')
    // without a stretch on that axis the factor is always 1 and the entry silently does nothing
    else if (!stretched.has(t.axis)) add(`${where}.axis`, 'tileUv.axis must be an axis this mesh stretches (a sizeParams entry)')
    if (t?.uv !== 'u' && t?.uv !== 'v') add(`${where}.uv`, "uv must be 'u' or 'v'")
    if (!Array.isArray(t?.materials) || t.materials.length === 0 || t.materials.some((m) => typeof m !== 'string' || m === '')) {
      add(`${where}.materials`, 'materials must be a non-empty array of GLB material names')
    }
  })
}

/** Validate one axis of a grid array (see GridAxisSpec). */
function validateGridAxis(axis: unknown, at: string, add: (field: string, message: string) => void): void {
  const ax = axis as { sizeParam?: unknown; pitchParam?: unknown; marginParam?: unknown; size?: unknown; pitch?: unknown; margin?: unknown; maxSpacing?: unknown } | undefined
  if (typeof ax !== 'object' || ax === null) {
    add(at, 'grid axis must be an object { sizeParam, pitchParam | maxSpacing, marginParam? }')
    return
  }
  if (typeof ax.sizeParam !== 'string' || ax.sizeParam === '') add(`${at}.sizeParam`, 'sizeParam must be a non-empty param name')
  const hasPitch = typeof ax.pitchParam === 'string' && ax.pitchParam !== ''
  if (ax.maxSpacing !== undefined && (!isFiniteNum(ax.maxSpacing) || ax.maxSpacing <= 0)) add(`${at}.maxSpacing`, 'maxSpacing must be > 0')
  if (!hasPitch && ax.maxSpacing === undefined) add(`${at}.pitchParam`, 'pitchParam must be a non-empty param name (or set maxSpacing)')
  else if (ax.pitchParam !== undefined && !hasPitch) add(`${at}.pitchParam`, 'pitchParam must be a non-empty param name')
  if (ax.marginParam !== undefined && (typeof ax.marginParam !== 'string' || ax.marginParam === '')) add(`${at}.marginParam`, 'marginParam must be a non-empty param name')
  if (ax.size !== undefined && (!isFiniteNum(ax.size) || ax.size < 0)) add(`${at}.size`, 'size fallback must be a non-negative number')
  if (ax.pitch !== undefined && (!isFiniteNum(ax.pitch) || ax.pitch <= 0)) add(`${at}.pitch`, 'pitch fallback must be > 0')
  if (ax.margin !== undefined && (!isFiniteNum(ax.margin) || ax.margin < 0)) add(`${at}.margin`, 'margin fallback must be a non-negative number')
}

/** Validate a link's optional `array` spec (array-links): exactly one of `distribute`, `count`+`step`, or
 *  `grid`. (Switching a link off with a param is the link's `showParam`, arrayed or not.) */
function validateArray(array: unknown, at: string, add: (field: string, message: string) => void): void {
  if (array === undefined) return
  const a = array as { distribute?: { axis?: unknown; spanParam?: unknown; spanAdd?: unknown; maxSpacing?: unknown; worldPhase?: unknown }; count?: unknown; step?: unknown; stepParams?: unknown; enabledParam?: unknown; omitFirstParam?: unknown; omitLastParam?: unknown; grid?: { x?: unknown; z?: unknown; enabledParam?: unknown } }
  if (a.enabledParam !== undefined) add(`${at}.enabledParam`, 'array.enabledParam was retired (package format 4): give the link `showParam` instead (it switches the whole link, arrayed or not)')
  for (const key of ['omitFirstParam', 'omitLastParam'] as const) {
    const v = (a as Record<string, unknown>)[key]
    if (v !== undefined && (typeof v !== 'string' || v === '')) add(`${at}.${key}`, `${key} must be a non-empty boolean-param name`)
  }
  const hasDistribute = a.distribute !== undefined
  const hasCount = a.count !== undefined
  const hasGrid = a.grid !== undefined
  const forms = (hasDistribute ? 1 : 0) + (hasCount ? 1 : 0) + (hasGrid ? 1 : 0)
  if (forms === 0 && a.enabledParam !== undefined) return // reported above: the whole array was only a gate
  if (forms !== 1) {
    add(at, 'array needs exactly one of `distribute`, `count`+`step`, or `grid` (a link that only switches on and off needs no array: use `showParam`)')
    return
  }
  if (hasGrid) {
    const grid = a.grid!
    if (a.stepParams !== undefined) add(`${at}.stepParams`, 'stepParams applies to the `count`+`step` form only')
    if (a.omitFirstParam !== undefined || a.omitLastParam !== undefined) add(`${at}.omitFirstParam`, 'omitFirst/LastParam apply to the 1-D `distribute`/`count` forms, not `grid`')
    validateGridAxis(grid.x, `${at}.grid.x`, add)
    validateGridAxis(grid.z, `${at}.grid.z`, add)
    if (grid.enabledParam !== undefined) add(`${at}.grid.enabledParam`, 'array.grid.enabledParam was retired (package format 4): give the link `showParam` instead')
    return
  }
  if (hasDistribute) {
    const d = a.distribute!
    if (a.stepParams !== undefined) add(`${at}.stepParams`, 'stepParams applies to the `count`+`step` form only')
    if (d.axis !== 0 && d.axis !== 1 && d.axis !== 2) add(`${at}.distribute.axis`, 'axis must be 0, 1 or 2')
    if (typeof d.spanParam !== 'string' || d.spanParam === '') add(`${at}.distribute.spanParam`, 'spanParam must be a non-empty string')
    if (d.spanAdd !== undefined && !isFiniteNum(d.spanAdd)) add(`${at}.distribute.spanAdd`, 'spanAdd must be a number (metres added to the span)')
    if (!isFiniteNum(d.maxSpacing) || d.maxSpacing <= 0) add(`${at}.distribute.maxSpacing`, 'maxSpacing must be > 0')
    if (d.worldPhase !== undefined && typeof d.worldPhase !== 'boolean') add(`${at}.distribute.worldPhase`, 'worldPhase must be a boolean')
    else if (d.worldPhase === true && d.axis !== 0) add(`${at}.distribute.worldPhase`, 'worldPhase requires axis 0 (the flow axis)')
  } else {
    if (typeof a.count !== 'string' || a.count === '') add(`${at}.count`, 'count must be a non-empty param name')
    if (!isVec3(a.step)) add(`${at}.step`, 'step must be 3 finite numbers')
    validateSizeParams(a.stepParams, `${at}.stepParams`, add)
  }
}

function validateRigShape(shape: unknown, at: string, add: (field: string, message: string) => void, assetIds: Set<string>, materialIds: Set<string>): void {
  const s = shape as { kind?: unknown; size?: unknown; sizeParams?: unknown; tileUv?: unknown; radius?: unknown; height?: unknown; length?: unknown; width?: unknown; asset?: unknown; node?: unknown; scale?: unknown; fitHeight?: unknown; material?: unknown; materials?: unknown; lamp?: unknown; lamps?: unknown; hideNodes?: unknown; keepNode?: unknown; collision?: unknown; text?: unknown; textParam?: unknown; textFrom?: unknown; color?: unknown; spanParam?: unknown; widthParam?: unknown; standParam?: unknown; frameDepth?: unknown; frameDepthParam?: unknown; arc?: unknown; bed?: unknown }
  // (`s.sizeParams` is validated per-kind below)
  if (s?.kind === 'box') {
    if (!isVec3(s.size) || s.size.some((n) => n <= 0)) add(`${at}.size`, 'box size must be 3 positive numbers')
    validateSizeParams(s.sizeParams, `${at}.sizeParams`, add)
  } else if (s?.kind === 'cylinder') {
    if (!isFiniteNum(s.radius) || s.radius <= 0) add(`${at}.radius`, 'cylinder radius must be > 0')
    if (!isFiniteNum(s.height) || s.height <= 0) add(`${at}.height`, 'cylinder height must be > 0')
    validateSizeParams(s.sizeParams, `${at}.sizeParams`, add)
  } else if (s?.kind === 'cone') {
    if (!isFiniteNum(s.radius) || s.radius <= 0) add(`${at}.radius`, 'cone radius must be > 0')
    if (!isFiniteNum(s.height) || s.height <= 0) add(`${at}.height`, 'cone height must be > 0')
  } else if (s?.kind === 'deck') {
    add(`${at}.kind`, 'shape.kind "deck" was retired (package format 4): a box link with `conveys: true` is the same conveying slab')
  } else if (s?.kind === 'frame') {
    // transform-only: nothing else to validate
  } else if (s?.kind === 'mesh') {
    if (typeof s.asset !== 'string' || !assetIds.has(s.asset)) add(`${at}.asset`, 'mesh.asset must reference an embedded package asset id')
    if (s.node !== undefined && (typeof s.node !== 'string' || s.node === '')) add(`${at}.node`, 'mesh.node must be a non-empty string')
    if (s.scale !== undefined && (!isFiniteNum(s.scale) || s.scale <= 0)) add(`${at}.scale`, 'mesh.scale must be > 0')
    validateSizeParams(s.sizeParams, `${at}.sizeParams`, add)
    validateTileUv(s.tileUv, s.sizeParams, `${at}.tileUv`, add)
    if (s.fitHeight !== undefined && (!isFiniteNum(s.fitHeight) || s.fitHeight <= 0)) add(`${at}.fitHeight`, 'mesh.fitHeight must be > 0')
    if (s.fitHeight !== undefined && s.node !== undefined) add(`${at}.fitHeight`, 'mesh.fitHeight applies to a whole-scene ref only (drop `node`)')
    if (s.material !== undefined && (typeof s.material !== 'string' || !materialIds.has(s.material))) add(`${at}.material`, 'mesh.material must reference a package material id')
    if (s.materials !== undefined) {
      if (typeof s.materials !== 'object' || s.materials === null || Array.isArray(s.materials)) {
        add(`${at}.materials`, 'mesh.materials must be a map of GLB-material-name → package material id')
      } else {
        for (const [glbName, matId] of Object.entries(s.materials as Record<string, unknown>)) {
          if (typeof matId !== 'string' || !materialIds.has(matId)) add(`${at}.materials.${glbName}`, 'mesh.materials value must reference a package material id')
        }
      }
    }
    if (s.hideNodes !== undefined) {
      if (!Array.isArray(s.hideNodes) || s.hideNodes.some((n) => typeof n !== 'string' || n === '')) {
        add(`${at}.hideNodes`, 'mesh.hideNodes must be an array of non-empty GLB node names')
      } else if (s.node !== undefined) {
        add(`${at}.hideNodes`, 'mesh.hideNodes applies to a whole-scene ref only (drop `node`)')
      }
    }
    if (s.keepNode !== undefined) {
      if (typeof s.keepNode !== 'string' || s.keepNode === '') add(`${at}.keepNode`, 'mesh.keepNode must be a non-empty GLB node name')
      else if (s.node !== undefined) add(`${at}.keepNode`, 'mesh.keepNode applies to a whole-scene ref only (drop `node`)')
      else if (s.hideNodes !== undefined) add(`${at}.keepNode`, 'mesh.keepNode and mesh.hideNodes are mutually exclusive')
    }
    if (s.collision !== undefined) add(`${at}.collision`, "a mesh's collision box moved to its link: collision: { box: [x, y, z] } (package format 4)")
  } else if (s?.kind === 'label') {
    if (s.text !== undefined && typeof s.text !== 'string') add(`${at}.text`, 'label.text must be a string')
    if (s.textParam !== undefined && (typeof s.textParam !== 'string' || s.textParam === '')) add(`${at}.textParam`, 'label.textParam must be a non-empty param name')
    if (s.textFrom !== undefined && (typeof s.textFrom !== 'string' || s.textFrom === '')) add(`${at}.textFrom`, 'label.textFrom must be a non-empty display name (the name ctx.display() publishes)')
    if (s.size !== undefined && (!Array.isArray(s.size) || s.size.length !== 2 || !s.size.every((n) => isFiniteNum(n) && n > 0))) add(`${at}.size`, 'label.size must be 2 positive numbers [width, height]')
    if (s.color !== undefined && !isVec3(s.color)) add(`${at}.color`, 'label.color must be 3 finite numbers (r, g, b in 0..1)')
  } else if (s?.kind === 'leg') {
    if (typeof s.spanParam !== 'string' || s.spanParam === '') add(`${at}.spanParam`, 'leg.spanParam must be a non-empty param name')
    if (typeof s.widthParam !== 'string' || s.widthParam === '') add(`${at}.widthParam`, 'leg.widthParam must be a non-empty param name')
    if (typeof s.standParam !== 'string' || s.standParam === '') add(`${at}.standParam`, 'leg.standParam must be a non-empty param name')
    if (!isFiniteNum(s.frameDepth)) add(`${at}.frameDepth`, 'leg.frameDepth must be a finite number')
    const fdp = s.frameDepthParam as { param?: unknown; scale?: unknown; add?: unknown; min?: unknown; max?: unknown } | undefined
    if (fdp !== undefined) {
      if (typeof fdp !== 'object' || fdp === null || typeof fdp.param !== 'string' || fdp.param === '') add(`${at}.frameDepthParam`, 'leg.frameDepthParam must be { param, scale?, add?, min?, max? } naming a number param')
      else for (const f of ['scale', 'add', 'min', 'max'] as const) if (fdp[f] !== undefined && !isFiniteNum(fdp[f])) add(`${at}.frameDepthParam.${f}`, `leg.frameDepthParam.${f} must be a finite number`)
    }
    const arc = s.arc as { radiusParam?: unknown; sweepDeg?: unknown } | undefined
    if (arc !== undefined) {
      if (typeof arc.radiusParam !== 'string' || arc.radiusParam === '') add(`${at}.arc.radiusParam`, 'leg.arc.radiusParam must be a non-empty param name')
      if (!isFiniteNum(arc.sweepDeg)) add(`${at}.arc.sweepDeg`, 'leg.arc.sweepDeg must be a finite number')
    }
  } else if (typeof s?.kind === 'string' && Object.hasOwn(RETIRED_SHAPE_KINDS, s.kind)) {
    add(`${at}.kind`, `shape.kind "${s.kind}" was retired: ${RETIRED_SHAPE_KINDS[s.kind]!.advice}`)
  } else {
    add(`${at}.kind`, 'shape.kind must be "box", "cylinder", "cone", "frame", "mesh", "label" or "leg"')
  }
}

/** How long a retired kind keeps loading after its retirement reaches main. Covers an autosave or a file that
 *  someone opens rarely. */
export const RETIRED_KIND_GRACE_MONTHS = 6

/** Rig shape kinds a package may no longer declare, with what to do instead. Authoring refuses them
 *  (validatePartPackage); a stored package goes through {@link upgradeStoredPackage} first, so older content still
 *  opens. Empty: the engine-built `chain` lane and `roller` bed are not listed, so an older save that still holds
 *  one of those links fails to load.
 *
 *  Each entry expires; the table and its handling stay. `npm run retired-kinds` works out the expiry: the grace
 *  period ({@link RETIRED_KIND_GRACE_MONTHS}) starts on the first main commit after which no shipped manifest
 *  (examples/parts) declares the kind. The grace period alone does not make removal safe: an older save with the
 *  link fails to load rather than loading without it, and an unopened collab room from before the deploy would feed
 *  the raw link to the renderer. So remove one only when `npm run retired-kinds -- --db <collab.sqlite>`, against a
 *  fresh backup of the production collab database (server/DEPLOY.md), reports it REMOVABLE: the grace period is over
 *  and no stored room or snapshot declares it. Keep this table and dropRetiredRigLinks when empty: the next retirement
 *  needs them. */
export const RETIRED_SHAPE_KINDS: Readonly<Record<string, {
  /** what to do instead, quoted in the authoring error */
  advice: string
  /** the day the kind was retired in the source (YYYY-MM-DD). Not the day its grace period starts: that is when the
   *  retirement reaches main, which `npm run retired-kinds` reads from git (scripts/retired-kinds.mjs) */
  retired: string
}>> = {}

/**
 * A stored package (a scene's embedded snapshot, a project's parts, a room) with its retired rig links removed:
 * each link whose shape kind is retired, every link parented beneath one (part of the same retired visual), and
 * every joint driving one of those. Returns the input itself when there is nothing to drop, so the common case
 * never copies. Only for loading what was saved: an author's manifest is refused instead, with
 * the reason (validatePartPackage). Every retired kind was render-only, so dropping one loses a visual, never a body.
 * Load points call {@link upgradeStoredPackage}, which runs this after any format upgrade. `retired` is the table to
 * judge by; only a test passes another.
 */
export function dropRetiredRigLinks<T>(raw: T, retired: Readonly<Record<string, unknown>> = RETIRED_SHAPE_KINDS): { pkg: T; dropped: string[] } {
  const geo = (raw as { geometry?: { kind?: unknown; links?: unknown; joints?: unknown } } | null)?.geometry
  if (!geo || geo.kind !== 'rig' || !Array.isArray(geo.links)) return { pkg: raw, dropped: [] }
  const links = geo.links as { name?: unknown; parent?: unknown; shape?: { kind?: unknown } }[]
  const gone = new Set<unknown>(links.filter((l) => typeof l?.shape?.kind === 'string' && Object.hasOwn(retired, l.shape.kind)).map((l) => l.name))
  if (gone.size === 0) return { pkg: raw, dropped: [] }
  // descendants go with their retired ancestor (fixed point: links may be listed in any order)
  for (let grew = true; grew; ) {
    grew = false
    for (const l of links) if (!gone.has(l?.name) && l?.parent !== undefined && gone.has(l.parent)) { gone.add(l.name); grew = true }
  }
  const joints = Array.isArray(geo.joints) ? (geo.joints as { link?: unknown }[]).filter((j) => !gone.has(j?.link)) : geo.joints
  const pkg = { ...(raw as object), geometry: { ...geo, links: links.filter((l) => !gone.has(l?.name)), ...(joints !== undefined ? { joints } : {}) } } as T
  return { pkg, dropped: [...gone].map(String) }
}

/** The package format this build writes and the newest one it reads. Typed as {@link PartPackage.format}, so a bump
 *  here fails to compile until that literal moves with it. */
export const PACKAGE_FORMAT: PartPackage['format'] = 6

/** One upgrade step: a stored package of format N in, the same package written as format N+1 out, plus a line per
 *  thing it had to change for the load's repair report. It must not mutate its input (a room's copy is shared). */
export type PackageUpgrade = (pkg: Record<string, unknown>) => { pkg: Record<string, unknown>; notes: string[] }

/**
 * How a stored package of an older format is carried forward, keyed by the format each step upgrades from.
 *   1 -> 2: a rig link's seven lamp fields became one {@link RigLink.lamps} list plus
 *          {@link RigLink.squash} ({@link upgradeLampsToFormat2}).
 *   2 -> 3: the stair-and-platform words became general ones: `snap.stairMount` is an `edgeMount`
 *          facing into the deck, `railing` is `onEdge`, `stairFoot` is `anchor: 'floor'`, and a diverter's
 *          guard-opening mount says `opens` ({@link upgradeCutsToFormat3}).
 *   3 -> 4: the vocabulary pass (docs/sdk-vocabulary.md): one word per idea, one place per
 *          declaration ({@link upgradeToFormat4}).
 *   4 -> 5: a sensor beam names its params (`rangeParam` / `showParam`) instead of the host reading params
 *          named `maxRange` / `showBeam` ({@link upgradeBeamsToFormat5}).
 *   5 -> 6: `basedOn` and `fromShelf` became one {@link PartOrigin} keyed by source, `origin.app` and
 *          `origin.shelf` (docs/part-sources.md; {@link canonicalOrigin}).
 *
 * This is how a manifest field is renamed, merged or removed without a grace period. Scenes, project libraries and
 * collab rooms embed every package they use, so a shipped field is read forever unless rewritten on the way in. To
 * change one: bump PACKAGE_FORMAT, add the step from the old number here, and make the validator and renderer know
 * only the new spelling. A step stays forever (a document of that format may always exist) and costs one function.
 *
 * The cost of a bump: an older build (an open tab from before the deploy, a peer in the same room) refuses a newer
 * format by name ("saved by a newer version"). So bump only for a change a step has to translate; an added
 * optional field needs no bump, since an older build never reads it.
 */
export const PACKAGE_UPGRADES: Readonly<Record<number, PackageUpgrade>> = {
  1: upgradeLampsToFormat2,
  2: upgradeCutsToFormat3,
  3: upgradeToFormat4,
  4: upgradeBeamsToFormat5,
  5: (pkg) => ({ pkg: canonicalOrigin(pkg), notes: [] }),
}

/**
 * A stored package or manifest with its record in the current spelling: before package format 6 it was two fields,
 * `basedOn` (the built-in a project's version was made from) and `fromShelf` (the shelf version it was copied from);
 * they become `origin.app` and `origin.shelf`. A key `origin` already has keeps its value. Returns the argument itself when there
 * is nothing to move. Used by the format 6 upgrade step (a stored package, {@link PACKAGE_UPGRADES}) and the package
 * build (a manifest a project folder or the shelf wrote before format 6: those carry no format number to upgrade by).
 */
export function canonicalOrigin<T>(raw: T): T {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || (!('basedOn' in r) && !('fromShelf' in r))) return raw
  const { basedOn, fromShelf, ...rest } = r
  const legacy: Record<string, unknown> = {}
  if (typeof basedOn === 'string' && basedOn !== '') legacy.app = basedOn
  if (typeof fromShelf === 'string' && fromShelf !== '') legacy.shelf = fromShelf
  const had = rest.origin && typeof rest.origin === 'object' ? (rest.origin as PartOrigin) : undefined
  const origin = { ...legacy, ...had }
  return (Object.keys(origin).length > 0 ? { ...rest, origin } : rest) as T
}

/**
 * The rig a retired one-box `deck` geometry becomes (format 4), in the current spelling: the same conveyor in the
 * general form. A conveying box `thick` deep with its top at the origin (the body the sim always built: conveyor
 * friction, surface velocity from the behavior), in the concrete deck finish, plus the yellow bar the deck drew
 * near its discharge end; bounds that give the same footprint (y from -thick to 0.05). Also what a retired sweep
 * becomes ({@link replaceSweepGeometry}).
 */
export function deckRig(length: number, width: number, thick = 0.1): RigGeometry {
  const bar = Math.max(length * 0.07, 0.06)
  return {
    kind: 'rig',
    links: [
      { name: 'deck', shape: { kind: 'box', size: [length, thick, width] }, offset: [0, -thick / 2, 0], conveys: true, finish: 'deck', notchable: true },
      // the deck's discharge-end bar: sRGB #f2bd0f in linear, decoration only
      { name: 'accent', shape: { kind: 'box', size: [bar, 0.012, Math.max(width * 0.8, 0.05)] }, offset: [length / 2 - bar, 0.008, 0], color: [0.888, 0.509, 0.0048], metalness: 0.1, roughness: 0.5, collision: 'none' },
    ],
    joints: [],
    bounds: { length, width, top: 0.05, bottom: -thick },
  }
}

/**
 * A snap declaration in the current spelling. `snap` is read out of a part's behavior (`definePart({ snap })`), and
 * behavior code is stored verbatim in documents and rooms, so a script written for an older format keeps declaring
 * the old words forever; the package build reads it through here (sim/validatePart.ts), and the format 4 upgrade
 * step uses it on a stored package's `snap`. Format 4: `edges` -> `tile`. Returns the argument itself when nothing
 * changed.
 */
export function canonicalSnap<T>(snap: T): T {
  const s = snap as Record<string, unknown> | undefined
  if (!s || typeof s !== 'object' || !('edges' in s)) return snap
  const { edges, ...rest } = s
  return (rest.tile === undefined && edges !== undefined ? { ...rest, tile: edges } : rest) as T
}

/**
 * The conveyor format 3 inferred from a package, as a declaration (the format 4 upgrade step). Each test is the one
 * the host's classifiers applied in format 3 (core/parts/partGeometry.ts: beltLikeView, curvedGizmoOf, straightConveyorView,
 * spurConveyorView, rotatingDeckView), frozen here: they are what an old package meant, whatever the live rules become.
 */
function inferConveyorV3(pkg: Record<string, unknown>): ConveyorDecl | undefined {
  const params = (pkg.params ?? {}) as Record<string, { handle?: Record<string, unknown> } | undefined>
  const handles = Object.values(params).map((spec) => (spec && typeof spec === 'object' ? spec.handle : undefined)).filter((h): h is Record<string, unknown> => !!h && typeof h === 'object')
  const geo = (pkg.geometry ?? {}) as { kind?: unknown; conveys?: unknown; links?: unknown; joints?: unknown }
  const links = Array.isArray(geo.links) ? (geo.links as Record<string, unknown>[]) : []
  const conveys = geo.kind === 'drawn' ? geo.conveys === true : geo.kind === 'rig' ? links.some((l) => l && l.conveys === true) : false
  const faceX = handles.find((h) => h.kind === 'face' && h.axis === 'x')
  const faceZ = handles.some((h) => h.kind === 'face' && h.axis === 'z')
  let bed: ConveyorDecl['bed']
  if (handles.some((h) => h.kind === 'path')) bed = 'path'
  else if (conveys && handles.some((h) => h.kind === 'arc')) bed = 'arc'
  else if (conveys && faceX && faceZ) bed = faceX.angleFrontParam !== undefined || faceX.angleBackParam !== undefined ? 'spur' : 'straight'
  else if (geo.kind === 'rig' && Array.isArray(geo.joints)) {
    const joint = (geo.joints as { type?: unknown; link?: unknown }[]).find((j) => j && j.type === 'revolute')
    const deck = joint ? links.find((l) => l && l.name === joint.link) : undefined
    if ((deck?.shape as { kind?: unknown } | undefined)?.kind === 'cylinder') bed = 'turntable'
  }
  let belt = bed === 'path'
  if (!belt && geo.kind === 'drawn' && conveys && typeof pkg.behavior === 'string') {
    const parts = evalPartGeometry(pkg.behavior, resolvePartParams(pkg.params as ParamSchema, {}))
    belt = (parts ?? []).some((mp) => mp.finish === 'belt')
  }
  // the names format 3's host mirrored, on a part that conveys
  const speedParam = conveys && (params.speed as { type?: unknown } | undefined)?.type === 'number' ? 'speed' : undefined
  const reverseParam = conveys && (params.reverse as { type?: unknown } | undefined)?.type === 'boolean' ? 'reverse' : undefined
  if (!bed && !belt && !speedParam) return undefined
  return { ...(bed ? { bed } : {}), surface: belt ? 'belt' : 'roller', ...(speedParam ? { speedParam } : {}), ...(reverseParam ? { reverseParam } : {}) }
}

const CONVEYOR_BEDS: readonly string[] = ['straight', 'spur', 'path', 'arc', 'turntable']

/** A conveyor declaration's rules ({@link ConveyorDecl}): each bed has the declaration that gives its geometry. */
function validateConveyor(p: Record<string, unknown> | undefined, problems: PackageProblem[]): void {
  const comms = p?.commsParam
  if (comms !== undefined) {
    const spec = typeof comms === 'string' ? (p?.params as Record<string, { type?: unknown } | undefined> | undefined)?.[comms] : undefined
    if (spec?.type !== 'boolean') problems.push({ field: 'commsParam', message: 'commsParam must name a `boolean` param of this part (the switch that connects its tags to the PLC)' })
  }
  const c = p?.conveyor as { bed?: unknown; surface?: unknown } | undefined
  if (c === undefined) return
  if (typeof c !== 'object' || c === null) {
    problems.push({ field: 'conveyor', message: 'conveyor must be an object: { bed?, surface }' })
    return
  }
  if (c.surface !== 'belt' && c.surface !== 'roller') problems.push({ field: 'conveyor.surface', message: "conveyor.surface must be 'belt' or 'roller' (what cargo rides on, which sets its grip)" })
  const named = (field: string, key: unknown, type: string): void => {
    if (key === undefined) return
    const spec = typeof key === 'string' ? (p?.params as Record<string, { type?: unknown } | undefined> | undefined)?.[key] : undefined
    if (spec?.type !== type) problems.push({ field: `conveyor.${field}`, message: `conveyor.${field} must name a \`${type}\` param of this part` })
  }
  named('speedParam', (c as { speedParam?: unknown }).speedParam, 'number')
  named('reverseParam', (c as { reverseParam?: unknown }).reverseParam, 'boolean')
  if (c.bed === undefined) return
  if (!CONVEYOR_BEDS.includes(c.bed as string)) {
    problems.push({ field: 'conveyor.bed', message: `conveyor.bed must be one of ${CONVEYOR_BEDS.map((b) => `'${b}'`).join(', ')}` })
    return
  }
  const params = (p?.params ?? {}) as Record<string, { type?: unknown; handle?: Record<string, unknown> } | undefined>
  const handleOf = (test: (h: Record<string, unknown>) => boolean): [string, Record<string, unknown>] | undefined => {
    for (const [key, spec] of Object.entries(params)) if (spec?.handle && typeof spec.handle === 'object' && test(spec.handle)) return [key, spec.handle]
    return undefined
  }
  const need = (ok: boolean, message: string): void => {
    if (!ok) problems.push({ field: 'conveyor.bed', message })
  }
  const geo = (p?.geometry ?? {}) as { kind?: unknown; conveys?: unknown; links?: unknown; joints?: unknown }
  const links = Array.isArray(geo.links) ? (geo.links as { name?: unknown; conveys?: unknown; shape?: { kind?: unknown } }[]) : []
  const conveys = geo.kind === 'drawn' ? geo.conveys === true : geo.kind === 'rig' && links.some((l) => l?.conveys === true)
  switch (c.bed) {
    case 'straight':
    case 'spur': {
      const x = handleOf((h) => h.kind === 'face' && h.axis === 'x')
      need(conveys, `a '${c.bed}' bed conveys: give the geometry a conveying surface (a rig's \`conveys\` link, or \`conveys: true\` on drawn geometry)`)
      need(!!x && !!handleOf((h) => h.kind === 'face' && h.axis === 'z'), `a '${c.bed}' bed is sized by its length and width: put a \`face\` handle on the length param (axis 'x') and one on the width param (axis 'z')`)
      if (c.bed === 'spur') need(!!x && (x[1].angleFrontParam !== undefined || x[1].angleBackParam !== undefined), "a 'spur' bed's ends splay: the length param's face handle names angleFrontParam and/or angleBackParam")
      return
    }
    case 'path':
      need(!!handleOf((h) => h.kind === 'path'), "a 'path' bed is edited by a `path` handle on its segments param")
      return
    case 'arc':
      need(conveys, "an 'arc' bed conveys: give the geometry a conveying surface")
      need(!!handleOf((h) => h.kind === 'arc'), "an 'arc' bed is swept by an `arc` handle on its sweep param")
      return
    case 'turntable': {
      const joint = Array.isArray(geo.joints) ? (geo.joints as { type?: unknown; link?: unknown }[]).find((j) => j?.type === 'revolute') : undefined
      const deck = joint ? links.find((l) => l?.name === joint.link) : undefined
      need(geo.kind === 'rig' && deck?.shape?.kind === 'cylinder', "a 'turntable' bed turns: a rig with a revolute joint whose link is a cylinder (the deck; its rim is where neighbours butt)")
      return
    }
  }
}

/** The host finishes a rig link may take ({@link RigLink.finish}). */
export const RIG_FINISHES: readonly Finish[] = ['frame', 'guard', 'leg', 'bolt', 'gapfill', 'roller', 'belt', 'tread', 'deck', 'mesh']

/** Which side of the bed (-Z = left) a link sits on, from its Z offset (base, else the sign of a width-scaled
 *  offsetParam); null when centred. What format 3 read a guard's or frame's side from; format 4 declares it. */
function linkZSide(link: RawLink): 'left' | 'right' | null {
  const offset = Array.isArray(link.offset) ? (link.offset as unknown[]) : []
  let z = typeof offset[2] === 'number' ? offset[2] : 0
  if (z === 0 && Array.isArray(link.offsetParams)) {
    const p = (link.offsetParams as { axis?: unknown; scale?: unknown }[]).find((o) => o && o.axis === 2)
    z = typeof p?.scale === 'number' ? p.scale : 0
  }
  return z === 0 ? null : z < 0 ? 'left' : 'right'
}

/** A rig link as a plain record, for the upgrade steps (which read stored JSON, not typed packages). */
type RawLink = Record<string, unknown> & { shape?: Record<string, unknown> }

/**
 * Format 3 -> 4: the vocabulary pass (docs/sdk-vocabulary.md), one small function per rename over a link or the
 * package, in the order they were made.
 *   link.edges (a wireframe colour)          -> link.outline
 *   link.noCollision: true                   -> link.collision: 'none'
 *   a mesh shape's collision: { size }       -> the link's collision: { box: size }
 *   geometry kind 'function'                 -> 'drawn'
 *   link.array.enabledParam / .grid.enabledParam -> link.showParam (an array that was only the gate is dropped)
 *   a primitive lamp link's color            -> lamps[0].offColor (the colour the lamp shows while dark)
 *   a boolean param named enableComms        -> commsParam: 'enableComms'
 *   no conveyor declaration                  -> conveyor: { bed, surface } where format 3 inferred one, by the same
 *                                               tests (inferConveyorV3): a path handle, a conveying arc handle,
 *                                               conveying x + z face handles (spur when the length handle names
 *                                               splay angles), a revolute joint on a cylinder link; surface belt
 *                                               for a path bed or a drawn bed that draws a belt (default params),
 *                                               else roller; on a conveying part, a number param named speed ->
 *                                               speedParam, a boolean named reverse -> reverseParam
 *   link.grabZone / grabRadius / grabParams  -> link.grip: { zone, radius, radiusParams }
 *   bounds { height, floorY }                -> bounds { top, bottom } (rig, drawn); a cargo box's bounds -> size
 *   snap.edges                               -> snap.tile (also for a snap read from stored behavior code,
 *                                               {@link canonicalSnap})
 *   link role: r                             -> finish: r, plus what the role switched on: a guard / frame box
 *                                               off the centreline -> sideGuard / sideRail: its side; a frame on
 *                                               a conveying rig -> bed: true; a deck box -> notchable: true.
 *                                               (A centred guard-finish box loses its zero friction; no shipped
 *                                               part had one.)
 *   geometry kind 'deck' { length, width }   -> the rig {@link deckRig} builds (same body, footprint and look)
 *   shape kind 'deck' { length, width, h }   -> a box [length, h ?? 0.1, width] with conveys: true
 */
function upgradeToFormat4(pkg: Record<string, unknown>): { pkg: Record<string, unknown>; notes: string[] } {
  const notes: string[] = []
  let geo = pkg.geometry as { kind?: unknown; links?: unknown; length?: unknown; width?: unknown; height?: unknown } | undefined
  let out = pkg
  if (geo && geo.kind === 'function') {
    geo = { ...geo, kind: 'drawn' }
    out = { ...out, geometry: geo }
  }
  if (geo && geo.kind === 'deck') {
    const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback)
    geo = deckRig(num(geo.length, 1), num(geo.width, 1), num(geo.height, 0.1)) as unknown as typeof geo
    out = { ...out, geometry: geo }
  }
  if (geo && geo.kind === 'rig' && Array.isArray(geo.links)) {
    const rigConveys = (geo.links as RawLink[]).some((l) => l && typeof l === 'object' && l.conveys === true)
    const links = (geo.links as RawLink[]).map((raw) => (raw && typeof raw === 'object' ? upgradeLinkTo4(raw, rigConveys, notes) : raw))
    out = { ...out, geometry: { ...geo, links } }
  }
  // bounds: height / floorY -> top / bottom (rig, drawn); a cargo box's bounds -> size
  const g4 = out.geometry as Record<string, unknown> | undefined
  if (g4 && typeof g4 === 'object') {
    const b = g4.bounds as Record<string, unknown> | undefined
    if (g4.kind === 'cargo' && b !== undefined && g4.size === undefined) {
      const { bounds: _b, ...rest } = g4
      out = { ...out, geometry: { ...rest, size: b } }
    } else if (b && typeof b === 'object' && ('height' in b || 'floorY' in b)) {
      const { height, floorY, ...rest } = b
      out = { ...out, geometry: { ...g4, bounds: { ...rest, ...(height !== undefined ? { top: height } : {}), ...(floorY !== undefined ? { bottom: floorY } : {}) } } }
    }
  }
  if (out.snap && typeof out.snap === 'object') {
    const snap = canonicalSnap(out.snap)
    if (snap !== out.snap) out = { ...out, snap }
  }
  if (out.conveyor === undefined) {
    const conveyor = inferConveyorV3(out)
    if (conveyor) out = { ...out, conveyor }
  }
  if (out.commsParam === undefined && ((out.params ?? {}) as Record<string, { type?: unknown } | undefined>).enableComms?.type === 'boolean') out = { ...out, commsParam: 'enableComms' }
  return { pkg: out, notes }
}

/**
 * Package format 4 -> 5: a beam's params become its own declaration. Format 4 drew every beam of a part out to the
 * part's `maxRange` number param when the beam named no `rangeParam`, and hid them all on a false `showBeam` boolean
 * param. This writes those names onto each beam that relied on them. A `rangeParam` also sets the sensing reach,
 * which format 4's name did not (sensing used the static `range`), so the note says so.
 */
function upgradeBeamsToFormat5(pkg: Record<string, unknown>): { pkg: Record<string, unknown>; notes: string[] } {
  const notes: string[] = []
  const geo = pkg.geometry as { kind?: unknown; links?: unknown } | undefined
  if (!geo || geo.kind !== 'rig' || !Array.isArray(geo.links)) return { pkg, notes }
  const params = (pkg.params ?? {}) as Record<string, { type?: unknown } | undefined>
  const range = params.maxRange?.type === 'number'
  const show = params.showBeam?.type === 'boolean'
  if (!range && !show) return { pkg, notes }
  let changed = false
  const links = (geo.links as RawLink[]).map((l) => {
    const beam = l && typeof l === 'object' ? (l.beam as Record<string, unknown> | undefined) : undefined
    if (!beam || typeof beam !== 'object') return l
    const next = { ...beam }
    if (range && next.rangeParam === undefined) {
      next.rangeParam = 'maxRange'
      notes.push(`link "${String(l.name)}": its beam now takes its length from the maxRange param by name (beam.rangeParam), which also sets how far it senses`)
    }
    if (show && next.showParam === undefined) next.showParam = 'showBeam'
    if (next.rangeParam === beam.rangeParam && next.showParam === beam.showParam) return l
    changed = true
    return { ...l, beam: next }
  })
  return changed ? { pkg: { ...pkg, geometry: { ...geo, links } }, notes } : { pkg, notes }
}

function upgradeLinkTo4(raw: RawLink, rigConveys: boolean, notes: string[]): RawLink {
  const { edges, noCollision, role, grabZone, grabRadius, grabParams, ...link } = raw
  const next: RawLink = { ...link }
  if (grabZone !== undefined || grabRadius !== undefined || grabParams !== undefined) {
    next.grip = { ...(grabZone !== undefined ? { zone: grabZone } : {}), ...(grabRadius !== undefined ? { radius: grabRadius } : {}), ...(grabParams !== undefined ? { radiusParams: grabParams } : {}) }
  }
  if (edges !== undefined) next.outline = edges
  if (noCollision === true) next.collision = 'none'
  const array = raw.array as (Record<string, unknown> & { grid?: Record<string, unknown> }) | undefined
  if (array && typeof array === 'object') {
    // array.enabledParam / array.grid.enabledParam -> the link's showParam; an array that was only the gate goes
    const gate = array.enabledParam ?? array.grid?.enabledParam
    if (gate !== undefined) {
      const { enabledParam: _g, ...restArray } = array
      if (restArray.grid && typeof restArray.grid === 'object') {
        const { enabledParam: _gg, ...grid } = restArray.grid
        restArray.grid = grid
      }
      if (restArray.distribute === undefined && restArray.count === undefined && restArray.grid === undefined) delete next.array
      else next.array = restArray
      if (next.showParam === undefined) next.showParam = gate
      else if (next.showParam !== gate) notes.push(`link "${String(raw.name)}" had both showParam "${String(next.showParam)}" and an array gate "${String(gate)}"; format 4 has one switch per link, so it keeps showParam and the link no longer follows "${String(gate)}"`)
    }
  }
  // a primitive lamp link's colour was its lamp's unlit colour: say it on the lamp
  const lamps = raw.lamps
  if (raw.color !== undefined && raw.shape?.kind !== 'mesh' && Array.isArray(lamps) && lamps.length > 0 && lamps[0] && typeof lamps[0] === 'object') {
    const [first, ...others] = lamps as Record<string, unknown>[]
    next.lamps = [first!.offColor === undefined ? { ...first, offColor: raw.color } : first, ...others]
    delete next.color
  }
  if (role !== undefined) {
    next.finish = role
    // what the role switched on, spelled out (format 3 read these off the finish): a guard or frame box off the
    // centreline was a side wall, a frame on a conveying rig joined the conveyor gates, a deck box took notches
    const isBox = raw.shape?.kind === 'box'
    const side = isBox ? linkZSide(raw) : null
    if (role === 'guard' && side) next.sideGuard = side
    if (role === 'frame' && side) next.sideRail = side
    if (role === 'frame' && rigConveys) next.bed = true
    if (role === 'deck' && isBox) next.notchable = true
  }
  const shape = raw.shape
  if (shape && shape.kind === 'deck') {
    const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback)
    next.shape = { kind: 'box', size: [num(shape.length, 1), num(shape.height, 0.1), num(shape.width, 1)] }
    next.conveys = true
  }
  if (shape && shape.kind === 'mesh' && shape.collision !== undefined) {
    const { collision, ...rest } = shape
    next.shape = rest
    const size = (collision as { size?: unknown } | null)?.size
    if (size !== undefined) next.collision = { box: size }
  }
  return next
}

/**
 * Format 2 -> 3: the words that tied neighbour cuts to one pairing (docs/part-snap-cuts.md).
 *   link.railing: edge                 -> link.onEdge: edge
 *   link.stairFoot: true               -> link.anchor: 'floor'
 *   snap.stairMount { accepts, widthParam, stepsParam, reach, risePerStep, treadRun, landingDepth, topOffset }
 *                                      -> snap.edgeMount { accepts, alongParam: widthParam, reach, facing: 'into',
 *                                           at: [landingDepth, topOffset, 0], atParams: steps x tread along X and
 *                                           steps x rise up, fromFloor: { param: stepsParam }, opens, notch, lift }
 *   a mount facing OUT onto a conveyorGuard  -> the same mount with opens: true (format 2 read the facing as "opens")
 * A part carrying both a stairMount and an edgeMount keeps its edgeMount and loses the stairMount, with a note: a
 * package has one edge connector, and no shipped part ever declared both.
 */
function upgradeCutsToFormat3(pkg: Record<string, unknown>): { pkg: Record<string, unknown>; notes: string[] } {
  const notes: string[] = []
  let out = pkg
  const geo = pkg.geometry as { kind?: unknown; links?: unknown } | undefined
  if (geo && geo.kind === 'rig' && Array.isArray(geo.links)) {
    const links = (geo.links as Record<string, unknown>[]).map((raw) => {
      if (!raw || typeof raw !== 'object' || !('railing' in raw || 'stairFoot' in raw)) return raw
      const { railing, stairFoot, ...link } = raw
      return { ...link, ...(railing !== undefined ? { onEdge: railing } : {}), ...(stairFoot === true ? { anchor: 'floor' } : {}) }
    })
    out = { ...out, geometry: { ...geo, links } }
  }
  const snap = pkg.snap as Record<string, unknown> | undefined
  if (snap && typeof snap === 'object') {
    let next: Record<string, unknown> = snap
    const sm = snap.stairMount as Record<string, unknown> | undefined
    if (sm !== undefined) {
      const { stairMount: _gone, ...rest } = next
      next = rest
      if (snap.edgeMount !== undefined) notes.push('snap.stairMount dropped: the part also declares an edgeMount, and a package has one edge connector')
      else if (sm && typeof sm === 'object') {
        const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
        // format 2's defaults, frozen here: they are what an old stairMount meant, whatever the live ones become
        const TREAD_V2 = 0.28
        const RISE_V2 = 0.178
        const steps = sm.stepsParam
        next = {
          ...next,
          edgeMount: {
            accepts: sm.accepts,
            alongParam: sm.widthParam,
            reach: sm.reach,
            facing: 'into',
            at: [num(sm.landingDepth, 0), num(sm.topOffset, 0), 0],
            atParams: [
              { axis: 0, param: steps, scale: num(sm.treadRun, TREAD_V2) },
              { axis: 1, param: steps, scale: num(sm.risePerStep, RISE_V2) },
            ],
            fromFloor: { param: steps },
            opens: true,
            notch: true,
            lift: true,
          },
        }
      }
    }
    if (Array.isArray(next.mounts)) {
      const mounts = (next.mounts as Record<string, unknown>[]).map((m) => (m && m.face === 'out' && m.accepts === 'conveyorGuard' && m.opens === undefined ? { ...m, opens: true } : m))
      next = { ...next, mounts }
    }
    if (next !== snap) out = { ...out, snap: next }
  }
  return { pkg: out, notes }
}

/**
 * Format 1 -> 2: a rig link's lamp fields, spelled seven ways, become {@link RigLink.lamps} + {@link RigLink.squash}.
 *   link.emissive, lampParam, lampOpacity      -> lamps: [{ emissive, param, opacity }]     (a primitive's own lamp)
 *   mesh shape.lamp + link.emissive            -> lamps: [{ emissive, material, param, opacity }]
 *   mesh shape.lamps[{ name, material, ... }]  -> lamps: [{ name, material, emissive, opacity }]
 *   link.lampSquash, squashLamp                -> squash: { amount, lamp }
 * A format-1 `lampParam` lit the lamp named like the link, so it goes to that lamp. Two things format 1 accepted
 * that did nothing are dropped with a note, because format 2 refuses them: an `emissive` on a mesh link with no
 * `lamp` material (nothing to light), and a `lampSquash` off a mesh link (only a mesh link's clones squash).
 */
function upgradeLampsToFormat2(pkg: Record<string, unknown>): { pkg: Record<string, unknown>; notes: string[] } {
  const geo = pkg.geometry as { kind?: unknown; links?: unknown } | undefined
  if (!geo || geo.kind !== 'rig' || !Array.isArray(geo.links)) return { pkg, notes: [] }
  const notes: string[] = []
  const links = (geo.links as Record<string, unknown>[]).map((raw) => {
    if (!raw || typeof raw !== 'object') return raw
    const { emissive, lampParam, lampOpacity, lampSquash, squashLamp, ...link } = raw as Record<string, unknown>
    const shapeIn = link.shape as Record<string, unknown> | undefined
    const mesh = shapeIn?.kind === 'mesh'
    let shape = shapeIn
    const lamps: Record<string, unknown>[] = []
    if (mesh && shapeIn) {
      const { lamp, lamps: specs, ...rest } = shapeIn
      shape = rest
      if (Array.isArray(specs)) for (const spec of specs as Record<string, unknown>[]) lamps.push({ ...spec })
      else if (typeof lamp === 'string' && emissive !== undefined) lamps.push({ emissive, material: lamp })
      else if (emissive !== undefined) notes.push(`link "${String(link.name)}": emissive on a mesh with no lamp material lit nothing; dropped`)
    } else if (emissive !== undefined) lamps.push({ emissive })
    for (const lamp of lamps) {
      if ((lamp.name ?? link.name) !== link.name) continue
      if (lampParam !== undefined) lamp.param = lampParam
      if (lampOpacity !== undefined && lamp.opacity === undefined) lamp.opacity = lampOpacity
    }
    const out: Record<string, unknown> = { ...link, ...(shape ? { shape } : {}) }
    if (lamps.length > 0) out.lamps = lamps
    if (lampSquash !== undefined) {
      if (mesh) out.squash = { amount: lampSquash, ...(squashLamp !== undefined ? { lamp: squashLamp } : {}) }
      else notes.push(`link "${String(link.name)}": lampSquash off a mesh link squashed nothing; dropped`)
    }
    return out
  })
  return { pkg: { ...pkg, geometry: { ...geo, links } }, notes }
}

/**
 * The one way in for a stored package (a scene's embedded snapshot, a project's parts, a room entry): upgraded
 * step by step to {@link PACKAGE_FORMAT}, then its retired rig links dropped ({@link dropRetiredRigLinks}), so
 * every load point handles every old document the same way. Validate the result with validatePartPackage as
 * before. `repairs` lists what was lost or replaced, for the load's repair report; a format upgrade that only
 * respells is not listed. `pkg` is the input itself, uncopied, when nothing at all changed.
 *
 * Anything it cannot carry forward (not an object, no numeric format, a format newer than this build, a missing
 * step) comes back unchanged, and validatePartPackage names the reason. An author's own manifest does not come
 * through here: it is refused with the reason instead (validatePartPackage, check-part).
 */
export function upgradeStoredPackage<T>(raw: T, upgrades: Readonly<Record<number, PackageUpgrade>> = PACKAGE_UPGRADES, current: number = PACKAGE_FORMAT): { pkg: T; repairs: string[] } {
  const repairs: string[] = []
  let pkg: unknown = raw
  const from = (raw as { format?: unknown } | null)?.format
  if (typeof raw === 'object' && raw !== null && Number.isInteger(from) && (from as number) < current) {
    let f = from as number
    let next = raw as Record<string, unknown>
    const notes: string[] = []
    for (; f < current; f++) {
      const step = upgrades[f]
      if (!step) break
      const out = step(next)
      next = { ...out.pkg, format: f + 1 }
      notes.push(...out.notes)
    }
    if (f === current) {
      pkg = next
      // a respelling that loses nothing is not a repair (validate-project --strict fails on repairs, and every
      // document saved before a bump would trip it); only what a step had to drop is reported
      if (notes.length > 0) repairs.push(`package format ${from as number} -> ${current}: ${notes.join('; ')}`)
    }
  }
  const { pkg: kept, dropped } = dropRetiredRigLinks(pkg)
  if (dropped.length > 0) repairs.push(`retired rig link(s) ${dropped.join(', ')} dropped`)
  const { pkg: flat, replaced } = replaceSweepGeometry(kept)
  if (replaced) repairs.push(`retired sweep geometry replaced by a flat deck of the same footprint`)
  const { pkg: unexposed, dropped: exposes } = dropRetiredExposes(flat)
  if (exposes) repairs.push(`retired exposes (a scoped cell's public tags) dropped`)
  const { pkg: snapped, dropped: snapKinds } = dropRetiredSnapKinds(unexposed)
  if (snapKinds.length > 0) repairs.push(`retired ${snapKinds.join(' and ')} dropped`)
  return { pkg: dropServoRamps(snapped) as T, repairs }
}

/** A stored package with its servo joints' `ramp` / `maxJerk` removed. Older parts can carry them, and every servo move
 *  is a trapezoid, so they mean nothing. The input itself when there are none. */
function dropServoRamps<T>(raw: T): T {
  const geo = (raw as { geometry?: { joints?: unknown } } | null)?.geometry
  const joints = geo?.joints
  if (!Array.isArray(joints)) return raw
  const has = (j: unknown): boolean => {
    const s = (j as { servo?: unknown } | null)?.servo
    return typeof s === 'object' && s !== null && ('ramp' in s || 'maxJerk' in s)
  }
  if (!joints.some(has)) return raw
  const next = joints.map((j: unknown) => {
    if (!has(j)) return j
    const { ramp: _ramp, maxJerk: _jerk, ...servo } = (j as { servo: Record<string, unknown> }).servo
    return { ...(j as object), servo }
  })
  return { ...(raw as object), geometry: { ...geo, joints: next } } as T
}

/**
 * `snap.ports` (point-to-point mates, every conveyor end an implicit port) and `snap.rails` (an explicit segment a
 * mount slides along) are retired snap kinds. No first-party or example part declares one. A stored package that
 * still carries one loses it here, with a repair line (a custom part could have declared one; the part keeps
 * loading and stops snapping by it).
 * An author's manifest is refused with the reason instead (validateSnap). Returns the input itself when neither is
 * present.
 */
export const RETIRED_SNAP_KINDS = ['ports', 'rails'] as const
const RETIRED_SNAP_ADVICE = "A device seats on a host with `mounts` (onto a conveyor's guards, a declared `surfaces` entry, or any footprint `'face'`)."

export function dropRetiredSnapKinds<T>(raw: T): { pkg: T; dropped: string[] } {
  const snap = (raw as { snap?: unknown } | null)?.snap
  if (typeof snap !== 'object' || snap === null) return { pkg: raw, dropped: [] }
  const dropped: string[] = RETIRED_SNAP_KINDS.filter((k) => k in snap)
  if (dropped.length === 0) return { pkg: raw, dropped: [] }
  const kept = Object.fromEntries(Object.entries(snap).filter(([k]) => !dropped.includes(k)))
  return { pkg: { ...(raw as object), snap: kept } as T, dropped: dropped.map((k) => `snap.${k}`) }
}

/**
 * `exposes` listed the tags a part offered a scene program when it was placed as a scoped cell: the public half of
 * PLC tag scoping, retired with it. A part's PLC interface is its `'tag'` params, wired by name. A stored
 * package that still carries the field loses it here (it described nothing that runs, so nothing changes); an
 * author's manifest is refused with the reason instead (sim/validatePart.ts). Returns the input itself when absent.
 */
export function dropRetiredExposes<T>(raw: T): { pkg: T; dropped: boolean } {
  if (typeof raw !== 'object' || raw === null || !('exposes' in raw)) return { pkg: raw, dropped: false }
  const { exposes: _retired, ...rest } = raw as Record<string, unknown>
  return { pkg: rest as T, dropped: true }
}

/** The retired whole-part geometry kind: a declarative swept bed, `{ kind: 'mesh', sweep, bounds, conveys? }`.
 *  `geometry()` draws any swept, inclined or curved bed and more, and the sweep is not on the authoring ladder
 *  (docs/procedural-geometry.md). Its physics was a flat deck (an arc or incline was drawn curved but carried
 *  cargo flat), so a stored one becomes exactly that deck ({@link replaceSweepGeometry}).
 *  Not to be confused with a rig link's `shape.kind: 'mesh'`, a GLB model, which stays. Retired. */
export const RETIRED_SWEEP_KIND = 'mesh'
const RETIRED_SWEEP_ADVICE = "draw the bed in the behavior's geometry() with g.sweep (a function geometry, `conveys: true` for a conveyor), as examples/parts/belt-conveyor does"

/**
 * A stored package whose geometry is the retired sweep ({@link RETIRED_SWEEP_KIND}) with a flat `deck` in its
 * place: the footprint the sim already built for it (the sweep's own length, its profile's width), so cargo rides
 * it as before. What is lost is the drawn profile and any param-driven length, which a deck does not have. Unlike
 * a retired rig link this never expires: it converts rather than drops, so it costs a few lines and no grace
 * period. Returns the input itself when there is nothing to replace.
 */
export function replaceSweepGeometry<T>(raw: T): { pkg: T; replaced: boolean } {
  const geo = (raw as { geometry?: { kind?: unknown; sweep?: { profile?: unknown; length?: unknown }; bounds?: { length?: unknown; width?: unknown } } } | null)?.geometry
  if (!geo || geo.kind !== RETIRED_SWEEP_KIND) return { pkg: raw, replaced: false }
  const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
  const profile = Array.isArray(geo.sweep?.profile) ? (geo.sweep.profile as unknown[]) : []
  const ws = profile.map((pt) => (Array.isArray(pt) ? pt[1] : undefined)).filter((w): w is number => typeof w === 'number' && Number.isFinite(w))
  const profileWidth = ws.length ? Math.max(...ws) - Math.min(...ws) : 0
  const length = positive(geo.sweep?.length) ? geo.sweep.length : positive(geo.bounds?.length) ? geo.bounds.length : 1
  const width = positive(profileWidth) ? profileWidth : positive(geo.bounds?.width) ? geo.bounds.width : 1
  return { pkg: { ...(raw as object), geometry: deckRig(length, width) } as T, replaced: true }
}

// Does the parent chain of any link loop back on itself? A cycle would make FK composition (render/sim)
// recurse forever, so it's rejected at import.
function hasParentCycle(parents: Map<string, string | undefined>): boolean {
  for (const start of parents.keys()) {
    const seen = new Set<string>()
    let cur: string | undefined = start
    while (cur !== undefined) {
      if (seen.has(cur)) return true
      seen.add(cur)
      cur = parents.get(cur)
    }
  }
  return false
}

/** A link's {@link RigLink.lamps} and {@link RigLink.squash}. Whether `squash.lamp` names a real lamp is a
 *  reference, checked with the others in core/parts/partAuthoringChecks. */
function validateLinkLamps(l: { name?: unknown; shape?: { kind?: unknown; materials?: unknown }; lamps?: unknown; squash?: unknown; color?: unknown }, at: string, add: (field: string, message: string) => void, lampNames: Set<string>): void {
  if (l.lamps !== undefined) {
    if (!Array.isArray(l.lamps) || l.lamps.length === 0) add(`${at}.lamps`, 'lamps must be a non-empty array of lamps')
    else {
      const mesh = l.shape?.kind === 'mesh'
      if (!mesh && l.lamps.length > 1) add(`${at}.lamps`, "a primitive link carries at most one lamp (its own material); several lamps need a mesh link's materials")
      if (!mesh && l.color !== undefined) add(`${at}.color`, "a lamp link's colours are its lamp's: the lit `emissive` and the dark `offColor` (package format 3 took the link's color for offColor)")
      const remap = (l.shape?.materials ?? {}) as Record<string, unknown>
      l.lamps.forEach((raw: unknown, i: number) => {
        const lamp = raw as { name?: unknown; emissive?: unknown; offColor?: unknown; material?: unknown; opacity?: unknown; param?: unknown } | null
        const la = `${at}.lamps[${i}]`
        const name = lamp?.name === undefined ? l.name : lamp.name
        if (typeof name !== 'string' || name === '') add(`${la}.name`, 'lamp name must be a non-empty string')
        else if (lampNames.has(name)) add(`${la}.name`, `duplicate lamp name "${name}": ctx.lamps has one entry per name (name the second lamp on a link)`)
        else lampNames.add(name)
        // without a lit colour the lamp is a silent no-op: it registers, the behavior toggles it, nothing changes
        if (!isVec3(lamp?.emissive)) add(`${la}.emissive`, 'lamp emissive must be 3 finite numbers (the lit colour, r/g/b in 0..1)')
        if (lamp?.offColor !== undefined && !isVec3(lamp.offColor)) add(`${la}.offColor`, 'lamp offColor must be 3 finite numbers (the dark colour, r/g/b in 0..1)')
        if (mesh) {
          // a lamp may only light a material this link remaps: an un-remapped GLB material is shared with every
          // other part using the model, so repainting it would light their lenses too
          if (typeof lamp?.material !== 'string' || lamp.material === '' || !(lamp.material in remap)) {
            add(`${la}.material`, 'a mesh lamp names the GLB material it lights, one this link remaps (a key of `materials`)')
          }
        } else if (lamp?.material !== undefined) add(`${la}.material`, "lamp material is for a mesh link; a primitive's lamp is its own material")
        if (lamp?.opacity !== undefined && (!isFiniteNum(lamp.opacity) || lamp.opacity <= 0 || lamp.opacity > 1)) add(`${la}.opacity`, 'lamp opacity must be in (0, 1]')
        if (lamp?.param !== undefined && (typeof lamp.param !== 'string' || lamp.param === '')) add(`${la}.param`, 'lamp param must be a non-empty string (a boolean param key)')
      })
    }
  }
  const squash = l.squash as { amount?: unknown; lamp?: unknown } | undefined
  if (squash !== undefined) {
    if (typeof squash !== 'object' || squash === null) add(`${at}.squash`, 'squash must be an object { amount, lamp? }')
    else {
      if (!isFiniteNum(squash.amount) || squash.amount <= 0 || squash.amount > 1) add(`${at}.squash.amount`, 'squash.amount must be a number in (0, 1]')
      if (squash.lamp !== undefined && (typeof squash.lamp !== 'string' || squash.lamp === '')) add(`${at}.squash.lamp`, 'squash.lamp must be a non-empty lamp name')
      if (l.shape?.kind !== 'mesh') add(`${at}.squash`, 'squash compresses a mesh link (a suction cup); this link is not one')
    }
  }
}

function validateRig(g: { links?: unknown; joints?: unknown; posable?: unknown }, problems: PackageProblem[], assetIds: Set<string>, materialIds: Set<string>): void {
  const add = (field: string, message: string): void => {
    problems.push({ field, message })
  }
  if (g.posable !== undefined && typeof g.posable !== 'boolean') add('geometry.posable', 'posable must be a boolean')
  const links = g.links
  if (!Array.isArray(links) || links.length === 0) {
    add('geometry.links', 'rig must have a non-empty links array')
    return
  }
  const names = new Set<string>()
  const lampNames = new Set<string>() // ctx.lamps has one entry per name, across the whole rig
  const parents = new Map<string, string | undefined>()
  links.forEach((raw, i) => {
    const l = raw as { name?: unknown; parent?: unknown; offset?: unknown; rotation?: unknown; shape?: unknown }
    const at = `geometry.links[${i}]`
    if (typeof l?.name !== 'string' || l.name === '') {
      add(`${at}.name`, 'link name must be a non-empty string')
      return
    }
    if (names.has(l.name)) add(`${at}.name`, `duplicate link name "${l.name}"`)
    names.add(l.name)
    parents.set(l.name, typeof l.parent === 'string' ? l.parent : undefined)
    if (!isVec3(l.offset)) add(`${at}.offset`, 'offset must be 3 finite numbers')
    validateSizeParams((l as { offsetParams?: unknown }).offsetParams, `${at}.offsetParams`, add)
    const color = (l as { color?: unknown }).color
    if (color !== undefined && !isVec3(color)) add(`${at}.color`, 'color must be 3 finite numbers (r, g, b in 0..1)')
    const colorParam = (l as { colorParam?: unknown }).colorParam
    if (colorParam !== undefined && (typeof colorParam !== 'string' || colorParam === '')) add(`${at}.colorParam`, 'colorParam must be a non-empty string (a color/string param key)')
    for (const k of ['metalness', 'roughness'] as const) {
      const v = (l as Record<string, unknown>)[k]
      if (v !== undefined && (!isFiniteNum(v) || v < 0 || v > 1)) add(`${at}.${k}`, `${k} must be a number in [0, 1]`)
    }
    const opacity = (l as { opacity?: unknown }).opacity
    if (opacity !== undefined && (!isFiniteNum(opacity) || opacity <= 0 || opacity > 1)) add(`${at}.opacity`, 'opacity must be a number in (0, 1]')
    const outline = (l as { outline?: unknown }).outline
    if (outline !== undefined && !isVec3(outline)) add(`${at}.outline`, 'outline must be 3 finite numbers (r, g, b in 0..1)')
    if ((l as { edges?: unknown }).edges !== undefined) add(`${at}.edges`, 'edges was renamed outline (package format 4)')
    if ((l as { noCollision?: unknown }).noCollision !== undefined) add(`${at}.noCollision`, "noCollision was replaced by collision: 'none' (package format 4)")
    const collision = (l as { collision?: unknown }).collision
    if (collision !== undefined && collision !== 'none') {
      const box = (collision as { box?: unknown } | null)?.box
      if (!isVec3(box) || box.some((n) => n <= 0)) add(`${at}.collision`, "collision must be 'none' or { box: [x, y, z] } (3 positive numbers)")
      else if ((l as { shape?: { kind?: unknown } }).shape?.kind !== 'mesh') add(`${at}.collision.box`, "collision.box is for a mesh link (a primitive collides as its own shape; use 'none' to turn that off)")
    }
    const finish = (l as { finish?: unknown }).finish
    if (finish !== undefined && !RIG_FINISHES.includes(finish as Finish)) add(`${at}.finish`, `finish must be one of ${RIG_FINISHES.map((f) => `'${f}'`).join(',')}`)
    const finishParam = (l as { finishParam?: unknown }).finishParam
    if (finishParam !== undefined && (typeof finishParam !== 'string' || finishParam === '')) add(`${at}.finishParam`, 'finishParam must be the name of an enum param')
    if ((l as { role?: unknown }).role !== undefined) add(`${at}.role`, 'role was split (package format 4): the look is `finish`, and what it switched on is declared on its own (sideGuard, sideRail, bed, notchable)')
    for (const key of ['sideGuard', 'sideRail'] as const) {
      const side = (l as Record<string, unknown>)[key]
      if (side === undefined) continue
      if (side !== 'left' && side !== 'right') add(`${at}.${key}`, `${key} must be 'left' or 'right'`)
      else if ((l as { shape?: { kind?: unknown } }).shape?.kind !== 'box') add(`${at}.${key}`, `${key} is for a box link (the wall the host splits and retracts)`)
    }
    if ((l as { sideGuard?: unknown }).sideGuard !== undefined && (l as { sideRail?: unknown }).sideRail !== undefined) add(`${at}.sideRail`, 'a link is a sideGuard or a sideRail, not both')
    for (const key of ['bed', 'notchable'] as const) {
      const v = (l as Record<string, unknown>)[key]
      if (v !== undefined && typeof v !== 'boolean') add(`${at}.${key}`, `${key} must be a boolean`)
    }
    if ((l as { notchable?: unknown }).notchable === true && (l as { shape?: { kind?: unknown } }).shape?.kind !== 'box') add(`${at}.notchable`, 'notchable is for a box link (the deck slab the host carves)')
    validateLinkLamps(l as { name?: unknown; shape?: { kind?: unknown; materials?: unknown }; lamps?: unknown; squash?: unknown }, at, add, lampNames)
    const beam = (l as { beam?: unknown }).beam as { range?: unknown; rangeParam?: unknown; showParam?: unknown; axis?: unknown; tint?: unknown } | undefined
    if (beam !== undefined) {
      if (!isFiniteNum(beam.range) || beam.range <= 0) add(`${at}.beam.range`, 'beam.range must be > 0')
      if (beam.axis !== undefined && (!isVec3(beam.axis) || beam.axis.every((n) => n === 0))) add(`${at}.beam.axis`, 'beam.axis must be 3 finite numbers, not all zero')
      if (beam.tint !== undefined && beam.tint !== 'hit') add(`${at}.beam.tint`, "beam.tint must be 'hit'")
      if (beam.rangeParam !== undefined && (typeof beam.rangeParam !== 'string' || beam.rangeParam === '')) add(`${at}.beam.rangeParam`, 'beam.rangeParam must be a non-empty param name')
      if (beam.showParam !== undefined && (typeof beam.showParam !== 'string' || beam.showParam === '')) add(`${at}.beam.showParam`, 'beam.showParam must be a non-empty param name')
    }
    const zone = (l as { zone?: unknown }).zone as { size?: unknown; sizeParams?: unknown } | undefined
    if (zone !== undefined) {
      if (!isVec3(zone.size) || zone.size.some((n) => n <= 0)) add(`${at}.zone.size`, 'zone.size must be 3 positive numbers')
      validateSizeParams(zone.sizeParams, `${at}.zone.sizeParams`, add)
    }
    const loadCell = (l as { loadCell?: unknown }).loadCell
    if (loadCell !== undefined) {
      if (typeof loadCell !== 'boolean') add(`${at}.loadCell`, 'loadCell must be a boolean')
      else if (loadCell) {
        // the host weighs what rests on the link's own body, so it needs one: a solid box, not an array of copies
        const lk = l as { shape?: { kind?: unknown }; collision?: unknown; array?: unknown }
        if (lk.shape?.kind !== 'box') add(`${at}.loadCell`, 'loadCell is for a box link (the platform the load rests on)')
        else if (lk.collision === 'none') add(`${at}.loadCell`, "a loadCell link must be solid: remove collision: 'none'")
        else if (lk.array !== undefined) add(`${at}.loadCell`, 'a loadCell link cannot be an array: give each platform its own link')
      }
    }
    for (const old of ['grabZone', 'grabRadius', 'grabParams'] as const) {
      if ((l as Record<string, unknown>)[old] !== undefined) add(`${at}.${old}`, `${old} moved into the link's \`grip\` block (package format 4): grip: { zone, radius, radiusParams }`)
    }
    const grip = (l as { grip?: unknown }).grip as { zone?: { size?: unknown; offset?: unknown; sizeParams?: unknown }; radius?: unknown; radiusParams?: unknown; forks?: unknown } | undefined
    if (grip !== undefined) {
      if (typeof grip !== 'object' || grip === null) add(`${at}.grip`, 'grip must be an object: { zone?, radius?, radiusParams? }')
      else {
        if (grip.radius !== undefined && (!isFiniteNum(grip.radius) || grip.radius <= 0)) add(`${at}.grip.radius`, 'grip.radius must be a positive number (metres)')
        validateSizeParams(grip.radiusParams, `${at}.grip.radiusParams`, add)
        const zone = grip.zone
        if (zone !== undefined) {
          if (!isVec3(zone.size) || zone.size.some((n) => n <= 0)) add(`${at}.grip.zone.size`, 'grip.zone.size must be 3 positive numbers')
          if (zone.offset !== undefined && !isVec3(zone.offset)) add(`${at}.grip.zone.offset`, 'grip.zone.offset must be 3 finite numbers (link-local metres)')
          validateSizeParams(zone.sizeParams, `${at}.grip.zone.sizeParams`, add)
        }
        const forks = grip.forks as { spread?: unknown; spreadParam?: unknown; bladeWidth?: unknown; bladeThickness?: unknown } | undefined
        if (forks !== undefined) {
          if (typeof forks !== 'object' || forks === null) add(`${at}.grip.forks`, 'grip.forks must be an object: { spread? | spreadParam?, bladeWidth, bladeThickness }')
          else {
            for (const k of ['bladeWidth', 'bladeThickness'] as const) {
              if (!isFiniteNum(forks[k]) || (forks[k] as number) <= 0) add(`${at}.grip.forks.${k}`, `grip.forks.${k} must be a positive number (metres)`)
            }
            if (forks.spread !== undefined && (!isFiniteNum(forks.spread) || (forks.spread as number) <= 0)) add(`${at}.grip.forks.spread`, 'grip.forks.spread must be a positive number (metres)')
            if (forks.spreadParam !== undefined && (typeof forks.spreadParam !== 'string' || forks.spreadParam === '')) add(`${at}.grip.forks.spreadParam`, 'grip.forks.spreadParam must name a number param')
            if (forks.spread === undefined && forks.spreadParam === undefined) add(`${at}.grip.forks`, 'grip.forks needs a spread or a spreadParam')
          }
        }
      }
    }
    const conveys = (l as { conveys?: unknown }).conveys
    if (conveys !== undefined && typeof conveys !== 'boolean') add(`${at}.conveys`, 'conveys must be a boolean')
    const hidden = (l as { hidden?: unknown }).hidden
    if (hidden !== undefined && typeof hidden !== 'boolean') add(`${at}.hidden`, 'hidden must be a boolean')
    const showParam = (l as { showParam?: unknown }).showParam
    if (showParam !== undefined && (typeof showParam !== 'string' || showParam === '')) add(`${at}.showParam`, 'showParam must be a non-empty string (a boolean param key)')
    const onEdge = (l as { onEdge?: unknown }).onEdge
    if (onEdge !== undefined && !['posX', 'negX', 'posZ', 'negZ'].includes(onEdge as string)) add(`${at}.onEdge`, "onEdge must be one of 'posX','negX','posZ','negZ' (the deck edge this link runs on)")
    const anchor = (l as { anchor?: unknown }).anchor
    if (anchor !== undefined && anchor !== 'floor') add(`${at}.anchor`, "anchor must be 'floor'")
    const dropWhenMounted = (l as { dropWhenMounted?: unknown }).dropWhenMounted
    if (dropWhenMounted !== undefined && typeof dropWhenMounted !== 'boolean') add(`${at}.dropWhenMounted`, 'dropWhenMounted must be a boolean')
    if ((l as { railing?: unknown }).railing !== undefined) add(`${at}.railing`, 'railing was renamed onEdge (package format 3)')
    if ((l as { stairFoot?: unknown }).stairFoot !== undefined) add(`${at}.stairFoot`, "stairFoot was renamed anchor: 'floor' (package format 3)")
    validateArray((l as { array?: unknown }).array, `${at}.array`, add)
    if (l.rotation !== undefined && !isVec3(l.rotation)) add(`${at}.rotation`, 'rotation must be 3 finite numbers')
    if ((l as { quat?: unknown }).quat !== undefined && !isVec4((l as { quat?: unknown }).quat)) add(`${at}.quat`, 'quat must be 4 finite numbers (x, y, z, w)')
    validateRigShape(l.shape, `${at}.shape`, add, assetIds, materialIds)
  })
  // parent references must resolve to a declared link
  links.forEach((raw, i) => {
    const l = raw as { parent?: unknown }
    if (l?.parent !== undefined && (typeof l.parent !== 'string' || !names.has(l.parent))) {
      add(`geometry.links[${i}].parent`, 'parent must reference an existing link')
    }
  })
  if (hasParentCycle(parents)) add('geometry.links', 'link parent hierarchy has a cycle')
  // C-aim: a two-point look-at target must resolve to a declared link; up (if given) must be a valid axis
  links.forEach((raw, i) => {
    const aim = (raw as { aim?: unknown }).aim as { target?: unknown; up?: unknown } | undefined
    if (aim === undefined) return
    if (typeof aim.target !== 'string' || !names.has(aim.target)) add(`geometry.links[${i}].aim.target`, 'aim.target must reference an existing link')
    if (aim.up !== undefined && (!isVec3(aim.up) || aim.up.every((n) => n === 0))) add(`geometry.links[${i}].aim.up`, 'aim.up must be 3 finite numbers, not all zero')
  })

  const joints = g.joints
  if (!Array.isArray(joints)) {
    add('geometry.joints', 'rig must have a joints array (may be empty)')
    return
  }
  const jointNames = new Set<string>()
  joints.forEach((raw, i) => {
    const j = raw as { name?: unknown; link?: unknown; type?: unknown; axis?: unknown; min?: unknown; max?: unknown; cosmetic?: unknown; rest?: unknown }
    const at = `geometry.joints[${i}]`
    if (typeof j?.name !== 'string' || j.name === '') add(`${at}.name`, 'joint name must be a non-empty string')
    else {
      if (jointNames.has(j.name)) add(`${at}.name`, `duplicate joint name "${j.name}"`)
      jointNames.add(j.name)
    }
    if (typeof j?.link !== 'string' || !names.has(j.link)) add(`${at}.link`, 'joint.link must reference an existing link')
    if (j?.type !== 'revolute' && j?.type !== 'prismatic') add(`${at}.type`, 'joint.type must be "revolute" or "prismatic"')
    if (!isVec3(j?.axis) || j.axis.every((n) => n === 0)) add(`${at}.axis`, 'axis must be 3 finite numbers, not all zero')
    if (!isFiniteNum(j?.min) || !isFiniteNum(j?.max) || j.min > j.max) add(`${at}.limits`, 'min/max must be finite with min <= max')
    if (j?.cosmetic !== undefined && typeof j.cosmetic !== 'boolean') add(`${at}.cosmetic`, 'cosmetic must be a boolean')
    for (const key of ['minParam', 'maxParam'] as const) {
      const ref = (j as Record<string, unknown> | undefined)?.[key] as { param?: unknown; scale?: unknown; add?: unknown; min?: unknown; max?: unknown } | undefined
      if (ref === undefined) continue
      if (typeof ref !== 'object' || ref === null || typeof ref.param !== 'string' || ref.param === '') add(`${at}.${key}`, `${key} must be { param, scale?, add?, min?, max? } naming a number param`)
      else for (const f of ['scale', 'add', 'min', 'max'] as const) if (ref[f] !== undefined && !isFiniteNum(ref[f])) add(`${at}.${key}.${f}`, `${key}.${f} must be a finite number`)
    }
    if (j?.rest !== undefined) {
      const rest = j.rest as { param?: unknown; scale?: unknown; add?: unknown }
      if (typeof rest?.param !== 'string' || rest.param === '') add(`${at}.rest.param`, 'joint rest.param must be a non-empty param name')
      if (rest?.scale !== undefined && !isFiniteNum(rest.scale)) add(`${at}.rest.scale`, 'joint rest.scale must be a finite number')
      if (rest?.add !== undefined && !isFiniteNum(rest.add)) add(`${at}.rest.add`, 'joint rest.add must be a finite number')
    }
    const servo = (j as { servo?: unknown } | undefined)?.servo
    if (servo !== undefined) {
      const s = servo as Record<string, unknown> | null
      const positive = (v: unknown) => isFiniteNum(v) && v > 0
      if (typeof s !== 'object' || s === null) add(`${at}.servo`, 'servo must be { maxVelocity, maxAccel, maxDecel?, modulo? }')
      else {
        if (!positive(s.maxVelocity)) add(`${at}.servo.maxVelocity`, 'servo.maxVelocity must be a positive number')
        if (!positive(s.maxAccel)) add(`${at}.servo.maxAccel`, 'servo.maxAccel must be a positive number')
        if (s.maxDecel !== undefined && !positive(s.maxDecel)) add(`${at}.servo.maxDecel`, 'servo.maxDecel must be a positive number')
        // `ramp` / `maxJerk` are not refused, so an older part that has them still loads; a stored package
        // loses them (dropServoRamps)
        if (s.modulo !== undefined) {
          if (!positive(s.modulo)) add(`${at}.servo.modulo`, 'servo.modulo must be a positive number')
          else if (j?.type !== 'revolute') add(`${at}.servo.modulo`, 'only a revolute joint can wrap (servo.modulo)')
          // the wrapped position falls in [0, modulo), and every pose is clamped to the joint's limits
          else if (isFiniteNum(j?.min) && isFiniteNum(j?.max) && (j.min > 0 || j.max < (s.modulo as number))) add(`${at}.servo.modulo`, 'a wrapping servo\'s joint min / max must cover 0 to modulo')
        }
      }
      if (j?.cosmetic === true) add(`${at}.servo`, 'a cosmetic joint cannot be a servo: a servo is commanded, cosmetic dressing is not')
    }
  })
}

/** Is `v` a {@link PartCredit}: short texts, and an https link if any. */
export function isPartCredit(v: unknown): v is PartCredit {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const c = v as Record<string, unknown>
  const text = (x: unknown, max: number): boolean => typeof x === 'string' && x.trim() !== '' && x.length <= max
  if (!text(c.library, 100)) return false
  if (c.by !== undefined && !text(c.by, 100)) return false
  if (c.url !== undefined && !(text(c.url, 300) && /^https:\/\/[^\s]+$/.test(c.url as string))) return false
  return Object.keys(c).every((k) => k === 'by' || k === 'library' || k === 'url')
}
