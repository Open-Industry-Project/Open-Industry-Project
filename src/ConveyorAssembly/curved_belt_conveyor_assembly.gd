@tool
class_name CurvedBeltConveyorAssembly
extends ResizableNode3D

const CONVEYOR_CLASS_NAME = "CurvedBeltConveyor"

var _conveyor_script: Script
var _has_instantiated := false
var _cached_conveyor_property_values: Dictionary[StringName, Variant] = {}


func _init() -> void:
	# Set default size for curved belt conveyor assemblies BEFORE calling super._init()
	size_default = Vector3(1.524, 0.5, 1.524)

	super._init()

	var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
	var class_details: Dictionary = class_list[class_list.find_custom(func (item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
	_conveyor_script = load(class_details["path"]) as Script

	# Enable transform notifications
	set_notify_transform(true)


func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSFORM_CHANGED:
		if _has_instantiated and is_inside_tree():
			_update_attachments()
	elif what == NOTIFICATION_ENTER_TREE:
		if _has_instantiated:
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

func _set(property: StringName, value: Variant) -> bool:
	# Allow size property to be handled by ResizableNode3D
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
			# Find the property's value in the PackedScene file.
			var scene := load($ConveyorCorner.scene_file_path) as PackedScene
			var scene_state := scene.get_state()
			for prop_idx in range(scene_state.get_node_property_count(0)):
				if scene_state.get_node_property_name(0, prop_idx) == property:
					return scene_state.get_node_property_value(0, prop_idx)
			# Try the script's default instead.
			return $ConveyorCorner.get_script().get_property_default_value(property)
	return _conveyor_script.get_property_default_value(property)


func _ready() -> void:
	if not $ConveyorCorner.property_list_changed.is_connected(notify_property_list_changed):
		$ConveyorCorner.property_list_changed.connect(notify_property_list_changed)

	for property: StringName in _cached_conveyor_property_values:
		var value = _cached_conveyor_property_values[property]
		$ConveyorCorner.set(property, value)
	_cached_conveyor_property_values.clear()

	_has_instantiated = true

	# Sync the assembly's size to the ConveyorCorner
	if is_instance_valid($ConveyorCorner) and "size" in $ConveyorCorner:
		$ConveyorCorner.size = size

	_update_attachments()


func _get_conveyor_forwarded_properties() -> Array[Dictionary]:
	var all_properties: Array[Dictionary]
	# Skip properties until we reach the category after the "Node3D" category.
	var has_seen_node3d_category = false
	var has_seen_category_after_node3d = false
	# Avoid duplicating ResizableNode3D properties
	var has_seen_resizable_node_3d_category = false

	if _has_instantiated:
		all_properties = $ConveyorCorner.get_property_list()
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


func _conveyor_property_cached_set(property: StringName, value: Variant) -> void:
	if _has_instantiated:
		$ConveyorCorner.set(property, value)
		if property in ["conveyor_angle", "size"]:
			_update_attachments()
	else:
		_cached_conveyor_property_values[property] = value

func _conveyor_property_cached_get(property: StringName) -> Variant:
	if _has_instantiated and is_instance_valid($ConveyorCorner):
		var value = $ConveyorCorner.get(property)
		if value != null:
			return value

	# Return cached value or look up default from cache
	if property in _cached_conveyor_property_values:
		return _cached_conveyor_property_values[property]

	# Return script default as final fallback
	if _conveyor_script:
		return _conveyor_script.get_property_default_value(property)

	return null

func _on_size_changed() -> void:
	if _has_instantiated and is_instance_valid($ConveyorCorner) and "size" in $ConveyorCorner:
		$ConveyorCorner.size = size
	_update_attachments()

func _update_attachments() -> void:
	if not _has_instantiated or not is_inside_tree():
		return

	var conveyor = $ConveyorCorner
	var radians := deg_to_rad(conveyor.conveyor_angle)
	if conveyor.conveyor_angle <= 10.0:
		conveyor.conveyor_angle = 10.0
		radians = deg_to_rad(10.0)
	$SideGuardsCBC.guard_angle = conveyor.conveyor_angle
	$SideGuardsCBC.size.x = conveyor.size.x + 0.036

	var front_legs = $ConveyorCorner/ConveyorLegsAssembly/ConveyorLegTail
	var rear_legs = $ConveyorCorner/ConveyorLegsAssembly/ConveyorLegHead
	var size_factor = conveyor.size.x
	var leg_x = -sin(radians) * 0.75 * size_factor
	var leg_z = cos(radians) * 0.73 * size_factor

	front_legs.position.x = leg_x
	front_legs.position.z = 0.04 + leg_z
	front_legs.rotation.y = -radians

	rear_legs.position.x = -0.04
	rear_legs.position.z = 0.75 * size_factor
	rear_legs.rotation.y = 0
