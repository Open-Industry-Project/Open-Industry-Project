@tool
class_name ConveyorAssemblyBase
extends ConveyorAttachmentsAssembly

## Base for conveyor assemblies that wrap a single `%Conveyor` child. Adds
## property forwarding, preview generation, and size-change forwarding on top
## of [ConveyorAttachmentsAssembly].

var _conveyor_script: Script
var _cached_conveyor_property_values: Dictionary[StringName, Variant] = {}

var _forwarded_properties_cache: Array[Dictionary] = []
var _forwarded_property_names_cache: Array[String] = []
var _forwarded_cache_valid: bool = false
var _forwarded_cache_was_fallback: bool = false


func _init() -> void:
	super._init()
	var class_name_str: String = _get_conveyor_class_name()
	if class_name_str.is_empty():
		return
	var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
	var idx: int = class_list.find_custom(func(item: Dictionary) -> bool: return item["class"] == class_name_str)
	if idx >= 0:
		_conveyor_script = load(class_list[idx]["path"]) as Script


func _get_conveyor_class_name() -> String:
	push_error("ConveyorAssemblyBase subclass must override _get_conveyor_class_name()")
	return ""


func _get_preview_scene_path() -> String:
	push_error("ConveyorAssemblyBase subclass must override _get_preview_scene_path()")
	return ""


func _ready() -> void:
	if not %Conveyor.property_list_changed.is_connected(_on_conveyor_property_list_changed):
		%Conveyor.property_list_changed.connect(_on_conveyor_property_list_changed)

	for property: StringName in _cached_conveyor_property_values:
		var value: Variant = _cached_conveyor_property_values[property]
		%Conveyor.set(property, value)
	_cached_conveyor_property_values.clear()

	super._ready()

	if is_instance_valid(%Conveyor) and "size" in %Conveyor:
		%Conveyor.size = size

	_update_frame_rails()


func _get_forwarded_property_list() -> Array[Dictionary]:
	var filtered_properties: Array[Dictionary] = []

	# Side-guards is the last @export category, so its dynamic guard entries
	# naturally extend that section in the inspector.
	if _has_instantiated and has_node("%SideGuardsAssembly"):
		filtered_properties.append_array(%SideGuardsAssembly._get_property_list())

	var conveyor_properties := _get_conveyor_forwarded_properties()
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


func _set(property: StringName, value: Variant) -> bool:
	if super._set(property, value):
		return true
	if property not in _get_conveyor_forwarded_property_names():
		return false
	_conveyor_property_cached_set(property, value)
	return true


func _get(property: StringName) -> Variant:
	if _is_side_guard_detail_property(property):
		return super._get(property)
	if property not in _get_conveyor_forwarded_property_names():
		return null
	return _conveyor_property_cached_get(property)


func _property_can_revert(property: StringName) -> bool:
	return property in _get_conveyor_forwarded_property_names()


func _property_get_revert(property: StringName) -> Variant:
	if property not in _get_conveyor_forwarded_property_names():
		return null
	if _has_instantiated:
		if %Conveyor.property_can_revert(property):
			return %Conveyor.property_get_revert(property)
		elif %Conveyor.scene_file_path:
			var scene := load(%Conveyor.scene_file_path) as PackedScene
			var scene_state := scene.get_state()
			for prop_idx in range(scene_state.get_node_property_count(0)):
				if scene_state.get_node_property_name(0, prop_idx) == property:
					return scene_state.get_node_property_value(0, prop_idx)
			return %Conveyor.get_script().get_property_default_value(property)
	return _conveyor_script.get_property_default_value(property)


func _get_constrained_size(new_size: Vector3) -> Vector3:
	return new_size


func _on_size_changed() -> void:
	if _has_instantiated and is_instance_valid(%Conveyor) and "size" in %Conveyor:
		if _resize_handle >= 0:
			%Conveyor.resize(size, _resize_handle)
		else:
			%Conveyor.size = size
	_update_frame_rails()
	super._on_size_changed()


func _get_custom_preview_node() -> Node3D:
	var preview_scene := load(_get_preview_scene_path()) as PackedScene
	var preview_node := preview_scene.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED) as Node3D
	_apply_preview_common(preview_node)
	return preview_node


func _get_conveyor_forwarded_properties() -> Array[Dictionary]:
	_ensure_forwarded_cache()
	return _forwarded_properties_cache


func _get_conveyor_forwarded_property_names() -> Array:
	_ensure_forwarded_cache()
	return _forwarded_property_names_cache


func _ensure_forwarded_cache() -> void:
	if _forwarded_cache_valid and not (_forwarded_cache_was_fallback and _has_instantiated):
		return

	var all_properties: Array[Dictionary]
	var has_seen_node3d_category: bool = false
	var has_seen_category_after_node3d: bool = false
	var has_seen_resizable_node_3d_category: bool = false

	if _has_instantiated:
		all_properties = %Conveyor.get_property_list()
		_forwarded_cache_was_fallback = false
	else:
		# Script list skips Node/Node3D categories, so short-circuit the gate.
		all_properties = _conveyor_script.get_script_property_list()
		has_seen_node3d_category = true
		_forwarded_cache_was_fallback = true

	var filtered_properties: Array[Dictionary] = []
	var names: Array[String] = []
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

		var prop_name := property[&"name"] as String
		var usage := property[&"usage"] as int
		if prop_name in EXCLUDED_FORWARDED_PROPERTIES:
			continue
		if prop_name.begins_with("metadata/"):
			continue
		if usage & (PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP):
			continue
		if not (usage & PROPERTY_USAGE_STORAGE):
			continue
		names.append(prop_name)

	_forwarded_properties_cache = filtered_properties
	_forwarded_property_names_cache = names
	_forwarded_cache_valid = true


func _on_conveyor_property_list_changed() -> void:
	_forwarded_cache_valid = false
	notify_property_list_changed()


func _conveyor_property_cached_set(property: StringName, value: Variant) -> void:
	if _has_instantiated:
		%Conveyor.set(property, value)
	else:
		_cached_conveyor_property_values[property] = value


func _conveyor_property_cached_get(property: StringName) -> Variant:
	if _has_instantiated and is_instance_valid(%Conveyor):
		var value: Variant = %Conveyor.get(property)
		if value != null:
			return value

	if property in _cached_conveyor_property_values:
		return _cached_conveyor_property_values[property]

	if _conveyor_script:
		return _conveyor_script.get_property_default_value(property)

	return null
