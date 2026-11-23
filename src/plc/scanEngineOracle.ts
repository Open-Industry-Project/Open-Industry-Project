// The differential oracle for the two scan engines (interpreter.ts): the AST walker, which is the reference, and the
// typed engine every program runs on (typed/, scanCodegen.ts; docs/plc-typed-storage.md). The same program is built
// on each, driven through the same inputs, and everything each holds - array elements, struct members and the inside
// of every function block instance (`deepMemory`) - is compared after every scan, every value also held to its
// declared type's form (`inForm`). A fault must be the same fault. A program the typed engine refuses is reported
// (`refused`), with nothing compared: a caller must not read that as agreement. Optional writes between scans go
// through the tag surface the scene, an HMI and the tag editor use (setInput, which reaches struct fields, array
// elements and bits), which is what catches generated code that kept hold of something a write replaced.
//
// Test support, not app code: nothing outside the specs imports it.

import { compile, setScanEngine, type ScanEngine } from './interpreter'
import { TaskScheduler } from './scanEngine'
import { TypedUnsupported } from './typed/layout'
import { isInt, wrap } from './runtime'
import type { CompiledProgram, ScalarType, TagValue } from './types'

export interface OracleStep {
  /** inputs written before the scan */
  in?: Record<string, TagValue>
  /** seconds the scan (or the scheduler, for a program with tasks) advances */
  dt: number
}

export interface OracleOptions {
  /** values to write after scan `i`, before the next - given the variables the program holds */
  between?: (i: number, keys: readonly string[], memory: Readonly<Record<string, TagValue>>) => Record<string, TagValue>
  /** stop after this many differences */
  maxDiffs?: number
}

export interface OracleResult {
  /** each difference, worded for a failure message; empty when the engines agreed throughout */
  diffs: string[]
  scans: number
  /** the variables compared after each scan */
  compared: number
  /** the fault both engines stopped on, if the run ended in one */
  fault: string | null
  /** set when the typed engine refused the program (TypedUnsupported): nothing was compared */
  refused?: string
}

function build(engine: ScanEngine, src: string): CompiledProgram | Error {
  const was = setScanEngine(engine)
  try {
    return compile(src)
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  } finally {
    setScanEngine(was)
  }
}

