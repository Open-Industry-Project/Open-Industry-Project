@tool
class_name CurvedConveyorLegsAssembly
extends ConveyorLegsAssembly

func _ready() -> void:
	# Ensure all existing legs have the correct default Y scale
	if Engine.is_editor_hint():
		for child in get_children():
			var conveyor_leg = child as ConveyorLeg
			if conveyor_leg:
				# Set default Y scale to 1.25, preserve X and Z
				conveyor_leg.scale = Vector3(conveyor_leg.scale.x, 1.25, conveyor_leg.scale.z)

## Get the path position of a point projected onto the conveyor legs path.
##
## For curved assemblies, this is an angle of the point around the conveyor legs Y axis in degrees.
func _get_position_on_conveyor_legs_path(position: Vector3) -> float:
	# Convert position to angle in degrees
	return rad_to_deg(atan2(position.z, position.x))


## Move a conveyor leg to a given position on the conveyor legs path.
##
## For curved assemblies, the position is an angle in degrees.
## The conveyor leg is moved and rotated to align with the curved path.
func _move_conveyor_leg_to_path_position(conveyor_leg: Node3D, path_position: float) -> bool:
	var changed := false
	
	# Special handling for front and rear legs
	var leg_index = _get_auto_conveyor_leg_index(conveyor_leg.name)
	
	if leg_index == LegIndex.FRONT:
		# Front leg (tail) - positioned at the start of the curve
		# Original position: X=-1.143, Y=-2.000397, Z=0.04 (world space)
		# Position at Y=0, scale will be adjusted to reach correct height
		var new_position := Vector3(
			-1.143,
			0.0,
			0.04
		)
		
		if conveyor_leg.position != new_position:
			conveyor_leg.position = new_position
			changed = true
		
		# Original rotation from transform matrix
		var new_rotation := Vector3(0.0, -PI/2, 0.0)
		if conveyor_leg.rotation != new_rotation:
			conveyor_leg.rotation = new_rotation
			changed = true
			
	elif leg_index == LegIndex.REAR:
		# Rear leg (head) - positioned at the end of the curve
		# Original position: X=-0.04, Y=-2.000397, Z=1.143 (world space)
		# Position at Y=0, scale will be adjusted to reach correct height
		var new_position := Vector3(
			-0.04,
			0.0,
			1.143
		)
		
		if conveyor_leg.position != new_position:
			conveyor_leg.position = new_position
			changed = true
		
		var new_rotation := Vector3(0.0, 0.0, 0.0)
		if conveyor_leg.rotation != new_rotation:
			conveyor_leg.rotation = new_rotation
			changed = true
	else:
		# Middle legs - use angular positioning
		var angle_rad = deg_to_rad(path_position)
		var radius = conveyor.size.x if conveyor else 1.524
		
		var new_position := Vector3(
			radius * sin(angle_rad),
			0.0,  # Y=0 for all legs
			radius * cos(angle_rad)
		)
		
		if conveyor_leg.position != new_position:
			conveyor_leg.position = new_position
			changed = true
		
		# Rotate to face the center
		var new_rotation := Vector3(0.0, angle_rad, 0.0)
		if conveyor_leg.rotation != new_rotation:
			conveyor_leg.rotation = new_rotation
			changed = true
	
	return changed


func _get_conveyor_leg_coverage() -> Array[float]:
	if not conveyor:
		return [0.0, 0.0]
	
	# For curved conveyors, we need to calculate coverage in terms of angles
	# Get the conveyor angle property if it exists
	var conveyor_angle = 90.0
	if conveyor.has_method("get") and conveyor.get("conveyor_angle") != null:
		conveyor_angle = conveyor.get("conveyor_angle")
	
	# Convert to radians
	var angle_rad = deg_to_rad(conveyor_angle)
	
	# Calculate start and end angles
	# The conveyor starts at 0 degrees and extends to conveyor_angle
	var start_angle = 0.0 + rad_to_deg(deg_to_rad(tail_end_attachment_offset * 30.0))
	var end_angle = conveyor_angle - rad_to_deg(deg_to_rad(head_end_attachment_offset * 30.0))
	
	# Convert to the coverage system
	return [start_angle, end_angle]


