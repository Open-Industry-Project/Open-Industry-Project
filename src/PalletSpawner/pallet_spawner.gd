@tool
extends Node3D

@export var scene: PackedScene

@export var disable: bool = false:
	set(value):
		if(value == disable):
			return
		disable = value
		if(!disable):
			scan_interval = spawn_interval 

@export var spawn_initial_linear_velocity: Vector3 = Vector3.ZERO
@export var spawn_interval: float = 1.0

var scan_interval: float = 0.0

func _enter_tree() -> void:
	set_notify_local_transform(true)
	scan_interval = spawn_interval
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)

func _ready() -> void:
	set_physics_process(SimulationEvents.simulation_running)

func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)

func _physics_process(delta: float) -> void:
	if disable:
		return
		
	scan_interval += delta
	if scan_interval > spawn_interval:
		scan_interval = 0
		_spawn_box()

func _spawn_box() -> void:
	var pallet = scene.instantiate() as Pallet
		
	pallet.rotation = rotation
	pallet.position = position
	pallet.initial_linear_velocity = spawn_initial_linear_velocity
	pallet.instanced = true
	add_child(pallet,true)
	pallet.owner = get_tree().edited_scene_root

func Use() -> void:
	disable = !disable

func _on_simulation_started() -> void:
	set_physics_process(true)
	scan_interval = spawn_interval

func _on_simulation_ended() -> void:
	set_physics_process(false)
