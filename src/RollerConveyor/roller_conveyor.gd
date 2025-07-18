@tool
class_name RollerConveyor
extends ResizableNode3D

signal width_changed(width: float)
signal length_changed(length: float)
signal roller_skew_angle_changed(skew_angle_degrees: float)
signal speed_changed(speed: float)
signal roller_override_material_changed(material: Material)

const RADIUS: float = 0.12
const CIRCUMFERENCE: float = 2.0 * PI * RADIUS
@export_custom(PROPERTY_HINT_NONE, "suffix:m/s") var speed: float = 1.0:
	set(value):
		if value == speed:
			return
		speed = value
		speed_changed.emit(value)
		_update_conveyor_velocity()

		if _register_speed_tag_ok and _speed_tag_group_init:
			OIPComms.write_float32(speed_tag_group_name, speed_tag_name, value)
		if _register_running_tag_ok and _running_tag_group_init:
			OIPComms.write_bit(running_tag_group_name, running_tag_name, value != 0.0)

@export_range(-60, 60, 1, "degrees") var skew_angle: float = 0.0:
	set(value):
		if skew_angle != value:
			skew_angle = value
			roller_skew_angle_changed.emit(skew_angle)
			_update_conveyor_velocity()

@export_category("Communications")
@export var enable_comms: bool = false
@export var speed_tag_group_name: String
@export_custom(0, "tag_group_enum") var speed_tag_groups:
	set(value):
		speed_tag_group_name = value
		speed_tag_groups = value
@export var speed_tag_name: String = ""
@export var running_tag_group_name: String
@export_custom(0, "tag_group_enum") var running_tag_groups:
	set(value):
		running_tag_group_name = value
		running_tag_groups = value
@export var running_tag_name: String = ""

var running: bool = false:
	set(value):
		running = value
		set_physics_process(running)

var _register_speed_tag_ok: bool = false
var _register_running_tag_ok: bool = false
var _speed_tag_group_init: bool = false
var _running_tag_group_init: bool = false
var _speed_tag_group_original: String
var _running_tag_group_original: String
var _last_size: Vector3 = Vector3(1.525, 0.24, 1.524)
var _last_length: float = 1.525
var _last_width: float = 1.524
var _metal_material: Material
var _rollers: Rollers
var _ends: Node3D
var _roller_material: BaseMaterial3D
var _simple_conveyor_shape: StaticBody3D


func _init() -> void:
	super._init()
	size_default = Vector3(4, 0.24, 1.524)


func _enter_tree() -> void:
	super._enter_tree()

	_speed_tag_group_original = speed_tag_group_name
	_running_tag_group_original = running_tag_group_name

	if speed_tag_group_name.is_empty() and OIPComms.get_tag_groups().size() > 0:
		speed_tag_group_name = OIPComms.get_tag_groups()[0]
	if running_tag_group_name.is_empty() and OIPComms.get_tag_groups().size() > 0:
		running_tag_group_name = OIPComms.get_tag_groups()[0]

	speed_tag_groups = speed_tag_group_name
	running_tag_groups = running_tag_group_name

	if SimulationEvents:
		SimulationEvents.simulation_started.connect(_on_simulation_started)
		SimulationEvents.simulation_ended.connect(_on_simulation_ended)
		running = SimulationEvents.simulation_running

	OIPComms.tag_group_initialized.connect(_tag_group_initialized)
	OIPComms.tag_group_polled.connect(_tag_group_polled)
	OIPComms.enable_comms_changed.connect(notify_property_list_changed)


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


func _property_can_revert(property: StringName) -> bool:
	return property == "speed_tag_groups" or property == "running_tag_groups"


func _property_get_revert(property: StringName) -> Variant:
	if property == "speed_tag_groups":
		return _speed_tag_group_original
	elif property == "running_tag_groups":
		return _running_tag_group_original
	else:
		return null


