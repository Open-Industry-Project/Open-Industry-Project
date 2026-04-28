@tool
class_name ConveyorLiveSnap
extends Node

## Live snap for conveyors during gizmo drags and drop-hover. Hold Alt to escape.

const SEARCH_RADIUS: float = 3.0
## Per-feature `visible_threshold` overrides this (e.g. BladeStop = 2.0).
const VISIBLE_THRESHOLD: float = 0.3
## Below this dot product, the snap rotates the part and requires aim
## within VISIBLE_THRESHOLD regardless of body-overlap.
const FACING_PRESERVED_DOT: float = 0.85
const SNAP_DISABLE_MODIFIER: Key = KEY_ALT
const _BASELINE_REVERSE_META := &"_snap_baseline_reverse"
const _BASELINE_FLOOR_META := &"_snap_baseline_floor_plane"
const _BASELINE_LEGS_XFORM_META := &"_snap_baseline_legs_xform"
## Locks the flip decision on first engage so pair shifts mid-hover don't
## oscillate `reverse_belt` as the snap result's `needs_reverse_belt` flips.
const _FLIP_DECISION_META := &"_snap_flip_decision"

var _selected: Node3D = null
var _target: Node3D = null
var _snap_result: Dictionary = {}
var _mode_locked: bool = false
var _mode_is_end_to_end: bool = false
## Variant so null means "not yet captured".
var _pre_snap_transform: Variant = null
var _pre_snap_reverse: Variant = null
## Lock the flip decision until snap fully disengages — the setter's side effects
## and pair-shift-induced flips would otherwise oscillate `reverse_belt`.
var _flip_locked: bool = false
var _active_snap: bool = false
## Re-entry guard for our own commit_action firing history_changed.
var _committing: bool = false
var _candidate_cache: Array[Dictionary] = []
var _candidate_cache_node: Node3D = null
var _cache_sel_features: Variant = null
var _cache_sel_end_info: Array = []
var _active_preview_count: int = 0
var _preview_snap_pending: Dictionary = {}


func _enter_tree() -> void:
	if not Engine.is_editor_hint():
		return
	set_process(true)
	EditorInterface.get_editor_undo_redo().history_changed.connect(_on_undo_history_changed)
	get_tree().node_added.connect(_on_node_added_for_preview)


func _exit_tree() -> void:
	if not Engine.is_editor_hint():
		return
	var undo_redo := EditorInterface.get_editor_undo_redo()
	if undo_redo.history_changed.is_connected(_on_undo_history_changed):
		undo_redo.history_changed.disconnect(_on_undo_history_changed)
	if get_tree() and get_tree().node_added.is_connected(_on_node_added_for_preview):
		get_tree().node_added.disconnect(_on_node_added_for_preview)


func _process(_delta: float) -> void:
	if not Engine.is_editor_hint():
		return
	_ensure_hook()


func _on_undo_history_changed() -> void:
	if _committing:
		return
	if _active_snap and _pre_snap_transform != null:
		_commit()
	if not _preview_snap_pending.is_empty():
		# Defer: dropped scene's SideGuard children don't exist until next idle.
		var pending := _preview_snap_pending
		_preview_snap_pending = {}
		_commit_preview_snap_guards.call_deferred(pending)
	_reset()


func _on_node_added_for_preview(node: Node) -> void:
	if not Engine.is_editor_hint():
		return
	if not (node is Node3D) or not _is_snappable(node as Node3D):
		return
	var edited_root := EditorInterface.get_edited_scene_root()
	if edited_root == null:
		return
	# Drop previews live outside the edited root.
	if edited_root == node or edited_root.is_ancestor_of(node):
		return
	if node.has_meta(&"_snap_transform"):
		return
	_preview_snap_pending = {}
	_active_preview_count += 1
	node.set_meta(&"_snap_transform", _on_preview_snap.bind(node))
	node.tree_exiting.connect(_on_preview_exiting.bind(node), CONNECT_ONE_SHOT)


func _on_preview_exiting(node: Node) -> void:
	_active_preview_count = maxi(0, _active_preview_count - 1)
	# Deferred: drops free the preview before commit_action fires.
	_clear_preview_pending_if_match.call_deferred(node)


