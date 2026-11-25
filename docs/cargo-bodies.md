# Cargo bodies

Cargo that declares its own shape and what it is to the machines around it: a drum that rolls, a crate, a plastic
pallet a fork can take, a container that nests. App code reads what a body declares and never names the part
([part-libraries.md](part-libraries.md), "App code names capabilities, not parts"). The Containers library
([libraries/containers](../libraries/containers/)) holds the worked examples: the Drum (rolls), the IBC tote (forks,
heavy, carries a stack) and the Tote (separate contacts, nests), which is on the built-in tote shape. A rig that nests
is a test part, not a shipped one (src/sim/fixtures/nesting-bin), because a second bin beside the Tote would
duplicate it.

## Two kinds of cargo

- **Box, pallet and tote** declare `geometry: { kind: 'cargo', cargoKind, size }`. `cargoView` (core/frame.ts) turns
  one into a kind number (`CARGO_KIND_BOX` / `PALLET` / `TOTE`), half extents, colour, mass and attributes, and every
  consumer after that carries only those fields: a box shape, or the pallet's and tote's compounds
  (sim/cargoRegistry.ts `cargoShape`); one instanced batch for boxes and one per pallet footprint and tote size
  (render/viewport/boxes.ts); sensing against each body's oriented box.
- **A cargo part with its own body** is a `rig` with a `cargo` declaration (`CargoDecl` in core/parts/partPackage.ts:
  `friction`, `massParam`, `colorParam`). It is kind `CARGO_KIND_PART`.

## How a part's own body works

- **Recognised once.** `cargoView` returns a part-bodied view through `partCargoView`, and `isCargoPackage`
  (core/parts/partPackage.ts) is the package-level test the sim, the frame, the scaffold and the product dropdown share.
- **Collider** (core/cargoBody.ts `cargoPieces`): the rig's colliding links at rest pose, by the same rule machine rigs
  use (core/rig/rigLinkBody.ts `rigLinkEmitsBody`). A box link is a box; a cylinder link stays a cylinder (a machine rig's
  cylinder collides as its bounding box). The sim builds one Jolt compound per shape key
  (sim/bodyFactory.ts `buildPartCargoShape`, cached in the cargo registry) and shares it between bodies. A body keeps
  its `shapeKey`, so a unit join or split rebuilds it.
- **Validation:** `validatePartPackage` checks the declaration (a rig, no joints, named params of the right type).
  `validatePart` checks, at default params, that the rig has a colliding link and that their bounds are centred on
  the origin: cargo is centre-origin, and every box-shaped consumer (sensing, wrapping, placement) reads the bounds'
  half extents about the body's position.
- **Frame:** each body carries its shape key (`BoxFrame.shapes`) and the frame carries what each key is
  (`shapeRefs`: product and params). The wire sends shapes like `partIds`, only when they change, and each ref once
  per run (sim/frameWire.ts). The stopped scene's frame (`buildAuthoredCargoFrame`) carries the same, so a placed drum
  draws as a drum before Run.
- **Rendering** (render/parts/partCargoMesh.ts): the part's own visual built once per shape, baked into part-local
  space and merged per material, so every body of that shape draws in one instanced batch per material. The visual is
  built with the colour param white and again black; a material that differs is tinted per body, the rest keep their
  colour. Every attribute is copied out as floats before the bake: a model's can be quantized integers, which a
  matrix baked in place would wrap. A late-loading model moves the visual's structure version, and the batches
  rebuild. An edit to the part's package applies the kept visuals again and rebuilds the batches too
  (`SimBoxes.refreshPackage`): an edit that keeps the colliders keeps the shape's key, so nothing else would replace
  them. The builder loads on the first part-bodied row (a scene without one never loads it); the row draws nothing
  until then.
- **Spawning and promotion:** a Spawner whose Product is such a part spawns it as its shape (sim/cargoFlow.ts
  `spawnProduct`). A pick of a part-bodied body reports its product, so selecting a spawned drum makes it a drum, not
  a box (editor/controller/liveCargo.ts `promotedAs`).
- **Sensing** is unchanged: beams cast against the bounds as an oriented box, zones by centre. A beam on a drum reads
  its bounding box, close enough for a beam across a conveyor.

Tests: src/sim/cargoBodies.test.ts (a drum on its side rolls several times as far as a box of its size slides, it
stands on its end, one collider per shape, and the validation), src/sim/frameWire.test.ts, src/editor/controller/liveCargo.test.ts,
src/render/parts/partCargoMesh.test.ts (quantized, interleaved and multi-material geometry bakes to floats and merges),
and e2e/verify-cargo-bodies.mjs (drums draw as their own visual stopped and running, a Spawner makes drums, 200 drums
cost the draws of 2, a model-drawn part draws its model, and an edit to the part's look reaches the bodies already
drawn).

## Capabilities, not kinds

