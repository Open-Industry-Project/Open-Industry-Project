@tool
class_name BeltConveyorAssembly
extends EnhancedNode3D

const CONVEYOR_CLASS_NAME = "BeltConveyor"
const SIDE_GUARDS_SCRIPT_PATH = "res://src/ConveyorAttachment/side_guards_assembly.gd"
const SIDE_GUARDS_SCRIPT_FILENAME = "side_guards_assembly.gd"
const CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH = "res://src/ConveyorAttachment/conveyor_legs_assembly.gd"
const CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME = "conveyor_legs_assembly.gd"

#region SideGuardsAssembly properties
@export_category(SIDE_GUARDS_SCRIPT_FILENAME)
@export_group("Side Guards", "sideguards")
@export var sideguards_right_side: bool = true:
	get:
		if _has_instantiated:
			return %SideGuardsAssembly.right_side
		else:
			return sideguards_right_side
	set(value):
		if _has_instantiated:
			%SideGuardsAssembly.right_side = value
		else:
			sideguards_right_side = value
@export var sideguards_right_side_openings: Array[SideGuardOpening] = []:
	get:
		if _has_instantiated:
			return %SideGuardsAssembly.right_side_openings
		else:
			return sideguards_right_side_openings
	set(value):
		if _has_instantiated:
			%SideGuardsAssembly.right_side_openings = value
		else:
			sideguards_right_side_openings = value
@export var sideguards_left_side: bool = true:
	get:
		if _has_instantiated:
			return %SideGuardsAssembly.left_side
		else:
			return sideguards_left_side
	set(value):
		if _has_instantiated:
			%SideGuardsAssembly.left_side = value
		else:
			sideguards_left_side = value
@export var sideguards_left_side_openings: Array[SideGuardOpening] = []:
	get:
		if _has_instantiated:
			return %SideGuardsAssembly.left_side_openings
		else:
			return sideguards_left_side_openings
	set(value):
		if _has_instantiated:
			%SideGuardsAssembly.left_side_openings = value
		else:
			sideguards_left_side_openings = value
#endregion

#region ConveyorLegsAssembly properties
@export_category(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME)
@export_group("Conveyor Legs", "")
@export_custom(PROPERTY_HINT_NONE, "suffix:m")
var floor_plane: Plane = preload(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH).DEFAULT_FLOOR_PLANE:
	get:
		if _has_instantiated:
			return %ConveyorLegsAssembly.floor_plane
		else:
			return floor_plane
	set(value):
		if _has_instantiated:
			%ConveyorLegsAssembly.floor_plane = value
		else:
			floor_plane = value
var global_floor_plane: Plane = preload(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH).DEFAULT_FLOOR_PLANE:
	get:
		if _has_instantiated:
			return %ConveyorLegsAssembly.global_floor_plane
		else:
			return global_floor_plane
	set(value):
		if _has_instantiated:
			%ConveyorLegsAssembly.global_floor_plane = value
		else:
			global_floor_plane = value
@export_storage
var local_floor_plane: Plane = preload(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH).DEFAULT_FLOOR_PLANE:
	get:
		if _has_instantiated:
			return %ConveyorLegsAssembly.local_floor_plane
		else:
			return local_floor_plane
	set(value):
		if _has_instantiated:
			%ConveyorLegsAssembly.local_floor_plane = value
		else:
			local_floor_plane = value


@export_subgroup("Middle Legs", "middle_legs")
@export
var middle_legs_enabled := false:
	get:
		if _has_instantiated:
			return %ConveyorLegsAssembly.middle_legs_enabled
		else:
			return middle_legs_enabled
	set(value):
		if _has_instantiated:
			%ConveyorLegsAssembly.middle_legs_enabled = value
		else:
			middle_legs_enabled = value
@export_range(-5, 5, 0.01, "or_less", "or_greater", "suffix:m")
var middle_legs_initial_leg_position: float:
	get:
		if _has_instantiated:
			return %ConveyorLegsAssembly.middle_legs_initial_leg_position
		else:
			return middle_legs_initial_leg_position
	set(value):
		if _has_instantiated:
			%ConveyorLegsAssembly.middle_legs_initial_leg_position = value
		else:
			middle_legs_initial_leg_position = value
@export_range(preload(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH).MIDDLE_LEGS_SPACING_MIN, 5, 0.01, "or_greater", "suffix:m")
var middle_legs_spacing: float = 2:
	get:
		if _has_instantiated:
			return %ConveyorLegsAssembly.middle_legs_spacing
		else:
			return middle_legs_spacing
	set(value):
		if _has_instantiated:
			%ConveyorLegsAssembly.middle_legs_spacing = value
		else:
			middle_legs_spacing = value


@export_subgroup("Head End", "head_end")
@export_range(0, 1, 0.01, "or_greater", "suffix:m")
var head_end_attachment_offset: float = 0.45:
	get:
		if _has_instantiated:
			return %ConveyorLegsAssembly.head_end_attachment_offset
		else:
			return head_end_attachment_offset
	set(value):
		if _has_instantiated:
			%ConveyorLegsAssembly.head_end_attachment_offset = value
		else:
			head_end_attachment_offset = value
@export
var head_end_leg_enabled: bool = true:
	get:
		if _has_instantiated:
			return %ConveyorLegsAssembly.head_end_leg_enabled
		else:
			return head_end_leg_enabled
	set(value):
		if _has_instantiated:
			%ConveyorLegsAssembly.head_end_leg_enabled = value
		else:
			head_end_leg_enabled = value
