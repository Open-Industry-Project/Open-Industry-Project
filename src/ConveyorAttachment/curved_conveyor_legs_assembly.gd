@tool
class_name CurvedConveyorLegsAssembly
extends ConveyorLegsAssembly

const DEFAULT_LEG_SCALE := Vector3(0.5, 1.253, 0.5)
const DEFAULT_ASSEMBLY_SIZE := Vector3(1.524, 0.5, 1.524)


## Returns the average radius of the curved conveyor (midpoint between inner and outer edges).
func _get_avg_radius() -> float:
	var inner_radius := 0.25
	var conveyor_width := 1.0
	if conveyor and "inner_radius" in conveyor:
		inner_radius = conveyor.inner_radius
	if conveyor and "conveyor_width" in conveyor:
		conveyor_width = conveyor.conveyor_width
	return maxf(0.001, inner_radius + conveyor_width / 2.0)


func _get_leg_scale_for_assembly_size() -> Vector3:
	if not conveyor:
		return DEFAULT_LEG_SCALE
	
	var conveyor_width = 1.0
	var belt_height = 0.5
	
	if "conveyor_width" in conveyor:
		conveyor_width = conveyor.conveyor_width
	if "belt_height" in conveyor:
		belt_height = conveyor.belt_height
		
	if conveyor.get_script() and conveyor.get_script().get_global_name() == "CurvedRollerConveyor":
		var base_margin = 1.08
		var size_scale = conveyor.size.x / DEFAULT_ASSEMBLY_SIZE.x
		var additional_margin = 1.0 + (size_scale - 1.0) * -0.01
		conveyor_width *= base_margin * additional_margin
		
	var base_conveyor_width = 1.0
	var width_scale_factor = conveyor_width / base_conveyor_width
	
	var base_belt_height = 0.5
	var height_difference = belt_height - base_belt_height
	var height_scale_factor = 1.0 - (height_difference * 0.75)
	height_scale_factor = clamp(height_scale_factor, 0.7, 1.3)
	
	return Vector3(
		DEFAULT_LEG_SCALE.x,
		DEFAULT_LEG_SCALE.y * height_scale_factor,
		DEFAULT_LEG_SCALE.z * width_scale_factor
	)


func _apply_assembly_scale(conveyor_leg: Node3D) -> void:
	var target := _get_leg_scale_for_assembly_size()
	conveyor_leg.scale = Vector3(target.x, conveyor_leg.scale.y, target.z)


func _ready() -> void:
	super._ready()
	
	if Engine.is_editor_hint():
		_update_all_leg_scales()
	
	if conveyor:
		_set_needs_update(true)


## For curved assemblies, this is the angle from +Z toward -X around the Y axis in degrees,
## matching the conveyor's angle parameterization (0° at the tail end, increasing toward head).
func _get_position_on_conveyor_legs_path(position: Vector3) -> float:
	return rad_to_deg(atan2(-position.x, position.z))


func _on_conveyor_size_changed() -> void:
	_conveyor_legs_path_changed = true
	super._on_conveyor_size_changed()
	_update_all_leg_scales()
	if Engine.is_editor_hint():
		_set_needs_update(true)
		_update_conveyor_legs()
		_update_conveyor_legs_height_and_visibility()


func _update_all_leg_scales() -> void:
	for child in get_children():
		var conveyor_leg = child as ConveyorLeg
		if conveyor_leg:
			_apply_assembly_scale(conveyor_leg)


## Positions legs on a circular arc. The parameterization matches the conveyor angle:
## 0° at the tail end (+Z direction), increasing counterclockwise toward the head end.
func _move_conveyor_leg_to_path_position(conveyor_leg: Node3D, path_position: float) -> bool:
	var changed := false
	var angle_rad := deg_to_rad(path_position)
	var avg_radius := _get_avg_radius()

	var new_position := Vector3(
		-sin(angle_rad) * avg_radius,
		conveyor_leg.position.y,
		cos(angle_rad) * avg_radius
	)
	if conveyor_leg.position != new_position:
		conveyor_leg.position = new_position
		changed = true

	var new_rotation := Vector3(0.0, -angle_rad, 0.0)
	if conveyor_leg.rotation != new_rotation:
		conveyor_leg.rotation = new_rotation
		changed = true

	return changed


