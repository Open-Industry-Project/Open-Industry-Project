@tool
extends Node3D

enum ConvTexture {
	STANDARD,
	ALTERNATE
}

const BASE_INNER_RADIUS: float = 0.25
const BASE_OUTER_RADIUS: float = 1.25
const BASE_CONVEYOR_WIDTH: float = BASE_OUTER_RADIUS - BASE_INNER_RADIUS

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
		RecalculateSpeeds()
		UpdateBeltMaterialScale()

var AngularSpeed: float = 0.0
var LinearSpeed: float = 0.0
var prev_scale_x: float = 0.0

@export var ReferenceDistance: float:
	set(value):
		ReferenceDistance = value
		RecalculateSpeeds()

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

var origin: Vector3
var running: bool = false
var belt_position: float = 0.0

func get_conveyor_end1():
	return get_node_or_null("ConveyorEnd")
func get_conveyor_end2():
	return get_node_or_null("ConveyorEnd2")

# Dynamically update the ReferenceDistance property hint.
func _get_property_list() -> Array:
	var properties = []
	properties.append({
		"name": "ReferenceDistance",
		"type": TYPE_FLOAT,
		"usage": PROPERTY_USAGE_DEFAULT,
		"hint": PROPERTY_HINT_RANGE,
		"hint_string": "0," + str(scale.x * BASE_CONVEYOR_WIDTH) + ",suffix:m"
	})
	return properties

func _init() -> void:
	set_notify_local_transform(true)

func _ready() -> void:
	sb = get_node("StaticBody3D") as StaticBody3D
	mesh = get_node("StaticBody3D/MeshInstance3D") as MeshInstance3D
	mesh.mesh = mesh.mesh.duplicate()
	metal_material = mesh.mesh.surface_get_material(0).duplicate()
	belt_material = mesh.mesh.surface_get_material(1).duplicate()
	mesh.mesh.surface_set_material(0, metal_material)
	mesh.mesh.surface_set_material(1, belt_material)
	
	origin = sb.position
	
	(belt_material as ShaderMaterial).set_shader_parameter("BlackTextureOn", BeltTexture == ConvTexture.STANDARD)
	var ce1 = get_conveyor_end1()
	var ce2 = get_conveyor_end2()
	if ce1 and ce1.belt_material:
		(ce1.belt_material as ShaderMaterial).set_shader_parameter("BlackTextureOn", BeltTexture == ConvTexture.STANDARD)
	if ce2 and ce2.belt_material:
		(ce2.belt_material as ShaderMaterial).set_shader_parameter("BlackTextureOn", BeltTexture == ConvTexture.STANDARD)
	
	(belt_material as ShaderMaterial).set_shader_parameter("ColorMix", BeltColor)
	if ce1 and ce1.belt_material:
		(ce1.belt_material as ShaderMaterial).set_shader_parameter("ColorMix", BeltColor)
	if ce2 and ce2.belt_material:
		(ce2.belt_material as ShaderMaterial).set_shader_parameter("ColorMix", BeltColor)
	
	RecalculateSpeeds()
	if ce1:
		ce1.Speed = LinearSpeed
	if ce2:
		ce2.Speed = LinearSpeed
	
	if ce1:
		var sb1 = ce1.get_node("StaticBody3D") as StaticBody3D
		if sb1:
			sb1.physics_material_override = sb.physics_material_override
	if ce2:
		var sb2 = ce2.get_node("StaticBody3D") as StaticBody3D
		if sb2:
			sb2.physics_material_override = sb.physics_material_override
	
	prev_scale_x = scale.x

func _enter_tree() -> void:
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)


func _exit_tree() -> void:
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)

func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		set_notify_local_transform(false)
		scale = Vector3(scale.x, 1, scale.x)
		set_notify_local_transform(true)
		OnScaleChanged()

func OnScaleChanged() -> void:
	if prev_scale_x != scale.x:
		RecalculateSpeeds()
		notify_property_list_changed()
		if scale.x > 1.0:
			UpdateBeltMaterialScale()
			UpdateMetalMaterialScale()
		var ce1 = get_conveyor_end1()
		var ce2 = get_conveyor_end2()
		if ce1:
			ce1.OnOwnerScaleChanged(scale)
		if ce2:
			ce2.OnOwnerScaleChanged(scale)
		prev_scale_x = scale.x

func RecalculateSpeeds() -> void:
	var reference_radius: float = scale.x * BASE_OUTER_RADIUS - ReferenceDistance
	AngularSpeed = 0.0 if reference_radius == 0.0 else Speed / reference_radius
	LinearSpeed = AngularSpeed * (scale.x * (BASE_OUTER_RADIUS + BASE_INNER_RADIUS) / 2.0)
	var ce1 = get_conveyor_end1()
	var ce2 = get_conveyor_end2()
	if ce1:
		ce1.Speed = LinearSpeed
	if ce2:
		ce2.Speed = LinearSpeed

func _physics_process(delta: float) -> void:
	if SimulationEvents.simulation_running:
		var local_up = sb.global_transform.basis.y.normalized()
		var velocity = -local_up * AngularSpeed
		sb.constant_angular_velocity = velocity
		if not SimulationEvents.simulation_paused:
			belt_position += LinearSpeed * delta
		if LinearSpeed != 0:
			(belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", belt_position * sign(LinearSpeed))
		if belt_position >= 1.0:
			belt_position = 0.0

func UpdateBeltMaterialScale() -> void:
	if belt_material and Speed != 0:
		(belt_material as ShaderMaterial).set_shader_parameter("Scale", scale.x / 2.0 * sign(Speed))

func UpdateMetalMaterialScale() -> void:
	if metal_material:
		(metal_material as ShaderMaterial).set_shader_parameter("Scale", scale.x / 2.0)

func _on_simulation_ended() -> void:
	belt_position = 0.0
	(belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", belt_position)
	for child in sb.get_children():
		if child is Node3D:
			child.position = Vector3.ZERO
			child.rotation = Vector3.ZERO