/** Run `src` on both engines through `steps`, comparing every variable after every scan. */
export function compareEngines(src: string, steps: readonly OracleStep[], opts: OracleOptions = {}): OracleResult {
  const max = opts.maxDiffs ?? 8
  const walker = build('walker', src)
  const generated = build('typed', src)
  if (generated instanceof TypedUnsupported) return { diffs: [], scans: 0, compared: 0, fault: null, refused: generated.message }
  if (walker instanceof Error || generated instanceof Error) {
    const a = walker instanceof Error ? walker.message : 'compiled'
    const b = generated instanceof Error ? generated.message : 'compiled'
    return { diffs: a === b ? [] : [`compile: walker ${a} / typed ${b}`], scans: 0, compared: 0, fault: a === b && walker instanceof Error ? a : null }
  }
  const scheduled = walker.tasks.length > 0
  const run = (p: CompiledProgram): ((dt: number) => void) => {
    if (!scheduled) return (dt) => p.scan(dt)
    const sched = new TaskScheduler({ tasks: p.tasks, tick: (dt) => p.scan(dt), tickTask: (i, dt) => p.scanTask(i, dt) }, { maxCatchUp: 64 })
    return (dt) => void sched.advance(dt)
  }
  // the declared type of every memory key (the same for both engines: one program, one shape)
  const types = walker.memoryTypes
  const runW = run(walker)
  const runC = run(generated)
  const diffs: string[] = []
  let compared = 0
  let scans = 0
  for (let i = 0; i < steps.length && diffs.length < max; i++) {
    const step = steps[i]!
    for (const [k, v] of Object.entries(step.in ?? {})) {
      walker.setInput(k, v)
      generated.setInput(k, v)
    }
    let fw: string | null = null
    let fc: string | null = null
    try {
      runW(step.dt)
    } catch (e) {
      fw = e instanceof Error ? e.message : String(e)
    }
    try {
      runC(step.dt)
    } catch (e) {
      fc = e instanceof Error ? e.message : String(e)
    }
    scans++
    if (fw !== null || fc !== null) {
      if (fw !== fc) diffs.push(`scan ${i}: walker ${fw === null ? 'ran' : `faulted (${fw})`}, typed ${fc === null ? 'ran' : `faulted (${fc})`}`)
      return { diffs, scans, compared, fault: fw === fc ? fw : null }
    }
    // everything each holds, inside function block instances too (deepMemory): state no surface lists is where a
    // wrong address in the typed engine's arena would land unseen
    const mw = walker.deepMemory
    const mc = generated.deepMemory
    const keys = Object.keys(walker.memory)
    for (const k of new Set([...Object.keys(mw), ...Object.keys(mc)])) {
      compared++
      if (!Object.is(mw[k], mc[k])) {
        diffs.push(`scan ${i}: '${k}' walker ${String(mw[k])}, typed ${String(mc[k])}`)
        if (diffs.length >= max) break
      }
      // storage holds every value in its declared type's form, always - in either engine, array elements and struct
      // members included. Generated code trusts it (it reads a BOOL without bool(), stores a DINT read into a DINT
      // without a coercion), so a writer that stores a 1 in a BOOL, 70000 in an INT or an f64 in a REAL must fail here
      for (const [engine, m] of [['walker', mw], ['typed', mc]] as const) {
        const t = types[k]
        if (t !== undefined && m[k] !== undefined && !inForm(t, m[k]!)) {
          diffs.push(`scan ${i}: '${k}' is declared ${t} but the ${engine} holds ${typeof m[k]} ${String(m[k])}`)
          if (diffs.length >= max) break
        }
      }
      if (diffs.length >= max) break
    }
    if (opts.between) {
      for (const [k, v] of Object.entries(opts.between(i, keys, walker.memory))) {
        walker.setInput(k, v)
        generated.setInput(k, v)
      }
    }
  }
  return { diffs, scans, compared, fault: null }
}

/** Is `v` exactly what a store into a place of declared type `type` leaves there? A BOOL is a boolean and a STRING
 *  text; an integer (an enumeration is an INT) is a whole number its width keeps as it is; a REAL is a number single
 *  precision holds exactly (NaN included); the rest are numbers. */
export function inForm(type: string, v: TagValue): boolean {
  if (type === 'BOOL') return typeof v === 'boolean'
  if (type === 'STRING') return typeof v === 'string'
  if (typeof v !== 'number') return false
  const t = (type === 'ENUM' ? 'INT' : type) as ScalarType
  if (isInt(t)) return Object.is(wrap(t, v), v)
  if (t === 'REAL') return Object.is(Math.fround(v), v)
  return true
}

/** A small deterministic generator (an LCG), so a failing run is the same run next time. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** Writes for `between`: `count` variables picked at random, each given a value of its own kind. */
export function randomWrites(rand: () => number, count: number): NonNullable<OracleOptions['between']> {
  return (_i, keys, memory) => {
    const out: Record<string, TagValue> = {}
    if (keys.length === 0) return out
    for (let n = 0; n < count; n++) {
      const k = keys[Math.floor(rand() * keys.length)]!
      const v = memory[k]
      if (typeof v === 'boolean') out[k] = rand() < 0.5
      else if (typeof v === 'number') out[k] = Number.isInteger(v) ? Math.floor(rand() * 200) - 50 : Math.round((rand() * 200 - 50) * 1000) / 1000
      else if (typeof v === 'string') out[k] = rand() < 0.5 ? '' : 'abc'
    }
    return out
  }
}
