@tool
class_name BeltConveyorAssembly
extends ResizableNode3D

const CONVEYOR_CLASS_NAME: String = "BeltConveyor"
const SIDE_GUARDS_SCRIPT_PATH: String = "res://src/ConveyorAttachment/side_guards_assembly.gd"
const SIDE_GUARDS_SCRIPT_FILENAME: String = "side_guards_assembly.gd"
const CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH: String = "res://src/ConveyorAttachment/conveyor_legs_assembly.gd"
const CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME: String = "conveyor_legs_assembly.gd"
const PREVIEW_SCENE_PATH: String = "res://parts/assemblies/BeltConveyorAssembly.tscn"

## Conveyor speed in meters per second.
## Negative values will reverse the direction of the conveyor.
var speed: float = 2:
	get:
		return _conveyor_property_cached_get(&"speed")
	set(value):
		_conveyor_property_cached_set(&"speed", value)

## The color of the conveyor belt.
var belt_color: Color = Color(1, 1, 1, 1):
	get:
		return _conveyor_property_cached_get(&"belt_color")
	set(value):
		_conveyor_property_cached_set(&"belt_color", value)

## The texture pattern used on the conveyor belt.
var belt_texture: int = 0:
	get:
		return _conveyor_property_cached_get(&"belt_texture")
	set(value):
		_conveyor_property_cached_set(&"belt_texture", value)

## Physics material for the conveyor belt surface.
var belt_physics_material: PhysicsMaterial:
	get:
		return _conveyor_property_cached_get(&"belt_physics_material")
	set(value):
		_conveyor_property_cached_set(&"belt_physics_material", value)

