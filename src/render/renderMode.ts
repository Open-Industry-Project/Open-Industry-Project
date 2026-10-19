/// <reference types="vite/client" />
// Tiny global flag for the active render backend, set by RenderView once it knows
// which renderer it got. Part visuals are built without a renderer reference, so this
// lets the few WebGPU-incompatible visuals (raw GLSL ShaderMaterials) degrade
// gracefully instead of rendering as opaque black under the experimental WebGPU path.
let webgpu = false

export function setWebGPURenderMode(on: boolean): void {
  webgpu = on
}

export function isWebGPURenderMode(): boolean {
  return webgpu
}

const missingWarned = new Set<string>()

/**
 * Guard for the WebGPU node-material factories (gizmo ring, floor markings, metal, selection
 * outline). Each is a module-level singleton registered once in createWebGPURenderer, before
 * RenderView builds anything. Returns the factory only when it's actually usable - i.e. we're
 * on the WebGPU path and it was registered; otherwise null, so the caller takes its WebGL path.
 *
 * The dangerous case is "WebGPU active but factory missing": the caller would silently fall
 * back to its raw-GLSL/onBeforeCompile path, which WebGPU can't compile → black/wrong visuals.
 * The dev full-reload plugin (vite.config.ts) rules out HMR as a cause, so if this ever fires
 * it's a wiring/ordering bug. Report it loudly (once per factory) in dev rather than shipping a
 * silent artifact.
 */
export function webgpuNodeFactory<T>(factory: T | null, name: string): T | null {
  if (!webgpu) return null
  if (factory) return factory
  if (import.meta.env.DEV && !missingWarned.has(name)) {
    missingWarned.add(name)
    console.error(
      `[oip] WebGPU is active but the "${name}" node-material factory is unregistered. ` +
        `Falling back to its WebGL GLSL path, which WebGPU cannot compile (expect black/wrong ` +
        `visuals). This is a setup-ordering bug - the factory must be registered in ` +
        `createWebGPURenderer before RenderView builds materials.`,
    )
  }
  return null
}
