// The standard function blocks other than the timers (the edges, the counters, the bistables), and the motion kernel,
// over the typed arena: each one a function of its instance's address and its inputs as a call gives them (undefined
// for an input the call leaves out). A standard block keeps each input in its record, so one a call leaves out has
// the value the last call gave it (runtime.ts). They do what runtime.ts's objects do, line for line - those stay the
// walker's, so the oracle compares two implementations of every block (docs/plc-typed-storage.md, "Layout"). Every
// offset comes from the block's layout (layout.ts BLOCKS), so the code and the layout cannot disagree about where a
// field is. The three timers are not here: a body writes them itself (scanWasmCalls.ts timerBlock says why).

import { bool, num, wrap } from '../runtime'
import type { FbType, TagValue } from '../types'
import type { Arena } from './arena'
import { BLOCKS } from './layout'
import { MotionChannel, type MotionOutputs } from '../motionChannel'

type In = TagValue | undefined

const off = (t: FbType, field: string): number => BLOCKS[t].byKey.get(field.toUpperCase())!.off

/** Each block's call, over one arena: what generated code is handed as `blk_R_TRIG`, `blk_CTU`, ... The parameters after
 *  the instance are the block's accepted inputs in runtime.ts FB_INPUTS order, aliases included. */
export function blocksOver(a: Arena, channels: Map<number, MotionChannel>): Record<string, (...args: never[]) => void> {
  const { U8, I16, I32, F64 } = a
  const rt = { q: off('R_TRIG', 'Q'), prev: off('R_TRIG', 'prev') }
  const ft = { q: off('F_TRIG', 'Q'), prev: off('F_TRIG', 'prev') }
  const ctu = { cv: off('CTU', 'CV'), q: off('CTU', 'Q'), prev: off('CTU', 'prev'), r: off('CTU', 'R'), pv: off('CTU', 'PV') }
  const ctd = { cv: off('CTD', 'CV'), q: off('CTD', 'Q'), prev: off('CTD', 'prev'), ld: off('CTD', 'LD'), pv: off('CTD', 'PV') }
  const ctud = { cv: off('CTUD', 'CV'), qu: off('CTUD', 'QU'), qd: off('CTUD', 'QD'), pu: off('CTUD', 'prevU'), pd: off('CTUD', 'prevD'), r: off('CTUD', 'R'), ld: off('CTUD', 'LD'), pv: off('CTUD', 'PV') }
  const sr = { q1: off('SR', 'Q1'), s1: off('SR', 'S1'), r: off('SR', 'R') }
  const rs = { q1: off('RS', 'Q1'), s: off('RS', 'S'), r1: off('RS', 'R1') }
  /** A kept BOOL input at `at`: a given value is stored there first, and the stored value is answered. */
  const keptBool = (at: number, v: In): boolean => {
    if (v !== undefined) U8[at] = bool(v) ? 1 : 0
    return U8[at] !== 0
  }
  /** A kept INT input at `at`, read at INT width as the walker reads it. */
  const keptInt = (at: number, v: In): number => {
    if (v !== undefined) I16[at >> 1] = wrap('INT', num(v))
    return I16[at >> 1]!
  }
  const ak = { cmdId: off('AXIS_KERNEL', 'CMDID'), curCmd: off('AXIS_KERNEL', 'CURCMD'), doneCmd: off('AXIS_KERNEL', 'DONECMD'), qLo: off('AXIS_KERNEL', 'QLO'), qHi: off('AXIS_KERNEL', 'QHI'), state: off('AXIS_KERNEL', 'STATE'), x: off('AXIS_KERNEL', 'X'), vel: off('AXIS_KERNEL', 'VEL'), err: off('AXIS_KERNEL', 'ERR'), powered: off('AXIS_KERNEL', 'POWERED'), homed: off('AXIS_KERNEL', 'HOMED') }
  const mo: MotionOutputs = { cmdId: 0, curCmd: 0, doneCmd: 0, state: 0, x: 0, v: 0, error: 0, qLo: 0, qHi: -1, powered: false, homed: false }

  return {
    blk_R_TRIG(b: number, CLK: In): void {
      const clk = CLK === undefined ? U8[b + rt.prev] !== 0 : bool(CLK)
      U8[b + rt.q] = clk && U8[b + rt.prev] === 0 ? 1 : 0
      U8[b + rt.prev] = clk ? 1 : 0
    },
    blk_F_TRIG(b: number, CLK: In): void {
      const clk = CLK === undefined ? U8[b + ft.prev] !== 0 : bool(CLK)
      U8[b + ft.q] = !clk && U8[b + ft.prev] !== 0 ? 1 : 0
      U8[b + ft.prev] = clk ? 1 : 0
    },
    blk_CTU(b: number, CU: In, R: In, RESET: In, PV: In): void {
      const cu = CU === undefined ? U8[b + ctu.prev] !== 0 : bool(CU)
      const cv = (b + ctu.cv) >> 1
      const pv = keptInt(b + ctu.pv, PV)
      if (keptBool(b + ctu.r, RESET ?? R)) I16[cv] = 0
      else if (cu && U8[b + ctu.prev] === 0 && I16[cv]! < 32767) I16[cv] = I16[cv]! + 1
      U8[b + ctu.prev] = cu ? 1 : 0
      U8[b + ctu.q] = I16[cv]! >= pv ? 1 : 0
    },
    blk_CTD(b: number, CD: In, LD: In, PV: In): void {
      const cd = CD === undefined ? U8[b + ctd.prev] !== 0 : bool(CD)
      const cv = (b + ctd.cv) >> 1
      const pv = keptInt(b + ctd.pv, PV)
      if (keptBool(b + ctd.ld, LD)) I16[cv] = pv
      else if (cd && U8[b + ctd.prev] === 0 && I16[cv]! > 0) I16[cv] = I16[cv]! - 1
      U8[b + ctd.prev] = cd ? 1 : 0
      U8[b + ctd.q] = I16[cv]! <= 0 ? 1 : 0
    },
    blk_CTUD(b: number, CU: In, CD: In, R: In, RESET: In, LD: In, PV: In): void {
      const cu = CU === undefined ? U8[b + ctud.pu] !== 0 : bool(CU)
      const cd = CD === undefined ? U8[b + ctud.pd] !== 0 : bool(CD)
      const pv = keptInt(b + ctud.pv, PV)
      const cv = (b + ctud.cv) >> 1
      // both kept before either acts: a reset still keeps the LD it was given
      const reset = keptBool(b + ctud.r, RESET ?? R)
      const load = keptBool(b + ctud.ld, LD)
      if (reset) I16[cv] = 0
      else if (load) I16[cv] = pv
      else {
        if (cu && U8[b + ctud.pu] === 0 && I16[cv]! < 32767) I16[cv] = I16[cv]! + 1
        if (cd && U8[b + ctud.pd] === 0 && I16[cv]! > -32768) I16[cv] = I16[cv]! - 1
      }
      U8[b + ctud.pu] = cu ? 1 : 0
      U8[b + ctud.pd] = cd ? 1 : 0
      U8[b + ctud.qu] = I16[cv]! >= pv ? 1 : 0
      U8[b + ctud.qd] = I16[cv]! <= 0 ? 1 : 0
    },
    blk_SR(b: number, S1: In, R: In, SET1: In, RESET: In): void {
      const r = keptBool(b + sr.r, R ?? RESET)
      const s1 = keptBool(b + sr.s1, S1 ?? SET1)
      if (r) U8[b + sr.q1] = 0
      if (s1) U8[b + sr.q1] = 1 // set is dominant, so it is applied last
    },
    blk_RS(b: number, S: In, R1: In, SET: In, RESET1: In): void {
      const s = keptBool(b + rs.s, S ?? SET)
      const r1 = keptBool(b + rs.r1, R1 ?? RESET1)
      if (s) U8[b + rs.q1] = 1
      if (r1) U8[b + rs.q1] = 0 // reset is dominant, so it is applied last
    },
    // The motion kernel: its plan lives in a channel per instance, kept in `channels` by the instance's address (stable
    // for the program's life, unique per instance); the record holds its outputs, written after every call. The table
    // is the program's (TypedProgram.motion), which empties it on a restart.
    blk_AXIS_KERNEL(b: number, CMD: In, P: In, V: In, A: In, D: In, BUF: In, LIMITS: In, LIMITPOS: In, LIMITNEG: In, LIMITDEC: In, now: number): void {
      let ch = channels.get(b)
      if (!ch) channels.set(b, (ch = new MotionChannel()))
      ch.call({ cmd: num(CMD ?? 0), p: num(P ?? 0), v: num(V ?? 0), a: num(A ?? 0), d: num(D ?? 0), buffered: bool(BUF ?? false), limits: bool(LIMITS ?? false), limitPos: num(LIMITPOS ?? 0), limitNeg: num(LIMITNEG ?? 0), limitDecel: num(LIMITDEC ?? 0) }, now, mo)
      I32[(b + ak.cmdId) >> 2] = mo.cmdId
      I32[(b + ak.curCmd) >> 2] = mo.curCmd
      I32[(b + ak.doneCmd) >> 2] = mo.doneCmd
      I32[(b + ak.qLo) >> 2] = mo.qLo
      I32[(b + ak.qHi) >> 2] = mo.qHi
      I16[(b + ak.state) >> 1] = mo.state
      F64[(b + ak.x) >> 3] = mo.x
      F64[(b + ak.vel) >> 3] = mo.v
      I16[(b + ak.err) >> 1] = mo.error
      U8[b + ak.powered] = mo.powered ? 1 : 0
      U8[b + ak.homed] = mo.homed ? 1 : 0
    },
  }
}
