import { describe, expect, it } from 'vitest'
import { arrayInstanceDeltas, jointLimits, legFrameDepth, linkHalfExtents, qApply, qFromAxisAngle, resolvedBoxSize, resolvedGrabReach, resolvedGrabZone, resolvedMeshScale, resolvedOffset, rigLinkLocalPoseInto, rigLocalPose, rigWorldPoses } from './rigPose'
import type { SeamContext } from './rigPose'
import type { PartPackage, RigJoint, RigLink } from '../parts/partPackage'

type RigGeometry = Extract<PartPackage['geometry'], { kind: 'rig' }>

// a leg row's frame depth: the static number, or a param (a bed whose frame depth is authored)
describe('legFrameDepth', () => {
  it('tracks frameDepthParam (value * scale + add), else the static frameDepth stands', () => {
    const leg = { frameDepth: 0.175, frameDepthParam: { param: 'frameHeight', add: 0.005 } }
    expect(legFrameDepth(leg, { frameHeight: 0.3 })).toBeCloseTo(0.305, 12)
    expect(legFrameDepth(leg, {})).toBe(0.175)
    expect(legFrameDepth(leg, { frameHeight: 'deep' })).toBe(0.175)
    expect(legFrameDepth({ frameDepth: 0.2 }, { frameHeight: 0.3 })).toBe(0.2)
  })
})

