@tool
extends Node3D

enum ConvTexture {
	STANDARD,
	ALTERNATE
}

@export var BeltColor : Color = Color(1, 1, 1, 1):
	set(value):
		BeltColor = value
		if belt_material:
			(belt_material as ShaderMaterial).set_shader_parameter("ColorMix", BeltColor)
		var ce1 = get_conveyor_end1()
		var ce2 = get_conveyor_end2()
		if ce1 and ce1.belt_material:
			(ce1.belt_material as ShaderMaterial).set_shader_parameter("ColorMix", BeltColor)
		if ce2 and ce2.belt_material:
			(ce2.belt_material as ShaderMaterial).set_shader_parameter("ColorMix", BeltColor)

@export var BeltTexture = ConvTexture.STANDARD:
	set(value):
		BeltTexture = value
		if belt_material:
			(belt_material as ShaderMaterial).set_shader_parameter("BlackTextureOn", BeltTexture == ConvTexture.STANDARD)
		var ce1 = get_conveyor_end1()
		var ce2 = get_conveyor_end2()
		if ce1 and ce1.belt_material:
			(ce1.belt_material as ShaderMaterial).set_shader_parameter("BlackTextureOn", BeltTexture == ConvTexture.STANDARD)
		if ce2 and ce2.belt_material:
			(ce2.belt_material as ShaderMaterial).set_shader_parameter("BlackTextureOn", BeltTexture == ConvTexture.STANDARD)


@export var Speed: float:
	set(value):
		if value == Speed:
			return
		Speed = value
		var ce1 = get_conveyor_end1()
		var ce2 = get_conveyor_end2()
		if ce1:
			ce1.Speed = Speed
		if ce2:
			ce2.Speed = Speed
		UpdateBeltMaterialScale()

@export var BeltPhysicsMaterial : PhysicsMaterial:
	get:
		var sb_node = get_node_or_null("StaticBody3D") as StaticBody3D
		if sb_node:
			return sb_node.physics_material_override
		return null
	set(value):
		var sb_node = get_node_or_null("StaticBody3D") as StaticBody3D
		if sb_node:
			sb_node.physics_material_override = value
		var sb_end1 = get_node_or_null("ConveyorEnd/StaticBody3D") as StaticBody3D
		if sb_end1:
			sb_end1.physics_material_override = value
		var sb_end2 = get_node_or_null("ConveyorEnd2/StaticBody3D") as StaticBody3D
		if sb_end2:
			sb_end2.physics_material_override = value

var sb: StaticBody3D
var mesh: MeshInstance3D
var belt_material: Material
var metal_material: Material
var belt_position: float = 0.0
var box_size: Vector3

var Main

func get_conveyor_end1():
	return get_node_or_null("ConveyorEnd")
func get_conveyor_end2():
	return get_node_or_null("ConveyorEnd2")

func _init() -> void:
	set_notify_local_transform(true)

func _ready() -> void:
	sb = get_node("StaticBody3D") as StaticBody3D
	mesh = get_node("StaticBody3D/MeshInstance3D") as MeshInstance3D
	mesh.mesh = mesh.mesh.duplicate() as Mesh
	belt_material = mesh.mesh.surface_get_material(0).duplicate() as Material
	metal_material = mesh.mesh.surface_get_material(1).duplicate() as Material
	mesh.mesh.surface_set_material(0, belt_material)
	mesh.mesh.surface_set_material(1, metal_material)
	mesh.mesh.surface_set_material(2, metal_material)
	
	belt_material.set_shader_parameter("BlackTextureOn", BeltTexture == ConvTexture.STANDARD)
	var ce1 = get_conveyor_end1()
	var ce2 = get_conveyor_end2()
	if ce1 and ce1.belt_material:
		ce1.belt_material.set_shader_parameter("BlackTextureOn", BeltTexture == ConvTexture.STANDARD)
	if ce2 and ce2.belt_material:
		ce2.belt_material.set_shader_parameter("BlackTextureOn", BeltTexture == ConvTexture.STANDARD)
	
	belt_material.set_shader_parameter("ColorMix", BeltColor)
	if ce1 and ce1.belt_material:
		ce1.belt_material.set_shader_parameter("ColorMix", BeltColor)
	if ce2 and ce2.belt_material:
		ce2.belt_material.set_shader_parameter("ColorMix", BeltColor)
	
	if ce1:
		ce1.Speed = Speed
	if ce2:
		ce2.Speed = Speed
	
	if ce1:
		var sb1 = ce1.get_node("StaticBody3D") as StaticBody3D
		if sb1:
			sb1.physics_material_override = sb.physics_material_override
	if ce2:
		var sb2 = ce2.get_node("StaticBody3D") as StaticBody3D
		if sb2:
			sb2.physics_material_override = sb.physics_material_override

func _enter_tree() -> void:
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)

func _exit_tree() -> void:
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)

func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		if scale.y != 1:
			scale = Vector3(scale.x, 1, scale.z)
			return
		_on_scale_changed()

func _on_scale_changed() -> void:
	UpdateBeltMaterialScale()
	UpdateMetalMaterialScale()
	var ce1 = get_conveyor_end1()
	var ce2 = get_conveyor_end2()
	if ce1:
		ce1.OnOwnerScaleChanged(scale)
	if ce2:
		ce2.OnOwnerScaleChanged(scale)

func _physics_process(delta: float) -> void:
	if SimulationEvents.simulation_running:
		var local_left = sb.global_transform.basis.x.normalized()
		var velocity = local_left * Speed
		sb.constant_linear_velocity = velocity
		if !SimulationEvents.simulation_paused:
			belt_position += Speed * delta
		if Speed != 0:
			(belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", belt_position * sign(Speed))
		if belt_position >= 1.0:
			belt_position = 0.0

func UpdateBeltMaterialScale() -> void:
	if belt_material and Speed != 0:
		(belt_material as ShaderMaterial).set_shader_parameter("Scale", scale.x * sign(Speed))

func UpdateMetalMaterialScale() -> void:
	if metal_material:
		(metal_material as ShaderMaterial).set_shader_parameter("Scale", scale.x)

func _on_simulation_ended() -> void:
	belt_position = 0.0
	(belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", belt_position)
	sb.constant_linear_velocity = Vector3.ZERO
	for child in sb.get_children():
		if child is Node3D:
			child.position = Vector3.ZERO
			child.rotation = Vector3.ZERO
