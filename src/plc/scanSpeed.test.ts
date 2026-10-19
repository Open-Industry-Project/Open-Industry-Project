// The speed gate for the typed scan engine (typed/, scanCodegen.ts): how many times faster than the walker it scans, on
// programs shaped like the kinds of real load. scanEngines.test.ts proves the engines agree. Nothing else would notice
// the typed one losing its speed, because what its speed depends on fails silently: a body too big for V8 to optimise,
// a coercion the types made unnecessary coming back, a function call resetting its region the slow way. Every other
// test stays green while the scan gets several times slower.
//
// It gates a ratio, measured in one process with the two engines interleaved and the best run of each kept, so the
// machine's load (other test runs, a dev server, a parallel suite) divides out; an absolute time would be noise here.
// The floors sit well below what was measured (see each one) so a busy box doesn't fail them, and well above what a
// lost optimisation leaves (each one measured to fall below its floor when the thing it guards was switched off).

import { describe, expect, it } from 'vitest'
import { compile, setScanEngine, type ScanEngine } from './interpreter'
import type { CompiledProgram } from './types'

/** Struct traffic across several UDT types, with integer arithmetic, bits and branches: the shape of a large
 *  program. Several types matter: one helper shared by every field read sees all their shapes, which is what direct
 *  per-site field access (and one shape per type) is for. */
const STRUCTS = `
TYPE Belt : STRUCT Run : BOOL; Count : DINT; Speed : REAL; END_STRUCT; END_TYPE
TYPE Eye : STRUCT Blocked : BOOL; Hits : DINT; END_STRUCT; END_TYPE
TYPE Motor : STRUCT On : BOOL; Amps : REAL; Faults : DINT; Ons : DWORD; END_STRUCT; END_TYPE
TYPE Slot : STRUCT Occupied : BOOL; Id : DINT; Age : DINT; END_STRUCT; END_TYPE
TYPE Lamp : STRUCT Lit : BOOL; Blink : DINT; END_STRUCT; END_TYPE
PROGRAM Main
VAR belts : ARRAY[1..20] OF Belt; eyes : ARRAY[1..20] OF Eye; motors : ARRAY[1..20] OF Motor; slots : ARRAY[1..20] OF Slot;
  lamps : ARRAY[1..20] OF Lamp; i : INT; tick : DINT; total : DINT; END_VAR
tick := tick + 1;
total := 0;
FOR i := 1 TO 20 DO
  belts[i].Run := ((tick + i) MOD 5) <> 0;
  eyes[i].Blocked := ((tick + i) MOD 4) = 0;
  IF eyes[i].Blocked THEN eyes[i].Hits := eyes[i].Hits + 1; END_IF;
  motors[i].On := belts[i].Run AND NOT eyes[i].Blocked;
  IF motors[i].On THEN
    motors[i].Amps := motors[i].Amps * 0.9 + 0.5;
    belts[i].Count := belts[i].Count + 1;
  END_IF;
  motors[i].Ons := motors[i].Ons OR 2;
  slots[i].Occupied := eyes[i].Blocked;
  slots[i].Age := slots[i].Age + 1;
  lamps[i].Lit := slots[i].Occupied OR motors[i].On;
  lamps[i].Blink := lamps[i].Blink + 1;
  total := total + belts[i].Count + eyes[i].Hits;
END_FOR;
END_PROGRAM
`

/** Calls: instances of a user block with a timer, user FUNCTIONs, builtins - the shape of a call-heavy IEC program. */
const CALLS = `
FUNCTION_BLOCK Zone
VAR_INPUT Enable : BOOL; Speed : REAL; Target : DINT; Sensor : BOOL; END_VAR
VAR_OUTPUT Run : BOOL; Count : DINT; Out : REAL; END_VAR
VAR t : TON; last : BOOL; END_VAR
t(IN := Enable AND NOT Sensor, PT := T#200ms);
IF Sensor AND NOT last THEN Count := Count + 1; END_IF;
last := Sensor;
Run := Enable AND (Count < Target) AND NOT t.Q;
Out := LIMIT(0.0, Speed * 1.5, 100.0);
END_FUNCTION_BLOCK

FUNCTION Scale : REAL
VAR_INPUT x : REAL; k : REAL; END_VAR
Scale := ABS(x) * k;
END_FUNCTION

FUNCTION Clamp : REAL
VAR_INPUT v : REAL; lo : REAL; hi : REAL; END_VAR
Clamp := LIMIT(lo, v, hi);
END_FUNCTION

PROGRAM Main
VAR zones : ARRAY[1..40] OF Zone; i : INT; tick : DINT; total : DINT; s : REAL; m : DINT; a : DINT; END_VAR
tick := tick + 1;
total := 0;
FOR i := 1 TO 40 DO
  zones[i](Enable := TRUE, Speed := INT_TO_REAL(i), Target := 1000, Sensor := ((tick + i) MOD 7) = 0);
  total := total + zones[i].Count;
  s := Scale(zones[i].Out, 0.5) + Scale(INT_TO_REAL(i), 2.0) + Clamp(DINT_TO_REAL(total), 0.0, 50.0);
  m := MAX(m, MIN(total, 100000));
  a := ABS(a - INT_TO_DINT(i)) + MIN(a, 7);
END_FOR;
END_PROGRAM
`

/** One long straight-line body, the shape of a large main program: far past the size V8 will optimise as one
 *  function, so it only stays fast while scanCodegen splits big statement lists into sub-functions. Its variables stay
 *  well under the ~1000 a V8 record holds in fast mode (past that the record is a hash table however it is built, so
 *  the ratio falls for a reason this gate does not guard), so it can also tell whether records keep their shape. */