// C-paramgeo: a box link's size axis can track an instance param (width/length reshaping the rig).
describe('param-driven box size resolution', () => {
  it('resolves a param-driven axis (value * scale + add), leaving others static', () => {
    expect(resolvedBoxSize([0.05, 0.3, 0.5], [{ axis: 2, param: 'width' }], { width: 0.8 })).toEqual([0.05, 0.3, 0.8])
    expect(resolvedBoxSize([0.05, 0.3, 0.5], [{ axis: 2, param: 'width', scale: 0.5, add: 0.1 }], { width: 0.8 })).toEqual([0.05, 0.3, 0.5])
  })

  it('falls back to the static axis when the param is missing, non-numeric, or non-positive', () => {
    expect(resolvedBoxSize([0.05, 0.3, 0.5], [{ axis: 2, param: 'width' }], {})).toEqual([0.05, 0.3, 0.5])
    expect(resolvedBoxSize([0.05, 0.3, 0.5], [{ axis: 2, param: 'width' }], { width: 'big' })).toEqual([0.05, 0.3, 0.5])
    expect(resolvedBoxSize([0.05, 0.3, 0.5], [{ axis: 2, param: 'width' }], { width: -1 })).toEqual([0.05, 0.3, 0.5])
  })

  it('linkHalfExtents resolves a box link with sizeParams; a plain link uses the static size', () => {
    const blade: RigLink = { name: 'blade', shape: { kind: 'box', size: [0.05, 0.3, 0.5], sizeParams: [{ axis: 2, param: 'width' }] }, offset: [0, 0, 0] }
    expect(linkHalfExtents(blade, { width: 0.8 })).toEqual([0.025, 0.15, 0.4])
    const plain: RigLink = { name: 'b', shape: { kind: 'box', size: [0.2, 0.2, 0.2] }, offset: [0, 0, 0] }
    expect(linkHalfExtents(plain, { width: 0.8 })).toEqual([0.1, 0.1, 0.1])
  })

  // node scaling: a mesh node's axis stretches by a param-driven multiplier (a GLB section growing with width).
  it('resolvedMeshScale stretches one axis by a param factor, leaving others 1', () => {
    expect(resolvedMeshScale([{ axis: 2, param: 'width', scale: 2 }], { width: 0.5 })).toEqual([1, 1, 1]) // factor 1 at default
    expect(resolvedMeshScale([{ axis: 2, param: 'width', scale: 2 }], { width: 1.0 })).toEqual([1, 1, 2]) // twice as wide
    expect(resolvedMeshScale(undefined, { width: 1 })).toEqual([1, 1, 1])
  })

  it('resolvedMeshScale falls back to 1 for a missing / non-numeric / non-positive factor', () => {
    expect(resolvedMeshScale([{ axis: 0, param: 'width' }], {})).toEqual([1, 1, 1])
    expect(resolvedMeshScale([{ axis: 0, param: 'width' }], { width: 'big' })).toEqual([1, 1, 1])
    expect(resolvedMeshScale([{ axis: 0, param: 'width', scale: 1, add: -2 }], { width: 1 })).toEqual([1, 1, 1]) // factor -1 → fallback
  })

  it('linkHalfExtents stretches a mesh collider by its node-scale factor (sim tracks the reshaped node)', () => {
    const mid: RigLink = { name: 'mid', shape: { kind: 'mesh', asset: 'glb', sizeParams: [{ axis: 2, param: 'width', scale: 2 }] }, collision: { box: [0.1, 0.4, 1] }, offset: [0, 0, 0] }
    expect(linkHalfExtents(mid, { width: 0.5 })).toEqual([0.05, 0.2, 0.5]) // factor 1 → static half-extents
    expect(linkHalfExtents(mid, { width: 1.0 })).toEqual([0.05, 0.2, 1]) // z collider doubled with width
    // a visual-only mesh node (no collision) still has no body even with sizeParams
    const vis: RigLink = { name: 'v', shape: { kind: 'mesh', asset: 'glb', sizeParams: [{ axis: 2, param: 'width' }] }, offset: [0, 0, 0] }
    expect(linkHalfExtents(vis, { width: 2 })).toEqual([0, 0, 0])
  })

  it('resolvedOffset drives an axis (any sign) and falls back when the param is missing', () => {
    expect(resolvedOffset([0, 0, 0], [{ axis: 0, param: 'length', scale: -0.5 }], { length: 1.4 })).toEqual([-0.7, 0, 0])
    expect(resolvedOffset([0.1, 0, 0], [{ axis: 0, param: 'length', scale: 0.5, add: 0.05 }], { length: 1 })).toEqual([0.55, 0, 0])
    expect(resolvedOffset([0.1, 0, 0], [{ axis: 0, param: 'length' }], {})).toEqual([0.1, 0, 0])
  })

  // C-paramgeo min/max: a floor/ceiling the linear map can't express (the Blade Stop's cornerZ clamp - end
  // nodes stop at the centreline and the middle collapses instead of inverting on a very narrow lane).
  it('clamps a resolved value to the entry min/max (offset, mesh factor, box size)', () => {
    const corner = [{ axis: 2 as const, param: 'width', scale: 0.5, add: -0.09, min: 0.0045 }]
    expect(resolvedOffset([0, 0, 0.16], corner, { width: 0.5 })).toEqual([0, 0, 0.16])
    expect(resolvedOffset([0, 0, 0.16], corner, { width: 0.1 })).toEqual([0, 0, 0.0045]) // floored, not −0.04
    const mirror = [{ axis: 2 as const, param: 'width', scale: -0.5, add: 0.09, max: -0.0045 }]
    expect(resolvedOffset([0, 0, -0.16], mirror, { width: 0.1 })).toEqual([0, 0, -0.0045]) // ceiling on the −Z side
    expect(resolvedMeshScale([{ axis: 2, param: 'width', scale: 2, add: -0.2, min: 0.01 }], { width: 0.05 })).toEqual([1, 1, 0.01])
    expect(resolvedBoxSize([0.1, 0.1, 0.5], [{ axis: 2, param: 'width', max: 0.4 }], { width: 0.8 })).toEqual([0.1, 0.1, 0.4])
  })

  // C-paramgeo mulParam: a param product the single linear map can't express. The chain transfer's deck
  // width = chains × distance, so a lane-spacing edit (or an adopted host pitch) resizes the bed.
  it('mulParam multiplies a second param in before scale/add (param product)', () => {
    const deckZ = [{ axis: 2 as const, param: 'chains', mulParam: 'distance' }]
    expect(resolvedBoxSize([2, 0.06, 1.65], deckZ, { chains: 5, distance: 0.33 })).toEqual([2, 0.06, 5 * 0.33])
    expect(resolvedBoxSize([2, 0.06, 1.65], deckZ, { chains: 4, distance: 0.5 })).toEqual([2, 0.06, 2])
    // scale/add apply after the product
    expect(resolvedOffset([0, 0, 0], [{ axis: 2, param: 'chains', mulParam: 'distance', scale: 0.5, add: 0.1 }], { chains: 4, distance: 0.5 })).toEqual([0, 0, 1.1])
  })

  it('mulParam missing/non-numeric skips the entry (the static axis stands)', () => {
    const deckZ = [{ axis: 2 as const, param: 'chains', mulParam: 'distance' }]
    expect(resolvedBoxSize([2, 0.06, 1.65], deckZ, { chains: 5 })).toEqual([2, 0.06, 1.65])
    expect(resolvedBoxSize([2, 0.06, 1.65], deckZ, { chains: 5, distance: 'wide' })).toEqual([2, 0.06, 1.65])
  })

  it('rigWorldPoses resolves a param-driven hinge offset through a revolute joint', () => {
    // a hinge frame at -length/2 with a leaf child at +length/2 (so the leaf centres at the part origin when
    // closed); a 90° swing pivots the leaf about the hinge.
    const gate: RigGeometry = {
      kind: 'rig',
      links: [
        { name: 'hinge', shape: { kind: 'frame' }, offset: [0, 0, 0], offsetParams: [{ axis: 0, param: 'length', scale: -0.5 }] },
        { name: 'leaf', parent: 'hinge', shape: { kind: 'box', size: [0.9, 2, 0.06] }, offset: [0, 1, 0], offsetParams: [{ axis: 0, param: 'length', scale: 0.5 }] },
      ],
      joints: [{ name: 'swing', link: 'hinge', type: 'revolute', axis: [0, 1, 0], min: -3.15, max: 3.15 }],
    }
    const params = { length: 1.4 }
    // closed: hinge at x=-0.7, leaf at hinge + 0.7 → x=0 (centred), y=1
    const closed = rigWorldPoses(gate, { swing: 0 }, undefined, 1, params)
    expect(closed.get('hinge')!.pos[0]).toBeCloseTo(-0.7, 9)
    expect(closed.get('leaf')!.pos[0]).toBeCloseTo(0, 9)
    expect(closed.get('leaf')!.pos[1]).toBeCloseTo(1, 9)
    // open 90° about +Y: the +0.7 leaf offset (local +X) rotates to local −Z → leaf at x=-0.7, z=-0.7
    const open = rigWorldPoses(gate, { swing: Math.PI / 2 }, undefined, 1, params)
    expect(open.get('leaf')!.pos[0]).toBeCloseTo(-0.7, 6)
    expect(open.get('leaf')!.pos[2]).toBeCloseTo(-0.7, 6)
  })

  it('inclineRad tilts non-leg links about the root (+X head lifts) but leaves leg links flat', () => {
    // a center-origin conveying bed (deck at origin, head sample link at +1) over a trestle leg link - the
    // roller-conveyor incline shape. inclineRad tilts the bed about the rig root (+Z), the leg is excluded
    // (the trestle pool regrows it vertically), matching how render + the sim rig bodies read one incline.
    const bed: RigGeometry = {
      kind: 'rig',
      inclineParam: 'tiltDeg',
      links: [
        { name: 'deck', shape: { kind: 'box', size: [4, 0.04, 1] }, offset: [0, 0, 0] },
        { name: 'head', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [1, 0, 0] },
        { name: 'legs', shape: { kind: 'leg', spanParam: 'length', widthParam: 'width', standParam: 'stand', frameDepth: 0.5 }, offset: [0, 0, 0] },
      ],
      joints: [],
    }
    const theta = (20 * Math.PI) / 180
    const flat = rigWorldPoses(bed, {}, undefined, 1, {}, 0)
    const tilted = rigWorldPoses(bed, {}, undefined, 1, {}, theta)
    // the +X head link lifts by run·sin and pulls in by run·cos (tail-pivot about the root at x=0)
    expect(tilted.get('head')!.pos[0]).toBeCloseTo(Math.cos(theta), 9)
    expect(tilted.get('head')!.pos[1]).toBeCloseTo(Math.sin(theta), 9)
    // the deck's orientation rolls about +Z (its quat's z/w component picks up the half-angle)
    expect(tilted.get('deck')!.quat[2]).toBeCloseTo(Math.sin(theta / 2), 9)
    // the leg link is unchanged: it stays at the flat pose (the trestle pool applies its own tilt)
    expect(tilted.get('legs')!.pos).toEqual(flat.get('legs')!.pos)
    expect(tilted.get('legs')!.quat).toEqual(flat.get('legs')!.quat)
  })
})

