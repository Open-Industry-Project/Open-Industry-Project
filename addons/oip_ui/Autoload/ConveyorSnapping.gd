@tool
extends Node

const DIVERTER_Y_OFFSET: float = 0.2


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


func _input(event: InputEvent) -> void:
	if not Engine.is_editor_hint():
		return

	var editor_settings := EditorInterface.get_editor_settings()
	if editor_settings.is_shortcut("Open Industry Project/Snap Conveyor", event) and event.is_pressed() and not event.is_echo():
		snap_selected_conveyors()


static func snap_selected_conveyors() -> void:
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
		if (_is_conveyor(node) or _is_diverter(node) or _is_chain_transfer(node)) and node != target_conveyor:
			selected_conveyors.append(node as Node3D)

	if selected_conveyors.is_empty():
		EditorInterface.get_editor_toaster().push_toast("No valid conveyors selected for snapping (target conveyor excluded)", EditorToaster.SEVERITY_WARNING)
		return

	for node in selected_conveyors:
		if _is_chain_transfer(node) and not _is_roller_conveyor(target_conveyor):
			EditorInterface.get_editor_toaster().push_toast("Chain transfers can only be snapped onto a roller conveyor", EditorToaster.SEVERITY_WARNING)
			return
	
	var undo_redo := EditorInterface.get_editor_undo_redo()
	
	# Determine appropriate action name based on conveyor types and side guards
	var has_curved := false
	var has_side_guards := false
	var has_diverter := false
	var has_chain_transfer := false

	for conveyor in selected_conveyors:
		if _is_curved_conveyor(conveyor) or _is_curved_conveyor(target_conveyor):
			has_curved = true
		if _has_side_guards(conveyor) or _has_side_guards(target_conveyor):
			has_side_guards = true
		if _is_diverter(conveyor):
			has_diverter = true
		if _is_chain_transfer(conveyor):
			has_chain_transfer = true

	var action_name: String
	if has_chain_transfer:
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
	
	for conveyor in selected_conveyors:
		var original_transform := conveyor.global_transform
		var snap_result := _calculate_snap_transform(conveyor, target_conveyor)
		var snap_transform: Transform3D = snap_result.transform
		var is_end_to_end: bool = snap_result.is_end_to_end
		undo_redo.add_do_property(conveyor, "global_transform", snap_transform)
		undo_redo.add_undo_property(conveyor, "global_transform", original_transform)

		# For side connections, connect sideguards at the T-junction. Chain
		# transfers sit on top of the conveyor and never form a T-junction.
		if not is_end_to_end and not _is_chain_transfer(conveyor):
			if _is_diverter(conveyor):
				_open_side_guards_for_diverter(undo_redo, snap_transform, conveyor, target_conveyor)
			else:
				_connect_side_guards(undo_redo, conveyor, target_conveyor, snap_transform)

	undo_redo.commit_action()

	# Save guard and frame rail state after commit.
	for conveyor in selected_conveyors:
		for node in [target_conveyor, conveyor]:
			var sg := _find_side_guards_assembly(node)
			if sg and sg.has_method("save_guard_state"):
				sg.save_guard_state()
			if node.has_method("_save_frame_rail_state"):
				node._save_frame_rail_state()
			_save_child_frame_rail_states(node)


static func _calculate_conveyor_intersection_for_transform(snapped_conveyor: Node3D, target_conveyor: Node3D, snapped_transform: Transform3D) -> Dictionary:
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
	
	# This function is only called for side connections (not end-to-end),
	# so we always check for intersections with the target's side edges.
	var intersections := []
	var tolerance := 0.001
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

	if max_bounds.z >= (-target_half_width - tolerance) and min_bounds.z <= (-target_half_width + tolerance):
		intersections.append({
			"side": "left",
			"position": opening_position,
			"size": opening_size
		})

	if min_bounds.z <= (target_half_width + tolerance) and max_bounds.z >= (target_half_width - tolerance):
		intersections.append({
			"side": "right",
			"position": opening_position,
			"size": opening_size
		})

	return {"intersections": intersections}