func _clear_preview_pending_if_match(node: Node) -> void:
	if _preview_snap_pending.get("preview") == node:
		_preview_snap_pending = {}


## Returns the snap pose when engaged, `null` otherwise. `null` makes the fork
## fall back to bounds-offset placement so non-snap drops still rest on the surface.
func _on_preview_snap(proposed: Transform3D, node: Node3D) -> Variant:
	_snapshot_baselines(node)
	var snap_disabled := not ConveyorSnapping.live_snap_enabled or Input.is_physical_key_pressed(SNAP_DISABLE_MODIFIER)
	var found: Dictionary = {} if snap_disabled else _find_snap(node, proposed)

	if found.is_empty():
		_preview_snap_pending = {}
		_restore_preview_state(node)
		return null

	# Side-effect scale: fork orthonormalizes the returned basis on drop hover.
	if found.result.has("scale"):
		var target_scale: Vector3 = found.result.scale
		if not node.scale.is_equal_approx(target_scale):
			node.scale = target_scale
	_apply_preview_reverse_flip(node, found.result)
	_apply_preview_floor(node, found.result.transform, found.target)
	found["preview"] = node
	_preview_snap_pending = found
	return found.result.transform


static func _snapshot_baselines(node: Node3D) -> void:
	var reverse_prop := ConveyorSnapping.get_reverse_property_name(node)
	if reverse_prop != &"" and not node.has_meta(_BASELINE_REVERSE_META):
		node.set_meta(_BASELINE_REVERSE_META, bool(node.get(reverse_prop)))
	var legs := node.get_node_or_null("%ConveyorLegsAssembly")
	if legs == null:
		return
	if &"floor_plane" in node and not node.has_meta(_BASELINE_FLOOR_META):
		node.set_meta(_BASELINE_FLOOR_META, node.get(&"floor_plane"))
	if not legs.has_meta(_BASELINE_LEGS_XFORM_META):
		legs.set_meta(_BASELINE_LEGS_XFORM_META, legs.transform)


static func _apply_preview_reverse_flip(node: Node3D, result: Dictionary) -> void:
	var prop := ConveyorSnapping.get_reverse_property_name(node)
	if prop == &"":
		return
	if not node.has_meta(_FLIP_DECISION_META):
		node.set_meta(_FLIP_DECISION_META, bool(result.get("needs_reverse_belt", false)))
	var baseline: bool = bool(node.get_meta(_BASELINE_REVERSE_META))
	var should_flip: bool = bool(node.get_meta(_FLIP_DECISION_META))
	var target_value: bool = (not baseline) if should_flip else baseline
	if bool(node.get(prop)) != target_value:
		node.set(prop, target_value)


## Drives the legs through the inherited target floor with the explicit snap
## pose; `is_preview` gates `_update_floor_plane` on preview legs, so we mask
## the meta around the explicit recompute call.
static func _apply_preview_floor(node: Node3D, snap_xform: Transform3D, target: Node3D) -> void:
	var legs := node.get_node_or_null("%ConveyorLegsAssembly")
	if legs == null or not (&"floor_plane" in node):
		return
	var floor_plane := _resolve_target_floor_plane(node, snap_xform.origin, target)
	legs.restore_floor_plane(floor_plane)
	var had_meta: bool = legs.has_meta("is_preview")
	if had_meta:
		legs.remove_meta("is_preview")
	legs.call(&"_update_floor_plane", snap_xform)
	if had_meta:
		legs.set_meta("is_preview", true)


