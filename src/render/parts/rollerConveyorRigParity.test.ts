import { describe, expect, it } from 'vitest'
import { arrayInstanceDeltas, linkHalfExtents, MAX_DISTRIBUTE_INSTANCES } from '../../core/rig/rigPose'
import type { SeamContext } from '../../core/rig/rigPose'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import type { PartPackage } from '../../core/parts/partPackage'
import { registerPackage } from '../../core/parts/partRegistry'
import { rollerStations } from '../../core/conveyor/rollerGrid'
import { ROLLER_CLASSES } from '../../core/types'
import type { PartInstance } from '../../core/types'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { GeometryContext, MeshPart } from '../../core/parts/partApi'
import { examplePart, type RigGeo } from './examplePart'
const { geometry: ROLLER_CONVEYOR_RIG, behavior: ROLLER_BEHAVIOR } = examplePart<RigGeo>('oip.roller-conveyor')

// The Roller Conveyor is a `custom` part, so the shared snap-grid engine (rollerStations, in core/conveyor/rollerGrid)
// drives its world-phase rollers off the registered package. Register it so rollerStations can resolve the
// rig's worldPhase array. That is the second production grid path, which this file cross-checks against the
// rig-array path (arrayInstanceDeltas).
registerPackage({
  format: PACKAGE_FORMAT,
  id: 'oip.roller-conveyor',
  name: 'Roller Conveyor',
  conveyor: { bed: 'straight', surface: 'roller' },
  params: {
    length: { type: 'number', default: 3, handle: { kind: 'face', axis: 'x' } },
    width: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'z' } },
  },
  behavior: 'definePart({ step(ctx){ ctx.setSurfaceVelocity({x:1,y:0,z:0}) } })',
  geometry: ROLLER_CONVEYOR_RIG,
} as unknown as PartPackage)

// The Roller Conveyor is a custom part (examples/parts/roller-conveyor). This pins the rig: a conveying deck is
// the surface, the side frames collide, and the part's own geometry() draws the rollers (examples/parts/_shared/rollerBed.js) on the stations of a world-phased pitch grid
// that a draw-free 'roller' frame link declares and the host resolves across butted beds.

const geo = ROLLER_CONVEYOR_RIG
const link = (name: string) => geo.links.find((l) => l.name === name)!
const draw = (params: Record<string, unknown>, ctx?: GeometryContext): MeshPart[] => {
  const parts = evalPartGeometry(ROLLER_BEHAVIOR, params as never, undefined, ctx)
  if (!parts) throw new Error('roller conveyor geometry() returned no parts')
  return parts
}
const ROLLER_TEMPLATE_BODY = 2 * 0.9371 // the kit's tube, rim to rim, in its native units
// the roller layout read back off the tube bank (the kit emits the tubes first, then the stubs, then the bands)
const layout = (params: Record<string, unknown>, ctx?: GeometryContext): { x: number; z: number; yaw: number; length: number }[] =>
  draw(params, ctx).find((p) => p.finish === 'roller' && p.instances)!.instances!.map((i) => ({ x: i.position[0], z: i.position[2], yaw: 2 * Math.atan2(i.quaternion![1], i.quaternion![3]), length: i.scale![2] * ROLLER_TEMPLATE_BODY }))
// the seam strip: the only sheet steel a roller bed draws
const plates = (parts: MeshPart[]): MeshPart[] => parts.filter((p) => p.finish === 'gapfill')
// a skewed bed's end frames are two banks in the frame's finish: boxes (the cross members) and wedges (the
// housings that hold the cut rollers on them). A wedge is 5 triangles, a box 12.
const isWedge = (p: MeshPart): boolean => p.desc.positions.length === 5 * 3 * 3
const gapPlates = (parts: MeshPart[]): MeshPart[] => parts.filter((p) => p.finish === 'frame' && !!p.instances && isWedge(p))

