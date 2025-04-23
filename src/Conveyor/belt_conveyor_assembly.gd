@tool
class_name BeltConveyorAssembly
extends EnhancedNode3D

const CONVEYOR_CLASS_NAME = "BeltConveyor"
var conveyor_script: Script
var has_instantiated := false
var cached_property_values: Dictionary = {}


func _init() -> void:
	var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
	var class_details: Dictionary = class_list[class_list.find_custom(func (item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
	conveyor_script = load(class_details["path"]) as Script


func _get_property_list() -> Array[Dictionary]:
	# Expose the conveyor's properties as our own.
	#print("_get_property_list()")
	return _get_conveyor_forwarded_properties()


func _set(property: StringName, value: Variant) -> bool:
	# Pass-through most conveyor properties.
	if property not in _get_conveyor_forwarded_property_names():
		return false
	if has_instantiated:
		%Conveyor.set(property, value)
		return true
	else:
		# The conveyor instance won't exist yet, so cache the values to apply them later.
		cached_property_values[property] = value
		return true


func _get(property: StringName) -> Variant:
	#print("_get(%s)" % property)
	# Pass-through most conveyor properties.
	if property not in _get_conveyor_forwarded_property_names():
		return null
	# Beware null values because Godot will treat them differently (godot/godotengine#86989).
	if has_instantiated:
		#print("getting property: ", property, ": ", %Conveyor.get(property))
		return %Conveyor.get(property)
	else:
		# The conveyor instance won't exist yet, so return the cached value.
		#print("getting property: ", property, ": ", cached_property_values[property])
		return cached_property_values[property]


func _property_can_revert(property: StringName) -> bool:
	#print("_property_can_revert(%s)" % property)
	return property in _get_conveyor_forwarded_property_names()


func _property_get_revert(property: StringName) -> Variant:
	#print("_property_get_revert(%s)" % property)
	if property not in _get_conveyor_forwarded_property_names():
		return null
	if has_instantiated:
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
	#print("revert for ", property, ": ", conveyor_script.get_property_default_value(property))
	return conveyor_script.get_property_default_value(property)


func _on_instantiated() -> void:
	# Copy cached values to conveyor instance, now that it's available.
	for property in cached_property_values:
		var value = cached_property_values[property]
		%Conveyor.set(property, value)
	# Clear the cache to ensure it can't haunt us later somehow.
	cached_property_values.clear()
	has_instantiated = true


func _get_conveyor_forwarded_properties() -> Array[Dictionary]:
	var all_properties: Array[Dictionary]
	# Skip properties until we reach the category after the "Node3D" category.
	var has_seen_node3d_category = false
	var has_seen_category_after_node3d = false

	if has_instantiated:
		all_properties = %Conveyor.get_property_list()
	else:
		# The conveyor instance won't exist yet, so grab from the script class instead.
		all_properties = conveyor_script.get_script_property_list()
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
