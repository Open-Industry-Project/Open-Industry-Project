@tool
class_name StackLight
extends Node3D

var _segment_scene: PackedScene = load("res://src/StackLight/StackSegment.tscn")
var _data: StackLightData = load("res://src/StackLight/StackLightData.tres")

var _prev_scale: Vector3

var segments: int = 1:
	set(value):
		var new_value: int = clamp(value, 1, 10)
		if new_value == segments:
			return

		segments = new_value

		if is_inside_tree():
			_data.set_segments(segments)

			var current_child_count = _segments_container.get_child_count()
			var difference = segments - current_child_count

			if difference > 0:
				_spawn_segments(difference)
			elif difference < 0:
				_remove_segments(-difference)

			_init_segments()

			# If segments were removed, mask the light value
			var new_light_value = light_value & ((1 << segments) - 1)
			if new_light_value != light_value:
				light_value = new_light_value
				_update_segment_visuals()

			if _top_mesh:
				_top_mesh.position = Vector3(0, _TOP_MESH_INITIAL_Y_POS + (STEP * (segments - 1)), 0)
		notify_property_list_changed()

var light_value: int = 0:
	set(value):
		var new_val: int = value % (1 << segments)
		if new_val == light_value:
			return
		light_value = new_val
		_update_segment_visuals()
		notify_property_list_changed()

var enable_comms: bool = true
@export var tag_group_name: String
var _tag_groups: String:
	set(value):
		tag_group_name = value
		_tag_groups = value

var tag_name: String = ""

const STEP: float = 0.048
var _segments_container: Node3D
var _top_mesh: MeshInstance3D
var _segment_initial_y_pos: float
const _TOP_MESH_INITIAL_Y_POS: float = 0.087

var _bottom_mesh: MeshInstance3D
var _stem_mesh: MeshInstance3D
var _mid_mesh: MeshInstance3D

var _register_tag_ok: bool = false
var _tag_group_init: bool = false
var _tag_group_original: String
var _enable_comms_changed: bool = false:
	set(value):
		notify_property_list_changed()

func _get(property: StringName) -> Variant:
	if not is_inside_tree():
		return null
	
	for i in range(segments):
		if property == "Light " + str(i + 1):
			var segment = _segments_container.get_child(i)
			return segment.segment_data
	return null

func _validate_property(property: Dictionary) -> void:
	if property.name == "tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE


func _property_can_revert(property: StringName) -> bool:
	return property == "tag_groups"


func _property_get_revert(property: StringName) -> Variant:
	if property == "tag_groups":
		return _tag_group_original
	else:
		return null

func _get_property_list() -> Array:
	var properties = []
	properties.append({
		"name": "light_value",
		"type": TYPE_INT,
		"usage": PROPERTY_USAGE_DEFAULT
	})
	properties.append({
		"name": "segments",
		"type": TYPE_INT,
		"usage": PROPERTY_USAGE_DEFAULT
	})
	properties.append({
		"name": "_data",
		"type": TYPE_OBJECT,
		"usage": PROPERTY_USAGE_NO_EDITOR
	})
	for i in range(segments - 1, -1, -1):
		properties.append({
			"name": "Light " + str(i + 1),
			"class_name": "StackSegmentData",
			"type": TYPE_OBJECT,
			"usage": PROPERTY_USAGE_DEFAULT | PROPERTY_USAGE_READ_ONLY
		})
	properties.append({
		"name": "Communications",
		"type": TYPE_NIL,
		"usage": PROPERTY_USAGE_CATEGORY
	})
	properties.append({
		"name": "enable_comms",
		"type": TYPE_BOOL,
		"usage": PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	})
	properties.append({
		"name": "tag_groups",
		"type": 0,
		"usage": PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_STORAGE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE,
		"hint": 0,
		"hint_string": "tag_group_enum"
	})
	properties.append({
		"name": "tag_name",
		"type": TYPE_STRING,
		"usage": PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	})
	return properties

func _ready() -> void:
	set_notify_transform(true)
	_data = _data.duplicate(true)
	_data.init_segments(segments)
	_segments_container = get_node("Mid/Segments")
	_top_mesh = get_node("Mid/Top")
	_bottom_mesh = get_node("Bottom")
	_mid_mesh = get_node("Mid")

	var current_child_count = _segments_container.get_child_count()
	var difference = segments - current_child_count

	if difference > 0:
		# Need to add segments
		_spawn_segments(difference)
	elif difference < 0:
		# Need to remove segments (queue_free excess)
		for i in range(-difference):
			var child_to_remove_index = current_child_count - 1 - i
			if child_to_remove_index >= 0:
				var child_node = _segments_container.get_child(child_to_remove_index)
				child_node.queue_free()
			else:
				pass # Tried to remove invalid index

	if _segments_container.get_child_count() > 0:
		_segment_initial_y_pos = _segments_container.get_child(0).position.y
	else:
		# Need a fallback if all segments are removed (e.g., Segments set to 0, although we clamp to 1)
		_segment_initial_y_pos = 0.0

	_fix_segment_positions()
	_init_segments()

	_top_mesh.position = Vector3(0, _TOP_MESH_INITIAL_Y_POS + (STEP * (max(0, segments - 1))), 0) # Use max(0,...) in case Segments is 0 temporarily
	_update_segment_visuals()
	_prev_scale = scale
	_rescale()

