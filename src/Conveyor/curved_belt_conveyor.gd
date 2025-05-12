@tool
class_name CurvedBeltConveyor
extends Node3D

enum ConvTexture {
	STANDARD,
	ALTERNATE
}

const BASE_INNER_RADIUS: float = 0.25
const BASE_OUTER_RADIUS: float = 1.25
const BASE_CONVEYOR_WIDTH: float = BASE_OUTER_RADIUS - BASE_INNER_RADIUS

@export var belt_color: Color = Color(1, 1, 1, 1):
	set(value):
		belt_color = value
		if _belt_material:
			(_belt_material as ShaderMaterial).set_shader_parameter("ColorMix", belt_color)
		var ce1 = get_conveyor_end1()
		var ce2 = get_conveyor_end2()
		if ce1 and ce1.belt_material:
			(ce1.belt_material as ShaderMaterial).set_shader_parameter("ColorMix", belt_color)
		if ce2 and ce2.belt_material:
			(ce2.belt_material as ShaderMaterial).set_shader_parameter("ColorMix", belt_color)

@export var belt_texture = ConvTexture.STANDARD:
	set(value):
		belt_texture = value
		if _belt_material:
			(_belt_material as ShaderMaterial).set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)
		var ce1 = get_conveyor_end1()
		var ce2 = get_conveyor_end2()
		if ce1 and ce1.belt_material:
			(ce1.belt_material as ShaderMaterial).set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)
		if ce2 and ce2.belt_material:
			(ce2.belt_material as ShaderMaterial).set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)

@export var speed: float = 2:
	set(value):
		if value == speed:
			return
		speed = value
		_recalculate_speeds()
		_update_belt_material_scale()

@export var reference_distance: float = 0.5:
	set(value):
		reference_distance = value
		_recalculate_speeds()

@export var belt_physics_material: PhysicsMaterial:
	get:
		var sb_node = get_node_or_null("StaticBody3D") as StaticBody3D
		if sb_node:
			return sb_node.physics_material_override
		return null
	set(value):
		var sb_node = get_node_or_null("StaticBody3D") as StaticBody3D
		if sb_node:
			sb_node.physics_material_override = value
		var sb_end1 = get_node_or_null("BeltConveyorEnd/StaticBody3D") as StaticBody3D
		if sb_end1:
			sb_end1.physics_material_override = value
		var sb_end2 = get_node_or_null("BeltConveyorEnd2/StaticBody3D") as StaticBody3D
		if sb_end2:
			sb_end2.physics_material_override = value

var _angular_speed: float = 0.0
var _linear_speed: float = 0.0
var _prev_scale_x: float = 0.0
var _sb: StaticBody3D
var _mesh: MeshInstance3D
var _belt_material: Material
var _metal_material: Material
var _belt_position: float = 0.0
var _origin: Vector3

var _register_speed_tag_ok: bool = false
var _register_running_tag_ok: bool = false
var _speed_tag_group_init: bool = false
var _running_tag_group_init: bool = false
var _enable_comms_changed: bool = false:
	set(value):
		notify_property_list_changed()

@export_category("Communications")
@export var enable_comms := false
@export var speed_tag_group_name: String
@export_custom(0, "tag_group_enum") var speed_tag_groups:
	set(value):
		speed_tag_group_name = value
		speed_tag_groups = value
@export var speed_tag_name := ""
@export var running_tag_group_name: String
@export_custom(0, "tag_group_enum") var running_tag_groups:
	set(value):
		running_tag_group_name = value
		running_tag_groups = value
@export var running_tag_name := ""

func _validate_property(property: Dictionary) -> void:
	if property.name == "enable_comms":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "speed_tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "speed_tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "speed_tag_name":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "running_tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "running_tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "running_tag_name":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE

func get_conveyor_end1() -> Node:
	return get_node_or_null("BeltConveyorEnd")

func get_conveyor_end2() -> Node:
	return get_node_or_null("BeltConveyorEnd2")

func _init() -> void:
	set_notify_local_transform(true)

