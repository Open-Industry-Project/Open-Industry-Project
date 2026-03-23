@tool
extends Node


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
		if _is_conveyor(node) and node != target_conveyor:
			selected_conveyors.append(node as Node3D)
	
	if selected_conveyors.is_empty():
		EditorInterface.get_editor_toaster().push_toast("No valid conveyors selected for snapping (target conveyor excluded)", EditorToaster.SEVERITY_WARNING)
		return
	
	var undo_redo := EditorInterface.get_editor_undo_redo()
	
	# Determine appropriate action name based on conveyor types and side guards
	var has_curved := false
	var has_side_guards := false
	
	for conveyor in selected_conveyors:
		if _is_curved_conveyor(conveyor) or _is_curved_conveyor(target_conveyor):
			has_curved = true
		if _has_side_guards(conveyor) or _has_side_guards(target_conveyor):
			has_side_guards = true
	
	var action_name: String
	if has_curved and has_side_guards:
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
		var snap_transform := _calculate_snap_transform(conveyor, target_conveyor)
		var original_side_guard_states: Dictionary = _store_side_guard_states([target_conveyor, conveyor])
		
		var intersection_info_target := Dictionary()
		if _has_side_guards(target_conveyor):
			intersection_info_target = _calculate_conveyor_intersection_for_transform(conveyor, target_conveyor, snap_transform)
		
		var retraction_info_snapped := Dictionary()
		if _has_side_guards(conveyor):
			retraction_info_snapped = _calculate_side_guard_retraction(conveyor, target_conveyor, snap_transform)
		
		var snapped_forward := snap_transform.basis.x.normalized()
		var target_forward := target_conveyor.global_transform.basis.x.normalized()
		var dot_product: float = abs(snapped_forward.dot(target_forward))
		var is_inline_connection: bool = dot_product > 0.7
		
		var target_right := target_conveyor.global_transform.basis.z.normalized()
		var side_alignment: float = abs(snapped_forward.dot(target_right))
		if side_alignment < 0.8:
			is_inline_connection = true
		
		undo_redo.add_do_property(conveyor, "global_transform", snap_transform)
		undo_redo.add_undo_property(conveyor, "global_transform", original_transform)
		
		if not intersection_info_target.is_empty() and intersection_info_target.get("intersections", []).size() > 0:
			var target_state: Dictionary = original_side_guard_states.get(target_conveyor.get_instance_id(), {})
			_add_side_guard_undo_redo_operations(undo_redo, target_conveyor, intersection_info_target, target_state)
		
		if not retraction_info_snapped.is_empty() and retraction_info_snapped.get("retractions", []).size() > 0:
			var snapped_state: Dictionary = original_side_guard_states.get(conveyor.get_instance_id(), {})
			_add_side_guard_retraction_operations(undo_redo, conveyor, retraction_info_snapped, snapped_state)
		elif is_inline_connection and _has_side_guards(conveyor):
			var inline_state: Dictionary = original_side_guard_states.get(conveyor.get_instance_id(), {})
			_clear_side_guard_openings_for_inline_connection(undo_redo, conveyor, inline_state)
	
	undo_redo.commit_action()