describe('rig FK quaternion math', () => {
  it('rotates a vector about an axis (qFromAxisAngle + qApply)', () => {
    // +Z rotated +90° about +Y → +X (matches three.js)
    const out = qApply(qFromAxisAngle([0, 1, 0], Math.PI / 2), [0, 0, 1])
    expect(out[0]).toBeCloseTo(1, 10)
    expect(out[1]).toBeCloseTo(0, 10)
    expect(out[2]).toBeCloseTo(0, 10)
  })
})

describe('rigLocalPose', () => {
  const link = { name: 'arm', shape: { kind: 'box' as const, size: [0.1, 0.1, 0.8] as [number, number, number] }, offset: [0, 0.4, 0] as [number, number, number] }

  it('revolute keeps the origin, rotates by the clamped angle', () => {
    const j = { name: 'shoulder', link: 'arm', type: 'revolute' as const, axis: [0, 1, 0] as [number, number, number], min: -Math.PI, max: Math.PI }
    const pose = rigLocalPose(link, j, 10) // clamped to π
    expect(pose.pos).toEqual([0, 0.4, 0])
    const expected = qFromAxisAngle([0, 1, 0], Math.PI)
    expect(pose.quat.map((v, i) => Math.abs(v - expected[i]!) < 1e-9).every(Boolean)).toBe(true)
  })

  it('prismatic slides the origin along the axis', () => {
    const j = { name: 'lift', link: 'arm', type: 'prismatic' as const, axis: [0, 1, 0] as [number, number, number], min: 0, max: 1 }
    expect(rigLocalPose(link, j, 0.5).pos[1]).toBeCloseTo(0.9, 10) // 0.4 + 0.5
  })
})

