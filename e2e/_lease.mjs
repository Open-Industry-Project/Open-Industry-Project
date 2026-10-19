// Machine-wide lease for GPU-bound e2e work.
//
// `run-gates` runs 2 gates at a time because a machine has one GPU, but nothing stops three test
// runs from each starting a 2-wide batch. The box then runs 6-wide plus whatever else is up, and all
// three runs get failures that look like broken gates. Measured at concurrency 4: 41 HARNESS + 7 HUNG
// + 26 FAILED, and every sampled script from that set passed when run alone. Measured across
// concurrent runs: 3 of 9 gates non-PASS, the two slowest gates were not the ones under
// investigation, and a phase probe disagreed with itself 7x.
//
// As with _gpuGuard.mjs, scripts don't opt in. `startServer()` takes the lease and every script
// calls `startServer()`, so every script holds the lease, including one written by someone who has
// never heard of this file. Runs don't need to know about each other.
//
// It only serialises scripts that call startServer(). A dev server, a vitest run or another
// toolchain is not covered. For those, `_load.mjs` stamps every result with the conditions it was
// taken under, so a number skewed by outside load is marked as such.
//
// Design rules:
//   - Advisory, never fatal. On timeout it warns and proceeds. A gate that a crashed peer can
//     block forever is worse than contention.
//   - Reentrant through env, like OIP_SHARED_PORT: run-gates takes one batch lease and its children
//     see it held by an ancestor. Without this, CONCURRENCY=2 would deadlock down to 1.
//   - Machine-global, not repo-relative. `.e2e-server.json` lives at the repo root, so two checkouts
//     on one machine collide. This lease lives in LOCALAPPDATA.
//   - Self-healing. A holder that died without releasing is detected by PID liveness, and any lease
//     older than MAX_AGE_MS is broken regardless, because PIDs get reused.
/* global process, console, setTimeout */
import { readFileSync, unlinkSync, writeSync, openSync, closeSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { machineScratchDir } from './_load.mjs'

const LOCK_PATH = join(machineScratchDir(), 'oip-e2e-gpu.lock')

// A batch of gates can legitimately run for half an hour; nothing should hold this for two.
const MAX_AGE_MS = 2 * 60 * 60_000
// How long to queue before giving up and running anyway (loudly).
const DEFAULT_WAIT_MS = Number(process.env.OIP_E2E_LEASE_WAIT_MS ?? 20 * 60_000)
// A lease file with no readable holder in it is broken only once it is this old. tryTake writes the holder through the
// descriptor it created, so the file is empty only for the instant between those two calls. A peer reading in that
// instant must not break it, take it and run beside the holder. Anything still unreadable after this long is litter.
const UNREADABLE_GRACE_MS = 10_000

const noop = () => {}

/** '45s' / '20m' - a wait under a minute must not print as '0m'. */
const humanMs = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`)

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM means it exists and belongs to someone else - still alive.
    return e?.code === 'EPERM'
  }
}

function readRaw() {
  try {
    return readFileSync(LOCK_PATH, 'utf8')
  } catch {
    return null
  }
}

function parseHolder(raw) {
  try {
    const h = JSON.parse(raw)
    return typeof h?.pid === 'number' ? h : null
  } catch {
    return null
  }
}

function readHolder() {
  const raw = readRaw()
  return raw === null ? null : parseHolder(raw)
}

/** Remove a lease whose owner is gone, or one old enough that its owner cannot be trusted. */
function clearIfStale() {
  const raw = readRaw()
  if (raw === null) return true // released since we looked: just try again
  const h = parseHolder(raw)
  let stale
  if (h === null) {
    // unreadable or corrupt: not a lease anyone can honour - unless it is one being written right now
    let age = Infinity
    try { age = Date.now() - statSync(LOCK_PATH).mtimeMs } catch { return true }
    stale = age > UNREADABLE_GRACE_MS
  } else {
    stale = !alive(h.pid) || Date.now() - (h.started ?? 0) > MAX_AGE_MS
  }
  if (!stale) return false
  // Break only the lease we judged. Another waiter may have broken the same dead one and taken it since we read it,
  // and deleting that one would put two batches on the GPU; the re-read narrows that to the gap between two syscalls.
  if (readRaw() !== raw) return true
  try { unlinkSync(LOCK_PATH) } catch { /* raced with the owner's release */ }
  return true
}

/** Atomic create-or-fail. Returns true if we now hold the lease. */
function tryTake(label) {
  let fd
  try {
    // 'wx' is an exclusive create: two processes racing here, exactly one wins.
    fd = openSync(LOCK_PATH, 'wx')
  } catch {
    return false
  }
  try {
    // The identity goes in through this descriptor, before it is closed. Closing first and writing by path would leave
    // an empty file between the two, which a peer would read as a corrupt lease, break, and take - two holders, both
    // running.
    writeSync(fd, JSON.stringify({ pid: process.pid, label, started: Date.now() }) + '\n')
  } catch {
    closeSync(fd)
    try { unlinkSync(LOCK_PATH) } catch { /* already gone */ }
    return false
  }
  closeSync(fd)
  return true
}

let held = false
let cleanupInstalled = false

function release() {
  if (!held) return
  held = false
  const h = readHolder()
  // only clear our own lease: a timed-out waiter may since have broken ours and taken it
  if (h?.pid === process.pid) {
    try { unlinkSync(LOCK_PATH) } catch { /* already gone */ }
  }
  delete process.env.OIP_E2E_LEASE
}

function installCleanup() {
  if (cleanupInstalled) return
  cleanupInstalled = true
  process.on('exit', release)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { release(); process.exit(1) })
  }
}

/**
 * Queue for exclusive use of this machine's GPU, then run.
 *
 * Returns a release function. Safe to call in any order, any number of times, and released
 * automatically at exit - a script that forgets its `finally` does not wedge the box.
 *
 * No-ops (returning immediately) when:
 *   - OIP_E2E_LEASE_OFF is set        - the escape hatch, for when you mean to overlap
 *   - OIP_E2E_LEASE is set            - an ancestor already holds it for this whole process tree
 *   - this process already holds it   - startServer() called twice
 */
export async function acquireLease({ label = 'e2e', waitMs = DEFAULT_WAIT_MS, quiet = false } = {}) {
  if (process.env.OIP_E2E_LEASE_OFF) return noop
  if (process.env.OIP_E2E_LEASE) return noop
  if (held) return noop

  const deadline = Date.now() + waitMs
  let announced = false
  for (;;) {
    if (tryTake(label)) {
      held = true
      // children inherit this, so a batch runner's gates do not queue against their own parent
      process.env.OIP_E2E_LEASE = String(process.pid)
      installCleanup()
      if (announced && !quiet) console.log(`[lease] acquired after waiting`)
      return release
    }
    if (clearIfStale()) continue // broke a dead holder's lease; try again immediately

    if (Date.now() > deadline) {
      const h = readHolder()
      if (!quiet) {
        console.warn(
          `[lease] still held by pid ${h?.pid ?? '?'} (${h?.label ?? 'unknown'}) after ${humanMs(waitMs)} ` +
          `- running ANYWAY. Timings from this run are contended; see the load stamp on each result.`,
        )
      }
      return noop
    }
    if (!announced && !quiet) {
      const h = readHolder()
      const age = h?.started ? ((Date.now() - h.started) / 1000).toFixed(0) : '?'
      console.log(`[lease] waiting for pid ${h?.pid ?? '?'} (${h?.label ?? 'unknown'}, ${age}s in) - set OIP_E2E_LEASE_OFF=1 to overlap deliberately`)
      announced = true
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/** Who holds it right now, for a diagnostic. null when free. */
export function leaseHolder() {
  const h = readHolder()
  if (!h || !alive(h.pid)) return null
  return h
}

export const LEASE_PATH = LOCK_PATH