The engine never asks whether a body is a box, a pallet or a tote. It asks what the body is to the machine in front of
it, as bits on the body (core/frame.ts `CARGO_CAP_*`, `cargoCapsOf`), declared under `cargo` by any cargo part:

| Capability | What reads it | A built-in that has it |
|---|---|---|
| `forkPockets` | a fork's fit check, which says when the spread does not fit a face (sim/rigDriver.ts, core/pallet.ts) | pallet |
| `heavy` | the firmer solver island for a body that bears loads (sim/bodyFactory.ts makeCargoBody), and flow facts, which never count it dropped or tipped | pallet |
| `loadBase` | the stretch wrap, whose film starts at its mid-height, and the anchor of a unit load (core/cargoWrap.ts) | pallet |
| `separateContacts` | manifold reduction off, so a floor hovering over a foot does not sink (sim/bodyFactory.ts) | tote |
| `nestDepth` | placement: a body of the same shape set on it sits this much lower (core/frame.ts cargoSeatOn) | tote (its foot) |

A box, pallet or tote that declares none gets its kind's capabilities (`capsOfKind`), so stored versions keep
simulating as recorded. The old-parts corpus (src/sim/partCorpus.test.ts) checks this: it runs every stored version and
hashes each body's kind and rest pose. The capabilities travel with each body (`LiveBox.caps`) and in the frame (`BoxFrame.caps`); a frame built without
them (a test's) reads each body's kind's (`frameHasCap`).

## What each body is

Every cargo body carries what it was made as: a key (`cargoRefKey`; a part body's shape key) and, in the frame's
`shapeRefs`, its product and params. A placed part and a product spawn carry their own; a kind-only spawn
(`ctx.spawn({ kind })`, kept so stored part versions keep spawning) is the built-in of its kind at the standard its size
snapped to (`kindSpawnRef`). Selecting a spawned body makes it exactly that part (editor/controller/liveCargo.ts
`promotedAs`); a body made as no product stays transient, never a box guessed from its size. `test-project --cargo`, the
probes' rows and the agent's `get_cargo` report the product.

## Why box, pallet and tote keep their built-in shapes

Their colliders and visuals stay the shape kinds `cargoKind: 'box' | 'pallet' | 'tote'`: a generic vocabulary any part
can use, the way a rig link can be a box or a cylinder, not a rule about three parts. Rebuilding them as rigs would need
their standard sizes (an enum param, `'1200x800'`) to drive link sizes, which a rig's param refs cannot, and their
textured meshes (the cardboard and wood atlases) ported to models, a visual risk to every scene for no change in what
they do. Because the engine names none of them, any of them can move to a library like any other part.

What still names them, in src/core/parts/partIdCoupling.test.ts: a kind-only spawn's product (`kindSpawnRef`) and a stored
unit load that names no pieces (`unitPiecesOf`), both for stored part versions.

## Assemblies

A product put together from cargo, one piece a station. A cargo part declares `assembly` in its manifest
(`AssemblyDecl` in core/parts/partPackage.ts) and is then the base: the fixture, or the lower housing.

```json
"assembly": {
  "slots": [
    { "name": "bottom", "part": "phone.bottom", "at": [0, 0.007, 0] },
    { "name": "pcb", "part": "phone.pcb", "at": [0.0007, 0.0119, 0], "after": ["bottom"] },
    { "name": "top", "part": "phone.top", "at": [0, 0.0151, 0], "after": ["pcb"], "maxTurn": 20 }
  ]
}
```

- **A slot** is one component's place: the cargo `part` that goes there, where its centre sits in the base's frame
  (`at`, and `quat` when it is turned), and optionally the slots it comes `after`.
- **Reaching a slot** (core/cargoAssembly.ts `reachesSlot`): the piece's world-axis bounding box overlaps the slot's,
  which is the piece's box at its assembled pose grown by `tolerance` (3 mm unless the slot says). Overlap alone
  catches a long piece from most of its length away and any way round. `reach` limits how far its centre may be
  from its place, and `maxTurn` how far it may be turned.
- **The snap** (sim/cargoFlow.ts `snapAssemblies`, once a step after the grippers): the piece is put exactly in the
  slot and becomes one rigid body with the base and everything on it, a unit load with the base as its anchor
  (sim/cargoRegistry.ts `seatRow`). A piece something holds is left alone, so one in a gripper snaps when the gripper
  opens. A base something holds takes pieces all the same and stays held.
- **`mode`** says what holds a placed piece. `fixed` (the default) is the join above. `loose` only puts the piece in its
  place, once: it stays its own body, held by gravity and friction, so a product moved too hard comes apart. Its slot
  is filled while it is still in its place and opens when it has left. Colliders are bounding boxes, so loose pieces
  that nest in the model (a housing in a pocket) push each other a few millimetres out of place.
- **A fixture** is a second kind of slot, `"hold": true`. It locates a part and keeps it there, always rigidly, but
  what it holds stays a thing of its own. So the product's base is one of its own pieces (the lower housing, with a
  slot per component), and the carrier it is built in has one hold slot for that base:

  ```json
  "assembly": { "slots": [{ "name": "nest", "part": "phone.bottom", "at": [0, 0.007, 0], "hold": true }] }
  ```

  The base takes its components while it is held. Taking the base out takes the product as built and leaves the
  fixture (sim/cargoFlow.ts `liftSeated`), and the product can be set down in any other fixture with a hold slot
  for the same part. A gripper that closes on the product alone lifts it out; one that also closes on the fixture
  takes both (`gripTargets`). A fixture can have several hold slots, for any parts.
- **What collides** (sim/assemblyBodies.ts). Cargo collides as its bounding pieces, so pieces that nest overlap each
  other's boxes. Two rules keep that from pushing a product about. A piece seated on a product that is not whole yet
  is in the load without a collider (`seatedCollides`): the load collides as its anchor, the fixture or the bare
  base, and gets every piece's collider back when the last one is on, or loses them again when one is lifted off.
  And a piece of an assembly that something holds is on an object layer of its own (`LAYER_HELD_PIECE`) that does
  not collide with a load that takes pieces (`LAYER_ASSEMBLY`) or with another held piece, so a gripper can carry it into a pocket. Let go, it
  is taken into its slot, or is plain cargo again and is pushed out of what it overlaps. Both are for pieces that
  are joined; a loose assembly's pieces collide as ever.
- **Moved by hand** (a drag, a pin, the pilot): taken by its base a fixed product stays whole; a held part comes out
  with what is on it; a component with nothing on it comes off alone (sim/cargoFlow.ts `takeOut`).
- **State** is on marks. A product carries each slot's `name` while its piece is on, and `assembled` once every
  component is. With `"product": "phone"` it also carries `phone` then, so a line of several products can sort
  them. A fixture carries each hold slot's name while it is filled, and `occupied` while any is. A load has one set
  of marks, so a product in its fixture reads as both. When the product is lifted out the marks go with it, and the
  fixture is left with what it had empty. A machine reads them like any mark (`ctx.marked`, a beam hit's `marks`),
  and a photoeye with **Only marked targets** set to one gives a PLC a BOOL for it with no part code.
- **`becomes`** swaps a finished product for one body: `"becomes": { "part": "phone.finished", "at": [0, 0.003, 0] }`.
  The step the last piece goes on a fixed assembly, the base and its pieces are removed and one body of that part
  stands where they were (`at`: its centre in the base's frame), with the product's marks, and in the same fixture
  slot if the product was held (`finishProduct`). A hold slot for a part also takes what that part's product has
  become. It is one-way, and what it saves is drawing: a fixed product is already one physics body. The pieces'
  parts stay in the scene and are back on the next run; for the rest of this one they are gone, and an edit of the
  running scene does not build them again (`PartGroup.spent`).
- **Import part > A product assembly…** makes the parts from one `.glb` (core/parts/productImport.ts): each named
  object becomes a cargo part drawing its own node about its box's centre, with a hidden box collider, and the base
  gets a slot per piece from where the model has it. **The first piece is a fixture** makes it a carrier with a hold
  slot and the second piece the product's base. **Finished product** takes a second, simpler model of the whole
  product and sets `becomes` to it; exported from the same file, it stands exactly where the pieces did. A piece can
  be renamed in the dialog: its name is its part's, and as an id segment its slot's, so also the mark that says it
  is on. Importing a product again under the same name replaces its parts under their ids and places no piece the
  scene already has. The Part
  Editor's **Assembly** section edits the declaration afterwards, and turns any cargo part into a base or a fixture.

Three limits to know:

- A product being built collides as its fixture or its base alone, so a piece that stands proud of that passes
  through a guard or a stop until the product is whole. A held piece passes through every load that takes pieces,
  not only the one it is for.
- A product seated in a fixture that something holds (a pinned fixture, one in a gripper) is the holder's too, so a
  gripper cannot take it out. A hand can (a drag, a pin, the pilot).
- A load has one set of marks. A fixture with several hold slots reads every product in it as one, and marks that
  are not the assembly's own go with whichever is lifted out first.

Not in it yet: fastening as its own step (a screw or a weld that fixes a loose piece), an import that maps a
fixture's pieces onto parts the project already has (a kit tray for a product imported earlier), taking one piece
off again by a machine, hold slots on a machine (a station's nest, a mover's plate), and colliders finer than each
piece's bounding box.

## Limits

- **Rollers.** A roller conveyor's deck is one kinematic surface, not individual rollers, so a drum rides it as on a
  belt and never wedges between rollers as a real one can. Boxes get the same simplification.
- **Soft cargo** (sacks, bags) is out of scope: a sack is a rigid body of its shape.
- **Draw cost** with many distinct shapes: each (part, params) pair is its own batches, so drums of twenty sizes are
  twenty sets. Nothing caps the number of distinct shapes.
