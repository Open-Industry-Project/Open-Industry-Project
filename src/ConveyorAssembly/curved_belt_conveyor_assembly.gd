@tool
class_name CurvedBeltConveyorAssembly
extends Node3D

const CONVEYOR_CLASS_NAME = "CurvedBeltConveyor"
const PREVIEW_SCENE_PATH: String = "res://parts/assemblies/CurvedBeltConveyorAssembly.tscn"

var _conveyor_script: Script
var _has_instantiated := false
var _cached_conveyor_property_values: Dictionary[StringName, Variant] = {}

# Track when attachment updates are needed to avoid unnecessary recalculations
var _attachment_update_needed: bool = true
var _last_conveyor_angle: float = 0.0
var _last_conveyor_size: Vector3 = Vector3.ZERO

func _init() -> void:
	# Note: No longer inherits from ResizableNode3D, so no size controls

	var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
	var class_details: Dictionary = class_list[class_list.find_custom(func (item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
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

	# Note: ConveyorCorner now calculates its own size automatically from radius/width

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
			_attachment_update_needed = true
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
	# Note: Size is now calculated automatically, no manual syncing needed
	_attachment_update_needed = true
	_update_attachments()

func _update_attachments() -> void:
	if not _has_instantiated or not is_inside_tree():
		return

	var conveyor = $ConveyorCorner
	var current_angle = conveyor.conveyor_angle
	var current_size = conveyor.size
	
	if not _attachment_update_needed and current_angle == _last_conveyor_angle and current_size == _last_conveyor_size:
		return
	
	var radians := deg_to_rad(current_angle)
	if current_angle <= 10.0:
		conveyor.conveyor_angle = 10.0
		radians = deg_to_rad(10.0)
		current_angle = 10.0
		
	# For curved conveyors, let the SideGuardsCBC calculate its own size based on conveyor parameters
	# instead of overriding it with a simple offset
	$SideGuardsCBC.guard_angle = current_angle
	
	# Get conveyor parameters for proper side guard sizing (now absolute values)
	#var inner_radius = conveyor.get("inner_radius") if "inner_radius" in conveyor else 0.25
	#var conveyor_width = conveyor.get("conveyor_width") if "conveyor_width" in conveyor else 1.0
	#var outer_radius = inner_radius + conveyor_width  # Now absolute, not relative to size
	#var calculated_size_x = outer_radius * 2.0 + 0.036
	
	$SideGuardsCBC.size.x =  $ConveyorCorner.size.x
	
	# Note: Leg positioning is now handled automatically by the ConveyorLegsAssembly
	# via the update_for_curved_conveyor method - no manual positioning needed
	
	_last_conveyor_angle = current_angle
	_last_conveyor_size = current_size
	_attachment_update_needed = false


func _get_custom_preview_node() -> Node3D:
	var preview_scene := load(PREVIEW_SCENE_PATH) as PackedScene
	var preview_node = preview_scene.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED) as Node3D

	_disable_collisions_recursive(preview_node)

	var legs_assembly = preview_node.get_node_or_null("ConveyorCorner/ConveyorLegsAssembly")
	if legs_assembly == null:
		legs_assembly = preview_node.get_node_or_null("%ConveyorLegsAssembly")
	if is_instance_valid(legs_assembly):
		legs_assembly.set_meta("is_preview", true)
		legs_assembly.set_process_mode(Node.PROCESS_MODE_DISABLED)

	var side_guards = preview_node.get_node_or_null("SideGuardsCBC")
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
