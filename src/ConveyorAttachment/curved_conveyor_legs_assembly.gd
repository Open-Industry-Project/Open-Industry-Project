@tool
class_name CurvedConveyorLegsAssembly
extends ConveyorLegsAssembly

const DEFAULT_LEG_SCALE := Vector3(0.5, 1.253, 0.5)
const DEFAULT_ASSEMBLY_SIZE := Vector3(1.524, 0.5, 1.524)

func _get_leg_scale_for_assembly_size() -> Vector3:
	if not conveyor:
		return DEFAULT_LEG_SCALE
	
	var conveyor_width = 1.0
	var belt_height = 0.5
	
	if "conveyor_width" in conveyor:
		conveyor_width = conveyor.conveyor_width
	if "belt_height" in conveyor:
		belt_height = conveyor.belt_height
		
	# For curved roller conveyors, add margin with slower scaling and adjust grabs offset
	if conveyor.get_script() and conveyor.get_script().get_global_name() == "CurvedRollerConveyor":
		var base_margin = 1.08
		# Additional margin that scales with size, but much slower
		var size_scale = conveyor.size.x / DEFAULT_ASSEMBLY_SIZE.x
		var additional_margin = 1.0 + (size_scale - 1.0) * -0.01  # Only 1% increase per unit of scale
		conveyor_width *= base_margin * additional_margin
		
	# Scale leg width to match conveyor width, keep length constant
	# Inner radius changes should only affect positioning, not leg size
	var base_conveyor_width = 1.0  # Reference width for default scale
	var width_scale_factor = conveyor_width / base_conveyor_width
	
	# Calculate height scale with very gradual changes
	var base_belt_height = 0.5
	var height_difference = belt_height - base_belt_height
	var height_scale_factor = 1.0 - (height_difference * 0.75)  # Only 20% change per unit difference
	height_scale_factor = clamp(height_scale_factor, 0.7, 1.3)  # Very conservative range
	
	return Vector3(
		DEFAULT_LEG_SCALE.x,  # Keep X scale (length) constant
		DEFAULT_LEG_SCALE.y * height_scale_factor,  # Legs adjust with belt height (clamped)
		DEFAULT_LEG_SCALE.z * width_scale_factor   # Scale Z (width) to match conveyor width
	)

func _ready() -> void:
	super._ready()
	
	# Apply proper scaling to any existing legs
	if Engine.is_editor_hint():
		_update_all_leg_scales()
	
	# Trigger leg creation/update
	if conveyor:
		_set_needs_update(true)

## For curved assemblies, this is an angle around the Y axis in degrees.
func _get_position_on_conveyor_legs_path(position: Vector3) -> float:
	return rad_to_deg(atan2(position.z, position.x))

func _on_conveyor_size_changed() -> void:
	_conveyor_legs_path_changed = true
	super._on_conveyor_size_changed()
	_update_all_leg_scales()
	if Engine.is_editor_hint():
		_set_needs_update(true)
		# Process updates immediately in editor for responsive leg scaling
		_update_conveyor_legs()
		_update_conveyor_legs_height_and_visibility()

func _update_all_leg_scales() -> void:
	for child in get_children():
		var conveyor_leg = child as ConveyorLeg
		if conveyor_leg:
			var calculated_scale = _get_leg_scale_for_assembly_size()
			var current_scale = conveyor_leg.scale
			
			# Preserve manual height adjustments - only update X and Z dimensions
			conveyor_leg.scale = Vector3(
				calculated_scale.x,  # Update width scaling
				current_scale.y,     # Preserve current height (manual adjustments)
				calculated_scale.z   # Update length scaling
			)

