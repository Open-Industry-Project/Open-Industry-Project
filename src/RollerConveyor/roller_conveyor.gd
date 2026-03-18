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
## Linear speed of the rollers in meters per second.
@export_custom(PROPERTY_HINT_NONE, "suffix:m/s") var speed: float = 1.0:
	set(value):
		if value == speed:
			return
		speed = value
		speed_changed.emit(value)
		_update_conveyor_velocity()

		if _running_tag.is_ready():
			_running_tag.write_bit(value != 0.0)

## Angle of roller skew for angled product movement (-60 to 60 degrees).
@export_range(-60, 60, 1, "degrees") var skew_angle: float = 0.0:
	set(value):
		if skew_angle != value:
			skew_angle = value
			roller_skew_angle_changed.emit(skew_angle)
			_update_conveyor_velocity()

@export_category("Communications")
## Enable communication with external PLC/control systems.
@export var enable_comms: bool = false
@export var speed_tag_group_name: String
## The tag group for reading speed values from external systems.
@export_custom(0, "tag_group_enum") var speed_tag_groups:
	set(value):
		speed_tag_group_name = value
		speed_tag_groups = value
## The tag name for the speed value in the selected tag group.[br]Datatype: [code]REAL[/code] (32-bit float)[br][br]Format varies by protocol:[br][b]EIP:[/b] CIP tag names[br][b]Modbus:[/b] prefix+number (e.g. [code]hr0[/code])[br][b]OPC UA:[/b] full NodeId (e.g. [code]ns=2;s=MyVariable[/code] or [code]ns=2;i=12345[/code]).
@export var speed_tag_name: String = ""
@export var running_tag_group_name: String
## The tag group for the running state signal.
@export_custom(0, "tag_group_enum") var running_tag_groups:
	set(value):
		running_tag_group_name = value
		running_tag_groups = value
## The tag name for the running state in the selected tag group.[br]Datatype: [code]BOOL[/code][br][br]Format varies by protocol:[br][b]EIP:[/b] CIP tag names[br][b]Modbus:[/b] prefix+number (e.g. [code]co0[/code])[br][b]OPC UA:[/b] full NodeId (e.g. [code]ns=2;s=MyVariable[/code] or [code]ns=2;i=12345[/code]).
@export var running_tag_name: String = ""

var running: bool = false:
	set(value):
		running = value
		set_physics_process(running)

var _speed_tag := OIPCommsTag.new()
var _running_tag := OIPCommsTag.new()
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

	speed_tag_group_name = OIPCommsSetup.default_tag_group(speed_tag_group_name)
	running_tag_group_name = OIPCommsSetup.default_tag_group(running_tag_group_name)
	if SimulationEvents:
		SimulationEvents.simulation_started.connect(_on_simulation_started)
		SimulationEvents.simulation_ended.connect(_on_simulation_ended)
		running = SimulationEvents.simulation_running

	OIPCommsSetup.connect_comms(self, _tag_group_initialized, _tag_group_polled)


func _validate_property(property: Dictionary) -> void:
	if OIPCommsSetup.validate_tag_property(property, "speed_tag_group_name", "speed_tag_groups", "speed_tag_name"):
		return
	OIPCommsSetup.validate_tag_property(property, "running_tag_group_name", "running_tag_groups", "running_tag_name")


func _exit_tree() -> void:
	if SimulationEvents:
		if SimulationEvents.simulation_started.is_connected(_on_simulation_started):
			SimulationEvents.simulation_started.disconnect(_on_simulation_started)
		if SimulationEvents.simulation_ended.is_connected(_on_simulation_ended):
			SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)

	OIPCommsSetup.disconnect_comms(self, _tag_group_initialized, _tag_group_polled)

	super._exit_tree()


func _ready() -> void:
	_setup_conveyor_physics()
	_setup_collision_shape()
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


func _setup_collision_shape() -> void:
	if _simple_conveyor_shape:
		var collision_shape := _simple_conveyor_shape.get_node_or_null("CollisionShape3D") as CollisionShape3D
		if collision_shape and collision_shape.shape:
			collision_shape.shape = collision_shape.shape.duplicate() as BoxShape3D


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
		_speed_tag.register(speed_tag_group_name, speed_tag_name)
		_running_tag.register(running_tag_group_name, running_tag_name)


func _on_simulation_ended() -> void:
	running = false
	_update_conveyor_velocity()


func _tag_group_initialized(tag_group_name_param: String) -> void:
	_speed_tag.on_group_initialized(tag_group_name_param)
	_running_tag.on_group_initialized(tag_group_name_param)


func _tag_group_polled(tag_group_name_param: String) -> void:
	if not enable_comms:
		return

	if _speed_tag.matches_group(tag_group_name_param):
		speed = _speed_tag.read_float32()
