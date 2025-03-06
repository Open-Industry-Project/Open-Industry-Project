@tool
extends Node3D

@export var Speed: float:
	set(value):
		Speed = value
		UpdateBeltMaterialScale()
		UpdateBeltMaterialPosition()

var belt_position: float = 0.0
var running: bool = false
var static_body: StaticBody3D
var mesh: MeshInstance3D
var belt_material: ShaderMaterial
var belt_shader: Shader

var prev_scale_x: float = 0.0

func _ready() -> void:
	static_body = get_node("StaticBody3D") as StaticBody3D
	mesh = get_node("MeshInstance3D") as MeshInstance3D
	mesh.mesh = mesh.mesh.duplicate()
	belt_material = mesh.mesh.surface_get_material(0).duplicate() as ShaderMaterial
	mesh.mesh.surface_set_material(0, belt_material)
	belt_shader = belt_material.shader.duplicate() as Shader
	belt_material.shader = belt_shader

func OnOwnerScaleChanged(new_owner_scale: Vector3) -> void:
	if new_owner_scale.x != prev_scale_x:
		scale = Vector3(1 / new_owner_scale.x, 1, 1)
		prev_scale_x = new_owner_scale.x

func _physics_process(delta: float) -> void:
	if SimulationEvents.simulation_running:
		var local_front = global_transform.basis.z.normalized()
		if not SimulationEvents.simulation_paused:
			belt_position += Speed * delta
		if belt_position >= 1.0:
			belt_position = 0.0
		var radius: float = 0.25
		static_body.constant_angular_velocity = local_front * Speed / radius
		UpdateBeltMaterialPosition()
	else:
		belt_position = 0.0
		static_body.constant_angular_velocity = Vector3.ZERO
		UpdateBeltMaterialPosition()

func UpdateBeltMaterialScale() -> void:
	if belt_material && Speed != 0:
		(belt_material as ShaderMaterial).set_shader_parameter("Scale", sign(Speed))

func UpdateBeltMaterialPosition() -> void:
	if belt_material:
		(belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", belt_position * sign(-Speed))