## For curved assemblies, the position is an angle in degrees.
func _move_conveyor_leg_to_path_position(conveyor_leg: Node3D, path_position: float) -> bool:
	var changed := false
	var leg_index = _get_auto_conveyor_leg_index(conveyor_leg.name)
	
	if leg_index == LegIndex.FRONT:
		var inner_radius = 0.25
		var conveyor_width = 1.0
		
		if conveyor and "inner_radius" in conveyor:
			inner_radius = conveyor.inner_radius
		if conveyor and "conveyor_width" in conveyor:
			conveyor_width = conveyor.conveyor_width
		
		# Position FRONT leg exactly like ce2 (straight end) - stays fixed at start
		var radius_inner = inner_radius
		var radius_outer = inner_radius + conveyor_width
		var avg_radius = (radius_inner + radius_outer) / 2.0
		
		var new_position := Vector3(0.0, 0.0, avg_radius)
		
		if conveyor_leg.position != new_position:
			conveyor_leg.position = new_position
			changed = true
		
		var new_rotation := Vector3(0.0, 0.0, 0.0)
		if conveyor_leg.rotation != new_rotation:
			conveyor_leg.rotation = new_rotation
			changed = true
			
	elif leg_index == LegIndex.REAR:
		var conveyor_angle = 90.0
		var inner_radius = 0.25
		var conveyor_width = 1.0
		
		if conveyor and "conveyor_angle" in conveyor:
			conveyor_angle = conveyor.conveyor_angle
		if conveyor and "inner_radius" in conveyor:
			inner_radius = conveyor.inner_radius
		if conveyor and "conveyor_width" in conveyor:
			conveyor_width = conveyor.conveyor_width
		
		# Position REAR leg exactly like ce1 (angled end) - moves with conveyor_angle
		var radians = deg_to_rad(conveyor_angle)
		var radius_inner = inner_radius
		var radius_outer = inner_radius + conveyor_width
		var avg_radius = (radius_inner + radius_outer) / 2.0
		
		var new_position := Vector3(-sin(radians) * avg_radius, 0.0, cos(radians) * avg_radius)
		
		if conveyor_leg.position != new_position:
			conveyor_leg.position = new_position
			changed = true
		
		var new_rotation := Vector3(0.0, -radians, 0.0)
		if conveyor_leg.rotation != new_rotation:
			conveyor_leg.rotation = new_rotation
			changed = true
	else:
		var angle_rad = deg_to_rad(path_position)
		var inner_radius = 0.25
		var conveyor_width = 1.0
		
		if conveyor and "inner_radius" in conveyor:
			inner_radius = conveyor.inner_radius
		if conveyor and "conveyor_width" in conveyor:
			conveyor_width = conveyor.conveyor_width
		
		# Position middle legs using same calculation as conveyor ends
		var radius_inner = inner_radius
		var radius_outer = inner_radius + conveyor_width
		var avg_radius = (radius_inner + radius_outer) / 2.0
		
		var new_position := Vector3(
			avg_radius * sin(angle_rad),
			0.0,
			avg_radius * cos(angle_rad)
		)
		
		if conveyor_leg.position != new_position:
			conveyor_leg.position = new_position
			changed = true
		
		var new_rotation := Vector3(0.0, angle_rad, 0.0)
		if conveyor_leg.rotation != new_rotation:
			conveyor_leg.rotation = new_rotation
			changed = true
	
	return changed

func _get_conveyor_leg_coverage() -> Array[float]:
	if not conveyor:
		return [0.0, 0.0]
	
	var conveyor_angle = 90.0
	if conveyor.has_method("get") and conveyor.get("conveyor_angle") != null:
		conveyor_angle = conveyor.get("conveyor_angle")
	
	var start_angle = 0.0 + rad_to_deg(deg_to_rad(tail_end_attachment_offset * 30.0))
	var end_angle = conveyor_angle - rad_to_deg(deg_to_rad(head_end_attachment_offset * 30.0))
	
	return [start_angle, end_angle]

func _get_interval_conveyor_leg_position(index: int) -> float:
	assert(index >= 0)
	
	var coverage = _get_conveyor_leg_coverage()
	var min_angle = coverage[0]
	var max_angle = coverage[1]
	
	tail_end_leg_clearance = maxf(0.0, tail_end_leg_clearance)
	head_end_leg_clearance = maxf(0.0, head_end_leg_clearance)
	
	var front_margin_deg = (tail_end_leg_clearance * 10.0) if tail_end_leg_enabled else 0.0
	var rear_margin_deg = (head_end_leg_clearance * 10.0) if head_end_leg_enabled else 0.0
	
	var angular_spacing = middle_legs_spacing * 10.0
	
	var first_angle = min_angle + front_margin_deg
	return first_angle + index * angular_spacing

