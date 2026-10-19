import { Color, DirectionalLight, GridHelper, HemisphereLight } from 'three'
import type { Object3D, Scene } from 'three'
import { GROUND_SIZE } from '../core/types'
import { shadowMapSize } from './quality'
import { setWallLightmapBrightness } from './parts/wallLightmaps'
import { notifyBundleStructureChanged } from './bundleGroups'
import { SCENE_SKY, setMetalEnvBrightness } from './metalEnvironment'

const DEFAULT_BACKGROUND = '#9fb1c4'
const HEMI_BASE = SCENE_SKY.intensity
const KEY_BASE = 2.1
const FILL_BASE = 1.0

/**
 * The editor overlays (the transform/resize/ruler manipulators, sensor beams, flow arrows, the
 * floor grid) are on this layer, in addition to layer 0, so the WebGPU path can draw them in a
 * final sub-pass after the bundled main pass, against its full depth buffer. Render bundles execute
 * after every base draw there (finishRender → executeBundles), so drawn inline they would be painted
 * over (consolidatedOutlineNode.ts renderLayeredScene). WebGL draws them inline: their materials are
 * transparent and depth-test-off with a high renderOrder, so they draw last and on top anyway.
 * The main lights are enabled here too so a lit overlay looks the same in its own pass.
 * Staying on layer 0 keeps them visible to every raycaster (default layer 0).
 */
export const OVERLAY_LAYER = 3

/**
 * The building's authored look. Shadow-map resolution is not here: it is a
 * per-client preference (quality.ts shadowQualityPref), because it describes the viewer's GPU
 * rather than the scene, and because resizing a live shadow map blacks out the WebGPU bundled
 * pass. Brightness and background are genuine scene data - every viewer should see the same plant.
 */
export interface Lighting {
  brightness: number
  backgroundColor: string
}

export const DEFAULT_LIGHTING: Lighting = { brightness: 1, backgroundColor: DEFAULT_BACKGROUND }

export interface Environment {
  /** drive the lights, and the baked walls' brightness, from the lighting params (defaults when no building) */
  setLighting(lighting: Lighting): void
  /** show/hide the floor reference grid */
  setGridVisible(visible: boolean): void
  /** the floor reference grid itself - the view hands it to the overlay sub-pass (see below) */
  readonly grid: Object3D
  /**
   * Flag the main key's shadow map for one recompute on the next render. The map is frozen (see
   * createEnvironment) and the view calls this on every frame something that casts into it may have
   * moved (viewBundles.ts, refreshKeyShadowIfDirty). A no-op under `?liveshadow`, where it re-renders every frame.
   */
  refreshKeyShadow(): void
  dispose(): void
}

/** `?liveshadow`: the main key's shadow re-renders every frame (no freeze), for A/B */
function liveKeyShadow(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).has('liveshadow')
}

