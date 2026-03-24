@tool
class_name RollerSpurConveyorAssembly
extends ResizableNode3D

const CONVEYOR_CLASS_NAME = "RollerConveyor"
const CONVEYOR_SCRIPT_PATH = "res://src/RollerConveyor/roller_conveyor.gd"
const CONVEYOR_SCRIPT_FILENAME = "roller_conveyor.gd"
const SIDE_GUARDS_SCRIPT_PATH: String = "res://src/ConveyorAttachment/side_guards_assembly.gd"
const SIDE_GUARDS_SCRIPT_FILENAME: String = "side_guards_assembly.gd"
const CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH: String = "res://src/ConveyorAttachment/conveyor_legs_assembly.gd"
const CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME: String = "conveyor_legs_assembly.gd"
const PREVIEW_SCENE_PATH: String = "res://parts/assemblies/RollerSpurConveyorAssembly.tscn"

static var _conveyor_script_cached: Script

var _conveyor_script: Script
var _has_instantiated: bool = false
var _conveyor_x_offset: float = 0.0

@export_custom(PROPERTY_HINT_NONE, "suffix:m") var length: float:
	set(value): size.x = value
	get: return size.x

@export_custom(PROPERTY_HINT_NONE, "suffix:m") var width: float:
	set(value): size.z = value
	get: return size.z

@export_custom(PROPERTY_HINT_NONE, "suffix:m") var depth: float:
	set(value): size.y = value
	get: return size.y

## Angular offset of the downstream end (positive angles splay outward).
@export_range(-70, 70, 1, "radians_as_degrees") var angle_downstream: float = 0.0:
	set(value):
		if angle_downstream != value:
			angle_downstream = value
			set_process(true)

## Angular offset of the upstream end (positive angles splay outward).
@export_range(-70, 70, 1, "radians_as_degrees") var angle_upstream: float = 0.0:
	set(value):
		if angle_upstream != value:
			angle_upstream = value
			set_process(true)

var _cached_conveyor_property_values: Dictionary[StringName, Variant] = {}
var _cached_side_guards_property_values: Dictionary[StringName, Variant] = {}
var _cached_legs_property_values: Dictionary[StringName, Variant] = {}

#region SideGuardsAssembly properties
@export_category(SIDE_GUARDS_SCRIPT_FILENAME)
@export_group("Right Side Guards", "right_side_guards_")
@export var right_side_guards_enabled: bool = true:
	get:
		return _side_guards_property_cached_get(&"right_side_guards_enabled", right_side_guards_enabled)
	set(value):
		right_side_guards_enabled = _side_guards_property_cached_set(&"right_side_guards_enabled", value, right_side_guards_enabled)
@export var right_side_guards_openings: Array[SideGuardOpening] = []:
	get:
		return _side_guards_property_cached_get(&"right_side_guards_openings", right_side_guards_openings)
	set(value):
		right_side_guards_openings = _side_guards_property_cached_set(&"right_side_guards_openings", value, right_side_guards_openings)
@export_group("Left Side Guards", "left_side_guards_")
@export var left_side_guards_enabled: bool = true:
	get:
		return _side_guards_property_cached_get(&"left_side_guards_enabled", left_side_guards_enabled)
	set(value):
		left_side_guards_enabled = _side_guards_property_cached_set(&"left_side_guards_enabled", value, left_side_guards_enabled)
@export var left_side_guards_openings: Array[SideGuardOpening] = []:
	get:
		return _side_guards_property_cached_get(&"left_side_guards_openings", left_side_guards_openings)
	set(value):
		left_side_guards_openings = _side_guards_property_cached_set(&"left_side_guards_openings", value, left_side_guards_openings)
#endregion

#region ConveyorLegsAssembly properties
@export_category(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME)
@export_group("Conveyor Legs", "")
@export_custom(PROPERTY_HINT_NONE, "suffix:m")
var floor_plane: Plane = preload(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH).DEFAULT_FLOOR_PLANE:
	get:
		return _legs_property_cached_get(&"floor_plane", floor_plane)
	set(value):
		floor_plane = _legs_property_cached_set(&"floor_plane", value, floor_plane)
var global_floor_plane: Plane = preload(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH).DEFAULT_FLOOR_PLANE:
	get:
		return _legs_property_cached_get(&"global_floor_plane", global_floor_plane)
	set(value):
		global_floor_plane = _legs_property_cached_set(&"global_floor_plane", value, global_floor_plane)
