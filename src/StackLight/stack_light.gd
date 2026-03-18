@tool
class_name StackLight
extends Node3D

const STEP: float = 0.048
const _TOP_MESH_INITIAL_Y_POS: float = 0.087

## Number of light segments in the stack (1-10).
var segments: int = 1:
	set(value):
		var new_value: int = clamp(value, 1, 8)
		if new_value == segments:
			return

		segments = new_value

		if is_inside_tree():
			_data.set_segments(segments)

			var current_child_count := _segments_container.get_child_count()
			var difference := segments - current_child_count

			if difference > 0:
				_spawn_segments(difference)
			elif difference < 0:
				_remove_segments(-difference)

			_init_segments()

			# If segments were removed, mask the light value
			var new_light_value := light_value & ((1 << segments) - 1)
			if new_light_value != light_value:
				light_value = new_light_value
				_update_segment_visuals()

			if _top_mesh:
				_top_mesh.position = Vector3(0, _TOP_MESH_INITIAL_Y_POS + (STEP * (segments - 1)), 0)
		notify_property_list_changed()

## Bitmask controlling which segments are lit (bit 0 = segment 1, etc.).
var light_value: int = 0:
	set(value):
		var new_val: int = value % (1 << segments)
		if new_val == light_value:
			return
		light_value = new_val
		_update_segment_visuals()
		notify_property_list_changed()

## Enable communication with external PLC/control systems.
var enable_comms: bool = true
## Internal storage for the selected tag group name.
@export var tag_group_name: String
## The tag group for reading light values from external systems.
var _tag_groups: String:
	set(value):
		tag_group_name = value
		_tag_groups = value

## The tag name for the light value in the selected tag group.[br]Datatype: [code]BYTE[/code] (8-bit)[br][br]Format varies by protocol:[br][b]EIP:[/b] CIP tag names[br][b]Modbus:[/b] prefix+number (e.g. [code]hr0[/code])[br][b]OPC UA:[/b] full NodeId (e.g. [code]ns=2;s=MyVariable[/code] or [code]ns=2;i=12345[/code]).
var tag_name: String = ""

var _segment_scene: PackedScene = load("res://src/StackLight/StackSegment.tscn")
var _data: StackLightData = load("res://src/StackLight/StackLightData.tres")
var _prev_scale: Vector3
var _top_mesh_initial_y_pos: float
var _segment_initial_y_pos: float
var _tag := OIPCommsTag.new()
@onready var _segments_container: Node3D = get_node("Mid/Segments")
@onready var _top_mesh: MeshInstance3D = get_node("Mid/Top")
@onready var _bottom_mesh: MeshInstance3D = get_node("Bottom")
@onready var _mid_mesh: MeshInstance3D = get_node("Mid")


func _get(property: StringName) -> Variant:
	if not is_inside_tree() or not _segments_container:
		return null
	
	for i in range(segments):
		if property == "Light " + str(i + 1):
			var segment := _segments_container.get_child(i)
			return segment.segment_data
	return null


func _validate_property(property: Dictionary) -> void:
	if property.name == "tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE


func _get_property_list() -> Array:
	var properties: Array = []
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
		"usage": PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE
	})
	properties.append({
		"name": "tag_groups",
		"type": 0,
		"usage": PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE,
		"hint": 0,
		"hint_string": "tag_group_enum"
	})
	properties.append({
		"name": "tag_name",
		"type": TYPE_STRING,
		"usage": PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE
	})
	return properties


func _enter_tree() -> void:
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	tag_group_name = OIPCommsSetup.default_tag_group(tag_group_name)
	OIPCommsSetup.connect_comms(self, Callable(), _tag_group_polled)


func _ready() -> void:
	set_notify_transform(true)
	_data = _data.duplicate(true)
	_data.init_segments(segments)

	var current_child_count := _segments_container.get_child_count()
	var difference := segments - current_child_count

	if difference > 0:
		_spawn_segments(difference)
	elif difference < 0:
		for i in range(-difference):
			var child_to_remove_index := current_child_count - 1 - i
			if child_to_remove_index >= 0:
				var child_node := _segments_container.get_child(child_to_remove_index)
				child_node.queue_free()
			else:
				pass

	if _segments_container.get_child_count() > 0:
		_segment_initial_y_pos = _segments_container.get_child(0).position.y
	else:
		_segment_initial_y_pos = 0.0

	_fix_segment_positions()
	_init_segments()

	_top_mesh.position = Vector3(0, _TOP_MESH_INITIAL_Y_POS + (STEP * (max(0, segments - 1))), 0)
	_update_segment_visuals()
	_prev_scale = scale
	_rescale()