func _get_interval_conveyor_leg_position(index: int) -> float:
	assert(index >= 0)
	
	# For curved conveyors, distribute legs along the arc
	var coverage = _get_conveyor_leg_coverage()
	var min_angle = coverage[0]
	var max_angle = coverage[1]
	var angle_span = max_angle - min_angle
	
	# Don't allow negative clearance
	tail_end_leg_clearance = maxf(0.0, tail_end_leg_clearance)
	head_end_leg_clearance = maxf(0.0, head_end_leg_clearance)
	
	# Convert clearances to angular offsets
	var front_margin_deg = (tail_end_leg_clearance * 10.0) if tail_end_leg_enabled else 0.0
	var rear_margin_deg = (head_end_leg_clearance * 10.0) if head_end_leg_enabled else 0.0
	
	# Calculate angular spacing
	var angular_spacing = middle_legs_spacing * 10.0  # Convert linear spacing to degrees
	
	var first_angle = min_angle + front_margin_deg
	return first_angle + index * angular_spacing


## Override to set default scale for curved conveyor legs
func _add_or_get_conveyor_leg_instance(name: StringName) -> Node:
	var conveyor_leg := get_node_or_null(NodePath(name))
	if conveyor_leg != null:
		return conveyor_leg

	conveyor_leg = leg_model_scene.instantiate()
	conveyor_leg.name = name
	add_child(conveyor_leg)
	conveyor_leg.owner = self
	
	# Set default Y scale to 1.25
	conveyor_leg.scale = Vector3(1.0, 1.25, 1.0)
	
	return conveyor_leg


## Override to preserve Y scale when updating width
func _update_conveyor_leg_width(conveyor_leg: Node3D) -> void:
	var target_width := _get_conveyor_leg_target_width()
	# Preserve the current Y scale instead of using scale.y
	conveyor_leg.scale = Vector3(1.0, conveyor_leg.scale.y, target_width / CONVEYOR_LEGS_BASE_WIDTH)


## Override visibility check for curved conveyors
func _update_individual_conveyor_leg_height_and_visibility(conveyor_leg: ConveyorLeg, conveyor_plane: Plane) -> void:
	# Raycast from the minimum-height tip of the conveyor leg to the conveyor plane.
	var intersection = conveyor_plane.intersects_ray(
		conveyor_leg.position + conveyor_leg.basis.y.normalized(),
		conveyor_leg.basis.y.normalized()
	)

	if not intersection:
		conveyor_leg.visible = false
		# Set scale to minimum height.
		conveyor_leg.scale = Vector3(1.0, 1.0, conveyor_leg.scale.z)
		return

	var leg_height = intersection.distance_to(conveyor_leg.position)
	
	# Apply adjusted height
	var adjusted_height = leg_height - 0.1
	
	conveyor_leg.scale = Vector3(1.0, adjusted_height, conveyor_leg.scale.z)
	conveyor_leg.grabs_rotation = rad_to_deg(conveyor_leg.basis.y.signed_angle_to(
		conveyor_plane.normal.slide(conveyor_leg.basis.z.normalized()),
		conveyor_leg.basis.z
	))

	# For curved conveyors, always show front and rear legs if they're enabled
	var leg_index = _get_auto_conveyor_leg_index(conveyor_leg.name)
	if leg_index == LegIndex.FRONT and tail_end_leg_enabled:
		conveyor_leg.visible = true
	elif leg_index == LegIndex.REAR and head_end_leg_enabled:
		conveyor_leg.visible = true
	else:
		# For middle legs, use the coverage check
		var tip_position = _get_position_on_conveyor_legs_path(conveyor_leg.position + conveyor_leg.basis.y)
		conveyor_leg.visible = _conveyor_leg_coverage_min <= tip_position and tip_position <= _conveyor_leg_coverage_max
