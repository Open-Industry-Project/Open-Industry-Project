// A check of this device's PLC engine, for the run log (runLog.ts): the same program on the typed engine, whose
// bodies are WebAssembly, and on the walker, every variable compared after every scan (plc/scanEngineOracle.ts).
//
// The two are held together by the unit suite on the machine that runs it. A program's bodies are compiled again on
// each device by that device's own WebAssembly engine, and its optimising tiers take a body over only after some
// thousands of calls, so a fault of the engine shows on that device alone and minutes into a run. This runs enough
// scans to be past that point.

import { controllerRuns, runnableSource } from '../plc'
import { compareEngines, type OracleStep } from '../plc/scanEngineOracle'
import type { Controller } from '../core/controller'

/** Timers, a pulse, an edge and a counter, each called every scan: the blocks that read the controller's clock. */
const TIMERS = `VAR
  go : BOOL;
  a, b, c : TON;
  p : TP;
  f : TOF;
  edge : R_TRIG;
  count : CTU;
  n : DINT;
  r : LREAL;
  lamp : BOOL;
END_VAR
a(IN := NOT b.Q, PT := T#500ms);
b(IN := a.Q, PT := T#500ms);
c(IN := go, PT := T#1000ms);
p(IN := a.Q, PT := T#200ms);
f(IN := c.Q, PT := T#300ms);
edge(CLK := c.Q);
count(CU := edge.Q, R := FALSE, PV := 1000);
IF c.Q THEN n := n + 1; END_IF;
r := r + 0.25;
lamp := a.Q AND NOT p.Q;
`

export interface EngineCheck {
  /** which program: the built-in timers, or the open project's */
  of: 'timers' | 'project'
  scans: number
  compared: number
  /** the first differences, as the oracle words them; empty when the engines agreed */
  diffs: string[]
  /** the typed engine refused the program, a fault ended the run, or the check itself threw */
  note?: string
  ms: number
}

function run(of: EngineCheck['of'], source: string, steps: readonly OracleStep[]): EngineCheck {
  const t0 = performance.now()
  try {
    const r = compareEngines(source, steps, { maxDiffs: 6 })
    const note = r.refused !== undefined ? `refused: ${r.refused}` : r.fault !== null ? `fault: ${r.fault}` : undefined
    return { of, scans: r.scans, compared: r.compared, diffs: r.diffs, ...(note !== undefined ? { note } : {}), ms: Math.round(performance.now() - t0) }
  } catch (e) {
    return { of, scans: 0, compared: 0, diffs: [], note: `threw: ${e instanceof Error ? e.message : String(e)}`, ms: Math.round(performance.now() - t0) }
  }
}

/**
 * Compare the engines on this device: the timers for `scans` scans of 10 ms, then the open project's program (the
 * default controller's share of it) for a quarter as many, its inputs left as they start. Blocks the thread for as long
 * as it takes. Measured in a desktop WebKit on the dev server: 1.5 s for the timers and 11 s for 10,000 scans of the
 * demo's program, which compares 275 values a scan.
 */
export function checkPlcEngines(open: { stProgram: string; controller: Controller | null | undefined; stScanMs: number } | null, scans = 60_000): EngineCheck[] {
  const out = [run('timers', TIMERS, Array.from({ length: scans }, (_, i) => ({ dt: 0.01, ...(i % 300 === 0 ? { in: { go: i % 600 === 0 } } : {}) })))]
  if (open && open.stProgram.trim() !== '') {
    try {
      const main = controllerRuns(open.stProgram, open.controller, open.stScanMs, { simulated: [] }).find((r) => r.controller === null)
      if (main) out.push(run('project', runnableSource(main.source, main.table), Array.from({ length: Math.ceil(scans / 4) }, () => ({ dt: 0.01 }))))
    } catch (e) {
      out.push({ of: 'project', scans: 0, compared: 0, diffs: [], note: `threw: ${e instanceof Error ? e.message : String(e)}`, ms: 0 })
    }
  }
  return out
}
