import { FrontSide, MeshBasicMaterial, SRGBColorSpace } from 'three'
import type { Material, MeshStandardMaterial, Texture } from 'three'
import { notifyBundleStructureChanged } from '../bundleGroups'
import { gateBuildingLoad, loadTextureBitmap } from '../gltf'
import type { WallSide } from './wallAutoHide'

/**
 * The building walls' light is baked (scripts/bake-wall-lighting.mjs): every wall piece carries a second
 * UV set into one lightmap per world facing, holding the irradiance of a per-half wall light rig,
 * column and brace shadows included (building.ts litSide picks the facing). The walls draw in the main
 * pass with no scene lights at all.
 *
 * The material is a MeshBasicMaterial with that lightmap. Basic computes albedo * lightMap *
 * lightMapIntensity / PI on both backends (WebGL meshbasic.glsl, WebGPU BasicLightMapNode), which is
 * exactly the standard material's diffuse term, albedo * (1 - metalness) * E / PI, once the intensity
 * carries the (1 - metalness), the encode range and the scene brightness. There is no specular term; at
 * metalness 0.15 / roughness 0.85 a lit wall's specular is only a faint sheen on the framing.
 */

/** irradiance the lightmaps encode as 1.0; mirrors RANGE in scripts/bake-wall-lighting.mjs */
export const WALL_LIGHTMAP_RANGE = 4

const lightmaps = new Map<WallSide, Texture>()
const live = new Set<MeshBasicMaterial>()
let brightness = 1

/** The lightmap for walls facing `side` in the world, fetched once and held by the building-first gate. */
export function wallLightmap(side: WallSide): Texture {
  let tex = lightmaps.get(side)
  if (!tex) {
    let settle!: () => void
    const done = new Promise<void>((resolve) => {
      settle = resolve
    })
    tex = loadTextureBitmap(`/models/building/lightmaps/walls-${side}.webp`, () => settle())
    // encoded through the sRGB curve so 8 bits keep their precision in the shadows; sampling decodes it
    tex.colorSpace = SRGBColorSpace
    tex.channel = 1 // the bake's uv layout is TEXCOORD_1
    tex.anisotropy = 4
    lightmaps.set(side, tex)
    void gateBuildingLoad(done)
  }
  return tex
}

/** Kick all four lightmaps now, beside the wall GLBs, rather than when the first wall is placed. */
export function prefetchWallLightmaps(): void {
  for (const side of ['nz', 'pz', 'nx', 'px'] as const) wallLightmap(side)
}

const intensityOf = (metalness: number): number => WALL_LIGHTMAP_RANGE * (1 - metalness) * brightness

/**
 * A baked-light copy of `src` (a dressed wall material: its BaseColor map, metalness and side) for the
 * walls facing `side` in the world. The caller caches one per (material, facing) and disposes it.
 */
export function bakedWallMaterial(src: Material, side: WallSide): MeshBasicMaterial {
  const std = src as MeshStandardMaterial
  const metalness = std.isMeshStandardMaterial ? std.metalness : 0
  const mat = new MeshBasicMaterial({
    name: `${src.name}@${side}`,
    map: std.map ?? null,
    color: std.isMeshStandardMaterial ? std.color : 0xffffff,
    lightMap: wallLightmap(side),
    lightMapIntensity: intensityOf(metalness),
    side: src.side ?? FrontSide,
  })
  mat.userData.wallLightmapMetalness = metalness
  live.add(mat)
  mat.addEventListener('dispose', () => live.delete(mat))
  return mat
}

/**
 * Scene brightness for the baked walls (the Lighting param env.setLighting applies to the live lights).
 * lightMapIntensity is a uniform on both backends, so this recompiles nothing; the walls draw inside the
 * bundled main pass, so the replay is re-recorded once to pick the new value up.
 */
export function setWallLightmapBrightness(b: number): void {
  if (b === brightness) return
  brightness = b
  for (const mat of live) mat.lightMapIntensity = intensityOf(mat.userData.wallLightmapMetalness as number)
  if (live.size > 0) notifyBundleStructureChanged()
}
