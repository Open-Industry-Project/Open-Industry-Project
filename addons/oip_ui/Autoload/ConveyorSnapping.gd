@tool
extends Node

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
	
	var opening_position: float
	if is_perpendicular:
		opening_position = snapped_local_transform.origin.x
	else:
		opening_position = (min_bounds.x + max_bounds.x) / 2.0
	
	if is_perpendicular:
		if max_bounds.z >= (-target_half_width - tolerance) and min_bounds.z <= (-target_half_width + tolerance):
			intersections.append({
				"side": "left",
				"position": opening_position,
				"size": (max_bounds.x - min_bounds.x) + side_guard_margin
			})
		
		if min_bounds.z <= (target_half_width + tolerance) and max_bounds.z >= (target_half_width - tolerance):
			intersections.append({
				"side": "right",
				"position": opening_position,
				"size": (max_bounds.x - min_bounds.x) + side_guard_margin
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
		"BeltSpurConveyor", "SpurConveyorAssembly", "BeltConveyor", "RollerConveyor", 
		"CurvedBeltConveyor", "CurvedRollerConveyor", "BeltConveyorAssembly", "RollerConveyorAssembly", 
		"CurvedBeltConveyorAssembly", "CurvedRollerConveyorAssembly"
	]
	
	return global_name in conveyor_types or node_class in conveyor_types


static func _calculate_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Transform3D:
	# Check if either conveyor is curved - if so, use marker-based snapping
	if _is_curved_conveyor(selected_conveyor) or _is_curved_conveyor(target_conveyor):
		return _calculate_curved_snap_transform(selected_conveyor, target_conveyor)
	
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


static func _get_conveyor_markers(conveyor: Node3D) -> Array[Marker3D]:
	var markers: Array[Marker3D] = []
	
	for child in conveyor.get_children():
		if child is Marker3D and ("CurvedEndMarker" in child.name or "curved" in child.name.to_lower()):
			markers.append(child as Marker3D)
		_find_markers_recursive(child, markers)
	
	return markers


static func _find_markers_recursive(node: Node, markers: Array[Marker3D]) -> void:
	for child in node.get_children():
		if child is Marker3D and ("CurvedEndMarker" in child.name or "curved" in child.name.to_lower()):
			markers.append(child as Marker3D)
		_find_markers_recursive(child, markers)


static func _calculate_curved_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Transform3D:
	var target_transform := target_conveyor.global_transform
	var selected_transform := selected_conveyor.global_transform
	
	# Check conveyor types for different snapping scenarios
	var is_target_belt_conveyor := _is_belt_conveyor(target_conveyor)
	var is_selected_belt_conveyor := _is_belt_conveyor(selected_conveyor)
	
	if is_target_belt_conveyor and is_selected_belt_conveyor:
		# BeltConveyor snapping to BeltConveyor (existing logic)
		return _calculate_regular_snap_transform(selected_conveyor, target_conveyor)
	elif is_target_belt_conveyor and not is_selected_belt_conveyor:
		# CurvedBeltConveyor snapping to BeltConveyor
		# Check if conveyor is already snapped (same position, perpendicular rotation)
		var is_already_snapped := _is_conveyor_already_snapped(selected_conveyor, target_conveyor)
		if is_already_snapped:
			return _calculate_second_snap_transform(selected_conveyor, target_conveyor)
		else:
			return _calculate_curved_to_belt_snap_transform(selected_conveyor, target_conveyor)
	elif not is_target_belt_conveyor and is_selected_belt_conveyor:
		# BeltConveyor snapping to CurvedBeltConveyor (no resnap)
		return _calculate_belt_to_curved_snap_transform(selected_conveyor, target_conveyor)
	else:
		# CurvedBeltConveyor snapping to CurvedBeltConveyor
		# Check if conveyor is already snapped (same position, perpendicular rotation)
		var is_already_snapped := _is_conveyor_already_snapped(selected_conveyor, target_conveyor)
		if is_already_snapped:
			return _calculate_second_snap_transform(selected_conveyor, target_conveyor)
		else:
			return _calculate_curved_to_curved_snap_transform(selected_conveyor, target_conveyor)


static func _is_conveyor_already_snapped(selected_conveyor: Node3D, target_conveyor: Node3D) -> bool:
	var target_pos := target_conveyor.global_position
	var selected_pos := selected_conveyor.global_position
	
	# Check if target is a BeltConveyor
	var is_target_belt_conveyor := _is_belt_conveyor(target_conveyor)
	
	if is_target_belt_conveyor:
		# CurvedBeltConveyor to BeltConveyor snapping detection
		return _is_curved_to_belt_already_snapped(selected_conveyor, target_conveyor)
	else:
		# CurvedBeltConveyor to CurvedBeltConveyor snapping detection (existing logic)
		return _is_curved_to_curved_already_snapped(selected_conveyor, target_conveyor)


static func _calculate_second_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Transform3D:
	var target_transform := target_conveyor.global_transform
	var target_pos := target_conveyor.global_position
	var selected_pos := selected_conveyor.global_position
	var relative_pos := selected_pos - target_pos
	
	# Transform relative position to target's local space
	var target_right := target_transform.basis.z.normalized()
	var target_forward := target_transform.basis.x.normalized()
	var right_component := relative_pos.dot(target_right)
	var forward_component := relative_pos.dot(target_forward)
	
	# Check if target is a BeltConveyor
	var is_target_belt_conveyor := _is_belt_conveyor(target_conveyor)
	
	if is_target_belt_conveyor:
		# CurvedBeltConveyor resnapping to BeltConveyor
		return _calculate_curved_to_belt_resnap_transform(selected_conveyor, target_conveyor)
	else:
		# CurvedBeltConveyor resnapping to CurvedBeltConveyor (existing logic)
		return _calculate_curved_to_curved_resnap_transform(selected_conveyor, target_conveyor)


static func _is_belt_conveyor(conveyor: Node3D) -> bool:
	var node_script: Script = conveyor.get_script()
	var global_name: String = node_script.get_global_name() if node_script != null else ""
	var node_class := conveyor.get_class()
	var node_name := conveyor.name
	
	# Check for belt conveyor types (straight conveyors)
	var belt_types := [
		"BeltConveyor", "BeltConveyorAssembly", "BeltSpurConveyor", "SpurConveyorAssembly",
		"RollerConveyor", "RollerConveyorAssembly"  # Added RollerConveyor types
	]
	
	return (global_name in belt_types or 
			node_class in belt_types or 
			("Belt" in node_name and "Curved" not in node_name) or
			("Roller" in node_name and "Curved" not in node_name))


static func _calculate_curved_to_curved_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Transform3D:
	var target_transform := target_conveyor.global_transform
	var target_pos := target_conveyor.global_position
	var selected_pos := selected_conveyor.global_position
	var relative_pos := selected_pos - target_pos
	
	var target_right := target_transform.basis.z.normalized()
	var target_forward := target_transform.basis.x.normalized()
	var right_component := relative_pos.dot(target_right)
	var forward_component := relative_pos.dot(target_forward)
	
	var snap_position: Vector3
	var snap_rotation: Vector3
	
	var target_inner_radius: float = 0.5
	var selected_inner_radius: float = 0.5
	if "inner_radius" in target_conveyor:
		target_inner_radius = target_conveyor.inner_radius
	if "inner_radius" in selected_conveyor:
		selected_inner_radius = selected_conveyor.inner_radius
	
	if abs(right_component) > abs(forward_component):
		if right_component > 0:
			var local_offset := Vector3(0.5, 0, target_inner_radius - selected_inner_radius)
			if _is_curved_roller_conveyor(selected_conveyor) and not _is_curved_roller_conveyor(target_conveyor):
				local_offset.z += 0.115
			elif _is_curved_roller_conveyor(target_conveyor) and not _is_curved_roller_conveyor(selected_conveyor):
				local_offset.z -= 0.115
			snap_position = target_pos + target_transform.basis * local_offset
			snap_rotation = target_transform.basis.get_euler() + Vector3(0, deg_to_rad(90), 0)
		else:
			var local_offset := Vector3(-(target_inner_radius - selected_inner_radius), 0, -0.5)
			if _is_curved_roller_conveyor(selected_conveyor) and not _is_curved_roller_conveyor(target_conveyor):
				local_offset.x += 0.115
			elif _is_curved_roller_conveyor(target_conveyor) and not _is_curved_roller_conveyor(selected_conveyor):
				local_offset.x -= 0.115
			snap_position = target_pos + target_transform.basis * local_offset
			snap_rotation = target_transform.basis.get_euler() + Vector3(0, deg_to_rad(-90), 0)
	else:
		if forward_component > 0:
			var local_offset := Vector3(0.5, 0, target_inner_radius - selected_inner_radius)
			if _is_curved_roller_conveyor(selected_conveyor) and not _is_curved_roller_conveyor(target_conveyor):
				local_offset.z -= 0.115
			elif _is_curved_roller_conveyor(target_conveyor) and not _is_curved_roller_conveyor(selected_conveyor):
				local_offset.z += 0.115
			snap_position = target_pos + target_transform.basis * local_offset
			snap_rotation = target_transform.basis.get_euler() + Vector3(0, deg_to_rad(90), 0)
		else:
			var local_offset := Vector3(-(target_inner_radius - selected_inner_radius), 0, -0.5)
			if _is_curved_roller_conveyor(selected_conveyor) and not _is_curved_roller_conveyor(target_conveyor):
				local_offset.x -= 0.115
			elif _is_curved_roller_conveyor(target_conveyor) and not _is_curved_roller_conveyor(selected_conveyor):
				local_offset.x += 0.115
			snap_position = target_pos + target_transform.basis * local_offset
			snap_rotation = target_transform.basis.get_euler() + Vector3(0, deg_to_rad(-90), 0)
	
	var final_basis := Basis.from_euler(snap_rotation)
	return Transform3D(final_basis, snap_position)


static func _calculate_curved_to_belt_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Transform3D:
	var target_transform := target_conveyor.global_transform
	var target_pos := target_conveyor.global_position
	var selected_pos := selected_conveyor.global_position
	var relative_pos := selected_pos - target_pos
	
	var target_right := target_transform.basis.z.normalized()
	var target_forward := target_transform.basis.x.normalized()
	var forward_component := relative_pos.dot(target_forward)
	
	var snap_position: Vector3
	var snap_rotation: Vector3
	
	var selected_inner_radius: float = 0.5
	if "inner_radius" in selected_conveyor:
		selected_inner_radius = selected_conveyor.inner_radius
	
	var target_size := _get_conveyor_size(target_conveyor)
	var x_offset := target_size.x / 2.0 + 0.25
	
	if forward_component > 0:
		var local_offset := Vector3(x_offset, 0, -1.262 - (selected_inner_radius - 0.5))
		if _is_curved_roller_conveyor(selected_conveyor):
			local_offset.z += 0.115
		snap_position = target_pos + target_transform.basis * local_offset
		snap_rotation = target_transform.basis.get_euler() + Vector3(0, deg_to_rad(90), 0)
	else:
		var local_offset := Vector3(-x_offset, 0, -1.262 - (selected_inner_radius - 0.5))
		if _is_curved_roller_conveyor(selected_conveyor):
			local_offset.z += 0.115
		snap_position = target_pos + target_transform.basis * local_offset
		snap_rotation = target_transform.basis.get_euler() + Vector3(0, deg_to_rad(0), 0)
	
	var final_basis := Basis.from_euler(snap_rotation)
	return Transform3D(final_basis, snap_position)


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


static func _group_markers_by_ends(markers: Array[Marker3D]) -> Array[Array]:
	if markers.size() != 4:
		return []
	
	var conveyor: Node3D = null
	for marker in markers:
		var current_node: Node = marker
		while current_node != null:
			if current_node is Node3D and current_node.get_script() != null:
				conveyor = current_node as Node3D
				break
			current_node = current_node.get_parent()
		if conveyor != null:
			break
	
	if conveyor == null:
		var sorted_markers := markers.duplicate()
		sorted_markers.sort_custom(func(a, b): return a.global_position.x < b.global_position.x)
		var front_end: Array[Marker3D] = [sorted_markers[0], sorted_markers[1]]
		var back_end: Array[Marker3D] = [sorted_markers[2], sorted_markers[3]]
		return [front_end, back_end]
	
	var markers_with_local_pos: Array = []
	for marker in markers:
		var local_pos := conveyor.global_transform.affine_inverse() * marker.global_position
		markers_with_local_pos.append({"marker": marker, "local_pos": local_pos})
	
	markers_with_local_pos.sort_custom(func(a, b): return a.local_pos.x < b.local_pos.x)
	
	var front_end: Array[Marker3D] = [markers_with_local_pos[0].marker, markers_with_local_pos[1].marker]
	var back_end: Array[Marker3D] = [markers_with_local_pos[2].marker, markers_with_local_pos[3].marker]
	
	return [front_end, back_end]


static func _would_cause_overlap(selected_conveyor: Node3D, target_conveyor: Node3D, selected_end: Array[Marker3D], target_end: Array[Marker3D]) -> bool:
	if selected_end.is_empty() or target_end.is_empty():
		return false
	
	# For now, use a simpler overlap detection focusing on end-to-end distance vs conveyor sizes
	var target_end_center := _get_end_center_position(target_end)
	var selected_end_center := _get_end_center_position(selected_end)
	
	# Get approximate conveyor lengths to check for overlap
	var target_size := _get_conveyor_size(target_conveyor)
	var selected_size := _get_conveyor_size(selected_conveyor)
	
	# Calculate centers and directions
	var target_center := target_conveyor.global_position
	var selected_center := selected_conveyor.global_position
	
	# Direction from target center to its end
	var target_to_end := target_end_center - target_center
	
	# Estimate where selected center would be after snapping
	var offset := selected_center - selected_end_center
	var projected_selected_center := target_end_center + offset
	
	# Check if this would place the selected conveyor center very close to the target center
	# This indicates potential overlap
	var distance_to_target_center := projected_selected_center.distance_to(target_center)
	var min_safe_distance := (target_size.x + selected_size.x) * 0.1  # More permissive threshold
	
	return distance_to_target_center < min_safe_distance


static func _get_end_center_position(end: Array[Marker3D]) -> Vector3:
	if end.is_empty():
		return Vector3.ZERO
	
	var center := Vector3.ZERO
	for marker in end:
		center += marker.global_position
	
	return center / float(end.size())


static func _calculate_end_alignment_transform(selected_conveyor: Node3D, selected_end: Array[Marker3D], target_end: Array[Marker3D]) -> Transform3D:
	if selected_end.is_empty() or target_end.is_empty():
		EditorInterface.get_editor_toaster().push_toast("Cannot align empty marker ends", EditorToaster.SEVERITY_ERROR)
		return selected_conveyor.global_transform
	
	if selected_end.size() >= 2 and target_end.size() >= 2:
		return _calculate_best_marker_pair_alignment(selected_conveyor, selected_end, target_end)
	else:
		return _calculate_single_marker_alignment(selected_conveyor, selected_end[0], target_end[0])


static func _calculate_best_marker_pair_alignment(selected_conveyor: Node3D, selected_end: Array[Marker3D], target_end: Array[Marker3D]) -> Transform3D:
	var min_distance := INF
	var best_selected_marker: Marker3D = null
	var best_target_marker: Marker3D = null
	
	for selected_marker in selected_end:
		for target_marker in target_end:
			var distance := selected_marker.global_position.distance_to(target_marker.global_position)
			if distance < min_distance:
				min_distance = distance
				best_selected_marker = selected_marker
				best_target_marker = target_marker
	
	var remaining_selected: Array[Marker3D] = []
	var remaining_target: Array[Marker3D] = []
	
	for marker in selected_end:
		if marker != best_selected_marker:
			remaining_selected.append(marker)
	
	for marker in target_end:
		if marker != best_target_marker:
			remaining_target.append(marker)
	
	var second_selected_marker: Marker3D = null
	var second_target_marker: Marker3D = null
	
	if remaining_selected.size() > 0 and remaining_target.size() > 0:
		var second_min_distance := INF
		for selected_marker in remaining_selected:
			for target_marker in remaining_target:
				var distance := selected_marker.global_position.distance_to(target_marker.global_position)
				if distance < second_min_distance:
					second_min_distance = distance
					second_selected_marker = selected_marker
					second_target_marker = target_marker
		
		var selected_pair: Array[Marker3D] = [best_selected_marker, second_selected_marker]
		var target_pair: Array[Marker3D] = [best_target_marker, second_target_marker]
		return _calculate_dual_marker_alignment(selected_conveyor, selected_pair, target_pair)
	else:
		return _calculate_single_marker_alignment(selected_conveyor, best_selected_marker, best_target_marker)


static func _calculate_dual_marker_alignment(selected_conveyor: Node3D, selected_end: Array[Marker3D], target_end: Array[Marker3D]) -> Transform3D:
	selected_end.sort_custom(func(a, b): return a.global_position.z < b.global_position.z)
	target_end.sort_custom(func(a, b): return a.global_position.z < b.global_position.z)
	
	var selected_marker1 := selected_end[0]
	var selected_marker2 := selected_end[1]
	var target_marker1 := target_end[0]
	var target_marker2 := target_end[1]
	
	var selected_spacing := selected_marker1.global_position.distance_to(selected_marker2.global_position)
	var target_spacing := target_marker1.global_position.distance_to(target_marker2.global_position)
	var spacings_match: bool = abs(selected_spacing - target_spacing) < 0.01
	
	if not spacings_match:
		var swap_spacing_1_2: float = selected_marker1.global_position.distance_to(target_marker2.global_position)
		var swap_spacing_2_1: float = selected_marker2.global_position.distance_to(target_marker1.global_position)
		
		if (swap_spacing_1_2 + swap_spacing_2_1) < (selected_marker1.global_position.distance_to(target_marker1.global_position) + selected_marker2.global_position.distance_to(target_marker2.global_position)):
			var temp_marker := target_marker1
			target_marker1 = target_marker2
			target_marker2 = temp_marker
	
	var selected_marker1_local := selected_conveyor.global_transform.affine_inverse() * selected_marker1.global_position
	var selected_marker2_local := selected_conveyor.global_transform.affine_inverse() * selected_marker2.global_position
	
	var snap_transform: Transform3D
	
	if spacings_match:
		var target_direction := (target_marker2.global_position - target_marker1.global_position).normalized()
		var selected_direction_local := (selected_marker2_local - selected_marker1_local).normalized()
		var selected_direction_world := selected_conveyor.global_transform.basis * selected_direction_local
		
		var rotation_quat: Quaternion
		if selected_direction_world.length_squared() > 0.001 and target_direction.length_squared() > 0.001:
			rotation_quat = Quaternion(selected_direction_world, target_direction)
		else:
			rotation_quat = Quaternion.IDENTITY
		
		var new_basis := Basis(rotation_quat) * selected_conveyor.global_transform.basis
		var rotated_marker1_local := new_basis * selected_marker1_local
		var rotated_marker2_local := new_basis * selected_marker2_local
		
		var translation1 := target_marker1.global_position - rotated_marker1_local
		var translation2 := target_marker2.global_position - rotated_marker2_local
		var final_translation := (translation1 + translation2) * 0.5
		
		snap_transform = Transform3D(new_basis, final_translation)
	else:
		var selected_center_local := (selected_marker1_local + selected_marker2_local) * 0.5
		var target_center := (target_marker1.global_position + target_marker2.global_position) * 0.5
		var target_direction := (target_marker2.global_position - target_marker1.global_position).normalized()
		var selected_direction_local := (selected_marker2_local - selected_marker1_local).normalized()
		
		var rotation_quat: Quaternion
		if selected_direction_local.length_squared() > 0.001 and target_direction.length_squared() > 0.001:
			rotation_quat = Quaternion(selected_direction_local, target_direction)
			rotation_quat = rotation_quat.slerp(Quaternion.IDENTITY, 0.4)
		else:
			rotation_quat = Quaternion.IDENTITY
		
		var new_basis := Basis(rotation_quat) * selected_conveyor.global_transform.basis
		var rotated_center_local := new_basis * selected_center_local
		var translation := target_center - rotated_center_local
		
		snap_transform = Transform3D(new_basis, translation)
	
	return snap_transform


static func _calculate_single_marker_alignment(selected_conveyor: Node3D, selected_marker: Marker3D, target_marker: Marker3D) -> Transform3D:
	var target_marker_global := target_marker.global_transform
	var selected_marker_local := selected_marker.transform
	var selected_conveyor_to_marker := selected_marker_local
	var marker_to_conveyor := selected_conveyor_to_marker.affine_inverse()
	var snap_transform := target_marker_global * marker_to_conveyor
	var selected_inclination := _get_z_inclination(selected_conveyor.global_transform)
	snap_transform.basis = _apply_inclination_to_basis(snap_transform.basis, selected_inclination)
	return snap_transform


static func _calculate_curved_to_curved_resnap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Transform3D:
	var target_transform := target_conveyor.global_transform
	var target_pos := target_conveyor.global_position
	var selected_pos := selected_conveyor.global_position
	var relative_pos := selected_pos - target_pos
	
	var target_right := target_transform.basis.z.normalized()
	var target_forward := target_transform.basis.x.normalized()
	var right_component := relative_pos.dot(target_right)
	var forward_component := relative_pos.dot(target_forward)
	
	var snap_position: Vector3
	var snap_rotation: Vector3
	
	var target_inner_radius: float = 0.5
	var selected_inner_radius: float = 0.5
	if "inner_radius" in target_conveyor:
		target_inner_radius = target_conveyor.inner_radius
	if "inner_radius" in selected_conveyor:
		selected_inner_radius = selected_conveyor.inner_radius
	
	if abs(right_component) > abs(forward_component):
		if right_component > 0:
			var local_offset := Vector3(0.5, 0, target_inner_radius + selected_inner_radius + 1.5)
			if _is_curved_roller_conveyor(selected_conveyor) and _is_curved_roller_conveyor(target_conveyor):
				local_offset.z -= 0.22
			elif _is_curved_roller_conveyor(selected_conveyor) and not _is_curved_roller_conveyor(target_conveyor):
				local_offset.z -= 0.115
			elif _is_curved_roller_conveyor(target_conveyor) and not _is_curved_roller_conveyor(selected_conveyor):
				local_offset.z -= 0.115
			snap_position = target_pos + target_transform.basis * local_offset
			snap_rotation = target_transform.basis.get_euler() + Vector3(0, deg_to_rad(180), 0)
		else:
			var local_offset := Vector3(-(target_inner_radius + selected_inner_radius + 1.5), 0, -0.5)
			if _is_curved_roller_conveyor(selected_conveyor) and _is_curved_roller_conveyor(target_conveyor):
				local_offset.x += 0.22
			elif _is_curved_roller_conveyor(selected_conveyor) and not _is_curved_roller_conveyor(target_conveyor):
				local_offset.x += 0.115
			elif _is_curved_roller_conveyor(target_conveyor) and not _is_curved_roller_conveyor(selected_conveyor):
				local_offset.x += 0.115
			snap_position = target_pos + target_transform.basis * local_offset
			snap_rotation = target_transform.basis.get_euler() + Vector3(0, deg_to_rad(180), 0)
	else:
		if forward_component < 0:
			var local_offset := Vector3(-(target_inner_radius + selected_inner_radius + 1.5), 0, -0.5)
			if _is_curved_roller_conveyor(selected_conveyor) and _is_curved_roller_conveyor(target_conveyor):
				local_offset.x += 0.22
			elif _is_curved_roller_conveyor(selected_conveyor) and not _is_curved_roller_conveyor(target_conveyor):
				local_offset.x += 0.115
			elif _is_curved_roller_conveyor(target_conveyor) and not _is_curved_roller_conveyor(selected_conveyor):
				local_offset.x += 0.115
			snap_position = target_pos + target_transform.basis * local_offset
			snap_rotation = target_transform.basis.get_euler() + Vector3(0, deg_to_rad(180), 0)
		else:
			var local_offset := Vector3(0.5, 0, target_inner_radius + selected_inner_radius + 1.5)
			if _is_curved_roller_conveyor(selected_conveyor) and _is_curved_roller_conveyor(target_conveyor):
				local_offset.z -= 0.22
			elif _is_curved_roller_conveyor(selected_conveyor) and not _is_curved_roller_conveyor(target_conveyor):
				local_offset.z -= 0.115
			elif _is_curved_roller_conveyor(target_conveyor) and not _is_curved_roller_conveyor(selected_conveyor):
				local_offset.z -= 0.115
			snap_position = target_pos + target_transform.basis * local_offset
			snap_rotation = target_transform.basis.get_euler() + Vector3(0, deg_to_rad(180), 0)
	
	var final_basis := Basis.from_euler(snap_rotation)
	return Transform3D(final_basis, snap_position)


static func _calculate_curved_to_belt_resnap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Transform3D:
	var target_transform := target_conveyor.global_transform
	var target_pos := target_conveyor.global_position
	var selected_pos := selected_conveyor.global_position
	var relative_pos := selected_pos - target_pos
	
	var target_right := target_transform.basis.z.normalized()
	var target_forward := target_transform.basis.x.normalized()
	var forward_component := relative_pos.dot(target_forward)
	
	var snap_position: Vector3
	var snap_rotation: Vector3
	
	var selected_inner_radius: float = 0.5
	if "inner_radius" in selected_conveyor:
		selected_inner_radius = selected_conveyor.inner_radius
	
	var target_size := _get_conveyor_size(target_conveyor)
	var x_offset := target_size.x / 2.0 + 0.25
	
	if forward_component > 0:
		var local_offset := Vector3(x_offset, 0, 1.262 + selected_inner_radius - 0.5)
		if _is_curved_roller_conveyor(selected_conveyor):
			local_offset.z -= 0.115
		snap_position = target_pos + target_transform.basis * local_offset
		snap_rotation = target_transform.basis.get_euler() + Vector3(0, deg_to_rad(180), 0)
	else:
		var local_offset := Vector3(-x_offset, 0, 1.262 + selected_inner_radius - 0.5)
		if _is_curved_roller_conveyor(selected_conveyor):
			local_offset.z -= 0.115
		snap_position = target_pos + target_transform.basis * local_offset
		snap_rotation = target_transform.basis.get_euler() + Vector3(0, deg_to_rad(-90), 0)
	
	var final_basis := Basis.from_euler(snap_rotation)
	return Transform3D(final_basis, snap_position)


static func _calculate_belt_to_curved_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Transform3D:
	var target_transform := target_conveyor.global_transform
	var target_pos := target_conveyor.global_position
	var selected_pos := selected_conveyor.global_position
	var relative_pos := selected_pos - target_pos
	
	var target_right := target_transform.basis.z.normalized()
	var target_forward := target_transform.basis.x.normalized()
	var forward_component := relative_pos.dot(target_forward)
	
	var snap_position: Vector3
	var snap_rotation: Vector3
	
	var target_inner_radius: float = 0.5
	if "inner_radius" in target_conveyor:
		target_inner_radius = target_conveyor.inner_radius
	
	var selected_size := _get_conveyor_size(selected_conveyor)
	var x_offset_front := -(1.262 + (target_inner_radius - 0.5))
	var x_offset_back := selected_size.x / 2.0 + 0.242
	var z_offset_front := selected_size.x / 2.0 + 0.242
	var z_offset_back := 1.258 + (target_inner_radius - 0.5)
	
	if forward_component > 0:
		var local_offset := Vector3(x_offset_front, 0, -z_offset_front)
		if _is_curved_roller_conveyor(target_conveyor):
			local_offset.x += 0.115
		snap_position = target_pos + target_transform.basis * local_offset
		snap_rotation = target_transform.basis.get_euler() + Vector3(0, deg_to_rad(90), 0)
	else:
		var local_offset := Vector3(x_offset_back, 0, z_offset_back)
		if _is_curved_roller_conveyor(target_conveyor):
			local_offset.z -= 0.115
		snap_position = target_pos + target_transform.basis * local_offset
		snap_rotation = target_transform.basis.get_euler() + Vector3(0, deg_to_rad(0), 0)
	
	var final_basis := Basis.from_euler(snap_rotation)
	return Transform3D(final_basis, snap_position)


static func _is_curved_to_curved_already_snapped(selected_conveyor: Node3D, target_conveyor: Node3D) -> bool:
	var target_pos := target_conveyor.global_position
	var selected_pos := selected_conveyor.global_position
	
	var target_inner_radius: float = 0.5
	var selected_inner_radius: float = 0.5
	if "inner_radius" in target_conveyor:
		target_inner_radius = target_conveyor.inner_radius
	if "inner_radius" in selected_conveyor:
		selected_inner_radius = selected_conveyor.inner_radius
	
	var target_transform := target_conveyor.global_transform
	var target_right := target_transform.basis.z.normalized()
	var target_forward := target_transform.basis.x.normalized()
	var relative_pos := selected_pos - target_pos
	var right_component := relative_pos.dot(target_right)
	var forward_component := relative_pos.dot(target_forward)
	
	var expected_first_snap_pos: Vector3
	if abs(right_component) > abs(forward_component):
		if right_component > 0:
			expected_first_snap_pos = target_pos + target_transform.basis * Vector3(0.5, 0, target_inner_radius - selected_inner_radius)
			if _is_curved_roller_conveyor(selected_conveyor) and not _is_curved_roller_conveyor(target_conveyor):
				expected_first_snap_pos += target_transform.basis * Vector3(0, 0, -0.115)
			elif _is_curved_roller_conveyor(target_conveyor) and not _is_curved_roller_conveyor(selected_conveyor):
				expected_first_snap_pos += target_transform.basis * Vector3(0, 0, -0.115)
		else:
			expected_first_snap_pos = target_pos + target_transform.basis * Vector3(-(target_inner_radius - selected_inner_radius), 0, -0.5)
			if _is_curved_roller_conveyor(selected_conveyor) and not _is_curved_roller_conveyor(target_conveyor):
				expected_first_snap_pos += target_transform.basis * Vector3(0.115, 0, 0)
			elif _is_curved_roller_conveyor(target_conveyor) and not _is_curved_roller_conveyor(selected_conveyor):
				expected_first_snap_pos += target_transform.basis * Vector3(0.115, 0, 0)
	else:
		if forward_component > 0:
			expected_first_snap_pos = target_pos + target_transform.basis * Vector3(0.5, 0, target_inner_radius - selected_inner_radius)
			if _is_curved_roller_conveyor(selected_conveyor) and not _is_curved_roller_conveyor(target_conveyor):
				expected_first_snap_pos += target_transform.basis * Vector3(0, 0, -0.115)
			elif _is_curved_roller_conveyor(target_conveyor) and not _is_curved_roller_conveyor(selected_conveyor):
				expected_first_snap_pos += target_transform.basis * Vector3(0, 0, -0.115)
		else:
			expected_first_snap_pos = target_pos + target_transform.basis * Vector3(-(target_inner_radius - selected_inner_radius), 0, -0.5)
			if _is_curved_roller_conveyor(selected_conveyor) and not _is_curved_roller_conveyor(target_conveyor):
				expected_first_snap_pos += target_transform.basis * Vector3(0.115, 0, 0)
			elif _is_curved_roller_conveyor(target_conveyor) and not _is_curved_roller_conveyor(selected_conveyor):
				expected_first_snap_pos += target_transform.basis * Vector3(0.115, 0, 0)
	
	var position_tolerance := 1.0
	var position_distance := selected_pos.distance_to(expected_first_snap_pos)
	if position_distance > position_tolerance:
		return false
	
	var target_rotation := target_conveyor.global_transform.basis.get_euler()
	var selected_rotation := selected_conveyor.global_transform.basis.get_euler()
	
	var y_diff: float = abs(target_rotation.y - selected_rotation.y)
	y_diff = fmod(y_diff, 2 * PI)
	var is_perpendicular: bool = (abs(y_diff - PI/2) < 0.3) or (abs(y_diff - 3*PI/2) < 0.3)
	
	return is_perpendicular


static func _is_curved_to_belt_already_snapped(selected_conveyor: Node3D, target_conveyor: Node3D) -> bool:
	var target_pos := target_conveyor.global_position
	var selected_pos := selected_conveyor.global_position
	
	var selected_inner_radius: float = 0.5
	if "inner_radius" in selected_conveyor:
		selected_inner_radius = selected_conveyor.inner_radius
	
	var target_size := _get_conveyor_size(target_conveyor)
	var x_offset := target_size.x / 2.0 + 0.25
	
	var target_transform := target_conveyor.global_transform
	var target_right := target_transform.basis.z.normalized()
	var target_forward := target_transform.basis.x.normalized()
	var relative_pos := selected_pos - target_pos
	var forward_component := relative_pos.dot(target_forward)
	
	var expected_first_snap_pos: Vector3
	if forward_component > 0:
		expected_first_snap_pos = target_pos + target_transform.basis * Vector3(x_offset, 0, -1.262 - (selected_inner_radius - 0.5))
	else:
		expected_first_snap_pos = target_pos + target_transform.basis * Vector3(-x_offset, 0, -1.262 - (selected_inner_radius - 0.5))
	
	var position_tolerance := 1.0
	var position_distance := selected_pos.distance_to(expected_first_snap_pos)
	if position_distance > position_tolerance:
		return false
	
	var target_rotation := target_conveyor.global_transform.basis.get_euler()
	var selected_rotation := selected_conveyor.global_transform.basis.get_euler()
	
	var y_diff: float = abs(target_rotation.y - selected_rotation.y)
	y_diff = fmod(y_diff, 2 * PI)
	var is_perpendicular: bool = (abs(y_diff - PI/2) < 0.3) or (abs(y_diff) < 0.3)
	
	return is_perpendicular
