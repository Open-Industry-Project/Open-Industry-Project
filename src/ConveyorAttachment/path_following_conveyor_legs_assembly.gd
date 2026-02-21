@tool
class_name PathFollowingConveyorLegsAssembly
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

func _ready() -> void:
	super._ready()

	middle_legs_initial_leg_position = 0

	# Apply proper scaling to any existing legs
	if Engine.is_editor_hint():
		_update_all_leg_scales()

	# Trigger leg creation/update
	if conveyor:
		_set_needs_update(true)


func _connect_conveyor() -> void:
	super._connect_conveyor()
	if conveyor != null and conveyor.has_signal("path_segments_changed"):
		if not conveyor.is_connected("path_segments_changed", _on_path_segments_changed):
			conveyor.connect("path_segments_changed", _on_path_segments_changed)


func _disconnect_conveyor_signals() -> void:
	if conveyor != null and conveyor.has_signal("path_segments_changed"):
		if conveyor.is_connected("path_segments_changed", _on_path_segments_changed):
			conveyor.disconnect("path_segments_changed", _on_path_segments_changed)
	super._disconnect_conveyor_signals()


func _on_path_segments_changed() -> void:
	_conveyor_legs_path_changed = true
	_set_needs_update(true)
	if Engine.is_editor_hint():
		_update_conveyor_legs()
		_update_conveyor_legs_height_and_visibility()


func _validate_property(property: Dictionary) -> void:
	if property.name == "middle_legs_initial_leg_position":
		property.usage = PROPERTY_USAGE_NONE

func _get_position_on_conveyor_legs_path(target_position: Vector3) -> float:
	var path := _get_path_3d()
	if not path or not path.curve:
		return 0.0

	var curve := path.curve
	var curve_length := curve.get_baked_length()
	if curve_length <= 0.0:
		return 0.0

	if not is_inside_tree() or not path.is_inside_tree():
		return 0.0

	var local_pos = path.to_local(to_global(target_position))
	var target_xz := Vector2(local_pos.x, local_pos.z)

	var best_offset := 0.0
	var best_dist_sq := INF
	var sample_count := int(curve_length / 0.1) + 1
	sample_count = clampi(sample_count, 10, 1000)

	for i in sample_count + 1:
		var d := (float(i) / float(sample_count)) * curve_length
		var sample_pt := curve.sample_baked(d)
		var sample_xz := Vector2(sample_pt.x, sample_pt.z)
		var dist_sq := target_xz.distance_squared_to(sample_xz)
		if dist_sq < best_dist_sq:
			best_dist_sq = dist_sq
			best_offset = d

	return best_offset

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
			var calculated_scale = _get_leg_scale_for_assembly_size()
			var current_scale = conveyor_leg.scale

			conveyor_leg.scale = Vector3(
				calculated_scale.x,
				current_scale.y,
				calculated_scale.z
			)

func _move_conveyor_leg_to_path_position(conveyor_leg: Node3D, path_position: float) -> bool:
	var path := _get_path_3d()
	if not path or not path.curve:
		return false

	var curve := path.curve
	var curve_length := curve.get_baked_length()

	var d = clamp(path_position, 0.0, curve_length)

	var path_pt_local = curve.sample_baked(d)
	var path_pt_global = path.to_global(path_pt_local)

	var path_pt_assembly = to_local(path_pt_global)
	var target_pos = Vector3(path_pt_assembly.x, 0.0, path_pt_assembly.z)

	var changed := false

	if conveyor_leg.position.distance_squared_to(target_pos) > 0.0001:
		conveyor_leg.position = target_pos
		changed = true

	var next_d = min(d + 0.1, curve_length)
	if next_d <= d + 0.001:
		next_d = max(d - 0.1, 0.0)

	var next_pt_local = curve.sample_baked(next_d)
	var next_pt_global = path.to_global(next_pt_local)
	var next_pt_assembly = to_local(next_pt_global)

	var forward = (next_pt_assembly - path_pt_assembly)
	forward.y = 0
	if forward.length_squared() > 0.001:
		forward = forward.normalized()
	else:
		forward = Vector3.BACK

	var leg_basis := Basis()
	leg_basis.z = - forward
	leg_basis.y = Vector3.UP
	leg_basis.x = leg_basis.y.cross(leg_basis.z).normalized()
	leg_basis.y = leg_basis.z.cross(leg_basis.x).normalized()
	leg_basis = leg_basis.rotated(Vector3.UP, PI / 2.0)

	var new_transform := conveyor_leg.transform
	new_transform.basis = leg_basis
	new_transform.origin = conveyor_leg.position

	if not conveyor_leg.transform.basis.is_equal_approx(leg_basis):
		conveyor_leg.transform = new_transform
		changed = true

	if _update_individual_conveyor_leg_height_and_visibility_internal(conveyor_leg, d):
		changed = true

	return changed

