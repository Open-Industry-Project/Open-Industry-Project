@tool
class_name BeltSpurConveyor
extends SpurConveyorAssembly

const CONVEYOR_CLASS_NAME = "BeltConveyor"
const CONVEYOR_SCRIPT_PATH = "res://src/Conveyor/belt_conveyor.gd"
const CONVEYOR_SCRIPT_FILENAME = "belt_conveyor.gd"
const PREVIEW_SCENE_PATH: String = "res://parts/BeltSpurConveyor.tscn"

var _conveyor_script: Script

# Store properties locally and forward to child conveyors
# This ensures properties persist even when child conveyors are recreated dynamically
@export_storage var _cached_properties: Dictionary = {}

# Default property values
var _default_speed: float = 2.0
var _default_belt_color: Color = Color.WHITE
var _default_belt_texture: int = 0  # BeltConveyor.ConvTexture.STANDARD
var _default_enable_comms: bool = false
var _default_speed_tag_group_name: String = ""
var _default_speed_tag_name: String = ""
var _default_running_tag_group_name: String = ""
var _default_running_tag_name: String = ""


func _init() -> void:
	super()
	# Initialize cached properties with default values
	_cached_properties[&"speed"] = _default_speed
	_cached_properties[&"belt_color"] = _default_belt_color
	_cached_properties[&"belt_texture"] = _default_belt_texture
	_cached_properties[&"enable_comms"] = _default_enable_comms
	_cached_properties[&"speed_tag_group_name"] = _default_speed_tag_group_name
	_cached_properties[&"speed_tag_name"] = _default_speed_tag_name
	_cached_properties[&"running_tag_group_name"] = _default_running_tag_group_name
	_cached_properties[&"running_tag_name"] = _default_running_tag_name


func _enter_tree() -> void:
	super._enter_tree()
	if not OIPComms.enable_comms_changed.is_connected(notify_property_list_changed):
		OIPComms.enable_comms_changed.connect(notify_property_list_changed)


func _ready() -> void:
	for child in get_children():
		remove_child(child)
		child.queue_free()


func _exit_tree() -> void:
	if OIPComms.enable_comms_changed.is_connected(notify_property_list_changed):
		OIPComms.enable_comms_changed.disconnect(notify_property_list_changed)


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
		# Link the category to a script.
		# This will make the category show the script class and icon as if we inherited from it.
		assert(CONVEYOR_SCRIPT_PATH.get_file() == CONVEYOR_SCRIPT_FILENAME, "CONVEYOR_SCRIPT_PATH doesn't match CONVEYOR_SCRIPT_FILENAME")
		property[&"hint_string"] = CONVEYOR_SCRIPT_PATH
		return
	
	# Handle communication properties forwarded from child conveyors
	elif property[&"name"] == "Communications" and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		property[&"usage"] = PROPERTY_USAGE_CATEGORY if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property[&"name"] == "enable_comms":
		property[&"usage"] = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE
	elif property[&"name"] == "speed_tag_group_name":
		# This is a storage-only property, not visible in editor
		property[&"usage"] = PROPERTY_USAGE_STORAGE
	elif property[&"name"] == "speed_tag_groups":
		# This is the visible dropdown selector for speed tag groups
		property[&"usage"] = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property[&"name"] == "speed_tag_name":
		property[&"usage"] = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE
	elif property[&"name"] == "running_tag_group_name":
		# This is a storage-only property, not visible in editor
		property[&"usage"] = PROPERTY_USAGE_STORAGE
	elif property[&"name"] == "running_tag_groups":
		# This is the visible dropdown selector for running tag groups
		property[&"usage"] = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property[&"name"] == "running_tag_name":
		property[&"usage"] = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE
	
	super._validate_property(property)


func _get_conveyor_script() -> Script:
	var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
	var class_details: Dictionary = class_list[class_list.find_custom(func (item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
	_conveyor_script = load(class_details["path"]) as Script
	return _conveyor_script


func _set_conveyor_properties(conveyor: Node) -> void:
	# Apply all cached properties to the new conveyor
	for property_name in _cached_properties:
		if conveyor.has_method("set"):
			conveyor.set(property_name, _cached_properties[property_name])


func _get_custom_preview_node() -> Node3D:
	var preview_scene := load(PREVIEW_SCENE_PATH) as PackedScene
	var preview_node = preview_scene.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED) as SpurConveyorAssembly
	
	preview_node.set_meta("is_preview", true)
	
	if preview_node.has_method("_update_conveyors"):
		preview_node._update_conveyors()
	
	_disable_collisions_recursive(preview_node)
	
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


func _set_for_all_conveyors(property: StringName, value: Variant) -> void:
	var conveyor_count := _get_internal_child_count()
	for i in range(conveyor_count):
		var conveyor: Node = get_child(i, true)
		conveyor.set(property, value)


func _set(property: StringName, value: Variant) -> bool:
	if property not in _get_conveyor_forwarded_property_names():
		return false
	_cached_properties[property] = value
	_set_for_all_conveyors(property, value)
	# Special handling for enable_comms - refresh property list when it changes
	if property == &"enable_comms":
		notify_property_list_changed()
	return true


func _get(property: StringName) -> Variant:
	if property not in _get_conveyor_forwarded_property_names():
		return null
	# Get the property from the first child conveyor if available
	var conveyor := _get_first_conveyor()
	if conveyor:
		return conveyor.get(property)
	# Fall back to cached value
	if property in _cached_properties:
		return _cached_properties[property]
	# Fall back to default values
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
	return property in _get_conveyor_forwarded_property_names()


func _property_get_revert(property: StringName) -> Variant:
	if property not in _get_conveyor_forwarded_property_names():
		return null
	if _get_internal_child_count() > 0:
		var conveyor: Node = get_child(0, true)
		if conveyor.has_method("property_can_revert") and conveyor.property_can_revert(property):
			return conveyor.property_get_revert(property)
		elif conveyor.scene_file_path:
			# Find the property's value in the PackedScene file.
			var scene := load(conveyor.scene_file_path) as PackedScene
			var scene_state := scene.get_state()
			for prop_idx in range(scene_state.get_node_property_count(0)):
				if scene_state.get_node_property_name(0, prop_idx) == property:
					return scene_state.get_node_property_value(0, prop_idx)
			# Try the script's default instead.
			return conveyor.get_script().get_property_default_value(property)
	return _conveyor_script.get_property_default_value(property)


func _get_conveyor_forwarded_properties() -> Array[Dictionary]:
	var all_properties: Array[Dictionary]
	# Skip properties until we reach the category after the "Node3D" category.
	var has_seen_node3d_category: bool = false
	var has_seen_category_after_node3d: bool = false

	if _get_internal_child_count() > 0:
		var conveyor: Node = get_child(0, true)
		all_properties = conveyor.get_property_list()
	else:
		# The conveyor instance won't exist yet, so grab from the script class instead.
		all_properties = _get_conveyor_script().get_script_property_list()
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
