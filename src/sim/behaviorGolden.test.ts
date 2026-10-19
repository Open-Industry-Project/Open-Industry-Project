// Golden-trace determinism harness for the custom-part behavior runtime. It lets the per-tick transport change
// (JSON string → object, or later an SoA / typed-array component store) without silently changing what parts
// compute. It pins three properties:
//
//   1. Determinism - the same part + same input sequence yields a bit-identical output trace across runs.
//   2. Transport parity - the object path (stepDirect, what world.ts drives) and the string FFI boundary
//                          (step, for an out-of-process/sandboxed host) emit the same commands every tick.
//   3. Golden hash - the combined trace of representative parts hashes to a pinned value, so any
//                          refactor that changes the output stream fails the test.
//
// This drives the behavior layer directly (no Jolt), so the trace is pure deterministic JS - reproducible
// across machines. Numbers are rounded to 6 dp before hashing to absorb transcendental ulp differences
// across Node/V8 versions while still catching any real behavior change.
import { describe, it, expect } from 'vitest'
import { create, step, stepDirect, destroy } from './embeddedBehavior'
import type { BehaviorInput, BehaviorOutput } from './embeddedBehavior'

const SIM_HZ = 60
const DT = 1 / SIM_HZ
const TICKS = 120

// A deterministic per-tick input - derived purely from the tick index (no Math.random / Date), so the trace
// reproduces exactly. Tags ramp/toggle, position eases along a circle, joint/grip feedback echoes the host.
function inputAt(tick: number): BehaviorInput {
  const t = tick / SIM_HZ
  return {
    simTime: t,
    position: [Math.sin(t) * 0.5, 0, Math.cos(t) * 0.5],
    forward: [1, 0, 0],
    tags: { run: tick % 30 < 20, speed: 1 + (tick % 10) * 0.1, cmd: tick % 17 === 0 },
    joints: { j1: Math.sin(t) * 0.3 },
    grips: { hand: tick % 40 > 20 },
    used: tick % 23 === 0,
  }
}

// Representative parts spanning the ctx facets the runtime moves across the boundary each tick:
// surface velocity, numeric/bool tag I/O, approach(), joints + measured feedback, grips on a rising edge,
// emissive lamps, rng-driven spawn, and the used() interaction pulse.
const PARTS: Record<string, string> = {
  conveyor: `definePart({
    params: { gain: { type: 'number', default: 2 } },
    step(ctx) {
      const target = ctx.readNumber('speed') * ctx.params.gain
      const v = ctx.approach(ctx.readNumber('fb'), target, 5 * ctx.dt)
      ctx.writeNumber('fb', v)
      ctx.setSurfaceVelocity({ x: ctx.readTag('run') ? v : 0, y: 0, z: 0 })
    },
  })`,
  rig: `definePart({
    joints: ['j1', 'j2'], grippers: ['hand'], lamps: ['busy'],
    step(ctx) {
      ctx.joints.j1 = Math.sin(ctx.simTime) * 0.8
      ctx.joints.j2 = ctx.measured.joints.j1 * 0.5
      if (ctx.rising('cmd')) ctx.grips.hand = !ctx.grips.hand
      ctx.lamps.busy = ctx.readTag('run')
      ctx.writeTag('atLimit', ctx.measured.joints.j1 > 0.7)
    },
  })`,
  producer: `definePart({
    step(ctx) {
      if (ctx.used()) ctx.spawn({ size: [0.4 + ctx.rng() * 0.2, 0.4, 0.4] })
      ctx.writeNumber('count', ctx.simTime)
    },
  })`,
}

/** Run a part over the fixed input sequence via the object path, collecting its per-tick output. */
function trace(source: string, ticks = TICKS): BehaviorOutput[] {
  const h = create(source, '{}')
  expect(h).toBeGreaterThan(0)
  const out: BehaviorOutput[] = []
  for (let i = 0; i < ticks; i++) {
    const o = stepDirect(h, inputAt(i), DT)
    expect(o).not.toBeNull()
    out.push(o as BehaviorOutput)
  }
  destroy(h)
  return out
}

// Canonical, key-sorted, 6-dp-rounded JSON so the hash is stable regardless of property order / float ulps.
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (typeof val === 'number') return Number.isFinite(val) ? Math.round(val * 1e6) / 1e6 : String(val)
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const rec = val as Record<string, unknown>
      return Object.fromEntries(Object.keys(rec).sort().map((k) => [k, rec[k]]))
    }
    return val
  })
}

// Two independent FNV-1a passes → a 64-bit (16 hex char) change-detection digest. Pure JS - no node:crypto
// (this codebase carries no @types/node); a cryptographic hash is overkill for a golden, we only need to
// notice when the trace changes.
function hash(v: unknown): string {
  const s = canonical(v)
  let h1 = 0x811c9dc5 >>> 0
  let h2 = 0x12345678 >>> 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x85ebca77) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

describe('behavior trace', () => {
  for (const [name, src] of Object.entries(PARTS)) {
    it(`${name}: identical across two independent runs (deterministic)`, () => {
      expect(trace(src)).toEqual(trace(src))
    })

    it(`${name}: object path (stepDirect) matches the JSON string boundary (step)`, () => {
      const h1 = create(src, '{}')
      const h2 = create(src, '{}')
      for (let i = 0; i < TICKS; i++) {
        const inp = inputAt(i)
        const viaObject = stepDirect(h1, inp, DT)
        const viaString = JSON.parse(step(h2, JSON.stringify(inp), DT)) as BehaviorOutput
        expect(viaString).toEqual(viaObject)
      }
      destroy(h1)
      destroy(h2)
    })
  }

  // Pinned golden: regenerate intentionally with `npx vitest run src/sim/behaviorGolden.test.ts -u` ONLY when
  // a behavior change is expected; an unexpected diff means the transport altered what parts compute.
  //
  // An envelope change alone also moves the hash. The per-tick envelope carries a `values` map (effective param
  // values, from ctx.report) and a `displays` map (readouts from ctx.display), ten output keys in all. None of
  // the parts below call `report` or `display`, so each entry holds `values: {}` and `displays: {}`. When the
  // hash moves for a shape change like that, the determinism and object-vs-string parity cases above are the
  // pair that would catch a real drift in what parts compute.
  it('combined trace hashes to the pinned golden', () => {
    const combined = Object.fromEntries(Object.entries(PARTS).map(([n, s]) => [n, trace(s)]))
    expect(hash(combined)).toMatchInlineSnapshot(`"3b16dee8473a5f71"`)
  })
})
