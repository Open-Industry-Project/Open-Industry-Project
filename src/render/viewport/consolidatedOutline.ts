import {
  Color,
  DepthTexture,
  HalfFloatType,
  NoBlending,
  AdditiveBlending,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  WebGLRenderTarget,
} from 'three'
import type { Camera, Object3D, WebGLRenderer } from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import type { RenderQuality } from '../quality'
import type { ISelectionOutline } from './outline'
import type { OutlineMaskMergeSurface } from './outlineMaskMerge'
import { SEL_ATTR, batchHasSelection } from './selTierChannel'
import {
  ACTIVE_HIDDEN_EDGE,
  ACTIVE_VISIBLE_EDGE,
  EDGE_FEATHER,
  EDGE_STRENGTH,
  HIDDEN_EDGE,
  VISIBLE_EDGE,
} from './outline'

/**
 * Consolidated selection outline - the Blender-overlay-style single-pass design (the WebGL twin of
 * consolidatedOutlineNode.ts). three's stock OutlinePass chain runs two tiers, each a mask render +
 * ~5 fullscreen passes (downsample → edge → separable blur ×N) for a soft glow this app sets to zero.
 * This draws one combined mask and runs one fullscreen detect-and-composite pass: on a multi-select,
 * ~12 fullscreen passes become 1. The saving is largest on WebGPU, where per-pass setup is pricier.
 *
 * Combined mask: a single R channel with five discrete values, ordered so a plain max() over a pixel
 * neighbourhood yields the correct priority (active beats regular; within a tier, visible beats the
 * dimmed/occluded look drawn for xrayed segments):
 *   0.0  background
 *   0.25 regular, occluded     -> HIDDEN_EDGE
 *   0.5  regular, visible      -> VISIBLE_EDGE
 *   0.75 active,  occluded     -> ACTIVE_HIDDEN_EDGE
 *   1.0  active,  visible      -> ACTIVE_VISIBLE_EDGE
 * Occlusion is decided in the mask shader by comparing the fragment's window-space depth against the
 * scene depth the RenderPass already wrote (depthTexture) - the same depth-reuse trick the WebGL
 * OutlinePass override uses, so no second scene render. Selected geometry is drawn depth-test-off so
 * occluded segments are still written to the mask (tagged occluded) for the xray dim.
 */

// Uses three's chunks so the standard transform path runs - critically <project_vertex>, which
// applies instanceMatrix under USE_INSTANCING. Roller-conveyor hardware (rollers) are InstancedMesh;
// a hand-written `modelViewMatrix * position` ignores per-instance transforms and piles every
// instance onto the base transform (a stray blob in the mask). three injects the instanceMatrix
// attribute + USE_INSTANCING define automatically when this material renders an InstancedMesh.
const MASK_VERT = /* glsl */ `
  #include <common>
  void main() {
    #include <begin_vertex>
    #include <project_vertex>
  }
`

// occluded selected fragment -> tier base; visible -> tier base + 0.25 (see value table above)
const MASK_FRAG = /* glsl */ `
  uniform sampler2D uSceneDepth;
  uniform vec2 uResolution;
  uniform float uTierBase;      // 0.25 regular, 0.75 active
  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float sceneD = texture2D(uSceneDepth, uv).x;   // window-space [0,1]
    float fragD = gl_FragCoord.z;
    // small bias so a selected surface that IS the frontmost pixel reads visible, not self-occluded
    float visible = fragD <= sceneD + 0.00005 ? 0.25 : 0.0;
    gl_FragColor = vec4(uTierBase + visible, 0.0, 0.0, 1.0);
  }
`

// Pool-mesh mask: the persistent instance pools carry a per-instance `aSel` selection channel
// (instancePool.setSelectionTiers: 0 unselected / 1 regular / 2 active). One render of the pool
// group covers every selected part's pooled hardware - unselected instances discard - so the
// mask's draw calls scale with #pools, not #selected parts (the select-100 sustained cost).
// The SimBoxes cargo batches carry the same channel (boxes.setSelectionTiers), so selected
// boxes/pallets mask from inside their instanced batch through this same material.
const POOL_MASK_VERT = /* glsl */ `
  #include <common>
  attribute float ${SEL_ATTR};
  varying float vSel;
  void main() {
    vSel = ${SEL_ATTR};
    #include <begin_vertex>
    #include <project_vertex>
  }
`