static func _restore_preview_state(node: Node3D) -> void:
	if node.has_meta(_FLIP_DECISION_META):
		node.remove_meta(_FLIP_DECISION_META)
	var reverse_prop := ConveyorSnapping.get_reverse_property_name(node)
	if reverse_prop != &"" and node.has_meta(_BASELINE_REVERSE_META):
		var baseline_reverse: bool = bool(node.get_meta(_BASELINE_REVERSE_META))
		if bool(node.get(reverse_prop)) != baseline_reverse:
			node.set(reverse_prop, baseline_reverse)
	var legs := node.get_node_or_null("%ConveyorLegsAssembly")
	if legs == null or not legs.has_meta(_BASELINE_LEGS_XFORM_META):
		return
	var saved_xform: Transform3D = legs.get_meta(_BASELINE_LEGS_XFORM_META) as Transform3D
	var changed: bool = false
	if node.has_meta(_BASELINE_FLOOR_META):
		var saved_global: Plane = node.get_meta(_BASELINE_FLOOR_META) as Plane
		if (node.get(&"floor_plane") as Plane) != saved_global:
			# is_preview gates the legs.transform sub-update inside `_apply_floor_plane`,
			# so this just resets the cached global plane.
			legs.restore_floor_plane(saved_global)
			changed = true
	if not legs.transform.is_equal_approx(saved_xform):
		legs.transform = saved_xform
		changed = true
	if changed:
		legs.call(&"_update_conveyor_legs_height_and_visibility")


static func _resolve_target_floor_plane(node: Node3D, origin: Vector3, target: Node3D) -> Plane:
	# Walk up to the closest ancestor that exposes floor_plane — snap targets
	# are often the inner corner (which lacks the property) wrapped in an
	# assembly (which has it).
	var floor_source: Node3D = target
	while is_instance_valid(floor_source) and not (&"floor_plane" in floor_source):
		floor_source = floor_source.get_parent() as Node3D
	if is_instance_valid(floor_source):
		var inherited: Plane = floor_source.get(&"floor_plane")
		if inherited.normal != Vector3.ZERO:
			return inherited
	# Exclude both source and target so the ray skips the live new-node body
	# (commit path) and the target's own collider top.
	var exclude_rids: Array = []
	if is_instance_valid(node):
		_collect_collision_rids(node, exclude_rids)
	if is_instance_valid(target):
		_collect_collision_rids(target, exclude_rids)
	return _detect_floor_below(node, origin, exclude_rids)


func _commit_preview_snap_guards(pending: Dictionary) -> void:
	var target: Node3D = pending.get("target")
	var result: Dictionary = pending.get("result", {})
	var preview: Node3D = pending.get("preview")
	if result.is_empty():
		return
	var new_node := _pick_snappable()
	if new_node == null or not is_instance_valid(new_node):
		return

	var should_apply_scale: bool = result.has("scale")
	var should_open_guards: bool = (target != null and is_instance_valid(target)
			and not _should_skip_guards(new_node, result))
	var reverse_prop := ConveyorSnapping.get_reverse_property_name(new_node)
	var should_apply_reverse: bool = false
	var reverse_value: bool = false
	if reverse_prop != &"" and is_instance_valid(preview):
		reverse_value = bool(preview.get(reverse_prop))
		should_apply_reverse = reverse_value != bool(new_node.get(reverse_prop))
	# Snap bypasses _collision_repositioned, so a fresh node would otherwise
	# keep its saved-scene default floor instead of the target's.
	var should_apply_floor: bool = false
	var floor_value: Plane
	if &"floor_plane" in new_node:
		floor_value = _resolve_target_floor_plane(new_node, result.transform.origin, target)
		should_apply_floor = floor_value != (new_node.get("floor_plane") as Plane)
	if not should_apply_scale and not should_open_guards and not should_apply_reverse and not should_apply_floor:
		return

	var undo_redo := EditorInterface.get_editor_undo_redo()
	_committing = true
	undo_redo.create_action("Create Node", UndoRedo.MERGE_ALL)

	if should_apply_scale:
		undo_redo.add_do_property(new_node, "scale", result.scale as Vector3)

	if should_apply_reverse:
		undo_redo.add_do_property(new_node, reverse_prop, reverse_value)

	if should_apply_floor:
		undo_redo.add_do_property(new_node, "floor_plane", floor_value)

	if should_open_guards:
		var is_diverter := ConveyorSnapping._is_diverter(new_node)
		if is_diverter:
			ConveyorSnapping._open_side_guards_for_diverter(undo_redo, result.transform, new_node, target)
		else:
			ConveyorSnapping._connect_side_guards(undo_redo, new_node, target, result.transform, true)
		# Skip undo on new_node: its subtree is removed on Create Node undo.
		ConveyorSnapping._register_state_sync(undo_redo, [target])
		ConveyorSnapping._register_state_sync(undo_redo, [new_node], true)

	undo_redo.commit_action()
	_committing = false


