// Flat, FFI-friendly façade over the Structured Text engine for embedding it in a host JS runtime -
// e.g. QuickJS (or a JS-in-WASM module) loaded by a native host, so native runs the same
// engine in-process instead of reaching a soft-PLC over WebSocket (ws_plc). The host evaluates this
// bundle once, then drives it through strings + numbers only - no objects cross the boundary, and no
// host APIs (window/fetch/process/Date.now/Math.random) are used, so the one engine runs in the
// browser, Node, AND embedded native. The shape mirrors PlcLink.step(inputs, dt) -> outputs.
//
// Boundary (everything a host needs):
//   create(source)               -> handle (>0), or 0 on compile error (see error())
//   meta(handle)                 -> JSON {"inputs":[...],"outputs":[...]}
//   step(handle, inputsJson, dt) -> JSON {tag: value, ...} of the program outputs
//   watch(handle)                -> JSON {var: value, ...} of every variable (for online monitoring)
//   destroy(handle)              -> void
//   error()                      -> last error message (and clears it)

import { SoftPlc } from './softPlc'
import type { TagValue } from './types'

const instances = new Map<number, SoftPlc>()
let nextHandle = 1
let lastError = ''

function fail(message: string): void {
  lastError = message
}

export function create(source: string): number {
  try {
    const handle = nextHandle++
    instances.set(handle, new SoftPlc(source))
    return handle
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
    return 0
  }
}

export function meta(handle: number): string {
  const plc = instances.get(handle)
  if (!plc) {
    fail(`oip-plc: bad handle ${handle}`)
    return '{}'
  }
  const m = plc.meta()
  return JSON.stringify({ inputs: m.inputs, outputs: m.outputs })
}

export function step(handle: number, inputsJson: string, dt: number): string {
  const plc = instances.get(handle)
  if (!plc) {
    fail(`oip-plc: bad handle ${handle}`)
    return '{}'
  }
  try {
    const inputs = JSON.parse(inputsJson) as Record<string, TagValue>
    return JSON.stringify(plc.step(inputs, dt).v)
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
    return '{}'
  }
}

/** JSON snapshot of every program variable (inputs, outputs, internals) for online monitoring. */
export function watch(handle: number): string {
  const plc = instances.get(handle)
  if (!plc) {
    fail(`oip-plc: bad handle ${handle}`)
    return '{}'
  }
  return JSON.stringify(plc.watch())
}

export function destroy(handle: number): void {
  instances.delete(handle)
}

/** Last error message; clears it so a host can poll after a 0/`{}` return. */
export function error(): string {
  const e = lastError
  lastError = ''
  return e
}

export const OipPlc = { create, meta, step, watch, destroy, error }

// Expose on globalThis so an embedded host (QuickJS) can reach the API after evaluating the bundle.
;(globalThis as unknown as { OipPlc?: typeof OipPlc }).OipPlc = OipPlc
