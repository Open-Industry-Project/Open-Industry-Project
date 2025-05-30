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
@export var enable_comms: bool = false:
	get = get_enable_comms,
	set = set_enable_comms
@export var tag: String = ""
@export var update_rate: int = 100
@export var speed: float = 0.0:
	get = get_speed,
	set = set_speed
@export var reference_distance: float = 0.5:
	get = get_reference_distance,
	set = set_reference_distance

var current_scale = Scales.MID
var run: bool = true
var id = "" # Using string instead of Guid
var scan_interval: float = 0.0
var running: bool = false
var read_successful: bool = false

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
	SimulationEvents.simulation_started.connect(on_simulation_started)
	SimulationEvents.simulation_ended.connect(on_simulation_ended)
	if SimulationEvents.simulation_running:
		running = true


func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(on_simulation_started)
	SimulationEvents.simulation_ended.disconnect(on_simulation_ended)


func _process(delta: float) -> void:
	if running:
		var uv_speed = get_roller_angular_speed() / (2.0 * PI)
		var uv_offset = roller_material.uv1_offset
		if !SimulationEvents.simulation_paused:
			uv_offset.x = fmod(fmod(uv_offset.x, 1.0) + uv_speed * delta, 1.0)
		roller_material.uv1_offset = uv_offset


func _physics_process(delta: float) -> void:
	if running and enable_comms and read_successful:
		scan_interval += delta
		if scan_interval > float(update_rate) / 1000.0 and read_successful:
			scan_interval = 0
			#scan_tag.call_deferred()


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


func on_simulation_started() -> void:
	running = true
	if enable_comms:
		read_successful = SimulationEvents.connect_device(id, "Float", name, tag)


func on_simulation_ended() -> void:
	running = false


#func scan_tag() -> void:
#	try:
#		speed = await SimulationEvents.read_float(id)
#	except:
#		printerr("Failure to read: %s in Node: %s" % [tag, name])
#		read_successful = false


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
