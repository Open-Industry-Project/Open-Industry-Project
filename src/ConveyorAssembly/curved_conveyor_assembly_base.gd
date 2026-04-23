@tool
class_name CurvedConveyorAssemblyBase
extends Node3D

## Base for curved conveyor assemblies. Wraps a `$ConveyorCorner` child + a
## `$SideGuardsCBC` side-guards node + a `%ConveyorLegsAssembly` attachment.
## Owns property forwarding to the corner conveyor, legs caching, and the
## attachment-update lifecycle driven by transform + angle/size changes.

const CONVEYOR_LEGS_ASSEMBLY_SCRIPT_PATH: String = "res://src/ConveyorAttachment/conveyor_legs_assembly.gd"

var _conveyor_script: Script
var _has_instantiated: bool = false
var _cached_conveyor_property_values: Dictionary[StringName, Variant] = {}
var _cached_legs_property_values: Dictionary[StringName, Variant] = {}

var _attachment_update_needed: bool = true
var _last_conveyor_angle: float = 0.0
var _last_conveyor_size: Vector3 = Vector3.ZERO


func _init() -> void:
	var class_name_str := _get_conveyor_class_name()
	if not class_name_str.is_empty():
		var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
		var idx := class_list.find_custom(func(item: Dictionary) -> bool: return item["class"] == class_name_str)
		if idx >= 0:
			_conveyor_script = load(class_list[idx]["path"]) as Script
	set_notify_transform(true)


func _get_conveyor_class_name() -> String:
	push_error("CurvedConveyorAssemblyBase subclass must override _get_conveyor_class_name()")
	return ""


func _get_preview_scene_path() -> String:
	push_error("CurvedConveyorAssemblyBase subclass must override _get_preview_scene_path()")
	return ""


func _get_attachment_trigger_properties() -> Array[StringName]:
	return [&"conveyor_angle", &"size"]


func _get_corner_belt_height(corner: Node) -> float:
	return corner.size.y


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
		$ConveyorCorner.set(property, _cached_conveyor_property_values[property])
	_cached_conveyor_property_values.clear()

	if not %ConveyorLegsAssembly.property_list_changed.is_connected(notify_property_list_changed):
		%ConveyorLegsAssembly.property_list_changed.connect(notify_property_list_changed)
	for property: StringName in _cached_legs_property_values:
		%ConveyorLegsAssembly.set(property, _cached_legs_property_values[property])
	_cached_legs_property_values.clear()

	_has_instantiated = true
	_update_attachments()


func _get_property_list() -> Array[Dictionary]:
	var filtered_properties: Array[Dictionary] = []
	var found_categories: Array = []
	for prop in _get_conveyor_forwarded_properties():
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


func _set(property: StringName, value: Variant) -> bool:
	# Size is computed by the corner from radius + width; don't forward it.
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
	var has_seen_resizable_node_3d_category := false

	if _has_instantiated:
		all_properties = $ConveyorCorner.get_property_list()
	else:
		# %Conveyor doesn't exist yet; fall back to the script's property list,
		# which skips the built-in Node/Node3D categories entirely.
		all_properties = _conveyor_script.get_script_property_list()
		has_seen_node3d_category = true

	var filtered_properties: Array[Dictionary] = []
	for property in all_properties:
		# Drop ResizableNode3D's properties — we inherit them already.
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
	return (_get_conveyor_forwarded_properties()
			.filter(func(property: Dictionary) -> bool:
				var prop_name := property[&"name"] as String
				var usage := property[&"usage"] as int
				if prop_name in ConveyorAttachmentsAssembly.EXCLUDED_FORWARDED_PROPERTIES:
					return false
				if prop_name.begins_with("metadata/hijack_scale"):
					return false
				return (not (usage & PROPERTY_USAGE_CATEGORY
					or usage & PROPERTY_USAGE_GROUP
					or usage & PROPERTY_USAGE_SUBGROUP)
					and usage & PROPERTY_USAGE_STORAGE
					and not prop_name.begins_with("metadata/")))
			.map(func(property: Dictionary) -> String: return property[&"name"] as String))


func _legs_property_cached_set(property: StringName, value: Variant, _existing_backing_field_value: Variant) -> Variant:
	if _has_instantiated:
		%ConveyorLegsAssembly.set(property, value)
	else:
		_cached_legs_property_values[property] = value
	return value


func _legs_property_cached_get(property: StringName, backing_field_value: Variant) -> Variant:
	if _has_instantiated and is_instance_valid(%ConveyorLegsAssembly):
		var value: Variant = %ConveyorLegsAssembly.get(property)
		if value != null:
			return value
	return backing_field_value


func _conveyor_property_cached_set(property: StringName, value: Variant) -> void:
	if _has_instantiated:
		$ConveyorCorner.set(property, value)
		if property in _get_attachment_trigger_properties():
			_attachment_update_needed = true
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


func _on_size_changed() -> void:
	_attachment_update_needed = true
	_update_attachments()


func _update_attachments() -> void:
	if not _has_instantiated or not is_inside_tree():
		return

	var conveyor := $ConveyorCorner
	var current_angle: float = conveyor.conveyor_angle
	var current_size: Vector3 = conveyor.size
	if not _attachment_update_needed and current_angle == _last_conveyor_angle and current_size == _last_conveyor_size:
		return

	# Curved conveyors below 10° produce degenerate geometry; clamp.
	if current_angle <= 10.0:
		conveyor.conveyor_angle = 10.0
		current_angle = 10.0

	$SideGuardsCBC.update_for_curved_conveyor(
		conveyor.inner_radius, conveyor.conveyor_width, current_size, current_angle
	)

	_last_conveyor_angle = current_angle
	_last_conveyor_size = current_size
	_attachment_update_needed = false


func _get_custom_preview_node() -> Node3D:
	var preview_scene := load(_get_preview_scene_path()) as PackedScene
	var preview_node := preview_scene.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED) as Node3D

	_disable_collisions_recursive(preview_node)

	var legs_assembly := preview_node.get_node_or_null("ConveyorCorner/ConveyorLegsAssembly")
	if legs_assembly == null:
		legs_assembly = preview_node.get_node_or_null("%ConveyorLegsAssembly")
	if is_instance_valid(legs_assembly):
		legs_assembly.set_meta("is_preview", true)
		legs_assembly.set_process_mode(Node.PROCESS_MODE_DISABLED)

	var side_guards := preview_node.get_node_or_null("SideGuardsCBC")
	if is_instance_valid(side_guards):
		side_guards.set_meta("is_preview", true)
		side_guards.set_process_mode(Node.PROCESS_MODE_DISABLED)

	var corner := preview_node.get_node("ConveyorCorner")
	preview_node.add_child(FlowDirectionArrow.create_curved(
		corner.inner_radius, corner.conveyor_width, _get_corner_belt_height(corner), corner.conveyor_angle))

	return preview_node


func _disable_collisions_recursive(node: Node) -> void:
	if node is CollisionShape3D:
		node.disabled = true
	if node is CollisionObject3D:
		node.collision_layer = 0
		node.collision_mask = 0
	for child in node.get_children():
		_disable_collisions_recursive(child)