describe('rigWorldPoses (FK composition through the tree)', () => {
  const geo: RigGeometry = {
    kind: 'rig',
    links: [
      { name: 'base', shape: { kind: 'cylinder', radius: 0.2, height: 0.3 }, offset: [0, 0, 0] },
      { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0.4, 0] },
      { name: 'hand', parent: 'arm', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0, 0.5] },
    ],
    joints: [{ name: 'shoulder', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -6.3, max: 6.3 }],
  }

  it('composes a child through a rotated parent', () => {
    const poses = rigWorldPoses(geo, { shoulder: Math.PI / 2 })
    // arm origin unmoved; hand at arm.offset + R(Y,90°)·[0,0,0.5] = [0,0.4,0] + [0.5,0,0]
    expect(poses.get('arm')!.pos).toEqual([0, 0.4, 0])
    const hand = poses.get('hand')!.pos
    expect(hand[0]).toBeCloseTo(0.5, 9)
    expect(hand[1]).toBeCloseTo(0.4, 9)
    expect(hand[2]).toBeCloseTo(0, 9)
  })

  it('rest pose (no joint values) leaves children at their offsets', () => {
    const poses = rigWorldPoses(geo, {})
    expect(poses.get('hand')!.pos).toEqual([0, 0.4, 0.5])
  })
})

// The returned Map's iteration order matters: sim/rigBuild.ts buildRigBodies walks it
// to create one Jolt body per link, so reordering it renumbers every body ID. That breaks determinism, and no
// pose-by-name assertion would catch it. Two rules (rigPose.ts `mapOrder`): a link always follows its parent
// (declaration order otherwise), and
// on an aim rig everything an aim rotation can't move comes first, then the aim links + their descendants.
describe('rigWorldPoses - Map iteration order (body build order)', () => {
  it('emits a parent before its child even when declared after it', () => {
    const geo: RigGeometry = {
      kind: 'rig',
      links: [
        { name: 'hand', parent: 'arm', shape: { kind: 'frame' }, offset: [0, 0, 0] }, // child declared first
        { name: 'base', shape: { kind: 'frame' }, offset: [0, 0, 0] },
        { name: 'arm', parent: 'base', shape: { kind: 'frame' }, offset: [0, 0, 0] },
      ],
      joints: [],
    }
    expect([...rigWorldPoses(geo, {}).keys()]).toEqual(['base', 'arm', 'hand'])
  })

  it('an aim rig emits the unaffected links first, then the aim link and its subtree', () => {
    const geo: RigGeometry = {
      kind: 'rig',
      links: [
        { name: 'anchor', shape: { kind: 'frame' }, offset: [0, 0, 0], aim: { target: 'tgt' } },
        { name: 'strut', parent: 'anchor', shape: { kind: 'frame' }, offset: [0, 0, 0] }, // carried by the aim
        { name: 'tgt', shape: { kind: 'frame' }, offset: [0, 0, 5] },
      ],
      joints: [],
    }
    expect([...rigWorldPoses(geo, {}).keys()]).toEqual(['tgt', 'anchor', 'strut'])
  })
})

// Seam-resolver mechanism: world-phase array distribution locks copies to a shared world pitch grid so two
// collinear beds (butted roller conveyors) align, with the centred default left untouched (docs/seam-resolvers.md).
describe('arrayInstanceDeltas world-phase distribution', () => {
  const PITCH = 0.075
  const roller = (worldPhase: boolean): NonNullable<RigLink['array']> => ({
    distribute: { axis: 0, spanParam: 'length', maxSpacing: PITCH, ...(worldPhase ? { worldPhase: true } : {}) },
  })
  const fposmod = (a: number, b: number): number => ((a % b) + b) % b
  // world +X station of each copy for a bed placed at x=originX, rotationY 0 (axis 0 → world +X)
  const worldStations = (originX: number, length: number): number[] => {
    const seam: SeamContext = { worldPos: [originX, 0, 0], worldRotY: 0 }
    return arrayInstanceDeltas(roller(true), { length }, seam).map((d) => originX + d[0])
  }

  it('lands every copy on the world pitch grid regardless of the bed origin', () => {
    for (const s of [...worldStations(0, 2), ...worldStations(2, 2), ...worldStations(3.137, 1.5)]) {
      const r = fposmod(s, PITCH)
      expect(Math.min(r, PITCH - r)).toBeLessThan(1e-6)
    }
  })

  it('two collinear beds butting at x=2 form one continuous grid (constant seam gap = pitch)', () => {
    const all = [...worldStations(0, 2), ...worldStations(2, 2)].sort((a, b) => a - b)
    // de-dupe a shared seam station, then every consecutive gap is exactly one pitch
    const uniq = all.filter((v, i) => i === 0 || Math.abs(v - all[i - 1]!) > 1e-6)
    for (let i = 1; i < uniq.length; i++) expect(uniq[i]! - uniq[i - 1]!).toBeCloseTo(PITCH, 9)
  })

  it('honours an anchor world point (curve-anchored phase) instead of the world origin', () => {
    const anchor: [number, number, number] = [0.31, 0, 0] // a curve end roller off the world grid
    const seam: SeamContext = { worldPos: [1, 0, 0], worldRotY: 0, anchor }
    for (const d of arrayInstanceDeltas(roller(true), { length: 1 }, seam)) {
      const r = fposmod(1 + d[0] - anchor[0], PITCH) // stations align to the anchor, not the origin
      expect(Math.min(r, PITCH - r)).toBeLessThan(1e-6)
    }
  })

  it('falls back to the centred spread when no seam is supplied (deterministic bare eval)', () => {
    const centred = arrayInstanceDeltas(roller(true), { length: 2 }) // no seam → centred, symmetric about 0
    expect(centred[0]![0]).toBeCloseTo(-1, 9)
    expect(centred[centred.length - 1]![0]).toBeCloseTo(1, 9)
  })

  it('leaves a plain (non-worldPhase) distribute untouched', () => {
    const seam: SeamContext = { worldPos: [2, 0, 0], worldRotY: 0 }
    const plain = arrayInstanceDeltas(roller(false), { length: 2 }, seam)
    expect(plain[0]![0]).toBeCloseTo(-1, 9) // centred about the link, ignores placement
    expect(plain[plain.length - 1]![0]).toBeCloseTo(1, 9)
  })
})

