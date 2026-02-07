@tool
class_name PathFollowingConveyorAssembly
extends Node3D

const CONVEYOR_CLASS_NAME := "PathFollowingConveyor"
const PREVIEW_SCENE_PATH: String = "res://parts/assemblies/PathFollowingConveyorAssembly.tscn"
const SIDE_GUARDS_SCRIPT_PATH: String = "res://src/SideGuards/path_following_side_guards.gd"
const SIDE_GUARDS_SCRIPT_FILENAME: String = "path_following_side_guards.gd"
const CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH: String = "res://src/ConveyorAttachment/path_following_conveyor_legs_assembly.gd"
const CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME: String = "path_following_conveyor_legs_assembly.gd"

var _conveyor_script: Script
var _has_instantiated := false
var _cached_conveyor_property_values: Dictionary[StringName, Variant] = {}
var _cached_side_guards_property_values: Dictionary[StringName, Variant] = {}
var _cached_legs_property_values: Dictionary[StringName, Variant] = {}

#region PathFollowingSideGuards Properties
@export_category(SIDE_GUARDS_SCRIPT_FILENAME)
@export_group("Wall Visibility")
@export var left_wall_enabled: bool = true:
	get:
		return _side_guards_property_cached_get(&"left_wall_enabled", left_wall_enabled)
	set(value):
		left_wall_enabled = _side_guards_property_cached_set(&"left_wall_enabled", value, left_wall_enabled)
@export var right_wall_enabled: bool = true:
	get:
		return _side_guards_property_cached_get(&"right_wall_enabled", right_wall_enabled)
	set(value):
		right_wall_enabled = _side_guards_property_cached_set(&"right_wall_enabled", value, right_wall_enabled)

@export_group("Side Guard Visibility")
@export var show_inner_end_l: bool = true:
	get:
		return _side_guards_property_cached_get(&"show_inner_end_l", show_inner_end_l)
	set(value):
		show_inner_end_l = _side_guards_property_cached_set(&"show_inner_end_l", value, show_inner_end_l)
@export var show_outer_end_l: bool = true:
	get:
		return _side_guards_property_cached_get(&"show_outer_end_l", show_outer_end_l)
	set(value):
		show_outer_end_l = _side_guards_property_cached_set(&"show_outer_end_l", value, show_outer_end_l)
@export var show_inner_end_r: bool = true:
	get:
		return _side_guards_property_cached_get(&"show_inner_end_r", show_inner_end_r)
	set(value):
		show_inner_end_r = _side_guards_property_cached_set(&"show_inner_end_r", value, show_inner_end_r)
@export var show_outer_end_r: bool = true:
	get:
		return _side_guards_property_cached_get(&"show_outer_end_r", show_outer_end_r)
	set(value):
		show_outer_end_r = _side_guards_property_cached_set(&"show_outer_end_r", value, show_outer_end_r)
#endregion

#region PathFollowingConveyorLegsAssembly properties
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

# Track when attachment updates are needed to avoid unnecessary recalculations
var _attachment_update_needed: bool = true

