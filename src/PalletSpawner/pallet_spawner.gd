@tool
class_name PalletSpawner
extends Node3D

## The pallet scene to spawn (must be a Pallet-derived PackedScene).
@export var scene: PackedScene
## When enabled, stops spawning new pallets.
@export var disable: bool = false:
	set(value):
		if value == disable:
			return
		disable = value
		if not disable:
			_reset_spawn_cycle()
		_change_texture()

## Initial velocity applied to spawned pallets.
@export var spawn_initial_linear_velocity: Vector3 = Vector3.ZERO
@export var pallets_per_minute: int = 10:
	set(value):
		value = clampi(value, 1, 1000)
		pallets_per_minute = value
## When true, pallets spawn at a fixed rate. When false, spawn times vary randomly.
@export var fixed_rate: bool = true

var _scan_interval: float = 0.0
var _next_spawn_time: float = 0.0
var _first_spawn_done: bool = false

@onready var disabled_pallet: MeshInstance3D = $Disabled_Pallet

func _enter_tree() -> void:
	set_notify_local_transform(true)
	_reset_spawn_cycle()
	EditorInterface.simulation_started.connect(_on_simulation_started)
	EditorInterface.simulation_stopped.connect(_on_simulation_ended)

func _ready() -> void:
	set_physics_process(EditorInterface.is_simulation_running())
	_change_texture()

func _exit_tree() -> void:
	EditorInterface.simulation_started.disconnect(_on_simulation_started)
	EditorInterface.simulation_stopped.disconnect(_on_simulation_ended)

func _physics_process(delta: float) -> void:
	if disable or not EditorInterface.is_simulation_running():
		return

	_scan_interval += delta

	if not _first_spawn_done:
		_spawn_box()
		_first_spawn_done = true
		_scan_interval = 0.0

	if fixed_rate:
		var time_between: float = 60.0 / float(pallets_per_minute)
		if _scan_interval >= time_between:
			_spawn_box()
			_scan_interval -= time_between
	else:
		if _scan_interval >= _next_spawn_time:
			_spawn_box()
			_next_spawn_time = (60.0 / pallets_per_minute) * randf_range(0.5, 1.5)
			_scan_interval = 0.0

func _spawn_box() -> void:
	var pallet := scene.instantiate() as Pallet

	pallet.rotation = rotation
	pallet.position = position
	pallet.initial_linear_velocity = spawn_initial_linear_velocity
	pallet.instanced = true
	add_child(pallet, true)
	pallet.owner = get_tree().edited_scene_root

func _reset_spawn_cycle() -> void:
	_scan_interval = 0.0
	_first_spawn_done = false
	_next_spawn_time = (60.0 / pallets_per_minute) * randf_range(0.5, 1.5)

func use() -> void:
	disable = not disable

func _change_texture() -> void:
	if not is_inside_tree():
		return
	disabled_pallet.visible = disable

func _on_simulation_started() -> void:
	set_physics_process(true)
	_reset_spawn_cycle()

func _on_simulation_ended() -> void:
	set_physics_process(false)
