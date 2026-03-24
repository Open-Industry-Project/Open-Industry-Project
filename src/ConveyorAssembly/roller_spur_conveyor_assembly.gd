@tool
class_name RollerSpurConveyor
extends ResizableNode3D

const CONVEYOR_CLASS_NAME = "RollerConveyor"
const CONVEYOR_SCRIPT_PATH = "res://src/RollerConveyor/roller_conveyor.gd"
const CONVEYOR_SCRIPT_FILENAME = "roller_conveyor.gd"
const CONVEYOR_SCENE = preload("res://parts/RollerConveyor.tscn")
const PREVIEW_SCENE_PATH: String = "res://parts/RollerSpurConveyor.tscn"

static var _conveyor_script_cached: Script

var _conveyor_script: Script
var _conveyor: Node3D = null
var _conveyor_x_offset: float = 0.0

@export_custom(PROPERTY_HINT_NONE, "suffix:m") var length: float:
	set(value): size.x = value
	get: return size.x

@export_custom(PROPERTY_HINT_NONE, "suffix:m") var width: float:
	set(value): size.z = value
	get: return size.z

@export_custom(PROPERTY_HINT_NONE, "suffix:m") var depth: float:
	set(value): size.y = value
	get: return size.y

## Angular offset of the downstream end (positive angles splay outward).
@export_range(-70, 70, 1, "radians_as_degrees") var angle_downstream: float = 0.0:
	set(value):
		if angle_downstream != value:
			angle_downstream = value
			set_process(true)

## Angular offset of the upstream end (positive angles splay outward).
@export_range(-70, 70, 1, "radians_as_degrees") var angle_upstream: float = 0.0:
	set(value):
		if angle_upstream != value:
			angle_upstream = value
			set_process(true)

@export_storage var _cached_properties: Dictionary = {}

var _default_speed: float = 2.0
var _default_enable_comms: bool = false
var _default_speed_tag_group_name: String = ""
var _default_speed_tag_name: String = ""
var _default_running_tag_group_name: String = ""
var _default_running_tag_name: String = ""


