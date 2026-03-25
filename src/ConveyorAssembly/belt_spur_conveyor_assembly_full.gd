@tool
class_name BeltSpurConveyorAssembly
extends SpurConveyorAssembly

const CONVEYOR_CLASS_NAME = "BeltConveyor"
const CONVEYOR_SCRIPT_PATH = "res://src/Conveyor/belt_conveyor.gd"
const CONVEYOR_SCRIPT_FILENAME = "belt_conveyor.gd"
const SIDE_GUARDS_SCRIPT_PATH: String = "res://src/ConveyorAttachment/side_guards_assembly.gd"
const SIDE_GUARDS_SCRIPT_FILENAME: String = "side_guards_assembly.gd"
const CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH: String = "res://src/ConveyorAttachment/conveyor_legs_assembly.gd"
const CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME: String = "conveyor_legs_assembly.gd"
const PREVIEW_SCENE_PATH: String = "res://parts/assemblies/BeltSpurConveyorAssembly.tscn"

static var _conveyor_script_cached: Script

var _conveyor_script: Script
var _has_instantiated: bool = false

@export_storage var _cached_properties: Dictionary = {}

var _default_speed: float = 2.0
var _default_belt_color: Color = Color.WHITE
var _default_belt_texture: int = 0
var _default_enable_comms: bool = false
var _default_speed_tag_group_name: String = ""
var _default_speed_tag_name: String = ""
var _default_running_tag_group_name: String = ""
var _default_running_tag_name: String = ""

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
var leg_model_scene: PackedScene = preload("res://parts/ConveyorLegBC.tscn"):
	get:
		return _legs_property_cached_get(&"leg_model_scene", leg_model_scene)
	set(value):
		leg_model_scene = _legs_property_cached_set(&"leg_model_scene", value, leg_model_scene)
@export
var leg_model_grabs_offset: float = 0.132:
	get:
		return _legs_property_cached_get(&"leg_model_grabs_offset", leg_model_grabs_offset)
	set(value):
		leg_model_grabs_offset = _legs_property_cached_set(&"leg_model_grabs_offset", value, leg_model_grabs_offset)
#endregion


