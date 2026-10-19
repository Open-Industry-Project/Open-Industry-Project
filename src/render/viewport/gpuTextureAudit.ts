import type { Material, Scene, Texture } from 'three'

/**
 * WebGPU GPU-texture invariant audit (dev/E2E) - catches the "live edit doesn't take until reload" class.
 *
 * three's WebGPU backend allocates a sampled texture's GPUTexture once, at the size of the first uploaded
 * image (Textures.updateTexture gates backend.createTexture on isDefaultTexture), and a later needsUpdate
 * only re-writes into that fixed-size allocation. So any code path that swaps `texture.image` in place to a
 * different-sized image silently keeps sampling the stale old-size GPUTexture until something rebuilds the
 * texture, typically a browser refresh. WebGL never shows this (texImage2D re-specifies every upload),
 * so these bugs pass on the WebGL path and in any manual check after a reload.
 * Example: the belt weave swap (BeltSurface.setVariant, plain 1024² ↔ arrows 512²). It binds a separate
 * texture per weave variant (beltWeaveTexture) instead of swapping one texture's image.
 *
 * This audit checks for the whole class: walk every texture reachable from a scene material,
 * including ones inside TSL node graphs where standard material slots don't apply, and compare the
 * CPU-side image's size against the GPUTexture the backend actually holds. Any mismatch is a live stale-
 * texture bug. Run it from the console as `window.__oip.view.auditGpuTextures()` when something renders
 * stale, and from E2E (verify-webgpu-belt-weave-live.mjs) so a future different-size swap fails CI.
 * Returns null on WebGL, where the class cannot occur.
 */

/** one comparable texture: the CPU-side image size vs the GPUTexture the backend allocated for it */
export interface GpuTextureAuditEntry {
  material: string
  /** image URL basename when available, else the texture's name/uuid */
  texture: string
  imageSize: [number, number]
  gpuSize: [number, number]
  ok: boolean
}

export interface GpuTextureAuditResult {
  /** how many textures were comparable (had a decoded image and a live GPUTexture) - assert > 0 in E2E */
  checked: number
  textures: GpuTextureAuditEntry[]
  /** entries whose GPUTexture no longer matches the bound image - each one is a live stale-texture bug */
  mismatches: GpuTextureAuditEntry[]
}

// keys that lead out of a material/node graph (into the scene tree, renderer, or geometry buffers) - the
// deep scan below must stay inside the material's own object web or it would walk the entire application
const SKIP_KEYS = new Set(['parent', 'children', 'scene', 'camera', 'object', 'object3d', 'geometry', 'material', 'renderer', '_listeners'])

// CPU-side size of a texture's bound image, or null when it isn't comparable: no image, an image element
// still loading (three keeps the previous upload bound - not a mismatch), or a multi-image (cube) source.
function imageSize(img: unknown): [number, number] | null {
  if (!img || typeof img !== 'object' || Array.isArray(img)) return null
  const o = img as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number; complete?: boolean }
  if (o.complete === false) return null
  const w = o.naturalWidth ?? o.width
  const h = o.naturalHeight ?? o.height
  return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? [w, h] : null
}

function textureLabel(t: Texture): string {
  const img = t.image as { currentSrc?: string; src?: string } | undefined
  const src = img?.currentSrc || img?.src
  if (typeof src === 'string' && src.length > 0) return src.split('/').pop() ?? src
  return t.name || t.uuid.slice(0, 8)
}

export function auditGpuTextures(scene: Scene, renderer: unknown): GpuTextureAuditResult | null {
  const r = renderer as {
    isWebGPURenderer?: boolean
    backend?: { get(o: object): { texture?: { width?: number; height?: number } } }
  }
  if (r?.isWebGPURenderer !== true || typeof r.backend?.get !== 'function') return null
  const backend = r.backend

  // every texture reachable from a scene material. A generic depth-capped object walk rather than a list of
  // material slots, because the WebGPU materials here are TSL node materials - their textures live inside
  // the node graph (e.g. beltNodeMaterial's colorNode), not on .map.
  const seen = new Set<object>()
  const owner = new Map<Texture, string>()
  const scan = (o: object, matName: string, depth: number): void => {
    if (seen.has(o) || depth > 12 || ArrayBuffer.isView(o)) return
    seen.add(o)
    const t = o as Texture
    if (t.isTexture) {
      if (!owner.has(t)) owner.set(t, matName)
      return
    }
    for (const k in o) {
      if (SKIP_KEYS.has(k)) continue
      const v = (o as Record<string, unknown>)[k]
      if (v !== null && typeof v === 'object') scan(v, matName, depth + 1)
    }
  }
  scene.traverse((obj) => {
    const m = (obj as { material?: Material | Material[] }).material
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) scan(mat, mat.name || mat.type, 0)
  })

  const textures: GpuTextureAuditEntry[] = []
  for (const [t, matName] of owner) {
    // only plain sampled image textures are comparable; GPU-owned kinds size themselves
    const flags = t as unknown as { isRenderTargetTexture?: boolean; isDepthTexture?: boolean; isFramebufferTexture?: boolean; isStorageTexture?: boolean; isVideoTexture?: boolean; isExternalTexture?: boolean; isCubeTexture?: boolean }
    if (flags.isRenderTargetTexture || flags.isDepthTexture || flags.isFramebufferTexture || flags.isStorageTexture || flags.isVideoTexture || flags.isExternalTexture || flags.isCubeTexture) continue
    const img = imageSize(t.image)
    if (!img) continue
    const g = backend.get(t)?.texture
    if (!g || typeof g.width !== 'number' || typeof g.height !== 'number') continue // never uploaded yet
    // 1×1 = the backend's transient async-decode placeholder (createDefaultTexture); it self-resolves on
    // the first real upload, so it isn't the stale-size bug this audit exists to catch
    if (g.width === 1 && g.height === 1 && (img[0] !== 1 || img[1] !== 1)) continue
    const ok = g.width === img[0] && g.height === img[1]
    textures.push({ material: matName, texture: textureLabel(t), imageSize: img, gpuSize: [g.width, g.height], ok })
  }
  return { checked: textures.length, textures, mismatches: textures.filter((e) => !e.ok) }
}
