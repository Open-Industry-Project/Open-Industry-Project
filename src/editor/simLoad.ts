import { useEffect, useState } from 'react'
import { MAX_SIM_HZ } from '../core/types'
import type { IRenderView } from '../render/api'
import type { StepStats } from '../sim/protocol'
import type { EditorController } from './controller'

/**
 * What the sim worker costs, in the terms a user can act on: how much of one core it is busy, and how high this
 * scene's physics rate could go on this machine. The stats overlay and the Scene inspector's rate field both read it.
 *
 * The worker's own number is ms per step, and that is the wrong thing to show on its own: raising the rate multiplies
 * the steps, not the cost of each, so it barely moves while the CPU cost doubles (some of it even shrinks per step,
 * because the frame build runs once per worker tick and the PLC scans on its own period, both shared across more
 * steps). Load = busy ms per real ms is the number that moves with the rate, and 100% is the point the sim can no
 * longer keep up, whatever the rate is.
 */

/** a StepStats read and the main-thread time it was read at */
export interface StepSample {
  stats: StepStats
  at: number
}

/** where the worker's time went in a window, as fractions of it (sum ~1); named as the overlay's rows read */
export interface StepSplit {
  /** what the parts cost: every part's step() (behaviors, sensing, scripts) and moving their rig bodies (drives:
   *  robot links, mostly, plus the pilot and held parts). Counted together so a robot-heavy scene reads as parts,
   *  not as an unexplained upkeep */
  parts: number
  /** the interleaved ST scans */
  plc: number
  /** Jolt's step: contacts, constraints, integration */
  physics: number
  /** per-box bookkeeping: the cull (its pose snapshot, shared with the sensors) and the frame build sent to the
   *  main thread, both O(cargo), plus the conveyor-surface sync (~nothing) */
  upkeep: number
}

export interface StepWindow {
  /** average worker ms per step over the window (step + frame build + PLC); null when no step ran (paused) */
  msPerStep: number | null
  /** busy ms per real ms over the window: 1 = one core flat out */
  load: number
  split: StepSplit | null
}

const worked = (s: StepStats): number => s.totalMs + s.frameTotalMs + s.plcTotalMs

/** the window between two samples; null if the counters went backwards (a new run reset them) or no time passed */
export function stepWindow(a: StepSample, b: StepSample): StepWindow | null {
  const elapsed = b.at - a.at
  const dSteps = b.stats.steps - a.stats.steps
  const dWorked = worked(b.stats) - worked(a.stats)
  if (elapsed <= 0 || dSteps < 0 || dWorked < 0) return null
  if (dSteps === 0) return { msPerStep: null, load: 0, split: null }
  let split: StepSplit | null = null
  if (dWorked > 0) {
    const d = (k: keyof StepStats['phases']): number => Math.max(0, b.stats.phases[k] - a.stats.phases[k])
    const parts = d('behaviors') + d('drives')
    const physics = d('solver')
    const plc = Math.max(0, b.stats.plcTotalMs - a.stats.plcTotalMs)
    const upkeep = Math.max(0, dWorked - parts - physics - plc)
    split = { parts: parts / dWorked, plc: plc / dWorked, physics: physics / dWorked, upkeep: upkeep / dWorked }
  }
  // capped: the counters arrive with the worker's frames, so a window can catch a burst of banked steps
  // whose time partly belongs to the window before
  return { msPerStep: dWorked / dSteps, load: Math.min(1, dWorked / elapsed), split }
}

/** the share of one core a run at `hz` costs at 1x speed, from its per-step cost */
export function loadAtRate(msPerStep: number, hz: number): number {
  return (msPerStep * hz) / 1000
}

/** leave this much of the core free: past it a busy moment (a cargo pile-up, a GC) puts the sim behind */
const HEADROOM = 0.8

/**
 * The highest physics rate this machine should sustain for the scene as it is now, rounded down to 10 Hz and capped
 * at MAX_SIM_HZ. An estimate: it assumes the per-step cost stays put, which errs low (the frame build and the PLC
 * scan get cheaper per step as the rate rises) and goes stale as cargo or parts are added.
 */
export function sustainableHz(msPerStep: number): number {
  if (msPerStep <= 0) return MAX_SIM_HZ
  return Math.min(MAX_SIM_HZ, Math.floor((HEADROOM * 1000) / msPerStep / 10) * 10)
}

/** a load at or over this is what limits the run (HEADROOM, the same line the rate estimate keeps clear of) */
export const LIMIT_LOAD = HEADROOM

/** one row of the sim split: what the time went to and its ms per step */
export interface SplitRow {
  label: string
  ms: number
}

/**
 * The split as rows under `sim`, each in ms per step, so they add up to the ms on the sim line (the time split by
 * share). ms and not a share of a share: a percentage under a percentage reads as the CPU's, and it moves whenever
 * another cost does, where "parts went from 0.6 to 1.2 ms" survives a rate or speed change. Each row points at a
 * different fix: parts = the parts (their logic and their rigs), plc = the program, physics = cargo and colliders.
 * The parent line is `sim`, not `physics`, because it is the whole worker and Jolt is only one row of it. `upkeep`
 * is the per-box bookkeeping and is not fixed overhead: the cull reads every box's pose each step and the frame build
 * packs every box's pose for the main thread (both O(cargo), world.ts `step` / `frame`), so it tracks the cargo
 * count. (The cull's pose snapshot is cached for the step and shared with every sensor, so upkeep also carries what
 * the beams would otherwise spend; measured 0.14-0.18 ms at 885 boxes, the cull's own check 0.004.) Fixed order, never
 * sorted, so rows don't jump as they wobble. `plc` only appears when a scan ran at all, so a scene
 * with no program has no `plc 0.00`. null when there is no split or step time yet.
 */