// C-paramgeo stepParams: a count+step array's spacing tracks an instance param - the chain transfer's lane
// spacing following `distance` (and an adopted host roller pitch), the static step as the fallback.
describe('arrayInstanceDeltas count+step with stepParams (param-driven spacing)', () => {
  const lanes: NonNullable<RigLink['array']> = {
    count: 'chains',
    step: [0, 0, 0.33],
    stepParams: [{ axis: 2, param: 'distance' }],
    centered: true,
  }

  it('steps copies by the live param value instead of the static step', () => {
    expect(arrayInstanceDeltas(lanes, { chains: 3, distance: 0.5 }).map((d) => d[2])).toEqual([-0.5, 0, 0.5])
  })

  it('falls back to the static step axis when the param is missing/non-numeric', () => {
    expect(arrayInstanceDeltas(lanes, { chains: 3 }).map((d) => d[2])).toEqual([-0.33, 0, 0.33])
    expect(arrayInstanceDeltas(lanes, { chains: 3, distance: 'wide' }).map((d) => d[2])).toEqual([-0.33, 0, 0.33])
  })
})

describe('arrayInstanceDeltas omitFirst/LastParam (butt barriers without a doubled post - guard rail)', () => {
  // a distribute post row along +X: at length 4.8, N = ceil(4.8/2.4)+1 = 3 posts at [-2.4, 0, +2.4]
  const posts = (extra: Partial<NonNullable<RigLink['array']>> = {}): NonNullable<RigLink['array']> => ({
    distribute: { axis: 0, spanParam: 'length', maxSpacing: 2.4 },
    ...extra,
  })
  const xs = (a: NonNullable<RigLink['array']>, params: Record<string, number | boolean>) => arrayInstanceDeltas(a, params).map((d) => d[0])

  it('drops the first (low-X) post only when omitPostStart is true', () => {
    expect(xs(posts({ omitFirstParam: 'omitStart' }), { length: 4.8 })).toEqual([-2.4, 0, 2.4]) // default false → all posts
    expect(xs(posts({ omitFirstParam: 'omitStart' }), { length: 4.8, omitStart: true })).toEqual([0, 2.4]) // -2.4 dropped
  })

  it('drops the last (high-X) post only when omitPostEnd is true', () => {
    expect(xs(posts({ omitLastParam: 'omitEnd' }), { length: 4.8, omitEnd: true })).toEqual([-2.4, 0]) // +2.4 dropped
  })

  it('drops both ends when both are set', () => {
    expect(xs(posts({ omitFirstParam: 'omitStart', omitLastParam: 'omitEnd' }), { length: 4.8, omitStart: true, omitEnd: true })).toEqual([0])
  })

  it('never empties the row - a lone post keeps at least itself', () => {
    // length 0.5 → N = ceil(0.5/2.4)+1 = 2 posts; both-omit would empty it, so it keeps one
    expect(xs(posts({ omitFirstParam: 'omitStart', omitLastParam: 'omitEnd' }), { length: 0.5, omitStart: true, omitEnd: true })).toHaveLength(1)
  })
})