func _get_conveyor_leg_coverage() -> Array[float]:
	var path := _get_path_3d()
	if not path or not path.curve:
		return [0.0, 0.0]

	var curve := path.curve
	var curve_length := curve.get_baked_length()

	# Convert attachment offsets into distances along the curve
	var min_pos := tail_end_attachment_offset
	var max_pos := curve_length - head_end_attachment_offset

	min_pos = clamp(min_pos, 0.0, curve_length)
	max_pos = clamp(max_pos, 0.0, curve_length)

	return [min_pos, max_pos]

func _get_interval_conveyor_leg_position(index: int) -> float:
	assert(index >= 0)

	var coverage = _get_conveyor_leg_coverage()
	var min_pos = coverage[0]
	var max_pos = coverage[1]

	tail_end_leg_clearance = maxf(0.0, tail_end_leg_clearance)
	head_end_leg_clearance = maxf(0.0, head_end_leg_clearance)

	var front_margin := tail_end_leg_clearance if tail_end_leg_enabled else 0.0
	var rear_margin := head_end_leg_clearance if head_end_leg_enabled else 0.0

	var usable_min = min_pos + front_margin
	var _usable_max = max_pos - rear_margin

	var spacing := maxf(MIDDLE_LEGS_SPACING_MIN, middle_legs_spacing)

	var first_pos := ceili(usable_min / spacing) * spacing
	var result := first_pos + index * spacing

	return result

func _add_or_get_conveyor_leg_instance(leg_name: StringName) -> Node:
	var conveyor_leg := get_node_or_null(NodePath(leg_name))
	if conveyor_leg != null:
		var calculated_scale = _get_leg_scale_for_assembly_size()
		var current_scale = conveyor_leg.scale

		conveyor_leg.scale = Vector3(
			calculated_scale.x,
			current_scale.y,
			calculated_scale.z
		)
		return conveyor_leg

	conveyor_leg = leg_model_scene.instantiate()
	conveyor_leg.name = leg_name
	add_child(conveyor_leg)
	conveyor_leg.scale = _get_leg_scale_for_assembly_size()
	return conveyor_leg

func _get_desired_interval_conveyor_leg_count() -> int:
	if not middle_legs_enabled:
		return 0

	var coverage = _get_conveyor_leg_coverage()
	var min_pos = coverage[0]
	var max_pos = coverage[1]

	var spacing := maxf(MIDDLE_LEGS_SPACING_MIN, middle_legs_spacing)

	var front_margin := tail_end_leg_clearance if tail_end_leg_enabled else 0.0
	var rear_margin := head_end_leg_clearance if head_end_leg_enabled else 0.0

	var usable_min = min_pos + front_margin
	var usable_max = max_pos - rear_margin

	if usable_min > usable_max:
		return 0

	return int(floor((usable_max - usable_min) / spacing)) + 1

func _update_conveyor_leg_width(conveyor_leg: Node3D) -> void:
	var calculated_scale = _get_leg_scale_for_assembly_size()
	var current_scale = conveyor_leg.scale

	conveyor_leg.scale = Vector3(
		calculated_scale.x,
		current_scale.y,
		calculated_scale.z
	)

