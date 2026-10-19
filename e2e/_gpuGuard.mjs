// WebGPU device-error guard for every e2e page.
//
// A WebGPU validation error never throws. The device fires `uncapturederror`, three logs it, the
// frame is wrong, and the script's own assertions about positions, params and draw counts still pass.
// A buffer freed while a recording held it shipped twice as a black viewport with every gate green:
// src/render/gpuErrorWatch.ts recorded the errors, but only three of ~130 verify-* scripts read them.
//
// So this is not a per-gate check. This module patches the playwright entry points once, watches
// every page any gate opens, and reports at process exit. `_server.mjs` imports it for that side
// effect, and every gate imports `_server.mjs`, so a new gate gets the guard without doing anything.
//
// Errors are split at the moment the scene settles (`incrementalWarmReady`, or a grace period if a
// gate never reaches it):
//   - before  → reported as a note, never a failure. A known open load-time race in three's
//               bind-group lifetime (documented in verify-webgpu-resize-no-gpu-errors.mjs) raises
//               a couple of these on ~1 run in 3. Failing on it would make gates intermittently
//               red, and people would learn to ignore the signal.
//   - after   → FAIL. After the warm the app is idle unless the gate drives it, so an uncaptured
//               error comes from that gesture.
//
// The failure is printed as a leading `FAIL` line, the verdict convention scripts/run-gates.mjs
// classifies on, and sets a non-zero exit code if the gate has not already set one. A gate that
// asserts this itself (the two *-no-gpu-errors gates) reports it twice when broken, which is harmless.
//
// Every gate runs this code, so it must not be able to break one: every page call is wrapped, the
// poller is unref'd (it never holds a process open), and any error inside the guard is swallowed.
// At worst it reports nothing.
/* global process, console, window, setInterval, clearInterval */
import { chromium } from 'playwright'
// Same patch point, second job: hand every headless launch the machine's real GPU adapter. Kept in
// its own module because it is a different concern from the error watch - see e2e/_gpuArgs.mjs for
// the measurement, the escape hatch, and what it leaves alone.
import { withGpuArgs } from './_gpuArgs.mjs'

/** how often to sample the in-page tally (ms) - cheap, and the tally is monotone so nothing is missed */
const POLL_MS = 500
/** if a gate never reaches incrementalWarmReady, treat the scene as settled this long after the
 *  watch first appears. Generous: load churn must land in the informational bucket. */
const SETTLE_GRACE_MS = 12000

const report = {
  /** pages that had a live gpuErrorWatch (i.e. a real WebGPU device) */
  watched: 0,
  /** uncaptured errors seen before the scene settled - informational */
  load: 0,
  /** uncaptured errors seen after it settled - the ones that fail */
  post: 0,
  /** distinct messages, first-seen order, post-settle only */
  distinct: [],
}

/** the running tally, for a gate or probe that wants to assert inline as well */
export function gpuGuardReport() {
  return { ...report, distinct: [...report.distinct] }
}

function noteDistinct(messages) {
  for (const m of messages) {
    if (report.distinct.length >= 6) return
    if (!report.distinct.includes(m)) report.distinct.push(m)
  }
}

/** Poll one page's tally until it closes. Never throws, never holds the process open. */
function watchPage(page) {
  let baseline = null // count at the moment the scene settled; null until then
  let firstSeenAt = 0
  let counted = 0 // what we have already folded into the report from this page
  const timer = setInterval(() => {
    page
      .evaluate(() => {
        const r = globalThis.__oipGpuErrors
        if (!r) return null
        return {
          count: r.count,
          // the message only - a repeat count in the key would make one recurring error read as a
          // new distinct one on every poll, which is noise in exactly the failure it is reporting
          distinct: r.distinct.map((d) => d.message),
          // the view exposes this once the staged reveal + pipeline warm have finished
          settled: window.__oip?.view?.incrementalWarmReady === true,
        }
      })
      .then((snap) => {
        if (!snap) return // no device (WebGL fallback) or the app has not booted yet
        if (firstSeenAt === 0) {
          firstSeenAt = Date.now()
          report.watched++
        }
        if (baseline === null && (snap.settled || Date.now() - firstSeenAt > SETTLE_GRACE_MS)) {
          baseline = snap.count
          report.load += Math.max(0, snap.count - counted)
          counted = snap.count
          return
        }
        if (baseline === null) {
          report.load += Math.max(0, snap.count - counted)
          counted = snap.count
          return
        }
        const added = snap.count - counted
        if (added > 0) {
          report.post += added
          counted = snap.count
          noteDistinct(snap.distinct)
        }
      })
      .catch(() => {
        // page closed / navigating / context destroyed - nothing to do, keep polling until close
      })
  }, POLL_MS)
  timer.unref?.() // a guard must never be the reason a gate hangs
  page.on?.('close', () => clearInterval(timer))
}

/** wrap a BrowserContext so pages it opens (now or later) are watched */
function watchContext(context) {
  try {
    for (const p of context.pages?.() ?? []) watchPage(p)
    const origNewPage = context.newPage?.bind(context)
    if (origNewPage) {
      context.newPage = async (...a) => {
        const page = await origNewPage(...a)
        watchPage(page)
        return page
      }
    }
  } catch {
    /* a guard must not be able to break a gate */
  }
}

// --- patch the entry points, once per process ---------------------------------
if (!globalThis.__oipGpuGuardInstalled) {
  globalThis.__oipGpuGuardInstalled = true

  const origLaunch = chromium.launch.bind(chromium)
  chromium.launch = async (...args) => {
    const browser = await origLaunch(withGpuArgs(args[0]), ...args.slice(1))
    try {
      const origNewPage = browser.newPage.bind(browser)
      browser.newPage = async (...a) => {
        const page = await origNewPage(...a)
        watchPage(page)
        return page
      }
      const origNewContext = browser.newContext.bind(browser)
      browser.newContext = async (...a) => {
        const context = await origNewContext(...a)
        watchContext(context)
        return context
      }
    } catch {
      /* ignore */
    }
    return browser
  }

  // the warm-cache gates run a persistent profile, which hands back a context, not a browser
  const origPersistent = chromium.launchPersistentContext?.bind(chromium)
  if (origPersistent) {
    chromium.launchPersistentContext = async (...args) => {
      // (userDataDir, options) - the options are the second argument here
      const context = await origPersistent(args[0], withGpuArgs(args[1]), ...args.slice(2))
      watchContext(context)
      return context
    }
  }

  process.on('exit', () => {
    try {
      if (report.post > 0) {
        // leading FAIL token = the fleet's verdict convention (scripts/run-gates.mjs)
        console.log(
          `FAIL  ${report.post} uncaptured WebGPU error(s) AFTER the scene settled - the frame this gate judged is not what the scene says`,
        )
        for (const m of report.distinct) console.log(`      ${m}`)
        console.log(
          '      "used in submit while destroyed" = a recorded render bundle drew a freed resource:\n' +
            '      something disposed a geometry/mesh/material without retiring it (src/render/gpuRetire.ts),\n' +
            '      or a re-emit minted instead of recycling (src/render/geometryRecycle.ts).\n' +
            '      Reported automatically by e2e/_gpuGuard.mjs - this gate does not assert it itself.',
        )
        if (!process.exitCode) process.exitCode = 1
      } else if (report.load > 0) {
        // never a failure: the documented three-internal load race (see the module header)
        console.log(`note  ${report.load} uncaptured WebGPU error(s) during load only (known-open load race) - gate unaffected`)
      }
    } catch {
      /* never let the reporter itself break a run */
    }
  })
}
