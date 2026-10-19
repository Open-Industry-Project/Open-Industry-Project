import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'

/**
 * Shared Draco decoder for every GLTFLoader in the app.
 *
 * The prod optimizer Draco-compresses the node-driven rigs (the `TEXTURE_ONLY` set in
 * scripts/optimize-assets.mjs). They are reshaped through their authored local node transforms, so
 * they can't use meshopt: its quantization bakes a compensating scale+translation onto every
 * node, which the runtime's `obj.scale`/link-reset writes then overwrite. Draco dequantizes back into
 * the authored space, so node transforms come out byte-identical (the optimizer's verify enforces it).
 *
 * One instance, shared by render/gltf.ts and parts/sdk/materials.ts, so they share one decoder
 * worker pool.
 *
 * No `setDecoderPath`: three resolves its bundled decoder via `new URL(..., import.meta.url)`, so
 * vite emits it as a hashed same-origin `/assets/*` file (a CDN copy would be blocked by COEP),
 * covered by the `/assets/*` headers and versioned with three. See docs/three-coupling.md.
 *
 * Not `.preload()`ed: only prod GLBs are Draco-compressed, so the ~190 KB decoder is fetched on the
 * first compressed parse, not on boot.
 */
export const dracoLoader = new DRACOLoader()
