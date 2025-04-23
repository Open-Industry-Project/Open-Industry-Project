@tool
class_name Box extends Node3D

@export var initial_linear_velocity: Vector3 = Vector3.ZERO

@export var color : Color = Color.WHITE:
	set(value):
		color = value
		if(mesh_instance_3d):
			var mat : StandardMaterial3D
			mesh_instance_3d.mesh = mesh_instance_3d.mesh.duplicate()
			mat = mesh_instance_3d.mesh.surface_get_material(0).duplicate()
			mat.albedo_color = color
			mesh_instance_3d.mesh.surface_set_material(0,mat)
		

@onready var rigid_body_3d: RigidBody3D = $RigidBody3D
@onready var mesh_instance_3d: MeshInstance3D = $RigidBody3D/MeshInstance3D
var _initial_transform: Transform3D
var _paused: bool = false
var _enable_inital_transform: bool = false

var instanced: bool = false

func _enter_tree() -> void:
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)
	SimulationEvents.simulation_set_paused.connect(_on_simulation_set_paused)

func _ready() -> void:
	if color != Color.WHITE:
		set("color",color)
	rigid_body_3d.freeze = not SimulationEvents.simulation_running
	if SimulationEvents.simulation_running:
		instanced = true
		rigid_body_3d.linear_velocity = initial_linear_velocity

func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)
	SimulationEvents.simulation_set_paused.disconnect(_on_simulation_set_paused)
	if instanced:
		queue_free()

func selected() -> void:
	if _paused or not SimulationEvents.simulation_running:
		return
	if rigid_body_3d.freeze:
		rigid_body_3d.top_level = false
		if rigid_body_3d.transform != Transform3D.IDENTITY:
			rigid_body_3d.transform = Transform3D.IDENTITY
	else:
		rigid_body_3d.top_level = true
		if transform != rigid_body_3d.transform:
			transform = rigid_body_3d.transform

func use() -> void:
	rigid_body_3d.freeze = not rigid_body_3d.freeze
	
func _on_simulation_started() -> void:
	if(_enable_inital_transform):
		return
		
	_initial_transform = global_transform
	rigid_body_3d.linear_velocity = initial_linear_velocity
	rigid_body_3d.top_level = true
	rigid_body_3d.freeze = false
	_enable_inital_transform = true

func _on_simulation_ended() -> void:
	if instanced:
		queue_free()
	else:
		rigid_body_3d.top_level = false
		rigid_body_3d.transform = Transform3D.IDENTITY
		rigid_body_3d.linear_velocity = Vector3.ZERO
		rigid_body_3d.angular_velocity = Vector3.ZERO
		# Work around for #83
		if _enable_inital_transform:
			global_transform = _initial_transform
			_enable_inital_transform = false

func _on_simulation_set_paused(paused: bool) -> void:
	_paused = paused
	rigid_body_3d.top_level = true
	rigid_body_3d.freeze = paused
	transform = rigid_body_3d.transform
	rigid_body_3d.top_level = not paused
