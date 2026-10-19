import { Color, DataTexture, EquirectangularReflectionMapping, FloatType, LinearFilter, LinearSRGBColorSpace, Mesh, MeshStandardMaterial, RGBAFormat, SphereGeometry } from 'three'
import type { Material, Object3D } from 'three'

/**
 * Something for metals to reflect: the scene's sky as an environment map, given to metallic materials only.
 *
 * The scene is lit by a HemisphereLight (env.ts), which reflects nothing, so without this a metal (no diffuse
 * term) gets only the two directional lights' highlights and renders dark and flat, an untextured one
 * near-black. A hemisphere light is the closed-form irradiance of a sky one colour above the horizon and
 * another below. This environment is that sky as radiance, so a metal reflects the same light the hemisphere
 * gives everything else, plus a horizon and a few soft overhead patches (the plant's fixtures) that move a
 * highlight along a rounded or polished part as the camera moves.
 *
 * Why metals only, not `scene.environment`: three's environment sampling code roughly doubles every lit
 * shader's compile time on WebGPU (Dawn). Applied scene-wide it would move the loading cover from ~10 s to
 * ~13-15 s on the demo. Dielectrics (paint, plastic, concrete) reflect a few percent at most, so only
 * metals look different. A material only gets the environment's shader cost if it is metallic enough to
 * show it (MIN_METALNESS).
 *
 * Its strength follows metalness: zero at 0.5, the hemisphere light's strength at 1. A metallic material
 * still has a (1 - metalness) diffuse share, which this environment lights a second time on top of the
 * hemisphere light. Ramping the strength keeps that double count under ~5% while the most metallic
 * surfaces reflect the most.
 */

/** the scene's hemisphere light, which env.ts lights with and this environment reproduces as radiance */
export const SCENE_SKY = { sky: 0xc4cfdc, ground: 0x9a948a, intensity: 1.15 } as const

/** below this a material reflects too little to be worth the environment's compile cost */
const MIN_METALNESS = 0.6

const W = 256
const H = 128
/** fixture patches: elevations (deg) x azimuth steps, radiance as a multiple of the sky's, angular radius */
const FIXTURE_ELEVATIONS = [42, 68]
const FIXTURE_AZIMUTHS = 8
const FIXTURE_GAIN = 2.5
const FIXTURE_RADIUS_DEG = 5
/** the open sky's radiance against the hemisphere colour, trimmed so the patches' extra light nets out */
const SKY_SCALE = 0.95

let texture: DataTexture | null = null
let brightness = 1
const dressed = new Set<MeshStandardMaterial>()

/** An equirectangular HDR environment of the sky colours, ready for `material.envMap` (three PMREMs it). */
function skyTexture(): DataTexture {
  if (texture) return texture
  const sky = new Color(SCENE_SKY.sky).multiplyScalar(SKY_SCALE)
  const ground = new Color(SCENE_SKY.ground)
  const patchSky = new Color(SCENE_SKY.sky)
  const data = new Float32Array(W * H * 4)
  const fixtures: { x: number; y: number; z: number }[] = []
  for (const elev of FIXTURE_ELEVATIONS) {
    for (let k = 0; k < FIXTURE_AZIMUTHS; k++) {
      const az = ((k + 0.5) / FIXTURE_AZIMUTHS) * Math.PI * 2
      const e = (elev * Math.PI) / 180
      fixtures.push({ x: Math.cos(e) * Math.cos(az), y: Math.sin(e), z: Math.cos(e) * Math.sin(az) })
    }
  }
  const cosR = Math.cos((FIXTURE_RADIUS_DEG * Math.PI) / 180)
  for (let row = 0; row < H; row++) {
    // three's equirect lookup: v = asin(dir.y) / PI + 0.5, and a DataTexture's row 0 is v = 0 (straight down)
    const lat = ((row + 0.5) / H - 0.5) * Math.PI
    const y = Math.sin(lat)
    // a soft horizon over a couple of degrees, so the prefilter has no hard step to ring on
    const skyMix = Math.min(1, Math.max(0, 0.5 + y / 0.06))
    for (let col = 0; col < W; col++) {
      const lon = ((col + 0.5) / W) * Math.PI * 2
      const dx = Math.cos(lat) * Math.cos(lon)
      const dz = Math.cos(lat) * Math.sin(lon)
      let r = ground.r + (sky.r - ground.r) * skyMix
      let g = ground.g + (sky.g - ground.g) * skyMix
      let b = ground.b + (sky.b - ground.b) * skyMix
      for (const f of fixtures) {
        const c = dx * f.x + y * f.y + dz * f.z
        if (c <= cosR) continue
        const t = (c - cosR) / (1 - cosR) // 0 at the patch edge, 1 at its centre
        const w = FIXTURE_GAIN * t * t
        r += patchSky.r * w
        g += patchSky.g * w
        b += patchSky.b * w
      }
      const i = (row * W + col) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 1
    }
  }
  texture = new DataTexture(data, W, H, RGBAFormat, FloatType)
  texture.mapping = EquirectangularReflectionMapping
  texture.colorSpace = LinearSRGBColorSpace
  texture.magFilter = LinearFilter
  texture.minFilter = LinearFilter
  texture.needsUpdate = true
  return texture
}

