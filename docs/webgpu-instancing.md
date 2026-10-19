# WebGPU instancing: the resize and duplicate hitch

Adding, duplicating or extending an instanced part (a conveyor, for example) can stutter under WebGPU, because three
compiles a fresh render pipeline for **every** InstancedMesh object. Its vertex WGSL embeds a per-object buffer-struct
id, so structurally identical banks never share a pipeline. Two mitigations cover it:

- **Program-cache dedup** (`pipelineDedup.ts`) normalizes that per-object id, so identical banks share one compiled
  pipeline and adding or duplicating a part costs about what it does under WebGL.
- **Capacity bucketing** (`bucketCapacity`) keeps a resize under its allocated buffer, so no fresh mesh is minted.

Both work around a coupling in three. They are unnecessary once three keys render pipelines on structure
(see [What would make them unnecessary](#what-would-make-them-unnecessary)).

## The coupling (why every InstancedMesh compiles its own pipeline under WebGPU)

three's `WebGPURenderer` node system renders an InstancedMesh's `instanceMatrix` as a uniform buffer whose WGSL
struct is named **`NodeBuffer_<node.id>`**: the buffer node's global id, unique per mesh object (see three's
`createInstanceMatrixNode` and the WGSL builder's `name ? name : 'NodeBuffer_' + id`). The vertex program is
cached by its WGSL string and the render pipeline by the program id (`stageVertex.id + stageFragment.id +
backendState`). So two structurally identical instanced meshes emit vertex WGSL that differs only in that struct
name. That gives a distinct program, a distinct pipeline, and a cold compile for every fresh instanced mesh.
Consequences:

- **Duplicate, instantiate, paste.** A new part is all fresh meshes, so each bank cold-compiles a pipeline on the draw
  path. Measured without the mitigations (headed GPU, demo scene), a roller-conveyor duplicate takes about 250 ms and
  a platform about 1 s, every time. A Diverter (a GLB rig with no instancing) duplicates in about 50 ms because its
  programs dedupe. So the cost is the instancing, not the part.
- **Resize, extend.** Growing a bank past its buffer capacity mints a **new** `InstancedMesh` (three also captures
  `instanceMatrix.array` by reference, so a buffer can't grow in place), and the new object cold-compiles. That is
  the one-frame hitch when extending a conveyor.

Banks are minted in three places:

- `src/render/parts/instanceBank.ts` (`growBank` / `InstanceBank`) is the single mint site for per-part banks
  (rollers, axle stubs, legs, frame and leg bolts, array links). `common.ts`'s `ensureInstanceCapacity` and
  `createInstancePool` are thin facades over it.
- `src/render/parts/instancedTemplate.ts` (`realizeInstancedTemplate`) builds SDK `MeshPart.instances` banks. Its
  callers (`sdk/functionMesh.ts`, `sdk/rig.ts`) mint a new bank when the count outgrows its bucket. They do not go
  through `InstanceBank`.
- `src/render/viewport/instancePool.ts` (`ensureCapacity`), the scene-wide merged-hardware pool, has its own
  persistent-object lifecycle.

**WebGL is unaffected.** Instanced attributes are count-independent there, and buffer size is not part of the
pipeline key. This is a problem of the WebGPU node backend only.

## The structural model

Engines with a structural pipeline key draw these as one batched object and, on resize, set the instance count on the
**same** object. The per-instance transforms live in a **storage buffer bound at draw time**, and the compiled
pipeline is keyed on **shader + vertex format + framebuffer format**, not the buffer or the object identity. Growing
the buffer never invalidates the pipeline, because instance count is a runtime draw parameter, not a pipeline
property.

## Program-cache dedup (add and duplicate)

`src/render/viewport/pipelineDedup.ts` (`installInstancePipelineDedup(renderer)`) is installed in
`createWebGPURenderer` right after `renderer.init()`, before any program compiles. It wraps three's internal
`_pipelines.programs.{vertex,fragment}` maps so their key is normalized: `NodeBuffer_<id>` becomes `NodeBuffer_N`.
Two shaders that differ only in that per-object struct name map to one cached program and one pipeline, as under
WebGL. A duplicate of a part already in the scene compiles **0** new bank pipelines. The first instance of a shape
compiles once and every later copy reuses it.

- **Correct.** The buffer binds by `@group/@binding` (untouched) from each mesh's own bind groups, so sharing a
  program across distinct instance buffers renders identically. The demo shows no pixel difference between dedup on
  and `?nopipelinededup`.
- **Safe merge only.** The id is stripped but not the array size (`array<mat4x4<f32>, capacity>`). Two banks at
  different capacities keep distinct keys, because merging them would bind a too-small buffer to a shader that
  reads past it. `bucketCapacity` coarsens capacity so an identical duplicate falls into the same bucket and fully
  dedupes.
- **Kill switch.** `?nopipelinededup`. It feature-detects three's map shape and does nothing if a three bump changes
  it, which degrades to stock per-mesh compiles: slower, never wrong.
- **Verification.** `e2e/verify-webgpu-duplicate-amortizes.mjs` runs real WebGPU (Dawn) and asserts the second
  duplicate of a roller conveyor adds at most 4 vertex programs (about 9 with `?nopipelinededup`).
- **What it does not cover.** The per-object node-to-WGSL **codegen** still runs synchronously on the draw path: the
  pipeline is reused, but the render object is still built. For heavy parts the incremental pre-warm (`viewWarm.ts`
  `pumpWarm`) hides that residual: a freshly added part is held hidden while `compileAsync` runs its codegen off the
  draw path, then revealed. Measured with dedup and pre-warm, a duplicate hitches about 90 ms (roller) and 120 ms
  (platform), against about 250 ms and 1 s without them.

Binding `instanceMatrix` as a `StorageInstancedBufferAttribute` is not enough on its own: three names the *storage*
buffer node `NodeBuffer_<id>` too, so the WGSL still differs per object and nothing dedupes. Storage changes
`var<uniform>` to `var<storage>` but not the naming. The program-cache dedup is what collapses them.

## Capacity bucketing (resize)

`src/render/parts/instanceCapacity.ts` (`bucketCapacity(n)`) rounds every instance-buffer request up to the next power
of two, with a floor of 128. The floor is high because capacity is baked into the shader (`array<mat4x4<f32>,
CAPACITY>`), so every distinct capacity is another pipeline. Floor 128 puts the demo's banks on two capacities and
saves 28 pipelines for about 0.85 MB more instance-matrix memory, measured with `e2e/probes/shader-similarity.mjs`
(see the header of `instanceCapacity.ts`). Because buffers are sized to a coarse bucket instead of exact-fit, a
typical interactive resize stays **under** the allocated capacity. The reconcile rewrites the same mesh's transforms
in place, the uuid and its warm pipeline are kept, and there is no hitch. A mint fires only when a resize crosses a
bucket boundary (O(log final size) over a whole drag, and never on the first small nudge from a loaded size). three
sizes the WebGPU instance uniform to buffer capacity, so drawing with `mesh.count` below capacity is correct. Above
the floor, a bank over-allocates less than 2x.

The capacity policy (bucket plus at least 2x doubling headroom) and the WebGPU mint-on-grow for per-part banks live
in `src/render/parts/instanceBank.ts` (`growBank` / `InstanceBank`). Every per-part bank grows through it, so a change
to the mint branch touches no call site. The scene pool and the SDK template banks are separate (see the mint sites
above).

**Verification:**
- `src/render/parts/instanceCapacity.test.ts`: bucketing properties (power of two at least n, under 2x waste,
  monotonic).
- `src/render/parts/instanceBank.test.ts`: reuse under capacity, mint-on-grow carries layer mask and
  shadow flag, doubling headroom, `write` / `dispose`.
- `src/render/parts/instancedTemplate.test.ts`: a bank reserves headroom above its live count (5 gives
  `bucketCapacity(5)` = 128).
- `e2e/verify-webgpu-resize-no-recompile.mjs`: real WebGPU, one `commit`. A modest extend adds instances and
  re-mints **0** bank meshes.
- `e2e/verify-webgpu-resize-drag-mints.mjs`: real WebGPU, the gizmo path. A 15-step `setTransient` drag adds ~170
  instances with re-mints bounded by bucket crossings, far below the step count.
- `verify-webgpu-leg-grow` checks that grown legs are not invisible.

## What would make them unnecessary

three keys render pipelines by program id (`Pipelines._getRenderCacheKey` is
`stageVertex.id + ',' + stageFragment.id + ',' + backend.getRenderCacheKey(renderObject)` in
`three/src/renderers/common/Pipelines.js`). The mitigations are unneeded if three either:

1. keys **render** pipelines on a structural key (shader + binding layout) rather than the mesh, **or**
2. binds `instanceMatrix` as an **index-read storage buffer** decoupled from the node graph and the object id.

Then `growBank`'s mint-fresh branch, `bucketCapacity` and `pipelineDedup` can all go. Because every per-part bank
grows through `InstanceBank`, removing the mint branch is a one-file change. Related upstream issues:

- [mrdoob/three.js#32099](https://github.com/mrdoob/three.js/issues/32099): an InstancedMesh's instance count is
  baked at first render under WebGPU. Closed as not planned: growing past the first render is not supported.
- [mrdoob/three.js#32735](https://github.com/mrdoob/three.js/issues/32735): the pipeline cache is keyed on
  `node.id`, with a proposal for a structural key, scoped to compute pipelines. The same idea applied to render
  pipelines would remove the coupling.

The project does not carry a private patch against three for this.

## BatchedMesh for what the instance pool cannot take

The meshes the instance pool cannot take (moving rig links, jointed parts) each draw on their own. Batching them into
material-keyed `BatchedMesh`es would cut the demo's WebGL draws from 339 to 240 (measured), but the app does not do
it:

- WebGPU has no multi-draw, so three draws a `BatchedMesh` as one draw per instance. The gain is zero there, and the
  same mechanism in `staticFold` took idle WebGPU draws from 22 to 99 when tried.
- Per-instance culling cannot help under render bundles, which record the draw list once.

A batching path would need a WebGPU indirect or multi-draw path for `BatchedMesh` in three. It would also need one
invalidation seam shared with `instancePool`, not a separate manager that re-derives the pool's `poolUnit` /
`poolHidden` flags: the pool changes those flags behind its exempt-key gate, so a separate manager goes stale after a
selection.
