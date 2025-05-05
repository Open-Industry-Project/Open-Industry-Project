@tool
extends Node3D

const CONVEYOR_SCENE_BASE_LENGTH = 1.0
const CONVEYOR_SCENE_BASE_WIDTH = 1.0

@export var width: float = 2.0:
	set(value):
		if _set_process_if_changed(_width, value):
			_width = value
	get:
		return _width

@export var length: float = 4.0:
	set(value):
		if _set_process_if_changed(_length, value):
			_length = value
	get:
		return _length

@export_range(-70, 70, 1) var angle_downstream: float = 0.0:
	set(value):
		if _set_process_if_changed(_angle_downstream, value):
			_angle_downstream = value
	get:
		return _angle_downstream

@export_range(-70, 70, 1) var angle_upstream: float = 0.0:
	set(value):
		if _set_process_if_changed(_angle_upstream, value):
			_angle_upstream = value
	get:
		return _angle_upstream

@export_range(1, 20, 1) var conveyor_count: int = 4:
	set(value):
		if _set_process_if_changed(_conveyor_count, value):
			_conveyor_count = value
	get:
		return _conveyor_count

@export var speed: float = 2.0:
	set(value):
		if _set_process_if_changed(_speed, value):
			_speed = value
	get:
		return _speed

@export var conveyor_scene: PackedScene = preload("res://parts/BeltConveyor.tscn"):
	set(value):
		if _set_process_if_changed(_conveyor_scene, value):
			_conveyor_scene = value
			# Recreate all conveyors
			_add_or_remove_conveyors(0)
	get:
		return _conveyor_scene

@export var enable_comms: bool = false:
	set(value):
		if _set_process_if_changed(_enable_comms, value):
			_enable_comms = value
			notify_property_list_changed()
	get:
		return _enable_comms

@export var tag: String = "":
	set(value):
		if _set_process_if_changed(_tag, value):
			_tag = value
	get:
		return _tag

@export var update_rate: int = 100:
	set(value):
		if _set_process_if_changed(_update_rate, value):
			_update_rate = value
	get:
		return _update_rate

# Private variables to store the actual values
var _width: float = 2.0
var _length: float = 4.0
var _angle_downstream: float = 0.0
var _angle_upstream: float = 0.0
var _conveyor_count: int = 4
var _speed: float = 2.0
var _conveyor_scene: PackedScene
var _enable_comms: bool = false
var _tag: String = ""
var _update_rate: int = 100

func _ready() -> void:
	_process(0.0)

func _process(delta: float) -> void:
	_update_conveyors()
	set_process(false)

func _validate_property(property: Dictionary) -> void:
	var property_name = property["name"]

	if property_name == "update_rate" or property_name == "tag":
		property["usage"] = PROPERTY_USAGE_DEFAULT if enable_comms else PROPERTY_USAGE_NO_EDITOR

func _update_conveyors() -> void:
	_add_or_remove_conveyors(conveyor_count)
	for i in range(conveyor_count):
		_update_conveyor(i)

func _add_or_remove_conveyors(count: int) -> void:
	while get_child_count(true) - get_child_count() > count and get_child_count(true) - get_child_count() > 0:
		_remove_last_child()
	while get_child_count(true) - get_child_count() < count:
		_spawn_conveyor()

func _remove_last_child() -> void:
	var child = get_child(get_child_count(true) - 1, true)
	remove_child(child)
	child.queue_free()

func _spawn_conveyor() -> void:
	var conveyor = conveyor_scene.instantiate() as Node3D
	add_child(conveyor, false, Node.INTERNAL_MODE_BACK)
	conveyor.owner = null

func _update_conveyor(index: int) -> void:
	var child_3d = get_child(index + get_child_count(), true) as Node3D
	child_3d.transform = _get_new_transform_for_conveyor(index)

	if child_3d.has_method("set_enable_comms"):  # IComms equivalent check
		child_3d.enable_comms = enable_comms
		child_3d.tag = tag
		child_3d.update_rate = update_rate

	if child_3d.has_method("set_speed"):  # IConveyor equivalent check
		child_3d.speed = speed

func _get_new_transform_for_conveyor(index: int) -> Transform3D:
	var slope_downstream = tan(angle_downstream)
	var slope_upstream = tan(angle_upstream)

	var w = width / conveyor_count
	var pos_z = -0.5 * width + 0.5 * w + index * width / conveyor_count
	var pos_x = (slope_downstream * pos_z + slope_upstream * pos_z) / 2.0
	var l = length + slope_downstream * pos_z - slope_upstream * pos_z

	var position = Vector3(pos_x, 0, pos_z)
	var scale = Vector3(l / CONVEYOR_SCENE_BASE_LENGTH, 1, w / CONVEYOR_SCENE_BASE_WIDTH)

	return Transform3D(Basis().scaled(scale), position)

func _set_process_if_changed(cached_val, new_val) -> bool:
	var changed = cached_val != new_val
	if changed:
		set_process(true)
	return changed
