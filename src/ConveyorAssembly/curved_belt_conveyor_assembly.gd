@tool
class_name CurvedBeltConveyorAssembly
extends EnhancedNode3D

const CONVEYOR_CLASS_NAME = "CurvedBeltConveyor"

var _conveyor_script: Script
var _has_instantiated := false
var _cached_conveyor_property_values: Dictionary[StringName, Variant] = {}


func _init() -> void:
	var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
	var class_details: Dictionary = class_list[class_list.find_custom(func (item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
	_conveyor_script = load(class_details["path"]) as Script


func _get_property_list() -> Array[Dictionary]:
	# Expose the conveyor's properties as our own.
	return _get_conveyor_forwarded_properties()

func _set(property: StringName, value: Variant) -> bool:
	# Pass-through most conveyor properties.
	if property not in _get_conveyor_forwarded_property_names():
		return false
	_conveyor_property_cached_set(property, value)
	return true


func _get(property: StringName) -> Variant:
	# Pass-through most conveyor properties.
	if property not in _get_conveyor_forwarded_property_names():
		return null
	# Beware null values because Godot will treat them differently (godot/godotengine#86989).
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
	# Keep property list in sync with child's.
	$ConveyorCorner.property_list_changed.connect(notify_property_list_changed)

	# Copy cached values to conveyor instance, now that it's available.
	for property: StringName in _cached_conveyor_property_values:
		var value = _cached_conveyor_property_values[property]
		$ConveyorCorner.set(property, value)
	# Clear the cache to ensure it can't haunt us later somehow.
	_cached_conveyor_property_values.clear()

	# Disable caching from now on.
	_has_instantiated = true
	
	# Update legs position and rotation
	_update_legs_position()


func _get_conveyor_forwarded_properties() -> Array[Dictionary]:
	var all_properties: Array[Dictionary]
	# Skip properties until we reach the category after the "Node3D" category.
	var has_seen_node3d_category = false
	var has_seen_category_after_node3d = false

	if _has_instantiated:
		all_properties = $ConveyorCorner.get_property_list()
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
		$ConveyorCorner.set(property, value)
		if property in ["conveyor_angle", "size"]:
			_update_legs_position()
	else:
		# The instance won't exist yet, so cache the values to apply them later.
		_cached_conveyor_property_values[property] = value


## Get the property value from the Conveyor node; use a cached value if that child isn't present.
func _conveyor_property_cached_get(property: StringName) -> Variant:
	if _has_instantiated:
		return $ConveyorCorner.get(property)
	else:
		# The instance won't exist yet, so return the cached or default value.
		return _cached_conveyor_property_values[property]
func _update_legs_position() -> void:
	if not _has_instantiated:
		return

	# Check if node is in the scene tree before accessing global_transform
	if not is_inside_tree():
		return

	var conveyor = $ConveyorCorner
	var radians := deg_to_rad(conveyor.conveyor_angle)

	# Clamp the conveyor angle to prevent mesh generation issues at 0 degrees
	if conveyor.conveyor_angle <= 10.0:
		conveyor.conveyor_angle = 10.0
		radians = deg_to_rad(10.0)

	$SideGuardsCBC.guard_angle = conveyor.conveyor_angle
	$SideGuardsCBC.size.x = conveyor.size.x + 0.036

	if has_node("AutoLegsStandFront") and has_node("AutoLegsStandRear"):
		var front_legs = $AutoLegsStandFront
		var rear_legs = $AutoLegsStandRear

		var should_show_legs = conveyor.size.y <= 0.8
		front_legs.visible = should_show_legs
		rear_legs.visible = should_show_legs

		if not should_show_legs:
			return

		var size_factor = conveyor.size.x

		# Constants
		const LEGS_WORLD_Y = -2.0  # Fixed world Y position for legs
		const DEFAULT_LEG_HEIGHT = 0.75
		const HEIGHT_MULTIPLIER = 1

		# Calculate the Y position in local space to maintain world Y = LEGS_WORLD_Y
		var local_y = LEGS_WORLD_Y - global_transform.origin.y

		# Calculate positions (X and Z in local space)
		var leg_x = -sin(radians) * 0.75 * size_factor
		var leg_z = cos(radians) * 0.73 * size_factor

		# Calculate height scale based on conveyor height
		var height_scale = DEFAULT_LEG_HEIGHT + (1.0 - conveyor.size.y) * HEIGHT_MULTIPLIER

		# Position legs
		front_legs.position = Vector3(
			leg_x,
			local_y,  # Adjusted to maintain world Y position
			0.04 + leg_z
		)
		front_legs.rotation.y = -radians

		rear_legs.position = Vector3(
			-0.04,
			local_y,  # Adjusted to maintain world Y position
			0.75 * size_factor
		)
		rear_legs.rotation.y = 0

		# Base scale components
		var base_scale := Vector3(1.0, 1.0, 0.8)
		var z_scale_factor = 0.69 + (size_factor - 1.0) * 0.62

		# Apply scales
		front_legs.scale = Vector3(base_scale.x, height_scale, base_scale.z * z_scale_factor)
		rear_legs.scale = Vector3(base_scale.x, height_scale, base_scale.z * z_scale_factor)