func _ensure_hook() -> bool:
	var selected := _pick_snappable()
	if selected == null:
		if _pre_snap_transform == null and _active_preview_count == 0:
			_unhook()
			_reset()
		return false

	if _selected != null and _selected != selected:
		if _active_snap and _pre_snap_transform != null:
			_commit()
		_unhook()
		_reset()

	_selected = selected
	# Always rebind: Ctrl+D copies meta, so the duplicate would stay bound to the original.
	selected.set_meta(&"_snap_transform", _on_gizmo_transform.bind(selected))
	return true


func _unhook() -> void:
	if _selected != null and is_instance_valid(_selected):
		_selected.remove_meta(&"_snap_transform")


func _reset() -> void:
	_selected = null
	_target = null
	_snap_result = {}
	_mode_locked = false
	_mode_is_end_to_end = false
	_pre_snap_transform = null
	_pre_snap_reverse = null
	_flip_locked = false
	_active_snap = false
	_candidate_cache.clear()
	_candidate_cache_node = null
	_cache_sel_features = null
	_cache_sel_end_info = []
	ConveyorSnapping.live_type_cache.clear()
	ConveyorSnapping.live_end_info_cache.clear()
	# _preview_snap_pending belongs to the drop-hover flow, not this gizmo flow.


func _on_gizmo_transform(proposed: Transform3D, selected: Node3D) -> Transform3D:
	if not ConveyorSnapping.live_snap_enabled or Input.is_physical_key_pressed(SNAP_DISABLE_MODIFIER):
		_restore_pre_snap_reverse()
		_active_snap = false
		return proposed

	var found := _find_snap(selected, proposed)
	if found.is_empty():
		_restore_pre_snap_reverse()
		_active_snap = false
		return proposed

	var is_end: bool = found.result.get("is_end_to_end", false)
	if _mode_locked and is_end != _mode_is_end_to_end:
		_restore_pre_snap_reverse()
		_active_snap = false
		return proposed

	if _pre_snap_transform == null:
		_pre_snap_transform = proposed
	_accept(found)
	_apply_live_reverse_flip()
	_active_snap = true
	return _snap_result.transform


func _apply_live_reverse_flip() -> void:
	if _flip_locked:
		return
	_flip_locked = true
	if not _snap_result.get("needs_reverse_belt", false):
		return
	var prop := ConveyorSnapping.get_reverse_property_name(_selected)
	if prop == &"":
		return
	if _pre_snap_reverse == null:
		_pre_snap_reverse = bool(_selected.get(prop))
	var target_value: bool = not bool(_pre_snap_reverse)
	if bool(_selected.get(prop)) != target_value:
		_selected.set(prop, target_value)


func _restore_pre_snap_reverse() -> void:
	_flip_locked = false
	if _pre_snap_reverse == null or not is_instance_valid(_selected):
		return
	var prop := ConveyorSnapping.get_reverse_property_name(_selected)
	if prop == &"":
		return
	if bool(_selected.get(prop)) != bool(_pre_snap_reverse):
		_selected.set(prop, bool(_pre_snap_reverse))


func _accept(found: Dictionary) -> void:
	_target = found.target
	_snap_result = found.result
	if not _mode_locked:
		_mode_locked = true
		_mode_is_end_to_end = _snap_result.get("is_end_to_end", false)


static func _should_skip_guards(selected: Node3D, result: Dictionary) -> bool:
	return (
		result.get("is_end_to_end", false)
		or ConveyorSnapping._is_chain_transfer(selected)
		or ConveyorSnapping._is_blade_stop(selected)
	)