static func _store_side_guard_states(conveyors: Array[Node3D]) -> Dictionary:
	var states: Dictionary = {}
	for conveyor in conveyors:
		if _has_side_guards(conveyor):
			states[conveyor.get_instance_id()] = {
				"left_openings": conveyor.left_side_guards_openings.duplicate(true),
				"right_openings": conveyor.right_side_guards_openings.duplicate(true)
			}
	return states


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
	
	var intersections := []
	var tolerance := 0.001
	var side_guard_margin: float = 0.15 if _has_side_guards(snapped_conveyor) else 0.05
	
	var snapped_forward := snapped_transform.basis.x.normalized()
	var target_forward := target_transform.basis.x.normalized()
	var dot_product: float = abs(snapped_forward.dot(target_forward))
	var is_perpendicular: bool = dot_product < 0.7
	
	var target_right := target_transform.basis.z.normalized()
	var side_alignment: float = abs(snapped_forward.dot(target_right))
	if side_alignment > 0.3:
		is_perpendicular = true
	
	var opening_position: float = (min_bounds.x + max_bounds.x) / 2.0
	var opening_size: float = (max_bounds.x - min_bounds.x) + side_guard_margin
	
	if is_perpendicular and _has_spur_angles(snapped_conveyor):
		var spur_angles := _get_spur_angles(snapped_conveyor)
		var connecting_downstream: bool = snapped_local_transform.origin.x > 0.0
		var spur_angle: float = spur_angles.downstream if connecting_downstream else spur_angles.upstream
		if abs(spur_angle) > 0.001:
			var left_extent: float
			var right_extent: float
			if connecting_downstream:
				left_extent = snapped_half_length + tan(spur_angle) * (-snapped_half_width)
				right_extent = snapped_half_length + tan(spur_angle) * snapped_half_width
			else:
				left_extent = -snapped_half_length + tan(spur_angle) * (-snapped_half_width)
				right_extent = -snapped_half_length + tan(spur_angle) * snapped_half_width
			
			var side_guard_thickness: float = 0.1
			var edge_a: Vector3 = snapped_local_transform * Vector3(left_extent, 0, -snapped_half_width - side_guard_thickness)
			var edge_b: Vector3 = snapped_local_transform * Vector3(right_extent, 0, snapped_half_width + side_guard_thickness)
			
			var edge_min_x: float = min(edge_a.x, edge_b.x)
			var edge_max_x: float = max(edge_a.x, edge_b.x)
			edge_min_x = max(edge_min_x, -target_half_length)
			edge_max_x = min(edge_max_x, target_half_length)
			
			opening_position = (edge_min_x + edge_max_x) / 2.0
			opening_size = (edge_max_x - edge_min_x) + side_guard_margin
	
	if is_perpendicular:
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


static func _add_side_guard_undo_redo_operations(undo_redo: EditorUndoRedoManager, conveyor: Node3D, intersection_info: Dictionary, original_state: Dictionary) -> void:
	if not intersection_info.has("intersections"):
		return
	
	var intersections := intersection_info["intersections"] as Array
	
	for intersection in intersections:
		var side := intersection["side"] as String
		var position := intersection["position"] as float
		var size := intersection["size"] as float
		var new_opening := SideGuardOpening.new(position, size)
		
		if side == "left" and conveyor.left_side_guards_enabled:
			var left_openings: Array = original_state.get("left_openings", [])
			_add_opening_to_side(undo_redo, conveyor, "left_side_guards_openings", new_opening, left_openings)
		elif side == "right" and conveyor.right_side_guards_enabled:
			var right_openings: Array = original_state.get("right_openings", [])
			_add_opening_to_side(undo_redo, conveyor, "right_side_guards_openings", new_opening, right_openings)


static func _add_opening_to_side(undo_redo: EditorUndoRedoManager, conveyor: Node3D, property_name: String, new_opening: SideGuardOpening, original_openings: Array) -> void:
	var new_openings := original_openings.duplicate(true)
	
	var duplicate_found := false
	for existing_opening in new_openings:
		if existing_opening != null and abs(existing_opening.position - new_opening.position) < 0.1 and abs(existing_opening.size - new_opening.size) < 0.1:
			duplicate_found = true
			break
	
	if not duplicate_found:
		new_openings.append(new_opening)
		undo_redo.add_do_property(conveyor, property_name, new_openings)
		undo_redo.add_undo_property(conveyor, property_name, original_openings)


static func _has_side_guards(conveyor: Node3D) -> bool:
	return ("right_side_guards_enabled" in conveyor and 
			"left_side_guards_enabled" in conveyor and
			"right_side_guards_openings" in conveyor and
			"left_side_guards_openings" in conveyor)


static func _is_conveyor(node: Node) -> bool:
	if node is BeltConveyorAssembly or node is RollerConveyorAssembly or node is CurvedBeltConveyorAssembly or node is CurvedRollerConveyorAssembly:
		return true
	
	var node_script: Script = node.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := node.get_class()
	
	var conveyor_types := [
		"BeltSpurConveyor", "SpurConveyorAssembly", "BeltSpurConveyorAssembly",
		"BeltConveyor", "RollerConveyor", 
		"CurvedBeltConveyor", "CurvedRollerConveyor", "BeltConveyorAssembly", "RollerConveyorAssembly", 
		"CurvedBeltConveyorAssembly", "CurvedRollerConveyorAssembly"
	]
	
	return global_name in conveyor_types or node_class in conveyor_types