describe('Roller Conveyor custom-part rig - C-convey + part-drawn decorative rollers', () => {
  it('is a structurally valid package (rig + the conveying behavior)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.roller-conveyor', name: 'Roller Conveyor', params: {}, behavior: 'definePart({ step(ctx){ ctx.setSurfaceVelocity({x:1,y:0,z:0}) } })', geometry: geo })).toEqual([])
  })

  it('the deck is the conveying surface, length/width-parametric', () => {
    const deck = link('deck')
    expect(deck.conveys).toBe(true)
    expect(deck.shape.kind).toBe('box')
    // its top is at the part origin (offset −0.02 + half-height 0.02), level with the roller tops
    expect(deck.offset[1]).toBeCloseTo(-0.02, 6)
    expect(deck.shape.kind === 'box' && deck.shape.sizeParams?.map((s) => s.param)).toEqual(['length', 'width'])
  })

  it('the rollers sit on a distribute grid, world-phased, declared by a draw-free frame link', () => {
    const roller = link('roller')
    expect(roller.shape.kind).toBe('frame') // transform-only: it draws nothing and has no body
    // spread along the length, locked to the world pitch grid so butted beds align (docs/seam-resolvers.md)
    expect(roller.array?.distribute).toMatchObject({ axis: 0, spanParam: 'length', worldPhase: true })
    // the roller's axle-length tracks `width`, with a small inset
    for (const width of [0.6, 1.524, 2.5]) for (const r of layout({ length: 3, width })) expect(r.length).toBeCloseTo(width - 0.004, 6)
  })

  it('a roller is decorative - render-only, no collision body (the deck is the real surface)', () => {
    // the frame builds no collision proxy at any width (coplanar roller bodies would fight the deck)
    expect(linkHalfExtents(link('roller'), { width: 1.0 })).toEqual([0, 0, 0])
    expect(linkHalfExtents(link('roller'), { width: 2.0 })).toEqual([0, 0, 0])
    for (const p of draw({ length: 3, width: 1 })) expect(p.collision).toBeUndefined()
  })

  it('the L-rail side frames collide (keep cargo on the bed) and are length-parametric', () => {
    for (const n of ['wallL', 'wallR']) {
      const f = link(n)
      expect(f.collision).not.toBe('none') // a real collision body
      expect(f.shape.kind === 'box' && f.shape.sizeParams?.[0]?.param).toBe('length')
    }
  })

  // Skew and everything else about a roller is in the part's geometry(), not an engine hook: the tubes, two axle
  // stubs per roller, and the drive bands. All hang on the 'roller' link so they follow the incline, and the tubes
  // and stubs spin with the reported roller speed. The deck and side frames/guards are not laid out with the
  // rollers (the bed stays a rectangle; only the rollers angle).
  it('geometry() draws the whole bed on the roller link: spinning tubes + axle stubs, and static drive bands', () => {
    const parts = draw({ length: 3, width: 1.524 })
    for (const p of parts) expect(p.link).toBe('roller')
    const [tubes, stubs] = parts.filter((p) => p.finish === 'roller')
    expect(tubes!.spin).toEqual({ axis: [0, 0, -1], radius: ROLLER_CLASSES.light.radius }) // turns on 'speed', reported or the param
    expect(stubs!.spin).toEqual(tubes!.spin)
    expect(stubs!.instances!.length).toBe(2 * tubes!.instances!.length)
    const bands = parts.filter((p) => p.material === 'band')
    expect(bands).toHaveLength(2) // half-rings + strands
    for (const b of bands) expect(b.spin).toBeUndefined() // an even band looks the same moving or still
    expect(geo.links.find((l) => l.name === 'stubL')).toBeUndefined()
    expect(geo.links.find((l) => l.name === 'stubR')).toBeUndefined()
    expect(ROLLER_BEHAVIOR).toContain("if (fpm) ctx.report('speed', s)") // m/s in the fpm unit mode too
  })

  it('stays a structurally valid package (rig with a draw-free grid link)', () => {
    expect(validatePartPackage({
      format: PACKAGE_FORMAT, id: 'oip.roller-conveyor', name: 'Roller Conveyor',
      params: { skew: { type: 'number', default: 0 } },
      behavior: 'definePart({ params: { skew: { type: "number", default: 0 } }, step(ctx){ ctx.setSurfaceVelocity({x:1,y:0,z:0}) } })',
      geometry: geo,
    })).toEqual([])
  })
})

