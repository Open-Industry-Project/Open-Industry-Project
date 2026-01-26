@tool
class_name MultiPlaneBeltConveyor
extends ResizableNode3D

## Multi-plane belt conveyor that supports multiple angled segments driven by a single motor.
## Each segment can have its own length and incline angle, but shares speed and appearance.

const CONVEYOR_CLASS_NAME = "BeltConveyor"
const CONVEYOR_SCRIPT_PATH = "res://src/Conveyor/belt_conveyor.gd"
const CONVEYOR_SCRIPT_FILENAME = "belt_conveyor.gd"
const PREVIEW_SCENE_PATH: String = "res://parts/MultiPlaneBeltConveyor.tscn"

signal speed_changed

## The segments that make up this multi-plane conveyor.
## Each segment has its own length and angle.
@export var segments: Array[MultiPlaneSegment] = []:
	set(value):
		# Disconnect from old segments
		for segment in segments:
			if segment and segment.changed.is_connected(_on_segment_changed):
				segment.changed.disconnect(_on_segment_changed)
		
		segments = value
		
		# Connect to new segments
		for segment in segments:
			if segment and not segment.changed.is_connected(_on_segment_changed):
				segment.changed.connect(_on_segment_changed)
		
		_schedule_update()

## Width of all conveyor segments in meters.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var width: float = 1.524:
	set(value):
		width = maxf(0.1, value)
		_schedule_update()

## Height/depth of all conveyor segments in meters.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var depth: float = 0.5:
	set(value):
		depth = maxf(0.02, value)
		_schedule_update()

var _conveyor_script: Script

# Store properties locally and forward to child conveyors
@export_storage var _cached_properties: Dictionary = {}

# Default property values
var _default_speed: float = 2.0
var _default_belt_color: Color = Color.WHITE
var _default_belt_texture: int = 0  # BeltConveyor.ConvTexture.STANDARD
var _default_enable_comms: bool = false
var _default_speed_tag_group_name: String = ""
var _default_speed_tag_name: String = ""
var _default_running_tag_group_name: String = ""
var _default_running_tag_name: String = ""

var _update_scheduled: bool = false


func _init() -> void:
	super._init()
	size_default = Vector3(4, 0.5, 1.524)
	
	# Initialize cached properties with default values
	_cached_properties[&"speed"] = _default_speed
	_cached_properties[&"belt_color"] = _default_belt_color
	_cached_properties[&"belt_texture"] = _default_belt_texture
	_cached_properties[&"belt_physics_material"] = null
	_cached_properties[&"enable_comms"] = _default_enable_comms
	_cached_properties[&"speed_tag_group_name"] = _default_speed_tag_group_name
	_cached_properties[&"speed_tag_name"] = _default_speed_tag_name
	_cached_properties[&"running_tag_group_name"] = _default_running_tag_group_name
	_cached_properties[&"running_tag_name"] = _default_running_tag_name
	
	# Create default segments if empty
	if segments.is_empty():
		var seg1 := MultiPlaneSegment.new(2.0, 0.0)
		var seg2 := MultiPlaneSegment.new(2.0, deg_to_rad(15.0))
		segments = [seg1, seg2]


func _enter_tree() -> void:
	super._enter_tree()
	if not OIPComms.enable_comms_changed.is_connected(notify_property_list_changed):
		OIPComms.enable_comms_changed.connect(notify_property_list_changed)


func _ready() -> void:
	# Clear any existing children and rebuild
	for child in get_children():
		remove_child(child)
		child.queue_free()
	
	_update_conveyors()


func _exit_tree() -> void:
	if OIPComms.enable_comms_changed.is_connected(notify_property_list_changed):
		OIPComms.enable_comms_changed.disconnect(notify_property_list_changed)
	super._exit_tree()


func _process(_delta: float) -> void:
	if _update_scheduled:
		_update_scheduled = false
		set_process(false)
		_update_conveyors()


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

		if prop_name == "size" or prop_name == "hijack_scale" or prop_name.begins_with("metadata/hijack_scale"):
			continue

		filtered_properties.append(prop)

	return filtered_properties