var _conveyor_script: Script
var _has_instantiated: bool = false
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
var middle_legs_enabled: bool = true:
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
	super._init()

	var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
	var class_details: Dictionary = class_list[class_list.find_custom(func (item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
	_conveyor_script = load(class_details["path"]) as Script


func _ready() -> void:
	if not %Conveyor.property_list_changed.is_connected(notify_property_list_changed):
		%Conveyor.property_list_changed.connect(notify_property_list_changed)

	for property: StringName in _cached_conveyor_property_values:
		var value: Variant = _cached_conveyor_property_values[property]
		%Conveyor.set(property, value)
	_cached_conveyor_property_values.clear()

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
	if is_instance_valid(%Conveyor) and "size" in %Conveyor:
		%Conveyor.size = size
	call_deferred("_ensure_side_guards_updated")


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
	if property[&"name"] == SIDE_GUARDS_SCRIPT_FILENAME \
			and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		assert(SIDE_GUARDS_SCRIPT_PATH.get_file() == SIDE_GUARDS_SCRIPT_FILENAME, "SIDE_GUARDS_SCRIPT_PATH doesn't match SIDE_GUARDS_SCRIPT_FILENAME")
		property[&"hint_string"] = SIDE_GUARDS_SCRIPT_PATH
	elif property[&"name"] == CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME \
			and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		assert(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH.get_file() == CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME, "CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH doesn't match CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME")
		property[&"hint_string"] = CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH


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
	if property not in _get_conveyor_forwarded_property_names():
		return null
	if _has_instantiated:
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


func _get_constrained_size(new_size: Vector3) -> Vector3:
	# No constraints for belt conveyor assemblies
	return new_size


func _on_size_changed() -> void:
	if _has_instantiated and is_instance_valid(%Conveyor) and "size" in %Conveyor:
		%Conveyor.size = size

func _get_custom_preview_node() -> Node3D:
	var preview_scene := load(PREVIEW_SCENE_PATH) as PackedScene
	var preview_node = preview_scene.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED) as Node3D

	_disable_collisions_recursive(preview_node)

	var legs_assembly = preview_node.get_node_or_null("%ConveyorLegsAssembly")
	if is_instance_valid(legs_assembly):
		legs_assembly.set_meta("is_preview", true)
		legs_assembly.set_process_mode(Node.PROCESS_MODE_DISABLED)

	var side_guards = preview_node.get_node_or_null("%SideGuardsAssembly")
	if is_instance_valid(side_guards):
		side_guards.set_meta("is_preview", true)
		side_guards.set_process_mode(Node.PROCESS_MODE_DISABLED)

	return preview_node


func _disable_collisions_recursive(node: Node) -> void:
	if node is CollisionShape3D:
		node.disabled = true

	if node is CollisionObject3D:
		node.collision_layer = 0
		node.collision_mask = 0

	for child in node.get_children():
		_disable_collisions_recursive(child)


func _ensure_side_guards_updated() -> void:
	%SideGuardsAssembly._on_conveyor_size_changed()


func _get_conveyor_forwarded_properties() -> Array[Dictionary]:
	var all_properties: Array[Dictionary]
	# Skip properties until we reach the category after the "Node3D" category.
	var has_seen_node3d_category: bool = false
	var has_seen_category_after_node3d: bool = false
	# Avoid duplicating ResizableNode3D properties
	var has_seen_resizable_node_3d_category: bool = false

	if _has_instantiated:
		all_properties = %Conveyor.get_property_list()
	else:
		# The conveyor instance won't exist yet, so grab from the script class instead.
		all_properties = _conveyor_script.get_script_property_list()
		# List doesn't include built-in properties, so we don't have to skip them.
		has_seen_node3d_category = true

	var filtered_properties: Array[Dictionary] = []
	for property in all_properties:
		# Skip ResizableNode3D properties completely since we already have them from our parent class
		if property[&"name"] == "ResizableNode3D" and property[&"usage"] == PROPERTY_USAGE_CATEGORY:
			has_seen_resizable_node_3d_category = true
			continue

		if has_seen_resizable_node_3d_category:
			# Skip all properties until we find the next category
			if property[&"usage"] == PROPERTY_USAGE_CATEGORY:
				has_seen_resizable_node_3d_category = false
			else:
				continue

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
		var value: Variant = %Conveyor.get(property)
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
		var value: Variant = %SideGuardsAssembly.get(property)
		if value != null:
			return value

	# Return backing field value as fallback (this maintains the typed defaults)
	return backing_field_value


## Get the property value from the ConveyorLegsAssembly node; use a cached value if that child isn't present.
##
## [param backing_field_value] should be provided by the property's getter (where it can be accessed directly).
func _legs_property_cached_get(property: StringName, backing_field_value: Variant) -> Variant:
	if _has_instantiated and is_instance_valid(%ConveyorLegsAssembly):
		var value: Variant = %ConveyorLegsAssembly.get(property)
		if value != null:
			return value

	# Return backing field value as fallback (this maintains the typed defaults)
	return backing_field_value


## Called by curved conveyor when inner_radius or conveyor_width changes
func update_attachments_for_curved_conveyor(inner_radius: float, conveyor_width: float, conveyor_size: Vector3, conveyor_angle: float) -> void:
	if not _has_instantiated:
		return

	# Update side guards for curved conveyor
	var side_guards = get_node_or_null("SideGuardsAssembly")
	if not side_guards:
		side_guards = get_node_or_null("%SideGuardsAssembly")

	if is_instance_valid(side_guards) and side_guards.has_method("update_for_curved_conveyor"):
		side_guards.update_for_curved_conveyor(inner_radius, conveyor_width, conveyor_size, conveyor_angle)

	# Update legs for curved conveyor
	var legs_assembly = get_node_or_null("ConveyorLegsAssembly")
	if not legs_assembly:
		legs_assembly = get_node_or_null("%ConveyorLegsAssembly")

	if is_instance_valid(legs_assembly) and legs_assembly.has_method("update_for_curved_conveyor"):
		legs_assembly.update_for_curved_conveyor(inner_radius, conveyor_width, conveyor_size, conveyor_angle)