func _add_or_get_conveyor_leg_instance(name: StringName) -> Node:
	var conveyor_leg := get_node_or_null(NodePath(name))
	if conveyor_leg != null:
		# Leg already exists, preserve any manual height adjustments
		var calculated_scale = _get_leg_scale_for_assembly_size()
		var current_scale = conveyor_leg.scale
		
		conveyor_leg.scale = Vector3(
			calculated_scale.x,  # Update width scaling
			current_scale.y,     # Preserve current height (manual adjustments)
			calculated_scale.z   # Update length scaling
		)
		return conveyor_leg

	# New leg, apply full calculated scale
	conveyor_leg = leg_model_scene.instantiate()
	conveyor_leg.name = name
	add_child(conveyor_leg)
	conveyor_leg.scale = _get_leg_scale_for_assembly_size()
	return conveyor_leg

func _update_conveyor_leg_width(conveyor_leg: Node3D) -> void:
	var calculated_scale = _get_leg_scale_for_assembly_size()
	var current_scale = conveyor_leg.scale
	
	# Preserve manual height adjustments - only update X and Z dimensions
	conveyor_leg.scale = Vector3(
		calculated_scale.x,  # Update width scaling
		current_scale.y,     # Preserve current height (manual adjustments)
		calculated_scale.z   # Update length scaling
	)

func _update_all_conveyor_legs_width() -> void:
	for child in get_children():
		var conveyor_leg = child as ConveyorLeg
		if conveyor_leg:
			var calculated_scale = _get_leg_scale_for_assembly_size()
			var current_scale = conveyor_leg.scale
			
			# Preserve manual height adjustments - only update X and Z dimensions
			conveyor_leg.scale = Vector3(
				calculated_scale.x,  # Update width scaling
				current_scale.y,     # Preserve current height (manual adjustments)
				calculated_scale.z   # Update length scaling
			)

func _update_individual_conveyor_leg_height_and_visibility(conveyor_leg: ConveyorLeg, conveyor_plane: Plane) -> void:
	# Get the grabs offset based on conveyor type
	var grabs_offset = leg_model_grabs_offset
	if conveyor and conveyor.get_script() and conveyor.get_script().get_global_name() == "CurvedRollerConveyor":
		grabs_offset = 0.115

	var intersection = conveyor_plane.intersects_ray(
		conveyor_leg.position + conveyor_leg.basis.y.normalized(),
		conveyor_leg.basis.y.normalized()
	)

	if not intersection:
		conveyor_leg.visible = false
		var assembly_scale = _get_leg_scale_for_assembly_size()
		conveyor_leg.scale = Vector3(assembly_scale.x, 1.0, assembly_scale.z)
		return

	var leg_height = intersection.distance_to(conveyor_leg.position)
	var adjusted_height = leg_height - grabs_offset  # Use the type-specific grabs offset
	var assembly_scale = _get_leg_scale_for_assembly_size()
	
	conveyor_leg.scale = Vector3(
		assembly_scale.x, 
		adjusted_height, 
		assembly_scale.z
	)
	conveyor_leg.grabs_rotation = rad_to_deg(conveyor_leg.basis.y.signed_angle_to(
		conveyor_plane.normal.slide(conveyor_leg.basis.z.normalized()),
		conveyor_leg.basis.z
	))

	var leg_index = _get_auto_conveyor_leg_index(conveyor_leg.name)
	if leg_index == LegIndex.FRONT and tail_end_leg_enabled:
		conveyor_leg.visible = true
	elif leg_index == LegIndex.REAR and head_end_leg_enabled:
		conveyor_leg.visible = true
	else:
		var tip_position = _get_position_on_conveyor_legs_path(conveyor_leg.position + conveyor_leg.basis.y)
		conveyor_leg.visible = _conveyor_leg_coverage_min <= tip_position and tip_position <= _conveyor_leg_coverage_max

## Override to handle curved conveyor parameter changes for leg scaling
func update_for_curved_conveyor(inner_radius: float, conveyor_width: float, conveyor_size: Vector3, conveyor_angle: float) -> void:
	if not is_inside_tree():
		return
	
	# Call parent method for standard updates
	super.update_for_curved_conveyor(inner_radius, conveyor_width, conveyor_size, conveyor_angle)
	
	# Force immediate leg scale updates for curved conveyor parameters
	_update_all_leg_scales()
	
	# Force immediate leg positioning updates as well
	if Engine.is_editor_hint():
		_set_needs_update(true)
		# Process updates immediately in editor rather than waiting for next frame
		_update_conveyor_legs()
		_update_conveyor_legs_height_and_visibility()
