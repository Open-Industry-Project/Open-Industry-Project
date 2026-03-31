@tool
class_name BeltSpurConveyorAssembly
extends BeltSpurConveyor

const SIDE_GUARDS_SCRIPT_PATH: String = "res://src/ConveyorAttachment/side_guards_assembly.gd"
const SIDE_GUARDS_SCRIPT_FILENAME: String = "side_guards_assembly.gd"
const CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH: String = "res://src/ConveyorAttachment/conveyor_legs_assembly.gd"
const CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME: String = "conveyor_legs_assembly.gd"
const ASSEMBLY_PREVIEW_SCENE_PATH: String = "res://parts/assemblies/BeltSpurConveyorAssembly.tscn"

var _has_instantiated: bool = false

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
@export_group("Left Side Guards", "left_side_guards_")
@export var left_side_guards_enabled: bool = true:
	get:
		return _side_guards_property_cached_get(&"left_side_guards_enabled", left_side_guards_enabled)
	set(value):
		left_side_guards_enabled = _side_guards_property_cached_set(&"left_side_guards_enabled", value, left_side_guards_enabled)
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
var leg_model_scene: PackedScene = preload("res://parts/ConveyorLeg.tscn"):
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


func _ready() -> void:
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
	super._ready()


func _process(_delta: float) -> void:
	super._process(_delta)
	if _has_instantiated:
		call_deferred("_ensure_side_guards_updated")


func _on_size_changed() -> void:
	super._on_size_changed()
	if _has_instantiated:
		call_deferred("_ensure_side_guards_updated")


func _ensure_side_guards_updated() -> void:
	if has_node("%SideGuardsAssembly"):
		%SideGuardsAssembly._on_conveyor_size_changed()


func _collision_repositioned_save() -> Variant:
	return floor_plane


func _collision_repositioned(collision_point: Vector3, collision_normal: Vector3) -> void:
	if _has_instantiated and has_node("%ConveyorLegsAssembly"):
		%ConveyorLegsAssembly.collision_repositioned(collision_point, collision_normal)


func _collision_repositioned_undo(saved_data: Variant) -> void:
	if saved_data is Plane and _has_instantiated and has_node("%ConveyorLegsAssembly"):
		%ConveyorLegsAssembly.restore_floor_plane(saved_data)


func _validate_property(property: Dictionary) -> void:
	if property[&"name"] == SIDE_GUARDS_SCRIPT_FILENAME \
			and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		assert(SIDE_GUARDS_SCRIPT_PATH.get_file() == SIDE_GUARDS_SCRIPT_FILENAME, "SIDE_GUARDS_SCRIPT_PATH doesn't match SIDE_GUARDS_SCRIPT_FILENAME")
		property[&"hint_string"] = SIDE_GUARDS_SCRIPT_PATH
		return
	elif property[&"name"] == CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME \
			and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		assert(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH.get_file() == CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME, "CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH doesn't match CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME")
		property[&"hint_string"] = CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH
		return

	super._validate_property(property)


func _property_can_revert(property: StringName) -> bool:
	if property in _get_conveyor_forwarded_property_names():
		return true
	return super._property_can_revert(property)


func _property_get_revert(property: StringName) -> Variant:
	if property not in _get_conveyor_forwarded_property_names():
		return super._property_get_revert(property)
	var conveyor := _get_first_conveyor()
	if conveyor:
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
	var preview_scene := load(ASSEMBLY_PREVIEW_SCENE_PATH) as PackedScene
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

#endregion
