import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  Group,
  Mesh,
  NearestFilter,
  NoBlending,
  RGBAFormat,
  ShaderMaterial,
  Sphere,
  Vector2,
  Vector3,
} from 'three'
import type { InstancedMesh, Object3D, SkinnedMesh, Texture } from 'three'
import { retireGeometry, retireTexture } from '../gpuRetire'
import { noteGeometryRecycle } from '../geometryRecycle'

/**
 * Palette-merged outline mask, so the mask pass's draw count doesn't grow with the number of selected parts.
 *
 * Pooled hardware and cargo outline through the aSel channel, but each selected part's unique meshes
 * would otherwise draw individually into the mask (a six-axis robot ~45 draws; select-all on the demo
 * ~+300). This manager merges them into one position-only geometry:
 *
 *  - Baked in mesh-local space with a per-vertex `aSlot` index: pure memcpy, re-run only when the
 *    merged set changes (caught by the per-frame signature below).
 *  - Per frame, each slot's matrixWorld and tier (1 regular / 2 active) go into a float DataTexture,
 *    the palette, so drags and rig poses never re-bake. A hidden mesh gets an all-zero matrix (its
 *    triangles go degenerate), so visibility flips don't re-bake either. The vertex shader fetches by
 *    aSlot: one draw for the whole selection.
 *  - Leftovers stay per-mesh: InstancedMesh banks (transforms in their own buffers) and skinned/morphing
 *    meshes (no part has one).
 *
 * The per-frame signature walk hashes mesh identity, geometry identity/version and poolHidden, so a
 * resize's bank swap, an in-place edit or a drag-eject re-bakes on the frame it happens (see
 * consolidatedOutlineNode's regularRoots comment for why membership is re-read per frame).
 *
 * Owned by the view. The twins render `mesh`: WebGL with its own ShaderMaterial (call setSceneDepth
 * first), WebGPU with its TSL palette material built from `palette`. `group` sits hidden in the scene
 * so the WebGPU twin's filtered render can reach it, flipped visible only inside the mask bracket.
 * `?nomaskmerge` falls back to the per-mesh path.
 */

/**
 * The merged geometry's bounding sphere, set at bake time. Its positions are each source's local space, so a sphere
 * computed from them describes no real place. three still asks for one: the mesh is never frustum-culled, but the
 * renderer's draw sort reads the sphere's centre, and with none set it walks every vertex. Selecting the demo's
 * Building merges ~540k vertices, and that walk cost ~44 ms on every selection.
 */
function unboundedSphere(): Sphere {
  return new Sphere(new Vector3(), Infinity)
}

/** On by default, with an off switch, mirroring ?noinstancepool / ?nobundle. Node/headless ⇒ on. */
export function wantsOutlineMaskMerge(): boolean {
  return typeof location === 'undefined' || !new URLSearchParams(location.search).has('nomaskmerge')
}

// palette row layout: texels 0-3 = matrixWorld columns, texel 4 = (tier, 0, 0, 0)
const TEXELS_PER_SLOT = 5
const FLOATS_PER_SLOT = TEXELS_PER_SLOT * 4
const INITIAL_SLOTS = 1024

// Slot lookup: aSlot is a per-vertex float. All three verts of a triangle carry the same value, so
// interpolation is exact up to float error, and the +0.5 truncation absorbs that error.
// The matrix is applied manually as an affine combination (no mat4 ctor needed) and the mesh
// sits at identity, so viewMatrix alone completes the model-view transform.
const MERGE_MASK_VERT = /* glsl */ `
  uniform sampler2D uPalette;
  attribute float aSlot;
  varying float vTier;
  void main() {
    int slot = int(aSlot + 0.5);
    vec4 c0 = texelFetch(uPalette, ivec2(0, slot), 0);
    vec4 c1 = texelFetch(uPalette, ivec2(1, slot), 0);
    vec4 c2 = texelFetch(uPalette, ivec2(2, slot), 0);
    vec4 c3 = texelFetch(uPalette, ivec2(3, slot), 0);
    vTier = texelFetch(uPalette, ivec2(4, slot), 0).x;
    vec4 wp = c0 * position.x + c1 * position.y + c2 * position.z + c3;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp.xyz, 1.0);
  }
`