const POOL_MASK_FRAG = /* glsl */ `
  uniform sampler2D uSceneDepth;
  uniform vec2 uResolution;
  varying float vSel;
  void main() {
    if (vSel < 0.5) discard;
    vec2 uv = gl_FragCoord.xy / uResolution;
    float sceneD = texture2D(uSceneDepth, uv).x;
    float visible = gl_FragCoord.z <= sceneD + 0.00005 ? 0.25 : 0.0;
    float tierBase = vSel < 1.5 ? 0.25 : 0.75;
    gl_FragColor = vec4(tierBase + visible, 0.0, 0.0, 1.0);
  }
`

const DETECT_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// One pass: for each pixel, sample the mask around a ring of radius uThickness (two sub-rings for a
// smoother band). A pixel is inside the outline band when its neighbourhood straddles a mask boundary
// (it sees both selected samples and background samples), which centres a ~2*thickness band on the
// silhouette (matching OutlinePass's centred edge). Rather than a hard in/out test (which looks
// aliased/heavy vs the stock blur-feathered edge), the band's coverage is feathered: it peaks where
// selection and background are balanced (right on the silhouette) and ramps to 0 toward the band's
// inner/outer extremes, over uFeather of the range (see EDGE_FEATHER). The band colour comes from the
// highest-priority selected value seen (max()). Coverage is written to alpha; AdditiveBlending is
// SRC_ALPHA,ONE, so it adds col*strength*coverage over the HDR scene (tone-mapped later).
const DETECT_FRAG = /* glsl */ `
  uniform sampler2D uMask;
  uniform vec2 uTexel;          // 1 / resolution
  uniform float uThickness;     // px radius of the outline band (half-width)
  uniform float uEdgeStrength;
  uniform float uFeather;       // ramp width as a fraction of the band (0 = hard edge, 0.5 = softest)
  uniform vec3 uRegOcc;
  uniform vec3 uRegVis;
  uniform vec3 uActOcc;
  uniform vec3 uActVis;
  varying vec2 vUv;

  const int DIRS = 16;
  const int RINGS = 2;
  const float TWO_PI = 6.28318530718;

  void main() {
    float center = texture2D(uMask, vUv).r;
    float maxSel = center;
    float bg = center > 0.003 ? 0.0 : 1.0;
    float total = 1.0;
    for (int i = 0; i < DIRS; i++) {
      float a = float(i) * (TWO_PI / float(DIRS));
      vec2 dir = vec2(cos(a), sin(a));
      for (int r = 1; r <= RINGS; r++) {
        vec2 o = dir * (uThickness * (float(r) * 0.5)) * uTexel;
        float m = texture2D(uMask, vUv + o).r;
        maxSel = max(maxSel, m);
        bg += m > 0.003 ? 0.0 : 1.0;
        total += 1.0;
      }
    }
    float bgFrac = bg / total;
    float selFrac = 1.0 - bgFrac;
    // feathered coverage: solid where the neighbourhood is balanced (the silhouette), ramping to 0
    // as it becomes all-selection (inner rim) or all-background (outer rim).
    float cov = smoothstep(0.0, uFeather, selFrac) * smoothstep(0.0, uFeather, bgFrac);
    if (cov < 0.004) discard;
    // classify the winning value into one of the four edge colours
    vec3 col;
    if (maxSel > 0.875) col = uActVis;
    else if (maxSel > 0.625) col = uActOcc;
    else if (maxSel > 0.375) col = uRegVis;
    else col = uRegOcc;
    gl_FragColor = vec4(col * uEdgeStrength, cov);
  }
`

/** the combined mask + single detect/composite, as one EffectComposer pass (needsSwap off: it
 *  composites additively into readBuffer in place, like the stock outline overlay) */