func _commit() -> void:
	if _snap_result.is_empty() \
			or not is_instance_valid(_selected) \
			or not is_instance_valid(_target):
		return

	var skip_guards := _should_skip_guards(_selected, _snap_result)
	var reverse_prop := ConveyorSnapping.get_reverse_property_name(_selected)
	var has_reverse_flip: bool = (
		_pre_snap_reverse != null
		and reverse_prop != &""
		and bool(_selected.get(reverse_prop)) != bool(_pre_snap_reverse)
	)
	if skip_guards and not has_reverse_flip:
		return

	var undo_redo := EditorInterface.get_editor_undo_redo()
	var is_diverter := ConveyorSnapping._is_diverter(_selected)
	var action_name := "Snap Diverter" if is_diverter else "Snap Conveyor"
	_committing = true
	undo_redo.create_action(action_name)
	# Bundle transform with guard opening so one Ctrl+Z reverts both.
	if not skip_guards and _pre_snap_transform != null:
		undo_redo.add_do_property(_selected, "global_transform", _snap_result.transform)
		undo_redo.add_undo_property(_selected, "global_transform", _pre_snap_transform)
	if has_reverse_flip:
		undo_redo.add_do_property(_selected, reverse_prop, bool(_selected.get(reverse_prop)))
		undo_redo.add_undo_property(_selected, reverse_prop, bool(_pre_snap_reverse))
	if not skip_guards:
		if is_diverter:
			ConveyorSnapping._open_side_guards_for_diverter(undo_redo, _snap_result.transform, _selected, _target)
		else:
			ConveyorSnapping._connect_side_guards(undo_redo, _selected, _target, _snap_result.transform)
	var nodes_to_sync: Array[Node3D] = [_target, _selected]
	ConveyorSnapping._register_state_sync(undo_redo, nodes_to_sync)
	undo_redo.commit_action()
	_committing = false


## Multi-select skips snap; otherwise the hooked node oscillates against
## siblings the gizmo moves in lockstep.
static func _pick_snappable() -> Node3D:
	var selection := EditorInterface.get_selection()
	if selection == null:
		return null
	var found: Node3D = null
	for n in selection.get_selected_nodes():
		if n is Node3D and _is_snappable(n):
			if found != null:
				return null
			found = n
	return found


static func _is_snappable(node: Node3D) -> bool:
	return (
		ConveyorSnapping._is_diverter(node)
		or ConveyorSnapping._is_blade_stop(node)
		or ConveyorSnapping._is_chain_transfer(node)
		or ConveyorSnapping._is_conveyor(node)
	)


static func _accepts_target(selected: Node3D, target: Node3D) -> bool:
	if target == selected:
		return false
	if not ConveyorSnapping._is_conveyor(target):
		return false
	# Inner conveyor inside an assembly: defer to the assembly so floor_plane
	# inheritance and end-info come from the canonical wrapper.
	var parent := target.get_parent() as Node3D
	if is_instance_valid(parent) and ConveyorSnapping._is_conveyor(parent):
		return false
	if ConveyorSnapping._is_chain_transfer(selected) or ConveyorSnapping._is_blade_stop(selected):
		return ConveyorSnapping._is_roller_conveyor(target)
	return true


