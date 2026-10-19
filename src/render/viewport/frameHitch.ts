/**
 * Counts frames that took substantially longer than the frames around them: the HUD's `missed`
 * and the device benchmark's `missedFrames`.
 *
 * It counts hiccups, not steady load. A run that is uniformly slow re-baselines and reports zero,
 * while a pipeline compile or a GC pause in an otherwise smooth run stands out. The baseline is a
 * median, not a running minimum (`min(est * 1.005, dt)`, decaying upward 0.5% per frame), because a
 * running minimum inverts the metric on a variable-refresh display.
 *
 * Measured on an iPhone with a 120 Hz ProMotion panel (8.3 ms steps) running the editor at 60 fps:
 * with a running minimum, one 9.7 ms frame drops the baseline to 9.7, which puts the threshold at
 * 14.6 ms, below the healthy 16.7 ms cadence. Every following normal frame then counts as missed
 * for the ~27 frames it takes 0.5%-per-frame growth to climb back over 11.1 ms. About 17 such dips
 * in 30 seconds gave 473 "missed frames" in a window whose p95 was 18.1 ms and whose worst frame was
 * 24 ms. That measures the panel, not the app, and it reported the same count before and after a
 * change that removed a 142 ms stall.
 *
 * Outliers can't drag a rolling median in either direction: one fast frame moves it by one sample
 * out of the window, and a slower steady state moves it wholesale, which is the re-baselining the
 * metric needs.
 */

/** intervals kept for the baseline - about a second at 60 fps, half at 120 */
const WINDOW = 64
/** a frame this many times the recent typical interval is a hitch */
const FACTOR = 1.5
/** below this many samples the baseline is too noisy to judge against */
const MIN_SAMPLES = 8
/** re-sort this often; between recomputes the last baseline stands (sorting 64 floats 4x/s is negligible) */
const RECOMPUTE_EVERY = 16

export class HitchCounter {
  private readonly ring = new Float64Array(WINDOW)
  private filled = 0
  private head = 0
  private sinceRecompute = 0
  private baseline = 0
  private hitches = 0

  /** frames counted as a hitch since construction */
  get missed(): number {
    return this.hitches
  }

  /** the current typical frame interval in seconds (0 before enough samples) - diagnostics */
  get baselineSec(): number {
    return this.baseline
  }

  /**
   * Feed one frame interval (seconds). Returns true when it counted as a hitch.
   *
   * The sample is recorded before judging: a hitch belongs in the window it happened
   * in, so a run of them raises the baseline and stops being reported as hitching. That is the
   * "sustained slowness re-baselines" behaviour, and with a median it needs no extra work.
   */
  push(dtSec: number): boolean {
    this.ring[this.head] = dtSec
    this.head = (this.head + 1) % WINDOW
    if (this.filled < WINDOW) this.filled++

    if (this.sinceRecompute-- <= 0) {
      this.sinceRecompute = RECOMPUTE_EVERY
      this.baseline = this.median()
    }
    if (this.filled < MIN_SAMPLES || this.baseline <= 0) return false

    const hitch = dtSec > this.baseline * FACTOR
    if (hitch) this.hitches++
    return hitch
  }

  private median(): number {
    if (this.filled === 0) return 0
    const sorted = Array.prototype.slice.call(this.ring, 0, this.filled) as number[]
    sorted.sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)] ?? 0
  }
}
