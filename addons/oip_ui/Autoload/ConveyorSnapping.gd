@tool
extends Node

## When non-null, snap calculations read this instead of selected.global_transform.
## Avoids the descendant transform-notification cascade on assemblies during live preview.
static var selected_xform_override: Variant = null
## When non-null, snap calculations read this instead of target.global_transform.
static var target_xform_override: Variant = null

static var live_snap_enabled: bool = true

## Live-snap memoization, keyed by Node3D.get_instance_id(); empty in the
## manual snap path so predicates fall through to direct computation.
static var live_type_cache: Dictionary = {}
static var live_end_info_cache: Dictionary = {}

static func get_selected_xform(selected: Node3D) -> Transform3D:
	if selected_xform_override != null:
		return selected_xform_override
	return selected.global_transform


static func get_target_xform(target: Node3D) -> Transform3D:
	if target_xform_override != null:
		return target_xform_override
	return target.global_transform


func _enter_tree() -> void:
	if not Engine.is_editor_hint():
		return

	var editor_settings := EditorInterface.get_editor_settings()
	var snap_shortcut := Shortcut.new()
	var snap_key := InputEventKey.new()
	snap_key.keycode = KEY_C
	snap_key.ctrl_pressed = true
	snap_key.shift_pressed = true
	snap_shortcut.events.append(snap_key)
	editor_settings.add_shortcut("Open Industry Project/Snap Conveyor", snap_shortcut)

	# Loaded by path: autoloads parse before sibling class_names are registered.
	var live_snap_script: GDScript = load("res://addons/oip_ui/Autoload/ConveyorLiveSnap.gd")
	var live_snap: Node = live_snap_script.new()
	live_snap.name = "ConveyorLiveSnap"
	add_child(live_snap)


func _input(event: InputEvent) -> void:
	if not Engine.is_editor_hint():
		return

	var editor_settings := EditorInterface.get_editor_settings()
	if editor_settings.is_shortcut("Open Industry Project/Snap Conveyor", event) and event.is_pressed() and not event.is_echo():
		if _selection_has_structures():
			StructureSnapping.snap_selected_structures()
		else:
			snap_selected_conveyors()


static func _selection_has_structures() -> bool:
	for node in EditorInterface.get_selection().get_selected_nodes():
		if node is Platform or node is Stairs or node is GuardRail:
			return true
	return false


static func snap_selected_conveyors() -> void:
	# Clear any leak from a live-preview call.
	selected_xform_override = null

	var selection := EditorInterface.get_selection()
	var selected_conveyors: Array[Node3D] = []
	var target_conveyor := EditorInterface.get_active_node_3d()
	
	if not target_conveyor:
		EditorInterface.get_editor_toaster().push_toast("No active node found - please click on a target conveyor first", EditorToaster.SEVERITY_WARNING)
		return
	
	if not _is_conveyor(target_conveyor):
		EditorInterface.get_editor_toaster().push_toast("Active node is not a conveyor - please select a conveyor as target", EditorToaster.SEVERITY_WARNING)
		return
	
	for node in selection.get_selected_nodes():
		if (_is_conveyor(node) or _is_diverter(node) or _is_chain_transfer(node) or _is_blade_stop(node)) and node != target_conveyor:
			selected_conveyors.append(node as Node3D)

	if selected_conveyors.is_empty():
		EditorInterface.get_editor_toaster().push_toast("No valid conveyors selected for snapping (target conveyor excluded)", EditorToaster.SEVERITY_WARNING)
		return

	for node in selected_conveyors:
		if (_is_chain_transfer(node) or _is_blade_stop(node)) and not _is_roller_conveyor(target_conveyor):
			var label := "Chain transfers" if _is_chain_transfer(node) else "Blade stops"
			EditorInterface.get_editor_toaster().push_toast("%s can only be snapped onto a roller conveyor" % label, EditorToaster.SEVERITY_WARNING)
			return
	
	var undo_redo := EditorInterface.get_editor_undo_redo()

	var has_curved := false
	var has_side_guards := false
	var has_diverter := false
	var has_chain_transfer := false
	var has_blade_stop := false

	for conveyor in selected_conveyors:
		if _is_curved_conveyor(conveyor) or _is_curved_conveyor(target_conveyor):
			has_curved = true
		if _has_side_guards(conveyor) or _has_side_guards(target_conveyor):
			has_side_guards = true
		if _is_diverter(conveyor):
			has_diverter = true
		if _is_chain_transfer(conveyor):
			has_chain_transfer = true
		if _is_blade_stop(conveyor):
			has_blade_stop = true

	var action_name: String
	if has_blade_stop:
		action_name = "Snap Blade Stop Between Rollers"
	elif has_chain_transfer:
		action_name = "Snap Chain Transfer Between Rollers"
	elif has_diverter:
		action_name = "Snap Diverter with Side Guard Openings" if has_side_guards else "Snap Diverter"
	elif has_curved and has_side_guards:
		action_name = "Snap Curved Conveyors with Side Guard Openings"
	elif has_curved:
		action_name = "Snap Curved Conveyors"
	elif has_side_guards:
		action_name = "Snap Conveyors with Side Guard Openings"
	else:
		action_name = "Snap Conveyors"
	
	undo_redo.create_action(action_name)

	var nodes_to_sync: Array[Node3D] = [target_conveyor]

	for conveyor in selected_conveyors:
		if not nodes_to_sync.has(conveyor):
			nodes_to_sync.append(conveyor)

		var original_transform := conveyor.global_transform
		var snap_result := _calculate_snap_transform(conveyor, target_conveyor)
		var snap_transform: Transform3D = snap_result.transform
		var is_end_to_end: bool = snap_result.is_end_to_end
		undo_redo.add_do_property(conveyor, "global_transform", snap_transform)
		undo_redo.add_undo_property(conveyor, "global_transform", original_transform)

		# Chain transfers and blade stops sit between rollers and never form a T-junction.
		if not is_end_to_end and not _is_chain_transfer(conveyor) and not _is_blade_stop(conveyor):
			if _is_diverter(conveyor):
				_open_side_guards_for_diverter(undo_redo, snap_transform, conveyor, target_conveyor)
			else:
				_connect_side_guards(undo_redo, conveyor, target_conveyor, snap_transform)

	_register_state_sync(undo_redo, nodes_to_sync)

	undo_redo.commit_action()