export function createEnvironment(scene: Scene): Environment {
  // sky-ish background
  const background = new Color(DEFAULT_BACKGROUND)
  scene.background = background

  // ambient light: a cool sky above and a slightly warm ground bounce below, so undersides aren't dead
  // black. Metals reflect this same sky as an environment map (metalEnvironment.ts)
  const hemi = new HemisphereLight(SCENE_SKY.sky, SCENE_SKY.ground, HEMI_BASE)

  // key + fill directional rig (light comes from these directions toward the origin).
  // Soft, partial-strength shadows (0.6 shadow opacity).
  const key = new DirectionalLight(0xfff3e0, KEY_BASE)
  key.position.set(-8.1, 16.4, 8.1)
  key.castShadow = true
  key.shadow.mapSize.set(shadowMapSize, shadowMapSize)
  const shadowCam = key.shadow.camera
  const half = GROUND_SIZE / 2 + 2
  shadowCam.left = -half
  shadowCam.right = half
  shadowCam.top = half
  shadowCam.bottom = -half
  shadowCam.near = 0.5
  shadowCam.far = 90
  shadowCam.updateProjectionMatrix()
  key.shadow.bias = -0.0004
  key.shadow.normalBias = 0.02
  key.shadow.radius = 4
  // Frozen: the key does track moving boxes and parts, but on a parked editor frame nothing that casts into
  // it moves, and re-rendering a 2048² depth pass of the whole plant per frame wastes idle GPU (and
  // battery). The view flags it on every frame that can have moved a caster (refreshKeyShadow);
  // `?liveshadow` restores the per-frame render for A/B.
  if (!liveKeyShadow()) {
    key.shadow.autoUpdate = false
    key.shadow.needsUpdate = true
  }

  const fill = new DirectionalLight(0xdde6f2, FILL_BASE)
  fill.position.set(10, 14, -10)

  // No backdrop ground plane (just the sky outside the building): a plane coplanar
  // with the building floor at y=0 z-fought it. The pilot's walk floor is an invisible y=0 plane (pilot.ts) and
  // box physics uses a separate static body (world.ts), so neither needs a mesh.
  const grid = new GridHelper(GROUND_SIZE, GROUND_SIZE, 0x6b727b, 0x848b94)
  grid.position.y = 0.002
  grid.material.transparent = true
  grid.material.opacity = 0.35
  grid.material.depthWrite = false
  grid.visible = false // off by default; the editor toggles it on via setGridVisible
  // Drawn in the overlay sub-pass, not inline, like the flow arrows and sensor beams
  // (flowArrowBank.ts / sensorBeamOverlay.ts). The grid is a depthWrite-off translucent overlay
  // 2 mm above the floor, so inline it would go in the base transparent pass. Under WebGPU render
  // bundles the backend executes bundles last (finishRender → executeBundles), so the bundled
  // building floor would be painted over it and the toggle would show nothing. It keeps depthTest
  // on, and the overlay pass runs against the full depth buffer, so parts and walls still occlude
  // the grid; only the draw order changes. frustumCulled=false keeps the overlay pass's cached
  // projection (subPassCache) camera-independent.
  grid.layers.enable(OVERLAY_LAYER)
  grid.frustumCulled = false

  // the editor overlays draw in their own sub-pass under these main lights (see OVERLAY_LAYER)
  for (const l of [hemi, key, fill]) l.layers.enable(OVERLAY_LAYER)

  scene.add(hemi, key, key.target, fill, fill.target, grid)

  const setLighting = (lighting: Lighting): void => {
    const b = lighting.brightness
    hemi.intensity = HEMI_BASE * b
    // the metals' reflections scale with it; a uniform on both backends, but WebGPU's bundled main pass
    // replays it stale, so re-record on a change
    if (setMetalEnvBrightness(b)) notifyBundleStructureChanged()
    key.intensity = KEY_BASE * b
    fill.intensity = FILL_BASE * b
    // the walls' light is baked (scripts/bake-wall-lighting.mjs defines it); brightness scales it the same way
    setWallLightmapBrightness(b)
    background.set(lighting.backgroundColor)
    // NEVER resize the shadow map here. The resolution is fixed for the session (quality.ts
    // shadowMapSize) because three's ShadowNode.renderShadow re-`setSize`s the map on every
    // shadow render, and RenderTarget.setSize disposes on a change. That destroys the
    // ShadowDepthTexture that recorded WebGPU bundles hold by handle, which blacks out the whole
    // bundled main pass without throwing. retireTexture cannot prevent it (the free happens inside
    // three), so the size must never change. Ledger: docs/three-coupling.md.
  }

  return {
    setLighting,
    grid,
    setGridVisible(visible: boolean): void {
      grid.visible = visible
    },
    refreshKeyShadow(): void {
      key.shadow.needsUpdate = true
    },
    dispose(): void {
      scene.remove(hemi, key, key.target, fill, fill.target, grid)
      hemi.dispose()
      grid.geometry.dispose()
      grid.material.dispose()
      key.dispose()
      fill.dispose()
    },
  }
}
