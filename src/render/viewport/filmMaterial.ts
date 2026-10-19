import { Color, DoubleSide, MeshStandardMaterial } from 'three'
import { SCENE_SKY } from '../metalEnvironment'
import { webgpuNodeFactory } from '../renderMode'

/**
 * The stretch film material for load dressings (cargoDressing.ts): a sleeve round a load, or a web from a roll.
 *
 * A flat translucent sheet of one opacity reads as tinted glass. Film is recognised by how its density and gloss
 * change, so the shader adds three things:
 *
 *   - Path length. The dressing's opacity is one ply seen face-on. Seen at an angle the light crosses more film
 *     (transmittance^plies, the exponent growing toward 1 / cos), so faces turned away from the camera go milky and the load's outline reads.
 *   - Gloss without an environment map. Only metals get the sky map (metalEnvironment.ts, for compile time), so the
 *     film reflects a closed-form copy of that sky: a horizon gradient plus the overhead fixture patches, weighted by
 *     Schlick's Fresnel for a plastic (F0 0.04). The highlights move across a face as the camera moves.
 *   - Plies (sleeves only). A spiral wrap leaves a rolled cord at each band edge, a pitch apart and climbing one
 *     pitch per turn, more turns at the base (tying the load to its pallet) and the top, a rolled rim at both edges,
 *     and film pulled tight round each vertical corner. Each adds plies, measured in metres from the film's bottom
 *     edge, so the cords stay put on the load while the wrapper raises the sleeve's top. Fine wrinkles tilt the
 *     normal up and down, so the gloss shows as streaks along them.
 *
 * The sleeve geometry carries `filmAround` (per vertex: perimeter coefficients, position along the side, which axis
 * the side runs along) and the sleeve mesh `filmSize` (per instance: the film box's size in metres). See
 * cargoDressing.ts sleeveGeometry.
 *
 * WebGL: an onBeforeCompile patch. WebGPU: the TSL twin (filmNodeMaterial.ts, injected by createRenderer), which
 * computes the same terms.
 */

/** the band pitch: a 0.5 m film at 60% overlap climbs 0.2 m a turn (the shipped wrapper's defaults) */
export const FILM_PITCH = 0.2
/** half the width of a band's rolled edge (m) */
export const FILM_CORD = 0.006
/** the cords fade out when a pixel spans more than this share of a pitch, so a far load shows no moire */
export const FILM_CORD_FADE: readonly [number, number] = [0.08, 0.25]
/** height of the base and top wrap (m), and the extra plies they hold */
export const FILM_BASE: readonly [number, number] = [0.3, 0.35]
export const FILM_TOP: readonly [number, number] = [0.2, 0.25]
/** half width of the rolled rim at the film's top and bottom edges (m), and its extra plies */
export const FILM_RIM: readonly [number, number] = [0.012, 0.8]
/** extra plies on a band's edge cord */
export const FILM_CORD_PLIES = 0.6
/** how far from a vertical corner the film is pulled tight (m), and its extra plies there */
export const FILM_CORNER: readonly [number, number] = [0.04, 0.4]
/** the steepest view angle the path length counts (cos): past it a face edge-on to the camera stops thickening */
export const FILM_MIN_COS = 0.12
/** how much of the longer path at an angle thickens the film. The dressing's opacity already stands for the film's
 *  scatter as well as its plies, so the full 1 / cos turns a load seen at 45 degrees solid white */
export const FILM_PATH = 0.4
/** Stretch wrinkles: a tilt of the normal toward up and down (rad, roughly), from two waves of these lengths (m)
 *  running round the load. Without it a face seen from above reflects only the floor, and film shows its gloss as
 *  streaks along its wrinkles. Faded out between these pixel footprints (m), so it never aliases at a distance. */
export const FILM_WRINKLE = { amp: 0.12, waves: [0.07, 0.031] as const, fade: [0.004, 0.012] as const }
/** Schlick's F0 for a polyethylene film */
export const FILM_F0 = 0.04
/** the fixture patches' radiance as a multiple of the sky's. Higher than metalEnvironment's 2.5: there the PMREM
 *  spreads a patch over a rough metal, here it reflects off a near-mirror and only shows as a sharp streak */