// same occlusion test + tier encoding as the pool mask (consolidatedOutline.ts POOL_MASK_FRAG),
// with the tier from the palette instead of a per-instance attribute
const MERGE_MASK_FRAG = /* glsl */ `
  uniform sampler2D uSceneDepth;
  uniform vec2 uResolution;
  varying float vTier;
  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float sceneD = texture2D(uSceneDepth, uv).x;
    float visible = gl_FragCoord.z <= sceneD + 0.00005 ? 0.25 : 0.0;
    float tierBase = vTier < 1.5 ? 0.25 : 0.75;
    gl_FragColor = vec4(tierBase + visible, 0.0, 0.0, 1.0);
  }
`

const noRaycast = (): void => {}

/** version counter of a position attribute (plain or interleaved) - bumped on any GPU re-upload */
function attrVersion(attr: { version: number } | { data: { version: number } }): number {
  return 'data' in attr ? attr.data.version : attr.version
}

/** the slice of the manager the outline twins consume */
export interface OutlineMaskMergeSurface {
  /** the one merged mask mesh (parented under `group`) - 0 slots ⇒ nothing to render */
  mesh: Mesh
  /** hidden scene mount; the WebGPU twin flips it visible inside its mask bracket only */
  group: Group
  /** current palette texture - re-minted on capacity growth, so re-check identity per frame */
  palette: DataTexture
  slotCount: number
  /** unmergeable selected meshes (InstancedMesh banks, skinned), still drawn per mesh, by tier */
  leftoverRegular: readonly Object3D[]
  leftoverActive: readonly Object3D[]
  /** WebGL twin: point the merged material at this frame's scene depth before rendering */
  setSceneDepth(depth: Texture, width: number, height: number): void
}

export class OutlineMaskMergeManager implements OutlineMaskMergeSurface {
  readonly group = new Group()
  readonly mesh: Mesh
  palette: DataTexture
  slotCount = 0
  leftoverRegular: Object3D[] = []
  leftoverActive: Object3D[] = []

  private paletteData: Float32Array
  private capacity = INITIAL_SLOTS
  private roots: { obj: Object3D; tier: number }[] = []
  // slot i = sources[i]; tier stored alongside so the palette write needs no map lookups
  private sources: { mesh: Mesh; tier: number }[] = []
  private bakedSig = 0
  private readonly material: ShaderMaterial