static func _calculate_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Transform3D:
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


static func _get_bottom_edge_offset(conveyor_size: Vector3, inclination_angle: float, conveyor_basis: Basis) -> Vector3:
	if abs(inclination_angle) < 0.001:
		return Vector3.ZERO
	
	var half_height := conveyor_size.y / 2.0
	var half_length := conveyor_size.x / 2.0
	
	var local_front_bottom := Vector3(half_length, -half_height, 0)
	var world_front_bottom := conveyor_basis * local_front_bottom
	
	return -world_front_bottom


static func _calculate_side_guard_retraction(snapped_conveyor: Node3D, target_conveyor: Node3D, snapped_transform: Transform3D) -> Dictionary:
	if not _has_side_guards(snapped_conveyor):
		return {}
	
	# Don't recess side guards when snapping straight conveyor assemblies to curved conveyors
	if _is_straight_conveyor_assembly(snapped_conveyor) and _is_curved_conveyor(target_conveyor):
		return {}
	
	var snapped_size := _get_conveyor_size(snapped_conveyor)
	var target_transform := target_conveyor.global_transform
	var target_size := _get_conveyor_size(target_conveyor)
	
	var snapped_forward := snapped_transform.basis.x.normalized()
	var target_forward := target_transform.basis.x.normalized()
	var dot_product: float = abs(snapped_forward.dot(target_forward))
	var is_perpendicular: bool = dot_product < 0.7
	
	var target_right := target_transform.basis.z.normalized()
	var side_alignment: float = abs(snapped_forward.dot(target_right))
	if side_alignment > 0.3:
		is_perpendicular = true
	
	var snapped_inverse := snapped_transform.affine_inverse()
	var target_local_transform := snapped_inverse * target_transform
	
	var target_half_length := target_size.x / 2.0
	var target_half_width := target_size.z / 2.0
	var snapped_half_length := snapped_size.x / 2.0
	var snapped_half_width := snapped_size.z / 2.0
	
	var retractions := []
	var retraction_margin := 0.2
	
	if is_perpendicular:
		var target_center_local := target_local_transform.origin
		var target_belt_center := target_center_local.x
		
		var target_width := target_size.z
		var margin := 0.15
		var gap_size := target_width + margin
		var recess_start := target_belt_center - gap_size / 2.0
		var recess_end := target_belt_center + gap_size / 2.0
		
		if _has_spur_angles(snapped_conveyor):
			var spur_angles := _get_spur_angles(snapped_conveyor)
			var connecting_downstream: bool = target_belt_center > 0.0
			var spur_angle: float = spur_angles.downstream if connecting_downstream else spur_angles.upstream
			if abs(spur_angle) > 0.001:
				var left_extent: float = snapped_half_length + tan(spur_angle) * (-snapped_half_width)
				var right_extent: float = snapped_half_length + tan(spur_angle) * snapped_half_width
				if not connecting_downstream:
					left_extent = -snapped_half_length + tan(spur_angle) * (-snapped_half_width)
					right_extent = -snapped_half_length + tan(spur_angle) * snapped_half_width
				
				var corners: Array[Vector3] = []
				corners.append(target_local_transform.origin + target_local_transform.basis.x * target_half_length + target_local_transform.basis.z * target_half_width)
				corners.append(target_local_transform.origin + target_local_transform.basis.x * target_half_length - target_local_transform.basis.z * target_half_width)
				corners.append(target_local_transform.origin - target_local_transform.basis.x * target_half_length - target_local_transform.basis.z * target_half_width)
				corners.append(target_local_transform.origin - target_local_transform.basis.x * target_half_length + target_local_transform.basis.z * target_half_width)
				
				var left_x_range := _get_x_range_at_z(corners, -snapped_half_width)
				var right_x_range := _get_x_range_at_z(corners, snapped_half_width)
				
				if left_x_range.size() == 2:
					if connecting_downstream:
						retractions.append({"side": "left", "start_position": left_x_range[0] - margin, "end_position": left_extent})
					else:
						retractions.append({"side": "left", "start_position": left_extent, "end_position": left_x_range[1] + margin})
				
				if right_x_range.size() == 2:
					if connecting_downstream:
						retractions.append({"side": "right", "start_position": right_x_range[0] - margin, "end_position": right_extent})
					else:
						retractions.append({"side": "right", "start_position": right_extent, "end_position": right_x_range[1] + margin})
		
		if retractions.is_empty():
			retractions.append({
				"side": "left",
				"start_position": recess_start,
				"end_position": recess_end
			})
			retractions.append({
				"side": "right", 
				"start_position": recess_start,
				"end_position": recess_end
			})
	
	return {"retractions": retractions}