export const FILM_FIXTURE_GAIN = 6
/** fixture patches: elevations (rad), their angular half width (rad), azimuth count and sharpness */
export const FILM_FIXTURE_ELEVATIONS: readonly [number, number] = [(42 * Math.PI) / 180, (68 * Math.PI) / 180]
export const FILM_FIXTURE_WIDTH = 0.05
export const FILM_FIXTURE_AZIMUTHS = 8
export const FILM_FIXTURE_SHARPNESS = 24

/** the sky the film reflects, in linear rgb: the hemisphere light as radiance (colour * intensity / PI, as
 *  metalEnvironment.intensityFor) */
export function filmSky(): { sky: Color; ground: Color } {
  const k = SCENE_SKY.intensity / Math.PI
  return { sky: new Color(SCENE_SKY.sky).multiplyScalar(k), ground: new Color(SCENE_SKY.ground).multiplyScalar(k) }
}

export interface FilmLook {
  /** sleeve (true): the ply bands, which need `filmAround` and `filmSize`. Web (false): path length and gloss only */
  bands: boolean
  roughness: number
  opacity: number
  emissive?: number
}

let filmNodeFactory: ((look: FilmLook) => MeshStandardMaterial) | null = null
export function setFilmNodeFactory(factory: ((look: FilmLook) => MeshStandardMaterial) | null): void {
  filmNodeFactory = factory
}

const f = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n))
const v3 = (c: Color): string => `vec3(${f(c.r)}, ${f(c.g)}, ${f(c.b)})`

/** the GLSL after `#include <normal_fragment_maps>` on a sleeve: the wrinkles. The waves vary round the load in whole
 *  cycles per band pitch, so they meet themselves where the spiral term wraps */
function wrinkleFragment(): string {
  const k = (len: number): string => f((2 * Math.PI) / len)
  return `#include <normal_fragment_maps>
{
  float wfw = fwidth(vFilm.x);
  float wrinkle = ${f(FILM_WRINKLE.amp)} * (1.0 - smoothstep(${f(FILM_WRINKLE.fade[0])}, ${f(FILM_WRINKLE.fade[1])}, wfw))
    * (0.6 * sin(vFilm.x * ${k(FILM_WRINKLE.waves[0])} + vFilm.y * ${k(FILM_PITCH)}) + 0.4 * sin(vFilm.x * ${k(FILM_WRINKLE.waves[1])} - vFilm.y * ${k(FILM_PITCH / 2)} + 1.7));
  normal = normalize(normal + wrinkle * (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
}`
}