## Diverter-only: assumes the snap places the diverter adjacent to exactly one side.
static func _calculate_diverter_intersection_for_transform(snapped_conveyor: Node3D, target_conveyor: Node3D, snapped_transform: Transform3D) -> Dictionary:
	var target_transform := target_conveyor.global_transform
	var snapped_size := _get_conveyor_size(snapped_conveyor)
	var target_size := _get_conveyor_size(target_conveyor)
	
	var target_inverse := target_transform.affine_inverse()
	var snapped_local_transform := target_inverse * snapped_transform
	
	var snapped_half_length := snapped_size.x / 2.0
	var snapped_half_width := snapped_size.z / 2.0
	var target_half_length := target_size.x / 2.0
	var target_half_width := target_size.z / 2.0
	
	var min_bounds := Vector3(INF, 0, INF)
	var max_bounds := Vector3(-INF, 0, -INF)
	
	for x_sign in [-1, 1]:
		for z_sign in [-1, 1]:
			var local_corner: Vector3 = snapped_local_transform.origin + snapped_local_transform.basis.x * (x_sign * snapped_half_length) + snapped_local_transform.basis.z * (z_sign * snapped_half_width)
			min_bounds.x = min(min_bounds.x, local_corner.x)
			max_bounds.x = max(max_bounds.x, local_corner.x)
			min_bounds.z = min(min_bounds.z, local_corner.z)
			max_bounds.z = max(max_bounds.z, local_corner.z)
	
	if max_bounds.x < -target_half_length or min_bounds.x > target_half_length:
		return {}
	
	min_bounds.x = max(min_bounds.x, -target_half_length)
	max_bounds.x = min(max_bounds.x, target_half_length)
	
	var intersections := []
	var side_guard_margin: float = 0.15 if _has_side_guards(snapped_conveyor) else 0.05

	var opening_position: float = (min_bounds.x + max_bounds.x) / 2.0
	var opening_size: float = (max_bounds.x - min_bounds.x) + side_guard_margin

	if _has_spur_angles(snapped_conveyor):
		var spur_angles := _get_spur_angles(snapped_conveyor)
		var spur_angle: float = spur_angles.downstream
		if abs(spur_angle) > 0.001:
			var left_extent: float = snapped_half_length + tan(spur_angle) * (-snapped_half_width)
			var right_extent: float = snapped_half_length + tan(spur_angle) * snapped_half_width

			var side_guard_thickness: float = 0.1
			var edge_a: Vector3 = snapped_local_transform * Vector3(left_extent, 0, -snapped_half_width - side_guard_thickness)
			var edge_b: Vector3 = snapped_local_transform * Vector3(right_extent, 0, snapped_half_width + side_guard_thickness)

			var edge_min_x: float = min(edge_a.x, edge_b.x)
			var edge_max_x: float = max(edge_a.x, edge_b.x)
			edge_min_x = max(edge_min_x, -target_half_length)
			edge_max_x = min(edge_max_x, target_half_length)

			opening_position = (edge_min_x + edge_max_x) / 2.0
			opening_size = (edge_max_x - edge_min_x) + side_guard_margin

	# Pick from center Z; robust against any outward recess.
	var side_str: String = "left" if snapped_local_transform.origin.z < 0.0 else "right"
	intersections.append({
		"side": side_str,
		"position": opening_position,
		"size": opening_size,
	})

	return {"intersections": intersections}


## Shrink/split guards to open a gap matching [param intersection_info].
static func _shrink_guards_for_gap(undo_redo: EditorUndoRedoManager, conveyor: Node3D, intersection_info: Dictionary) -> void:
	if not intersection_info.has("intersections"):
		return

	var sg_assembly: Node = _find_side_guards_assembly(conveyor)
	if not sg_assembly:
		return

	var intersections := intersection_info["intersections"] as Array

	for intersection in intersections:
		var side_str: String = intersection["side"]
		var gap_center: float = intersection["position"]
		var gap_size: float = intersection["size"]
		var gap_start: float = gap_center - gap_size / 2.0
		var gap_end: float = gap_center + gap_size / 2.0

		var side_name: String = "LeftSide" if side_str == "left" else "RightSide"
		var side_node := sg_assembly.get_node_or_null(side_name) as Node3D
		if not side_node:
			continue

		for child in side_node.get_children():
			if not child is SideGuard:
				continue
			var guard := child as SideGuard
			var g_front: float = guard.position.x + guard.length / 2.0
			var g_back: float = guard.position.x - guard.length / 2.0

			if g_front <= gap_start or g_back >= gap_end:
				continue

			var old_length: float = guard.length
			var old_pos: Vector3 = guard.position

			if g_back < gap_start and g_front > gap_end:
				# Gap entirely inside guard: split into back + new front guard.
				var back_length: float = gap_start - g_back
				var back_center: float = (g_back + gap_start) / 2.0
				undo_redo.add_do_property(guard, "length", back_length)
				undo_redo.add_do_property(guard, "position", Vector3(back_center, 0, 0))
				undo_redo.add_do_property(guard, "front_anchored", false)
				undo_redo.add_undo_property(guard, "length", old_length)
				undo_redo.add_undo_property(guard, "position", old_pos)
				undo_redo.add_undo_property(guard, "front_anchored", guard.front_anchored)

				var front_length: float = g_front - gap_end
				var front_center: float = (gap_end + g_front) / 2.0
				var new_guard: SideGuard = sg_assembly._instantiate_guard()
				new_guard.back_anchored = false
				var guard_basis := Basis.IDENTITY
				if side_str == "right":
					guard_basis = Basis(Vector3.UP, PI)
				new_guard.transform = Transform3D(guard_basis, Vector3(front_center, 0, 0))
				new_guard.length = front_length
				undo_redo.add_do_method(side_node, "add_child", new_guard)
				undo_redo.add_do_reference(new_guard)
				undo_redo.add_undo_method(side_node, "remove_child", new_guard)
			elif g_back >= gap_start:
				# Gap overlaps the back: shrink from back.
				var new_length: float = maxf(0.01, g_front - gap_end)
				var new_center: float = (gap_end + g_front) / 2.0
				undo_redo.add_do_property(guard, "length", new_length)
				undo_redo.add_do_property(guard, "position", Vector3(new_center, 0, 0))
				undo_redo.add_do_property(guard, "back_anchored", false)
				undo_redo.add_undo_property(guard, "length", old_length)
				undo_redo.add_undo_property(guard, "position", old_pos)
				undo_redo.add_undo_property(guard, "back_anchored", guard.back_anchored)
			elif g_front <= gap_end:
				# Gap overlaps the front: shrink from front.
				var new_length: float = maxf(0.01, gap_start - g_back)
				var new_center: float = (g_back + gap_start) / 2.0
				undo_redo.add_do_property(guard, "length", new_length)
				undo_redo.add_do_property(guard, "position", Vector3(new_center, 0, 0))
				undo_redo.add_do_property(guard, "front_anchored", false)
				undo_redo.add_undo_property(guard, "length", old_length)
				undo_redo.add_undo_property(guard, "position", old_pos)
				undo_redo.add_undo_property(guard, "front_anchored", guard.front_anchored)


