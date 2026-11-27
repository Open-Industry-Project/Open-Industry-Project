# SDK geometry flexibility: render flags + the geometry context

Two general SDK capabilities let a part author geometry the engine would otherwise have to hard-code for
it: render-only flags on `MeshPart`, and a `GeometryContext` that hands `geometry()` the placement-dependent
seam it cannot compute from params. The Roller Conveyor's skew (angled rollers, and a seam strip at a butted
end) uses both, and it is authored entirely in the part. Related reading:
[procedural-geometry.md](procedural-geometry.md) (the authoring ladder),
[architecture.md](architecture.md) (built-ins are custom parts),
[seam-resolvers.md](seam-resolvers.md) (world phase).

## The rule

> The engine may contain only **general, composable capabilities that any part can use**, never code
> keyed to one specific part.

A part that can only be built because the engine hard-codes *its* geometry is not a reference an SDK
author can follow. So nothing named `roller` or `skew` lives in the engine. Roller parts draw their whole bed
as instanced banks with `spin` (`examples/parts/_shared/rollerBed.js`). The rig keeps only general features:
`worldPhase`, `inclineParam` and the `leg` trestle.

## Why the roller bed stays on the rig tier

Converting a straight roller bed to a `kind: 'drawn'` part (like the Spur Roller) would lose two things:

- **World phase.** Butted straight beds must drop rollers on one shared *world* pitch grid
  ([seam-resolvers.md](seam-resolvers.md#the-roller-grid)). That depends on the part's world position, which
  `geometry(g, params)` never sees (`core/geometry/geometryEval.ts`). The rig array-link path resolves it. The Spur can be
  `drawn` because a spur never butts into a continuous run.
- **Incline and legs.** `inclineParam` (whole-bed tilt of render **and** collision, `conveyor-incline.md`)
  and the `leg` trestle are host-resolved rig features with no equivalent for a `drawn` part.

So the bed is a rig part with a composed `geometry()`, and that `geometry()` needs the two capabilities below.

## Render-only mesh properties on `MeshPart`

```ts
interface MeshPart {
  // …
  castShadow?: boolean    // default true; false = a render-only decal/dead-plate that casts nothing
  doubleSided?: boolean   // default false; render both faces (thin sheets, backs of open panels)
}
```

Both are honoured in `buildFunctionMesh` and the rig `realizeProceduralGeometry` path. `castShadow` threads into
`shadowMesh(geo, mat, castShadow)`. `doubleSided` gives the submesh its own `DoubleSide` material instance, because
shared role materials must not be flipped for every part. `colorParam` follows the same own-instance rule. Decals,
dead-plates, thin sheets and the backs of wire panels use these flags. The skewed roller bed's seam strip is a few lines of
author `surface()` code with both set.

## `GeometryContext`: the placement seam `geometry()` needs

Butted roller beds read as one bed because both sit on the shared world pitch grid. The pair straddling a
seam is always exactly one pitch apart, so the clear gap there is `pitch − 2R` (27 mm) **whatever the phase**.
A skewed bed's rollers run wall to wall at an angle, which leaves a corner of each end, `width × tan(skew)` long,
that no full roller reaches. Shorter rollers fill it, mounted on a cross member across the bed end. So a skewed bed
ends in that cross member, not a roller, and at a butt it draws a full-width *strip* from its end toward the
neighbour. The neighbour's
first roller is wherever the grid put it, so a strip of fixed width leaves bare deck that depends on the phase, up
to `pitch − R` (51 mm). That is nearly twice a normal gap, and it looks fine at some positions and wrong at
others.

Neither the params nor a fixed constant can fix it:

- **Params can't.** The phase depends on where the bed sits in world X, which `geometry(g, params)`
  cannot see.
- **A fixed width can't either.** A strip a constant `R` wide bounds the gap correctly. But at the phases
  where the neighbour's first roller straddles the seam, the strip then sits *on top of* that roller (its top
  is 1 mm above the roller crown), which looks worse than the gap.

So `geometry()` takes a third argument, `ctx: GeometryContext` (`core/parts/partApi.ts`), carrying the host-resolved
seam:

```ts
export interface GeometryContext {
  deltas?: ReadonlyArray<readonly [number, number, number]> // the world-phase grid, part-local
  pitch?: number                                            // its spacing
  butt?: { head: boolean; tail: boolean }                   // does this end abut a collinear neighbour?
}
```

`deltas` and `pitch` give the phase. The next grid line past the head is `last + pitch`, and because collinear
beds share one grid, that is where the neighbour's first roller sits. `butt` comes straight off the resolved
`RollerGrid`. The resolver already computes it to suppress that end's edge nudge. It answers the one question the
grid alone can't: whether there is anything out there to meet. The strip runs to the neighbour roller's face,
bounded by `R`, and only at a butt. A free end draws none.

Every field is optional and the object may be empty. A part that ignores `ctx` is unaffected, and every
placement-free caller (parity tests, headless probes) gets the placement-free geometry. Determinism is over
`(params, ctx)`.

**Plumbing.** The rig resolves the bed grid once per refresh, so the strip and the rollers
are drawn against the same grid. The seam is part of `realizeProceduralGeometry`'s re-emit key. A part's first
refresh runs before the scene resolve hands the rig its grid, so `butt` is the only thing that changes on the
pass that learns the bed has a neighbour. Leave it out of the key and that pass early-outs on an unchanged key,
and the seam geometry never appears.

Gated by [e2e/verify-skew-transfer-seam.mjs](../e2e/verify-skew-transfer-seam.mjs), which sweeps a butted pair
through a whole pitch on the rendered bed, plus the `seam strip across a butt` unit block in
`rollerConveyorRigParity.test.ts` for the part's own arithmetic. Both gates find the part-authored strip by its
material (the one double-sided, shadow-off mesh in the part's group).
