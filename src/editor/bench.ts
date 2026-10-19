import type { RenderStats } from '../render/api'

/**
 * Device benchmark mode (`?bench`) - a fixed workload plus one copy-pasteable result blob.
 *
 * A desktop GPU in a phone-shaped viewport is not a phone, and the MOBILE preset in render/quality.ts
 * has no real handheld frame trace behind it. Run an arm on a phone, paste the JSON, compare.
 *
 * 1. Fixed workload: a deterministic orbit around the opening view; hand-orbited arms aren't comparable.
 * 2. Windowed results: a phone holds 60 fps for a couple of minutes then throttles, and one median over
 *    five minutes averages that decay away.
 * 3. Checkpointed: every closed window goes to localStorage, because an iOS tab kill at a raised pixel
 *    ratio is a result. `events.complete: false` is the finding.
 * 4. Resolved config, not the URL: an ignored `?dpr=2` reads as `dprCap: 1.5`, not an invisible duplicate
 *    arm. Both paths honour the tier's singlePass; `singlePassHonoured` is `false` in older pastes from a
 *    WebGPU path that ignored it.
 *
 * Field names match e2e/perf-webgpu-vs-webgl.mjs (`medianMs` / `p95Ms` / `worstMs` / `transientWorstMs`)
 * so phone results sit beside the desktop baselines. A URL-gated dev instrument, not a product surface.
 */

export interface BenchPose {
  px: number
  py: number
  pz: number
  tx: number
  ty: number
  tz: number
}

/** where a finished-or-truncated run is parked so a killed tab can still be pasted */
export const BENCH_STORAGE_KEY = 'oip-web/bench-last'

/** default schedule: five minutes, with the windows that make thermal decay legible */
export const BENCH_DEFAULT_TOTAL_SEC = 300
const BENCH_DEFAULT_BOUNDARIES = [30, 60, 180] as const

/** the post-load settling window, matching perf-webgpu-vs-webgl.mjs's transient sample */
const TRANSIENT_MS = 1600
/** one full revolution per minute - slow enough to read as a plausible inspection orbit */
const ORBIT_PERIOD_SEC = 60
/**
 * A frame interval longer than this is a resumed tab, not jank (see frame()).
 *
 * The run times its own frames: RenderView's `onFrame` dt is clamped at 100 ms (right for animation,
 * useless for measuring), so stalls read out as `worstMs: 100.0` and this guard could never fire.
 */
const RESUME_DT_MS = 1000

export interface BenchParams {
  enabled: boolean
  /** wall-clock length of the whole run */
  totalSec: number
  /** window close times, seconds since start, ascending, last === totalSec */
  boundariesSec: readonly number[]
}

const OFF = new Set(['0', 'false', 'off'])

/**
 * `?bench` runs the default five-minute schedule. `?bench=<sec>` shortens it (default boundaries
 * past that point never open). `?benchwin=2,5,8` names the boundaries outright and is the
 * schedule - total becomes its last entry - which is how the e2e gate runs a real multi-window
 * run in seconds instead of minutes.
 */