## Directly shrink/split guard nodes on the target conveyor to create a gap
## where the snapped conveyor intersects.
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

		# Find guards that overlap with the gap region and shrink/split them.
		for child in side_node.get_children():
			if not child is SideGuard:
				continue
			var guard := child as SideGuard
			var g_front: float = guard.position.x + guard.length / 2.0
			var g_back: float = guard.position.x - guard.length / 2.0

			# No overlap with gap.
			if g_front <= gap_start or g_back >= gap_end:
				continue

			var old_length: float = guard.length
			var old_pos: Vector3 = guard.position

			if g_back < gap_start and g_front > gap_end:
				# Gap is entirely inside this guard — split into two.
				# Shrink this guard to the back portion.
				var back_length: float = gap_start - g_back
				var back_center: float = (g_back + gap_start) / 2.0
				undo_redo.add_do_property(guard, "length", back_length)
				undo_redo.add_do_property(guard, "position", Vector3(back_center, 0, 0))
				undo_redo.add_do_property(guard, "front_anchored", false)
				undo_redo.add_undo_property(guard, "length", old_length)
				undo_redo.add_undo_property(guard, "position", old_pos)
				undo_redo.add_undo_property(guard, "front_anchored", guard.front_anchored)

				# Create a new guard for the front portion.
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
				# Gap overlaps the back — shrink from back.
				var new_length: float = g_front - gap_end
				if new_length < 0.01:
					new_length = 0.01
				var new_center: float = (gap_end + g_front) / 2.0
				undo_redo.add_do_property(guard, "length", new_length)
				undo_redo.add_do_property(guard, "position", Vector3(new_center, 0, 0))
				undo_redo.add_do_property(guard, "back_anchored", false)
				undo_redo.add_undo_property(guard, "length", old_length)
				undo_redo.add_undo_property(guard, "position", old_pos)
				undo_redo.add_undo_property(guard, "back_anchored", guard.back_anchored)

			elif g_front <= gap_end:
				# Gap overlaps the front — shrink from front.
				var new_length: float = gap_start - g_back
				if new_length < 0.01:
					new_length = 0.01
				var new_center: float = (g_back + gap_start) / 2.0
				undo_redo.add_do_property(guard, "length", new_length)
				undo_redo.add_do_property(guard, "position", Vector3(new_center, 0, 0))
				undo_redo.add_do_property(guard, "front_anchored", false)
				undo_redo.add_undo_property(guard, "length", old_length)
				undo_redo.add_undo_property(guard, "position", old_pos)
				undo_redo.add_undo_property(guard, "front_anchored", guard.front_anchored)