func _init() -> void:
	super()
	_cached_properties[&"speed"] = _default_speed
	_cached_properties[&"belt_color"] = _default_belt_color
	_cached_properties[&"belt_texture"] = _default_belt_texture
	_cached_properties[&"enable_comms"] = _default_enable_comms
	_cached_properties[&"speed_tag_group_name"] = _default_speed_tag_group_name
	_cached_properties[&"speed_tag_name"] = _default_speed_tag_name
	_cached_properties[&"running_tag_group_name"] = _default_running_tag_group_name
	_cached_properties[&"running_tag_name"] = _default_running_tag_name

	if _conveyor_script_cached == null:
		var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
		var class_details: Dictionary = class_list[class_list.find_custom(func (item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
		_conveyor_script_cached = load(class_details["path"]) as Script
	_conveyor_script = _conveyor_script_cached


func _enter_tree() -> void:
	super._enter_tree()
	if not OIPComms.enable_comms_changed.is_connected(notify_property_list_changed):
		OIPComms.enable_comms_changed.connect(notify_property_list_changed)


func _ready() -> void:
	if not %SideGuardsAssembly.property_list_changed.is_connected(notify_property_list_changed):
		%SideGuardsAssembly.property_list_changed.connect(notify_property_list_changed)

	for property: StringName in _cached_side_guards_property_values:
		var value: Variant = _cached_side_guards_property_values[property]
		%SideGuardsAssembly.set(property, value)
	_cached_side_guards_property_values.clear()

	if not %ConveyorLegsAssembly.property_list_changed.is_connected(notify_property_list_changed):
		%ConveyorLegsAssembly.property_list_changed.connect(notify_property_list_changed)

	for property: StringName in _cached_legs_property_values:
		var value: Variant = _cached_legs_property_values[property]
		%ConveyorLegsAssembly.set(property, value)
	_cached_legs_property_values.clear()

	_has_instantiated = true
	call_deferred("_ensure_side_guards_updated")
	super._ready()


func _exit_tree() -> void:
	if OIPComms.enable_comms_changed.is_connected(notify_property_list_changed):
		OIPComms.enable_comms_changed.disconnect(notify_property_list_changed)


func _process(_delta: float) -> void:
	super._process(_delta)
	if _has_instantiated:
		call_deferred("_ensure_side_guards_updated")


func _on_size_changed() -> void:
	super._on_size_changed()
	if _has_instantiated:
		call_deferred("_ensure_side_guards_updated")


func _ensure_side_guards_updated() -> void:
	if is_instance_valid(%SideGuardsAssembly):
		%SideGuardsAssembly._on_conveyor_size_changed()


func _collision_repositioned_save() -> Variant:
	return floor_plane


func _collision_repositioned(collision_point: Vector3, collision_normal: Vector3) -> void:
	if _has_instantiated and is_instance_valid(%ConveyorLegsAssembly):
		%ConveyorLegsAssembly.collision_repositioned(collision_point, collision_normal)


func _collision_repositioned_undo(saved_data: Variant) -> void:
	if saved_data is Plane and _has_instantiated and is_instance_valid(%ConveyorLegsAssembly):
		%ConveyorLegsAssembly.restore_floor_plane(saved_data)


#region Belt property forwarding to internal conveyor children

func _set_conveyor_properties(conveyor: Node) -> void:
	for property_name in _cached_properties:
		if conveyor.has_method("set"):
			conveyor.set(property_name, _cached_properties[property_name])


func _set_for_all_conveyors(property: StringName, value: Variant) -> void:
	var count := _get_internal_child_count()
	var offset := get_child_count()
	for i in range(count):
		var conveyor: Node = get_child(i + offset, true)
		conveyor.set(property, value)


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

		if prop_name == "size" or prop_name == "hijack_scale" or prop_name.begins_with("metadata/hijack_scale"):
			continue

		filtered_properties.append(prop)

	return filtered_properties


func _validate_property(property: Dictionary) -> void:
	if property[&"name"] == CONVEYOR_SCRIPT_FILENAME \
			and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		assert(CONVEYOR_SCRIPT_PATH.get_file() == CONVEYOR_SCRIPT_FILENAME, "CONVEYOR_SCRIPT_PATH doesn't match CONVEYOR_SCRIPT_FILENAME")
		property[&"hint_string"] = CONVEYOR_SCRIPT_PATH
		return
	elif property[&"name"] == SIDE_GUARDS_SCRIPT_FILENAME \
			and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		assert(SIDE_GUARDS_SCRIPT_PATH.get_file() == SIDE_GUARDS_SCRIPT_FILENAME, "SIDE_GUARDS_SCRIPT_PATH doesn't match SIDE_GUARDS_SCRIPT_FILENAME")
		property[&"hint_string"] = SIDE_GUARDS_SCRIPT_PATH
		return
	elif property[&"name"] == CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME \
			and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		assert(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH.get_file() == CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME, "CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH doesn't match CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME")
		property[&"hint_string"] = CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH
		return
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

	super._validate_property(property)


func _set(property: StringName, value: Variant) -> bool:
	if property not in _get_conveyor_forwarded_property_names():
		return false
	_cached_properties[property] = value
	_set_for_all_conveyors(property, value)
	if property == &"enable_comms":
		notify_property_list_changed()
	return true


func _get(property: StringName) -> Variant:
	if property not in _get_conveyor_forwarded_property_names():
		return null
	var conveyor := _get_first_conveyor()
	if conveyor:
		return conveyor.get(property)
	if property in _cached_properties:
		return _cached_properties[property]
	match property:
		&"speed":
			return _default_speed
		&"belt_color":
			return _default_belt_color
		&"belt_texture":
			return _default_belt_texture
		&"enable_comms":
			return _default_enable_comms
		&"speed_tag_group_name":
			return _default_speed_tag_group_name
		&"speed_tag_name":
			return _default_speed_tag_name
		&"running_tag_group_name":
			return _default_running_tag_group_name
		&"running_tag_name":
			return _default_running_tag_name
		_:
			return null


func _property_can_revert(property: StringName) -> bool:
	if property in _get_conveyor_forwarded_property_names():
		return true
	return super._property_can_revert(property)


func _property_get_revert(property: StringName) -> Variant:
	if property not in _get_conveyor_forwarded_property_names():
		return super._property_get_revert(property)
	if _get_internal_child_count() > 0:
		var conveyor: Node = get_child(get_child_count(), true)
		if conveyor.has_method("property_can_revert") and conveyor.property_can_revert(property):
			return conveyor.property_get_revert(property)
		elif conveyor.scene_file_path:
			var scene := load(conveyor.scene_file_path) as PackedScene
			var scene_state := scene.get_state()
			for prop_idx in range(scene_state.get_node_property_count(0)):
				if scene_state.get_node_property_name(0, prop_idx) == property:
					return scene_state.get_node_property_value(0, prop_idx)
			return conveyor.get_script().get_property_default_value(property)
	return _conveyor_script.get_property_default_value(property)


func _get_conveyor_script() -> Script:
	if _conveyor_script_cached == null:
		var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
		var class_details: Dictionary = class_list[class_list.find_custom(func (item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
		_conveyor_script_cached = load(class_details["path"]) as Script
	_conveyor_script = _conveyor_script_cached
	return _conveyor_script


func _get_conveyor_forwarded_properties() -> Array[Dictionary]:
	var all_properties: Array[Dictionary]
	var has_seen_node3d_category: bool = false
	var has_seen_category_after_node3d: bool = false

	if _get_internal_child_count() > 0:
		var conveyor: Node = get_child(get_child_count(), true)
		all_properties = conveyor.get_property_list()
	else:
		all_properties = _get_conveyor_script().get_script_property_list()
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
				if prop_name in ["size", "original_size", "transform_in_progress", "size_min", "size_default", "hijack_scale"]:
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

#endregion

#region Side guards / legs cached property helpers

func _side_guards_property_cached_set(property: StringName, value: Variant, existing_backing_field_value: Variant) -> Variant:
	if _has_instantiated:
		%SideGuardsAssembly.set(property, value)
		return value
	else:
		_cached_side_guards_property_values[property] = value
		return value


func _side_guards_property_cached_get(property: StringName, backing_field_value: Variant) -> Variant:
	if _has_instantiated and is_instance_valid(%SideGuardsAssembly):
		var value: Variant = %SideGuardsAssembly.get(property)
		if value != null:
			return value
	return backing_field_value


func _legs_property_cached_set(property: StringName, value: Variant, existing_backing_field_value: Variant) -> Variant:
	if _has_instantiated:
		%ConveyorLegsAssembly.set(property, value)
		return value
	else:
		_cached_legs_property_values[property] = value
		return value


func _legs_property_cached_get(property: StringName, backing_field_value: Variant) -> Variant:
	if _has_instantiated and is_instance_valid(%ConveyorLegsAssembly):
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

	if preview_node.has_method("_update_conveyors"):
		preview_node._update_conveyors()

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