@export_range(0.5, 5, 0.01, "or_greater", "suffix:m")
var head_end_leg_clearance: float = 0.5:
	get:
		if _has_instantiated:
			return %ConveyorLegsAssembly.head_end_leg_clearance
		else:
			return head_end_leg_clearance
	set(value):
		if _has_instantiated:
			%ConveyorLegsAssembly.head_end_leg_clearance = value
		else:
			head_end_leg_clearance = value


@export_subgroup("Tail End", "tail_end")
@export_range(0, 1, 0.01, "or_greater", "suffix:m")
var tail_end_attachment_offset: float = 0.45:
	get:
		if _has_instantiated:
			return %ConveyorLegsAssembly.tail_end_attachment_offset
		else:
			return tail_end_attachment_offset
	set(value):
		if _has_instantiated:
			%ConveyorLegsAssembly.tail_end_attachment_offset = value
		else:
			tail_end_attachment_offset = value
@export
var tail_end_leg_enabled: bool = true:
	get:
		if _has_instantiated:
			return %ConveyorLegsAssembly.tail_end_leg_enabled
		else:
			return tail_end_leg_enabled
	set(value):
		if _has_instantiated:
			%ConveyorLegsAssembly.tail_end_leg_enabled = value
		else:
			tail_end_leg_enabled = value
@export_range(0.5, 5, 0.01, "or_greater", "suffix:m")
var tail_end_leg_clearance: float = 0.5:
	get:
		if _has_instantiated:
			return %ConveyorLegsAssembly.tail_end_leg_clearance
		else:
			return tail_end_leg_clearance
	set(value):
		if _has_instantiated:
			%ConveyorLegsAssembly.tail_end_leg_clearance = value
		else:
			tail_end_leg_clearance = value


@export_subgroup("Model", "leg_model")
@export
var leg_model_scene: PackedScene = preload("res://parts/ConveyorLegBC.tscn"):
	get:
		if _has_instantiated:
			return %ConveyorLegsAssembly.leg_model_scene
		else:
			return leg_model_scene
	set(value):
		if _has_instantiated:
			%ConveyorLegsAssembly.leg_model_scene = value
		else:
			leg_model_scene = value
@export
var leg_model_grabs_offset: float = 0.132:
	get:
		if _has_instantiated:
			return %ConveyorLegsAssembly.leg_model_grabs_offset
		else:
			return leg_model_grabs_offset
	set(value):
		if _has_instantiated:
			%ConveyorLegsAssembly.leg_model_grabs_offset = value
		else:
			leg_model_grabs_offset = value
#endregion


var _conveyor_script: Script
var _has_instantiated := false
var _cached_property_values: Dictionary = {}


func _init() -> void:
	var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
	var class_details: Dictionary = class_list[class_list.find_custom(func (item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
	_conveyor_script = load(class_details["path"]) as Script


func _get_property_list() -> Array[Dictionary]:
	# Expose the conveyor's properties as our own.
	#print("_get_property_list()")
	return _get_conveyor_forwarded_properties()


func _validate_property(property: Dictionary) -> void:
	#print("_validate_property(%s)" % property)
	if property[&"name"] == SIDE_GUARDS_SCRIPT_FILENAME \
			&& property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		# Link the category to a script.
		# This will make the category show the script class and icon as if we inherited from it.
		assert(SIDE_GUARDS_SCRIPT_PATH.get_file() == SIDE_GUARDS_SCRIPT_FILENAME, "SIDE_GUARDS_SCRIPT_PATH doesn't match SIDE_GUARDS_SCRIPT_FILENAME")
		property[&"hint_string"] = SIDE_GUARDS_SCRIPT_PATH
	elif property[&"name"] == CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME \
			&& property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		# Link the category to a script.
		# This will make the category show the script class and icon as if we inherited from it.
		assert(CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH.get_file() == CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME, "CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH doesn't match CONVEYOR_LEGS_ASSEMBLY_SCRIPT_FILENAME")
		property[&"hint_string"] = CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH


func _set(property: StringName, value: Variant) -> bool:
	# Pass-through most conveyor properties.
	if property not in _get_conveyor_forwarded_property_names():
		return false
	if _has_instantiated:
		%Conveyor.set(property, value)
		return true
	else:
		# The conveyor instance won't exist yet, so cache the values to apply them later.
		_cached_property_values[property] = value
		return true


func _get(property: StringName) -> Variant:
	#print("_get(%s)" % property)
	# Pass-through most conveyor properties.
	if property not in _get_conveyor_forwarded_property_names():
		return null
	# Beware null values because Godot will treat them differently (godot/godotengine#86989).
	if _has_instantiated:
		#print("getting property: ", property, ": ", %Conveyor.get(property))
		return %Conveyor.get(property)
	else:
		# The conveyor instance won't exist yet, so return the cached value.
		#print("getting property: ", property, ": ", _cached_property_values[property])
		return _cached_property_values[property]


func _property_can_revert(property: StringName) -> bool:
	#print("_property_can_revert(%s)" % property)
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


func _on_instantiated() -> void:
	# Keep property list in sync with child's.
	%Conveyor.property_list_changed.connect(notify_property_list_changed)

	# Copy cached values to conveyor instance, now that it's available.
	# Godot actually calls the setters for us an extra time, so this step isn't actually needed right now.
	# But it's here just in case that changes.
	for property in _cached_property_values:
		var value = _cached_property_values[property]
		%Conveyor.set(property, value)
	# Clear the cache to ensure it can't haunt us later somehow.
	_cached_property_values.clear()
	_has_instantiated = true


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
				return (not (usage & PROPERTY_USAGE_CATEGORY
					or usage & PROPERTY_USAGE_GROUP
					or usage & PROPERTY_USAGE_SUBGROUP)
					and usage & PROPERTY_USAGE_STORAGE
					and not prop_name.begins_with("metadata/")))
			.map(func(property): return property[&"name"] as String))
	return result