// The part's geometry() authors the skew roller clip (docs/sdk-geometry-flexibility.md). The host resolves the
// (world-phased) grid deltas and the part shapes each roller. Feed it deltas and pin: straight → a full-length
// un-rotated roller at every delta; skewed → full-length rollers turned to the skew, none past a bed end.
describe('Roller Conveyor roller layout - skew clip authored in the part (SDK-expressed, not engine-coded)', () => {
  const AXLE = 1.524 - 0.004 // width − the roller shape's sizeParams add
  const grid = (n: number): [number, number, number][] => Array.from({ length: n }, (_, i) => [(-n / 2 + i) * 0.075, 0, 0])

  it('straight bed (skew 0): a full-length, un-rotated roller at every grid delta', () => {
    const deltas = grid(20)
    const insts = layout({ length: 4, width: 1.524, skew: 0 }, { deltas, pitch: 0.075 })
    expect(insts.length).toBe(deltas.length)
    insts.forEach((it, i) => { expect(it.x).toBeCloseTo(deltas[i]![0], 9); expect(it.yaw).toBe(0); expect(it.z).toBe(0); expect(it.length).toBeCloseTo(AXLE, 6) })
  })

  it('skewed bed (skew 10): full rollers wall to wall, and shorter ones filling the gap at each end', () => {
    const rad = (10 * Math.PI) / 180
    const full = AXLE / Math.cos(rad)
    const deltas = grid(52)
    const skewed = layout({ length: 4, width: 1.524, skew: 10 }, { deltas, pitch: 0.075 })
    expect(skewed.filter((it) => Math.abs(it.length - full) < 1e-6).length).toBeGreaterThan(40)
    const short = skewed.filter((it) => it.length < full - 1e-6)
    expect(short.length).toBeGreaterThan(4) // a 0.27 m gap an end at this skew, on a 0.075 m pitch
    for (const it of skewed) {
      expect(it.yaw).toBeCloseTo(rad, 6)
      expect(it.length).toBeLessThanOrEqual(full + 1e-6)
      expect(it.length).toBeGreaterThanOrEqual(0.1) // nothing shorter is drawn
      // neither end of any roller reaches the cross member at a bed end (20 mm thick)
      expect(Math.abs(it.x) + (it.length / 2) * Math.sin(rad) + 0.024 * Math.cos(rad)).toBeLessThan(2 - 0.02)
    }
    // the short ones sit on the same pitch as the rest, carried past the grid the host resolved
    const centreLine = skewed.map((it) => it.x - it.z * Math.tan(rad))
    for (let i = 1; i < centreLine.length; i++) expect(centreLine[i]! - centreLine[i - 1]!).toBeCloseTo(0.075, 9)
    expect(centreLine[centreLine.length - 1]!).toBeGreaterThan(deltas[deltas.length - 1]![0])
    // the head's short rollers are on the side cargo drifts to (-Z for +skew), the tail's on the other
    for (const it of short) expect(it.x > 0 ? it.z : -it.z).toBeLessThan(0)
  })

  // A short roller has one end out in the bed, at the cross member the part draws across each end of a skewed bed.
  it('skewed bed: a cross member across each end, none on a straight bed', () => {
    const frames = (params: Record<string, unknown>): MeshPart[] => draw(params).filter((p) => p.finish === 'frame' && !isWedge(p))
    expect(frames({ length: 4, width: 1.524, skew: 0 })).toHaveLength(0)
    const bank = frames({ length: 4, width: 1.524, skew: 10 })
    expect(bank).toHaveLength(1)
    expect(bank[0]!.link).toBe('roller') // rides the incline with the rollers
    const bars = bank[0]!.instances!
    expect(bars).toHaveLength(2)
    // full width, at the two bed ends, top under the roller tops (R above the link's datum)
    for (const b of bars) {
      expect(Math.abs(b.position[0])).toBeCloseTo(2 - 0.01, 9)
      expect(b.scale![2]).toBeCloseTo(1.524, 9)
      expect(b.position[1] + b.scale![1] / 2).toBeLessThan(0.024)
    }
  })

  it('with no grid (a headless call) it lays a centred one at the same pitch, so the bed still draws', () => {
    const insts = layout({ length: 3, width: 1 })
    expect(insts.length).toBeGreaterThan(30)
    expect(insts[1]!.x - insts[0]!.x).toBeCloseTo(0.075, 9)
    expect(insts[0]!.x + insts[insts.length - 1]!.x).toBeCloseTo(0, 9)
  })
})