## Connect sideguards at a T-junction via ray-plane intersection; trims A's frame rails too.
## [param skip_snapped_undo]: omit undo_ops on snapped's guards/rails when the caller
## removes its subtree on undo.
static func _connect_side_guards(
	undo_redo: EditorUndoRedoManager,
	snapped_conveyor: Node3D, target_conveyor: Node3D,
	snap_transform: Transform3D,
	skip_snapped_undo: bool = false
) -> void:
	var snapped_sg := _find_side_guards_assembly(snapped_conveyor)
	var target_sg := _find_side_guards_assembly(target_conveyor)
	if not snapped_sg or not target_sg:
		return

	var target_xform := target_conveyor.global_transform
	var target_inverse := target_xform.affine_inverse()
	var target_size := _get_conveyor_size(target_conveyor)
	var frame_wt := ConveyorFrameMesh.WALL_THICKNESS
	var target_half_width := target_size.z / 2.0
	var target_half_length := target_size.x / 2.0

	var snapped_center_in_target: Vector3 = target_inverse * snap_transform.origin
	var side_str: String
	if abs(snapped_center_in_target.z + target_half_width) < abs(snapped_center_in_target.z - target_half_width):
		side_str = "left"
	else:
		side_str = "right"

	# B's sideguard plane in world space.
	var side_z: float = (target_half_width + frame_wt) if side_str == "right" else -(target_half_width + frame_wt)
	var plane_point: Vector3 = target_xform * Vector3(0, 0, side_z)
	var plane_normal: Vector3 = (target_xform.basis.z).normalized()
	if side_str == "left":
		plane_normal = -plane_normal

	var delta_xform := snap_transform * snapped_conveyor.global_transform.affine_inverse()
	var snap_x_world: Vector3 = snap_transform.basis.x.normalized()
	var dir_sign: float = -1.0 if snap_x_world.dot(plane_normal) > 0.0 else 1.0

	var opening_x_values: Array[float] = []

	for side_name in ["LeftSide", "RightSide"]:
		var side_node := snapped_sg.get_node_or_null(side_name) as Node3D
		if not side_node:
			continue

		# Find the guard whose target-facing edge sits furthest toward the target.
		var best_guard: SideGuard = null
		var best_score := -INF
		for child in side_node.get_children():
			if child is SideGuard:
				var guard := child as SideGuard
				var leading_edge_x: float = guard.position.x + dir_sign * guard.length / 2.0
				var score: float = dir_sign * leading_edge_x
				if score > best_score:
					best_score = score
					best_guard = guard
		if not best_guard:
			continue

		var trailing_edge_x: float = best_guard.position.x - dir_sign * best_guard.length / 2.0
		var side_global: Transform3D = delta_xform * side_node.global_transform
		var ray_origin: Vector3 = side_global * Vector3(trailing_edge_x, 0, 0)
		var ray_dir: Vector3 = (side_global.basis.x * dir_sign).normalized()

		# Ray-plane intersection.
		var denom: float = ray_dir.dot(plane_normal)
		if abs(denom) < 0.001:
			continue  # Nearly parallel; skip.

		var t: float = (plane_point - ray_origin).dot(plane_normal) / denom
		if t < 0.01:
			continue  # Hit is behind trailing edge.

		var hit_point: Vector3 = ray_origin + ray_dir * t

		# Trim A's guard: keep its trailing edge fixed, move the leading edge to the hit.
		var new_length: float = t
		var new_center_x: float = trailing_edge_x + dir_sign * new_length / 2.0
		var old_length: float = best_guard.length
		var old_pos: Vector3 = best_guard.position

		undo_redo.add_do_property(best_guard, "length", new_length)
		undo_redo.add_do_property(best_guard, "position", Vector3(new_center_x, 0, 0))
		if not skip_snapped_undo:
			undo_redo.add_undo_property(best_guard, "length", old_length)
			undo_redo.add_undo_property(best_guard, "position", old_pos)
		if dir_sign > 0.0:
			undo_redo.add_do_property(best_guard, "front_anchored", false)
			undo_redo.add_do_property(best_guard, "front_boundary_tracking", true)
			if not skip_snapped_undo:
				undo_redo.add_undo_property(best_guard, "front_anchored", best_guard.front_anchored)
				undo_redo.add_undo_property(best_guard, "front_boundary_tracking", best_guard.front_boundary_tracking)
		else:
			undo_redo.add_do_property(best_guard, "back_anchored", false)
			undo_redo.add_do_property(best_guard, "back_boundary_tracking", true)
			if not skip_snapped_undo:
				undo_redo.add_undo_property(best_guard, "back_anchored", best_guard.back_anchored)
				undo_redo.add_undo_property(best_guard, "back_boundary_tracking", best_guard.back_boundary_tracking)

		var hit_in_target: Vector3 = target_inverse * hit_point
		opening_x_values.append(hit_in_target.x)

	if opening_x_values.size() >= 2:
		var gap_start: float = opening_x_values.min()
		var gap_end: float = opening_x_values.max()
		gap_start = max(gap_start, -target_half_length)
		gap_end = min(gap_end, target_half_length)

		if gap_end > gap_start + 0.01:
			var intersection_info := {"intersections": [{
				"side": side_str,
				"position": (gap_start + gap_end) / 2.0,
				"size": gap_end - gap_start,
			}]}
			_shrink_guards_for_gap(undo_redo, target_conveyor, intersection_info)

	# Spurs have multiple child belts with their own frame rails; walk them all.
	var conveyor_dir: Vector3 = snap_x_world * dir_sign
	var frame_denom: float = conveyor_dir.dot(plane_normal)
	if abs(frame_denom) > 0.001:
		var all_frames: Array[FrameRail] = []
		_find_frame_rails(snapped_conveyor, all_frames)

		for fr in all_frames:
			if not fr.visible:
				continue

			var fr_global: Transform3D = delta_xform * fr.global_transform
			var fr_dir: Vector3 = (fr_global.basis.x).normalized()
			var is_flipped: bool = fr_dir.dot(conveyor_dir) < 0

			# Ray from the rail's trailing edge toward the target plane.
			var trailing_local_x: float = -fr.length / 2.0 if not is_flipped else fr.length / 2.0
			var trailing_world: Vector3 = fr_global * Vector3(trailing_local_x, 0, 0)

			var t_f: float = (plane_point - trailing_world).dot(plane_normal) / frame_denom
			if t_f < 0.01:
				continue

			var old_length: float = fr.length
			var old_pos: Vector3 = fr.position
			# Keep trailing edge fixed in parent space; trim the leading edge.
			var trailing_parent_x: float = old_pos.x - dir_sign * old_length / 2.0
			var new_pos_x: float = trailing_parent_x + dir_sign * t_f / 2.0

			undo_redo.add_do_property(fr, "length", t_f)
			undo_redo.add_do_property(fr, "position", Vector3(new_pos_x, old_pos.y, old_pos.z))
			if not skip_snapped_undo:
				undo_redo.add_undo_property(fr, "length", old_length)
				undo_redo.add_undo_property(fr, "position", old_pos)
			if dir_sign > 0.0:
				undo_redo.add_do_property(fr, "front_anchored", false)
				undo_redo.add_do_property(fr, "front_boundary_tracking", true)
				if not skip_snapped_undo:
					undo_redo.add_undo_property(fr, "front_anchored", fr.front_anchored)
					undo_redo.add_undo_property(fr, "front_boundary_tracking", fr.front_boundary_tracking)
			else:
				undo_redo.add_do_property(fr, "back_anchored", false)
				undo_redo.add_do_property(fr, "back_boundary_tracking", true)
				if not skip_snapped_undo:
					undo_redo.add_undo_property(fr, "back_anchored", fr.back_anchored)
					undo_redo.add_undo_property(fr, "back_boundary_tracking", fr.back_boundary_tracking)