  constructor() {
    this.group.name = 'outlineMaskMerge'
    this.group.visible = false
    this.group.userData.outlineMaskMerge = true
    this.group.matrixAutoUpdate = false
    this.paletteData = new Float32Array(this.capacity * FLOATS_PER_SLOT)
    this.palette = this.mintPalette()
    this.material = new ShaderMaterial({
      vertexShader: MERGE_MASK_VERT,
      fragmentShader: MERGE_MASK_FRAG,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uPalette: { value: this.palette },
        uSceneDepth: { value: null },
        uResolution: { value: new Vector2(1, 1) },
      },
    })
    this.mesh = new Mesh(new BufferGeometry(), this.material)
    this.mesh.frustumCulled = false
    this.mesh.matrixAutoUpdate = false
    this.mesh.raycast = noRaycast
    this.mesh.userData.outlineMaskMergeMesh = true
    this.group.add(this.mesh)
  }

  private mintPalette(): DataTexture {
    const tex = new DataTexture(this.paletteData, TEXELS_PER_SLOT, this.capacity, RGBAFormat, FloatType)
    tex.magFilter = NearestFilter
    tex.minFilter = NearestFilter
    tex.generateMipmaps = false
    return tex
  }

  /**
   * New outline membership (refreshOutline, already gated on its selection/structure signature).
   * The roots are the same live objects handed to ISelectionOutline.select - parts on the regular
   * tier, the active node (and rig-highlight link meshes) on the active tier.
   */
  setMembership(regular: readonly Object3D[], active: readonly Object3D[]): void {
    this.roots = [
      ...regular.map((obj) => ({ obj, tier: 1 })),
      ...active.map((obj) => ({ obj, tier: 2 })),
    ]
    this.rebake()
  }

  /**
   * Per frame, after the view's matrix walk and before the outline renders: re-bake if the merged
   * set went stale (geometry swap/edit, pool eject, part added under a selected root), then
   * refresh the palette from the sources' current world matrices + visibility.
   */
  tick(): void {
    if (this.roots.length === 0) return
    const sig = this.walkSig()
    if (sig !== this.bakedSig) this.rebake()
    this.writePalette()
  }

  setSceneDepth(depth: Texture, width: number, height: number): void {
    this.material.uniforms['uSceneDepth']!.value = depth
    this.material.uniforms['uResolution']!.value.set(width, height)
  }

  /**
   * Dev/E2E merge-coherence invariant (view.auditMergeCoherence). {@link tick} re-bakes on a
   * signature change every frame, so at an idle point after a tick the baked signature must equal a
   * fresh walk. A mismatch means the mask mesh being drawn no longer matches the selected meshes it
   * was baked from: tick() is not reaching this manager on the render path, the only way this merge
   * can go stale.
   */
  auditCoherence(): { ok: boolean; reason: string } {
    if (this.roots.length === 0) return { ok: true, reason: '' }
    if (this.walkSig() === this.bakedSig) return { ok: true, reason: '' }
    return { ok: false, reason: 'stale outline mask merge: selected meshes changed since the last bake (tick() not reaching the manager?)' }
  }

  /** hash of everything whose change must re-bake: identity, geometry version, pool hiding */
  private walkSig(): number {
    let h = 0
    const mix = (v: number): void => { h = (Math.imul(h, 31) + v) | 0 }
    for (const { obj, tier } of this.roots) {
      mix(tier)
      obj.traverse((o) => {
        const m = o as Mesh
        if (!m.isMesh) return
        mix(m.id)
        const geo = m.geometry
        mix(geo.id)
        const pos = geo.getAttribute('position')
        // InterleavedBufferAttribute keeps its version on the backing data buffer
        mix(pos ? attrVersion(pos) + pos.count : -1)
        mix(geo.index ? geo.index.version + geo.index.count : -1)
        mix(geo.drawRange.start + (Number.isFinite(geo.drawRange.count) ? geo.drawRange.count : -1))
        mix(m.userData.poolHidden === true ? 1 : 0)
      })
    }
    return h
  }

  /**
   * True when the mesh and every ancestor are visible. Pooled sources (`poolHidden`) never reach
   * here: classify() drops them earlier, since the pool's own aSel channel draws their silhouettes.
   */
  private static effectiveVisible(mesh: Object3D): boolean {
    for (let o: Object3D | null = mesh; o; o = o.parent) {
      if (!o.visible) return false
    }
    return true
  }

  private classify(): { merge: Map<Mesh, number>; leftReg: Object3D[]; leftAct: Object3D[] } {
    const merge = new Map<Mesh, number>()
    const leftReg: Object3D[] = []
    const leftAct: Object3D[] = []
    for (const { obj, tier } of this.roots) {
      obj.traverse((o) => {
        const m = o as Mesh
        if (!m.isMesh) return
        // pool-hidden sources never mask via the merge or the leftover path (the pool's aSel
        // render draws their silhouette); a drag-eject un-hides them, which the signature walk
        // catches as a re-bake. Checked first so a pooled InstancedMesh bank doesn't leak into
        // leftovers and double-draw.
        if (m.userData.poolHidden === true) return
        if ((m as unknown as InstancedMesh).isInstancedMesh || (m as unknown as SkinnedMesh).isSkinnedMesh || m.geometry.morphAttributes.position) {
          ;(tier === 2 ? leftAct : leftReg).push(m)
          return
        }
        if (!m.geometry.getAttribute('position')) return
        // a mesh reachable from both tiers (a rig-highlight link inside a selected part) keeps
        // the active tier, the same priority the per-mesh path gets from draw order + mask max()
        const prev = merge.get(m)
        if (prev === undefined || tier > prev) merge.set(m, tier)
      })
    }
    return { merge, leftReg, leftAct }
  }

  /** rebuild the merged geometry + slot table from the current roots (memcpy-only bake) */
  private rebake(): void {
    const { merge, leftReg, leftAct } = this.classify()
    this.leftoverRegular = leftReg
    this.leftoverActive = leftAct

    // sizes: vertices are copied whole; indices honour drawRange (non-indexed sources get
    // sequential indices synthesised over their drawRange window)
    let vertTotal = 0
    let idxTotal = 0
    for (const m of merge.keys()) {
      const geo = m.geometry
      const pos = geo.getAttribute('position')!
      vertTotal += pos.count
      const range = geo.drawRange
      if (geo.index) idxTotal += Math.min(geo.index.count - range.start, range.count)
      else idxTotal += Math.min(pos.count - range.start, range.count)
    }

    // Recycle the bake buffers when the merged set is the same size as last time. That case repeats:
    // a drag re-bakes on every pointer-move (the walk signature changes with the sources) while the
    // selection's meshes stay the same. Reusing the arrays means the rebake frees nothing, so nothing
    // can be freed under a live recording (gpuRetire.ts), and a drag doesn't allocate three sizeable
    // typed arrays per frame. A membership change falls through to a mint.
    const cur = this.mesh.geometry
    const curPos = cur.getAttribute('position') as BufferAttribute | undefined
    const curSlot = cur.getAttribute('aSlot') as BufferAttribute | undefined
    const curIdx = cur.index
    const reuse =
      curPos?.array.length === vertTotal * 3 &&
      curSlot?.array.length === vertTotal &&
      curIdx?.array.length === Math.max(idxTotal, 0) &&
      curIdx.array instanceof Uint32Array
    const positions = reuse ? (curPos!.array as Float32Array) : new Float32Array(vertTotal * 3)
    const slots = reuse ? (curSlot!.array as Float32Array) : new Float32Array(vertTotal)
    const indices = reuse ? (curIdx!.array as Uint32Array) : new Uint32Array(Math.max(idxTotal, 0))
    this.sources = []
    let vertBase = 0
    let idxBase = 0
    for (const [m, tier] of merge) {
      const slot = this.sources.length
      this.sources.push({ mesh: m, tier })
      const geo = m.geometry
      const pos = geo.getAttribute('position')!
      if ((pos as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) {
        for (let i = 0; i < pos.count; i++) {
          positions[(vertBase + i) * 3] = pos.getX(i)
          positions[(vertBase + i) * 3 + 1] = pos.getY(i)
          positions[(vertBase + i) * 3 + 2] = pos.getZ(i)
        }
      } else {
        positions.set((pos.array as Float32Array).subarray(0, pos.count * 3), vertBase * 3)
      }
      slots.fill(slot, vertBase, vertBase + pos.count)
      const range = geo.drawRange
      if (geo.index) {
        const src = geo.index.array
        const count = Math.min(geo.index.count - range.start, range.count)
        for (let i = 0; i < count; i++) indices[idxBase + i] = src[range.start + i]! + vertBase
        idxBase += count
      } else {
        const count = Math.min(pos.count - range.start, range.count)
        for (let i = 0; i < count; i++) indices[idxBase + i] = range.start + i + vertBase
        idxBase += count
      }
      vertBase += pos.count
    }

    noteGeometryRecycle(reuse)
    if (reuse) {
      // same buffers, new contents: upload in place
      curPos!.needsUpdate = true
      curSlot!.needsUpdate = true
      curIdx!.needsUpdate = true
      cur.boundingBox = null
      cur.boundingSphere = unboundedSphere()
    } else {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(positions, 3))
      geometry.setAttribute('aSlot', new BufferAttribute(slots, 1))
      geometry.setIndex(new BufferAttribute(indices, 1))
      geometry.boundingSphere = unboundedSphere()
      const old = this.mesh.geometry
      this.mesh.geometry = geometry
      // Retire, don't dispose: a rebake happens while the render loop runs (the deferred interaction
      // warm stages an everything-selected membership over the running scene, then restores it: two
      // rebakes back to back), so the encode that last drew this geometry can still be in flight.
      // Freeing it here destroys buffers under that submit, Dawn rejects the whole command buffer
      // and the main pass goes black (gpuRetire.ts).
      retireGeometry(old)
    }

    // Palette capacity never shrinks. A growth re-mints the texture, and consumers re-check `palette`
    // identity per frame (consolidatedOutlineNode.renderMask), so rebind first and retire the old
    // texture after: a recorded bundle still holds the old GPUTexture in its bind group, and
    // destroying it under that replay drops the whole command buffer (gpuRetire.ts). Deferring the
    // free by one tick is not enough: one frame doesn't mean the re-record happened, and during a
    // burst of structural changes no record happens at all.
    if (this.sources.length > this.capacity) {
      while (this.capacity < this.sources.length) this.capacity *= 2
      this.paletteData = new Float32Array(this.capacity * FLOATS_PER_SLOT)
      const old = this.palette
      this.palette = this.mintPalette()
      this.material.uniforms['uPalette']!.value = this.palette
      retireTexture(old)
    }
    this.slotCount = this.sources.length
    this.bakedSig = this.walkSig()
  }

  /** stream every slot's current world matrix + tier; hidden meshes collapse via a zero matrix */
  private writePalette(): void {
    if (this.slotCount === 0) return
    const data = this.paletteData
    for (let i = 0; i < this.sources.length; i++) {
      const { mesh, tier } = this.sources[i]!
      const base = i * FLOATS_PER_SLOT
      if (OutlineMaskMergeManager.effectiveVisible(mesh)) {
        data.set(mesh.matrixWorld.elements, base)
      } else {
        data.fill(0, base, base + 16)
      }
      data[base + 16] = tier
    }
    this.palette.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.palette.dispose()
  }
}
