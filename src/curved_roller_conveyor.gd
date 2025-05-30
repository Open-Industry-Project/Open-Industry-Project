@tool
class_name CurvedRollerConveyor
extends Node3D

# Constants
const CURVE_BASE_INNER_RADIUS = 0.25
const CURVE_BASE_OUTER_RADIUS = 1.25
const BASE_CONVEYOR_WIDTH = CURVE_BASE_OUTER_RADIUS - CURVE_BASE_INNER_RADIUS
const BASE_ROLLER_LENGTH = 2.0
const ROLLER_INNER_END_RADIUS = 0.044587
const ROLLER_OUTER_END_RADIUS = 0.12

# Enums
enum Scales {LOW, MID, HIGH}

# Properties
@export var speed: float = 0.0:
	get = get_speed,
	set = set_speed
@export var reference_distance: float = 0.5:
	get = get_reference_distance,
	set = set_reference_distance

#region Communications
var _register_speed_tag_ok: bool = false
var _register_running_tag_ok: bool = false
var _speed_tag_group_init: bool = false
var _running_tag_group_init: bool = false

@export_category("Communications")
@export var enable_comms := false:
	get = get_enable_comms,
	set = set_enable_comms
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
#endregion

var current_scale = Scales.MID
var run: bool = true
var running: bool = false

var mesh_instance: MeshInstance3D
var metal_material: Material
var rollers_low: Node3D
var rollers_mid: Node3D
var rollers_high: Node3D
var roller_material: StandardMaterial3D
var ends: Node3D
var prev_scale_x: float

# Property getters/setters
func get_enable_comms() -> bool:
	return enable_comms


func set_enable_comms(value: bool) -> void:
	enable_comms = value
	notify_property_list_changed()


func get_speed() -> float:
	return speed


func set_speed(value: float) -> void:
	speed = value
	set_all_rollers_speed()


func get_reference_distance() -> float:
	return reference_distance


func set_reference_distance(value: float) -> void:
	reference_distance = value
	set_all_rollers_speed()

# Computed properties
func get_angular_speed_around_curve() -> float:
	var reference_radius = scale.x * CURVE_BASE_OUTER_RADIUS - reference_distance
	return 0.0 if reference_radius == 0.0 else speed / reference_radius


func get_roller_angular_speed() -> float:
	if scale.x == 0.0:
		return 0.0
	var reference_point_along_roller = BASE_ROLLER_LENGTH - reference_distance / scale.x
	var roller_radius_at_reference_point = ROLLER_INNER_END_RADIUS + reference_point_along_roller * (ROLLER_OUTER_END_RADIUS - ROLLER_INNER_END_RADIUS) / BASE_ROLLER_LENGTH
	return 0.0 if roller_radius_at_reference_point == 0.0 else speed / roller_radius_at_reference_point


func _ready() -> void:
	mesh_instance = get_node("MeshInstance3D")
	mesh_instance.mesh = mesh_instance.mesh.duplicate()
	metal_material = mesh_instance.mesh.surface_get_material(0).duplicate()
	mesh_instance.mesh.surface_set_material(0, metal_material)

	rollers_low = get_node("RollersLow")
	rollers_mid = get_node("RollersMid")
	rollers_high = get_node("RollersHigh")
	roller_material = takeover_roller_material()

	ends = get_node("Ends")

	on_scale_changed()
	set_all_rollers_speed()
	set_notify_transform(true)


func _enter_tree() -> void:
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)
	OIPComms.tag_group_initialized.connect(_tag_group_initialized)
	OIPComms.tag_group_polled.connect(_tag_group_polled)
	OIPComms.enable_comms_changed.connect(self.notify_property_list_changed)


func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)
	OIPComms.tag_group_initialized.disconnect(_tag_group_initialized)
	OIPComms.tag_group_polled.disconnect(_tag_group_polled)
	OIPComms.enable_comms_changed.disconnect(self.notify_property_list_changed)


func _process(delta: float) -> void:
	if running:
		var uv_speed = get_roller_angular_speed() / (2.0 * PI)
		var uv_offset = roller_material.uv1_offset
		if !SimulationEvents.simulation_paused:
			uv_offset.x = fmod(fmod(uv_offset.x, 1.0) + uv_speed * delta, 1.0)
		roller_material.uv1_offset = uv_offset


func _physics_process(delta: float) -> void:
	pass


func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSFORM_CHANGED:
		on_scale_changed()


func on_scale_changed() -> void:
	constrain_scale()

	if prev_scale_x != scale.x:
		notify_property_list_changed()

	if scale.x > 1.0:
		if metal_material != null and speed != 0:
			metal_material.set_shader_parameter("Scale", scale.x / 2.0)

	if ends != null:
		for end in ends.get_children():
			if end is MeshInstance3D:
				end.scale = Vector3(1.0 / scale.x, 1, 1)

	for rollers in [rollers_low, rollers_mid, rollers_high]:
		if rollers:
			for roller in rollers.get_children():
				if roller.has_method("set_speed"):  # Check if it's a RollerCorner
					roller.scale = Vector3(BASE_ROLLER_LENGTH / BASE_CONVEYOR_WIDTH / scale.x, 1, 1)

	regenerate_simple_conveyor_shape()
	set_current_scale()
	set_all_rollers_speed()


