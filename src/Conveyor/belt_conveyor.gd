@tool
class_name BeltConveyor
extends Node3D

enum ConvTexture {
	STANDARD,
	ALTERNATE
}

signal speed_changed

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


@export var Speed: float = 2:
	set(value):
		if value == Speed:
			return
		Speed = value
		speed_changed.emit()
		var ce1 = get_conveyor_end1()
		var ce2 = get_conveyor_end2()
		if ce1:
			ce1.Speed = Speed
		if ce2:
			ce2.Speed = Speed
		UpdateBeltMaterialScale()
		
		# dont write until the group is initialized
		if register_speed_tag_ok and speed_tag_group_init:
			OIPComms.write_float32(speed_tag_group_name, speed_tag_name, value)
		
		if register_running_tag_ok and running_tag_group_init:
			OIPComms.write_bit(running_tag_group_name, running_tag_name, value > 0.0)

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

var register_speed_tag_ok := false
var register_running_tag_ok := false
var speed_tag_group_init := false
var running_tag_group_init := false

@export_category("Communications")
@export var enable_comms := true
@export var speed_tag_group_name: String
@export_custom(0,"tag_group_enum") var speed_tag_groups:
	set(value):
		speed_tag_group_name = value
		speed_tag_groups = value
@export var speed_tag_name := ""
@export var running_tag_group_name: String
@export_custom(0,"tag_group_enum") var running_tag_groups:
	set(value):
		running_tag_group_name = value
		running_tag_groups = value
@export var running_tag_name := ""

func _validate_property(property: Dictionary):
	if property.name == "speed_tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "speed_tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE
	elif property.name == "running_tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "running_tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE
		
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
			
	UpdateBeltMaterialScale()
	UpdateMetalMaterialScale()

func _enter_tree() -> void:
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)
	OIPComms.tag_group_initialized.connect(_tag_group_initialized)
	OIPComms.tag_group_polled.connect(_tag_group_polled)

func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)
	OIPComms.tag_group_initialized.disconnect(_tag_group_initialized)
	OIPComms.tag_group_polled.disconnect(_tag_group_polled)

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

func _on_simulation_started() -> void:
	if enable_comms:
		register_speed_tag_ok = OIPComms.register_tag(speed_tag_group_name, speed_tag_name, 1)
		register_running_tag_ok = OIPComms.register_tag(running_tag_group_name, running_tag_name, 1)

func _on_simulation_ended() -> void:
	belt_position = 0.0
	(belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", belt_position)
	sb.constant_linear_velocity = Vector3.ZERO
	for child in sb.get_children():
		if child is Node3D:
			child.position = Vector3.ZERO
			child.rotation = Vector3.ZERO

func _tag_group_initialized(_tag_group_name: String) -> void:
	if _tag_group_name == speed_tag_group_name:
		speed_tag_group_init = true
	if _tag_group_name == running_tag_group_name:
		running_tag_group_init = true

func _tag_group_polled(_tag_group_name: String) -> void:
	if not enable_comms: return
	
	if _tag_group_name == speed_tag_group_name and speed_tag_group_init:
		Speed = OIPComms.read_float32(speed_tag_group_name, speed_tag_name)
