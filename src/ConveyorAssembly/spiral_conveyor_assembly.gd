@tool
class_name SpiralConveyorAssembly
extends Node3D

const CONVEYOR_CLASS_NAME = "SpiralConveyor"
const PREVIEW_SCENE_PATH: String = "res://parts/assemblies/SpiralConveyorAssembly.tscn"

static var _conveyor_script_cached: Script

var _conveyor_script: Script
var _has_instantiated := false
var _cached_conveyor_property_values: Dictionary[StringName, Variant] = {}


func _init() -> void:
	if _conveyor_script_cached == null:
		var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
		var class_details: Dictionary = class_list[class_list.find_custom(func (item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
		_conveyor_script_cached = load(class_details["path"]) as Script
	_conveyor_script = _conveyor_script_cached


func _ready() -> void:
	if not $ConveyorCorner.property_list_changed.is_connected(notify_property_list_changed):
		$ConveyorCorner.property_list_changed.connect(notify_property_list_changed)

	for property: StringName in _cached_conveyor_property_values:
		var value = _cached_conveyor_property_values[property]
		$ConveyorCorner.set(property, value)
	_cached_conveyor_property_values.clear()

	_has_instantiated = true


#region Property Forwarding

func _get_property_list() -> Array[Dictionary]:
	var conveyor_properties := _get_conveyor_forwarded_properties()
	var filtered: Array[Dictionary] = []
	var found_categories: Array = []

	for prop in conveyor_properties:
		var prop_name: String = prop[&"name"]
		var usage: int = prop[&"usage"]

		if usage & PROPERTY_USAGE_CATEGORY:
			if prop_name == "ResizableNode3D" or prop_name in found_categories:
				continue
			found_categories.append(prop_name)

		if prop_name in ["size", "hijack_scale"] or prop_name.begins_with("metadata/hijack_scale"):
			continue

		filtered.append(prop)

	return filtered


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
		if $ConveyorCorner.property_can_revert(property):
			return $ConveyorCorner.property_get_revert(property)
		elif $ConveyorCorner.scene_file_path:
			var scene := load($ConveyorCorner.scene_file_path) as PackedScene
			var scene_state := scene.get_state()
			for prop_idx in range(scene_state.get_node_property_count(0)):
				if scene_state.get_node_property_name(0, prop_idx) == property:
					return scene_state.get_node_property_value(0, prop_idx)
			return $ConveyorCorner.get_script().get_property_default_value(property)
	return _conveyor_script.get_property_default_value(property)


func _get_conveyor_forwarded_properties() -> Array[Dictionary]:
	var all_properties: Array[Dictionary]
	var has_seen_node3d_category := false
	var has_seen_category_after_node3d := false

	if _has_instantiated:
		all_properties = $ConveyorCorner.get_property_list()
	else:
		all_properties = _conveyor_script.get_script_property_list()
		has_seen_node3d_category = true

	var filtered: Array[Dictionary] = []
	for property in all_properties:
		if not has_seen_node3d_category:
			has_seen_node3d_category = (property[&"name"] == "Node3D"
					and property[&"usage"] == PROPERTY_USAGE_CATEGORY)
			continue
		if not has_seen_category_after_node3d:
			has_seen_category_after_node3d = property[&"usage"] == PROPERTY_USAGE_CATEGORY
		if not has_seen_category_after_node3d:
			continue
		filtered.append(property)
	return filtered


func _get_conveyor_forwarded_property_names() -> Array:
	return (_get_conveyor_forwarded_properties()
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


func _conveyor_property_cached_set(property: StringName, value: Variant) -> void:
	if _has_instantiated:
		$ConveyorCorner.set(property, value)
	else:
		_cached_conveyor_property_values[property] = value


func _conveyor_property_cached_get(property: StringName) -> Variant:
	if _has_instantiated and is_instance_valid($ConveyorCorner):
		var value = $ConveyorCorner.get(property)
		if value != null:
			return value

	if property in _cached_conveyor_property_values:
		return _cached_conveyor_property_values[property]

	if _conveyor_script:
		return _conveyor_script.get_property_default_value(property)

	return null

#endregion


func _get_custom_preview_node() -> Node3D:
	var preview_scene := load(PREVIEW_SCENE_PATH) as PackedScene
	var preview_node = preview_scene.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED) as Node3D

	_disable_collisions_recursive(preview_node)
	return preview_node


func _disable_collisions_recursive(node: Node) -> void:
	if node is CollisionShape3D:
		node.disabled = true
	if node is CollisionObject3D:
		node.collision_layer = 0
		node.collision_mask = 0
	for child in node.get_children():
		_disable_collisions_recursive(child)