func constrain_scale() -> void:
	var new_scale = Vector3(scale.x, 1, scale.x)
	if scale != new_scale:
		scale = new_scale


func set_current_scale() -> void:
	var new_scale
	if scale.x < 1.5:
		new_scale = Scales.LOW
	elif scale.x >= 1.5 and scale.x < 3.2:
		new_scale = Scales.MID
	else:
		new_scale = Scales.HIGH

	if new_scale != current_scale:
		current_scale = new_scale
		match current_scale:
			Scales.LOW:
				if rollers_low: rollers_low.visible = true
				if rollers_mid: rollers_mid.visible = false
				if rollers_high: rollers_high.visible = false
			Scales.MID:
				if rollers_low: rollers_low.visible = false
				if rollers_mid: rollers_mid.visible = true
				if rollers_high: rollers_high.visible = false
			Scales.HIGH:
				if rollers_low: rollers_low.visible = false
				if rollers_mid: rollers_mid.visible = true
				if rollers_high: rollers_high.visible = true


func takeover_roller_material() -> StandardMaterial3D:
	var dup_material = rollers_low.get_child(0).get_material().duplicate()
	for rollers in [rollers_low, rollers_mid, rollers_high]:
		if rollers:
			for roller in rollers.get_children():
				if roller.has_method("set_override_material"):
					roller.set_override_material(dup_material)
	return dup_material


func set_all_rollers_speed() -> void:
	var roller_speed = get_roller_angular_speed()
	set_rollers_speed(rollers_low, roller_speed)
	set_rollers_speed(rollers_mid, roller_speed)
	set_rollers_speed(rollers_high, roller_speed)


func set_rollers_speed(rollers: Node3D, speed: float) -> void:
	if rollers:
		for roller in rollers.get_children():
			if roller.has_method("set_speed"):
				roller.set_speed(speed)


func _on_simulation_started() -> void:
	running = true
	if enable_comms:
		_register_speed_tag_ok = OIPComms.register_tag(speed_tag_group_name, speed_tag_name, 1)
		_register_running_tag_ok = OIPComms.register_tag(running_tag_group_name, running_tag_name, 1)


func _on_simulation_ended() -> void:
	running = false


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


func get_curve_inner_radius() -> float:
	return CURVE_BASE_INNER_RADIUS * scale.x


func get_curve_outer_radius() -> float:
	return CURVE_BASE_OUTER_RADIUS * scale.x


func regenerate_simple_conveyor_shape() -> void:
	var simple_conveyor_shape_body = get_node("SimpleConveyorShape")
	simple_conveyor_shape_body.scale = scale.inverse()

	var inner_radius = get_curve_inner_radius()
	var outer_radius = get_curve_outer_radius()
	const END_SIZE = 0.125
	const INNER_Y = ROLLER_INNER_END_RADIUS
	const OUTER_Y = ROLLER_OUTER_END_RADIUS

	const ARC_ANGLE = PI / 2.0
	const ARC_SPLITS = 20
	const SPLIT_ANGLE = ARC_ANGLE / ARC_SPLITS
	const POINT_COUNT = (ARC_SPLITS + 3) * 4

	var new_points = []
	# First endcap
	new_points.append(Vector3(END_SIZE, INNER_Y, inner_radius))
	new_points.append(Vector3(END_SIZE, OUTER_Y, outer_radius))
	new_points.append(Vector3(END_SIZE, -OUTER_Y, outer_radius))
	new_points.append(Vector3(END_SIZE, -INNER_Y, inner_radius))

	for i in range(ARC_SPLITS + 1):
		# Skip angles we'll throw away
		if i > 1 and i < ARC_SPLITS:
			continue

		var angle = SPLIT_ANGLE * i
		var inner_z = cos(angle) * inner_radius
		var inner_x = -sin(angle) * inner_radius
		var outer_z = cos(angle) * outer_radius
		var outer_x = -sin(angle) * outer_radius

		new_points.append(Vector3(inner_x, INNER_Y, inner_z))
		new_points.append(Vector3(outer_x, OUTER_Y, outer_z))
		new_points.append(Vector3(outer_x, -OUTER_Y, outer_z))
		new_points.append(Vector3(inner_x, -INNER_Y, inner_z))

	# Second endcap
	new_points.append(Vector3(-inner_radius, INNER_Y, -END_SIZE))
	new_points.append(Vector3(-outer_radius, OUTER_Y, -END_SIZE))
	new_points.append(Vector3(-outer_radius, -OUTER_Y, -END_SIZE))
	new_points.append(Vector3(-inner_radius, -INNER_Y, -END_SIZE))

	# Update shapes
	var end1_shape = get_node("SimpleConveyorShape/CollisionShape3DEnd1").shape
	var arc_segment_shape = get_node("SimpleConveyorShape/CollisionShape3D1").shape
	var end2_shape = get_node("SimpleConveyorShape/CollisionShape3DEnd2").shape

	end1_shape.points = new_points.slice(0, 8)
	arc_segment_shape.points = new_points.slice(4, 12)
	end2_shape.points = new_points.slice(-8)