// Seam parity (docs/seam-resolvers.md, step 2): the rollers distribute with `worldPhase`, so the SDK bed places
// rollers on the same absolute world pitch grid as the built-in roller conveyor (its anchor-null grid). A butt
// join between two beds, or between an SDK bed and a built-in bed, then looks like one continuous run.
describe('Roller Conveyor rig - world-phase seam parity with the built-in grid', () => {
  const { pitch: PITCH } = ROLLER_CLASSES.light
  const rollerArray = link('roller').array!
  expect(rollerArray.distribute?.worldPhase).toBe(true) // the shipped part opts into world-phase

  // SDK world +X stations of the roller copies for a bed centred at world x=`centreX`, rotationY 0, length L.
  const sdkStations = (centreX: number, length: number): number[] => {
    const seam: SeamContext = { worldPos: [centreX, 0, 0], worldRotY: 0 }
    return arrayInstanceDeltas(rollerArray, { length }, seam).map((d) => centreX + d[0])
  }
  // The same placement resolved through the shared snap-grid engine (rollerStations): a centre-origin SDK roller
  // bed centred at world x=`centreX`. rollerStations returns part-local offsets, mapped back to world x.
  const gridEngine = (id: string, centreX: number, length: number): PartInstance =>
    ({
      id, type: 'part', packageId: 'oip.roller-conveyor', position: [centreX, 0.75, 0], rotationY: 0,
      params: { length, width: 0.6 },
    } as unknown as PartInstance)
  const builtinStations = (centreX: number, length: number): number[] =>
    rollerStations(gridEngine('b', centreX, length)).map((o) => o + centreX)
  const fposmod = (a: number, b: number): number => ((a % b) + b) % b

  it('drops every roller on the world pitch grid through the origin - the built-in anchor-null invariant', () => {
    for (const s of [...sdkStations(0, 3), ...sdkStations(1.5, 3), ...sdkStations(4.213, 2)]) {
      const r = fposmod(s, PITCH)
      expect(Math.min(r, PITCH - r)).toBeLessThan(1e-6)
    }
  })

  it('covers the same world grid lines as the built-in over a shared physical bed (interior, past both edge nudges)', () => {
    const L = 3
    const centreX = 1.5 // SDK bed centred here → world span [0, 3]; built-in tail at 0 → same span
    // map each station to its world grid index and keep the strict interior (≥ one pitch off either end), so the
    // built-in's edge-roller nudge (and FP at the boundary) can't skew the comparison. The grids must coincide.
    const margin = 1.5 * PITCH // clear of both edge-nudge zones and any FP wobble at the exact boundary index
    const gridIdx = (xs: number[]): number[] =>
      [...new Set(xs.filter((x) => x > margin && x < L - margin).map((x) => Math.round(x / PITCH)))].sort((a, b) => a - b)
    expect(gridIdx(sdkStations(centreX, L))).toEqual(gridIdx(builtinStations(centreX, L)))
  })

  it('two collinear SDK beds butting form one continuous grid (constant seam gap = pitch)', () => {
    const all = [...sdkStations(1.5, 3), ...sdkStations(4.5, 3)].sort((a, b) => a - b) // beds butt at world x=3
    const uniq = all.filter((v, i) => i === 0 || Math.abs(v - all[i - 1]!) > 1e-6)
    for (let i = 1; i < uniq.length; i++) expect(uniq[i]! - uniq[i - 1]!).toBeCloseTo(PITCH, 9)
  })

  // Long-bed parity: the SDK bed must place a roller on every world grid line across its full length, like the
  // built-in instanced roller bed (which has no instance cap). A 40 m bed is ~533 rollers at the 0.075 m pitch,
  // far past a 256-instance cap, which would truncate the bed at ~19.2 m (rollers/stubs vanish).
  it('places rollers across the full length of a long bed (no 256-instance truncation), matching the built-in', () => {
    const L = 40
    const sdk = sdkStations(L / 2, L).length
    const builtin = builtinStations(L / 2, L).length
    expect(sdk).toBeGreaterThan(256) // a flat 256 cap would stop the bed at ~19.2 m
    expect(Math.abs(sdk - builtin)).toBeLessThanOrEqual(2) // parity with the uncapped built-in grid
  })

  // The higher ceiling is still a real bound: a pathological length (more grid lines than the ceiling can hold)
  // clamps at MAX_DISTRIBUTE_INSTANCES instead of allocating without limit.
  it('still clamps a pathological length at the distribute ceiling', () => {
    const L = MAX_DISTRIBUTE_INSTANCES * PITCH * 1.5 // ~1.5× more grid lines than the ceiling allows
    expect(sdkStations(L / 2, L).length).toBe(MAX_DISTRIBUTE_INSTANCES)
  })
})