## Re-sync @export_storage guard/frame-rail dicts after per-property edits.
## [param skip_undo]: skip undo_methods on nodes whose subtree is removed on undo.
static func _register_state_sync(undo_redo: EditorUndoRedoManager, nodes: Array[Node3D], skip_undo: bool = false) -> void:
	for node in nodes:
		var sg := _find_side_guards_assembly(node)
		if sg and sg.has_method("save_guard_state"):
			undo_redo.add_do_method(sg, "save_guard_state")
			if not skip_undo:
				undo_redo.add_undo_method(sg, "save_guard_state")
		_register_frame_rail_sync(undo_redo, node, skip_undo)


static func _register_frame_rail_sync(undo_redo: EditorUndoRedoManager, node: Node, skip_undo: bool = false) -> void:
	if node.has_method("_save_frame_rail_state"):
		undo_redo.add_do_method(node, "_save_frame_rail_state")
		if not skip_undo:
			undo_redo.add_undo_method(node, "_save_frame_rail_state")
	for child in node.get_children():
		_register_frame_rail_sync(undo_redo, child, skip_undo)


## Recursively find all FrameRail nodes under a conveyor.
static func _find_frame_rails(node: Node, result: Array[FrameRail]) -> void:
	if node is FrameRail:
		result.append(node as FrameRail)
	for child in node.get_children():
		_find_frame_rails(child, result)


## Find the SideGuardsAssembly node on a conveyor.
static func _find_side_guards_assembly(conveyor: Node3D) -> Node:
	for path in ["%SideGuardsAssembly", "Conveyor/SideGuardsAssembly", "%Conveyor/%SideGuardsAssembly"]:
		var node := conveyor.get_node_or_null(path)
		if node:
			return node
	return null


static func _has_side_guards(conveyor: Node3D) -> bool:
	return ("right_side_guards_enabled" in conveyor and
			"left_side_guards_enabled" in conveyor)


static func _is_conveyor(node: Node) -> bool:
	if node is BeltConveyorAssembly or node is RollerConveyorAssembly or node is CurvedBeltConveyorAssembly or node is CurvedRollerConveyorAssembly:
		return true
	
	var node_script: Script = node.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := node.get_class()
	
	var conveyor_types := [
		"BeltSpurConveyor", "SpurConveyorAssembly", "BeltSpurConveyorAssembly",
		"RollerSpurConveyor", "RollerSpurConveyorAssembly",
		"BeltConveyor", "RollerConveyor", 
		"CurvedBeltConveyor", "CurvedRollerConveyor", "BeltConveyorAssembly", "RollerConveyorAssembly", 
		"CurvedBeltConveyorAssembly", "CurvedRollerConveyorAssembly"
	]
	
	return global_name in conveyor_types or node_class in conveyor_types


static func _make_snap_result(snap_transform: Transform3D, snapped_end: Dictionary, target_end: Dictionary) -> Dictionary:
	var end_names := [&"front", &"back", &"head", &"tail"]
	return {
		"transform": snap_transform,
		"snapped_end": snapped_end,
		"target_end": target_end,
		"is_end_to_end": snapped_end.name in end_names and target_end.name in end_names,
	}


## Curved/spur geometries have bespoke aligners; everything else uses the feature matcher.
static func _calculate_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D, live_mode: bool = false) -> Dictionary:
	if _is_curved_conveyor(selected_conveyor) or _is_curved_conveyor(target_conveyor):
		return _calculate_curved_snap_transform(selected_conveyor, target_conveyor, live_mode)

	if _has_spur_angles(selected_conveyor):
		return _calculate_spur_snap_transform(selected_conveyor, target_conveyor, live_mode)

	if _has_spur_angles(target_conveyor):
		return _calculate_snap_to_spur_target_transform(selected_conveyor, target_conveyor, live_mode)

	return ConveyorSnapFeatures.try_snap(selected_conveyor, target_conveyor, live_mode)


