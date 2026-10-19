// Import a STEP file as a GLB. Nothing here loads until it is called: the worker and its 7.6 MB wasm are their own
// chunk, kept out of the first frame and out of the offline precache (vite.config.ts globIgnores).
import type { StepToGlbStats } from '../core/stepToGlb'
import type { StepImportOptions } from './stepConvert'

export type { StepImportOptions } from './stepConvert'
export { DEFAULT_STEP_OPTIONS } from '../core/stepToGlb'

export const isStepFile = (name: string): boolean => /\.(step|stp)$/i.test(name)

export function importStep(bytes: Uint8Array, options: StepImportOptions): Promise<{ glb: Uint8Array; stats: StepToGlbStats }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./stepImport.worker.ts', import.meta.url), { type: 'module', name: 'step-import' })
    const done = (): void => worker.terminate()
    worker.onmessage = (e: MessageEvent<{ ok: true; glb: Uint8Array; stats: StepToGlbStats } | { ok: false; error: string }>) => {
      done()
      if (e.data.ok) resolve({ glb: e.data.glb, stats: e.data.stats })
      else reject(new Error(e.data.error))
    }
    worker.onerror = (e) => {
      done()
      reject(new Error(e.message || 'The STEP converter stopped unexpectedly.'))
    }
    worker.postMessage({ bytes, options }, [bytes.buffer])
  })
}

/** base64 of `bytes`, in slices: String.fromCharCode(...bytes) on a multi-MB model overflows the call stack */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