func _validate_property(property: Dictionary) -> void:
	var prop_name: String = property[&"name"]
	
	if prop_name == CONVEYOR_SCRIPT_FILENAME \
			and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		assert(CONVEYOR_SCRIPT_PATH.get_file() == CONVEYOR_SCRIPT_FILENAME, "CONVEYOR_SCRIPT_PATH doesn't match CONVEYOR_SCRIPT_FILENAME")
		property[&"hint_string"] = CONVEYOR_SCRIPT_PATH
		return
	
	# Hide the size property since we use segments, width, and depth instead
	if prop_name == "size":
		property[&"usage"] = PROPERTY_USAGE_STORAGE
	
	# Handle communication properties forwarded from child conveyors
	elif prop_name == "Communications" and property[&"usage"] & PROPERTY_USAGE_CATEGORY:
		property[&"usage"] = PROPERTY_USAGE_CATEGORY if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif prop_name == "enable_comms":
		property[&"usage"] = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE
	elif prop_name == "speed_tag_group_name":
		property[&"usage"] = PROPERTY_USAGE_STORAGE
	elif prop_name == "speed_tag_groups":
		property[&"usage"] = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif prop_name == "speed_tag_name":
		property[&"usage"] = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE
	elif prop_name == "running_tag_group_name":
		property[&"usage"] = PROPERTY_USAGE_STORAGE
	elif prop_name == "running_tag_groups":
		property[&"usage"] = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif prop_name == "running_tag_name":
		property[&"usage"] = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE


func _get_conveyor_script() -> Script:
	if _conveyor_script:
		return _conveyor_script
	var class_list: Array[Dictionary] = ProjectSettings.get_global_class_list()
	var class_details: Dictionary = class_list[class_list.find_custom(func (item: Dictionary) -> bool: return item["class"] == CONVEYOR_CLASS_NAME)]
	_conveyor_script = load(class_details["path"]) as Script
	return _conveyor_script


func _get_constrained_size(new_size: Vector3) -> Vector3:
	# Size is calculated from segments, not directly settable
	return new_size


func _on_size_changed() -> void:
	# Size is calculated from segments, width, and depth - don't feed back
	# The size property is effectively read-only for this assembly
	pass


func _on_segment_changed() -> void:
	_schedule_update()


func _schedule_update() -> void:
	if not is_inside_tree():
		return
	_update_scheduled = true
	set_process(true)


func _update_conveyors() -> void:
	if not is_inside_tree():
		return
	
	var target_count := segments.size()
	
	# Add or remove conveyors as needed
	_add_or_remove_conveyors(target_count)
	
	# Update each conveyor's transform and size
	_position_conveyors()
	
	# Calculate total size for the assembly
	_update_total_size()


func _add_or_remove_conveyors(count: int) -> void:
	var conveyor_scene := preload("res://parts/BeltConveyor.tscn")
	
	while _get_internal_child_count() > count and _get_internal_child_count() > 0:
		_remove_last_child()
	
	while _get_internal_child_count() < count:
		var conveyor := conveyor_scene.instantiate() as Node3D
		add_child(conveyor, false, Node.INTERNAL_MODE_BACK)
		conveyor.owner = null
		_set_conveyor_properties(conveyor)


func _get_internal_child_count() -> int:
	return get_child_count(true) - get_child_count()


func _remove_last_child() -> void:
	var child := get_child(get_child_count(true) - 1, true)
	remove_child(child)
	child.queue_free()


func _position_conveyors() -> void:
	if segments.is_empty():
		return
	
	# Calculate total length to center the assembly
	var total_horizontal_length: float = 0.0
	for segment in segments:
		if segment:
			total_horizontal_length += segment.length * cos(segment.angle)
	
	# Start position (left side of the assembly, centered on X)
	var current_x: float = -total_horizontal_length / 2.0
	var current_y: float = 0.0
	
	for i in range(_get_internal_child_count()):
		if i >= segments.size():
			break
		
		var segment := segments[i]
		if not segment:
			continue
		
		var conveyor := get_child(i + get_child_count(), true) as Node3D
		if not conveyor:
			continue
		
		# Calculate segment dimensions
		var seg_length := segment.length
		var seg_angle := segment.angle
		var horizontal_length := seg_length * cos(seg_angle)
		var vertical_rise := seg_length * sin(seg_angle)
		
		# Position is at the center of this segment
		var center_x := current_x + horizontal_length / 2.0
		var center_y := current_y + vertical_rise / 2.0
		
		# Set transform with rotation
		var basis := Basis.IDENTITY.rotated(Vector3.BACK, seg_angle)
		conveyor.transform = Transform3D(basis, Vector3(center_x, center_y, 0))
		
		# Set size
		if "size" in conveyor:
			conveyor.size = Vector3(seg_length, depth, width)
		
		# Update current position for next segment
		current_x += horizontal_length
		current_y += vertical_rise


