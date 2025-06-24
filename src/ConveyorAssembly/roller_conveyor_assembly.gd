@tool
class_name RollerConveyorAssembly
extends ResizableNode3D

const CONVEYOR_CLASS_NAME = "RollerConveyor"
const SIDE_GUARDS_SCRIPT_PATH = "res://src/ConveyorAttachment/side_guards_assembly.gd"
const SIDE_GUARDS_SCRIPT_FILENAME = "side_guards_assembly.gd"
const CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH = "res://src/ConveyorAttachment/conveyor_legs_assembly.gd"
const CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME = "conveyor_legs_assembly.gd"

## Conveyor speed in meters per second.
## Negative values will reverse the direction of the conveyor.
var speed: float = 2:
	get:
		return _conveyor_property_cached_get(&"speed")
	set(value):
		_conveyor_property_cached_set(&"speed", value)

## The color of the conveyor rollers.
var roller_color: Color = Color(1, 1, 1, 1):
	get:
		return _conveyor_property_cached_get(&"roller_color")
	set(value):
		_conveyor_property_cached_set(&"roller_color", value)

## Physics material for the conveyor rollers surface.
var roller_physics_material: PhysicsMaterial:
	get:
		return _conveyor_property_cached_get(&"roller_physics_material")
	set(value):
		_conveyor_property_cached_set(&"roller_physics_material", value)

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
var middle_legs_enabled := true:
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
var head_end_leg_enabled: bool = true:
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



var _conveyor_script: Script
var _has_instantiated := false
var _cached_conveyor_property_values: Dictionary[StringName, Variant] = {}
var _cached_side_guards_property_values: Dictionary[StringName, Variant] = {}
var _cached_legs_property_values: Dictionary[StringName, Variant] = {}