## End legs are placed at the physical ends of the curve (0° and conveyor_angle°),
## not inset by the attachment offset like on straight conveyors.
func _get_auto_conveyor_leg_position(index: int) -> float:
	if index == LegIndex.FRONT:
		return 0.0
	if index == LegIndex.REAR:
		var conveyor_angle := 90.0
		if conveyor and conveyor.get("conveyor_angle") != null:
			conveyor_angle = conveyor.get("conveyor_angle")
		return conveyor_angle
	return _get_interval_conveyor_leg_position(index)


## Coverage is an angular range in degrees using arc-length-to-angle conversion.
func _get_conveyor_leg_coverage() -> Array[float]:
	if not conveyor:
		return [0.0, 0.0]
	
	var conveyor_angle := 90.0
	if conveyor.get("conveyor_angle") != null:
		conveyor_angle = conveyor.get("conveyor_angle")
	
	var avg_radius := _get_avg_radius()
	var start_angle := rad_to_deg(tail_end_attachment_offset / avg_radius)
	var end_angle := conveyor_angle - rad_to_deg(head_end_attachment_offset / avg_radius)
	
	return [start_angle, end_angle]


func _get_interval_conveyor_leg_position(index: int) -> float:
	assert(index >= 0)
	
	var avg_radius := _get_avg_radius()
	var angular_spacing := rad_to_deg(middle_legs_spacing / avg_radius)
	var front_margin_deg := rad_to_deg(maxf(0.0, tail_end_leg_clearance) / avg_radius) if tail_end_leg_enabled else 0.0
	
	var first_angle := ceili((_conveyor_leg_coverage_min + front_margin_deg) / angular_spacing) * angular_spacing
	return first_angle + index * angular_spacing


func _get_desired_interval_conveyor_leg_count() -> int:
	var first_position := _get_interval_conveyor_leg_position(0)
	var avg_radius := _get_avg_radius()
	var angular_spacing := rad_to_deg(middle_legs_spacing / avg_radius)
	var rear_margin_deg := rad_to_deg(maxf(0.0, head_end_leg_clearance) / avg_radius) if head_end_leg_enabled else 0.0
	var last_position: float = floorf((_conveyor_leg_coverage_max - rear_margin_deg) / angular_spacing) * angular_spacing
	
	if not middle_legs_enabled or first_position > last_position:
		return 0
	return int((last_position - first_position) / angular_spacing) + 1


func _add_or_get_conveyor_leg_instance(name: StringName) -> Node:
	var conveyor_leg := get_node_or_null(NodePath(name))
	if conveyor_leg != null:
		_apply_assembly_scale(conveyor_leg)
		return conveyor_leg

	conveyor_leg = leg_model_scene.instantiate()
	conveyor_leg.name = name
	add_child(conveyor_leg)
	conveyor_leg.scale = _get_leg_scale_for_assembly_size()
	return conveyor_leg


func _update_conveyor_leg_width(conveyor_leg: Node3D) -> void:
	_apply_assembly_scale(conveyor_leg)


func _update_all_conveyor_legs_width() -> void:
	for child in get_children():
		var conveyor_leg = child as ConveyorLeg
		if conveyor_leg:
			_apply_assembly_scale(conveyor_leg)


func _update_individual_conveyor_leg_height_and_visibility(conveyor_leg: ConveyorLeg, conveyor_plane: Plane) -> void:
	super._update_individual_conveyor_leg_height_and_visibility(conveyor_leg, conveyor_plane)

	# End legs bypass the coverage visibility check to avoid floating-point edge cases
	# where the tip position lands just outside the coverage boundary.
	var leg_index = _get_auto_conveyor_leg_index(conveyor_leg.name)
	if leg_index == LegIndex.FRONT and tail_end_leg_enabled:
		conveyor_leg.visible = true
	elif leg_index == LegIndex.REAR and head_end_leg_enabled:
		conveyor_leg.visible = true


func update_for_curved_conveyor(inner_radius: float, conveyor_width: float, conveyor_size: Vector3, conveyor_angle: float) -> void:
	if not is_inside_tree():
		return
	
	super.update_for_curved_conveyor(inner_radius, conveyor_width, conveyor_size, conveyor_angle)
	_update_all_leg_scales()