func _init() -> void:
	# Note: No longer inherits from ResizableNode3D, so no size controls
	var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
	var class_details: Dictionary = class_list[class_list.find_custom(func(item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
	_conveyor_script = load(class_details["path"]) as Script

	# Enable transform notifications
	set_notify_transform(true)


func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSFORM_CHANGED:
		if _has_instantiated and is_inside_tree() and _attachment_update_needed:
			_update_attachments()
	elif what == NOTIFICATION_ENTER_TREE:
		if _has_instantiated:
			_attachment_update_needed = true
			_update_attachments()


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
		assert(SIDE_GUARDS_SCRIPT_PATH.get_file() == SIDE_GUARDS_SCRIPT_FILENAME)
		property[&"hint_string"] = SIDE_GUARDS_SCRIPT_PATH
	elif property[&"name"] == CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME \
			and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		assert(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH.get_file() == CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME)
		property[&"hint_string"] = CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH


func _set(property: StringName, value: Variant) -> bool:
	if property == "size":
		return false

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
		if $PathFollowingConveyor.property_can_revert(property):
			return $PathFollowingConveyor.property_get_revert(property)
		elif $PathFollowingConveyor.scene_file_path:
			var scene := load($PathFollowingConveyor.scene_file_path) as PackedScene
			var scene_state := scene.get_state()
			for prop_idx in range(scene_state.get_node_property_count(0)):
				if scene_state.get_node_property_name(0, prop_idx) == property:
					return scene_state.get_node_property_value(0, prop_idx)
			return $PathFollowingConveyor.get_script().get_property_default_value(property)
	return _conveyor_script.get_property_default_value(property)


func _ready() -> void:
	_setup_local_path()

	if not $PathFollowingConveyor.property_list_changed.is_connected(notify_property_list_changed):
		$PathFollowingConveyor.property_list_changed.connect(notify_property_list_changed)

	for property: StringName in _cached_conveyor_property_values:
		var value = _cached_conveyor_property_values[property]
		$PathFollowingConveyor.set(property, value)
	_cached_conveyor_property_values.clear()

	if not $PathFollowingSideGuards.property_list_changed.is_connected(notify_property_list_changed):
		$PathFollowingSideGuards.property_list_changed.connect(notify_property_list_changed)

	for property: StringName in _cached_side_guards_property_values:
		var value: Variant = _cached_side_guards_property_values[property]
		$PathFollowingSideGuards.set(property, value)
	_cached_side_guards_property_values.clear()

	if not %PathFollowingConveyorLegsAssembly.property_list_changed.is_connected(notify_property_list_changed):
		%PathFollowingConveyorLegsAssembly.property_list_changed.connect(notify_property_list_changed)

	for property: StringName in _cached_legs_property_values:
		var value: Variant = _cached_legs_property_values[property]
		%PathFollowingConveyorLegsAssembly.set(property, value)
	_cached_legs_property_values.clear()

	_has_instantiated = true

	_update_attachments()


## Creates a local Path3D node with a duplicated curve from the existing path_to_follow.
## Only runs when the node is instantiated into another scene (not when it's the scene root).
func _setup_local_path() -> void:
	if Engine.is_editor_hint():
		var edited_scene_root: Node = get_tree().edited_scene_root if get_tree() else null
		if edited_scene_root == self:
			return
	else:
		if get_parent() == null or self == get_tree().current_scene:
			return

	var conveyor := $PathFollowingConveyor as PathFollowingConveyor
	if not is_instance_valid(conveyor):
		return

	var existing_path: Path3D = conveyor.path_to_follow
	if not is_instance_valid(existing_path) or existing_path.curve == null:
		return

	var existing_local_path: Path3D = get_node_or_null("Path") as Path3D
	if is_instance_valid(existing_local_path):
		return

	var duplicated_curve: Curve3D = existing_path.curve.duplicate() as Curve3D

	var new_path := Path3D.new()
	new_path.name = "Path"
	new_path.curve = duplicated_curve

	add_child(new_path)
	if Engine.is_editor_hint():
		var edited_scene_root: Node = get_tree().edited_scene_root if get_tree() else null
		if edited_scene_root and new_path.is_inside_tree() and edited_scene_root.is_ancestor_of(new_path):
			new_path.owner = edited_scene_root

	self.set("path_to_follow", new_path)

	if existing_path.name != "Path":
		existing_path.visible = false
		existing_path.update_gizmos()
	else:
		$Path3D.visible = false
		$PathFollowingConveyor/Path3D.visible = false

		existing_path.visible = true

	if is_instance_valid($PathFollowingSideGuards):
		$PathFollowingSideGuards.update_for_path_conveyor()
	if is_instance_valid(%PathFollowingConveyorLegsAssembly):
		%PathFollowingConveyorLegsAssembly._on_path_segments_changed()


func _get_conveyor_forwarded_properties() -> Array[Dictionary]:
	var all_properties: Array[Dictionary]
	var has_seen_node3d_category := false
	var has_seen_category_after_node3d := false
	var has_seen_resizable_node_3d_category := false

	if _has_instantiated:
		all_properties = $PathFollowingConveyor.get_property_list()
	else:
		all_properties = _conveyor_script.get_script_property_list()
		has_seen_node3d_category = true

	var filtered_properties: Array[Dictionary] = []
	for property in all_properties:
		if property[&"name"] == "ResizableNode3D" and property[&"usage"] == PROPERTY_USAGE_CATEGORY:
			has_seen_resizable_node_3d_category = true
			continue

		if has_seen_resizable_node_3d_category:
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


func _conveyor_property_cached_set(property: StringName, value: Variant) -> void:
	if _has_instantiated:
		$PathFollowingConveyor.set(property, value)
	else:
		_cached_conveyor_property_values[property] = value

func _conveyor_property_cached_get(property: StringName) -> Variant:
	if _has_instantiated and is_instance_valid($PathFollowingConveyor):
		var value = $PathFollowingConveyor.get(property)
		if value != null:
			return value

	if property in _cached_conveyor_property_values:
		return _cached_conveyor_property_values[property]

	if _conveyor_script:
		return _conveyor_script.get_property_default_value(property)

	return null


func _side_guards_property_cached_set(property: StringName, value: Variant, existing_backing_field_value: Variant) -> Variant:
	if _has_instantiated:
		$PathFollowingSideGuards.set(property, value)
		return value
	else:
		_cached_side_guards_property_values[property] = value
		return value


func _side_guards_property_cached_get(property: StringName, backing_field_value: Variant) -> Variant:
	if _has_instantiated and is_instance_valid($PathFollowingSideGuards):
		var value: Variant = $PathFollowingSideGuards.get(property)
		if value != null:
			return value

	return backing_field_value


func _legs_property_cached_set(property: StringName, value: Variant, existing_backing_field_value: Variant) -> Variant:
	if _has_instantiated:
		%PathFollowingConveyorLegsAssembly.set(property, value)
		return value
	else:
		_cached_legs_property_values[property] = value
		return value


func _legs_property_cached_get(property: StringName, backing_field_value: Variant) -> Variant:
	if _has_instantiated and is_instance_valid(%PathFollowingConveyorLegsAssembly):
		var value: Variant = %PathFollowingConveyorLegsAssembly.get(property)
		if value != null:
			return value

	return backing_field_value

func _update_attachments() -> void:
	if not _has_instantiated or not is_inside_tree():
		return

	if not _attachment_update_needed:
		return

	# Leg positioning is handled automatically by PathFollowingConveyorLegsAssembly
	_attachment_update_needed = false


func _get_custom_preview_node() -> Node3D:
	var preview_scene := load(PREVIEW_SCENE_PATH) as PackedScene
	var preview_node = preview_scene.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED) as Node3D

	_disable_collisions_recursive(preview_node)

	var legs_assembly = preview_node.get_node_or_null("PathFollowingConveyor/PathFollowingConveyorLegsAssembly")
	if legs_assembly == null:
		legs_assembly = preview_node.get_node_or_null("%PathFollowingConveyorLegsAssembly")
	if is_instance_valid(legs_assembly):
		legs_assembly.set_meta("is_preview", true)
		legs_assembly.set_process_mode(Node.PROCESS_MODE_DISABLED)

	var side_guards = preview_node.get_node_or_null("PathFollowingSideGuards")
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