func _init() -> void:
	super._init()

	var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
	var class_details: Dictionary = class_list[class_list.find_custom(func(item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
	_conveyor_script = load(class_details["path"]) as Script



func _ready() -> void:
	if not %Conveyor.property_list_changed.is_connected(notify_property_list_changed):
		%Conveyor.property_list_changed.connect(notify_property_list_changed)

	for property: StringName in _cached_conveyor_property_values:
		var value = _cached_conveyor_property_values[property]
		%Conveyor.set(property, value)
	_cached_conveyor_property_values.clear()

	if not %SideGuardsAssembly.property_list_changed.is_connected(notify_property_list_changed):
		%SideGuardsAssembly.property_list_changed.connect(notify_property_list_changed)

	for property: StringName in _cached_side_guards_property_values:
		var value = _cached_side_guards_property_values[property]
		%SideGuardsAssembly.set(property, value)
	_cached_side_guards_property_values.clear()

	if not %ConveyorLegsAssembly.property_list_changed.is_connected(notify_property_list_changed):
		%ConveyorLegsAssembly.property_list_changed.connect(notify_property_list_changed)

	for property: StringName in _cached_legs_property_values:
		var value = _cached_legs_property_values[property]
		%ConveyorLegsAssembly.set(property, value)
	_cached_legs_property_values.clear()

	_has_instantiated = true
	if is_instance_valid(%Conveyor) and "size" in %Conveyor:
		%Conveyor.size = size
	call_deferred("_ensure_side_guards_updated")
	
	# Connect to OIPComms signal to update property visibility when global comms setting changes
	OIPComms.enable_comms_changed.connect(notify_property_list_changed)


func _exit_tree() -> void:
	# Disconnect from OIPComms signal
	if OIPComms.enable_comms_changed.is_connected(notify_property_list_changed):
		OIPComms.enable_comms_changed.disconnect(notify_property_list_changed)


func _get_property_list() -> Array[Dictionary]:
	var conveyor_properties = _get_conveyor_forwarded_properties()
	var filtered_properties: Array[Dictionary] = []
	var found_categories = []

	for prop in conveyor_properties:
		var prop_name = prop[&"name"] as String
		var usage = prop[&"usage"] as int

		if usage & PROPERTY_USAGE_CATEGORY:
			if prop_name == "ResizableNode3D" or prop_name in found_categories:
				continue
			found_categories.append(prop_name)

		if prop_name == "size" or prop_name == "hijack_scale" or prop_name.begins_with("metadata/hijack_scale"):
			continue

		filtered_properties.append(prop)

	return filtered_properties


func _validate_property(property: Dictionary) -> void:
	if property[&"name"] == SIDE_GUARDS_SCRIPT_FILENAME \
			and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		assert(SIDE_GUARDS_SCRIPT_PATH.get_file() == SIDE_GUARDS_SCRIPT_FILENAME, "SIDE_GUARDS_SCRIPT_PATH doesn't match SIDE_GUARDS_SCRIPT_FILENAME")
		property[&"hint_string"] = SIDE_GUARDS_SCRIPT_PATH
	elif property[&"name"] == CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME \
			and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		assert(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH.get_file() == CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME, "CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH doesn't match CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME")
		property[&"hint_string"] = CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH
	# Handle communication properties forwarded from RollerConveyor
	elif property[&"name"] == "Communications" and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		property[&"usage"] = PROPERTY_USAGE_CATEGORY if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property[&"name"] == "enable_comms":
		property[&"usage"] = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property[&"name"] == "speed_tag_group_name":
		property[&"usage"] = PROPERTY_USAGE_STORAGE
	elif property[&"name"] == "speed_tag_groups":
		property[&"usage"] = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property[&"name"] == "speed_tag_name":
		property[&"usage"] = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property[&"name"] == "running_tag_group_name":
		property[&"usage"] = PROPERTY_USAGE_STORAGE
	elif property[&"name"] == "running_tag_groups":
		property[&"usage"] = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property[&"name"] == "running_tag_name":
		property[&"usage"] = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE


func _set(property: StringName, value: Variant) -> bool:
	if property not in _get_conveyor_forwarded_property_names():
		return false
	_conveyor_property_cached_set(property, value)
	return true


func _get(property: StringName) -> Variant:
	if property not in _get_conveyor_forwarded_property_names():
		return null
	return _conveyor_property_cached_get(property)


func _property_can_revert(property: StringName) -> bool:
	return property in _get_conveyor_forwarded_property_names()


func _property_get_revert(property: StringName) -> Variant:
	#print("_property_get_revert(%s)" % property)
	if property not in _get_conveyor_forwarded_property_names():
		return null
	if _has_instantiated:
		if %Conveyor.property_can_revert(property):
			#print("revert for ", property, ": ", %Conveyor.property_get_revert(property))
			return %Conveyor.property_get_revert(property)
		elif %Conveyor.scene_file_path:
			# Find the property's value in the PackedScene file.
			var scene := load(%Conveyor.scene_file_path) as PackedScene
			var scene_state := scene.get_state()
			for prop_idx in range(scene_state.get_node_property_count(0)):
				if scene_state.get_node_property_name(0, prop_idx) == property:
					#print("revert for ", property, ": ", scene_state.get_node_property_value(0, prop_idx))
					return scene_state.get_node_property_value(0, prop_idx)
			# Try the script's default instead.
			#print("revert for ", property, ": ", %Conveyor.get_script().get_property_default_value(property))
			return %Conveyor.get_script().get_property_default_value(property)
	#print("revert for ", property, ": ", _conveyor_script.get_property_default_value(property))
	return _conveyor_script.get_property_default_value(property)





func _get_conveyor_forwarded_properties() -> Array[Dictionary]:
	var all_properties: Array[Dictionary]
	# Skip properties until we reach the category after the "Node3D" category.
	var has_seen_node3d_category = false
	var has_seen_category_after_node3d = false

	if _has_instantiated:
		all_properties = %Conveyor.get_property_list()
	else:
		# The conveyor instance won't exist yet, so grab from the script class instead.
		all_properties = _conveyor_script.get_script_property_list()
		# List doesn't include built-in properties, so we don't have to skip them.
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
		# Take all successive properties.
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


## Forward the property value to the Conveyor node; cache it if that child isn't present.
func _conveyor_property_cached_set(property: StringName, value: Variant) -> void:
	if _has_instantiated:
		%Conveyor.set(property, value)
	else:
		# The instance won't exist yet, so cache the values to apply them later.
		_cached_conveyor_property_values[property] = value


## Forward the property value to the SideGuardsAssembly node; cache it if that child isn't present.
##
## The return value is to be used by the property's setter to update its backing field.
func _side_guards_property_cached_set(property: StringName, value: Variant, existing_backing_field_value: Variant) -> Variant:
	if _has_instantiated:
		%SideGuardsAssembly.set(property, value)
		return value
	else:
		# The instance won't exist yet, so cache the values to apply them later.
		_cached_side_guards_property_values[property] = value
		return value


## Forward the property value to the ConveyorLegsAssembly node; cache it if that child isn't present.
##
## The return value is to be used by the property's setter to update its backing field.
func _legs_property_cached_set(property: StringName, value: Variant, existing_backing_field_value: Variant) -> Variant:
	if _has_instantiated:
		%ConveyorLegsAssembly.set(property, value)
		return value
	else:
		# The instance won't exist yet, so cache the values to apply them later.
		_cached_legs_property_values[property] = value
		return value


## Get the property value from the Conveyor node; use a cached value if that child isn't present.
func _conveyor_property_cached_get(property: StringName) -> Variant:
	if _has_instantiated and is_instance_valid(%Conveyor):
		var value = %Conveyor.get(property)
		if value != null:
			return value

	# Return cached value or look up default from cache
	if property in _cached_conveyor_property_values:
		return _cached_conveyor_property_values[property]

	# Return script default as final fallback
	if _conveyor_script:
		return _conveyor_script.get_property_default_value(property)

	return null


## Get the property value from the SideGuardsAssembly node; use a cached value if that child isn't present.
##
## [param backing_field_value] should be provided by the property's getter (where it can be accessed directly).
func _side_guards_property_cached_get(property: StringName, backing_field_value: Variant) -> Variant:
	if _has_instantiated and is_instance_valid(%SideGuardsAssembly):
		var value = %SideGuardsAssembly.get(property)
		if value != null:
			return value

	return backing_field_value


## Get the property value from the ConveyorLegsAssembly node; use a cached value if that child isn't present.
##
## [param backing_field_value] should be provided by the property's getter (where it can be accessed directly).
func _legs_property_cached_get(property: StringName, backing_field_value: Variant) -> Variant:
	if _has_instantiated and is_instance_valid(%ConveyorLegsAssembly):
		var value = %ConveyorLegsAssembly.get(property)
		if value != null:
			return value

	return backing_field_value


func _get_constrained_size(new_size: Vector3) -> Vector3:
	# No constraints for roller conveyor assemblies
	return new_size



func _on_size_changed() -> void:
	if _has_instantiated and is_instance_valid(%Conveyor) and "size" in %Conveyor:
		%Conveyor.size = size


func _ensure_side_guards_updated() -> void:
	%SideGuardsAssembly._on_conveyor_size_changed()
