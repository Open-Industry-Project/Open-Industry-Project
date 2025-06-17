@tool
extends Node

static func snap_selected_conveyors() -> void:
	var selection = EditorInterface.get_selection()
	var selected_conveyors: Array[Node3D] = []
	var target_conveyor = EditorInterface.get_active_node_3d()
	
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
	
	for conveyor in selected_conveyors:
		_snap_conveyor_to_target(conveyor, target_conveyor)


static func _snap_conveyor_to_target(selected_conveyor: Node3D, target_conveyor: Node3D) -> void:
	var snap_transform = _calculate_snap_transform(selected_conveyor, target_conveyor)
	selected_conveyor.global_transform = snap_transform
	


static func _is_conveyor(node: Node) -> bool:
	if node is BeltConveyorAssembly:
		return true
	if node is RollerConveyorAssembly:
		return true
	if node is CurvedBeltConveyorAssembly:
		return true
	
	var node_script = node.get_script()
	if node_script != null:
		var global_name = node_script.get_global_name()
		if global_name == "BeltSpurConveyor":
			return true
		elif global_name == "SpurConveyorAssembly":
			return true
		elif global_name == "BeltConveyor":
			return true
		elif global_name == "RollerConveyor":
			return true
		elif global_name == "CurvedBeltConveyor":
			return true
	
	var node_class = node.get_class()
	if node_class == "BeltConveyor":
		return true
	elif node_class == "RollerConveyor":
		return true
	elif node_class == "CurvedBeltConveyor":
		return true
	
	return false


static func _calculate_snap_transform(selected_conveyor: Node3D, target_conveyor: Node3D) -> Transform3D:
	var target_transform = target_conveyor.global_transform
	var selected_transform = selected_conveyor.global_transform
	var selected_size = _get_conveyor_size(selected_conveyor)
	var target_size = _get_conveyor_size(target_conveyor)
	
	var target_front_edge = target_transform.origin + target_transform.basis.x * (target_size.x / 2.0)
	var target_back_edge = target_transform.origin - target_transform.basis.x * (target_size.x / 2.0)
	var target_left_edge = target_transform.origin - target_transform.basis.z * (target_size.z / 2.0)
	var target_right_edge = target_transform.origin + target_transform.basis.z * (target_size.z / 2.0)
	
	var selected_position = selected_transform.origin
	var distance_to_front = selected_position.distance_to(target_front_edge)
	var distance_to_back = selected_position.distance_to(target_back_edge)
	var distance_to_left = selected_position.distance_to(target_left_edge)
	var distance_to_right = selected_position.distance_to(target_right_edge)
	
	# Check if conveyors are roughly perpendicular (prefer perpendicular connections)
	var selected_forward = selected_transform.basis.x.normalized()
	var target_forward = target_transform.basis.x.normalized()
	var dot_product = abs(selected_forward.dot(target_forward))
	var is_perpendicular = dot_product < 0.5  # Less than 60 degrees apart (cos(60°) = 0.5)
	
	var min_distance = min(distance_to_front, min(distance_to_back, min(distance_to_left, distance_to_right)))
	var snap_transform = Transform3D()
	
	# If conveyors are perpendicular, strongly prefer side connections
	if is_perpendicular:
		var min_side_distance = min(distance_to_left, distance_to_right)
		var min_end_distance = min(distance_to_front, distance_to_back)
		
		# Only choose end connection if it's extremely close AND much closer than sides
		# This prevents unwanted inline snapping when conveyors are clearly perpendicular
		if min_end_distance < 0.5 and min_end_distance < min_side_distance * 0.2:
			min_distance = min_end_distance
		else:
			min_distance = min_side_distance
	
	# Extract the Z-axis inclination from the selected conveyor
	var selected_inclination = _get_z_inclination(selected_transform)
	
	if min_distance == distance_to_front:
		var new_basis = _apply_inclination_to_basis(target_transform.basis, selected_inclination)
		var connection_position = target_front_edge + target_transform.basis.x * (selected_size.x / 2.0)
		# Adjust position so bottom edge of inclined conveyor aligns with target
		var height_offset = _get_bottom_edge_offset(selected_size, selected_inclination, new_basis)
		snap_transform.basis = new_basis
		snap_transform.origin = connection_position + height_offset
		
	elif min_distance == distance_to_back:
		var flipped_basis = target_transform.basis
		flipped_basis.x = -flipped_basis.x
		flipped_basis.z = -flipped_basis.z
		var new_basis = _apply_inclination_to_basis(flipped_basis, selected_inclination)
		var connection_position = target_back_edge - target_transform.basis.x * (selected_size.x / 2.0)
		# Adjust position so bottom edge of inclined conveyor aligns with target
		var height_offset = _get_bottom_edge_offset(selected_size, selected_inclination, new_basis)
		snap_transform.basis = new_basis
		snap_transform.origin = connection_position + height_offset
		
	elif min_distance == distance_to_left:
		var edge_start = target_transform.origin - target_transform.basis.z * (target_size.z / 2.0) - target_transform.basis.x * (target_size.x / 2.0)
		var edge_end = target_transform.origin - target_transform.basis.z * (target_size.z / 2.0) + target_transform.basis.x * (target_size.x / 2.0)
		var closest_point_on_edge = _get_closest_point_on_line_segment(selected_position, edge_start, edge_end)
		
		var perpendicular_basis = Basis()
		perpendicular_basis.x = target_transform.basis.z
		perpendicular_basis.y = target_transform.basis.y
		perpendicular_basis.z = -target_transform.basis.x
		var new_basis = _apply_inclination_to_basis(perpendicular_basis, selected_inclination)
		var connection_position = closest_point_on_edge - target_transform.basis.z * (selected_size.x / 2.0)
		# Adjust position so bottom edge of inclined conveyor aligns with target
		var height_offset = _get_bottom_edge_offset(selected_size, selected_inclination, new_basis)
		snap_transform.basis = new_basis
		snap_transform.origin = connection_position + height_offset
		
	else:
		var edge_start = target_transform.origin + target_transform.basis.z * (target_size.z / 2.0) - target_transform.basis.x * (target_size.x / 2.0)
		var edge_end = target_transform.origin + target_transform.basis.z * (target_size.z / 2.0) + target_transform.basis.x * (target_size.x / 2.0)
		var closest_point_on_edge = _get_closest_point_on_line_segment(selected_position, edge_start, edge_end)
		
		var perpendicular_basis = Basis()
		perpendicular_basis.x = -target_transform.basis.z
		perpendicular_basis.y = target_transform.basis.y
		perpendicular_basis.z = target_transform.basis.x
		var new_basis = _apply_inclination_to_basis(perpendicular_basis, selected_inclination)
		var connection_position = closest_point_on_edge + target_transform.basis.z * (selected_size.x / 2.0)
		# Adjust position so bottom edge of inclined conveyor aligns with target
		var height_offset = _get_bottom_edge_offset(selected_size, selected_inclination, new_basis)
		snap_transform.basis = new_basis
		snap_transform.origin = connection_position + height_offset
	
	return snap_transform