func _exit_tree() -> void:
	if SimulationEvents:
		if SimulationEvents.simulation_started.is_connected(_on_simulation_started):
			SimulationEvents.simulation_started.disconnect(_on_simulation_started)
		if SimulationEvents.simulation_ended.is_connected(_on_simulation_ended):
			SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)

	if OIPComms.tag_group_initialized.is_connected(_tag_group_initialized):
		OIPComms.tag_group_initialized.disconnect(_tag_group_initialized)
	if OIPComms.tag_group_polled.is_connected(_tag_group_polled):
		OIPComms.tag_group_polled.disconnect(_tag_group_polled)
	if OIPComms.enable_comms_changed.is_connected(notify_property_list_changed):
		OIPComms.enable_comms_changed.disconnect(notify_property_list_changed)

	super._exit_tree()


func _ready() -> void:
	_setup_conveyor_physics()
	_setup_roller_initialization()
	_setup_material()
	_on_size_changed()


func _physics_process(_delta: float) -> void:
	if running and _roller_material:
		_roller_material.uv1_offset.x = fmod(_roller_material.uv1_offset.x + speed * _delta / CIRCUMFERENCE, 1.0)


func set_roller_override_material(material: Material) -> void:
	_roller_material = material as BaseMaterial3D
	roller_override_material_changed.emit(material)


func _setup_material() -> void:
	var metal_mesh_instance := get_node_or_null("ConvRoller/ConvRollerL") as MeshInstance3D
	if metal_mesh_instance:
		_metal_material = metal_mesh_instance.get_surface_override_material(0)

		if not _metal_material:
			_metal_material = metal_mesh_instance.mesh.surface_get_material(0)

		if _metal_material:
			_metal_material = _metal_material.duplicate()
			var right_mesh_instance := get_node_or_null("ConvRoller/ConvRollerR") as MeshInstance3D
			if metal_mesh_instance and right_mesh_instance:
				metal_mesh_instance.set_surface_override_material(0, _metal_material)
				right_mesh_instance.set_surface_override_material(0, _metal_material)




func _setup_roller_initialization() -> void:
	set_roller_override_material(load("res://assets/3DModels/Materials/Metall2.tres").duplicate(true))

	_rollers = get_node_or_null("Rollers")
	_ends = get_node_or_null("Ends")

	if _rollers:
		_setup_roller_container(_rollers)

	if _ends:
		for end in _ends.get_children():
			if end is RollerConveyorEnd:
				_setup_roller_container(end)


func _setup_roller_container(container: AbstractRollerContainer) -> void:
	if container == null:
		return

	container.roller_added.connect(_on_roller_added)
	container.roller_removed.connect(_on_roller_removed)

	roller_skew_angle_changed.connect(container.set_roller_skew_angle)
	width_changed.connect(container.set_width)
	length_changed.connect(container.set_length)

	container.setup_existing_rollers()
	container.set_roller_skew_angle(skew_angle)
	container.set_width(size.z)
	container.set_length(size.x)


func _setup_conveyor_physics() -> void:
	_simple_conveyor_shape = get_node_or_null("SimpleConveyorShape") as StaticBody3D
	
	if _simple_conveyor_shape:
		var collision_shape := _simple_conveyor_shape.get_node_or_null("CollisionShape3D") as CollisionShape3D
		if collision_shape and collision_shape.shape is BoxShape3D:
			var box_shape := collision_shape.shape as BoxShape3D
			box_shape.size = size
		
		var physics_material := PhysicsMaterial.new()
		physics_material.friction = 0.8
		physics_material.rough = true
		_simple_conveyor_shape.physics_material_override = physics_material

		_update_conveyor_velocity()