describe('arrayInstanceDeltas grid (the EOAT suction-cup bed)', () => {
  const cups: NonNullable<RigLink['array']> = {
    grid: {
      x: { sizeParam: 'toolSizeX', pitchParam: 'cupPitchX', marginParam: 'cupMarginX' },
      z: { sizeParam: 'toolSizeZ', pitchParam: 'cupPitchZ', marginParam: 'cupMarginZ' },
    },
  }
  const P = (over: Record<string, number | boolean> = {}): Record<string, number | boolean> => ({
    toolSizeX: 0.5, toolSizeZ: 0.5, cupPitchX: 0.1, cupPitchZ: 0.1, cupMarginX: 0.05, cupMarginZ: 0.05, cupsEnabled: true, ...over,
  })

  it('default 0.5 m tool → a 5×5 grid, edge-to-edge across ±usable/2', () => {
    // usable = 0.5 − 2·0.05 = 0.4; count = floor(0.4/0.1)+1 = 5; the generated cups sit at −0.2…0.2
    const deltas = arrayInstanceDeltas(cups, P())
    expect(deltas).toHaveLength(25)
    const xs = [...new Set(deltas.map((d) => d[0]))].sort((a, b) => a - b)
    xs.forEach((x, i) => expect(x).toBeCloseTo(-0.2 + i * 0.1, 10))
    expect(deltas.every((d) => d[1] === 0)).toBe(true)
  })

  it('per-axis counts follow their own size/pitch/margin (rectangular tools)', () => {
    // x: usable 0.9 → 10 cups; z: usable 0.4 at pitch 0.2 → 3 cups
    const deltas = arrayInstanceDeltas(cups, P({ toolSizeX: 1, cupPitchZ: 0.2 }))
    expect(deltas).toHaveLength(30)
  })

  it("a false showParam on the link yields zero instances (cups_enabled off removes the bed)", () => {
    expect(arrayInstanceDeltas(cups, P({ cupsEnabled: false }), undefined, 'cupsEnabled')).toHaveLength(0)
  })

  it('a degenerate usable span parks a single centred instance per axis', () => {
    // margins swallow the whole span → usable 0 → 1×1 at the link origin (count clamped to ≥1)
    expect(arrayInstanceDeltas(cups, P({ cupMarginX: 0.3, cupMarginZ: 0.3 }))).toEqual([[0, 0, 0]])
  })

  it('stays within the 256-instance budget by thinning the larger axis (spacing degrades, no truncation)', () => {
    // 3 m × 3 m at 0.1 pitch would be 30×30 = 900; the lattice must thin to ≤256 but keep full coverage
    const deltas = arrayInstanceDeltas(cups, P({ toolSizeX: 3, toolSizeZ: 3 }))
    expect(deltas.length).toBeLessThanOrEqual(256)
    expect(deltas.length).toBeGreaterThan(100) // still a dense bed, not a token row
    const xs = deltas.map((d) => d[0])
    expect(Math.min(...xs)).toBeCloseTo(-1.45, 10) // full usable extent kept (±(3 − 0.1)/2)
    expect(Math.max(...xs)).toBeCloseTo(1.45, 10)
  })
})

describe('arrayInstanceDeltas grid maxSpacing (OSHA/ceil support-column lattice - built-in platform parity)', () => {
  // ceil semantics: every gap ≤ maxSpacing, edges included - the exact positions the built-in platform's
  // supportPositions(total) yields (spans = max(1, ceil(total/2.4)); positions −total/2 … +total/2).
  const cols: NonNullable<RigLink['array']> = {
    grid: {
      x: { sizeParam: 'length', maxSpacing: 2.4, size: 4 },
      z: { sizeParam: 'width', maxSpacing: 2.4, size: 4 },
    },
  }
  const axis = (deltas: [number, number, number][], i: 0 | 2): number[] => [...new Set(deltas.map((d) => d[i]))].sort((a, b) => a - b)

  it('default 4×4 deck → a 3×3 grid at ±2, 0 (a centre column, unlike the floor/pitch grid)', () => {
    const deltas = arrayInstanceDeltas(cols, { length: 4, width: 4, showSupports: true })
    expect(deltas).toHaveLength(9)
    expect(axis(deltas, 0)).toEqual([-2, 0, 2])
    expect(axis(deltas, 2)).toEqual([-2, 0, 2])
  })

  it('a narrow 13.5×1.9 catwalk keeps columns at both width edges (never down the centreline)', () => {
    // width 1.9 < 2.4 → 2 columns at ±0.95 (matches supportPositions), not a single centred one (floor mode)
    const deltas = arrayInstanceDeltas(cols, { length: 13.5, width: 1.9, showSupports: true })
    const zs = axis(deltas, 2)
    expect(zs).toHaveLength(2)
    expect(zs[0]).toBeCloseTo(-0.95, 10)
    expect(zs[1]).toBeCloseTo(0.95, 10)
    const xs = axis(deltas, 0) // 13.5 → spans 6 → 7 columns, gap 2.25 ≤ 2.4
    expect(xs).toHaveLength(7)
    xs.forEach((x, i) => expect(x).toBeCloseTo(-6.75 + i * 2.25, 10))
  })

  it("a false showParam on the link empties the grid (showSupports off drops the middle columns)", () => {
    expect(arrayInstanceDeltas(cols, { length: 4, width: 4, showSupports: false }, undefined, 'showSupports')).toHaveLength(0)
  })
})