func _ready() -> void:
	_sb = get_node("StaticBody3D") as StaticBody3D
	_mesh = get_node("StaticBody3D/MeshInstance3D") as MeshInstance3D
	_mesh.mesh = _mesh.mesh.duplicate()
	_metal_material = _mesh.mesh.surface_get_material(0).duplicate()
	_belt_material = _mesh.mesh.surface_get_material(1).duplicate()
	_mesh.mesh.surface_set_material(0, _metal_material)
	_mesh.mesh.surface_set_material(1, _belt_material)

	_origin = _sb.position

	(_belt_material as ShaderMaterial).set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)
	var ce1 = get_conveyor_end1()
	var ce2 = get_conveyor_end2()
	if ce1 and ce1.belt_material:
		(ce1.belt_material as ShaderMaterial).set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)
	if ce2 and ce2.belt_material:
		(ce2.belt_material as ShaderMaterial).set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)

	(_belt_material as ShaderMaterial).set_shader_parameter("ColorMix", belt_color)
	if ce1 and ce1.belt_material:
		(ce1.belt_material as ShaderMaterial).set_shader_parameter("ColorMix", belt_color)
	if ce2 and ce2.belt_material:
		(ce2.belt_material as ShaderMaterial).set_shader_parameter("ColorMix", belt_color)

	_recalculate_speeds()
	if ce1:
		ce1.speed = _linear_speed
	if ce2:
		ce2.speed = _linear_speed

	if ce1:
		var sb1 = ce1.get_node("StaticBody3D") as StaticBody3D
		if sb1:
			sb1.physics_material_override = _sb.physics_material_override
	if ce2:
		var sb2 = ce2.get_node("StaticBody3D") as StaticBody3D
		if sb2:
			sb2.physics_material_override = _sb.physics_material_override

	_prev_scale_x = scale.x

func _enter_tree() -> void:
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)
	OIPComms.tag_group_initialized.connect(_tag_group_initialized)
	OIPComms.tag_group_polled.connect(_tag_group_polled)
	OIPComms.enable_comms_changed.connect(func() -> void: _enable_comms_changed = OIPComms.get_enable_comms())

func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)
	OIPComms.tag_group_initialized.disconnect(_tag_group_initialized)
	OIPComms.tag_group_polled.disconnect(_tag_group_polled)

func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		set_notify_local_transform(false)
		scale = Vector3(scale.x, 1, scale.x)
		set_notify_local_transform(true)
		_on_scale_changed()

func _on_scale_changed() -> void:
	if _prev_scale_x != scale.x:
		_recalculate_speeds()
		notify_property_list_changed()
		if scale.x > 1.0:
			_update_belt_material_scale()
			_update_metal_material_scale()
		var ce1 = get_conveyor_end1()
		var ce2 = get_conveyor_end2()
		if ce1:
			ce1.scale = scale.inverse()
			ce1.size.z = scale.x
		if ce2:
			ce2.scale = Vector3(scale.z, scale.y, scale.x).inverse()
			ce2.size.z = scale.z
		_prev_scale_x = scale.x

func _recalculate_speeds() -> void:
	var reference_radius: float = scale.x * BASE_OUTER_RADIUS - reference_distance
	_angular_speed = 0.0 if reference_radius == 0.0 else speed / reference_radius
	_linear_speed = _angular_speed * (scale.x * (BASE_OUTER_RADIUS + BASE_INNER_RADIUS) / 2.0)
	var ce1 = get_conveyor_end1()
	var ce2 = get_conveyor_end2()
	if ce1:
		ce1.speed = _linear_speed
	if ce2:
		ce2.speed = _linear_speed

func _physics_process(delta: float) -> void:
	if SimulationEvents.simulation_running:
		var local_up = _sb.global_transform.basis.y.normalized()
		var velocity = -local_up * _angular_speed
		_sb.constant_angular_velocity = velocity
		if not SimulationEvents.simulation_paused:
			_belt_position += _linear_speed * delta
		if _linear_speed != 0:
			(_belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", _belt_position * sign(_linear_speed))
		if _belt_position >= 1.0:
			_belt_position = 0.0

func _update_belt_material_scale() -> void:
	if _belt_material and speed != 0:
		(_belt_material as ShaderMaterial).set_shader_parameter("Scale", scale.x / 2.0 * sign(speed))

func _update_metal_material_scale() -> void:
	if _metal_material:
		(_metal_material as ShaderMaterial).set_shader_parameter("Scale", scale.x / 2.0)

func _on_simulation_started() -> void:
	if enable_comms:
		_register_speed_tag_ok = OIPComms.register_tag(speed_tag_group_name, speed_tag_name, 1)
		_register_running_tag_ok = OIPComms.register_tag(running_tag_group_name, running_tag_name, 1)

func _on_simulation_ended() -> void:
	_belt_position = 0.0
	(_belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", _belt_position)
	for child in _sb.get_children():
		if child is Node3D:
			child.position = Vector3.ZERO
			child.rotation = Vector3.ZERO

func _tag_group_initialized(tag_group_name_param: String) -> void:
	if tag_group_name_param == speed_tag_group_name:
		_speed_tag_group_init = true
	if tag_group_name_param == running_tag_group_name:
		_running_tag_group_init = true

func _tag_group_polled(tag_group_name_param: String) -> void:
	if not enable_comms:
		return

	if tag_group_name_param == speed_tag_group_name and _speed_tag_group_init:
		speed = OIPComms.read_float32(speed_tag_group_name, speed_tag_name)
