// Behavior-tick microbenchmark: measures when the behavior layer becomes the bottleneck, so a move to an SoA /
// typed-array component store can be decided from measurements. Run with `npm run bench:behavior`. Not part
// of `npm test` (this is a `.bench.ts`; the test glob is `*.test.ts`).
// The script pins `--reporter=verbose`: in vitest 5 the default reporter prints only pass/fail for benchmarks,
// so a bare `vitest bench` runs the cases and shows no hz at all.
//
// It also compares the same fleet stepped via the object path (`stepDirect`, what world.ts drives) against the
// JSON string path (`JSON.stringify` in + `step` + `JSON.parse` out, per part per tick). The hz gap is the
// per-tick serialization cost the object path avoids.
//
// Reading the result: vitest reports hz = full-fleet ticks per second. ms per sim tick = 1000 / hz. Compare
// that against the sim's frame budget (1000/60 ≈ 16.7 ms) and the Jolt step cost at the same body count to
// see how much headroom the behavior phase has.
import { describe, test } from 'vitest'
import { create, step, stepDirect } from './embeddedBehavior'
import type { BehaviorInput } from './embeddedBehavior'

const DT = 1 / 60

// A mid-complexity part touching the facets that cost the most to serialize: numeric tag I/O, approach(),
// surface velocity, a joint command, and a rising-edge read.
const PART = `definePart({
  params: { gain: { type: 'number', default: 2 } },
  joints: ['j1'],
  step(ctx) {
    const v = ctx.approach(ctx.readNumber('fb'), ctx.readNumber('speed') * ctx.params.gain, 5 * ctx.dt)
    ctx.writeNumber('fb', v)
    ctx.setSurfaceVelocity({ x: ctx.readTag('run') ? v : 0, y: 0, z: 0 })
    ctx.joints.j1 = Math.sin(ctx.simTime)
    if (ctx.rising('cmd')) ctx.writeTag('pulsed', true)
  },
})`

function fleet(n: number): { handles: number[]; input: BehaviorInput } {
  const handles: number[] = []
  for (let i = 0; i < n; i++) handles.push(create(PART, '{}'))
  const input: BehaviorInput = { simTime: 0, position: [0, 0, 0], forward: [1, 0, 0], tags: { run: true, speed: 1.5, cmd: false } }
  return { handles, input }
}

for (const N of [100, 1000]) {
  describe(`behavior tick - ${N} parts`, () => {
    const { handles, input } = fleet(N)
    let t = 0

    // The object path world.ts uses: one struct reused, no JSON per tick.
    // In vitest 5 `bench` is on the test context, not a top-level import, so each case is a
    // test() that awaits one `.run()`.
    test('stepDirect (object path)', async ({ bench }) => {
      await bench('stepDirect (object path)', () => {
        input.simTime = t++ / 60
        for (const h of handles) stepDirect(h, input, DT)
      }).run()
    })

    // The JSON string path (the FFI boundary): stringify in + parse out, per part per tick.
    test('step (JSON string path)', async ({ bench }) => {
      await bench('step (JSON string path)', () => {
        input.simTime = t++ / 60
        for (const h of handles) JSON.parse(step(h, JSON.stringify(input), DT))
      }).run()
    })
  })
}
