@tool
class_name CurvedRollerConveyorAssembly
extends ResizableNode3D

const CONVEYOR_CLASS_NAME = "CurvedRollerConveyor"
const PREVIEW_SCENE_PATH: String = "res://parts/assemblies/CurvedRollerConveyorAssembly.tscn"

var _conveyor_script: Script
var _has_instantiated: bool = false
var _cached_conveyor_property_values: Dictionary[StringName, Variant] = {}

# Track when attachment updates are needed to avoid unnecessary recalculations
var _attachment_update_needed: bool = true
var _last_conveyor_angle: float = 0.0
var _last_conveyor_size: Vector3 = Vector3.ZERO


func _init() -> void:
	size_default = Vector3(1.524, 0.5, 1.524)
	super._init()

	var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
	var class_details: Dictionary = class_list[class_list.find_custom(func (item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
	_conveyor_script = load(class_details["path"]) as Script

	set_notify_transform(true)


func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSFORM_CHANGED:
		if _has_instantiated and is_inside_tree() and _attachment_update_needed:
			_update_attachments()
	elif what == NOTIFICATION_ENTER_TREE:
		if _has_instantiated:
			_attachment_update_needed = true
			_update_attachments()


func _ready() -> void:
	if not $ConveyorCorner.property_list_changed.is_connected(notify_property_list_changed):
		$ConveyorCorner.property_list_changed.connect(notify_property_list_changed)

	for property: StringName in _cached_conveyor_property_values:
		var value: Variant = _cached_conveyor_property_values[property]
		$ConveyorCorner.set(property, value)
	_cached_conveyor_property_values.clear()

	_has_instantiated = true

	if is_instance_valid($ConveyorCorner):
		# Sync assembly size with conveyor's conveyor_width if it exists
		if "conveyor_width" in $ConveyorCorner:
			var conveyor_width_value = $ConveyorCorner.conveyor_width
			if conveyor_width_value > 0.0:
				size = Vector3(conveyor_width_value, size.y, size.z)
		
		# Ensure the conveyor's size matches the assembly
		if "size" in $ConveyorCorner:
			$ConveyorCorner.size = size

	_update_attachments()


func _validate_property(property: Dictionary) -> void:
	if property.name == "size":
		property.usage = PROPERTY_USAGE_NONE  # Hide the size property

func _get_property_list() -> Array[Dictionary]:
	var conveyor_properties := _get_conveyor_forwarded_properties()
	var filtered_properties: Array[Dictionary] = []
	var found_categories: Array = []

	for prop in conveyor_properties:
		var prop_name: String = prop[&"name"] as String
		var usage: int = prop[&"usage"] as int

		if usage & PROPERTY_USAGE_CATEGORY:
			if prop_name == "ResizableNode3D" or prop_name in found_categories:
				continue
			found_categories.append(prop_name)

		if prop_name == "size" or prop_name == "hijack_scale" or prop_name.begins_with("metadata/hijack_scale"):
			continue

		filtered_properties.append(prop)

	return filtered_properties


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
	var has_seen_node3d_category: bool = false
	var has_seen_category_after_node3d: bool = false
	var has_seen_resizable_node_3d_category: bool = false

	if _has_instantiated:
		all_properties = $ConveyorCorner.get_property_list()
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
		$ConveyorCorner.set(property, value)
		if property == "conveyor_width" and value is float and value > 0.0:
			size = Vector3(value, size.y, size.z)
		if property in ["conveyor_width", "conveyor_angle", "size"]:
			_attachment_update_needed = true
			call_deferred("_notify_legs_assembly_of_changes")
			_update_attachments()
	else:
		_cached_conveyor_property_values[property] = value


func _conveyor_property_cached_get(property: StringName) -> Variant:
	if _has_instantiated and is_instance_valid($ConveyorCorner):
		var value: Variant = $ConveyorCorner.get(property)
		if value != null:
			return value

	if property in _cached_conveyor_property_values:
		return _cached_conveyor_property_values[property]

	if _conveyor_script:
		return _conveyor_script.get_property_default_value(property)

	return null


func _update_attachments() -> void:
	if not _has_instantiated:
		return
	if not is_inside_tree():
		return

	var conveyor := $ConveyorCorner
	var current_angle = conveyor.conveyor_angle
	var current_size = conveyor.size
	
	if not _attachment_update_needed and current_angle == _last_conveyor_angle and current_size == _last_conveyor_size:
		return
	
	var radians := deg_to_rad(current_angle)
	if current_angle <= 10.0:
		conveyor.conveyor_angle = 10.0
		radians = deg_to_rad(10.0)
		current_angle = 10.0
		
	# Update side guards with proper radius parameters
	_update_side_guards_for_curved_conveyor(conveyor, current_angle, current_size)

	# ConveyorLegsAssembly handles its own positioning via _notify_legs_assembly_of_changes()
	# when conveyor_angle or size properties change
	
	_last_conveyor_angle = current_angle
	_last_conveyor_size = current_size
	_attachment_update_needed = false

func _update_side_guards_for_curved_conveyor(conveyor: Node, angle: float, conveyor_size: Vector3) -> void:
	var side_guards = $SideGuardsCBC
	if not side_guards or not side_guards.has_method("update_for_curved_conveyor"):
		# Fallback to old method if update_for_curved_conveyor doesn't exist
		side_guards.guard_angle = angle
		side_guards.size.x = conveyor_size.x + 0.036
		return
	
	# Get radius parameters from the curved roller conveyor
	var inner_radius: float = 0.25  # Default fallback
	var conveyor_width: float = 1.0  # Default fallback
	
	if "inner_radius" in conveyor and "conveyor_width" in conveyor:
		inner_radius = conveyor.inner_radius
		conveyor_width = conveyor.conveyor_width
	else:
		# Calculate from size if direct radius properties not available
		var diameter = conveyor_size.x
		var outer_radius = diameter / 2.0
		conveyor_width = 1.0  # Use default conveyor width
		inner_radius = outer_radius - conveyor_width
	
	# Update side guards using proper radius-based method
	side_guards.update_for_curved_conveyor(inner_radius, conveyor_width, conveyor_size, angle)

func _on_size_changed() -> void:
	if _has_instantiated and is_instance_valid($ConveyorCorner) and "size" in $ConveyorCorner:
		$ConveyorCorner.size = size


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
	
	_attachment_update_needed = true
	# Notify legs assembly since size affects leg positioning
	call_deferred("_notify_legs_assembly_of_changes")
	_update_attachments()


## Helper method to safely notify the legs assembly of property changes
func _notify_legs_assembly_of_changes() -> void:
	if not _has_instantiated or not is_inside_tree():
		return
		
	var legs_assembly = $ConveyorCorner.get_node_or_null("ConveyorLegsAssembly")
	if legs_assembly and legs_assembly.has_method("_on_conveyor_size_changed"):
		# Force the legs assembly to update when conveyor properties change
		legs_assembly._on_conveyor_size_changed()