static func _get_conveyor_size(conveyor: Node3D) -> Vector3:
	if "size" in conveyor:
		return conveyor.size
	return Vector3(4.0, 0.5, 1.524)


static func _get_closest_point_on_line_segment(point: Vector3, line_start: Vector3, line_end: Vector3) -> Vector3:
	var line_vector := line_end - line_start
	var line_length_squared := line_vector.length_squared()
	
	if line_length_squared == 0.0:
		return line_start
	
	var point_to_start := point - line_start
	var projection_factor := point_to_start.dot(line_vector) / line_length_squared
	projection_factor = clampf(projection_factor, 0.0, 1.0)
	
	return line_start + projection_factor * line_vector


## Returns [min_x, max_x] where the polygon defined by ordered corners intersects a horizontal
## line at the given Z value. Returns an empty array if no intersection.
static func _get_x_range_at_z(corners: Array[Vector3], z_val: float) -> Array[float]:
	var x_values: Array[float] = []
	var n := corners.size()
	for i in range(n):
		var a := corners[i]
		var b := corners[(i + 1) % n]
		if (a.z <= z_val and b.z >= z_val) or (a.z >= z_val and b.z <= z_val):
			if absf(b.z - a.z) < 0.0001:
				x_values.append(a.x)
				x_values.append(b.x)
			else:
				var t := (z_val - a.z) / (b.z - a.z)
				x_values.append(a.x + t * (b.x - a.x))
	if x_values.is_empty():
		return []
	return [x_values.min(), x_values.max()]


static func _get_z_inclination(transform: Transform3D) -> float:
	var forward := transform.basis.x.normalized()
	return atan2(forward.y, Vector2(forward.x, forward.z).length())


static func _apply_inclination_to_basis(basis: Basis, inclination: float) -> Basis:
	var horizontal_forward := Vector3(basis.x.x, 0, basis.x.z).normalized()
	var horizontal_right := Vector3(basis.z.x, 0, basis.z.z).normalized()
	
	var inclined_forward := horizontal_forward * cos(inclination) + Vector3.UP * sin(inclination)
	
	var new_basis := Basis()
	new_basis.x = inclined_forward
	new_basis.z = horizontal_right
	new_basis.y = new_basis.z.cross(new_basis.x).normalized()
	
	return new_basis 



static func _is_curved_conveyor(conveyor: Node3D) -> bool:
	if not live_type_cache.is_empty():
		var f: Variant = live_type_cache.get(conveyor.get_instance_id())
		if f != null:
			return f.is_curved
	var node_script: Script = conveyor.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := conveyor.get_class()

	var curved_types := [
		"CurvedBeltConveyor", "CurvedRollerConveyor", "CurvedBeltConveyorAssembly", "CurvedRollerConveyorAssembly"
	]

	return global_name in curved_types or node_class in curved_types


static func _is_curved_roller_conveyor(conveyor: Node3D) -> bool:
	if not live_type_cache.is_empty():
		var f: Variant = live_type_cache.get(conveyor.get_instance_id())
		if f != null:
			return f.is_curved_roller
	var node_script: Script = conveyor.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := conveyor.get_class()

	var curved_roller_types := [
		"CurvedRollerConveyor", "CurvedRollerConveyorAssembly"
	]

	return global_name in curved_roller_types or node_class in curved_roller_types


static func _is_straight_conveyor_assembly(conveyor: Node3D) -> bool:
	if conveyor is BeltConveyorAssembly or conveyor is RollerConveyorAssembly:
		return true
	
	var node_script: Script = conveyor.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := conveyor.get_class()
	
	var straight_assembly_types := [
		"BeltConveyorAssembly", "RollerConveyorAssembly"
	]
	
	return global_name in straight_assembly_types or node_class in straight_assembly_types


static func _is_spur_conveyor(conveyor: Node3D) -> bool:
	if not live_type_cache.is_empty():
		var f: Variant = live_type_cache.get(conveyor.get_instance_id())
		if f != null:
			return f.is_spur
	var node_script: Script = conveyor.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := conveyor.get_class()
	var spur_types := ["BeltSpurConveyor", "SpurConveyorAssembly", "BeltSpurConveyorAssembly", "RollerSpurConveyor", "RollerSpurConveyorAssembly"]
	return global_name in spur_types or node_class in spur_types


static func _get_spur_angles(conveyor: Node3D) -> Dictionary:
	var angle_ds: float = 0.0
	var angle_us: float = 0.0
	if "angle_downstream" in conveyor:
		angle_ds = conveyor.angle_downstream
	if "angle_upstream" in conveyor:
		angle_us = conveyor.angle_upstream
	return {"downstream": angle_ds, "upstream": angle_us}


static func _has_spur_angles(conveyor: Node3D) -> bool:
	if not live_type_cache.is_empty():
		var f: Variant = live_type_cache.get(conveyor.get_instance_id())
		if f != null:
			return f.has_spur
	if not _is_spur_conveyor(conveyor):
		return false
	var angles := _get_spur_angles(conveyor)
	return abs(angles.downstream) > 0.001 or abs(angles.upstream) > 0.001


static func _get_curved_conveyor_angle(conveyor: Node3D) -> float:
	if "conveyor_angle" in conveyor:
		return conveyor.conveyor_angle
	var corner = conveyor.get_node_or_null("ConveyorCorner")
	if corner and "conveyor_angle" in corner:
		return corner.conveyor_angle
	return 90.0


static func _get_curved_conveyor_params(conveyor: Node3D) -> Dictionary:
	var inner_radius := 0.5
	var conveyor_width := 1.524
	if "inner_radius" in conveyor:
		inner_radius = conveyor.inner_radius
	elif "inner_radius_f" in conveyor:
		inner_radius = conveyor.inner_radius_f
	if "conveyor_width" in conveyor:
		conveyor_width = conveyor.conveyor_width
	var corner = conveyor.get_node_or_null("ConveyorCorner")
	if corner:
		if "inner_radius" in corner:
			inner_radius = corner.inner_radius
		if "conveyor_width" in corner:
			conveyor_width = corner.conveyor_width
	return {"inner_radius": inner_radius, "conveyor_width": conveyor_width}