func _init() -> void:
	super._init()
	size_default = Vector3(2, 0.24, 1.524)

	_cached_properties[&"speed"] = _default_speed
	_cached_properties[&"enable_comms"] = _default_enable_comms
	_cached_properties[&"speed_tag_group_name"] = _default_speed_tag_group_name
	_cached_properties[&"speed_tag_name"] = _default_speed_tag_name
	_cached_properties[&"running_tag_group_name"] = _default_running_tag_group_name
	_cached_properties[&"running_tag_name"] = _default_running_tag_name

	if _conveyor_script_cached == null:
		var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
		var class_details: Dictionary = class_list[class_list.find_custom(func (item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
		_conveyor_script_cached = load(class_details["path"]) as Script
	_conveyor_script = _conveyor_script_cached


func _enter_tree() -> void:
	super._enter_tree()
	if not OIPComms.enable_comms_changed.is_connected(notify_property_list_changed):
		OIPComms.enable_comms_changed.connect(notify_property_list_changed)


func _ready() -> void:
	_ensure_conveyor()
	_update_spur()


func _exit_tree() -> void:
	if OIPComms.enable_comms_changed.is_connected(notify_property_list_changed):
		OIPComms.enable_comms_changed.disconnect(notify_property_list_changed)


func _process(_delta: float) -> void:
	set_process(false)
	_update_spur()


func _on_size_changed() -> void:
	set_process(true)
	super._on_size_changed()


func _get_constrained_size(new_size: Vector3) -> Vector3:
	return new_size


func _validate_property(property: Dictionary) -> void:
	var property_name: String = property["name"]
	if property_name in ["length", "width", "depth"]:
		property["usage"] = PROPERTY_USAGE_EDITOR
	if property_name == "size":
		property["usage"] = PROPERTY_USAGE_STORAGE

	if property[&"name"] == CONVEYOR_SCRIPT_FILENAME \
			and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		assert(CONVEYOR_SCRIPT_PATH.get_file() == CONVEYOR_SCRIPT_FILENAME, "CONVEYOR_SCRIPT_PATH doesn't match CONVEYOR_SCRIPT_FILENAME")
		property[&"hint_string"] = CONVEYOR_SCRIPT_PATH
		return
	elif property[&"name"] == "Communications" and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		property[&"usage"] = PROPERTY_USAGE_CATEGORY if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property[&"name"] == "enable_comms":
		property[&"usage"] = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE
	elif property[&"name"] == "speed_tag_group_name":
		property[&"usage"] = PROPERTY_USAGE_STORAGE
	elif property[&"name"] == "speed_tag_groups":
		property[&"usage"] = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property[&"name"] == "speed_tag_name":
		property[&"usage"] = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE
	elif property[&"name"] == "running_tag_group_name":
		property[&"usage"] = PROPERTY_USAGE_STORAGE
	elif property[&"name"] == "running_tag_groups":
		property[&"usage"] = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property[&"name"] == "running_tag_name":
		property[&"usage"] = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE


func _property_can_revert(property: StringName) -> bool:
	if property in ["length", "width", "depth"]:
		return true
	if property in _get_conveyor_forwarded_property_names():
		return true
	return false


func _property_get_revert(property: StringName) -> Variant:
	match property:
		&"length":
			return size_default.x
		&"width":
			return size_default.z
		&"depth":
			return size_default.y
	if property not in _get_conveyor_forwarded_property_names():
		return null
	return _conveyor_script.get_property_default_value(property)


#region Internal conveyor management

func _ensure_conveyor() -> void:
	if _conveyor != null:
		return
	_conveyor = CONVEYOR_SCENE.instantiate() as Node3D
	add_child(_conveyor, false, Node.INTERNAL_MODE_BACK)
	_conveyor.owner = null


func _update_spur() -> void:
	_ensure_conveyor()

	var half_w := size.z / 2.0
	var ds_ext := absf(tan(angle_downstream)) * half_w
	var us_ext := absf(tan(angle_upstream)) * half_w
	var max_length := size.x + ds_ext + us_ext

	var ds_max := size.x / 2.0 + ds_ext
	var us_min := -size.x / 2.0 - us_ext
	_conveyor_x_offset = (ds_max + us_min) / 2.0

	if "size" in _conveyor:
		_conveyor.size = Vector3(max_length, size.y, size.z)
	_conveyor.position = Vector3(_conveyor_x_offset, 0, 0)

	_apply_conveyor_properties()
	call_deferred("_apply_spur_clipping")


func _apply_conveyor_properties() -> void:
	if _conveyor == null:
		return
	for property_name in _cached_properties:
		_conveyor.set(property_name, _cached_properties[property_name])


func _apply_spur_clipping() -> void:
	if not is_instance_valid(_conveyor):
		return

	var rollers_node := _conveyor.get_node_or_null("Rollers")
	if rollers_node:
		for child in rollers_node.get_children():
			if child is Roller:
				var x_spur: float = _conveyor.position.x + rollers_node.position.x + child.position.x
				_clip_roller_to_spur(child, x_spur)

	var ends_node := _conveyor.get_node_or_null("Ends")
	if ends_node:
		for end_child in ends_node.get_children():
			if end_child is RollerConveyorEnd:
				var end_roller: Roller = end_child.get_node_or_null("Roller")
				if end_roller:
					var x_spur: float = _conveyor.position.x + ends_node.position.x + end_child.position.x
					var clip := _get_spur_clip(x_spur)
					_apply_roller_clip(end_roller, clip)
					_adjust_end_frame(end_child, clip)

	_adjust_side_rails()


## Returns the spur-clipped z bounds as Vector3(z_min, z_max, clipped_width).
func _get_spur_clip(x_spur: float) -> Vector3:
	var half_w := size.z / 2.0
	var z_min := -half_w
	var z_max := half_w

	if absf(angle_downstream) > 0.001:
		var z_ds := (x_spur - size.x / 2.0) / tan(angle_downstream)
		if angle_downstream > 0:
			z_min = maxf(z_min, z_ds)
		else:
			z_max = minf(z_max, z_ds)

	if absf(angle_upstream) > 0.001:
		var z_us := (x_spur + size.x / 2.0) / tan(angle_upstream)
		if angle_upstream > 0:
			z_max = minf(z_max, z_us)
		else:
			z_min = maxf(z_min, z_us)

	return Vector3(z_min, z_max, maxf(0.0, z_max - z_min))


func _clip_roller_to_spur(roller: Roller, x_spur: float) -> void:
	_apply_roller_clip(roller, _get_spur_clip(x_spur))


func _apply_roller_clip(roller: Roller, clip: Vector3) -> void:
	if clip.z < 0.01:
		roller.visible = false
		return
	roller.visible = true
	roller.set_length_and_offset(clip.z, (clip.x + clip.y) / 2.0)


func _adjust_end_frame(end: RollerConveyorEnd, clip: Vector3) -> void:
	var frame_node := end.get_node_or_null("ConveyorRollerEnd")
	if not frame_node:
		return

	if clip.z < 0.01:
		frame_node.visible = false
		return

	frame_node.visible = true
	var half_w := size.z / 2.0
	var meshes: Array[MeshInstance3D] = []
	for child in frame_node.get_children():
		if child is MeshInstance3D:
			meshes.append(child)

	if meshes.size() >= 2:
		var at_left_edge := absf(clip.x + half_w) < 0.01
		var at_right_edge := absf(clip.y - half_w) < 0.01
		meshes[0].visible = at_left_edge
		meshes[1].visible = at_right_edge
		meshes[0].position = Vector3(meshes[0].position.x, meshes[0].position.y, clip.x)
		meshes[1].position = Vector3(meshes[1].position.x, meshes[1].position.y, clip.y)


func _adjust_side_rails() -> void:
	var conv_roller := _conveyor.get_node_or_null("ConvRoller")
	if not conv_roller:
		return

	var parent_scale_x: float = conv_roller.scale.x
	if parent_scale_x < 0.001:
		return

	var half_w := size.z / 2.0
	var tan_ds := tan(angle_downstream)
	var tan_us := tan(angle_upstream)

	var left_side := conv_roller.get_node_or_null("ConvRollerL")
	if left_side:
		var front_x: float = size.x / 2.0 + tan_ds * (-half_w)
		var back_x: float = -size.x / 2.0 + tan_us * (-half_w)
		var rail_length: float = front_x - back_x
		var center_conveyor: float = (front_x + back_x) / 2.0 - _conveyor_x_offset
		left_side.position.x = center_conveyor / parent_scale_x
		left_side.scale.x = rail_length / parent_scale_x

	var right_side := conv_roller.get_node_or_null("ConvRollerR")
	if right_side:
		var front_x: float = size.x / 2.0 + tan_ds * half_w
		var back_x: float = -size.x / 2.0 + tan_us * half_w
		var rail_length: float = front_x - back_x
		var center_conveyor: float = (front_x + back_x) / 2.0 - _conveyor_x_offset
		right_side.position.x = center_conveyor / parent_scale_x
		right_side.scale.x = rail_length / parent_scale_x

#endregion

#region Conveyor property forwarding

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

		if prop_name in ["size", "skew_angle", "hijack_scale"] or prop_name.begins_with("metadata/hijack_scale"):
			continue

		filtered_properties.append(prop)

	return filtered_properties


func _set(property: StringName, value: Variant) -> bool:
	if property not in _get_conveyor_forwarded_property_names():
		return false
	_cached_properties[property] = value
	if is_instance_valid(_conveyor):
		_conveyor.set(property, value)
	if property == &"enable_comms":
		notify_property_list_changed()
	return true


func _get(property: StringName) -> Variant:
	if property not in _get_conveyor_forwarded_property_names():
		return null
	if is_instance_valid(_conveyor):
		return _conveyor.get(property)
	if property in _cached_properties:
		return _cached_properties[property]
	match property:
		&"speed":
			return _default_speed
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


func _get_conveyor_forwarded_properties() -> Array[Dictionary]:
	var all_properties: Array[Dictionary]
	var has_seen_node3d_category: bool = false
	var has_seen_category_after_node3d: bool = false

	if is_instance_valid(_conveyor):
		all_properties = _conveyor.get_property_list()
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
				if prop_name in ["size", "skew_angle", "original_size", "transform_in_progress", "size_min", "size_default", "hijack_scale"]:
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

#endregion

#region Preview

func _get_custom_preview_node() -> Node3D:
	var preview_scene := load(PREVIEW_SCENE_PATH) as PackedScene
	var preview_node = preview_scene.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED) as Node3D

	preview_node.set_meta("is_preview", true)

	preview_node._update_spur()
	preview_node._apply_spur_clipping()

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

#endregion