static func _add_side_guard_retraction_operations(undo_redo: EditorUndoRedoManager, conveyor: Node3D, retraction_info: Dictionary, original_state: Dictionary) -> void:
	if not retraction_info.has("retractions"):
		return
	
	var retractions := retraction_info["retractions"] as Array
	
	for retraction in retractions:
		var side := retraction["side"] as String
		var start_pos := retraction["start_position"] as float
		var end_pos := retraction["end_position"] as float
		
		if side == "left" and conveyor.left_side_guards_enabled:
			var left_openings: Array = original_state.get("left_openings", [])
			var new_openings := _add_retraction_opening(left_openings, start_pos, end_pos)
			undo_redo.add_do_property(conveyor, "left_side_guards_openings", new_openings)
			undo_redo.add_undo_property(conveyor, "left_side_guards_openings", left_openings)
		
		elif side == "right" and conveyor.right_side_guards_enabled:
			var right_openings: Array = original_state.get("right_openings", [])
			var new_openings := _add_retraction_opening(right_openings, start_pos, end_pos)
			undo_redo.add_do_property(conveyor, "right_side_guards_openings", new_openings)
			undo_redo.add_undo_property(conveyor, "right_side_guards_openings", right_openings)


static func _add_retraction_opening(original_openings: Array, start_pos: float, end_pos: float) -> Array[SideGuardOpening]:
	var new_openings := original_openings.duplicate(true)
	var center_pos := (start_pos + end_pos) / 2.0
	var opening_size := end_pos - start_pos
	var new_opening := SideGuardOpening.new(center_pos, opening_size)
	
	var merged := false
	for i in range(new_openings.size()):
		var existing := new_openings[i] as SideGuardOpening
		if existing != null:
			var existing_start := existing.position - existing.size / 2.0
			var existing_end := existing.position + existing.size / 2.0
			
			if (start_pos <= existing_end + 0.1) and (end_pos >= existing_start - 0.1):
				var merged_start: float = min(start_pos, existing_start)
				var merged_end: float = max(end_pos, existing_end)
				new_openings[i] = SideGuardOpening.new((merged_start + merged_end) / 2.0, merged_end - merged_start)
				merged = true
				break
	
	if not merged:
		new_openings.append(new_opening)
	
	return new_openings


static func _clear_side_guard_openings_for_inline_connection(undo_redo: EditorUndoRedoManager, conveyor: Node3D, original_state: Dictionary) -> void:
	if not _has_side_guards(conveyor):
		return
	
	var side_guards_assembly: Node = null
	if conveyor.has_node("%SideGuardsAssembly"):
		side_guards_assembly = conveyor.get_node("%SideGuardsAssembly")
	elif conveyor.has_node("Conveyor/SideGuardsAssembly"):
		side_guards_assembly = conveyor.get_node("Conveyor/SideGuardsAssembly")
	elif conveyor.has_node("%Conveyor/%SideGuardsAssembly"):
		side_guards_assembly = conveyor.get_node("%Conveyor/%SideGuardsAssembly")
	
	if not side_guards_assembly:
		return
		
	var current_left_openings: Variant = side_guards_assembly.left_side_guards_openings
	var current_right_openings: Variant = side_guards_assembly.right_side_guards_openings
	
	if current_left_openings.size() > 0 or current_right_openings.size() > 0:
		var empty_left_openings: Array[SideGuardOpening] = []
		var empty_right_openings: Array[SideGuardOpening] = []
		
		side_guards_assembly.set("left_side_guards_openings", empty_left_openings)
		side_guards_assembly.set("right_side_guards_openings", empty_right_openings)
		
		undo_redo.add_undo_property(side_guards_assembly, "left_side_guards_openings", current_left_openings)
		undo_redo.add_undo_property(side_guards_assembly, "right_side_guards_openings", current_right_openings)


