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
			
@export var spawn_random_scale: bool = false
@export var spawn_random_size_min: Vector3 = Vector3(0.5, 0.5, 0.5)
@export var spawn_random_size_max: Vector3 = Vector3(1, 1, 1)
@export var spawn_initial_linear_velocity: Vector3 = Vector3.ZERO
@export var spawn_interval: float = 1.0

var scan_interval: float = 0.0

func _enter_tree() -> void:
	set_notify_local_transform(true)
	scan_interval = spawn_interval
	
func _ready() -> void:
	SimulationEvents.simulation_started.connect(_on_simulation_started)

func _physics_process(delta: float) -> void:
	if disable || not SimulationEvents.simulation_running:
		return
		
	scan_interval += delta
	if scan_interval >= spawn_interval:
		scan_interval = 0
		_spawn_box()

func _spawn_box() -> void:
	var box = scene.instantiate() as Box

	if spawn_random_scale:
		var x = randf_range(spawn_random_size_min.x, spawn_random_size_max.x)
		var y = randf_range(spawn_random_size_min.y, spawn_random_size_max.y)
		var z = randf_range(spawn_random_size_min.z, spawn_random_size_max.z)
		box.scale = Vector3(x, y, z)
	else:
		box.scale = scale
		
	box.rotation = rotation
	box.position = position
	box.initial_linear_velocity = spawn_initial_linear_velocity
	box.instanced = true
	add_child(box,true)
	box.owner = get_tree().edited_scene_root

func use() -> void:
	disable = !disable

func _on_simulation_started() -> void:
	scan_interval = spawn_interval