export function splitRows(split: StepSplit | null, msPerStep: number | null): SplitRow[] | null {
  if (!split || msPerStep === null) return null
  const rows: SplitRow[] = [{ label: 'parts', ms: split.parts * msPerStep }]
  if (split.plc > 0) rows.push({ label: 'plc', ms: split.plc * msPerStep })
  rows.push({ label: 'physics', ms: split.physics * msPerStep }, { label: 'upkeep', ms: split.upkeep * msPerStep })
  return rows
}

/** a row's ms, never rounded down to a reassuring 0.00 when it cost something */
export const rowMs = (ms: number): string => (ms > 0 && ms < 0.005 ? '<0.01' : ms.toFixed(2))

/** the view's cumulative frame counters (RenderStats.cpuTotalMs / frames) and the time they were read at */
export interface RenderSample {
  cpuTotalMs: number
  frames: number
  at: number
}

export interface RenderWindow {
  /** frames per real second: the true rate, hitches included */
  fps: number
  /** average main-thread ms per frame; null when no frame ran */
  msPerFrame: number | null
  /** main-thread busy ms per real ms: 1 = the main thread did nothing but produce frames */
  load: number
}

/**
 * The render side over a window, weighted by time the way the sim side is. The view's per-frame EMAs can't be
 * used for this: the interval it advances by is clamped to 100 ms and the work is not, so under hitches the averaged
 * interval overstates the frame rate and work / interval reads several times 100% (RenderStats.cpuTotalMs). Sampled
 * on the main thread, so a sample can never fall inside a frame: a 1.5 s frame is wholly inside the window that
 * waited for it, and the load needs no cap.
 *
 * The GPU's time stays out: it comes from an async timestamp resolve that can cover several frames (measured: 645 ms
 * "per frame" against a 29 ms interval), so it is a details line, not something to divide by.
 */
export function renderWindow(a: RenderSample, b: RenderSample): RenderWindow | null {
  const elapsed = b.at - a.at
  const dFrames = b.frames - a.frames
  const dCpu = b.cpuTotalMs - a.cpuTotalMs
  if (elapsed <= 0 || dFrames < 0 || dCpu < 0) return null
  return { fps: (dFrames * 1000) / elapsed, msPerFrame: dFrames > 0 ? dCpu / dFrames : null, load: dCpu / elapsed }
}

export interface RenderMeter {
  fps: number | null
  msPerFrame: number | null
  load: number | null
}

/** poll the view's frame counters; empty until the first window completes */
export function useRenderMeter(view: IRenderView | null, intervalMs = 500): RenderMeter {
  const [meter, setMeter] = useState<RenderMeter>({ fps: null, msPerFrame: null, load: null })
  useEffect(() => {
    if (!view) return
    const samples: RenderSample[] = []
    const id = setInterval(() => {
      const s = view.getStats()
      const w = slide(samples, { cpuTotalMs: s.cpuTotalMs, frames: s.frames, at: performance.now() }, renderWindow)
      if (!w) return
      setMeter((m) => ({ fps: w.fps, msPerFrame: w.msPerFrame ?? m.msPerFrame, load: w.load }))
    }, intervalMs)
    return () => clearInterval(id)
  }, [view, intervalMs])
  return meter
}

/** how many polls one reading spans: the step loop is bursty (backlog banked in one tick, repaid in the next), so
 *  one 500 ms window swings; a second's worth is steady enough to read and still follows a real change promptly */
const WINDOW_POLLS = 2

/**
 * Add a sample and measure the window from the oldest kept one to it. Every number in a reading comes from that one
 * window. Averaging the rate and the load across windows while the per-frame cost comes from the latest alone gives
 * three numbers that do not multiply out (25 fps at 124.5 ms a frame reading 55%). A counter reset (a new run, a
 * remounted view) restarts the window.
 */
function slide<S, W>(samples: S[], cur: S, measure: (a: S, b: S) => W | null): W | null {
  samples.push(cur)
  if (samples.length > WINDOW_POLLS + 1) samples.shift()
  const w = measure(samples[0]!, cur)
  if (w === null) samples.splice(0, samples.length - 1)
  return samples.length > 1 ? w : null
}

export interface StepMeter {
  /** last measured ms per step; kept through a pause, since the cost of a step has not changed */
  msPerStep: number | null
  /** smoothed load over the recent windows; 0 while paused */
  load: number | null
  split: StepSplit | null
}

const EMPTY: StepMeter = { msPerStep: null, load: null, split: null }

/** poll the controller's step counters while a run is going; empty when stopped */
export function useStepMeter(controller: EditorController | null, running: boolean, intervalMs = 500): StepMeter {
  const [meter, setMeter] = useState<StepMeter>(EMPTY)
  useEffect(() => {
    setMeter(EMPTY)
    if (!running || !controller) return
    const samples: StepSample[] = []
    const id = setInterval(() => {
      const stats = controller.stepStats
      if (!stats) return
      const w = slide(samples, { stats, at: performance.now() }, stepWindow)
      if (!w) return
      setMeter((m) => ({ msPerStep: w.msPerStep ?? m.msPerStep, load: w.load, split: w.split ?? m.split }))
    }, intervalMs)
    return () => clearInterval(id)
  }, [controller, running, intervalMs])
  return meter
}