class ConsolidatedOutlinePass extends Pass {
  private regularObjects: Object3D[] = []
  private activeObjects: Object3D[] = []
  private readonly maskScene = new Scene()
  private readonly empty: Object3D[] = []
  private readonly maskRT: WebGLRenderTarget
  private readonly maskMaterial: ShaderMaterial
  private readonly poolMaskMaterial: ShaderMaterial
  private readonly detectMaterial: ShaderMaterial
  private readonly fsQuad: FullScreenQuad
  private readonly camera: Camera
  private readonly getSelChannelMeshes: (all: boolean) => readonly Object3D[]
  private readonly getMaskMerge: () => OutlineMaskMergeSurface | null
  private readonly size = new Vector2()
  // true only inside warm(): take every sel-channel batch (nothing is selected at warm time, so the
  // draw gate would otherwise skip them all and their mask materials would compile on the first
  // real selection, the stall this warm exists to remove), and composite into a scratch target
  // instead of the scene's, so a warm can never paint.
  private warming = false
  private warmTarget: WebGLRenderTarget | null = null

  constructor(
    resolution: Vector2,
    camera: Camera,
    getSelChannelMeshes: (all: boolean) => readonly Object3D[],
    getMaskMerge: () => OutlineMaskMergeSurface | null,
  ) {
    super()
    this.needsSwap = false
    this.camera = camera
    this.getSelChannelMeshes = getSelChannelMeshes
    this.getMaskMerge = getMaskMerge
    this.maskScene.matrixWorldAutoUpdate = false
    // 8-bit is enough: the mask holds exact multiples of 0.25. No depth buffer - occlusion is
    // resolved in the shader against the scene depth, and selected geometry draws depth-test-off.
    this.maskRT = new WebGLRenderTarget(resolution.x, resolution.y, {
      format: RGBAFormat,
      type: UnsignedByteType,
      depthBuffer: false,
    })
    this.maskRT.texture.generateMipmaps = false
    this.maskMaterial = new ShaderMaterial({
      vertexShader: MASK_VERT,
      fragmentShader: MASK_FRAG,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSceneDepth: { value: null },
        uResolution: { value: new Vector2(resolution.x, resolution.y) },
        uTierBase: { value: 0.25 },
      },
    })
    this.poolMaskMaterial = new ShaderMaterial({
      vertexShader: POOL_MASK_VERT,
      fragmentShader: POOL_MASK_FRAG,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSceneDepth: { value: null },
        uResolution: { value: new Vector2(resolution.x, resolution.y) },
      },
    })
    // ~1px half-width band (→ ~2px outline); the stock OutlinePass edge is feathered/AA, so a solid
    // 1.5px band looks visibly heavier; 1.0 matches its perceived weight. Keep in sync with the
    // WebGPU twin's OUTLINE_THICKNESS (consolidatedOutlineNode.ts).
    const thickness = 1.0
    this.detectMaterial = new ShaderMaterial({
      vertexShader: DETECT_VERT,
      fragmentShader: DETECT_FRAG,
      transparent: true,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uMask: { value: this.maskRT.texture },
        uTexel: { value: new Vector2(1 / resolution.x, 1 / resolution.y) },
        uThickness: { value: thickness },
        uEdgeStrength: { value: EDGE_STRENGTH },
        uFeather: { value: EDGE_FEATHER },
        uRegOcc: { value: new Color().copy(HIDDEN_EDGE) },
        uRegVis: { value: new Color().copy(VISIBLE_EDGE) },
        uActOcc: { value: new Color().copy(ACTIVE_HIDDEN_EDGE) },
        uActVis: { value: new Color().copy(ACTIVE_VISIBLE_EDGE) },
      },
    })
    this.fsQuad = new FullScreenQuad(this.detectMaterial)
  }

  select(objects: readonly Object3D[], activeObjects: readonly Object3D[]): void {
    this.regularObjects = objects as Object3D[]
    this.activeObjects = activeObjects as Object3D[]
  }

  override setSize(width: number, height: number): void {
    this.maskRT.setSize(width, height)
    this.maskMaterial.uniforms['uResolution']!.value.set(width, height)
    this.detectMaterial.uniforms['uTexel']!.value.set(1 / width, 1 / height)
  }

  override render(
    renderer: WebGLRenderer,
    _writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    if (this.regularObjects.length === 0 && this.activeObjects.length === 0) return
    if (!readBuffer.depthTexture) return
    renderer.getDrawingBufferSize(this.size)

    // 1. combined mask: draw both tiers into maskRT, occlusion resolved against the scene depth.
    // Borrow the selected roots into maskScene (their world matrices are current from the main pass)
    // so we render only the selection, never touching the real scene graph.
    const oldAutoClear = renderer.autoClear
    const oldClearColor = renderer.getClearColor(new Color())
    const oldClearAlpha = renderer.getClearAlpha()
    renderer.autoClear = false
    this.maskMaterial.uniforms['uSceneDepth']!.value = readBuffer.depthTexture
    this.maskMaterial.uniforms['uResolution']!.value.set(this.size.x, this.size.y)
    renderer.setRenderTarget(this.maskRT)
    renderer.setClearColor(0x000000, 1)
    renderer.clear(true, false, false)
    // Selected parts' pooled hardware stays merged (deferred ejection): its silhouette comes from
    // one render of the pool mesh holding it, tiered per instance by the aSel channel (0 → shader
    // discard). Draw calls here scale with #pools holding selection, not #selected parts: the
    // batches with no selected row are gated out (selTierChannel.batchHasSelection), since every
    // fragment of those would be discarded anyway. The cargo batches (SimBoxes) go through the
    // same render and the same gate. Rendered first so the per-part tier renders below keep their
    // overlap priority (active over regular).
    const selChannelMeshes = this.getSelChannelMeshes(this.warming)
    if (selChannelMeshes.length > 0) {
      this.poolMaskMaterial.uniforms['uSceneDepth']!.value = readBuffer.depthTexture
      this.poolMaskMaterial.uniforms['uResolution']!.value.set(this.size.x, this.size.y)
      this.maskScene.overrideMaterial = this.poolMaskMaterial
      this.maskScene.children = selChannelMeshes as Object3D[]
      renderer.render(this.maskScene, this.camera)
    }
    // Palette-merged mask (outlineMaskMerge.ts): one merged mesh covers every selected part's
    // unique (non-instanced) meshes, tiered from its palette. It carries its own material (the
    // tier is baked per slot, not an override), so render it with overrideMaterial cleared. The
    // per-tier renders below then draw only the leftovers the merge couldn't absorb (InstancedMesh
    // banks / skinned), so mask draws don't scale with #selected parts. Null merge (stock or
    // ?nomaskmerge is off this path) ⇒ regularObjects/activeObjects are the full roots.
    const merge = this.getMaskMerge()
    if (merge && merge.slotCount > 0) {
      merge.setSceneDepth(readBuffer.depthTexture, this.size.x, this.size.y)
      this.maskScene.overrideMaterial = null
      this.maskScene.children = [merge.mesh]
      renderer.render(this.maskScene, this.camera)
    }
    const regular = merge ? merge.leftoverRegular : this.regularObjects
    const active = merge ? merge.leftoverActive : this.activeObjects
    this.maskScene.overrideMaterial = this.maskMaterial
    if (regular.length > 0) {
      this.maskMaterial.uniforms['uTierBase']!.value = 0.25
      this.maskScene.children = regular as Object3D[]
      renderer.render(this.maskScene, this.camera)
    }
    if (active.length > 0) {
      this.maskMaterial.uniforms['uTierBase']!.value = 0.75
      this.maskScene.children = active as Object3D[]
      renderer.render(this.maskScene, this.camera)
    }
    this.maskScene.children = this.empty

    // 2. detect + composite the outline band additively over the scene already in readBuffer
    this.detectMaterial.uniforms['uMask']!.value = this.maskRT.texture
    this.detectMaterial.uniforms['uTexel']!.value.set(1 / this.size.x, 1 / this.size.y)
    // warming: composite into a 4x4 scratch instead - the program compiles the same, no pixel of this
    // reaches the screen, and it cannot form a feedback loop by writing the mask it is sampling
    renderer.setRenderTarget(this.warming ? (this.warmTarget ??= new WebGLRenderTarget(4, 4)) : readBuffer)
    this.fsQuad.render(renderer)

    renderer.setClearColor(oldClearColor, oldClearAlpha)
    renderer.autoClear = oldAutoClear
  }

  /**
   * Compile this pass's programs off the interaction path: one full mask + detect, off screen.
   *
   * The mask substitutes its materials at render time (overrideMaterial / the merge's own material),
   * which no `renderer.compile()` can reach, so without this they link on the user's first click.
   * Measured on the demo, WebGL: without the warm, the first selection of a session compiles 7
   * programs in a 106 ms frame. This is the WebGL half; the WebGPU twin is consolidatedOutlineNode.warmSelection.
   *
   * The caller stages a synthetic membership first (viewWarm.ts warmSelectionOutline) and restores it after.
   */
  warm(renderer: WebGLRenderer, readBuffer: WebGLRenderTarget): void {
    if (!readBuffer.depthTexture) return
    const prevTarget = renderer.getRenderTarget()
    this.warming = true
    try {
      this.render(renderer, readBuffer, readBuffer)
    } finally {
      this.warming = false
      renderer.setRenderTarget(prevTarget)
    }
  }

  override dispose(): void {
    this.warmTarget?.dispose()
    this.maskRT.dispose()
    this.maskMaterial.dispose()
    this.poolMaskMaterial.dispose()
    this.detectMaterial.dispose()
    this.fsQuad.dispose()
  }
}