describe("arrayInstanceDeltas and the link's showParam", () => {
  it('a false showParam empties any form; true or absent leaves it whole (default-true toggles)', () => {
    const legs: NonNullable<RigLink['array']> = { count: 'n', step: [1, 0, 0] }
    expect(arrayInstanceDeltas(legs, { n: 3, showSupports: true }, undefined, 'showSupports')).toHaveLength(3)
    expect(arrayInstanceDeltas(legs, { n: 3 }, undefined, 'showSupports')).toHaveLength(3)
    expect(arrayInstanceDeltas(legs, { n: 3, showSupports: false }, undefined, 'showSupports')).toHaveLength(0)
  })
})

describe('resolvedGrabReach (param-driven gripper pickup volume - the EOAT vacuum zone)', () => {
  const gripper: RigLink = {
    name: 'gripper',
    shape: { kind: 'frame' },
    offset: [0, 0, 0],
    grip: {
      radius: 0.45,
      radiusParams: [
        { axis: 0, param: 'toolSizeX', scale: 0.5, add: 0.2 },
        { axis: 2, param: 'toolSizeZ', scale: 0.5, add: 0.2 },
      ],
    },
  }

  it('takes the largest resolved entry (vacuum box = tool_size + skin)', () => {
    expect(resolvedGrabReach(gripper, { toolSizeX: 3, toolSizeZ: 0.5 })).toBeCloseTo(1.7, 10)
  })

  it('never shrinks below the static radius, and falls back to it when no entry resolves', () => {
    expect(resolvedGrabReach(gripper, { toolSizeX: 0.1, toolSizeZ: 0.1 })).toBe(0.45)
    expect(resolvedGrabReach(gripper, {})).toBe(0.45)
    expect(resolvedGrabReach({ ...gripper, grip: {} }, {})).toBe(0.2) // the host default
  })
})

describe('resolvedGrabZone (C-multigrab - the gripper pickup volume, which decides how many bodies it takes)', () => {
  // a vacuum plate: the volume is the plate footprint (tracking the tool-size params) by a shallow reach below it
  const plate: RigLink = {
    name: 'gripper',
    shape: { kind: 'frame' },
    offset: [0, 0, 0],
    grip: { zone: {
      size: [0.5, 0.3, 0.5],
      sizeParams: [
        { axis: 0, param: 'toolSizeX', scale: 1 },
        { axis: 2, param: 'toolSizeZ', scale: 1 },
      ],
    } },
  }

  it('resolves the volume to half-extents, tracking the tool-size params', () => {
    expect(resolvedGrabZone(plate, { toolSizeX: 1.4, toolSizeZ: 1.2 })).toEqual({ half: [0.7, 0.15, 0.6], offset: [0, 0, 0] })
  })

  it('falls back to the authored size on the axes no param drives', () => {
    expect(resolvedGrabZone(plate, {})).toEqual({ half: [0.25, 0.15, 0.25], offset: [0, 0, 0] })
  })

  it('carries a link-local centre offset (the fork volume sitting out on the tines)', () => {
    const fork: RigLink = { name: 'gripper', shape: { kind: 'frame' }, offset: [0, 0, 0], grip: { zone: { size: [2.2, 2.4, 1.4], offset: [1.1, -0.15, 0] } } }
    expect(resolvedGrabZone(fork, {})).toEqual({ half: [1.1, 1.2, 0.7], offset: [1.1, -0.15, 0] })
  })

  it('returns null when the link declares no zone (the caller uses the grabRadius sphere)', () => {
    expect(resolvedGrabZone({ name: 'g', shape: { kind: 'frame' }, offset: [0, 0, 0] }, {})).toBeNull()
  })
})

describe('jointLimits (a limit that tracks a param, inside the static envelope)', () => {
  const carriage: RigJoint = {
    name: 'x', link: 'car', type: 'prismatic', axis: [1, 0, 0], min: -10, max: 10,
    minParam: { param: 'frameLength', scale: -0.5, add: 0.06, max: 0 },
    maxParam: { param: 'frameLength', scale: 0.5, add: -0.06, min: 0 },
  }
  it('narrows to the resolved params, and the FK clamps to them', () => {
    expect(jointLimits(carriage, { frameLength: 3 })).toEqual([-1.44, 1.44])
    const link: RigLink = { name: 'car', shape: { kind: 'frame' }, offset: [0, 0, 0] }
    expect(rigLocalPose(link, carriage, 5, { frameLength: 3 }).pos[0]).toBeCloseTo(1.44, 10)
    expect(rigLocalPose(link, carriage, 5).pos[0]).toBe(5) // no params: the static envelope
  })
  it('never widens past the static envelope, and a missing param leaves the static limit', () => {
    expect(jointLimits(carriage, { frameLength: 100 })).toEqual([-10, 10])
    expect(jointLimits(carriage, {})).toEqual([-10, 10])
  })
  it('a range the params cross (a frame shrunk below its inset) pins the middle instead of inverting', () => {
    expect(jointLimits(carriage, { frameLength: 0.05 })).toEqual([0, 0])
  })
})