@export_storage
var local_floor_plane: Plane = preload(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH).DEFAULT_FLOOR_PLANE:
	get:
		return _legs_property_cached_get(&"local_floor_plane", local_floor_plane)
	set(value):
		local_floor_plane = _legs_property_cached_set(&"local_floor_plane", value, local_floor_plane)

@export_subgroup("Middle Legs", "middle_legs")
@export
var middle_legs_enabled: bool = false:
	get:
		return _legs_property_cached_get(&"middle_legs_enabled", middle_legs_enabled)
	set(value):
		middle_legs_enabled = _legs_property_cached_set(&"middle_legs_enabled", value, middle_legs_enabled)
@export_range(-5, 5, 0.01, "or_less", "or_greater", "suffix:m")
var middle_legs_initial_leg_position: float:
	get:
		return _legs_property_cached_get(&"middle_legs_initial_leg_position", middle_legs_initial_leg_position)
	set(value):
		middle_legs_initial_leg_position = _legs_property_cached_set(&"middle_legs_initial_leg_position", value, middle_legs_initial_leg_position)
@export_range(preload(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH).MIDDLE_LEGS_SPACING_MIN, 5, 0.01, "or_greater", "suffix:m")
var middle_legs_spacing: float = 2:
	get:
		return _legs_property_cached_get(&"middle_legs_spacing", middle_legs_spacing)
	set(value):
		middle_legs_spacing = _legs_property_cached_set(&"middle_legs_spacing", value, middle_legs_spacing)

@export_subgroup("Head End", "head_end")
@export_range(0, 1, 0.01, "or_greater", "suffix:m")
var head_end_attachment_offset: float = 0.45:
	get:
		return _legs_property_cached_get(&"head_end_attachment_offset", head_end_attachment_offset)
	set(value):
		head_end_attachment_offset = _legs_property_cached_set(&"head_end_attachment_offset", value, head_end_attachment_offset)
@export
var head_end_leg_enabled: bool = false:
	get:
		return _legs_property_cached_get(&"head_end_leg_enabled", head_end_leg_enabled)
	set(value):
		head_end_leg_enabled = _legs_property_cached_set(&"head_end_leg_enabled", value, head_end_leg_enabled)
@export_range(0.5, 5, 0.01, "or_greater", "suffix:m")
var head_end_leg_clearance: float = 0.5:
	get:
		return _legs_property_cached_get(&"head_end_leg_clearance", head_end_leg_clearance)
	set(value):
		head_end_leg_clearance = _legs_property_cached_set(&"head_end_leg_clearance", value, head_end_leg_clearance)

@export_subgroup("Tail End", "tail_end")
@export_range(0, 1, 0.01, "or_greater", "suffix:m")
var tail_end_attachment_offset: float = 0.45:
	get:
		return _legs_property_cached_get(&"tail_end_attachment_offset", tail_end_attachment_offset)
	set(value):
		tail_end_attachment_offset = _legs_property_cached_set(&"tail_end_attachment_offset", value, tail_end_attachment_offset)
@export
var tail_end_leg_enabled: bool = true:
	get:
		return _legs_property_cached_get(&"tail_end_leg_enabled", tail_end_leg_enabled)
	set(value):
		tail_end_leg_enabled = _legs_property_cached_set(&"tail_end_leg_enabled", value, tail_end_leg_enabled)
@export_range(0.5, 5, 0.01, "or_greater", "suffix:m")
var tail_end_leg_clearance: float = 0.5:
	get:
		return _legs_property_cached_get(&"tail_end_leg_clearance", tail_end_leg_clearance)
	set(value):
		tail_end_leg_clearance = _legs_property_cached_set(&"tail_end_leg_clearance", value, tail_end_leg_clearance)

@export_subgroup("Model", "leg_model")
@export
var leg_model_scene: PackedScene = preload("res://parts/ConveyorLegRC.tscn"):
	get:
		return _legs_property_cached_get(&"leg_model_scene", leg_model_scene)
	set(value):
		leg_model_scene = _legs_property_cached_set(&"leg_model_scene", value, leg_model_scene)