// A skewed bed fills its end gaps with rollers, not plate. The one piece of sheet steel is the seam strip at a butted end,
// authored by the part's own geometry() as a render-only surface() MeshPart (docs/sdk-geometry-flexibility.md).
describe('Roller Conveyor geometry() - a skewed bed draws no plate in its end gap, and a seam strip at a butt', () => {
  const R = 0.024 // ROLLER_CLASSES.light.radius - the strip is authored in the roller-group frame (group sits R below the deck)

  // What holds a cut roller's end: one solid wedge of frame steel. Its square corner is at the far edge of the
  // roller's end face. One leg lies against the end face, square to the axle. The other runs on along the roller's
  // far side. Both reach the cross member, so the wedge's long side lies on it. One more wedge fills the tip of the
  // gap, where a roller would be under 0.1 m.
  it('a skewed bed has a housing at each cut roller\'s end and in the tip of each end gap, a straight bed none', () => {
    expect(gapPlates(draw({ length: 4, width: 1.524, skew: 0 }))).toHaveLength(0)
    for (const deg of [5, 10, 20, -10]) {
      const rad = (deg * Math.PI) / 180
      const full = (1.524 - 0.004) / Math.cos(rad)
      for (const shift of [0, 0.02, 0.05]) {
        const deltas: [number, number, number][] = []
        for (let x = -1.97 + shift; x <= 1.976; x += 0.075) deltas.push([x, 0, 0])
        const ctx = { deltas, pitch: 0.075 }
        const short = layout({ length: 4, width: 1.524, skew: deg }, ctx).filter((r) => r.length < full - 1e-6)
        const found = gapPlates(draw({ length: 4, width: 1.524, skew: deg }, ctx))
        expect(found).toHaveLength(1)
        expect(found[0]!.link).toBe('roller')
        const bank = found[0]!.instances!
        // one per cut roller (less one an end where the cut is right at the far side frame), and up to one more
        // at each end for the tip
        expect(bank.length).toBeGreaterThanOrEqual(short.length - 2)
        expect(bank.length).toBeLessThanOrEqual(short.length + 2)
        const bar = 2 - 0.02 // the cross member's inner face
        for (const b of bank) {
          const [x, y, z] = b.position
          const [sx, sy, sz] = b.scale!
          expect(sx).toBeGreaterThan(0) // turned into place, never mirrored (a mirrored wedge is lit from below)
          expect(sz).toBeGreaterThan(0)
          expect(y).toBeCloseTo(0.024 - 0.004, 9) // top a little under the roller tops, like the side frames
          expect(sy).toBeGreaterThan(2 * 0.024) // as deep as the roller
          // the wedge's two legs in the bed's frame: its own +X and +Z, turned by the instance's yaw
          const yaw = 2 * Math.atan2(b.quaternion![1], b.quaternion![3])
          const legs = [[Math.cos(yaw) * sx, -Math.sin(yaw) * sx], [Math.sin(yaw) * sz, Math.cos(yaw) * sz]] as const
          // one leg is square to the axle (the end face), the other along it, whichever way round
          const axle = [Math.sin(rad), Math.cos(rad)]
          const dots = legs.map((l) => Math.abs(l[0] * axle[0]! + l[1] * axle[1]!) / Math.hypot(l[0], l[1]))
          expect(Math.min(...dots)).toBeCloseTo(0, 6)
          expect(Math.max(...dots)).toBeCloseTo(1, 6)
          expect(Math.abs(x)).toBeLessThan(bar) // the square corner is in the bed
          expect(Math.abs(z)).toBeLessThanOrEqual(0.762 + 1e-9)
          for (const l of legs) {
            const ex = x + l[0], ez = z + l[1]
            expect(Math.abs(ex)).toBeLessThanOrEqual(bar + 1e-9) // neither leg passes the cross member's inner face
            expect(Math.abs(ez)).toBeLessThanOrEqual(0.762 + 1e-6) // or a side frame
            // each leg ends on the cross member, or on a side frame where that comes first
            expect(Math.min(bar - Math.abs(ex), 0.762 - Math.abs(ez))).toBeLessThan(1e-6)
          }
        }
      }
    }
  })

  it('emits no seam strip on a straight bed, or on a skewed bed with no neighbour', () => {
    expect(plates(draw({ length: 4, width: 1.524, skew: 0 }))).toHaveLength(0)
    expect(plates(draw({ length: 4, width: 1.524, skew: 10 }))).toHaveLength(0)
    expect(plates(draw({ length: 0.5, width: 1.524, skew: 20 }))).toHaveLength(0)
  })

  // The seam strip (GeometryContext). Two butted beds share one world pitch grid, so the neighbour's first roller
  // is on the next grid line past this bed's end. A skewed bed ends in its cross member, not a roller, so the
  // strip carries the seam out to that roller's face. Gated on `butt` (a free end has nothing to meet) and bounded
  // by R (so it never overlaps a roller that straddles the seam). e2e/verify-skew-transfer-seam.mjs sweeps this
  // through a whole pitch on the rendered bed; these pin the part's own arithmetic.
  describe('seam strip across a butt', () => {
    const PITCH = 0.075
    const P = { length: 4, width: 1.524, skew: 15 }
    const HEAD = 2 // length/2
    /** grid whose last line sits `gap` short of the head (so the next line, the neighbour's first roller, is
     *  at head − gap + pitch), and whose first line mirrors it at the tail */
    const gridEndingShortOf = (gap: number): { deltas: [number, number, number][]; pitch: number } => {
      const deltas: [number, number, number][] = []
      for (let x = HEAD - gap; x >= -HEAD; x -= PITCH) deltas.unshift([x, 0, 0])
      return { deltas, pitch: PITCH }
    }
    const maxX = (parts: ReturnType<typeof evalPartGeometry>): number => {
      const pos = plates(parts!)[0]?.desc.positions ?? []
      let m = HEAD // no strip: the bed ends at its frame
      for (let i = 0; i < pos.length; i += 3) m = Math.max(m, pos[i]!)
      return m
    }

    it('the strip is render-only, double-sided gapfill on the roller link, from the bed end outward', () => {
      const found = plates(draw(P, { ...gridEndingShortOf(0.001), butt: { head: true, tail: false } }))
      expect(found).toHaveLength(1)
      const strip = found[0]!
      expect(strip.link).toBe('roller') // rides the roller group → inclines with the bed
      expect(strip.castShadow).toBe(false)
      expect(strip.doubleSided).toBe(true)
      const pos = strip.desc.positions
      for (let i = 0; i < pos.length; i += 3) {
        expect(pos[i]!).toBeGreaterThanOrEqual(HEAD - 1e-9)
        expect(Math.abs(pos[i + 2]!)).toBeLessThanOrEqual(0.762 + 1e-9)
        expect(pos[i + 1]!).toBeLessThanOrEqual(R + 0.001 + 1e-9)
      }
    })

    it('no ctx at all (headless / parity call) ⇒ no strip', () => {
      expect(plates(evalPartGeometry(ROLLER_BEHAVIOR, P)!)).toHaveLength(0)
    })

    it('a free end grows no lip even with the grid resolved', () => {
      const g = gridEndingShortOf(0.001) // the phase that would otherwise lap the full R
      expect(maxX(evalPartGeometry(ROLLER_BEHAVIOR, P, undefined, { ...g, butt: { head: false, tail: false } }))).toBeCloseTo(HEAD, 9)
    })

    it('a butted end laps to the neighbour roller face, capped at the roller radius', () => {
      // next grid line = head − gap + pitch; the neighbour roller's near face is R before it
      for (const gap of [0.001, 0.02, 0.04, 0.06, 0.074]) {
        const face = HEAD - gap + PITCH - R
        const want = Math.min(HEAD + R, Math.max(HEAD, face)) // lap to the face, bounded by R, never negative
        const got = maxX(evalPartGeometry(ROLLER_BEHAVIOR, P, undefined, { ...gridEndingShortOf(gap), butt: { head: true, tail: false } }))
        expect(got).toBeCloseTo(want, 9)
        expect(got).toBeLessThanOrEqual(Math.max(HEAD, face) + 1e-9) // never on top of that roller
      }
    })

    it('the strip is 4 triangles per lapped end, and only where it laps', () => {
      const tris = (parts: ReturnType<typeof evalPartGeometry>): number => (plates(parts!)[0]?.desc.positions.length ?? 0) / 9
      const g = gridEndingShortOf(0.001)
      expect(tris(evalPartGeometry(ROLLER_BEHAVIOR, P, undefined, { ...g, butt: { head: false, tail: false } }))).toBe(0)
      expect(tris(evalPartGeometry(ROLLER_BEHAVIOR, P, undefined, { ...g, butt: { head: true, tail: false } }))).toBe(4)
      expect(tris(evalPartGeometry(ROLLER_BEHAVIOR, P, undefined, { ...g, butt: { head: true, tail: true } }))).toBe(8)
    })

    it('a straight bed still emits no plate, butt or no butt', () => {
      const g = gridEndingShortOf(0.001)
      expect(plates(draw({ ...P, skew: 0 }, { ...g, butt: { head: true, tail: true } }))).toHaveLength(0)
    })
  })
})