func _update_total_size() -> void:
	if segments.is_empty():
		size = Vector3(0, depth, width)
		return
	
	# Calculate bounding box of all segments
	var min_x: float = INF
	var max_x: float = -INF
	var min_y: float = INF
	var max_y: float = -INF
	
	var current_x: float = 0.0
	var current_y: float = 0.0
	
	for segment in segments:
		if not segment:
			continue
		
		var seg_length := segment.length
		var seg_angle := segment.angle
		var horizontal_length := seg_length * cos(seg_angle)
		var vertical_rise := seg_length * sin(seg_angle)
		
		# Track min/max positions
		min_x = minf(min_x, current_x)
		max_x = maxf(max_x, current_x + horizontal_length)
		min_y = minf(min_y, current_y)
		max_y = maxf(max_y, current_y + vertical_rise)
		min_y = minf(min_y, current_y + vertical_rise)
		max_y = maxf(max_y, current_y)
		
		current_x += horizontal_length
		current_y += vertical_rise
	
	# Set size to bounding box dimensions
	var total_length := max_x - min_x
	var total_height := max_y - min_y + depth
	size = Vector3(total_length, total_height, width)


func _set_conveyor_properties(conveyor: Node) -> void:
	# Apply all cached properties to the conveyor
	for property_name in _cached_properties:
		if conveyor.has_method("set"):
			conveyor.set(property_name, _cached_properties[property_name])


func _set_for_all_conveyors(property: StringName, value: Variant) -> void:
	var conveyor_count := _get_internal_child_count()
	for i in range(conveyor_count):
		var conveyor: Node = get_child(i + get_child_count(), true)
		if conveyor:
			conveyor.set(property, value)


func _set(property: StringName, value: Variant) -> bool:
	if property not in _get_conveyor_forwarded_property_names():
		return false
	_cached_properties[property] = value
	_set_for_all_conveyors(property, value)
	
	if property == &"speed":
		speed_changed.emit()
	elif property == &"enable_comms":
		notify_property_list_changed()
	
	return true


func _get(property: StringName) -> Variant:
	if property not in _get_conveyor_forwarded_property_names():
		return null
	
	# Get from first conveyor if available
	if _get_internal_child_count() > 0:
		var conveyor: Node = get_child(get_child_count(), true)
		if conveyor:
			return conveyor.get(property)
	
	# Fall back to cached value
	if property in _cached_properties:
		return _cached_properties[property]
	
	# Fall back to default values
	match property:
		&"speed":
			return _default_speed
		&"belt_color":
			return _default_belt_color
		&"belt_texture":
			return _default_belt_texture
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


func _property_can_revert(property: StringName) -> bool:
	return property in _get_conveyor_forwarded_property_names()


func _property_get_revert(property: StringName) -> Variant:
	if property not in _get_conveyor_forwarded_property_names():
		return null
	if _get_internal_child_count() > 0:
		var conveyor: Node = get_child(get_child_count(), true)
		if conveyor.has_method("property_can_revert") and conveyor.property_can_revert(property):
			return conveyor.property_get_revert(property)
		elif conveyor.scene_file_path:
			var scene := load(conveyor.scene_file_path) as PackedScene
			var scene_state := scene.get_state()
			for prop_idx in range(scene_state.get_node_property_count(0)):
				if scene_state.get_node_property_name(0, prop_idx) == property:
					return scene_state.get_node_property_value(0, prop_idx)
			return conveyor.get_script().get_property_default_value(property)
	return _get_conveyor_script().get_property_default_value(property)


func _get_conveyor_forwarded_properties() -> Array[Dictionary]:
	var all_properties: Array[Dictionary]
	var has_seen_node3d_category: bool = false
	var has_seen_category_after_node3d: bool = false

	if _get_internal_child_count() > 0:
		var conveyor: Node = get_child(get_child_count(), true)
		all_properties = conveyor.get_property_list()
	else:
		all_properties = _get_conveyor_script().get_script_property_list()
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


func _get_custom_preview_node() -> Node3D:
	var preview_scene := load(PREVIEW_SCENE_PATH) as PackedScene
	if not preview_scene:
		return null
	var preview_node = preview_scene.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED) as MultiPlaneBeltConveyor
	
	preview_node.set_meta("is_preview", true)
	
	if preview_node.has_method("_update_conveyors"):
		preview_node._update_conveyors()
	
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


## Add a new segment to the end of the conveyor.
func add_segment(length: float = 2.0, angle: float = 0.0) -> void:
	var new_segment := MultiPlaneSegment.new(length, angle)
	segments.append(new_segment)
	segments = segments  # Trigger setter


## Remove the last segment from the conveyor.
func remove_last_segment() -> void:
	if segments.size() > 1:
		segments.pop_back()
		segments = segments  # Trigger setter


## Get the total horizontal length of all segments combined.
func get_total_horizontal_length() -> float:
	var total: float = 0.0
	for segment in segments:
		if segment:
			total += segment.length * cos(segment.angle)
	return total


## Get the total vertical rise from start to end.
func get_total_vertical_rise() -> float:
	var total: float = 0.0
	for segment in segments:
		if segment:
			total += segment.length * sin(segment.angle)
	return total
