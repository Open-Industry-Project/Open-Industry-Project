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
const _PREVIEW_REVERSE_META := &"_snap_preview_reverse_default"
const _PREVIEW_FLIP_LOCKED_META := &"_snap_preview_flip_locked"
const _PREVIEW_FLOOR_META := &"_snap_preview_floor_default"

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


func _on_preview_snap(proposed: Transform3D, node: Node3D) -> Transform3D:
	if not ConveyorSnapping.live_snap_enabled or Input.is_physical_key_pressed(SNAP_DISABLE_MODIFIER):
		_restore_preview_reverse(node)
		_restore_preview_floor(node)
		_preview_snap_pending = {}
		return proposed
	var found := _find_snap(node, proposed)
	if found.is_empty():
		_restore_preview_reverse(node)
		_restore_preview_floor(node)
		_preview_snap_pending = {}
		return proposed
	# Side-effect scale: fork orthonormalizes the returned basis on drop hover.
	if found.result.has("scale"):
		var target_scale: Vector3 = found.result.scale
		if not node.scale.is_equal_approx(target_scale):
			node.scale = target_scale
	_apply_preview_reverse_flip(node, found.result)
	_apply_preview_floor(node, found.result.transform)
	found["preview"] = node
	_preview_snap_pending = found
	return found.result.transform


## Lock-once per preview hover; same oscillation rationale as the gizmo path.
static func _apply_preview_reverse_flip(node: Node3D, result: Dictionary) -> void:
	if node.has_meta(_PREVIEW_FLIP_LOCKED_META):
		return
	node.set_meta(_PREVIEW_FLIP_LOCKED_META, true)
	var prop := ConveyorSnapping.get_reverse_property_name(node)
	if prop == &"":
		return
	if not node.has_meta(_PREVIEW_REVERSE_META):
		node.set_meta(_PREVIEW_REVERSE_META, bool(node.get(prop)))
	if not result.get("needs_reverse_belt", false):
		return
	var original: bool = bool(node.get_meta(_PREVIEW_REVERSE_META))
	var target_value: bool = not original
	if bool(node.get(prop)) != target_value:
		node.set(prop, target_value)
		_sync_preview_overlay_arrow(node, target_value)


static func _restore_preview_reverse(node: Node3D) -> void:
	if node.has_meta(_PREVIEW_FLIP_LOCKED_META):
		node.remove_meta(_PREVIEW_FLIP_LOCKED_META)
	if not node.has_meta(_PREVIEW_REVERSE_META):
		return
	var prop := ConveyorSnapping.get_reverse_property_name(node)
	if prop != &"":
		var original: bool = bool(node.get_meta(_PREVIEW_REVERSE_META))
		if bool(node.get(prop)) != original:
			node.set(prop, original)
			_sync_preview_overlay_arrow(node, original)


## The corner's setter only flips its own internal arrow; the unregistered
## preview-overlay arrow has to be rebuilt separately to stay in sync.
static func _sync_preview_overlay_arrow(node: Node3D, reversed: bool) -> void:
	if node.has_method(&"_rebuild_preview_flow_arrow"):
		node.call(&"_rebuild_preview_flow_arrow", reversed)


static func _apply_preview_floor(node: Node3D, snap_xform: Transform3D) -> void:
	var legs := node.get_node_or_null("%ConveyorLegsAssembly")
	if legs == null:
		return
	if not (&"floor_plane" in node):
		return
	if not legs.has_meta(_PREVIEW_FLOOR_META):
		legs.set_meta(_PREVIEW_FLOOR_META, {
			"xform": legs.transform,
			"global": node.get("floor_plane"),
		})
	# No RID exclusion: preview collisions are pre-disabled by _apply_preview_common.
	var floor_plane := _detect_floor_below(node, snap_xform.origin)
	if (node.get("floor_plane") as Plane) != floor_plane:
		_write_preview_floor(legs, floor_plane, snap_xform)


## Direct transform write; cascading default global re-derives local from the
## current conveyor pos and stretches legs instead.
static func _restore_preview_floor(node: Node3D) -> void:
	var legs := node.get_node_or_null("%ConveyorLegsAssembly")
	if legs == null or not legs.has_meta(_PREVIEW_FLOOR_META):
		return
	var saved: Dictionary = legs.get_meta(_PREVIEW_FLOOR_META)
	var saved_xform: Transform3D = saved["xform"] as Transform3D
	var saved_global: Plane = saved["global"] as Plane
	var changed: bool = false
	if (node.get("floor_plane") as Plane) != saved_global:
		# is_preview gates sub-updates, so this resets the cached global only.
		legs.restore_floor_plane(saved_global)
		changed = true
	if not legs.transform.is_equal_approx(saved_xform):
		legs.transform = saved_xform
		changed = true
	if changed:
		legs.call(&"_update_conveyor_legs_height_and_visibility")


## Local recompute uses the explicit snap pose; conveyor.global_transform is
## still at the pre-snap cursor during the engine's snap callback.
static func _write_preview_floor(legs: Node3D, plane: Plane, snap_xform: Transform3D) -> void:
	legs.restore_floor_plane(plane)
	var had_meta: bool = legs.has_meta("is_preview")
	if had_meta:
		legs.remove_meta("is_preview")
	legs.call(&"_update_floor_plane", snap_xform)
	if had_meta:
		legs.set_meta("is_preview", true)


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
	# Detect the actual floor beneath the snap pose so legs reach it; snap
	# bypasses _collision_repositioned, and target.floor_plane may be stale.
	var should_apply_floor: bool = false
	var floor_value: Plane
	if &"floor_plane" in new_node:
		var exclude_rids: Array = []
		_collect_collision_rids(new_node, exclude_rids)
		floor_value = _detect_floor_below(new_node, result.transform.origin, exclude_rids)
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
		if _distance_to_target_box_cached(intent.origin, entry) > SEARCH_RADIUS + sel_reach:
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
static func _distance_to_target_box_cached(point: Vector3, entry: Dictionary) -> float:
	var xform: Transform3D = entry.xform
	var size: Variant = entry.size
	if size == null:
		return xform.origin.distance_to(point)
	var half: Vector3 = (size as Vector3) * 0.5
	var local: Vector3 = xform.basis.orthonormalized().transposed() * (point - xform.origin)
	var clamped := Vector3(
		clampf(local.x, -half.x, half.x),
		clampf(local.y, -half.y, half.y),
		clampf(local.z, -half.z, half.z),
	)
	return (local - clamped).length()


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