describe('rigLinkLocalPoseInto (one link, by the composition\'s own rule)', () => {
  // every layer a link's local pose can carry: a param-driven offset, a revolute and a prismatic joint, a sub-pose,
  // a rest rotation, the whole-bed incline on top-level links - and a leg, which the incline leaves alone
  const geo = {
    kind: 'rig',
    inclineParam: 'tiltDeg',
    links: [
      { name: 'base', shape: { kind: 'frame' }, offset: [0.1, 0.2, 0], offsetParams: [{ axis: 0, param: 'length', scale: -0.5 }] },
      { name: 'arm', parent: 'base', shape: { kind: 'box', size: [1, 0.1, 0.1] }, offset: [0.3, 0.4, 0.05], rotation: [0.2, -0.1, 0.3] },
      { name: 'slide', parent: 'arm', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0.5, 0, 0] },
      { name: 'cap', parent: 'slide', shape: { kind: 'box', size: [0.05, 0.05, 0.05] }, offset: [0, 0.1, 0] },
      { name: 'side', shape: { kind: 'box', size: [1, 0.1, 0.1] }, offset: [0, 0.5, -0.4] },
      { name: 'legs', shape: { kind: 'leg', spanParam: 'length', widthParam: 'width', standParam: 'stand', frameDepth: 0.5 }, offset: [0, 0, 0] },
    ],
    joints: [
      { name: 'j1', link: 'arm', type: 'revolute', axis: [0, 0, 1], min: -2, max: 2 },
      { name: 'j2', link: 'slide', type: 'prismatic', axis: [1, 0, 0], min: -0.5, max: 0.5 },
    ],
  } as unknown as Parameters<typeof rigWorldPoses>[0]
  const values = { j1: 0.7, j2: 0.25 }
  const subPoses = { cap: { position: [0.02, 0.15, -0.01] as [number, number, number], rotation: [0.3, 0, 0.1] as [number, number, number] } }
  const params = { length: 2, width: 1, stand: 0.8 }
  const incline = 0.15

  it('matches the local pose implied by the composed tree (parent world^-1 * world), link by link', () => {
    const world = rigWorldPoses(geo, values, subPoses, 1, params, incline)
    const out = new Float64Array(7)
    geo.links.forEach((link, i) => {
      rigLinkLocalPoseInto(out, geo, i, values, subPoses, params, incline)
      const w = world.get(link.name)!
      const root = { pos: [0, 0, 0] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number] }
      const pw = link.parent ? world.get(link.parent)! : root
      const c = [-pw.quat[0], -pw.quat[1], -pw.quat[2], pw.quat[3]] as [number, number, number, number]
      const pos = qApply(c, [w.pos[0] - pw.pos[0], w.pos[1] - pw.pos[1], w.pos[2] - pw.pos[2]])
      // local quat = conj(parent) * world
      const q = [
        c[3] * w.quat[0] + c[0] * w.quat[3] + c[1] * w.quat[2] - c[2] * w.quat[1],
        c[3] * w.quat[1] + c[1] * w.quat[3] + c[2] * w.quat[0] - c[0] * w.quat[2],
        c[3] * w.quat[2] + c[2] * w.quat[3] + c[0] * w.quat[1] - c[1] * w.quat[0],
        c[3] * w.quat[3] - c[0] * w.quat[0] - c[1] * w.quat[1] - c[2] * w.quat[2],
      ]
      const sign = q[0]! * out[3]! + q[1]! * out[4]! + q[2]! * out[5]! + q[3]! * out[6]! < 0 ? -1 : 1
      for (let k = 0; k < 3; k++) expect(out[k]).toBeCloseTo(pos[k]!, 9)
      for (let k = 0; k < 4; k++) expect(out[3 + k]).toBeCloseTo(sign * q[k]!, 9)
    })
  })

  it('tilts a top-level link by the incline and leaves a leg, and a child, untilted', () => {
    const out = new Float64Array(7)
    const flat = new Float64Array(7)
    const at = (name: string, inc: number, buf: Float64Array) => rigLinkLocalPoseInto(buf, geo, geo.links.findIndex((l) => l.name === name), values, subPoses, params, inc)
    expect([...at('side', incline, out)]).not.toEqual([...at('side', 0, flat)])
    expect([...at('legs', incline, out)]).toEqual([...at('legs', 0, flat)])
    expect([...at('arm', incline, out)]).toEqual([...at('arm', 0, flat)])
  })
})
