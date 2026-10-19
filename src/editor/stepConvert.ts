// STEP bytes -> GLB, given an initialised CAD kernel (occt-import-js). Split from the worker so a test can hand
// it the kernel in node: the worker owns loading the 7.6 MB wasm, this owns what is asked of it.
import { stepToGlb, type StepMesh, type StepToGlbOptions, type StepToGlbStats } from '../core/stepToGlb'

export type StepDetail = 'normal' | 'coarse'

export interface StepImportOptions extends StepToGlbOptions {
  detail: StepDetail
}

/** what occt-import-js's factory resolves to (only the call used here) */
export interface OcctKernel {
  ReadStepFile(bytes: Uint8Array, params: Record<string, unknown> | null): { success: boolean; meshes: StepMesh[] }
}

// Deflection is a fraction of each solid's own bounding box, so a screw and a frame rail get proportionate
// detail. Measured on two real machine assemblies: coarse halves the triangles of normal; reading the file, not
// meshing it, is nearly all the time (~2 s per MB of STEP either way).
const DETAIL: Record<StepDetail, Record<string, unknown>> = {
  normal: { linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.003, angularDeflection: 0.5 },
  coarse: { linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.01, angularDeflection: 1.0 },
}

export function convertStep(occt: OcctKernel, bytes: Uint8Array, options: StepImportOptions): { glb: Uint8Array; stats: StepToGlbStats } {
  // linearUnit: the kernel converts from whatever unit the file declares, so inch and mm files come out alike
  const res = occt.ReadStepFile(bytes, { linearUnit: 'meter', ...DETAIL[options.detail] })
  if (!res.success) throw new Error('This file could not be read as STEP.')
  if (res.meshes.length === 0) throw new Error('This STEP file has no solids to import.')
  return stepToGlb(res.meshes, options)
}