static func _get_conveyor_size(conveyor: Node3D) -> Vector3:
	if "size" in conveyor:
		return conveyor.size
	return Vector3(4.0, 0.5, 1.524)


static func _get_closest_point_on_line_segment(point: Vector3, line_start: Vector3, line_end: Vector3) -> Vector3:
	var line_vector = line_end - line_start
	var line_length_squared = line_vector.length_squared()
	
	if line_length_squared == 0.0:
		return line_start
	
	var point_to_start = point - line_start
	var projection_factor = point_to_start.dot(line_vector) / line_length_squared
	projection_factor = clampf(projection_factor, 0.0, 1.0)
	
	return line_start + projection_factor * line_vector


static func _get_z_inclination(transform: Transform3D) -> float:
	# Extract the Z-axis inclination (pitch) from the conveyor's forward direction
	var forward = transform.basis.x.normalized()
	return atan2(forward.y, Vector2(forward.x, forward.z).length())


static func _apply_inclination_to_basis(basis: Basis, inclination: float) -> Basis:
	# Apply Z-axis inclination to the basis while preserving horizontal orientation
	var horizontal_forward = Vector3(basis.x.x, 0, basis.x.z).normalized()
	var horizontal_right = Vector3(basis.z.x, 0, basis.z.z).normalized()
	
	# Create inclined forward vector
	var inclined_forward = horizontal_forward * cos(inclination) + Vector3.UP * sin(inclination)
	
	# Create new basis with inclination
	var new_basis = Basis()
	new_basis.x = inclined_forward
	new_basis.z = horizontal_right
	new_basis.y = new_basis.z.cross(new_basis.x).normalized()
	
	return new_basis 


static func _get_bottom_edge_offset(conveyor_size: Vector3, inclination_angle: float, conveyor_basis: Basis) -> Vector3:
	# For level conveyors, no offset needed
	if abs(inclination_angle) < 0.001:  # Essentially zero inclination
		return Vector3.ZERO
	
	# For inclined conveyors, we need to position the center so that the bottom edge of the END FACE
	# (where material flows onto the inclined conveyor) aligns with the connection point
	var half_height = conveyor_size.y / 2.0
	var half_length = conveyor_size.x / 2.0
	
	# The bottom edge of the front face is at the front-bottom corner in local coordinates
	# This point needs to align with the connection point
	var local_front_bottom = Vector3(half_length, -half_height, 0)
	
	# Transform to world coordinates using the conveyor's basis
	var world_front_bottom = conveyor_basis * local_front_bottom
	
	# The center needs to be offset so this front-bottom point aligns with connection point
	return -world_front_bottom