## Reads the proposed pose via selected_xform_override to avoid the
## descendant transform-notification cascade on assemblies.
func _find_snap(selected: Node3D, intent: Transform3D) -> Dictionary:
	if _candidate_cache.is_empty() or _candidate_cache_node != selected:
		_build_candidate_cache(selected)
		_candidate_cache_node = selected

	ConveyorSnapping.selected_xform_override = intent
	var on_top_attachment: bool = (
		ConveyorSnapping._is_blade_stop(selected)
		or ConveyorSnapping._is_chain_transfer(selected)
	)

	if _cache_sel_features == null:
		_cache_sel_features = ConveyorSnapFeatures._features_of(selected)
	var sel_features: Array = _cache_sel_features
	var sel_is_curved: bool = ConveyorSnapping._is_curved_conveyor(selected)
	var sel_has_spur: bool = ConveyorSnapping._has_spur_angles(selected)

	# Widen the pre-filter by selected's reach so a long conveyor whose
	# body extends into a target isn't dropped just because its origin sits
	# past SEARCH_RADIUS.
	var sel_reach: float = 0.0
	if &"size" in selected:
		var sel_size: Vector3 = selected.size
		sel_reach = maxf(absf(sel_size.x), absf(sel_size.z)) * 0.5

	# Body-overlap candidates categorically beat interface-only ones;
	# tracked separately since the two ranking metrics aren't comparable.
	var best: Dictionary = {}
	var best_target: Node3D = null
	var best_dist := INF
	var best_is_override: bool = false
	for entry in _candidate_cache:
		var tgt: Node3D = entry.node
		if not is_instance_valid(tgt):
			continue
		# XZ-only to match the gate, so an elevated end stays in scope when
		# the cursor sits at floor Y (the gate is also XZ-only for that case).
		if _xz_distance_to_target_box_cached(intent.origin, entry) > SEARCH_RADIUS + sel_reach:
			continue
		var override_threshold: bool = (
			not on_top_attachment
			and _selected_body_overlaps_target(intent, selected, entry)
		)
		if best_is_override and not override_threshold:
			continue
		# Bypasses the discriminator chain in _calculate_snap_transform and
		# spares callees from walking the parent chain on each tgt xform read.
		ConveyorSnapping.target_xform_override = entry.xform
		var result: Dictionary
		if sel_is_curved or entry.is_curved:
			result = _select_curved_snap(intent, _ensure_entry_curved_pairs(entry, selected))
		elif sel_has_spur:
			result = ConveyorSnapping._calculate_spur_snap_transform(selected, tgt, true)
		elif entry.has_spur:
			result = ConveyorSnapping._calculate_snap_to_spur_target_transform(selected, tgt, true)
		else:
			result = ConveyorSnapFeatures.try_snap(
					selected, tgt, true, sel_features, _ensure_entry_features(entry))
		if result.is_empty():
			continue
		var threshold: float = result.get("visible_threshold", VISIBLE_THRESHOLD)
		var snap_xform: Transform3D = result.transform
		var alignment: float = intent.basis.x.normalized().dot(snap_xform.basis.x.normalized())
		var rotation_penalty: float = (1.0 - alignment) * 2.0
		var preserves_facing: bool = alignment >= FACING_PRESERVED_DOT
		var rank_dist: float = intent.origin.distance_to(snap_xform.origin)
		# XZ-only gate so an elevated end engages from the floor; 3D ranking
		# still prefers a floor end over an elevated one at equal XZ.
		var gate_dist: float
		if override_threshold:
			gate_dist = rank_dist
		else:
			gate_dist = _snap_interface_xz_distance(result, selected, intent, tgt, entry.xform)
		if not preserves_facing and gate_dist > VISIBLE_THRESHOLD:
			continue
		if not override_threshold and gate_dist > threshold:
			continue
		var dist: float = rank_dist + rotation_penalty
		if override_threshold and not best_is_override:
			best_is_override = true
			best_dist = INF
		if dist < best_dist:
			best_dist = dist
			best = result
			best_target = tgt

	ConveyorSnapping.selected_xform_override = null
	ConveyorSnapping.target_xform_override = null

	if best.is_empty():
		return {}
	return {"result": best, "target": best_target}


static func _selected_body_overlaps_target(intent: Transform3D, selected: Node3D, entry: Dictionary) -> bool:
	var tgt_size: Variant = entry.size
	if tgt_size == null:
		return false
	var tgt_xform: Transform3D = entry.xform
	var tgt_half: Vector3 = (tgt_size as Vector3) * 0.5
	var tgt_inv_basis: Basis = tgt_xform.basis.orthonormalized().transposed()

	var sel_size: Variant = selected.size if &"size" in selected else null
	if sel_size == null:
		var local: Vector3 = tgt_inv_basis * (intent.origin - tgt_xform.origin)
		return absf(local.x) < tgt_half.x and absf(local.z) < tgt_half.z

	var sel_half: Vector3 = (sel_size as Vector3) * 0.5
	var sel_min_x: float = INF
	var sel_max_x: float = -INF
	var sel_min_z: float = INF
	var sel_max_z: float = -INF
	for sx in [-sel_half.x, sel_half.x]:
		for sz in [-sel_half.z, sel_half.z]:
			var world_corner: Vector3 = intent * Vector3(sx, 0, sz)
			var local_corner: Vector3 = tgt_inv_basis * (world_corner - tgt_xform.origin)
			sel_min_x = minf(sel_min_x, local_corner.x)
			sel_max_x = maxf(sel_max_x, local_corner.x)
			sel_min_z = minf(sel_min_z, local_corner.z)
			sel_max_z = maxf(sel_max_z, local_corner.z)

	return (
		sel_min_x < tgt_half.x and sel_max_x > -tgt_half.x
		and sel_min_z < tgt_half.z and sel_max_z > -tgt_half.z
	)