/**
 * The environment strength for a material of `metalness`: the hemisphere light's (its envmap term is
 * albedo * radiance * intensity, the light's albedo * color * intensity / PI), ramped from 0 at 0.5.
 */
function intensityFor(metalness: number): number {
  const ramp = Math.min(1, Math.max(0, (metalness - 0.5) / 0.5))
  return ((SCENE_SKY.intensity * brightness) / Math.PI) * ramp
}

/**
 * Give every metallic material under `root` the sky to reflect, and take it back from one no longer
 * metallic enough. Called where visuals are made and rebuilt (registry.createPartVisual,
 * structureRev.bumpStructureVersion), so a material has it before its first compile. Idempotent.
 */
export function dressMetals(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh) return
    const mats: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const mat of mats) {
      const m = mat as MeshStandardMaterial
      if (typeof m?.metalness !== 'number') continue
      const ours = m.userData.metalEnv === true
      if (m.metalness >= MIN_METALNESS) {
        if (m.envMap && !ours) continue // an authored envMap wins
        if (!ours) {
          m.envMap = skyTexture()
          m.userData.metalEnv = true
          m.needsUpdate = true
          if (!dressed.has(m)) {
            dressed.add(m)
            m.addEventListener('dispose', () => dressed.delete(m))
          }
        }
        m.envMapIntensity = intensityFor(m.metalness)
      } else if (ours) {
        m.envMap = null
        delete m.userData.metalEnv
        m.needsUpdate = true
        dressed.delete(m)
      }
    }
  })
}

const glass = new Set<MeshStandardMaterial>()
const glassIntensity = (): number => (SCENE_SKY.intensity * brightness) / Math.PI

/**
 * Give a glass material the sky to reflect at full strength. Glass is the one dielectric that needs it: an
 * opaque dark pane has almost no diffuse light, so without a reflection it renders as a black rectangle. The
 * Fresnel term keeps it dark head-on and bright at a glancing angle. dressMetals leaves it alone, since it only
 * takes back an environment it gave.
 */
export function dressGlass(m: MeshStandardMaterial): void {
  if (glass.has(m)) return
  m.envMap = skyTexture()
  m.envMapIntensity = glassIntensity()
  m.needsUpdate = true
  glass.add(m)
  m.addEventListener('dispose', () => glass.delete(m))
}

/** Scene brightness for the metals' and glass's reflections (env.setLighting); returns whether anything changed. */
export function setMetalEnvBrightness(b: number): boolean {
  if (b === brightness) return false
  brightness = b
  for (const m of dressed) m.envMapIntensity = intensityFor(m.metalness)
  for (const m of glass) m.envMapIntensity = glassIntensity()
  return dressed.size + glass.size > 0
}

let probe: Mesh | null = null
/**
 * A tiny metal for the idle warm-up to compile (viewWarm warmInteractionExtras*). The first material
 * that samples this environment makes three turn it into a PMREM (two programs and a render) and compile its
 * own environment variant, inside the first frame that draws it: 1.1-2.9 s, measured opening the roller conveyor's
 * definition on an empty scene, with no metal drawn earlier in the session. Compiling this probe after the cover
 * lifts does that work while idle. The caller keeps it in the scene, hidden, so its program stays cached.
 */
export function metalWarmProbe(): Mesh {
  if (!probe) {
    probe = new Mesh(new SphereGeometry(0.01, 4, 2), new MeshStandardMaterial({ metalness: 1, roughness: 0.5 }))
    probe.name = 'metalWarmProbe'
    probe.visible = false
    dressMetals(probe)
  }
  return probe
}
