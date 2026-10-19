# Placement staging: the preview is the part

Catalog placement stages a real scene part, streamed like a reposition drag, instead of a render-only
"placement ghost".

A render-only visual would be invisible to every system that reads `scene.parts`. Snap merges (host guard openings,
spur rail folds, platform railing gaps) would never be previewed, the roller grid would need its own resolution for
the one part not in the scene, and the WebGPU pipeline pre-warm would need a second copy. The drop would also swap
the visual for a newly built part, which makes the drop flash. A reposition drag already keeps the moving part in the
scene through `store.setTransient`, so the scene recomputes grids, openings and extents live, and commit or revert is
one store call. Placement works the same way.

## The model

**Placement = a reposition drag of a part that doesn't exist yet.**

- **Session** (controller `placing`): armed when placing mode is entered or the
  placed kind (type/packageId) changes. It holds:
  - `id`: the placed part's **final id, pre-allocated** (`nextId` on the base scene).
  - `base`: the scene the preview stages onto *and the commit lands against*.
  - `staged`: the last transient scene streamed (identity-tracked).
  - `exclude`: `{id}`, the self-exclusion set for every placement raycast and snap.
- **Preview** (`previewPlacing`): computes the draft part (carrying `id`), then
  streams `setTransient({ ...base, parts: [...base.parts, draft] })`. Losing the
  preview (off-viewport, no surface) reverts to `base`. React skips transients, and
  the viewport follows them (`subscribeView`), as in a reposition drag.
- **Drop** (`placePart`): closes the session, builds the final scene **from `base`**
  (placed part + snap `targetParamOverrides` + package embed + one-shot re-rest) and
  commits with `{ before: base }`, so undo returns to the pre-staging scene.
  Click-to-place re-arms a fresh session on the committed scene. A drag is one-shot.
- **Cancel / mode leave / kind switch** (`endPlacingSession`): un-tags the view and
  reverts an in-flight staged transient to `base`. It runs inside the store-change
  handler. The re-entrant `setTransient` is safe because the session/key are settled
  first (the same accepted re-entry pattern as stop-on-focus-exit).
- **External edits mid-session** (undo/redo, collab peer, hot-reload): a scene change
  that is neither the session's `staged` nor its `base` re-arms the session on the new scene.
  This refreshes the stale `base` and the possibly-colliding pre-allocated `id`.

### Why the shared id matters

The staged preview and the committed part are **one entry** in the view. The commit
re-syncs it in place: no teardown, no rebuild, no WebGPU pipeline re-warm, no blank
frame. So there is no drop flash to patch.

### The sim never sees the preview

The staged part is render-only until commit. While the session's staged transient is current, the live-edit push into a
running sim pushes `session.base` instead, and dedupes by identity (`prevSimScene`). So per-move streams cost the
worker no work, and the drop pushes the committed scene like any other edit. This uses the same seam as part-scene
isolation (`commsScene`/`forSim`).

### The view's share (`setStaging(id | null)`)

The view sees a normal entry plus an id tag, never a "ghost part". The staged part **renders exactly like every
other part**: real materials, real shadows, occluded by walls, pass 1 of the layered render. It is pixel-identical
to what the drop commits. A draw-over-walls overlay would make preview shadows impossible, because an overlay is
hidden while pass 1 renders the shadow map. The case it would serve, the camera outside a closed building, is
covered by roof auto-hide and the building-shell toggle, as for reposition drags.

The tag only governs interaction:

- Excluded from: `pickPart`/`pickPartsAt` (not selectable), `surfaceAt`/`surfaceBelow`
  (never a rest surface, least of all its own), the instance pool (`poolExempt`; it
  re-poses every pointer-move, and pooled matrices are for settled static hardware),
  and the idle cargo batch. A staged cargo part renders its real GLB entry directly
  (see `intendedVisible`), so it previews while running too, where the batch shows only
  live bodies.
- Flow arrow forced visible on the staged conveyor (placement-orientation cue,
  independent of the global toggle).
- First appearance goes through the normal `pumpWarm` hidden-hold (WebGPU), the
  entry-lifecycle warm.

## What the preview shows

- The preview casts and receives shadows and is occluded by walls, like any part.
- Snap merges preview live: dragging a spur against a belt shows the host's guard
  opening and the rail fold before the drop (they derive from part adjacency in
  `syncScene`). Snap `targetParamOverrides` apply only at commit, as in a reposition drag.
- A staged building takes part in scene lighting/backdrop resolution and gets the
  tiled-template upgrade during placement.
- Undo history, saves, autosave and collab commits never see transients. The commit's
  `before` is pinned to `base`.
