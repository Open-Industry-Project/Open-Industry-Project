@tool
class_name Pallet extends Node3D

@export var initial_linear_velocity: Vector3 = Vector3.ZERO

var rigid_body: RigidBody3D
var initial_transform: Transform3D
var instanced: bool = false
var _paused: bool = false
var enable_inital_transform: bool = false

func _enter_tree() -> void:
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)
	SimulationEvents.simulation_set_paused.connect(_on_simulation_set_paused)
	get_tree().current_scene

func _ready() -> void:
	rigid_body = $RigidBody3D
	rigid_body.freeze = not SimulationEvents.simulation_running
	if SimulationEvents.simulation_running:
		instanced = true
		rigid_body.linear_velocity = initial_linear_velocity

func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)
	SimulationEvents.simulation_set_paused.disconnect(_on_simulation_set_paused)
	if instanced:
		queue_free()

func Select() -> void:
	if _paused or not SimulationEvents.simulation_running:
		return
	if rigid_body.freeze:
		rigid_body.top_level = false
		if rigid_body.transform != Transform3D.IDENTITY:
			rigid_body.transform = Transform3D.IDENTITY
	else:
		rigid_body.top_level = true
		if transform != rigid_body.transform:
			transform = rigid_body.transform

func Use() -> void:
	rigid_body.freeze = not rigid_body.freeze

func _on_simulation_started() -> void:
	if not is_inside_tree():
		return
		
	initial_transform = global_transform
	rigid_body.linear_velocity = initial_linear_velocity
	rigid_body.top_level = true
	rigid_body.freeze = false
	enable_inital_transform = true

func _on_simulation_ended() -> void:
	if instanced:
		queue_free()
	else:
		rigid_body.top_level = false
		rigid_body.transform = Transform3D.IDENTITY
		rigid_body.linear_velocity = Vector3.ZERO
		rigid_body.angular_velocity = Vector3.ZERO
		# Work around for #83
		if enable_inital_transform:
			global_transform = initial_transform

func _on_simulation_set_paused(paused: bool) -> void:
	_paused = paused
	rigid_body.top_level = true
	rigid_body.freeze = paused
	transform = rigid_body.transform
	rigid_body.top_level = not paused
