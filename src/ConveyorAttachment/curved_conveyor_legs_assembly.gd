@tool
class_name CurvedConveyorLegsAssembly
extends ConveyorLegsAssembly

const DEFAULT_LEG_SCALE := Vector3(1.0, 1.253, 0.82)
const DEFAULT_ASSEMBLY_SIZE := Vector3(1.524, 0.5, 1.524)

func _get_leg_scale_for_assembly_size() -> Vector3:
	if not conveyor:
		return DEFAULT_LEG_SCALE
	
	var inner_radius = 0.25
	var conveyor_width = 1.0
	var belt_height = 0.5
	
	if "inner_radius" in conveyor:
		inner_radius = conveyor.inner_radius
	if "conveyor_width" in conveyor:
		conveyor_width = conveyor.conveyor_width
	if "belt_height" in conveyor:
		belt_height = conveyor.belt_height
		
	var outer_radius = inner_radius + conveyor_width
	var default_outer_radius = (0.25 + 1.0) * DEFAULT_ASSEMBLY_SIZE.x
	
	var scale_factor = outer_radius / default_outer_radius
	
	return Vector3(
		DEFAULT_LEG_SCALE.x * scale_factor,
		DEFAULT_LEG_SCALE.y * (belt_height / 0.5),
		DEFAULT_LEG_SCALE.z * scale_factor
	)

func _ready() -> void:
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

func _update_all_leg_scales() -> void:
	for child in get_children():
		var conveyor_leg = child as ConveyorLeg
		if conveyor_leg:
			conveyor_leg.scale = _get_leg_scale_for_assembly_size()

## For curved assemblies, the position is an angle in degrees.
func _move_conveyor_leg_to_path_position(conveyor_leg: Node3D, path_position: float) -> bool:
	var changed := false
	var leg_index = _get_auto_conveyor_leg_index(conveyor_leg.name)
	
	if leg_index == LegIndex.FRONT:
		var conveyor_angle = 90.0
		var inner_radius = 0.25
		var conveyor_width = 1.0
		
		if conveyor and "conveyor_angle" in conveyor:
			conveyor_angle = conveyor.conveyor_angle
		if conveyor and "inner_radius" in conveyor:
			inner_radius = conveyor.inner_radius
		if conveyor and "conveyor_width" in conveyor:
			conveyor_width = conveyor.conveyor_width
		
		var size_x = DEFAULT_ASSEMBLY_SIZE.x
		var relative_inner = inner_radius / size_x
		var relative_width = conveyor_width / size_x
		var relative_avg_radius = relative_inner + (relative_width / 2.0)
		
		var radians = deg_to_rad(conveyor_angle)
		var leg_x = -sin(radians) * 0.75 * relative_avg_radius * size_x
		var leg_z = cos(radians) * 0.73 * relative_avg_radius * size_x
		
		var new_position := Vector3(leg_x, 0.0, 0.04 + leg_z)
		
		if conveyor_leg.position != new_position:
			conveyor_leg.position = new_position
			changed = true
		
		var new_rotation := Vector3(0.0, -radians, 0.0)
		if conveyor_leg.rotation != new_rotation:
			conveyor_leg.rotation = new_rotation
			changed = true
			
	elif leg_index == LegIndex.REAR:
		var inner_radius = 0.25
		var conveyor_width = 1.0
		
		if conveyor and "inner_radius" in conveyor:
			inner_radius = conveyor.inner_radius
		if conveyor and "conveyor_width" in conveyor:
			conveyor_width = conveyor.conveyor_width
		
		var size_x = DEFAULT_ASSEMBLY_SIZE.x
		var relative_inner = inner_radius / size_x
		var relative_width = conveyor_width / size_x
		var relative_avg_radius = relative_inner + (relative_width / 2.0)
		
		var new_position := Vector3(-0.04, 0.0, 0.75 * relative_avg_radius * size_x)
		
		if conveyor_leg.position != new_position:
			conveyor_leg.position = new_position
			changed = true
		
		var new_rotation := Vector3(0.0, 0.0, 0.0)
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
		
		var size_x = DEFAULT_ASSEMBLY_SIZE.x
		var relative_inner = inner_radius / size_x
		var relative_width = conveyor_width / size_x
		var relative_avg_radius = relative_inner + (relative_width / 2.0)
		var radius = relative_avg_radius * size_x
		
		var new_position := Vector3(
			radius * sin(angle_rad),
			0.0,
			radius * cos(angle_rad)
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
		return conveyor_leg

	conveyor_leg = leg_model_scene.instantiate()
	conveyor_leg.name = name
	add_child(conveyor_leg)
	conveyor_leg.owner = self
	
	conveyor_leg.scale = _get_leg_scale_for_assembly_size()
	
	return conveyor_leg

func _update_conveyor_leg_width(conveyor_leg: Node3D) -> void:
	conveyor_leg.scale = _get_leg_scale_for_assembly_size()

func _update_all_conveyor_legs_width() -> void:
	for child in get_children():
		var conveyor_leg = child as ConveyorLeg
		if conveyor_leg:
			conveyor_leg.scale = _get_leg_scale_for_assembly_size()

func _update_individual_conveyor_leg_height_and_visibility(conveyor_leg: ConveyorLeg, conveyor_plane: Plane) -> void:
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
	var adjusted_height = leg_height - 0.1
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
	
	# Force leg scale updates for curved conveyor parameters
	_update_all_leg_scales()