static func _is_curved_conveyor(conveyor: Node3D) -> bool:
	var node_script: Script = conveyor.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := conveyor.get_class()
	var node_name := conveyor.name
	
	# Check for curved conveyor types
	var curved_types := [
		"CurvedBeltConveyor", "CurvedRollerConveyor", "CurvedBeltConveyorAssembly", "CurvedRollerConveyorAssembly"
	]
	
	return (global_name in curved_types or 
			node_class in curved_types or 
			"Curved" in node_name or
			"curved" in node_name.to_lower())


static func _is_curved_roller_conveyor(conveyor: Node3D) -> bool:
	var node_script: Script = conveyor.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := conveyor.get_class()
	var node_name := conveyor.name
	
	# Check for curved roller conveyor types
	var curved_roller_types := [
		"CurvedRollerConveyor", "CurvedRollerConveyorAssembly"
	]
	
	return (global_name in curved_roller_types or 
			node_class in curved_roller_types or 
			("Curved" in node_name and "Roller" in node_name))


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
	var spur_types := ["BeltSpurConveyor", "SpurConveyorAssembly", "BeltSpurConveyorAssembly"]
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
		return 0.242
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


## Checks if any pair of ends is already aligned (close position + opposing outward).
static func _is_any_end_pair_snapped(selected_conveyor: Node3D, target_conveyor: Node3D, position_tolerance: float = 1.0) -> bool:
	var sel_ends := _get_end_info(selected_conveyor)
	var tgt_ends := _get_end_info(target_conveyor)
	var sel_transform := selected_conveyor.global_transform
	var tgt_transform := target_conveyor.global_transform

	for se in sel_ends:
		for te in tgt_ends:
			var se_pos: Vector3 = se.pos
			var te_pos: Vector3 = te.pos
			var sel_world: Vector3 = sel_transform * se_pos
			var tgt_world: Vector3 = tgt_transform * te_pos
			if sel_world.distance_to(tgt_world) > position_tolerance:
				continue
			var se_out: Vector3 = se.outward
			var te_out: Vector3 = te.outward
			var sel_out_world: Vector3 = (sel_transform.basis * se_out).normalized()
			var tgt_out_world: Vector3 = (tgt_transform.basis * te_out).normalized()
			if sel_out_world.dot(tgt_out_world) < -0.5:
				return true
	return false


static func _calculate_curved_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Transform3D:
	if _is_belt_conveyor(target_conveyor) and _is_belt_conveyor(selected_conveyor):
		return _calculate_regular_snap_transform(selected_conveyor, target_conveyor)

	var gap := _get_snap_gap(selected_conveyor, target_conveyor)
	var is_snapped := _is_any_end_pair_snapped(selected_conveyor, target_conveyor)

	var pair: Array[Dictionary]
	if is_snapped:
		pair = _find_resnap_end_pair(selected_conveyor, target_conveyor)
	else:
		pair = _find_closest_end_pair(selected_conveyor, target_conveyor)

	return _snap_end_to_end(selected_conveyor, pair[0], target_conveyor, pair[1], gap)


## Computes a snap transform for a spur conveyor connecting to a target.
## When the spur is near a target's side, the spur's angled edge outward is used
## so the spur connects at the angle defined by its downstream/upstream angles.
## When nearer to a target's end, falls back to regular (inline) snapping.
static func _calculate_spur_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Transform3D:
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
	var side_closest: Vector3
	if dist_left < dist_right:
		side_outward = Vector3(0, 0, -1)
		side_closest = left_closest
	else:
		side_outward = Vector3(0, 0, 1)
		side_closest = right_closest

	var side_pos_local: Vector3 = tgt_transform.affine_inverse() * side_closest
	var side_end := {"pos": side_pos_local, "outward": side_outward}

	var sel_ends := _get_spur_end_info(selected_conveyor)
	var best_sel: Dictionary = sel_ends[0]
	var best_dist := INF
	for se in sel_ends:
		var se_world: Vector3 = sel_transform * (se.pos as Vector3)
		var dist := se_world.distance_to(side_closest)
		if dist < best_dist:
			best_dist = dist
			best_sel = se

	return _snap_end_to_end(selected_conveyor, best_sel, target_conveyor, side_end, 0.0)