func _enter_tree() -> void:
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	OIPComms.tag_group_polled.connect(_tag_group_polled)

	_tag_group_original = tag_group_name
	if tag_group_name.is_empty():
		tag_group_name = OIPComms.get_tag_groups()[0]

	_tag_groups = tag_group_name

	OIPComms.enable_comms_changed.connect(func() -> void: _enable_comms_changed = OIPComms.get_enable_comms())

func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	OIPComms.tag_group_polled.disconnect(_tag_group_polled)
	# Disconnect signals from all segments
	if _segments_container:
		for i in range(_segments_container.get_child_count()):
			var segment_node = _segments_container.get_child(i)
			if segment_node.is_connected("active_state_changed", _on_segment_state_changed):
				segment_node.active_state_changed.disconnect(_on_segment_state_changed)

func use() -> void:
	light_value += 1

func _on_simulation_started() -> void:
	if enable_comms:
		OIPComms.register_tag(tag_group_name, tag_name, 1)

func _tag_group_polled(tag_group_name_param: String) -> void:
	if not enable_comms:
		return
	# Use the tag_group_name_param if we need to check which tag group was polled
	if tag_group_name_param != tag_group_name:
		return

	light_value = OIPComms.read_int32(tag_group_name, tag_name)

func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSFORM_CHANGED:
		if scale != _prev_scale:
			_rescale()
			_prev_scale = scale

func _rescale() -> void:
	scale = Vector3(scale.x, scale.y, scale.x)
	_bottom_mesh.scale = Vector3(1, 1 / scale.y, 1)
	_mid_mesh.scale = Vector3(1, (1 / scale.y) * scale.x, 1)

func _init_segments() -> void:
	for i in range(segments):
		if i >= _segments_container.get_child_count():
			printerr("Mismatch between segments count and child nodes during InitSegments")
			break
		var segment_node = _segments_container.get_child(i)
		segment_node.segment_data = _data.segment_datas[i]
		segment_node.index = i

		if not segment_node.is_connected("active_state_changed", _on_segment_state_changed):
			segment_node.active_state_changed.connect(_on_segment_state_changed)
	_increase_collision_shape()

func _spawn_segments(count: int) -> void:
	if not is_inside_tree():
		return
	var start_index = _segments_container.get_child_count()
	for i in range(count):
		var segment = _segment_scene.instantiate() as Node3D
		_segments_container.add_child(segment, true)
		segment.owner = self
		var current_index = start_index + i
		segment.index = current_index
		segment.position = Vector3(0, _segment_initial_y_pos + (STEP * current_index), 0)

		if current_index < _data.segment_datas.size():
			segment.segment_data = _data.segment_datas[current_index]
		else:
			printerr("Not enough data segments available when spawning segment %d" % current_index)
		segment.active_state_changed.connect(_on_segment_state_changed)

func _remove_segments(count: int) -> void:
	if not is_inside_tree():
		return
	var current_child_count = _segments_container.get_child_count()
	for i in range(count):
		var child_index = current_child_count - 1 - i
		if child_index < 0:
			break # Should not happen if count is correct
		var segment_node = _segments_container.get_child(child_index)

		if segment_node.is_connected("active_state_changed", _on_segment_state_changed):
			segment_node.active_state_changed.disconnect(_on_segment_state_changed)
		segment_node.queue_free()

func _on_segment_state_changed(index: int, active: bool) -> void:
	if index < 0 or index >= segments:
		printerr("Received state change for invalid index: ", index)
		return

	var current_bit = (1 << index)
	var newlight_value: int
	if active:
		newlight_value = light_value | current_bit
	else:
		newlight_value = light_value & ~current_bit

	self.light_value = newlight_value

func _update_segment_visuals() -> void:
	if not is_inside_tree():
		return
	for i in range(segments):
		if i < _data.segment_datas.size():
			var segment_data: StackSegmentData = _data.segment_datas[i]
			var is_active = (light_value >> i) & 1 == 1
			# This prevents recursive signals if _on_segment_state_changed was triggered by inspector
			if segment_data.active != is_active:
				segment_data.active = is_active
		else:
			# This case handles if segments count > data array size temporarily
			# Ensure segment visuals are off if no data is present
			if i < _segments_container.get_child_count():
				var segment_node = _segments_container.get_child(i) as StackSegment
				segment_node._set_active(false) # Directly set visual state

func _fix_segment_positions() -> void:
	if not is_inside_tree():
		return
	for i in range(_segments_container.get_child_count()):
		var segment_node = _segments_container.get_child(i)
		segment_node.position = Vector3(0, _segment_initial_y_pos + (STEP * i), 0)
	
func _increase_collision_shape() -> void:
	var collision_shape = $StaticBody3D/CollisionShape3D
	if collision_shape:
		var new_scale_y = 1.45 + (0.3 * segments)
		collision_shape.shape.size.y = new_scale_y
		collision_shape.position.y = -0.148 + (0.16 * (segments - 1))