/**
 * ISelectionOutline surface over ConsolidatedOutlinePass, mirroring SelectionOutline's composer
 * wiring (scene RenderPass → outline → OutputPass) so it drops in behind the same seam.
 */
export class ConsolidatedSelectionOutline implements ISelectionOutline {
  private readonly renderer: WebGLRenderer
  private readonly composer: EffectComposer
  private readonly pass: ConsolidatedOutlinePass

  constructor(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: Camera,
    quality: RenderQuality,
    getMaskMerge: () => OutlineMaskMergeSurface | null = () => null,
  ) {
    this.renderer = renderer
    renderer.info.autoReset = false
    const size = renderer.getDrawingBufferSize(new Vector2())
    const target = new WebGLRenderTarget(size.x, size.y, {
      type: HalfFloatType,
      samples: quality.msaaSamples,
      depthTexture: new DepthTexture(size.x, size.y),
    })
    this.composer = new EffectComposer(renderer, target)
    // One scene pass, editor overlays included: every overlay material is transparent, depth-test-off and
    // high renderOrder (gizmo.ts, handles.ts, viewOverlays.ts), so it draws after all opaque geometry and
    // on top of it. Don't add a second render() for overlays: into this MSAA target each render() costs a
    // full resolve, and three invalidates the multisampled colour after each resolve, so the second render
    // draws into a buffer the driver may discard (it would nearly triple the 95th-percentile frame). The WebGPU
    // path keeps its overlay sub-pass for a different reason: bundles there execute after every base draw
    // (consolidatedOutlineNode.renderLayeredScene).
    this.composer.addPass(new RenderPass(scene, camera))
    // The aSel-carrying groups are found by tag: the instance-pool output group (may not exist
    // yet at construction, and is absent entirely under ?noinstancepool) plus the SimBoxes cargo
    // group (selChannelGroup). Of their batches the pass wants only the ones whose rows actually
    // hold a selected instance - every other one is a draw the mask material discards in full
    // (selTierChannel.ts). Re-read per frame: pool membership, cargo rows and the selection all
    // move underneath this, and the batches are few, so there is nothing worth caching.
    const getSelChannelMeshes = (all: boolean): Object3D[] => {
      const out: Object3D[] = []
      for (const g of scene.children) {
        if (g.userData.instancePoolGroup !== true && g.userData.selChannelGroup !== true) continue
        for (const m of g.children) if (all || batchHasSelection(m)) out.push(m)
      }
      return out
    }
    this.pass = new ConsolidatedOutlinePass(size.clone(), camera, getSelChannelMeshes, getMaskMerge)
    this.composer.addPass(this.pass)
    this.composer.addPass(new OutputPass())
  }

  select(objects: readonly Object3D[], activeObjects: readonly Object3D[] = []): void {
    this.pass.select(objects, activeObjects)
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height)
  }

  setPixelRatio(value: number): void {
    this.composer.setPixelRatio(value)
  }

  render(): void {
    this.renderer.info.reset()
    this.composer.render()
  }

  /** see ConsolidatedOutlinePass.warm - the composer owns the read target the mask needs for depth */
  warmSelection(): void {
    this.pass.warm(this.renderer, this.composer.readBuffer)
  }

  /** the RenderPass draws the scene, overlays included, into the read buffer */
  sceneTarget(): WebGLRenderTarget {
    return this.composer.readBuffer
  }

  dispose(): void {
    this.pass.dispose()
    this.composer.dispose()
  }
}
