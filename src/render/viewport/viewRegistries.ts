// The view's per-frame tick-callback registries and what the layered render pass draws on top of the
// main pass: the editor overlays (extracted from view.ts).

import type { Object3D } from 'three'
import { hasVisibleSensorBeam, sensorBeamGroup } from '../sensorBeamOverlay'
import { visualStructureEpoch } from '../parts/structureRev'
import type { Entry, PartTick, PartViewTick, PartProbeTick } from './viewTypes'
import type { RenderView } from './view'

/**
 * Tick-callback registries (refreshTickRegistries), held by the view as `view.registries`: the entries
 * whose visuals registered each per-frame callback, with the callback hoisted off userData, so the
 * per-frame loops iterate O(ticking parts) instead of reading 3 megamorphic userData keys on every entry
 * every frame.
 */
export class ViewRegistries {
  readonly tickRefs: Array<{ entry: Entry; tick: PartTick }> = []
  readonly viewTickRefs: Array<{ entry: Entry; viewTick: PartViewTick }> = []
  readonly probeTickRefs: Array<{ entry: Entry; probeTick: PartProbeTick }> = []
  registriesStructureRev = -1
  registriesVisualEpoch = -1
  // A probeTick can appear after the sync that armed the gate (a sensor's rig attaches
  // asynchronously), and the registry rebuild that picks it up may run after this frame's
  // probe pass. A boolean re-arm set there would be cleared by this frame's own
  // `beamProbeDirty = false`, so the beam is never published and the guards never open. This
  // revision survives that ordering: the gate re-fires whenever the registry moved since the
  // last pass that actually ran, wherever in the frame the rebuild happened.
  probeRegistryRev = 0
}

/** what the registries and the layered-pass collectors reach on the view beyond {@link ViewRegistries} */
export type RegistriesHost = Pick<
  RenderView,
  | 'boxes'
  | 'entries'
  | 'env'
  | 'flowArrowBank'
  | 'gizmo'
  | 'gridVisible'
  | 'handles'
  | 'overlays'
  | 'registries'
  | 'rigGizmoOverlay'
  | 'structureRev'
>

/**
 * Rebuild the tick-callback registries when they can be stale, else O(1). Two staleness
 * signals, both integer compares:
 *  - structureRev - an entry entered/left/reparented (syncScene's diff bumps it on every
 *    membership change, so removed entries can't leave a stale ref ticking a disposed visual);
 *  - visualStructureEpoch - an in-place rebuild created new callback closures (sdkPart.rebuild
 *    reassigns userData.tick/probeTick over the same visual root, and every such rebuild bumps
 *    its structureVersion, which bumps the epoch - the same identity seam the frame-routing
 *    WeakMap and the bundle poll consume). Async attaches bump the epoch too; those rescans
 *    are redundant but harmless, and structural churn frames are already O(parts) elsewhere.
 * Buildings assign their callbacks at factory time and every SDK kind assigns inside rebuild(),
 * so a callback can never appear without one of the two signals moving.
 */
export function refreshTickRegistries(view: RegistriesHost): void {
  const reg = view.registries
  const epoch = visualStructureEpoch()
  if (epoch === reg.registriesVisualEpoch && view.structureRev === reg.registriesStructureRev) return
  reg.registriesVisualEpoch = epoch
  reg.registriesStructureRev = view.structureRev
  const prevProbes = reg.probeTickRefs.slice()
  reg.tickRefs.length = 0
  reg.viewTickRefs.length = 0
  reg.probeTickRefs.length = 0
  for (const entry of view.entries.values()) {
    const ud = entry.visual.object.userData
    if (typeof ud.tick === 'function') reg.tickRefs.push({ entry, tick: ud.tick as PartTick })
    if (typeof ud.viewTick === 'function') reg.viewTickRefs.push({ entry, viewTick: ud.viewTick as PartViewTick })
    if (typeof ud.probeTick === 'function') reg.probeTickRefs.push({ entry, probeTick: ud.probeTick as PartProbeTick })
  }
  // a probeTick may have just appeared (async rig attach, a sensor rig rebuilt its closures); the probe gate re-fires
  // off this revision, which is ordering-independent (see probeRegistryRev). Only then: every part's structure bump
  // reaches this function, and re-casting every beam because a robot's cup bank re-counted is the per-edit
  // whole-scene cost docs/scene-change-consumers.md warns against.
  const probes = reg.probeTickRefs
  if (probes.length !== prevProbes.length || probes.some((r, i) => r.entry !== prevProbes[i]!.entry || r.probeTick !== prevProbes[i]!.probeTick)) {
    reg.probeRegistryRev++
  }
}

/**
 * Editor overlays for the WebGPU path's final sub-pass, drawn over the bundled scene
 * (consolidatedOutlineNode.renderLayeredScene): the transform/resize/ruler manipulators and the
 * rest of OVERLAY_LAYER. Only the currently-active (visible) ones are returned - the pass hides
 * each through the scene pass, then restores it and draws it last on OVERLAY_LAYER. (The placement-staging preview does not qualify: it renders as a
 * normal part - pass 1, real shadows, occlusion - so it stays pixel-identical to the part the
 * drop commits.)
 */
export function collectOverlays(view: RegistriesHost): Object3D[] {
  const out: Object3D[] = []
  if (view.gizmo.root.visible) out.push(view.gizmo.root)
  if (view.handles.root.visible) out.push(view.handles.root)
  // the rig pose gizmo too: drawn in the main pass, its hide would not reach the cached scene projection and the rings
  // would stay on screen after the robot is deselected
  if (view.rigGizmoOverlay.root.visible) out.push(view.rigGizmoOverlay.root)
  if (view.overlays.rulerGroup.visible) out.push(view.overlays.rulerGroup)
  // flow arrows render in the overlay pass too - under WebGPU render bundles the base
  // transparent pass can't draw over bundled content (finishRender executes bundles last),
  // so "always on top" is only deliverable from this post-main sub-pass (see syncFlowArrow)
  if (view.flowArrowBank.hasVisible()) out.push(view.flowArrowBank.group)
  // sensor beams, for the same reason: a depthWrite-off line inside the bundled parts group would be
  // painted over by the bundles the backend executes last, leaving only the stubs the guards'
  // shader-discard holes expose (sensorBeamOverlay.ts). Every beam in the scene is one instanced
  // draw in this pass, and they stay depth-tested, so this restores the draw order without
  // turning them into always-on-top lines.
  if (hasVisibleSensorBeam()) out.push(sensorBeamGroup)
  // the floor reference grid, for the same reason: a depthWrite-off translucent grid 2 mm over the
  // floor would draw in the base transparent pass, which the bundled floor (executed last) paints
  // over, so the toggle would change nothing on screen under WebGPU (env.ts)
  if (view.gridVisible) out.push(view.env.grid)
  // dressings on loads (film, labels), for the same reason: they write no depth, so in the main pass the bundled parts
  // behind them (a fence, a conveyor) would paint over them and a web would come and go with the camera (cargoDressing.ts)
  if (view.boxes.dressing.hasVisible() && view.boxes.dressing.group.visible) out.push(view.boxes.dressing.group)
  return out
}