## Returns both ends of a curved conveyor in local (assembly) space.
## Each end has a position and an outward-facing direction (away from the conveyor).
static func _get_curved_end_info(conveyor: Node3D) -> Array[Dictionary]:
	var angle_deg := _get_curved_conveyor_angle(conveyor)
	var angle_rad := deg_to_rad(angle_deg)
	var params := _get_curved_conveyor_params(conveyor)
	var avg_radius: float = params.inner_radius + params.conveyor_width / 2.0

	var corner = conveyor.get_node_or_null("ConveyorCorner")
	var cc_offset: Vector3 = corner.position if corner else Vector3.ZERO

	# Tail end (0° side): position at (0, 0, avg_radius), outward = +X
	var tail_pos: Vector3 = cc_offset + Vector3(0, 0, avg_radius)
	var tail_outward := Vector3(1, 0, 0)

	# Head end (angle° side): outward = flow direction at exit
	var head_pos: Vector3 = cc_offset + Vector3(-sin(angle_rad) * avg_radius, 0, cos(angle_rad) * avg_radius)
	var head_outward := Vector3(-cos(angle_rad), 0, -sin(angle_rad))

	return [
		{"pos": tail_pos, "outward": tail_outward, "name": "tail"},
		{"pos": head_pos, "outward": head_outward, "name": "head"},
	]


## Returns both ends of a straight conveyor in local space.
static func _get_straight_end_info(conveyor: Node3D) -> Array[Dictionary]:
	var size := _get_conveyor_size(conveyor)
	return [
		{"pos": Vector3(size.x / 2.0, 0, 0), "outward": Vector3(1, 0, 0), "name": "front"},
		{"pos": Vector3(-size.x / 2.0, 0, 0), "outward": Vector3(-1, 0, 0), "name": "back"},
	]


## Returns both ends of a spur conveyor in local space, with outward directions
## that account for the angled downstream/upstream edges.
## The edge normal is perpendicular to the angled edge line in the XZ plane.
static func _get_spur_end_info(conveyor: Node3D) -> Array[Dictionary]:
	var size := _get_conveyor_size(conveyor)
	var angles := _get_spur_angles(conveyor)
	var ds_outward := Vector3(cos(angles.downstream), 0, -sin(angles.downstream))
	var us_outward := Vector3(-cos(angles.upstream), 0, sin(angles.upstream))
	return [
		{"pos": Vector3(size.x / 2.0, 0, 0), "outward": ds_outward, "name": "front"},
		{"pos": Vector3(-size.x / 2.0, 0, 0), "outward": us_outward, "name": "back"},
	]


## Returns end info for any conveyor type.
static func _get_end_info(conveyor: Node3D) -> Array[Dictionary]:
	if not live_end_info_cache.is_empty():
		var cached: Variant = live_end_info_cache.get(conveyor.get_instance_id())
		if cached != null:
			return cached
	if _is_curved_conveyor(conveyor):
		return _get_curved_end_info(conveyor)
	if _has_spur_angles(conveyor):
		return _get_spur_end_info(conveyor)
	return _get_straight_end_info(conveyor)


## Computes a snap transform that aligns one end of the selected conveyor
## to one end of the target conveyor, with outward directions facing each other.
static func _snap_end_to_end(
	selected_conveyor: Node3D,
	sel_end: Dictionary,
	target_conveyor: Node3D,
	tgt_end: Dictionary,
	gap: float
) -> Transform3D:
	var target_transform := get_target_xform(target_conveyor)
	var tgt_pos: Vector3 = tgt_end.pos
	var tgt_out: Vector3 = tgt_end.outward
	var tgt_end_world: Vector3 = target_transform * tgt_pos
	var tgt_outward_world: Vector3 = (target_transform.basis * tgt_out).normalized()

	# Selected's outward should face opposite to target's outward
	var desired_outward: Vector3 = -tgt_outward_world
	var sel_out: Vector3 = sel_end.outward
	var sel_pos_local: Vector3 = sel_end.pos
	var sel_heading := atan2(sel_out.x, sel_out.z)
	var desired_heading := atan2(desired_outward.x, desired_outward.z)
	var y_rotation := desired_heading - sel_heading

	var new_basis := Basis(Vector3.UP, y_rotation)
	var rotated_sel_end: Vector3 = new_basis * sel_pos_local
	var snap_pos: Vector3 = tgt_end_world + tgt_outward_world * gap - rotated_sel_end
	snap_pos.y = target_transform.origin.y

	return Transform3D(new_basis, snap_pos)


## Returns the gap distance between two conveyors based on their types.
static func _get_snap_gap(selected_conveyor: Node3D, target_conveyor: Node3D) -> float:
	var sel_curved := _is_curved_conveyor(selected_conveyor)
	var tgt_curved := _is_curved_conveyor(target_conveyor)

	if sel_curved and tgt_curved:
		var both_roller := _is_curved_roller_conveyor(selected_conveyor) and _is_curved_roller_conveyor(target_conveyor)
		var both_belt := not _is_curved_roller_conveyor(selected_conveyor) and not _is_curved_roller_conveyor(target_conveyor)
		if both_roller:
			return 0.004
		elif both_belt:
			return 0.5
		return 0.25
	elif sel_curved or tgt_curved:
		var curved := selected_conveyor if sel_curved else target_conveyor
		if _is_curved_roller_conveyor(curved):
			return 0.001
		return 0.25
	return 0.0


## Finds the closest pair of ends between two conveyors and returns
## [selected_end, target_end] dictionaries.
static func _find_closest_end_pair(selected_conveyor: Node3D, target_conveyor: Node3D) -> Array[Dictionary]:
	var sel_ends := _get_end_info(selected_conveyor)
	var tgt_ends := _get_end_info(target_conveyor)
	var sel_transform := get_selected_xform(selected_conveyor)
	var tgt_transform := get_target_xform(target_conveyor)

	var best_dist := INF
	var best_sel: Dictionary
	var best_tgt: Dictionary

	for se in sel_ends:
		for te in tgt_ends:
			var se_pos: Vector3 = se.pos
			var te_pos: Vector3 = te.pos
			var sel_world: Vector3 = sel_transform * se_pos
			var tgt_world: Vector3 = tgt_transform * te_pos
			var dist := sel_world.distance_to(tgt_world)
			if dist < best_dist:
				best_dist = dist
				best_sel = se
				best_tgt = te

	return [best_sel, best_tgt]