## Targets don't move during a drag, so cache xform/size/type once. Features and
## curved end-pair geometry are deferred — most candidates fail the per-tick
## distance check and never need them.
func _build_candidate_cache(selected: Node3D) -> void:
	_candidate_cache.clear()
	ConveyorSnapping.live_type_cache.clear()
	ConveyorSnapping.live_end_info_cache.clear()
	_cache_sel_features = null
	_cache_sel_end_info = []
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return
	var nodes: Array[Node3D] = []
	_collect_candidates(root, selected, nodes)
	_populate_node_caches(selected)
	_cache_sel_end_info = ConveyorSnapping._get_end_info(selected)
	for n in nodes:
		var size: Variant = n.size if &"size" in n else null
		var flags: Dictionary = _populate_node_caches(n)
		_candidate_cache.append({
			"node": n,
			"xform": n.global_transform,
			"size": size,
			"is_curved": flags.is_curved,
			"has_spur": flags.has_spur,
		})


func _ensure_entry_features(entry: Dictionary) -> Array:
	if not entry.has("features"):
		entry["features"] = ConveyorSnapFeatures._features_of(entry.node)
	return entry["features"]


func _ensure_entry_curved_pairs(entry: Dictionary, selected: Node3D) -> Array:
	if not entry.has("curved_pairs"):
		entry["curved_pairs"] = _build_curved_snap_pairs(
				selected, entry.node, _cache_sel_end_info, entry.xform)
	return entry["curved_pairs"]


func _build_curved_snap_pairs(selected: Node3D, target: Node3D, sel_ends: Array, target_xform: Transform3D) -> Array:
	var tgt_ends: Array = ConveyorSnapping._get_end_info(target)
	var gap: float = ConveyorSnapping._get_snap_gap(selected, target)
	var sel_outputs: Array[bool] = []
	for se in sel_ends:
		sel_outputs.append(ConveyorSnapping._is_output_end(selected, se))
	var tgt_outputs: Array[bool] = []
	for te in tgt_ends:
		tgt_outputs.append(ConveyorSnapping._is_output_end(target, te))

	ConveyorSnapping.target_xform_override = target_xform
	var pairs: Array = []
	for se_idx in range(sel_ends.size()):
		var other_pos: Vector3 = sel_ends[1 - se_idx].pos
		for te_idx in range(tgt_ends.size()):
			var se: Dictionary = sel_ends[se_idx]
			var te: Dictionary = tgt_ends[te_idx]
			var snap_t: Transform3D = ConveyorSnapping._snap_end_to_end(selected, se, target, te, gap)
			pairs.append({
				"result": ConveyorSnapping._make_snap_result(snap_t, se, te),
				"other_sel_pos": other_pos,
				"free_end_after": snap_t * other_pos,
				"flow_compatible": sel_outputs[se_idx] != tgt_outputs[te_idx],
			})
	ConveyorSnapping.target_xform_override = null
	return pairs


## Closest pair wins regardless of flow; an opposite-flow winner is tagged so the
## apply step flips `reverse_belt` instead of rotating the conveyor 180°.
static func _select_curved_snap(intent: Transform3D, pairs: Array) -> Dictionary:
	var best: Dictionary = {}
	var best_dist: float = INF
	var best_compatible: bool = false
	for p in pairs:
		var fe_before: Vector3 = intent * (p.other_sel_pos as Vector3)
		var d: float = fe_before.distance_squared_to(p.free_end_after)
		if d < best_dist:
			best_dist = d
			best = p.result
			best_compatible = p.flow_compatible
	if best.is_empty():
		return {}
	var result: Dictionary = best.duplicate()
	result["needs_reverse_belt"] = not best_compatible
	return result