/** the GLSL that replaces `#include <opaque_fragment>`: plies, path length, Fresnel and the reflected sky */
function filmFragment(bands: boolean): string {
  const { sky, ground } = filmSky()
  const ply = bands
    ? `
  float fh = vFilm.x;
  float fH = vFilm.z;
  float fw = fwidth(fh);
  float dEdge = ${f(FILM_PITCH)} * abs(fract((fh - vFilm.y) / ${f(FILM_PITCH)} + 0.5) - 0.5);
  float cord = (1.0 - smoothstep(${f(FILM_CORD)} - fw, ${f(FILM_CORD)} + fw, dEdge)) * (1.0 - smoothstep(${f(FILM_PITCH * FILM_CORD_FADE[0])}, ${f(FILM_PITCH * FILM_CORD_FADE[1])}, fw));
  float base = 1.0 - smoothstep(${f(FILM_BASE[0] - 0.03)}, ${f(FILM_BASE[0] + 0.03)}, fh);
  float top = smoothstep(fH - ${f(FILM_TOP[0] + 0.03)}, fH - ${f(FILM_TOP[0] - 0.03)}, fh);
  float rim = 1.0 - smoothstep(${f(FILM_RIM[0])} - fw, ${f(FILM_RIM[0])} + fw, min(fh, fH - fh));
  float corner = 1.0 - smoothstep(0.0, ${f(FILM_CORNER[0])}, min(vFilmSide.x, 1.0 - vFilmSide.x) * vFilmSide.y);
  plies += ${f(FILM_CORD_PLIES)} * cord + ${f(FILM_BASE[1])} * base + ${f(FILM_TOP[1])} * top + ${f(FILM_RIM[1])} * rim + ${f(FILM_CORNER[1])} * corner;`
    : ''
  return `
{
  vec3 fV = normalize(vViewPosition);
  float cosV = clamp(abs(dot(normal, fV)), ${f(FILM_MIN_COS)}, 1.0);
  float plies = 1.0;${ply}
  float alphaFilm = 1.0 - pow(max(1.0 - diffuseColor.a, 0.001), plies * (1.0 + ${f(FILM_PATH)} * (1.0 / cosV - 1.0)));
  float fresnel = ${f(FILM_F0)} + ${f(1 - FILM_F0)} * pow(1.0 - cosV, 5.0);
  vec3 R = inverseTransformDirection(reflect(-fV, normal), viewMatrix);
  vec3 skyL = mix(${v3(ground)}, ${v3(sky)}, smoothstep(-0.2, 0.5, R.y));
  float elev = asin(clamp(R.y, -1.0, 1.0));
  float e0 = (elev - ${f(FILM_FIXTURE_ELEVATIONS[0])}) / ${f(FILM_FIXTURE_WIDTH)};
  float e1 = (elev - ${f(FILM_FIXTURE_ELEVATIONS[1])}) / ${f(FILM_FIXTURE_WIDTH)};
  float fixture = (exp(-e0 * e0) + exp(-e1 * e1)) * pow(max(cos(${f(FILM_FIXTURE_AZIMUTHS)} * atan(R.x, R.z)), 0.0), ${f(FILM_FIXTURE_SHARPNESS)});
  vec3 refl = (skyL + ${v3(sky)} * ${f(FILM_FIXTURE_GAIN)} * fixture) * fresnel;
  float alphaOut = clamp(alphaFilm + (1.0 - alphaFilm) * min(dot(refl, vec3(0.2126, 0.7152, 0.0722)), 1.0), 0.02, 0.98);
  diffuseColor.a = alphaOut;
  outgoingLight += refl / alphaOut;
}
#include <opaque_fragment>`
}

/** the WebGL film material: a MeshStandardMaterial with the film terms patched in */
function webglFilmMaterial(look: FilmLook): MeshStandardMaterial {
  const mat = new MeshStandardMaterial()
  const bands = look.bands
  mat.onBeforeCompile = (shader) => {
    if (bands) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 filmAround;\nattribute vec3 filmSize;\nvarying vec3 vFilm;\nvarying vec2 vFilmSide;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
\tfloat filmP = 2.0 * (filmSize.x + filmSize.z);
\tvFilm = vec3((position.y + 0.5) * filmSize.y, ${f(FILM_PITCH)} * (filmAround.x * filmSize.x + filmAround.y * filmSize.z) / filmP, filmSize.y);
\tvFilmSide = vec2(filmAround.z, mix(filmSize.x, filmSize.z, filmAround.w));`,
        )
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFilm;\nvarying vec2 vFilmSide;')
        .replace('#include <normal_fragment_maps>', wrinkleFragment())
    }
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', filmFragment(bands))
  }
  mat.customProgramCacheKey = () => (bands ? 'filmSleeve' : 'filmWeb')
  return mat
}

/** a film material for one opacity batch, on whichever backend is active */
export function filmMaterial(look: FilmLook): MeshStandardMaterial {
  const nodeFactory = webgpuNodeFactory(filmNodeFactory, 'film')
  const mat = nodeFactory ? nodeFactory(look) : webglFilmMaterial(look)
  mat.metalness = 0
  mat.roughness = look.roughness
  mat.opacity = look.opacity
  if (look.emissive !== undefined) mat.emissive.set(look.emissive)
  mat.transparent = true
  mat.depthWrite = false
  mat.side = DoubleSide
  return mat
}