## Finds the resnap pair: keeps the same target end but flips which end
## of the selected conveyor connects. This mirrors/flips the selected
## conveyor's orientation at the same attachment point.
static func _find_resnap_end_pair(selected_conveyor: Node3D, target_conveyor: Node3D) -> Array[Dictionary]:
	var sel_ends := _get_end_info(selected_conveyor)
	var tgt_ends := _get_end_info(target_conveyor)
	var sel_transform := get_selected_xform(selected_conveyor)
	var tgt_transform := get_target_xform(target_conveyor)

	var best_dist := INF
	var snapped_sel_idx := 0
	var snapped_tgt_idx := 0

	for si in range(sel_ends.size()):
		for ti in range(tgt_ends.size()):
			var se_pos: Vector3 = sel_ends[si].pos
			var te_pos: Vector3 = tgt_ends[ti].pos
			var sel_world: Vector3 = sel_transform * se_pos
			var tgt_world: Vector3 = tgt_transform * te_pos
			var dist := sel_world.distance_to(tgt_world)
			if dist < best_dist:
				best_dist = dist
				snapped_sel_idx = si
				snapped_tgt_idx = ti

	var other_sel_idx := 1 - snapped_sel_idx
	return [sel_ends[other_sel_idx], tgt_ends[snapped_tgt_idx]]



static func _is_output_end(conveyor: Node3D, end_info: Dictionary) -> bool:
	if _is_curved_conveyor(conveyor):
		var prop := get_reverse_property_name(conveyor)
		var reversed: bool = bool(conveyor.get(prop)) if prop != &"" else false
		return (end_info.name == "head") != reversed
	return end_info.name == "front"


## Belt curves expose `reverse_belt`; roller curves expose `reverse`.
static func get_reverse_property_name(conveyor: Node3D) -> StringName:
	if conveyor == null:
		return &""
	if "reverse_belt" in conveyor:
		return &"reverse_belt"
	if "reverse" in conveyor:
		return &"reverse"
	return &""


static func _find_direction_preserving_end_pair(
	selected_conveyor: Node3D, target_conveyor: Node3D, gap: float
) -> Array[Dictionary]:
	var sel_ends := _get_end_info(selected_conveyor)
	var tgt_ends := _get_end_info(target_conveyor)
	var sel_transform := get_selected_xform(selected_conveyor)

	var best_pair: Array[Dictionary]
	var best_free_dist := INF
	var fallback_pair: Array[Dictionary]
	var fallback_free_dist := INF

	for se_idx in range(sel_ends.size()):
		var se := sel_ends[se_idx]
		var other_se := sel_ends[1 - se_idx]
		var free_end_before: Vector3 = sel_transform * other_se.pos
		var se_is_output := _is_output_end(selected_conveyor, se)

		for te in tgt_ends:
			var snap_t := _snap_end_to_end(selected_conveyor, se, target_conveyor, te, gap)
			var free_end_after: Vector3 = snap_t * other_se.pos
			var dist := free_end_before.distance_to(free_end_after)
			var flow_compatible := se_is_output != _is_output_end(target_conveyor, te)

			if flow_compatible:
				if dist < best_free_dist:
					best_free_dist = dist
					best_pair = [se, te]
			elif dist < fallback_free_dist:
				fallback_free_dist = dist
				fallback_pair = [se, te]

	return best_pair if not best_pair.is_empty() else fallback_pair


static func _calculate_curved_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D, live_mode: bool = false) -> Dictionary:
	if _is_straight_conveyor(target_conveyor) and _is_straight_conveyor(selected_conveyor):
		return ConveyorSnapFeatures.try_snap(selected_conveyor, target_conveyor, live_mode)

	var gap := _get_snap_gap(selected_conveyor, target_conveyor)

	var pair: Array[Dictionary]
	pair = _find_direction_preserving_end_pair(selected_conveyor, target_conveyor, gap)
	# No-op flip: cycle end pair if snap matches current pose. Suppressed in live mode (oscillates).
	if not live_mode:
		var snap_t := _snap_end_to_end(selected_conveyor, pair[0], target_conveyor, pair[1], gap)
		var current := get_selected_xform(selected_conveyor)
		if current.origin.distance_to(snap_t.origin) < 0.01 and current.basis.x.dot(snap_t.basis.x) > 0.999:
			pair = _find_resnap_end_pair(selected_conveyor, target_conveyor)

	var snap_transform := _snap_end_to_end(selected_conveyor, pair[0], target_conveyor, pair[1], gap)
	return _make_snap_result(snap_transform, pair[0], pair[1])