func _update_all_conveyor_legs_width() -> void:
	for child in get_children():
		var conveyor_leg = child as ConveyorLeg
		if conveyor_leg:
			_update_conveyor_leg_width(conveyor_leg)

# Override parent to ignore the passed plane and use path height
func _update_conveyor_legs_height_and_visibility() -> void:
	if not conveyor:
		return

	for child in get_children():
		var conveyor_leg = child as ConveyorLeg
		if conveyor_leg:
			var d = _get_position_on_conveyor_legs_path(conveyor_leg.position)
			_update_individual_conveyor_leg_height_and_visibility_internal(conveyor_leg, d)

func _update_individual_conveyor_leg_height_and_visibility(conveyor_leg: ConveyorLeg, _conveyor_plane: Plane) -> void:
	var d = _get_position_on_conveyor_legs_path(conveyor_leg.position)
	_update_individual_conveyor_leg_height_and_visibility_internal(conveyor_leg, d)

func _update_individual_conveyor_leg_height_and_visibility_internal(conveyor_leg: ConveyorLeg, d: float) -> bool:
	var path := _get_path_3d()
	if not path or not path.curve:
		return false

	var curve := path.curve

	if not is_inside_tree() or not path.is_inside_tree():
		return false

	var path_pt_local = curve.sample_baked(d)
	var path_pt_global = path.to_global(path_pt_local)
	var path_pt_assembly = to_local(path_pt_global)

	var path_height = path_pt_assembly.y

	var grabs_offset = leg_model_grabs_offset
	if conveyor and conveyor.get_script() and conveyor.get_script().get_global_name() == "CurvedRollerConveyor":
		grabs_offset = 0.115

	var belt_height_offset := 0.0
	if conveyor and "belt_height" in conveyor:
		belt_height_offset = conveyor.belt_height / 2.0

	var leg_height = path_height - grabs_offset - belt_height_offset

	var coverage_min = _conveyor_leg_coverage_min
	var coverage_max = _conveyor_leg_coverage_max

	var is_in_coverage = d >= coverage_min and d <= coverage_max

	var leg_index = _get_auto_conveyor_leg_index(conveyor_leg.name)
	if leg_index == LegIndex.FRONT:
		is_in_coverage = tail_end_leg_enabled
	elif leg_index == LegIndex.REAR:
		is_in_coverage = head_end_leg_enabled

	var visibility = is_in_coverage and leg_height > 0.8

	var changed = false
	if conveyor_leg.visible != visibility:
		conveyor_leg.visible = visibility
		changed = true

	if visibility:
		var assembly_scale = _get_leg_scale_for_assembly_size()
		var new_scale = Vector3(
			assembly_scale.x,
			leg_height,
			assembly_scale.z
		)
		if not conveyor_leg.scale.is_equal_approx(new_scale):
			conveyor_leg.scale = new_scale
			conveyor_leg.grabs_rotation = 0.0
			changed = true

	return changed

func update_for_curved_conveyor(inner_radius: float, conveyor_width: float, conveyor_size: Vector3, conveyor_angle: float) -> void:
	if not is_inside_tree():
		return

	super.update_for_curved_conveyor(inner_radius, conveyor_width, conveyor_size, conveyor_angle)

	_update_all_leg_scales()

	if Engine.is_editor_hint():
		_set_needs_update(true)
		_update_conveyor_legs()
		_update_conveyor_legs_height_and_visibility()

func _get_configuration_warnings() -> PackedStringArray:
	if not _conveyor_connected or get_parent() is not PathFollowingConveyor:
		return ["This node must be a child of a PathFollowingConveyor."]
	return []

func _get_path_3d() -> Path3D:
	if not is_inside_tree():
		return null

	if not conveyor:
		if "path_to_follow" in get_parent():
			return get_parent().path_to_follow
		return null

	return conveyor.path_to_follow
