# Scene composition

OIP composes a scene from parts, groups and soft parenting, and reuses a definition through **parts**. A scene is
data. It compiles to the runtime, which is the deterministic SimCore, Jolt in a worker and three.js. The scene itself
holds no running objects.

## The data model

- **A scene is a flat list of parts.** Each entry carries its type, a world-space position and rotation, and params
  (`src/core/types/`, `scene.ts`). Connectivity is derived from geometry, never stored.
- **Soft parenting.** A part's optional `parent` is the id of its parent in the scene tree
  (`PartBase.parent`, [types/base.ts](../src/core/types/base.ts)). Positions stay world-space, so the sim and the
  renderer are unaffected, but the editor treats a parent and its descendants as a rigid group: moving or rotating
  the parent carries its subtree, and delete and duplicate act on the whole subtree.
- **Group** is a part type with no mesh and no sim body, a container for a subtree.
- **A part is a saved, instanceable definition.** A placed part references its package by id, and every placement
  follows the package, so editing a part's definition updates every copy
  ([part-sources.md](part-sources.md)). A rig nests its own nodes with local frames (`rigPose.ts`).
- **`partRef`** is a param that names another part by id (the spawner interlock).

## The build seam

```
authoring layer (the scene)  ──build/flatten──▶  runtime (SimCore + Jolt + three.js)
  parts, soft parents,                              world-space bodies, instanced render,
  packages                                          deterministic step
```

`src/sim/world.ts` builds world-space Jolt bodies from the scene. `src/core/determinism.ts` needs only a stable
traversal order.

## Composition, not propagation

- **Composition** builds a scene from reusable pieces by copying. Group containers and Duplicate provide it, and
  copies are cheap.
- **Propagation** (edit once, update everywhere) needs a single source of truth. It belongs to parts: a **part** is
  one package that every placement follows.

There is no second definition-and-instance system beside parts: no linked masters, no per-instance override diffs,
and no saved groups of parts. Such a system would be a rare bulk edit that multi-select or an agent already handles.

## Why there are no assemblies

A saved group of parts inserted as a plain copy is a frozen layout: fixed positions, fixed PLC tags, fixed references
to the parts around it. Inserting one twice gives two cells reading and driving the same tags. A `partRef` to a part
outside the group keeps its old id (pointing at nothing, or at whatever later took that id), and the copy is not
seated on anything. Inside one project, Group + Duplicate does the same copy, placed where the user is working.

Reuse belongs where it adapts to where it goes: a **part** for one machine every placement follows, and for a layout,
generating it in place (`core/lineScaffold.ts`, an agent through the agent door) rather than pasting a snapshot.

Older documents still read. Saved assemblies are left out on read, with a repair saying so, and copies already placed
are ordinary parts (docs/projects.md). Fields of linked copies (`masterId`, `instanceId`, `masterKey`, `overrides`)
are dropped like any unknown field, which changes nothing on screen because each copy is a full, world-space set of
parts.

## PLC tags

There is no tag scoping. A part's tags are the names its tag params say, and the program binds them by wiring by
name. A copy of a cell is wired to its own tags through its parts' tag params (`duplicate-parts` renames them). A
prefix scheme on a group would be a second naming scheme beside wiring by name, and it would hide the prefixed parts
from the wiring check. A document that sets `tagScope` on a group loads with a repair line, because without the
prefix its copies of a cell share the same tags.

The way real controllers name a cell's signals, an instance of a structured type or block (`Cell3.Motor`), is
available in the PLC engine.

## Related

- `docs/architecture.md` - the core/adapter seam this build step sits on; built-ins are
  custom parts on the public SDK.