export function readBenchParams(search: string): BenchParams {
  const params = new URLSearchParams(search)
  const raw = params.get('bench')
  const enabled = raw !== null && !OFF.has(raw)

  const win = params.get('benchwin')
  if (win) {
    const bounds = [...new Set(win.split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b)
    if (bounds.length > 0) return { enabled, totalSec: bounds[bounds.length - 1]!, boundariesSec: bounds }
  }

  const asked = Number(raw)
  const totalSec = Number.isFinite(asked) && asked > 0 ? asked : BENCH_DEFAULT_TOTAL_SEC
  return { enabled, totalSec, boundariesSec: [...BENCH_DEFAULT_BOUNDARIES.filter((b) => b < totalSec), totalSec] }
}

/**
 * Whether the screen was actually kept awake for the run.
 *
 * Reported, not merely attempted: a phone that slept mid-run produces a plausible-looking blob silently
 * missing those minutes.
 *
 * - held: acquired at the start and still held at the end
 * - interrupted: acquired, but released at least once mid-run (the API drops the lock whenever the
 *   page is hidden, and the OS can revoke it), so the screen may have slept
 * - unavailable: no `navigator.wakeLock`. It needs a secure context, so a phone pointed at a LAN
 *   dev server over plain http never has it. Set Auto-Lock to Never by hand for those runs.
 * - failed: the API exists and refused
 */
export type WakeLockState = 'held' | 'interrupted' | 'unavailable' | 'failed'

interface WakeLockHandle {
  state(): WakeLockState
  release(): void
}

interface SentinelLike {
  released: boolean
  addEventListener(type: 'release', cb: () => void): void
  release(): Promise<void>
}

/**
 * Hold a screen wake lock for the duration of a run, re-acquiring it when the page becomes visible
 * again (the lock is auto-released on hide and does not come back on its own).
 */
export function createScreenWakeLock(): WakeLockHandle {
  const api = (globalThis.navigator as { wakeLock?: { request(type: 'screen'): Promise<SentinelLike> } } | undefined)?.wakeLock
  if (!api) return { state: () => 'unavailable', release: () => {} }

  let state: WakeLockState = 'failed' // until the first request succeeds
  let sentinel: SentinelLike | null = null
  let done = false

  const acquire = (): void => {
    if (done) return
    void api
      .request('screen')
      .then((s) => {
        if (done) {
          void s.release().catch(() => {})
          return
        }
        sentinel = s
        // 'interrupted' is sticky: once the screen could have slept, a later re-acquire does not
        // make the run clean again
        if (state !== 'interrupted') state = 'held'
        s.addEventListener('release', () => {
          sentinel = null
          if (!done) state = 'interrupted'
        })
      })
      .catch(() => {
        if (state !== 'interrupted') state = 'failed'
      })
  }

  const onVisible = (): void => {
    if (!done && globalThis.document?.visibilityState === 'visible' && !sentinel) acquire()
  }
  acquire()
  globalThis.document?.addEventListener('visibilitychange', onVisible)

  return {
    state: () => state,
    release: () => {
      done = true
      globalThis.document?.removeEventListener('visibilitychange', onVisible)
      void sentinel?.release().catch(() => {})
      sentinel = null
    },
  }
}

export interface BenchWindowResult {
  /** human label for the interval, e.g. "0-30s" or "1-3m" */
  at: string
  frames: number
  /** frame interval quantiles in ms (what the display delivered), not main-thread cost */
  medianMs: number
  p95Ms: number
  worstMs: number
  /**
   * the fastest frame in the window, which is one display refresh step by definition. It is how
   * you read the panel's cadence off a run: on a 120 Hz phone the steps are 8.3 / 16.7 / 25.0 ms,
   * so a median that walks 17 -> 24 is not a gradual slide, it is the compositor dropping from
   * two steps to three.
   */
  minMs: number
  /** mean of the view's own cpuMs EMA across the window - the headroom number */
  cpuMs: number
  /** WebGPU timestamp-query GPU ms; null on WebGL, which has no equivalent */
  gpuMs: number | null
  drawCalls: number
  triangles: number
  /** GPU resources resident at the end of the window - a purge shows up here as a collapse */
  textures: number
  geometries: number
  /** hitches inside this window (the view's cumulative counter, differenced) */
  missedFrames: number
}

export interface BenchDeviceInfo {
  ua: string
  /** CSS viewport size */
  css: [number, number]
  dpr: number
  cores: number | null
  memGB: number | null
  /**
   * whether this device could have taken the WebGPU path at all. Recorded because the UA cannot
   * be read for it: Apple freezes the OS token in Safari's user agent (an iOS 26 phone reports
   * `iPhone OS 18_7`, the same way desktop Safari has said `Mac OS X 10_15_7` for years), so
   * inferring capability from the string gets it wrong. Ask the platform instead.
   */
  gpuAvailable: boolean
}

export interface BenchConfigInfo {
  tier: string
  /** the tier's cap... */
  dprCap: number
  /** ...and what the renderer actually took, min(devicePixelRatio, cap) */
  dprActual: number
  msaa: number
  singlePass: boolean
  /** true on both paths; `false` in older pastes, from a WebGPU path that ignored singlePass */
  singlePassHonoured: boolean
  shadowMap: number
  backend: string | null
  drawPath: string | null
  /**
   * Set whenever `drawPath` is 'replay': under WebGPU render bundles both `drawCalls` and
   * `triangles` tally what was encoded, not what was drawn: a full-scene replay reports ~26
   * draws and roughly a third of the triangles. Same scene, same pixels (verified by scene-graph
   * census + fixed-pose screenshots, e2e/probes/webgpu-triangle-census.mjs). Stated in the blob
   * because the blob is what gets pasted, and the numbers alone read as a scene gone missing.
   */
  countersNote: string | null
}

export interface BenchResult {
  v: 1
  build: string
  startedAt: string
  device: BenchDeviceInfo
  config: BenchConfigInfo
  workload: { scene: string; parts: number; path: 'orbit'; plannedSec: number; ranSec: number }
  load: {
    coverMs: number | null
    transientWorstMs: number | null
    /** elapsed of the first sampled frame, which explains a null transient */
    firstFrameAtSec: number | null
  }
  windows: BenchWindowResult[]
  events: {
    missedFrames: number
    gpuErrors: number
    contextLost: number
    /** when the context was lost, so each window can be judged valid or not */
    contextLostAtSec: number | null
    contextRestored: boolean
    /** the tab was hidden or resumed mid-run, so the windows it spans are not comparable */
    backgrounded: boolean
    /** did the screen actually stay awake - see WakeLockState, this is reported, not assumed */
    wakeLock: WakeLockState
    complete: boolean
  }
}

/** everything the run reads from the app, injected so the engine stays unit-testable */
export interface BenchHost {
  now(): number
  stats(): RenderStats | null
  setCameraPose(pose: BenchPose): void
  gpuErrors(): number
  hidden(): boolean
  wakeLock(): WakeLockState
  /** called once when the run finishes, so the host can drop the wake lock - optional for tests */
  onDone?(): void
  save(json: string): void
  build: string
  startedAt: string
  scene: string
  parts(): number
  device: BenchDeviceInfo
  config(): BenchConfigInfo
  /** canonical pose the orbit derives from: the scene's opening view, not wherever the user left the camera */
  startPose: BenchPose
}

/** quantile picker, identical to e2e/perf-webgpu-vs-webgl.mjs so the numbers mean the same thing */
function at(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function fmt(sec: number): string {
  return sec >= 60 && sec % 60 === 0 ? `${sec / 60}m` : `${sec}s`
}

function windowLabel(from: number, to: number): string {
  return from === 0 ? `0-${fmt(to)}` : `${fmt(from)}-${fmt(to)}`
}

class Accum {
  readonly dts: number[] = []
  private cpuSum = 0
  private gpuSum = 0
  private gpuN = 0
  private drawCalls = 0
  private triangles = 0
  private textures = 0
  private geometries = 0
  private missedAtStart: number | null = null
  private missedLatest = 0

  push(dtMs: number, s: RenderStats | null): void {
    this.dts.push(dtMs)
    if (!s) return
    this.cpuSum += s.cpuMs
    if (s.gpuMs !== null) {
      this.gpuSum += s.gpuMs
      this.gpuN++
    }
    // structural counts, not samples: the last frame's values describe the window
    this.drawCalls = s.drawCalls
    this.triangles = s.triangles
    this.textures = s.textures
    this.geometries = s.geometries
    if (this.missedAtStart === null) this.missedAtStart = s.missedFrames
    this.missedLatest = s.missedFrames
  }

  close(label: string): BenchWindowResult {
    const sorted = [...this.dts].sort((a, b) => a - b)
    const n = sorted.length
    return {
      at: label,
      frames: n,
      medianMs: round(at(sorted, 0.5)),
      p95Ms: round(at(sorted, 0.95)),
      worstMs: round(sorted[n - 1] ?? 0),
      minMs: round(sorted[0] ?? 0),
      cpuMs: round(n > 0 ? this.cpuSum / n : 0),
      gpuMs: this.gpuN > 0 ? round(this.gpuSum / this.gpuN) : null,
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      textures: this.textures,
      geometries: this.geometries,
      missedFrames: this.missedAtStart === null ? 0 : this.missedLatest - this.missedAtStart,
    }
  }
}

/**
 * One benchmark run. The host calls {@link frame} once per rendered frame (the editor's existing
 * `onFrame` hook); camera, windowing and checkpointing all happen in here.
 */
export class BenchRun {
  private readonly t0: number
  private readonly orbit: { tx: number; ty: number; tz: number; radius: number; height: number; angle0: number }
  private readonly windows: BenchWindowResult[] = []
  private cur = new Accum()
  private curIndex = 0
  private transientWorstMs = 0
  private firstFrameAtSec: number | null = null
  private lastFrameMs: number | null = null
  private coverMs: number | null = null
  private contextLost = 0
  private contextLostAtSec: number | null = null
  private contextRestored = false
  private backgrounded = false
  private ranSec = 0
  private doneFlag = false

  constructor(
    private readonly host: BenchHost,
    readonly params: BenchParams,
  ) {
    this.t0 = host.now()
    const p = host.startPose
    const dx = p.px - p.tx
    const dz = p.pz - p.tz
    const radius = Math.hypot(dx, dz)
    this.orbit = {
      tx: p.tx,
      ty: p.ty,
      tz: p.tz,
      // a degenerate opening pose (camera sitting on its target) would orbit in place, measuring nothing
      radius: radius > 0.5 ? radius : 12,
      height: p.py - p.ty,
      angle0: Math.atan2(dz, dx),
    }
  }

  get complete(): boolean {
    return this.doneFlag
  }

  /** ms from navigation to the loading cover fading out, recorded by the host */
  noteCover(ms: number): void {
    if (this.coverMs === null) this.coverMs = Math.round(ms)
  }

  /** a lost GPU context - on a phone that is usually memory pressure, and it is a result */
  noteContextLost(): void {
    this.contextLost++
    if (this.contextLostAtSec === null) this.contextLostAtSec = round((this.host.now() - this.t0) / 1000)
    this.checkpoint()
  }

  /**
   * the context came back. Worth recording separately: three re-initialises, but textures whose
   * source images were already released re-upload as black, so a restored run keeps producing
   * plausible frame numbers for a scene that is no longer being drawn correctly.
   */
  noteContextRestored(): void {
    this.contextRestored = true
    this.checkpoint()
  }

  /** deterministic camera pose for a point in the run */
  poseAt(elapsedSec: number): BenchPose {
    const a = this.orbit.angle0 + 2 * Math.PI * (elapsedSec / ORBIT_PERIOD_SEC)
    return {
      px: this.orbit.tx + this.orbit.radius * Math.cos(a),
      py: this.orbit.ty + this.orbit.height,
      pz: this.orbit.tz + this.orbit.radius * Math.sin(a),
      tx: this.orbit.tx,
      ty: this.orbit.ty,
      tz: this.orbit.tz,
    }
  }

  /**
   * One rendered frame. The interval is timed here rather than taken from the view's `onFrame`
   * dt, which is clamped to 100 ms (see RESUME_DT_MS) - that clamp silently caps worstMs and
   * makes every stall look identical.
   */
  frame(): void {
    if (this.doneFlag) return
    const nowMs = this.host.now()
    const elapsed = (nowMs - this.t0) / 1000
    this.ranSec = elapsed
    this.host.setCameraPose(this.poseAt(elapsed))

    // the first frame has no interval to report, only a start time
    const dtMs = this.lastFrameMs === null ? -1 : nowMs - this.lastFrameMs
    this.lastFrameMs = nowMs
    if (dtMs < 0) {
      this.closeWindows(elapsed)
      return
    }
    // A hidden tab stops rAF, so the first frame after resume carries the whole away-time as its
    // interval. Both the hidden state and an absurd dt mark the run interrupted instead of being
    // sampled. One such frame would otherwise set worstMs for the rest of the window.
    if (this.host.hidden() || dtMs > RESUME_DT_MS) {
      this.backgrounded = true
    } else {
      this.cur.push(dtMs, this.host.stats())
      if (this.firstFrameAtSec === null) this.firstFrameAtSec = round(elapsed)
      if (elapsed * 1000 <= TRANSIENT_MS) this.transientWorstMs = Math.max(this.transientWorstMs, dtMs)
    }
    this.closeWindows(elapsed)
  }

  private closeWindows(elapsed: number): void {
    let closed = false
    while (this.curIndex < this.params.boundariesSec.length && elapsed >= this.params.boundariesSec[this.curIndex]!) {
      const to = this.params.boundariesSec[this.curIndex]!
      const from = this.curIndex === 0 ? 0 : this.params.boundariesSec[this.curIndex - 1]!
      this.windows.push(this.cur.close(windowLabel(from, to)))
      this.cur = new Accum()
      this.curIndex++
      closed = true
    }
    if (this.curIndex >= this.params.boundariesSec.length && !this.doneFlag) {
      this.doneFlag = true
      this.host.onDone?.() // release the wake lock: the run is over, let the phone sleep
    }
    // a checkpoint per closed window: whatever is on disk survives the tab being killed
    if (closed) this.checkpoint()
  }

  /** drop the wake lock without finishing the run (the view is being torn down) */
  releaseWakeLock(): void {
    this.host.onDone?.()
  }

  /** live progress for the overlay */
  progress(): { elapsedSec: number; totalSec: number; windows: number; frames: number; wakeLock: WakeLockState } {
    return {
      elapsedSec: this.ranSec,
      totalSec: this.params.totalSec,
      windows: this.windows.length,
      frames: this.cur.dts.length,
      wakeLock: this.host.wakeLock(),
    }
  }

  result(): BenchResult {
    return {
      v: 1,
      build: this.host.build,
      startedAt: this.host.startedAt,
      device: this.host.device,
      config: this.host.config(),
      workload: {
        scene: this.host.scene,
        parts: this.host.parts(),
        path: 'orbit',
        plannedSec: this.params.totalSec,
        ranSec: round(this.ranSec),
      },
      load: {
        coverMs: this.coverMs,
        transientWorstMs: this.transientWorstMs > 0 ? round(this.transientWorstMs) : null,
        firstFrameAtSec: this.firstFrameAtSec,
      },
      windows: this.windows,
      events: {
        missedFrames: this.windows.reduce((n, w) => n + w.missedFrames, 0),
        gpuErrors: this.host.gpuErrors(),
        contextLost: this.contextLost,
        contextLostAtSec: this.contextLostAtSec,
        contextRestored: this.contextRestored,
        backgrounded: this.backgrounded,
        wakeLock: this.host.wakeLock(),
        complete: this.doneFlag,
      },
    }
  }

  private checkpoint(): void {
    try {
      this.host.save(JSON.stringify(this.result()))
    } catch {
      /* storage full / private mode - the on-screen copy still works */
    }
  }
}

/** parse a parked run, rejecting anything that is not a v1 blob (an older schema is not comparable) */
export function readSavedBench(raw: string | null): BenchResult | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const r = parsed as Partial<BenchResult>
    return r.v === 1 && Array.isArray(r.windows) ? (r as BenchResult) : null
  } catch {
    return null
  }
}
