# Scene annotations

An icon + text pinned to a place, optionally reading a live PLC tag. A note does not read a sim measurement or
a part's published display (`ctx.display`) directly. A part's number reaches a note only through a PLC tag the
part writes; see the end.

## What it is

A note is an ordinary scene part (`type: 'annotation'`) with no geometry, drawn as a screen-space chip over
the viewport. Place it from the catalog like anything else, type its text, pick an icon from a short list.

Because it is a part, the scene tree, selection, the transform gizmo, undo, save/load, collab
and the eye/lock toggles all work on it with no special code. `group` is the precedent: a part type
with no mesh and no sim body.

## Why an overlay and not geometry

A note is *about* the layout, not part of it. As a screen-space chip it stays the same readable size wherever
the camera is, faces you from every angle, and can't be walked into or collided with. A sign modelled on a
wall would have none of those properties, and would also need a thumbnail, a footprint and a collider it does
not use.

The rendering primitive is `view.worldToScreen`, which the tutorial's placement hint also uses to pin a DOM
ring to a world spot. Notes add user placement and persistence on top of it.

## Anchoring: parent it to the machine

`parent` is ordinary soft-parenting, and a translate drag applies to `subtreeIds(selection)`. So a note
parented to a conveyor moves with the conveyor, with no code of its own.

Prefer that over a bare world point. Layouts get rearranged constantly, and a note left at a fixed coordinate
stays put when the machine moves. It ends up labelling empty floor, or the machine that moved into that spot,
and nothing warns you. A note with no parent uses the same code path, not a second one.

## Two rules that limit clutter

Both are in [annotationChips.ts](../src/editor/annotationChips.ts), pure and unit-tested.

**Off screen is hidden, not clamped to the viewport edge.** The tutorial clamps its hint to the edge with an
arrow pointing back, which is right for a single hint. Done for every note in a plant layout, it would surround
the viewport with arrows and hide the scene.

**Far away fades out** (22 m → 45 m). A chip draws at a fixed pixel size, so unlike the machine it labels it
does not shrink with distance. That is useful up close and clutter at fifty metres.

There is also a **Show Annotations** toggle (View menu / palette), on by default because a placed note is
content, not a preference. It exists for the two cases where notes are in the way: a chip sitting over the
thing it annotates, and a clean presentation shot. Screenshots taken through `cleanShot()` already drop the
overlay, so the e2e fleet is unaffected either way.

## Placement

Drop it from the catalog like any part. Two things make that work:

**The overlay reads the scene from the store, not from React props.** A placement preview (and a drag) is
pushed as a `setTransient`, which does not re-render the React chrome, because re-rendering the panels would
take frame time from the render loop. Read through props, the note would be invisible until the drop. The
overlay reads the live scene in the frame loop, which already runs, so transients show with no extra work.

**A zero-footprint part hovers instead of resting.** `restUnderCursor` seats a part's footprint on whatever
is under the cursor. A note has no footprint, so without this it would sit flat on the floor at y=0. It
hovers `defaultY` (1.2 m) above the rest point: chest height over the floor, or over a conveyor's belt if
you drop it on one. This is derived from the footprint being zero, not from a type test, because the general
rule is that nothing with zero extent can rest on anything.

## Implementation notes

**Nothing draws until the loading cover lifts.** The chip layer is `position: fixed`, so its z-index competes
at the page root while the cover's is scoped inside the viewport. No z-index arrangement reliably puts one
under the other, so without a gate the chips paint over the cover during boot. The overlay gates on
`whenCoverHidden()`, the same signal the cover reports. That is also the right condition, because before the
reveal there is no settled camera to project against.

**The chip is the hit target.** There is nothing in the 3-D scene to click, so selection works the opposite
way from every other part: clicking the chip selects the note. That needs `.note-chip` in the viewport
controller's overlay opt-out (`onPointerDown`). Without it the viewport captures the pointer on mousedown and
the click never arrives.

**A geometry-less part type needs `PartDef.glyph`.** The catalog's built-in cards fetch
`/thumbnails/<type>.webp` and fall back to an offscreen render when that 404s. An annotation has no geometry to
render, so declaring a glyph opts it out of the image path entirely. There is no fetch, no boot-warm
entry, and no second GPU device started to render an empty transform.

## Live PLC readout

Bind a note to a **PLC tag** and its text becomes a label with the running program's value beside it:
`Infeed  42.0 /min`. Params: the tag, a unit, and decimals. The value is read from
`controller.plcGlobalTags`, the program's variable image lifted to global tag keys and memoized per frame.
So it is one map lookup per note per frame, with no new plumbing.

This is the only place a PLC tag is shown on the layout itself. The ST watch table is a table. A line's own
numbers (count, rate, cycle time) are the despawner's, shown on the part and published as tags. Bind one of
those tags to a note to show it anywhere on the layout.

**Blank is not zero.** A bound tag reads 0 through a tag table when the
sim is stopped, no program is attached, or the name is misspelled. Showing that as `0` on a note
wired to nothing would look the same as a line that is really stopped. An unreadable tag
prints `--`. A published 0 prints `0`, because the line really is stopped and that is a measurement. A note
that binds no tag shows no value slot at all, so a dash always means "bound to something that is not there".

## What a note does not show

**A part-published value** (`ctx.display`, e.g. the despawner's `count` / `rate` / `cycle`). The despawner and
both spawners publish displays, and the despawner shows its own on a plate, so a chip would be a second place to
read the same number. With a program attached it is already reachable through
the tag route (the same parts write `countTag` / `rateTag` / `cycleTag`).

Measurements are per sink. There is no engine-wide measurement HUD, because one number for the whole scene
would lump every sink together, a reject chute included.