@export
var leg_model_grabs_offset: float = 0.392:
	get:
		return _legs_property_cached_get(&"leg_model_grabs_offset", leg_model_grabs_offset)
	set(value):
		leg_model_grabs_offset = _legs_property_cached_set(&"leg_model_grabs_offset", value, leg_model_grabs_offset)
#endregion


func _init() -> void:
	super._init()
	size_default = Vector3(2, 0.24, 1.524)

	if _conveyor_script_cached == null:
		var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
		var class_details: Dictionary = class_list[class_list.find_custom(func (item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
		_conveyor_script_cached = load(class_details["path"]) as Script
	_conveyor_script = _conveyor_script_cached


func _ready() -> void:
	if not has_node("%Conveyor"):
		return

	if not %Conveyor.property_list_changed.is_connected(notify_property_list_changed):
		%Conveyor.property_list_changed.connect(notify_property_list_changed)

	for property: StringName in _cached_conveyor_property_values:
		var value = _cached_conveyor_property_values[property]
		%Conveyor.set(property, value)
	_cached_conveyor_property_values.clear()

	if has_node("%SideGuardsAssembly"):
		if not %SideGuardsAssembly.property_list_changed.is_connected(notify_property_list_changed):
			%SideGuardsAssembly.property_list_changed.connect(notify_property_list_changed)

		for property: StringName in _cached_side_guards_property_values:
			var value: Variant = _cached_side_guards_property_values[property]
			%SideGuardsAssembly.set(property, value)
		_cached_side_guards_property_values.clear()

	if has_node("%ConveyorLegsAssembly"):
		if not %ConveyorLegsAssembly.property_list_changed.is_connected(notify_property_list_changed):
			%ConveyorLegsAssembly.property_list_changed.connect(notify_property_list_changed)

		for property: StringName in _cached_legs_property_values:
			var value: Variant = _cached_legs_property_values[property]
			%ConveyorLegsAssembly.set(property, value)
		_cached_legs_property_values.clear()

	_has_instantiated = true
	call_deferred("_ensure_side_guards_updated")
	_update_spur()

	OIPComms.enable_comms_changed.connect(notify_property_list_changed)


func _exit_tree() -> void:
	if OIPComms.enable_comms_changed.is_connected(notify_property_list_changed):
		OIPComms.enable_comms_changed.disconnect(notify_property_list_changed)


func _process(_delta: float) -> void:
	set_process(false)
	_update_spur()
	if _has_instantiated:
		call_deferred("_ensure_side_guards_updated")


func _on_size_changed() -> void:
	set_process(true)
	super._on_size_changed()
	if _has_instantiated:
		call_deferred("_ensure_side_guards_updated")


func _ensure_side_guards_updated() -> void:
	if has_node("%SideGuardsAssembly"):
		%SideGuardsAssembly._on_conveyor_size_changed()


func _get_constrained_size(new_size: Vector3) -> Vector3:
	return new_size


func _collision_repositioned_save() -> Variant:
	return floor_plane


func _collision_repositioned(collision_point: Vector3, collision_normal: Vector3) -> void:
	if _has_instantiated and has_node("%ConveyorLegsAssembly"):
		%ConveyorLegsAssembly.collision_repositioned(collision_point, collision_normal)


func _collision_repositioned_undo(saved_data: Variant) -> void:
	if saved_data is Plane and _has_instantiated and has_node("%ConveyorLegsAssembly"):
		%ConveyorLegsAssembly.restore_floor_plane(saved_data)


func _validate_property(property: Dictionary) -> void:
	var property_name: String = property["name"]
	if property_name in ["length", "width", "depth"]:
		property["usage"] = PROPERTY_USAGE_EDITOR
	if property_name == "size":
		property["usage"] = PROPERTY_USAGE_STORAGE

	if property[&"name"] == SIDE_GUARDS_SCRIPT_FILENAME \
			and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		assert(SIDE_GUARDS_SCRIPT_PATH.get_file() == SIDE_GUARDS_SCRIPT_FILENAME, "SIDE_GUARDS_SCRIPT_PATH doesn't match SIDE_GUARDS_SCRIPT_FILENAME")
		property[&"hint_string"] = SIDE_GUARDS_SCRIPT_PATH
	elif property[&"name"] == CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME \
			and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		assert(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH.get_file() == CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME, "CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH doesn't match CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME")
		property[&"hint_string"] = CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH
	elif property[&"name"] == "Communications" and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		property[&"usage"] = PROPERTY_USAGE_CATEGORY if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property[&"name"] == "enable_comms":
		property[&"usage"] = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE
	elif property[&"name"] == "speed_tag_group_name":
		property[&"usage"] = PROPERTY_USAGE_STORAGE
	elif property[&"name"] == "speed_tag_groups":
		property[&"usage"] = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property[&"name"] == "speed_tag_name":
		property[&"usage"] = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE
	elif property[&"name"] == "running_tag_group_name":
		property[&"usage"] = PROPERTY_USAGE_STORAGE
	elif property[&"name"] == "running_tag_groups":
		property[&"usage"] = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property[&"name"] == "running_tag_name":
		property[&"usage"] = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE


func _property_can_revert(property: StringName) -> bool:
	if property in ["length", "width", "depth"]:
		return true
	return property in _get_conveyor_forwarded_property_names()


func _property_get_revert(property: StringName) -> Variant:
	match property:
		&"length":
			return size_default.x
		&"width":
			return size_default.z
		&"depth":
			return size_default.y
	if property not in _get_conveyor_forwarded_property_names():
		return null
	if _has_instantiated and has_node("%Conveyor"):
		if %Conveyor.property_can_revert(property):
			return %Conveyor.property_get_revert(property)
		elif %Conveyor.scene_file_path:
			var scene := load(%Conveyor.scene_file_path) as PackedScene
			var scene_state := scene.get_state()
			for prop_idx in range(scene_state.get_node_property_count(0)):
				if scene_state.get_node_property_name(0, prop_idx) == property:
					return scene_state.get_node_property_value(0, prop_idx)
			return %Conveyor.get_script().get_property_default_value(property)
	return _conveyor_script.get_property_default_value(property)


#region Spur conveyor management

func _update_spur() -> void:
	if not has_node("%Conveyor"):
		return

	var half_w := size.z / 2.0
	var ds_ext := absf(tan(angle_downstream)) * half_w
	var us_ext := absf(tan(angle_upstream)) * half_w
	var max_length := size.x + ds_ext + us_ext

	var ds_max := size.x / 2.0 + ds_ext
	var us_min := -size.x / 2.0 - us_ext
	_conveyor_x_offset = (ds_max + us_min) / 2.0

	if "size" in %Conveyor:
		%Conveyor.size = Vector3(max_length, size.y, size.z)
		%Conveyor.position = Vector3(_conveyor_x_offset, 0, 0)

	call_deferred("_apply_spur_clipping")


func _apply_spur_clipping() -> void:
	if not has_node("%Conveyor"):
		return

	var rollers_node := %Conveyor.get_node_or_null("Rollers")
	if rollers_node:
		for child in rollers_node.get_children():
			if child is Roller:
				var x_spur: float = float(%Conveyor.position.x) + rollers_node.position.x + child.position.x
				_clip_roller_to_spur(child, x_spur)

	var ends_node := %Conveyor.get_node_or_null("Ends")
	if ends_node:
		for end_child in ends_node.get_children():
			if end_child is RollerConveyorEnd:
				var end_roller: Roller = end_child.get_node_or_null("Roller")
				if end_roller:
					var x_spur: float = float(%Conveyor.position.x) + ends_node.position.x + end_child.position.x
					var clip := _get_spur_clip(x_spur)
					_apply_roller_clip(end_roller, clip)
					_adjust_end_frame(end_child, clip)

	_adjust_side_rails()


func _get_spur_clip(x_spur: float) -> Vector3:
	var half_w := size.z / 2.0
	var z_min := -half_w
	var z_max := half_w

	if absf(angle_downstream) > 0.001:
		var z_ds := (x_spur - size.x / 2.0) / tan(angle_downstream)
		if angle_downstream > 0:
			z_min = maxf(z_min, z_ds)
		else:
			z_max = minf(z_max, z_ds)

	if absf(angle_upstream) > 0.001:
		var z_us := (x_spur + size.x / 2.0) / tan(angle_upstream)
		if angle_upstream > 0:
			z_max = minf(z_max, z_us)
		else:
			z_min = maxf(z_min, z_us)

	return Vector3(z_min, z_max, maxf(0.0, z_max - z_min))


func _clip_roller_to_spur(roller: Roller, x_spur: float) -> void:
	_apply_roller_clip(roller, _get_spur_clip(x_spur))


func _apply_roller_clip(roller: Roller, clip: Vector3) -> void:
	if clip.z < 0.01:
		roller.visible = false
		return
	roller.visible = true
	roller.set_length_and_offset(clip.z, (clip.x + clip.y) / 2.0)


func _adjust_end_frame(end: RollerConveyorEnd, clip: Vector3) -> void:
	var frame_node := end.get_node_or_null("ConveyorRollerEnd")
	if not frame_node:
		return

	if clip.z < 0.01:
		frame_node.visible = false
		return

	frame_node.visible = true
	var half_w := size.z / 2.0
	var meshes: Array[MeshInstance3D] = []
	for child in frame_node.get_children():
		if child is MeshInstance3D:
			meshes.append(child)

	if meshes.size() >= 2:
		var at_left_edge := absf(clip.x + half_w) < 0.01
		var at_right_edge := absf(clip.y - half_w) < 0.01
		meshes[0].visible = at_left_edge
		meshes[1].visible = at_right_edge
		meshes[0].position = Vector3(meshes[0].position.x, meshes[0].position.y, clip.x)
		meshes[1].position = Vector3(meshes[1].position.x, meshes[1].position.y, clip.y)


func _adjust_side_rails() -> void:
	if not has_node("%Conveyor"):
		return

	var conv_roller := %Conveyor.get_node_or_null("ConvRoller")
	if not conv_roller:
		return

	var parent_scale_x: float = conv_roller.scale.x
	if parent_scale_x < 0.001:
		return

	var half_w := size.z / 2.0
	var tan_ds := tan(angle_downstream)
	var tan_us := tan(angle_upstream)

	var left_side := conv_roller.get_node_or_null("ConvRollerL")
	if left_side:
		var front_x: float = size.x / 2.0 + tan_ds * (-half_w)
		var back_x: float = -size.x / 2.0 + tan_us * (-half_w)
		var rail_length: float = front_x - back_x
		var center_conveyor: float = (front_x + back_x) / 2.0 - _conveyor_x_offset
		left_side.position.x = center_conveyor / parent_scale_x
		left_side.scale.x = rail_length / parent_scale_x

	var right_side := conv_roller.get_node_or_null("ConvRollerR")
	if right_side:
		var front_x: float = size.x / 2.0 + tan_ds * half_w
		var back_x: float = -size.x / 2.0 + tan_us * half_w
		var rail_length: float = front_x - back_x
		var center_conveyor: float = (front_x + back_x) / 2.0 - _conveyor_x_offset
		right_side.position.x = center_conveyor / parent_scale_x
		right_side.scale.x = rail_length / parent_scale_x

#endregion

#region Conveyor property forwarding

func _get_property_list() -> Array[Dictionary]:
	var conveyor_properties := _get_conveyor_forwarded_properties()
	var filtered_properties: Array[Dictionary] = []
	var found_categories: Array = []

	for prop in conveyor_properties:
		var prop_name := prop[&"name"] as String
		var usage := prop[&"usage"] as int

		if usage & PROPERTY_USAGE_CATEGORY:
			if prop_name == "ResizableNode3D" or prop_name in found_categories:
				continue
			found_categories.append(prop_name)

		if prop_name in ["size", "skew_angle", "hijack_scale"] or prop_name.begins_with("metadata/hijack_scale"):
			continue

		filtered_properties.append(prop)

	return filtered_properties


func _set(property: StringName, value: Variant) -> bool:
	if property not in _get_conveyor_forwarded_property_names():
		return false
	_conveyor_property_cached_set(property, value)
	return true


func _get(property: StringName) -> Variant:
	if property not in _get_conveyor_forwarded_property_names():
		return null
	return _conveyor_property_cached_get(property)


func _get_conveyor_forwarded_properties() -> Array[Dictionary]:
	var all_properties: Array[Dictionary]
	var has_seen_node3d_category: bool = false
	var has_seen_category_after_node3d: bool = false

	if _has_instantiated and has_node("%Conveyor"):
		all_properties = %Conveyor.get_property_list()
	else:
		all_properties = _conveyor_script.get_script_property_list()
		has_seen_node3d_category = true

	var filtered_properties: Array[Dictionary] = []
	for property in all_properties:
		if not has_seen_node3d_category:
			has_seen_node3d_category = (property[&"name"] == "Node3D"
					and property[&"usage"] == PROPERTY_USAGE_CATEGORY)
			continue
		if not has_seen_category_after_node3d:
			has_seen_category_after_node3d = property[&"usage"] == PROPERTY_USAGE_CATEGORY
		if not has_seen_category_after_node3d:
			continue
		filtered_properties.append(property)
	return filtered_properties


func _get_conveyor_forwarded_property_names() -> Array:
	var result: Array = (_get_conveyor_forwarded_properties()
			.filter(func(property):
				var prop_name := property[&"name"] as String
				var usage := property[&"usage"] as int
				if prop_name in ["size", "skew_angle", "original_size", "transform_in_progress", "size_min", "size_default", "hijack_scale"]:
					return false
				if prop_name.begins_with("metadata/hijack_scale"):
					return false
				return (not (usage & PROPERTY_USAGE_CATEGORY
					or usage & PROPERTY_USAGE_GROUP
					or usage & PROPERTY_USAGE_SUBGROUP)
					and usage & PROPERTY_USAGE_STORAGE
					and not prop_name.begins_with("metadata/")))
			.map(func(property): return property[&"name"] as String))
	return result


func _conveyor_property_cached_set(property: StringName, value: Variant) -> void:
	if _has_instantiated and has_node("%Conveyor"):
		%Conveyor.set(property, value)
	else:
		_cached_conveyor_property_values[property] = value


func _conveyor_property_cached_get(property: StringName) -> Variant:
	if _has_instantiated and has_node("%Conveyor"):
		var value = %Conveyor.get(property)
		if value != null:
			return value

	if property in _cached_conveyor_property_values:
		return _cached_conveyor_property_values[property]

	if _conveyor_script:
		return _conveyor_script.get_property_default_value(property)

	return null

#endregion

#region Side guards / legs cached property helpers

func _side_guards_property_cached_set(property: StringName, value: Variant, existing_backing_field_value: Variant) -> Variant:
	if _has_instantiated and has_node("%SideGuardsAssembly"):
		%SideGuardsAssembly.set(property, value)
		return value
	else:
		_cached_side_guards_property_values[property] = value
		return value


func _side_guards_property_cached_get(property: StringName, backing_field_value: Variant) -> Variant:
	if _has_instantiated and has_node("%SideGuardsAssembly"):
		var value: Variant = %SideGuardsAssembly.get(property)
		if value != null:
			return value
	return backing_field_value


func _legs_property_cached_set(property: StringName, value: Variant, existing_backing_field_value: Variant) -> Variant:
	if _has_instantiated and has_node("%ConveyorLegsAssembly"):
		%ConveyorLegsAssembly.set(property, value)
		return value
	else:
		_cached_legs_property_values[property] = value
		return value


func _legs_property_cached_get(property: StringName, backing_field_value: Variant) -> Variant:
	if _has_instantiated and has_node("%ConveyorLegsAssembly"):
		var value: Variant = %ConveyorLegsAssembly.get(property)
		if value != null:
			return value
	return backing_field_value

#endregion

#region Preview

func _get_custom_preview_node() -> Node3D:
	var preview_scene := load(PREVIEW_SCENE_PATH) as PackedScene
	var preview_node = preview_scene.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED) as Node3D

	preview_node.set_meta("is_preview", true)

	if preview_node.has_method("_update_spur"):
		preview_node._update_spur()

	_disable_collisions_recursive(preview_node)

	var legs_assembly = preview_node.get_node_or_null("%ConveyorLegsAssembly")
	if is_instance_valid(legs_assembly):
		legs_assembly.set_meta("is_preview", true)
		legs_assembly.set_process_mode(Node.PROCESS_MODE_DISABLED)

	var side_guards = preview_node.get_node_or_null("%SideGuardsAssembly")
	if is_instance_valid(side_guards):
		side_guards.set_meta("is_preview", true)
		side_guards.set_process_mode(Node.PROCESS_MODE_DISABLED)

	preview_node.set_process_mode(Node.PROCESS_MODE_DISABLED)

	return preview_node


func _disable_collisions_recursive(node: Node) -> void:
	if node is CollisionShape3D:
		node.disabled = true

	if node is CollisionObject3D:
		node.collision_layer = 0
		node.collision_mask = 0

	for child in node.get_children(true):
		_disable_collisions_recursive(child)

#endregion
