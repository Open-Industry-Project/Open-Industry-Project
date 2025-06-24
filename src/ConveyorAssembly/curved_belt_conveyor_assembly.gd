@tool
class_name CurvedBeltConveyorAssembly
extends ResizableNode3D

const CONVEYOR_CLASS_NAME = "CurvedBeltConveyor"

var _conveyor_script: Script
var _has_instantiated := false
var _cached_conveyor_property_values: Dictionary[StringName, Variant] = {}


func _init() -> void:
	var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
	var class_details: Dictionary = class_list[class_list.find_custom(func (item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
	_conveyor_script = load(class_details["path"]) as Script

	# Set default size for curved belt conveyor assemblies
	size_default = Vector3(1.524, 0.5, 1.524)

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
	return _get_conveyor_forwarded_properties()

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
			# Find the property's value in the PackedScene file.
			var scene := load($ConveyorCorner.scene_file_path) as PackedScene
			var scene_state := scene.get_state()
			for prop_idx in range(scene_state.get_node_property_count(0)):
				if scene_state.get_node_property_name(0, prop_idx) == property:
					return scene_state.get_node_property_value(0, prop_idx)
			# Try the script's default instead.
			return $ConveyorCorner.get_script().get_property_default_value(property)
	return _conveyor_script.get_property_default_value(property)


func _on_instantiated() -> void:
	if not $ConveyorCorner.property_list_changed.is_connected(notify_property_list_changed):
		$ConveyorCorner.property_list_changed.connect(notify_property_list_changed)

	for property: StringName in _cached_conveyor_property_values:
		var value = _cached_conveyor_property_values[property]
		$ConveyorCorner.set(property, value)
	_cached_conveyor_property_values.clear()

	_has_instantiated = true
	_update_attachments()


func _get_conveyor_forwarded_properties() -> Array[Dictionary]:
	var all_properties: Array[Dictionary]
	var has_seen_node3d_category = false
	var has_seen_category_after_node3d = false

	if _has_instantiated:
		all_properties = $ConveyorCorner.get_property_list()
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
	if _has_instantiated:
		return $ConveyorCorner.get(property)
	else:
		return _cached_conveyor_property_values[property]

func _on_size_changed() -> void:
	if _has_instantiated and is_instance_valid($ConveyorCorner):
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