func _populate_node_caches(node: Node3D) -> Dictionary:
	var nid: int = node.get_instance_id()
	var flags: Dictionary = {
		"is_curved": ConveyorSnapping._is_curved_conveyor(node),
		"is_curved_roller": ConveyorSnapping._is_curved_roller_conveyor(node),
		"is_straight": ConveyorSnapping._is_straight_conveyor(node),
		"is_spur": ConveyorSnapping._is_spur_conveyor(node),
		"has_spur": ConveyorSnapping._has_spur_angles(node),
	}
	ConveyorSnapping.live_type_cache[nid] = flags
	ConveyorSnapping.live_end_info_cache[nid] = ConveyorSnapping._get_end_info(node)
	return flags


## Orthonormalized inverse: conveyor bases carry scale; transpose alone would skew.
static func _xz_distance_to_target_box_cached(point: Vector3, entry: Dictionary) -> float:
	var xform: Transform3D = entry.xform
	var size: Variant = entry.size
	if size == null:
		var d := xform.origin - point
		return Vector2(d.x, d.z).length()
	var half: Vector3 = (size as Vector3) * 0.5
	var local: Vector3 = xform.basis.orthonormalized().transposed() * (point - xform.origin)
	var clamped_x: float = clampf(local.x, -half.x, half.x)
	var clamped_z: float = clampf(local.z, -half.z, half.z)
	return Vector2(local.x - clamped_x, local.z - clamped_z).length()


## End-to-end mins over all end pairs; side snaps use the result's pair.
static func _snap_interface_xz_distance(result: Dictionary, selected: Node3D, intent: Transform3D, target: Node3D, tgt_xform: Transform3D) -> float:
	var sel_end: Dictionary = result.get("snapped_end", {})
	var tgt_end: Dictionary = result.get("target_end", {})
	if not sel_end.has("pos") or not tgt_end.has("pos"):
		return _xz_distance(intent.origin, (result["transform"] as Transform3D).origin)

	if result.get("is_end_to_end", false):
		var sel_ends: Array = ConveyorSnapping._get_end_info(selected)
		var tgt_ends: Array = ConveyorSnapping._get_end_info(target)
		var min_dist: float = INF
		for se in sel_ends:
			var se_world: Vector3 = intent * (se.pos as Vector3)
			for te in tgt_ends:
				var te_world: Vector3 = tgt_xform * (te.pos as Vector3)
				var d: float = _xz_distance(se_world, te_world)
				if d < min_dist:
					min_dist = d
		return min_dist

	var sel_end_world: Vector3 = intent * (sel_end["pos"] as Vector3)
	var tgt_end_world: Vector3 = tgt_xform * (tgt_end["pos"] as Vector3)
	return _xz_distance(sel_end_world, tgt_end_world)


static func _xz_distance(a: Vector3, b: Vector3) -> float:
	return Vector2(a.x - b.x, a.z - b.z).length()


## Falls back to world Y=0 if the ray misses; the saved scene's default floor
## plane sits at Y=-2, which is below typical OIP ground.
static func _detect_floor_below(node: Node3D, origin: Vector3, exclude_rids: Array = []) -> Plane:
	var fallback := Plane(Vector3.UP, 0.0)
	if not node.is_inside_tree():
		return fallback
	var world := node.get_world_3d()
	if world == null or world.direct_space_state == null:
		return fallback
	var query := PhysicsRayQueryParameters3D.new()
	query.from = origin + Vector3.UP * 0.01
	query.to = origin + Vector3.DOWN * 100.0
	if not exclude_rids.is_empty():
		query.exclude = exclude_rids
	var hit := world.direct_space_state.intersect_ray(query)
	if hit.is_empty():
		return fallback
	return Plane(hit.normal, hit.position)


static func _collect_collision_rids(node: Node, out: Array) -> void:
	if node is CollisionObject3D:
		out.append((node as CollisionObject3D).get_rid())
	for child in node.get_children():
		_collect_collision_rids(child, out)


static func _collect_candidates(node: Node, selected: Node3D, out: Array[Node3D]) -> void:
	# Skip the selected's whole subtree; assembly children aren't valid targets.
	if node == selected:
		return
	if node is Node3D and _accepts_target(selected, node):
		out.append(node)
	for child in node.get_children():
		_collect_candidates(child, selected, out)