## Computes a snap transform for a straight conveyor connecting to a spur target.
## When the straight conveyor is near the spur's angled ends, the spur's angled
## outward vectors guide the straight conveyor's rotation so it aligns with the
## spur's edge angle. When nearer to the spur's sides, falls back to regular snap.
static func _calculate_snap_to_spur_target_transform(selected_conveyor: Node3D, target_spur: Node3D) -> Transform3D:
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

	return _snap_end_to_end(selected_conveyor, best_sel, target_spur, best_tgt, 0.0)


static func _is_belt_conveyor(conveyor: Node3D) -> bool:
	var node_script: Script = conveyor.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := conveyor.get_class()
	var node_name := conveyor.name
	
	# Check for belt conveyor types (straight conveyors)
	var belt_types := [
		"BeltConveyor", "BeltConveyorAssembly", "BeltSpurConveyor", "SpurConveyorAssembly", "BeltSpurConveyorAssembly",
		"RollerConveyor", "RollerConveyorAssembly"  # Added RollerConveyor types
	]
	
	return (global_name in belt_types or 
			node_class in belt_types or 
			("Belt" in node_name and "Curved" not in node_name) or
			("Roller" in node_name and "Curved" not in node_name))




static func _calculate_regular_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Transform3D:
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
	
	if min_distance == distance_to_front:
		var new_basis := _apply_inclination_to_basis(target_transform.basis, selected_inclination)
		var connection_position := target_front_edge + target_transform.basis.x * (selected_size.x / 2.0)
		var height_offset := _get_bottom_edge_offset(selected_size, selected_inclination, new_basis)
		snap_transform.basis = new_basis
		snap_transform.origin = connection_position + height_offset
		
	elif min_distance == distance_to_back:
		var new_basis := _apply_inclination_to_basis(target_transform.basis, selected_inclination)
		var connection_position := target_back_edge - target_transform.basis.x * (selected_size.x / 2.0)
		var height_offset := _get_bottom_edge_offset(selected_size, selected_inclination, new_basis)
		snap_transform.basis = new_basis
		snap_transform.origin = connection_position + height_offset
		
	elif min_distance == distance_to_left:
		var edge_start := target_transform.origin - target_transform.basis.z * (target_size.z / 2.0) - target_transform.basis.x * (target_size.x / 2.0)
		var edge_end := target_transform.origin - target_transform.basis.z * (target_size.z / 2.0) + target_transform.basis.x * (target_size.x / 2.0)
		var closest_point_on_edge := _get_closest_point_on_line_segment(selected_position, edge_start, edge_end)
		
		var perpendicular_basis := Basis()
		perpendicular_basis.x = target_transform.basis.z
		perpendicular_basis.y = target_transform.basis.y
		perpendicular_basis.z = -target_transform.basis.x
		var new_basis := _apply_inclination_to_basis(perpendicular_basis, selected_inclination)
		var connection_position := closest_point_on_edge - target_transform.basis.z * (selected_size.x / 2.0)
		var height_offset := _get_bottom_edge_offset(selected_size, selected_inclination, new_basis)
		snap_transform.basis = new_basis
		snap_transform.origin = connection_position + height_offset
		
	else:
		var edge_start := target_transform.origin + target_transform.basis.z * (target_size.z / 2.0) - target_transform.basis.x * (target_size.x / 2.0)
		var edge_end := target_transform.origin + target_transform.basis.z * (target_size.z / 2.0) + target_transform.basis.x * (target_size.x / 2.0)
		var closest_point_on_edge := _get_closest_point_on_line_segment(selected_position, edge_start, edge_end)
		
		var perpendicular_basis := Basis()
		perpendicular_basis.x = -target_transform.basis.z
		perpendicular_basis.y = target_transform.basis.y
		perpendicular_basis.z = target_transform.basis.x
		var new_basis := _apply_inclination_to_basis(perpendicular_basis, selected_inclination)
		var connection_position := closest_point_on_edge + target_transform.basis.z * (selected_size.x / 2.0)
		var height_offset := _get_bottom_edge_offset(selected_size, selected_inclination, new_basis)
		snap_transform.basis = new_basis
		snap_transform.origin = connection_position + height_offset
	
	return snap_transform
