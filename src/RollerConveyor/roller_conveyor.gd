@tool
extends Node3D
class_name RollerConveyor

signal width_changed(width: float)
signal length_changed(length: float)
signal scale_changed(scale: Vector3)
signal roller_skew_angle_changed(skew_angle_degrees: float)
signal set_speed(speed: float)
signal roller_override_material_changed(material: Material)

const RADIUS: float = 0.12
const CIRCUMFERENCE: float = 2.0 * PI * RADIUS
const BASE_WIDTH: float = 1.0
const FRAME_BASE_WIDTH: float = 2.0

@export var enable_comms: bool = false:
	set(value):
		enable_comms = value
		notify_property_list_changed()

@export var tag: String = ""
@export var update_rate: int = 100
@export var speed: float = 2.0:
	set(value):
		speed = value
		set_speed.emit(value)

@export var skew_angle: float = 0.0:
	set(value):
		if skew_angle != value:
			skew_angle = value
			roller_skew_angle_changed.emit(skew_angle)

var node_scale_x: float = 1.0
var node_scale_z: float = 1.0
var last_scale: Vector3 = Vector3.ONE
var last_length: float = 1.0
var last_width: float = NAN
var previous_transform: Transform3D = Transform3D.IDENTITY

var metal_material: Material
var rollers: Rollers
var ends: Node3D
var roller_material: StandardMaterial3D

func _init() -> void:
	set_notify_local_transform(true)

func _validate_property(property: Dictionary) -> void:
	var property_name: String = property["name"]
	if property_name in ["update_rate", "tag"]:
		property["usage"] = PROPERTY_USAGE_DEFAULT if enable_comms else PROPERTY_USAGE_NO_EDITOR

func _ready() -> void:
	var mesh_instance1 = get_node("ConvRoller/ConvRollerL") as MeshInstance3D
	var mesh_instance2 = get_node("ConvRoller/ConvRollerR") as MeshInstance3D
	mesh_instance1.mesh = mesh_instance1.mesh.duplicate()
	metal_material = mesh_instance1.mesh.surface_get_material(0).duplicate()
	mesh_instance1.mesh.surface_set_material(0, metal_material)
	mesh_instance2.mesh.surface_set_material(0, metal_material)
	update_metal_material_scale()

func _physics_process(delta: float) -> void:
	if not SimulationEvents:
		return

	if SimulationEvents.simulation_running and not SimulationEvents.simulation_paused:
		roller_material.uv1_offset += Vector3(4.0 * speed / CIRCUMFERENCE * delta, 0, 0)

	if enable_comms and SimulationEvents.simulation_running:
		# Additional communication logic would go here
		pass

func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		if not is_transform_valid():
			constrain_transform.call_deferred()
			return
		update_scale()
		update_width()
		update_length()
		update_size()
	elif what == NOTIFICATION_SCENE_INSTANTIATED:
		on_scene_instantiated()

func on_scene_instantiated() -> void:
	set_roller_override_material(load("res://assets/3DModels/Materials/Metall2.tres").duplicate(true))

	rollers = get_node_or_null("Rollers")
	ends = get_node_or_null("Ends")

	setup_roller_container(rollers)
	for end in ends.get_children():
		if end is RollerConveyorEnd:
			setup_roller_container(end)

	# In case transform was changed before scene was instantiated somehow.
	update_scale()
	update_width()
	update_length()
	update_size()

func setup_roller_container(container: AbstractRollerContainer) -> void:
	if not container:
		return

	container.roller_added.connect(_on_roller_added)
	container.roller_removed.connect(_on_roller_removed)

	roller_skew_angle_changed.connect(container.set_roller_skew_angle)
	scale_changed.connect(container.on_owner_scale_changed)
	width_changed.connect(container.set_width)
	length_changed.connect(container.set_length)

	container.setup_existing_rollers()
	container.set_roller_skew_angle(skew_angle)
	container.on_owner_scale_changed(scale)
	container.set_width(scale.z * BASE_WIDTH)
	container.set_length(scale.x)

func _on_roller_added(roller: Roller) -> void:
	set_speed.connect(roller.set_speed)
	roller_override_material_changed.connect(roller.set_roller_override_material)
	roller.set_speed(speed)
	roller.set_roller_override_material(roller_material)

func _on_roller_removed(roller: Roller) -> void:
	if set_speed.is_connected(roller.set_speed):
		set_speed.disconnect(roller.set_speed)
	if roller_override_material_changed.is_connected(roller.set_roller_override_material):
		roller_override_material_changed.disconnect(roller.set_roller_override_material)

func constrain_transform() -> void:
	var current_transform = transform
	if current_transform != previous_transform:
		var new_basis: Basis
		var _scale = current_transform.basis.get_scale()
		if _scale.x <= 0 or _scale.y <= 0 or _scale.z <= 0:
			new_basis = previous_transform.basis
		else:
			new_basis = current_transform.basis

		new_basis.x = max(1.0, abs(_scale.x)) * new_basis.x.normalized()
		new_basis.y = new_basis.y.normalized()
		new_basis.z = max(0.1, abs(_scale.z)) * new_basis.z.normalized()
		transform = Transform3D(new_basis, current_transform.origin)

	previous_transform = transform

func is_transform_valid() -> bool:
	return scale.x >= 1.0 and scale.y == 1.0 and scale.z >= 0.1

func update_scale() -> void:
	if last_scale != scale:
		scale_changed.emit(scale)
		last_scale = scale

		var simple_conveyor_shape_body = get_node("SimpleConveyorShape")
		simple_conveyor_shape_body.scale = scale.inverse()

		update_metal_material_scale()

func update_width() -> void:
	var new_width = scale.z * BASE_WIDTH
	if last_width != new_width:
		update_sides_mesh_scale(new_width)
		width_changed.emit(new_width)
		last_width = new_width

func update_length() -> void:
	# Note: This length measurement doesn't include the extra 0.5m from Ends.
	var new_length = scale.x
	if last_length != new_length:
		length_changed.emit(new_length)
		last_length = new_length

func update_size() -> void:
	var simple_conveyor_shape_node = get_node("SimpleConveyorShape/CollisionShape3D")
	var simple_conveyor_shape = simple_conveyor_shape_node.shape as BoxShape3D
	simple_conveyor_shape.size = get_size()

func update_sides_mesh_scale(width: float) -> void:
	var mesh_instance1 = get_node("ConvRoller/ConvRollerL")
	var mesh_instance2 = get_node("ConvRoller/ConvRollerR")
	mesh_instance1.scale = Vector3(1.0, 1.0, FRAME_BASE_WIDTH * BASE_WIDTH / width)
	mesh_instance2.scale = Vector3(1.0, 1.0, FRAME_BASE_WIDTH * BASE_WIDTH / width)

func get_size() -> Vector3:
	var length = scale.x + 0.5
	var width = scale.z
	var height = 0.24
	return Vector3(length, height, width)

func set_size(value: Vector3) -> void:
	scale = Vector3(value.x - 0.5, 1.0, value.z)

func update_metal_material_scale() -> void:
	if metal_material is ShaderMaterial:
		metal_material.set_shader_parameter("Scale", scale.x)

func set_roller_override_material(material: StandardMaterial3D) -> void:
	if roller_material != material:
		roller_material = material
		roller_override_material_changed.emit(roller_material)