## Spur near target's side: spur's downstream/upstream angle. Near end: feature matcher.
static func _calculate_spur_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D, live_mode: bool = false) -> Dictionary:
	var sel_transform := get_selected_xform(selected_conveyor)
	var tgt_transform := target_conveyor.global_transform
	var tgt_size := _get_conveyor_size(target_conveyor)
	var selected_position := sel_transform.origin

	var target_front := tgt_transform.origin + tgt_transform.basis.x * (tgt_size.x / 2.0)
	var target_back := tgt_transform.origin - tgt_transform.basis.x * (tgt_size.x / 2.0)

	var left_edge_start := tgt_transform.origin - tgt_transform.basis.z * (tgt_size.z / 2.0) - tgt_transform.basis.x * (tgt_size.x / 2.0)
	var left_edge_end := tgt_transform.origin - tgt_transform.basis.z * (tgt_size.z / 2.0) + tgt_transform.basis.x * (tgt_size.x / 2.0)
	var left_closest := _get_closest_point_on_line_segment(selected_position, left_edge_start, left_edge_end)

	var right_edge_start := tgt_transform.origin + tgt_transform.basis.z * (tgt_size.z / 2.0) - tgt_transform.basis.x * (tgt_size.x / 2.0)
	var right_edge_end := tgt_transform.origin + tgt_transform.basis.z * (tgt_size.z / 2.0) + tgt_transform.basis.x * (tgt_size.x / 2.0)
	var right_closest := _get_closest_point_on_line_segment(selected_position, right_edge_start, right_edge_end)

	var dist_front := selected_position.distance_to(target_front)
	var dist_back := selected_position.distance_to(target_back)
	var dist_left := selected_position.distance_to(left_closest)
	var dist_right := selected_position.distance_to(right_closest)

	var min_end_dist: float = min(dist_front, dist_back)
	var min_side_dist: float = min(dist_left, dist_right)

	if min_end_dist < min_side_dist:
		return ConveyorSnapFeatures.try_snap(selected_conveyor, target_conveyor, live_mode)

	var side_outward: Vector3
	var side_edge_start: Vector3
	var side_edge_end: Vector3
	if dist_left < dist_right:
		side_outward = Vector3(0, 0, -1)
		side_edge_start = left_edge_start
		side_edge_end = left_edge_end
	else:
		side_outward = Vector3(0, 0, 1)
		side_edge_start = right_edge_start
		side_edge_end = right_edge_end

	var sel_ends := _get_spur_end_info(selected_conveyor)
	var best_sel: Dictionary = sel_ends[0]
	var best_dist := INF
	for se in sel_ends:
		var se_world: Vector3 = sel_transform * (se.pos as Vector3)
		var side_closest := _get_closest_point_on_line_segment(se_world, side_edge_start, side_edge_end)
		var dist := se_world.distance_to(side_closest)
		if dist < best_dist:
			best_dist = dist
			best_sel = se

	var best_sel_world: Vector3 = sel_transform * (best_sel.pos as Vector3)
	var side_contact := _get_closest_point_on_line_segment(best_sel_world, side_edge_start, side_edge_end)
	var side_pos_local: Vector3 = tgt_transform.affine_inverse() * side_contact
	var side_name: StringName = &"left_side" if dist_left < dist_right else &"right_side"
	var side_end := {"pos": side_pos_local, "outward": side_outward, "name": side_name}

	# Gap must clear the frame flange (0.02m) on both sides to prevent overlap.
	var spur_gap := ConveyorFrameMesh.FLANGE_WIDTH * 2.0
	if not "conveyor_count" in selected_conveyor:
		spur_gap = 0.12

	var snap_transform := _snap_end_to_end(selected_conveyor, best_sel, target_conveyor, side_end, spur_gap)
	return _make_snap_result(snap_transform, best_sel, side_end)


## Near spur's angled end: align to spur's outward. Near its sides: feature matcher.
static func _calculate_snap_to_spur_target_transform(selected_conveyor: Node3D, target_spur: Node3D, live_mode: bool = false) -> Dictionary:
	var sel_transform := get_selected_xform(selected_conveyor)
	var tgt_transform := target_spur.global_transform
	var tgt_size := _get_conveyor_size(target_spur)
	var selected_position := sel_transform.origin

	var tgt_ends := _get_spur_end_info(target_spur)
	var tgt_front_world: Vector3 = tgt_transform * (tgt_ends[0].pos as Vector3)
	var tgt_back_world: Vector3 = tgt_transform * (tgt_ends[1].pos as Vector3)

	var left_edge_start := tgt_transform.origin - tgt_transform.basis.z * (tgt_size.z / 2.0) - tgt_transform.basis.x * (tgt_size.x / 2.0)
	var left_edge_end := tgt_transform.origin - tgt_transform.basis.z * (tgt_size.z / 2.0) + tgt_transform.basis.x * (tgt_size.x / 2.0)
	var left_closest := _get_closest_point_on_line_segment(selected_position, left_edge_start, left_edge_end)

	var right_edge_start := tgt_transform.origin + tgt_transform.basis.z * (tgt_size.z / 2.0) - tgt_transform.basis.x * (tgt_size.x / 2.0)
	var right_edge_end := tgt_transform.origin + tgt_transform.basis.z * (tgt_size.z / 2.0) + tgt_transform.basis.x * (tgt_size.x / 2.0)
	var right_closest := _get_closest_point_on_line_segment(selected_position, right_edge_start, right_edge_end)

	var dist_front := selected_position.distance_to(tgt_front_world)
	var dist_back := selected_position.distance_to(tgt_back_world)
	var dist_left := selected_position.distance_to(left_closest)
	var dist_right := selected_position.distance_to(right_closest)

	var min_end_dist: float = min(dist_front, dist_back)
	var min_side_dist: float = min(dist_left, dist_right)

	if min_end_dist > min_side_dist:
		return ConveyorSnapFeatures.try_snap(selected_conveyor, target_spur, live_mode)

	var best_tgt: Dictionary = tgt_ends[0] if dist_front < dist_back else tgt_ends[1]
	var best_tgt_world: Vector3 = tgt_transform * (best_tgt.pos as Vector3)

	var sel_ends := _get_straight_end_info(selected_conveyor)
	var best_sel: Dictionary = sel_ends[0]
	var best_dist := INF
	for se in sel_ends:
		var se_world: Vector3 = sel_transform * (se.pos as Vector3)
		var dist := se_world.distance_to(best_tgt_world)
		if dist < best_dist:
			best_dist = dist
			best_sel = se

	var snap_transform := _snap_end_to_end(selected_conveyor, best_sel, target_spur, best_tgt, 0.0)
	return _make_snap_result(snap_transform, best_sel, best_tgt)


static func _is_straight_conveyor(conveyor: Node3D) -> bool:
	if not live_type_cache.is_empty():
		var f: Variant = live_type_cache.get(conveyor.get_instance_id())
		if f != null:
			return f.is_straight
	var node_script: Script = conveyor.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := conveyor.get_class()

	var straight_types := [
		"BeltConveyor", "BeltConveyorAssembly", "BeltSpurConveyor", "SpurConveyorAssembly", "BeltSpurConveyorAssembly",
		"RollerConveyor", "RollerConveyorAssembly",
		"RollerSpurConveyor", "RollerSpurConveyorAssembly"
	]

	return global_name in straight_types or node_class in straight_types


static func _is_diverter(node: Node) -> bool:
	return node is Diverter


static func _is_chain_transfer(node: Node) -> bool:
	return node is ChainTransfer


static func _is_blade_stop(node: Node) -> bool:
	return node is BladeStop


static func _is_roller_conveyor(node: Node) -> bool:
	return node is RollerConveyor or node is RollerConveyorAssembly


static func _open_side_guards_for_diverter(undo_redo: EditorUndoRedoManager, snap_transform: Transform3D, diverter: Node3D, target_conveyor: Node3D) -> void:
	var intersection_info := _calculate_diverter_intersection_for_transform(diverter, target_conveyor, snap_transform)
	_shrink_guards_for_gap(undo_redo, target_conveyor, intersection_info)