## Connect sideguards at a T-junction using ray-plane intersection.
## For each of A's front guards, ray-cast from its back edge along its direction
## to B's sideguard plane. The hit point determines:
##   - A's guard trimmed length (distance from back to hit)
##   - B's opening edge position (hit point's X in B's local space)
static func _connect_side_guards(
	undo_redo: EditorUndoRedoManager,
	snapped_conveyor: Node3D, target_conveyor: Node3D,
	snap_transform: Transform3D
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

	# Determine which side of B the snap lands on.
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
	# Normal should point away from the belt (outward).
	if side_str == "left":
		plane_normal = -plane_normal

	# Compute delta transform for A's post-snap positions.
	var delta_xform := snap_transform * snapped_conveyor.global_transform.affine_inverse()

	# For each of A's front guards, ray-cast to B's plane.
	var opening_x_values: Array[float] = []  # X positions in B's local space

	for side_name in ["LeftSide", "RightSide"]:
		var side_node := snapped_sg.get_node_or_null(side_name) as Node3D
		if not side_node:
			continue

		# Find the front-most guard.
		var best_guard: SideGuard = null
		var best_front_x := -INF
		for child in side_node.get_children():
			if child is SideGuard:
				var guard := child as SideGuard
				var fx: float = guard.position.x + guard.length / 2.0
				if fx > best_front_x:
					best_front_x = fx
					best_guard = guard
		if not best_guard:
			continue

		var back_x: float = best_guard.position.x - best_guard.length / 2.0
		var side_global: Transform3D = delta_xform * side_node.global_transform
		var ray_origin: Vector3 = side_global * Vector3(back_x, 0, 0)
		var ray_dir: Vector3 = (side_global.basis.x).normalized()

		# Ray-plane intersection.
		var denom: float = ray_dir.dot(plane_normal)
		if abs(denom) < 0.001:
			continue  # Nearly parallel — skip.

		var t: float = (plane_point - ray_origin).dot(plane_normal) / denom
		if t < 0.01:
			continue  # Hit is behind back edge.

		var hit_point: Vector3 = ray_origin + ray_dir * t

		# Trim A's guard: new length = t (back edge to hit point).
		var new_length: float = t
		var new_center_x: float = back_x + new_length / 2.0
		var old_length: float = best_guard.length
		var old_pos: Vector3 = best_guard.position

		undo_redo.add_do_property(best_guard, "length", new_length)
		undo_redo.add_do_property(best_guard, "position", Vector3(new_center_x, 0, 0))
		undo_redo.add_do_property(best_guard, "front_anchored", false)
		undo_redo.add_do_property(best_guard, "front_boundary_tracking", true)
		undo_redo.add_undo_property(best_guard, "length", old_length)
		undo_redo.add_undo_property(best_guard, "position", old_pos)
		undo_redo.add_undo_property(best_guard, "front_anchored", best_guard.front_anchored)
		undo_redo.add_undo_property(best_guard, "front_boundary_tracking", false)

		# Record where B's opening edge should be.
		var hit_in_target: Vector3 = target_inverse * hit_point
		opening_x_values.append(hit_in_target.x)

	# Cut B's guard using the computed opening edges.
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

	# Trim frame rails. Find ALL visible FrameRail nodes across all child
	# conveyors (spurs have multiple child belts, each with their own frames).
	var conveyor_dir: Vector3 = (snap_transform.basis.x).normalized()
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

			# Ray from conveyor-space back edge to target plane.
			var back_local_x: float = -fr.length / 2.0 if not is_flipped else fr.length / 2.0
			var back_world: Vector3 = fr_global * Vector3(back_local_x, 0, 0)

			var t_f: float = (plane_point - back_world).dot(plane_normal) / frame_denom
			if t_f < 0.01:
				continue

			var old_length: float = fr.length
			var old_pos: Vector3 = fr.position

			# Keep the upstream (back, -X) edge fixed in parent space.
			# This is always at pos.x - length/2 regardless of rail flip.
			var back_parent_x: float = old_pos.x - old_length / 2.0
			var new_pos_x: float = back_parent_x + t_f / 2.0

			undo_redo.add_do_property(fr, "length", t_f)
			undo_redo.add_do_property(fr, "position", Vector3(new_pos_x, old_pos.y, old_pos.z))
			undo_redo.add_do_property(fr, "front_anchored", false)
			undo_redo.add_do_property(fr, "front_boundary_tracking", true)
			undo_redo.add_undo_property(fr, "length", old_length)
			undo_redo.add_undo_property(fr, "position", old_pos)
			undo_redo.add_undo_property(fr, "front_anchored", fr.front_anchored)
			undo_redo.add_undo_property(fr, "front_boundary_tracking", false)


static func _save_child_frame_rail_states(node: Node) -> void:
	for child in node.get_children():
		if child.has_method("_save_frame_rail_state"):
			child._save_frame_rail_state()
		_save_child_frame_rail_states(child)


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


## Build a snap result dictionary that carries the transform and which ends connected.
## [code]is_end_to_end[/code] is true when both connected ends are conveyor ends
## (front/back/head/tail) rather than a side edge.
static func _make_snap_result(snap_transform: Transform3D, snapped_end: Dictionary, target_end: Dictionary) -> Dictionary:
	var end_names := [&"front", &"back", &"head", &"tail"]
	return {
		"transform": snap_transform,
		"snapped_end": snapped_end,
		"target_end": target_end,
		"is_end_to_end": snapped_end.name in end_names and target_end.name in end_names,
	}


static func _calculate_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Dictionary:
	if _is_chain_transfer(selected_conveyor):
		return _calculate_chain_transfer_snap_transform(selected_conveyor, target_conveyor)

	if _is_diverter(selected_conveyor):
		return _calculate_diverter_snap_transform(selected_conveyor, target_conveyor)

	if _is_curved_conveyor(selected_conveyor) or _is_curved_conveyor(target_conveyor):
		return _calculate_curved_snap_transform(selected_conveyor, target_conveyor)

	if _has_spur_angles(selected_conveyor):
		return _calculate_spur_snap_transform(selected_conveyor, target_conveyor)
	
	if _has_spur_angles(target_conveyor):
		return _calculate_snap_to_spur_target_transform(selected_conveyor, target_conveyor)
	
	return _calculate_regular_snap_transform(selected_conveyor, target_conveyor)


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
	var node_script: Script = conveyor.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := conveyor.get_class()

	var curved_types := [
		"CurvedBeltConveyor", "CurvedRollerConveyor", "CurvedBeltConveyorAssembly", "CurvedRollerConveyorAssembly"
	]

	return global_name in curved_types or node_class in curved_types


static func _is_curved_roller_conveyor(conveyor: Node3D) -> bool:
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
	var target_transform := target_conveyor.global_transform
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
	snap_pos.y = target_conveyor.global_position.y

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
	var sel_transform := selected_conveyor.global_transform
	var tgt_transform := target_conveyor.global_transform

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
	var sel_transform := selected_conveyor.global_transform
	var tgt_transform := target_conveyor.global_transform

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
		var reversed: bool = conveyor.get("reverse_belt") if "reverse_belt" in conveyor else false
		return (end_info.name == "head") != reversed
	return end_info.name == "front"


static func _find_direction_preserving_end_pair(
	selected_conveyor: Node3D, target_conveyor: Node3D, gap: float
) -> Array[Dictionary]:
	var sel_ends := _get_end_info(selected_conveyor)
	var tgt_ends := _get_end_info(target_conveyor)
	var sel_transform := selected_conveyor.global_transform

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


static func _calculate_curved_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Dictionary:
	if _is_straight_conveyor(target_conveyor) and _is_straight_conveyor(selected_conveyor):
		return _calculate_regular_snap_transform(selected_conveyor, target_conveyor)

	var gap := _get_snap_gap(selected_conveyor, target_conveyor)

	var pair: Array[Dictionary]
	pair = _find_direction_preserving_end_pair(selected_conveyor, target_conveyor, gap)
	var snap_t := _snap_end_to_end(selected_conveyor, pair[0], target_conveyor, pair[1], gap)
	var current := selected_conveyor.global_transform
	if current.origin.distance_to(snap_t.origin) < 0.01 and current.basis.x.dot(snap_t.basis.x) > 0.999:
		pair = _find_resnap_end_pair(selected_conveyor, target_conveyor)

	var snap_transform := _snap_end_to_end(selected_conveyor, pair[0], target_conveyor, pair[1], gap)
	return _make_snap_result(snap_transform, pair[0], pair[1])


## Computes a snap transform for a spur conveyor connecting to a target.
## When the spur is near a target's side, the spur's angled edge outward is used
## so the spur connects at the angle defined by its downstream/upstream angles.
## When nearer to a target's end, falls back to regular (inline) snapping.
static func _calculate_spur_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Dictionary:
	var sel_transform := selected_conveyor.global_transform
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
		return _calculate_regular_snap_transform(selected_conveyor, target_conveyor)

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


## Computes a snap transform for a straight conveyor connecting to a spur target.
## When the straight conveyor is near the spur's angled ends, the spur's angled
## outward vectors guide the straight conveyor's rotation so it aligns with the
## spur's edge angle. When nearer to the spur's sides, falls back to regular snap.
static func _calculate_snap_to_spur_target_transform(selected_conveyor: Node3D, target_spur: Node3D) -> Dictionary:
	var sel_transform := selected_conveyor.global_transform
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
		return _calculate_regular_snap_transform(selected_conveyor, target_spur)

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
	var node_script: Script = conveyor.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := conveyor.get_class()

	var straight_types := [
		"BeltConveyor", "BeltConveyorAssembly", "BeltSpurConveyor", "SpurConveyorAssembly", "BeltSpurConveyorAssembly",
		"RollerConveyor", "RollerConveyorAssembly",
		"RollerSpurConveyor", "RollerSpurConveyorAssembly"
	]

	return global_name in straight_types or node_class in straight_types


static func _calculate_regular_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Dictionary:
	# This is the original snapping logic for non-curved conveyors
	var target_transform := target_conveyor.global_transform
	var selected_transform := selected_conveyor.global_transform
	var selected_size := _get_conveyor_size(selected_conveyor)
	var target_size := _get_conveyor_size(target_conveyor)

	var target_front_edge := target_transform.origin + target_transform.basis.x * (target_size.x / 2.0)
	var target_back_edge := target_transform.origin - target_transform.basis.x * (target_size.x / 2.0)
	var target_left_edge := target_transform.origin - target_transform.basis.z * (target_size.z / 2.0)
	var target_right_edge := target_transform.origin + target_transform.basis.z * (target_size.z / 2.0)

	var selected_position := selected_transform.origin
	var distance_to_front := selected_position.distance_to(target_front_edge)
	var distance_to_back := selected_position.distance_to(target_back_edge)
	var distance_to_left := selected_position.distance_to(target_left_edge)
	var distance_to_right := selected_position.distance_to(target_right_edge)

	var selected_forward := selected_transform.basis.x.normalized()
	var target_forward := target_transform.basis.x.normalized()
	var dot_product: float = abs(selected_forward.dot(target_forward))
	var is_perpendicular: bool = dot_product < 0.7

	var min_distance: float = min(distance_to_front, min(distance_to_back, min(distance_to_left, distance_to_right)))
	var snap_transform := Transform3D()

	if is_perpendicular:
		var min_side_distance: float = min(distance_to_left, distance_to_right)
		var min_end_distance: float = min(distance_to_front, distance_to_back)

		if min_end_distance < 0.5 and min_end_distance < min_side_distance * 0.2:
			min_distance = min_end_distance
		else:
			min_distance = min_side_distance

	var selected_inclination := _get_z_inclination(selected_transform)
	var snapped_end := {}
	var target_end := {}

	if min_distance == distance_to_front:
		var new_basis := _apply_inclination_to_basis(target_transform.basis, selected_inclination)
		var connection_position := target_front_edge + new_basis.x * (selected_size.x / 2.0)
		snap_transform.basis = new_basis
		snap_transform.origin = connection_position
		snapped_end = {"pos": Vector3(-selected_size.x / 2.0, 0, 0), "outward": Vector3(-1, 0, 0), "name": &"back"}
		target_end = {"pos": Vector3(target_size.x / 2.0, 0, 0), "outward": Vector3(1, 0, 0), "name": &"front"}

	elif min_distance == distance_to_back:
		var new_basis := _apply_inclination_to_basis(target_transform.basis, selected_inclination)
		var connection_position := target_back_edge - new_basis.x * (selected_size.x / 2.0)
		snap_transform.basis = new_basis
		snap_transform.origin = connection_position
		snapped_end = {"pos": Vector3(selected_size.x / 2.0, 0, 0), "outward": Vector3(1, 0, 0), "name": &"front"}
		target_end = {"pos": Vector3(-target_size.x / 2.0, 0, 0), "outward": Vector3(-1, 0, 0), "name": &"back"}

	elif min_distance == distance_to_left:
		var edge_start := target_transform.origin - target_transform.basis.z * (target_size.z / 2.0) - target_transform.basis.x * (target_size.x / 2.0)
		var edge_end := target_transform.origin - target_transform.basis.z * (target_size.z / 2.0) + target_transform.basis.x * (target_size.x / 2.0)
		var closest_point_on_edge := _get_closest_point_on_line_segment(selected_position, edge_start, edge_end)

		var perpendicular_basis := Basis()
		perpendicular_basis.x = target_transform.basis.z
		perpendicular_basis.y = target_transform.basis.y
		perpendicular_basis.z = -target_transform.basis.x
		var new_basis := _apply_inclination_to_basis(perpendicular_basis, selected_inclination)
		var connection_position := closest_point_on_edge - new_basis.x * (selected_size.x / 2.0)
		snap_transform.basis = new_basis
		snap_transform.origin = connection_position
		var edge_pos_local: Vector3 = target_transform.affine_inverse() * closest_point_on_edge
		snapped_end = {"pos": Vector3(selected_size.x / 2.0, 0, 0), "outward": Vector3(1, 0, 0), "name": &"front"}
		target_end = {"pos": edge_pos_local, "outward": Vector3(0, 0, -1), "name": &"left_side"}

	else:
		var edge_start := target_transform.origin + target_transform.basis.z * (target_size.z / 2.0) - target_transform.basis.x * (target_size.x / 2.0)
		var edge_end := target_transform.origin + target_transform.basis.z * (target_size.z / 2.0) + target_transform.basis.x * (target_size.x / 2.0)
		var closest_point_on_edge := _get_closest_point_on_line_segment(selected_position, edge_start, edge_end)

		var perpendicular_basis := Basis()
		perpendicular_basis.x = -target_transform.basis.z
		perpendicular_basis.y = target_transform.basis.y
		perpendicular_basis.z = target_transform.basis.x
		var new_basis := _apply_inclination_to_basis(perpendicular_basis, selected_inclination)
		var connection_position := closest_point_on_edge - new_basis.x * (selected_size.x / 2.0)
		snap_transform.basis = new_basis
		snap_transform.origin = connection_position
		var edge_pos_local: Vector3 = target_transform.affine_inverse() * closest_point_on_edge
		snapped_end = {"pos": Vector3(selected_size.x / 2.0, 0, 0), "outward": Vector3(1, 0, 0), "name": &"front"}
		target_end = {"pos": edge_pos_local, "outward": Vector3(0, 0, 1), "name": &"right_side"}

	return _make_snap_result(snap_transform, snapped_end, target_end)


static func _is_diverter(node: Node) -> bool:
	return node is Diverter


static func _is_chain_transfer(node: Node) -> bool:
	return node is ChainTransfer


static func _is_roller_conveyor(node: Node) -> bool:
	return node is RollerConveyor or node is RollerConveyorAssembly


## Snap a chain transfer onto a roller conveyor so its chains drop into the gaps between rollers.
static func _calculate_chain_transfer_snap_transform(chain_transfer: Node3D, target_conveyor: Node3D) -> Dictionary:
	var ct := chain_transfer as ChainTransfer
	var target_xform := target_conveyor.global_transform
	var target_size := _get_conveyor_size(target_conveyor)

	var ct_center_offset := (ct.chains - 1) * ct.distance / 2.0

	var rd := Rollers.ROLLERS_DISTANCE
	var first_roller_x := -target_size.x / 2.0 + Rollers.ROLLERS_START_OFFSET + rd
	var center_phase := first_roller_x + (rd / 2.0 if ct.chains % 2 == 1 else 0.0)

	var current_center_world := ct.global_transform * Vector3(0, 0, ct_center_offset)
	var current_center_x := (target_xform.affine_inverse() * current_center_world).x
	var usable_half := target_size.x / 2.0 - Rollers.ROLLERS_START_OFFSET
	var n_min := ceili((-usable_half + ct_center_offset - center_phase) / rd)
	var n_max := floori((usable_half - ct_center_offset - center_phase) / rd)
	var n := roundi((current_center_x - center_phase) / rd)
	if n_max >= n_min:
		n = clampi(n, n_min, n_max)
	var snapped_center_x := center_phase + n * rd

	var y_target := -0.05
	var local_origin := Vector3(snapped_center_x - ct_center_offset, y_target, 0.0)

	var tgt_basis := target_xform.basis.orthonormalized()
	var new_basis := Basis(
		-tgt_basis.z * ct.scale.x,
		tgt_basis.y * ct.scale.y,
		tgt_basis.x * ct.scale.z,
	)

	return {
		"transform": Transform3D(new_basis, target_xform * local_origin),
		"is_end_to_end": false,
	}


static func _calculate_diverter_snap_transform(diverter: Node3D, target_conveyor: Node3D) -> Dictionary:
	var target_transform := target_conveyor.global_transform
	var diverter_pos := diverter.global_transform.origin
	var diverter_size := _get_conveyor_size(diverter)
	var target_size := _get_conveyor_size(target_conveyor)
	var target_half_width := target_size.z / 2.0

	var target_left_edge := target_transform.origin - target_transform.basis.z * target_half_width
	var target_right_edge := target_transform.origin + target_transform.basis.z * target_half_width

	var snap_to_left := diverter_pos.distance_to(target_left_edge) <= diverter_pos.distance_to(target_right_edge)
	var side_sign := -1.0 if snap_to_left else 1.0
	var target_edge := target_left_edge if snap_to_left else target_right_edge

	var edge_start := target_edge - target_transform.basis.x * (target_size.x / 2.0)
	var edge_end := target_edge + target_transform.basis.x * (target_size.x / 2.0)
	var closest_point := _get_closest_point_on_line_segment(diverter_pos, edge_start, edge_end)

	var new_basis := Basis()
	new_basis.x = target_transform.basis.x.normalized()
	new_basis.z = side_sign * target_transform.basis.z.normalized()
	new_basis.y = new_basis.z.cross(new_basis.x).normalized()

	var snap_transform := Transform3D(
		new_basis,
		closest_point + new_basis.z * (diverter_size.z / 2.0) - new_basis.y * DIVERTER_Y_OFFSET
	)

	var edge_pos_local: Vector3 = target_transform.affine_inverse() * closest_point
	var snapped_end := {"pos": Vector3(0, 0, -diverter_size.z / 2.0), "outward": Vector3(0, 0, -1), "name": &"push_side"}
	var target_end := {
		"pos": edge_pos_local,
		"outward": Vector3(0, 0, side_sign),
		"name": (&"left_side" if snap_to_left else &"right_side"),
	}

	return _make_snap_result(snap_transform, snapped_end, target_end)


static func _open_side_guards_for_diverter(undo_redo: EditorUndoRedoManager, snap_transform: Transform3D, diverter: Node3D, target_conveyor: Node3D) -> void:
	var intersection_info := _calculate_conveyor_intersection_for_transform(diverter, target_conveyor, snap_transform)
	_shrink_guards_for_gap(undo_redo, target_conveyor, intersection_info)