func _update_component_positions() -> void:
	var conv_roller := get_node_or_null("ConvRoller")
	if conv_roller:
		var end_offset := 0.165
		var target_length := size.x - (2 * end_offset)
		conv_roller.scale = Vector3(target_length, 1, 1)
		conv_roller.position = Vector3(0, -0.25, 0)

		var left_side := conv_roller.get_node_or_null("ConvRollerL")
		var right_side := conv_roller.get_node_or_null("ConvRollerR")
		if left_side and right_side:
			var half_width := size.z / 2.0
			left_side.position = Vector3(left_side.position.x, left_side.position.y, -half_width)
			right_side.position = Vector3(right_side.position.x, right_side.position.y, half_width)

	var rollers_node := get_node_or_null("Rollers")
	if rollers_node:
		rollers_node.position = Vector3(-size.x / 2.0 + 0.2, -0.08, 0)
		rollers_node.scale = Vector3.ONE

	var ends_node := get_node_or_null("Ends")
	if ends_node:
		ends_node.position = Vector3(0, -0.25, 0)

		var end1 := ends_node.get_node_or_null("RollerConveyorEnd")
		var end2 := ends_node.get_node_or_null("RollerConveyorEnd2")

		var end_offset := 0.165
		if end1:
			end1.position = Vector3(size.x / 2.0 - end_offset, 0, 0)
			end1.rotation_degrees = Vector3(0, 0, 0)
			end1.scale = Vector3.ONE
		if end2:
			end2.position = Vector3(-size.x / 2.0 + end_offset, 0, 0)
			end2.rotation_degrees = Vector3(0, 180, 0)
			end2.scale = Vector3.ONE


func _update_width() -> void:
	var new_width := size.z
	if _last_width != new_width:
		width_changed.emit(new_width)
		_last_width = new_width


func _update_length() -> void:
	var new_length := size.x
	if _last_length != new_length:
		length_changed.emit(new_length)
		_last_length = new_length


func _update_metal_material_scale() -> void:
	if _metal_material is ShaderMaterial:
		var end_offset := 0.165
		var target_length := size.x - (2 * end_offset)
		var scale_factor := target_length / 1.67
		var scale_value: float = round(scale_factor)
		scale_value = max(1.0, scale_value)
		_metal_material.set_shader_parameter("Scale2", scale_value)


func _update_conveyor_velocity() -> void:
	if not _simple_conveyor_shape:
		return

	if running and speed != 0.0:
		var local_x := _simple_conveyor_shape.global_transform.basis.x.normalized()
		var local_y := _simple_conveyor_shape.global_transform.basis.y.normalized()
		var angle_rad := deg_to_rad(skew_angle)
		var velocity := local_x.rotated(local_y, angle_rad) * speed
		_simple_conveyor_shape.constant_linear_velocity = velocity
	else:
		_simple_conveyor_shape.constant_linear_velocity = Vector3.ZERO


func _on_size_changed() -> void:
	if _last_size != size:
		size_changed.emit()
		_last_size = size

		if _simple_conveyor_shape:
			var collision_shape := _simple_conveyor_shape.get_node_or_null("CollisionShape3D") as CollisionShape3D
			if collision_shape and collision_shape.shape is BoxShape3D:
				var box_shape := collision_shape.shape as BoxShape3D
				box_shape.size = size

		_update_width()
		_update_length()
		_update_metal_material_scale()
		_update_component_positions()

		if _simple_conveyor_shape:
			_simple_conveyor_shape.position = Vector3(0, -0.08, 0)


func _on_roller_added(roller: Roller) -> void:
	roller_override_material_changed.connect(roller.set_roller_override_material)
	roller.set_roller_override_material(_roller_material)


func _on_roller_removed(roller: Roller) -> void:
	if roller_override_material_changed.is_connected(roller.set_roller_override_material):
		roller_override_material_changed.disconnect(roller.set_roller_override_material)


func _on_simulation_started() -> void:
	running = true
	_update_conveyor_velocity()
	if enable_comms:
		_register_speed_tag_ok = OIPComms.register_tag(speed_tag_group_name, speed_tag_name, 1)
		_register_running_tag_ok = OIPComms.register_tag(running_tag_group_name, running_tag_name, 1)


func _on_simulation_ended() -> void:
	running = false
	_update_conveyor_velocity()


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

	if tag_group_name_param == running_tag_group_name and _running_tag_group_init:
		var is_running: bool = OIPComms.read_bit(running_tag_group_name, running_tag_name)
		speed = 1.0 if is_running else 0.0
