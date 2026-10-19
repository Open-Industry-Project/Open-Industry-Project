// Records what else was running while a timing was taken.
//
// Timings here are taken on a developer workstation that may also be running a dev server, two
// vitest instances, a second checkout's vite, another run's gates and more. Without its conditions,
// a reader can't tell a skewed number from a real one.
//
// A phase-timing probe run twice against the same build, minutes apart, disagreed by 7x on one phase
// (page.goto 7251 ms vs 1035 ms). The box was at 100% CPU with 18 chromium-family processes and 22
// node processes, most of them from other test runs. Three conclusions were drawn from the first set
// before anyone looked at the process table. So every result carries its conditions.
//
// It is cheap and cannot fail a run. The CPU reading comes from os.cpus() deltas (no spawn, no sleep,
// no sampling window). The process census is one tasklist/ps call, capped and wrapped, returning null
// rather than throwing.
//
// This covers processes nothing coordinates with, including ones outside this repo. `_lease.mjs`
// prevents contention among e2e scripts and cannot see anything else.
/* global process */
import { spawnSync } from 'node:child_process'
import { cpus, tmpdir } from 'node:os'

/**
 * Cumulative CPU time across all cores, for differencing against a later sample.
 *
 * Absolute values are meaningless; a pair of these spanning a run gives the average busy percentage
 * over exactly that run, which is the number a reader of the result wants. os.cpus() reports
 * monotonic counters, so no sampling interval or sleep is involved.
 */
export function cpuTimes() {
  let idle = 0
  let total = 0
  for (const c of cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k]
    idle += c.times.idle
  }
  return { idle, total }
}

/** Average CPU busy % between two cpuTimes() samples; null if the pair is unusable. */
export function cpuBusyPct(a, b) {
  if (!a || !b) return null
  const dTotal = b.total - a.total
  const dIdle = b.idle - a.idle
  if (!(dTotal > 0)) return null
  return Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100)))
}

// One process census, capped. The counts that matter here are node (vite, vitest, other runs'
// scripts, collab servers) and the chromium family (every e2e page, plus any browser the person has
// open). We count totals rather than trying to subtract our own tree: attributing a process to an
// owner needs a parent walk that is slow and wrong often enough to mislead, while a total of 22 node
// processes is already a sufficient answer to "was this box quiet".
const NODE_NAMES = /^(node|node\.exe)$/i
const BROWSER_NAMES = /^(chrome|chrome\.exe|msedge|msedge\.exe|chromium|chromium\.exe|headless_shell|headless_shell\.exe|Google Chrome Helper)$/i

/** @returns {{node: number, browser: number} | null} */
export function sampleProcs() {
  try {
    const r = process.platform === 'win32'
      ? spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 4000, windowsHide: true, maxBuffer: 8 << 20 })
      : spawnSync('ps', ['-e', '-o', 'comm='], { encoding: 'utf8', timeout: 4000, maxBuffer: 8 << 20 })
    if (r.error || typeof r.stdout !== 'string' || !r.stdout) return null
    let node = 0
    let browser = 0
    for (const raw of r.stdout.split('\n')) {
      // tasklist CSV: "name","pid",...  ps: a bare command name, possibly a path
      const name = process.platform === 'win32'
        ? (/^"([^"]*)"/.exec(raw)?.[1] ?? '')
        : raw.trim().split('/').pop() ?? ''
      if (!name) continue
      if (NODE_NAMES.test(name)) node++
      else if (BROWSER_NAMES.test(name)) browser++
    }
    return { node, browser }
  } catch {
    return null
  }
}

/**
 * A full stamp for one measured interval.
 *
 * `begin()` at the start, `end(token)` at the finish. The process census is taken at both ends and
 * reported as the higher of the two, because the failure this guards is "something heavy was running
 * for part of the window" - a single sample at either edge misses exactly that.
 */
export function begin() {
  return { cpu: cpuTimes(), procs: sampleProcs(), at: Date.now() }
}

export function end(token) {
  const procs = sampleProcs()
  const a = token?.procs
  return {
    cpuPct: cpuBusyPct(token?.cpu, cpuTimes()),
    node: Math.max(a?.node ?? 0, procs?.node ?? 0) || null,
    browser: Math.max(a?.browser ?? 0, procs?.browser ?? 0) || null,
    cores: cpus().length,
  }
}

/**
 * One short human-readable clause, e.g. `load 98% · 22 node · 18 browser`.
 *
 * Returns '' when nothing could be sampled, so a caller can concatenate it unconditionally.
 */
export function formatLoad(stamp) {
  if (!stamp) return ''
  const bits = []
  if (stamp.cpuPct !== null && stamp.cpuPct !== undefined) bits.push(`load ${stamp.cpuPct}%`)
  if (stamp.node) bits.push(`${stamp.node} node`)
  if (stamp.browser) bits.push(`${stamp.browser} browser`)
  return bits.join(' · ')
}

/**
 * Is the machine quiet enough for a timing to be worth believing?
 *
 * A judgement, not a measurement, and generous: this only has to separate "quiet box"
 * from the case above (100% CPU, 22 node, 18 browser). Callers use it to mark a number, never
 * to refuse to take one - a slow result on a busy box is still the truth about that box.
 */
export function looksContended(stamp) {
  if (!stamp) return false
  if ((stamp.cpuPct ?? 0) >= 85) return true
  // a cold e2e run is ~2-4 node (runner, script, vite) and one browser; well past that means other work is running
  if ((stamp.node ?? 0) >= 10) return true
  if ((stamp.browser ?? 0) >= 12) return true
  return false
}

/** Where a machine-global scratch file belongs on this OS (also used by _lease.mjs). */
export function machineScratchDir() {
  return process.env.LOCALAPPDATA || process.env.XDG_RUNTIME_DIR || tmpdir()
}
