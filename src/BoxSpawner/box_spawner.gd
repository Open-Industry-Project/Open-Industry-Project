@tool
class_name BoxSpawner
extends Node3D

@export var scene: PackedScene
@export var disable: bool = false:
	set(value):
		if value == disable:
			return
		disable = value
		if is_inside_tree():
			_change_texture()
			if not disable:
				_reset_spawn_cycle()

@export var box_color: Color = Color.WHITE:
	set(value):
		box_color = value

@export var random_size: bool = false
@export var random_size_min: Vector3 = Vector3(0.5, 0.5, 0.5)
@export var random_size_max: Vector3 = Vector3(1, 1, 1)
@export var initial_linear_velocity: Vector3 = Vector3.ZERO
@export var boxes_per_minute: int = 45:
	set(value):
		value = clamp(value, 0, 1000)
		boxes_per_minute = value

@export var fixed_rate: bool = true
@export var conveyor: Node3D = null:
	set(value):
		conveyor = value
		if not value:
			_conveyor_stopped = false

var _scan_interval: float = 0.0
var _conveyor_stopped: bool = false
var _next_spawn_time: float = 0.0
var _spawn_counter: int = 0
var _first_spawn_done: bool = false

@onready var disabled_box_texture: MeshInstance3D = $MeshInstance3D2

func _enter_tree() -> void:
	set_notify_local_transform(true)
	_reset_spawn_cycle()

func _ready() -> void:
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)
	_change_texture()

func _physics_process(delta: float) -> void:
	if disable or _conveyor_stopped or not SimulationEvents.simulation_running:
		return
	
	_scan_interval += delta

	if not _first_spawn_done:
		_spawn_box()
		_first_spawn_done = true
		_scan_interval = 0.0

	if fixed_rate:
		var time_between: float = 60.0 / float(boxes_per_minute)
		if _scan_interval >= time_between:
			_spawn_box()
			_scan_interval = 0.0
	else:
		if _scan_interval >= _next_spawn_time:
			_spawn_box()
			_spawn_counter += 1
			if _spawn_counter >= boxes_per_minute:
				_reset_spawn_cycle()
			else:
				_next_spawn_time = _scan_interval + (60.0 / boxes_per_minute) * randf_range(0.5, 1.5)

func _spawn_box() -> void:
	var box := scene.instantiate() as Box

	if random_size:
		var x := randf_range(random_size_min.x, random_size_max.x)
		var y := randf_range(random_size_min.y, random_size_max.y)
		var z := randf_range(random_size_min.z, random_size_max.z)
		box.size = Vector3(x, y, z)
	else:
		box.size = scale

	box.rotation = rotation
	box.position = position
	box.initial_linear_velocity = initial_linear_velocity
	box.color = box_color
	box.instanced = true
	add_child(box, true)
	box.owner = get_tree().edited_scene_root

func _reset_spawn_cycle() -> void:
	_scan_interval = 0.0
	_spawn_counter = 0
	_first_spawn_done = false
	_next_spawn_time = (60.0 / boxes_per_minute) * randf_range(0.5, 1.5)

func _change_texture() -> void:
	if not is_inside_tree():
		return
	disabled_box_texture.visible = disable

func use() -> void:
	disable = not disable

func _on_simulation_started() -> void:
	if conveyor:
		if conveyor.has_signal("speed_changed"):
			_conveyor_stopped = conveyor.speed == 0
			conveyor.connect("speed_changed", _conveyor_speed_changed)
		else:
			push_error("Conveyor in " + name + " is not of type Conveyor")
	_reset_spawn_cycle()

func _on_simulation_ended() -> void:
	if conveyor and conveyor.is_connected("speed_changed", _conveyor_speed_changed):
		conveyor.disconnect("speed_changed", _conveyor_speed_changed)

func _conveyor_speed_changed() -> void:
	_conveyor_stopped = conveyor.speed == 0
