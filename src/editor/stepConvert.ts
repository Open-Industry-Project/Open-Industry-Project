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
// detail. Coarse halves the triangles of normal. It does not shorten the import: measured on a 13.5 MB assembly,
// meshing is about 12% of the kernel's time and turning the file's entities into solids is 67%. The whole call takes
// 1 to 2 s per MB of STEP on a 2020s desktop, depending on the geometry.
const DETAIL: Record<StepDetail, Record<string, unknown>> = {
  normal: { linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.003, angularDeflection: 0.5 },
  coarse: { linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.01, angularDeflection: 1.0 },
}

export function convertStep(occt: OcctKernel, bytes: Uint8Array, options: StepImportOptions): { glb: Uint8Array; stats: StepToGlbStats } {
  // linearUnit: the kernel converts from whatever unit the file declares, so inch and mm files come out alike
  const res = occt.ReadStepFile(bytes, { linearUnit: 'meter', ...DETAIL[options.detail] })
  if (!res.success) throw new Error('This file could not be read as STEP.')
  if (res.meshes.length === 0) throw new Error('This STEP file has no solids to import.')
  // The kernel's memory stops at 2 GB. A 185 MB assembly reached it and came back as a success whose solids all
  // had no triangles, which would otherwise be written as an empty model.
  if (res.meshes.every((m) => m.index.array.length === 0))
    throw new Error('No geometry came out of this STEP file. A very large assembly is more than the converter can hold: export it in smaller pieces.')
  return stepToGlb(res.meshes, options)
}