const LONG = (() => {
  const vars = 200
  const rungs = 1500
  const decls = Array.from({ length: vars / 2 }, (_, k) => `a${k} : DINT; b${k} : BOOL;`).join(' ')
  const body = Array.from({ length: rungs }, (_, r) => {
    const k = r % (vars / 2)
    return `a${k} := a${k} + ${(r % 7) + 1}; IF a${k} > 100000 THEN a${k} := 0; END_IF; b${k} := ((a${k} MOD 3) = 0) AND NOT b${(k + 1) % (vars / 2)};`
  }).join(' ')
  return `PROGRAM Main VAR ${decls} END_VAR ${body} END_PROGRAM`
})()

/** A POU with more variables than one V8 record keeps in fast mode (~1000), the shape of a large controller's
 *  controller-scope tags: it stays fast only while interpreter.ts splits its image into chunks (CHUNK_FIELDS). */
const WIDE = (() => {
  const n = 700 // x 2 = 1400 variables
  const decls = Array.from({ length: n }, (_, k) => `a${k} : DINT; b${k} : BOOL;`).join(' ')
  const body = Array.from({ length: n }, (_, k) => `a${k} := a${k} + ${(k % 7) + 1}; IF a${k} > 100000 THEN a${k} := 0; END_IF; b${k} := ((a${k} MOD 3) = 0) AND NOT b${(k + 1) % n};`).join(' ')
  return `PROGRAM Main VAR ${decls} END_VAR ${body} END_PROGRAM`
})()

function build(engine: ScanEngine, src: string): CompiledProgram {
  const was = setScanEngine(engine)
  try {
    return compile(src)
  } finally {
    setScanEngine(was)
  }
}

/** µs per scan: the best of `runs` timed batches, after a warm-up long enough for V8 to optimise the generated code. */
function bestScan(p: CompiledProgram, batch: number): number {
  const t = performance.now()
  for (let i = 0; i < batch; i++) p.scan(0.01)
  return ((performance.now() - t) * 1000) / batch
}

/** How many times faster the typed engine scans `src` than the walker, both run interleaved in this process. */
function speedRatio(src: string, batch = 300, runs = 7): { ratio: number; walker: number; typed: number } {
  const w = build('walker', src)
  const g = build('typed', src)
  for (let i = 0; i < 1500; i++) {
    w.scan(0.01)
    g.scan(0.01)
  }
  let walker = Infinity
  let typed = Infinity
  for (let r = 0; r < runs; r++) {
    walker = Math.min(walker, bestScan(w, batch))
    typed = Math.min(typed, bestScan(g, batch))
  }
  return { ratio: walker / typed, walker, typed }
}

/** The ratio, re-measured once when it reads under `floor`: a real regression is low both times, a load spike on a shared
 *  box almost never is. The higher of the two is what the floor is held to. */
function gatedRatio(name: string, src: string, floor: number, batch: number): number {
  const first = speedRatio(src, batch).ratio
  const ratio = first >= floor ? first : Math.max(first, speedRatio(src, batch).ratio)
  // Printed on every run so CI logs carry the spread the floors are set from; local readings alone are too optimistic.
  // stdout, not console.log: vitest drops a passing test's console output, which is exactly the reading wanted.
  ;(globalThis as { process?: { stdout: { write(s: string): void } } }).process?.stdout.write(`[scanSpeed] ${name} ${ratio.toFixed(1)}x (floor ${floor})\n`)
  return ratio
}

// Each floor sits between the slowest healthy reading and the fastest regressed one, measured six runs each with the
// healthy engine and each regression in one process (scratch copies of src/plc, alternating order), under lockdown:
//   structs 40 - 82x | every store coerced again (`canonical`, `within` off) 22 - 34x
//   calls   8.6 - 14x | a FUNCTION's region reset through initDecls on every call (no starting snapshot) 2.9 - 3.6x
//   long    32 - 59x (slow CI runners 23.9 - 25x) | every store coerced again 12 - 20x, sub-function splitting off 5.2 - 7.6x
//   wide   102 - 172x | every store coerced again 29 - 55x, sub-function splitting off 7.5 - 64x
// Raise a floor with a measurement, as the build budgets are; lowering one means something got slower, which is the
// question this file exists to ask - unless the floor was set from too few readings. The ratio moves with the CPU (a
// slow CI runner overlaps the regressed band a fast laptop reads), so wide's floor of 45 is provisional until the
// logged CI readings ([scanSpeed] lines) give the real spread: it catches splitting, not coercion on a fast machine.
// long's floor of 21 sits under the slow runners' 23.9x and over coercion's 20x.
describe('the typed engine keeps its speed over the walker (a silent regression would otherwise ship green)', () => {
  it('struct traffic across several types: no store coerced that the types already prove', { timeout: 60_000 }, () => {
    expect(gatedRatio('structs', STRUCTS, 38, 300)).toBeGreaterThanOrEqual(38)
  })
  it('calls: a FUNCTION reset from its starting snapshot, builtins dispatched once', { timeout: 60_000 }, () => {
    expect(gatedRatio('calls', CALLS, 6, 150)).toBeGreaterThanOrEqual(6)
  })
  it('a long body: split into sub-functions V8 optimises, no needless coercion', { timeout: 120_000 }, () => {
    expect(gatedRatio('long', LONG, 21, 40)).toBeGreaterThanOrEqual(21)
  })
  it('a POU of 1,400 variables: split into sub-functions, no needless coercion', { timeout: 120_000 }, () => {
    expect(gatedRatio('wide', WIDE, 45, 40)).toBeGreaterThanOrEqual(45)
  })
})