func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	OIPCommsSetup.disconnect_comms(self, Callable(), _tag_group_polled)
	if _segments_container:
		for i in range(_segments_container.get_child_count()):
			var segment_node := _segments_container.get_child(i)
			if segment_node.active_state_changed.is_connected(_on_segment_state_changed):
				segment_node.active_state_changed.disconnect(_on_segment_state_changed)


func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSFORM_CHANGED:
		if scale != _prev_scale:
			_rescale()
			_prev_scale = scale


func use() -> void:
	light_value += 1


func _rescale() -> void:
	scale = Vector3(scale.x, scale.y, scale.x)
	_bottom_mesh.scale = Vector3(1, 1 / scale.y, 1)
	_mid_mesh.scale = Vector3(1, (1 / scale.y) * scale.x, 1)


func _init_segments() -> void:
	for i in range(segments):
		if i >= _segments_container.get_child_count():
			printerr("Mismatch between segments count and child nodes during InitSegments")
			break
		var segment_node := _segments_container.get_child(i)
		segment_node.segment_data = _data.segment_datas[i]
		segment_node.index = i

		if not segment_node.active_state_changed.is_connected(_on_segment_state_changed):
			segment_node.active_state_changed.connect(_on_segment_state_changed)
	_increase_collision_shape()


func _spawn_segments(count: int) -> void:
	if not is_inside_tree():
		return
	var start_index := _segments_container.get_child_count()
	for i in range(count):
		var segment := _segment_scene.instantiate() as Node3D
		_segments_container.add_child(segment, true)
		var current_index := start_index + i
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
	var current_child_count := _segments_container.get_child_count()
	for i in range(count):
		var child_index := current_child_count - 1 - i
		if child_index < 0:
			break
		var segment_node := _segments_container.get_child(child_index)

		if segment_node.active_state_changed.is_connected(_on_segment_state_changed):
			segment_node.active_state_changed.disconnect(_on_segment_state_changed)
		segment_node.queue_free()


func _fix_segment_positions() -> void:
	if not is_inside_tree():
		return
	for i in range(_segments_container.get_child_count()):
		var segment_node := _segments_container.get_child(i)
		segment_node.position = Vector3(0, _segment_initial_y_pos + (STEP * i), 0)


func _increase_collision_shape() -> void:
	var collision_shape := $StaticBody3D/CollisionShape3D
	if collision_shape:
		var new_scale_y := 1.45 + (0.3 * segments)
		collision_shape.shape.size.y = new_scale_y
		collision_shape.position.y = -0.148 + (0.16 * (segments - 1))


func _update_segment_visuals() -> void:
	if not is_inside_tree():
		return
	for i in range(segments):
		if i < _data.segment_datas.size():
			var segment_data: StackSegmentData = _data.segment_datas[i]
			var is_active := (light_value >> i) & 1 == 1
			if segment_data.active != is_active:
				segment_data.active = is_active
		else:
			if i < _segments_container.get_child_count():
				var segment_node := _segments_container.get_child(i) as StackSegment
				segment_node._set_active(false)


func _on_segment_state_changed(index: int, active: bool) -> void:
	if index < 0 or index >= segments:
		printerr("Received state change for invalid index: ", index)
		return

	var current_bit := (1 << index)
	var newlight_value: int
	if active:
		newlight_value = light_value | current_bit
	else:
		newlight_value = light_value & ~current_bit

	self.light_value = newlight_value


func _on_simulation_started() -> void:
	if enable_comms:
		_tag.register(tag_group_name, tag_name)


func _tag_group_polled(tag_group_name_param: String) -> void:
	if not enable_comms or not _tag.matches_group(tag_group_name_param):
		return
	light_value = _tag.read_uint8()
