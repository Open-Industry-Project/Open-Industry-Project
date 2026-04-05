@tool
class_name CurvedRollerConveyor
extends Node3D

signal size_changed

const BASE_INNER_RADIUS: float = 0.5
const BASE_CONVEYOR_WIDTH: float = 1.524
const SIZE_DEFAULT: Vector3 = Vector3(1.524, 0.5, 1.524)

const ROLLER_CORNER_SCENE: PackedScene = preload("res://src/RollerConveyor/RollerCorner.tscn")
const ROLLER_SPACING_LOW_DEG: float = 22.5
const ROLLER_SPACING_MID_DEG: float = 10.0
const ROLLER_SPACING_HIGH_DEG: float = 10.0
const ROLLER_OFFSET_HIGH_DEG: float = 5.0

enum Scales {LOW, MID, HIGH}

## Radius of the inner curve edge in meters.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var inner_radius: float = BASE_INNER_RADIUS:
	set(value):
		inner_radius = max(0.1, value)
		_mesh_regeneration_needed = true
		_update_calculated_size()
		_update_all_components()

## Width of the conveyor in meters.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var conveyor_width: float = BASE_CONVEYOR_WIDTH:
	set(value):
		conveyor_width = max(0.1, value)
		_mesh_regeneration_needed = true
		_update_calculated_size()
		_update_all_components()

## Angle of the curved section in degrees (10-180).
@export_range(10.0, 180.0, 1.0, "degrees") var conveyor_angle: float = 90.0:
	set(value):
		if conveyor_angle == value:
			return
		conveyor_angle = value
		_mesh_regeneration_needed = true
		_update_all_components()

## When true, reverses the roller direction.
@export var reverse: bool = false:
	set(value):
		reverse = value
		_recalculate_speeds()

## Linear speed at the reference distance in meters per second.
@export_custom(PROPERTY_HINT_NONE, "suffix:m/s") var speed: float = 2:
	set(value):
		if value == speed:
			return
		speed = value
		_recalculate_speeds()
		if _running_tag.is_ready():
			_running_tag.write_bit(value != 0.0)

## Distance from outer edge where speed value applies (for angular speed calc).
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var reference_distance: float = SIZE_DEFAULT.x / 2:
	set(value):
		reference_distance = value
		_recalculate_speeds()

## The physics material applied to the roller surface for friction control.
@export var belt_physics_material: PhysicsMaterial:
	get:
		if _sb:
			return _sb.physics_material_override
		return null
	set(value):
		if _sb:
			_sb.physics_material_override = value

## Calculated automatically from radius and width — not directly editable.
var size: Vector3:
	get:
		return _calculated_size
	set(_value):
		push_warning("CurvedRollerConveyor.size is read-only; set inner_radius, conveyor_width, or conveyor_angle instead.")

var _calculated_size: Vector3 = SIZE_DEFAULT
var _mesh_regeneration_needed: bool = true
var _last_size: Vector3 = Vector3.ZERO
var _angular_speed: float = 0.0

var current_scale: int = Scales.MID
var running: bool = false

@onready var _sb: StaticBody3D = get_node("StaticBody3D")
var _flow_arrow: Node3D
var _frame_mesh_instance: MeshInstance3D
var _shadow_plate: MeshInstance3D
var _metal_material: Material

var rollers_low: Node3D
var rollers_mid: Node3D
var rollers_high: Node3D
var roller_material: StandardMaterial3D
var ends: Node3D

var _end_static_bodies: Array[StaticBody3D] = []

var _speed_tag := OIPCommsTag.new()
var _running_tag := OIPCommsTag.new()
@export_category("Communications")
## Enable communication with external PLC/control systems.
@export var enable_comms := false
@export var speed_tag_group_name: String
## The tag group for reading speed values from external systems.
@export_custom(0, "tag_group_enum") var speed_tag_groups:
	set(value):
		speed_tag_group_name = value
		speed_tag_groups = value
## The tag name for the speed value in the selected tag group.[br]Datatype: [code]REAL[/code] (32-bit float)[br][br]Format varies by protocol:[br][b]EIP:[/b] CIP tag names[br][b]Modbus:[/b] prefix+number (e.g. [code]hr0[/code])[br][b]OPC UA:[/b] full NodeId (e.g. [code]ns=2;s=MyVariable[/code] or [code]ns=2;i=12345[/code]).
@export var speed_tag_name := ""
@export var running_tag_group_name: String
## The tag group for the running state signal.
@export_custom(0, "tag_group_enum") var running_tag_groups:
	set(value):
		running_tag_group_name = value
		running_tag_groups = value
## The tag name for the running state in the selected tag group.[br]Datatype: [code]BOOL[/code][br][br]Format varies by protocol:[br][b]EIP:[/b] CIP tag names[br][b]Modbus:[/b] prefix+number (e.g. [code]co0[/code])[br][b]OPC UA:[/b] full NodeId (e.g. [code]ns=2;s=MyVariable[/code] or [code]ns=2;i=12345[/code]).
@export var running_tag_name := ""


func _validate_property(property: Dictionary) -> void:
	if OIPCommsSetup.validate_tag_property(property, "speed_tag_group_name", "speed_tag_groups", "speed_tag_name"):
		return
	OIPCommsSetup.validate_tag_property(property, "running_tag_group_name", "running_tag_groups", "running_tag_name")


func _update_calculated_size() -> void:
	var outer_radius := inner_radius + conveyor_width
	var diameter := outer_radius * 2.0
	var old_size := _calculated_size
	_calculated_size = Vector3(diameter, SIZE_DEFAULT.y, diameter)

	if old_size != _calculated_size:
		size_changed.emit()


func _get_custom_preview_node() -> Node3D:
	var preview_scene := load("res://parts/CurvedRollerConveyor.tscn") as PackedScene
	var preview_node = preview_scene.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED) as Node3D

	_disable_collisions_recursive(preview_node)

	preview_node.add_child(FlowDirectionArrow.create_curved(
		inner_radius, conveyor_width, SIZE_DEFAULT.y, conveyor_angle))

	return preview_node


func _disable_collisions_recursive(node: Node) -> void:
	if node is CollisionShape3D:
		node.disabled = true

	if node is CollisionObject3D:
		node.collision_layer = 0
		node.collision_mask = 0

	for child in node.get_children():
		_disable_collisions_recursive(child)


func _init() -> void:
	set_notify_local_transform(true)
	_update_calculated_size()


func _ready() -> void:
	var collision_shape := _sb.get_node_or_null("CollisionShape3D") as CollisionShape3D
	if collision_shape and collision_shape.shape:
		collision_shape.shape = collision_shape.shape.duplicate()

	rollers_low = get_node_or_null("RollersLow")
	rollers_mid = get_node_or_null("RollersMid")
	rollers_high = get_node_or_null("RollersHigh")

	if rollers_low:
		roller_material = _takeover_roller_material()

	ends = get_node_or_null("Ends")

	# Create frame mesh node.
	_metal_material = ConveyorFrameMesh.create_material()
	_frame_mesh_instance = get_node_or_null("FrameMesh") as MeshInstance3D
	if not _frame_mesh_instance:
		_frame_mesh_instance = MeshInstance3D.new()
		_frame_mesh_instance.name = "FrameMesh"
		add_child(_frame_mesh_instance)

	_shadow_plate = get_node_or_null("ShadowPlate") as MeshInstance3D
	if not _shadow_plate:
		_shadow_plate = MeshInstance3D.new()
		_shadow_plate.name = "ShadowPlate"
		_shadow_plate.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_SHADOWS_ONLY
		add_child(_shadow_plate)

	_mesh_regeneration_needed = true
	_update_all_components()
	size_changed.emit()
	_update_flow_arrow()


func _update_flow_arrow() -> void:
	if _flow_arrow:
		FlowDirectionArrow.unregister(_flow_arrow)
		_flow_arrow.queue_free()
	_flow_arrow = FlowDirectionArrow.create_curved(
		inner_radius, conveyor_width, SIZE_DEFAULT.y, conveyor_angle)
	add_child(_flow_arrow, false, Node.INTERNAL_MODE_FRONT)
	FlowDirectionArrow.register(_flow_arrow)


func _enter_tree() -> void:
	speed_tag_group_name = OIPCommsSetup.default_tag_group(speed_tag_group_name)
	running_tag_group_name = OIPCommsSetup.default_tag_group(running_tag_group_name)
	EditorInterface.simulation_started.connect(_on_simulation_started)
	EditorInterface.simulation_stopped.connect(_on_simulation_ended)
	OIPCommsSetup.connect_comms(self, _tag_group_initialized, _tag_group_polled)


func _exit_tree() -> void:
	if _flow_arrow:
		FlowDirectionArrow.unregister(_flow_arrow)
	EditorInterface.simulation_started.disconnect(_on_simulation_started)
	EditorInterface.simulation_stopped.disconnect(_on_simulation_ended)
	OIPCommsSetup.disconnect_comms(self, _tag_group_initialized, _tag_group_polled)


func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		set_notify_local_transform(false)
		if scale != Vector3(scale.x, 1, scale.x):
			scale = Vector3(scale.x, 1, scale.x)
		set_notify_local_transform(true)


func _process(delta: float) -> void:
	if running and roller_material:
		var effective_speed := speed * (-1.0 if reverse else 1.0)
		var uv_speed := effective_speed / (2.0 * PI)
		var uv_offset := roller_material.uv1_offset
		if not EditorInterface.is_simulation_paused():
			uv_offset.x = fmod(fmod(uv_offset.x, 1.0) + uv_speed * delta, 1.0)
		roller_material.uv1_offset = uv_offset


func _physics_process(delta: float) -> void:
	if EditorInterface.is_simulation_running() and _sb:
		var local_up := _sb.global_transform.basis.y.normalized()
		_sb.constant_angular_velocity = -local_up * _angular_speed

		var effective_speed := speed * (-1.0 if reverse else 1.0)
		var angle_radians := deg_to_rad(conveyor_angle)
		for static_body in _end_static_bodies:
			var velocity_dir: Vector3
			if static_body.get_parent().name == "EndAxis2":
				velocity_dir = global_transform.basis * Vector3(cos(angle_radians), 0, -sin(angle_radians)).normalized()
			else:
				velocity_dir = global_transform.basis * Vector3(-1, 0, 0)
			static_body.constant_linear_velocity = velocity_dir * effective_speed
	else:
		if _sb:
			_sb.constant_angular_velocity = Vector3.ZERO
		for static_body in _end_static_bodies:
			static_body.constant_linear_velocity = Vector3.ZERO


# --- Update pipeline (mirrors curved belt conveyor) ---

func _update_all_components() -> void:
	if not is_inside_tree():
		return

	_update_mesh()
	_recalculate_speeds()
	_update_side_guards()
	_update_assembly_components()
	_update_flow_arrow()


func _update_mesh() -> void:
	if not is_inside_tree() or not _frame_mesh_instance:
		return

	if _mesh_regeneration_needed:
		_create_frame_mesh()
		_create_collision_shape()
		_create_end_collision_shapes()
		_mesh_regeneration_needed = false
		_last_size = size

	_update_roller_positions()
	_update_end_positions()
	_update_end_axis_angle()


func _create_frame_mesh() -> void:
	var angle_radians: float = deg_to_rad(conveyor_angle)
	var segments: int = maxi(4, int(conveyor_angle / 5.0))
	const DEFAULT_HEIGHT_RATIO: float = 0.50
	var height: float = DEFAULT_HEIGHT_RATIO * size.y
	const MESH_SCALE_FACTOR := 2.0

	var y_top: float = 0.125 * MESH_SCALE_FACTOR
	var y_bottom: float = (-height + 0.125) * MESH_SCALE_FACTOR

	var r_outer: float = inner_radius + conveyor_width
	var mesh := ConveyorFrameMesh.create_curved(
			inner_radius, r_outer,
			y_top, y_bottom, angle_radians, segments, MESH_SCALE_FACTOR)
	mesh.surface_set_material(0, _metal_material)

	# End side walls (close the inner/outer gaps at each arc endpoint).
	var tangent_r: float = SIZE_DEFAULT.y / 4.0 * 2.0
	ConveyorFrameMesh.add_curved_end_walls(mesh,
			inner_radius, r_outer, y_top, y_bottom, angle_radians,
			tangent_r, MESH_SCALE_FACTOR, _metal_material)

	_frame_mesh_instance.mesh = mesh
	_frame_mesh_instance.scale = Vector3(1.0 / MESH_SCALE_FACTOR, 1.0, 1.0 / MESH_SCALE_FACTOR)

	if _shadow_plate:
		_shadow_plate.mesh = ConveyorFrameMesh.create_arc_shadow_mesh(angle_radians, inner_radius, r_outer, segments)
		_shadow_plate.position.y = -height
	_frame_mesh_instance.position.y = -0.25


func _create_collision_shape() -> void:
	var collision_shape: CollisionShape3D = _sb.get_node_or_null("CollisionShape3D") as CollisionShape3D
	if not collision_shape:
		return

	var segments: int = maxi(1, int(conveyor_angle / 3.0))
	var angle_radians: float = deg_to_rad(conveyor_angle)
	const DEFAULT_HEIGHT_RATIO: float = 0.50
	var height: float = DEFAULT_HEIGHT_RATIO * size.y
	const MESH_SCALE_FACTOR := 2.0

	var all_verts := PackedVector3Array()
	var all_indices := PackedInt32Array()

	for i in range(segments + 1):
		var t: float = float(i) / segments
		var angle: float = t * angle_radians
		var sin_a: float = sin(angle)
		var cos_a: float = cos(angle)

		var it := Vector3(-sin_a * inner_radius, 0.125, cos_a * inner_radius) * MESH_SCALE_FACTOR
		var ot := Vector3(-sin_a * (inner_radius + conveyor_width), 0.125, cos_a * (inner_radius + conveyor_width)) * MESH_SCALE_FACTOR
		var ib := Vector3(-sin_a * inner_radius, -height + 0.125, cos_a * inner_radius) * MESH_SCALE_FACTOR
		var ob := Vector3(-sin_a * (inner_radius + conveyor_width), -height + 0.125, cos_a * (inner_radius + conveyor_width)) * MESH_SCALE_FACTOR

		all_verts.append_array([it, ot, ib, ob])

	for i in range(segments):
		var b: int = i * 4
		# Top face
		all_indices.append_array([b, b + 1, b + 5, b, b + 5, b + 4])
		all_indices.append_array([b + 5, b + 1, b, b + 4, b + 5, b])
		# Bottom face
		all_indices.append_array([b + 2, b + 6, b + 3, b + 3, b + 6, b + 7])
		all_indices.append_array([b + 3, b + 6, b + 2, b + 7, b + 6, b + 3])

	var triangle_verts := PackedVector3Array()
	var base_scale := 1.0 / MESH_SCALE_FACTOR
	for i in range(0, all_indices.size(), 3):
		if i + 2 >= all_indices.size():
			break
		for j in range(3):
			var v: Vector3 = all_verts[all_indices[i + j]]
			triangle_verts.append(Vector3(v.x * base_scale, v.y, v.z * base_scale))

	var shape: ConcavePolygonShape3D = collision_shape.shape
	shape.data = triangle_verts
	collision_shape.scale = Vector3.ONE
	_sb.position.y = -0.25


# --- Roller management ---

func _update_roller_positions() -> void:
	_update_roller_group(rollers_low, ROLLER_SPACING_LOW_DEG, 0.0)
	_update_roller_group(rollers_mid, ROLLER_SPACING_MID_DEG, 0.0)
	_update_roller_group(rollers_high, ROLLER_SPACING_HIGH_DEG, ROLLER_OFFSET_HIGH_DEG)


func _update_roller_group(group: Node3D, spacing_deg: float, offset_deg: float) -> void:
	if not group:
		return

	# Scale angular spacing to maintain consistent arc-length gap between rollers
	# regardless of inner_radius. The constants were calibrated for BASE_INNER_RADIUS.
	var base_center_r: float = BASE_INNER_RADIUS + BASE_CONVEYOR_WIDTH / 2.0
	var center_r: float = inner_radius + conveyor_width / 2.0
	var radius_ratio: float = base_center_r / center_r if center_r > 1e-6 else 1.0
	var actual_spacing: float = spacing_deg * radius_ratio
	var actual_offset: float = offset_deg * radius_ratio

	var needed_count: int
	if actual_offset > 0.0:
		needed_count = maxi(0, floori((conveyor_angle - actual_offset) / actual_spacing) + 1)
	else:
		needed_count = maxi(1, floori(conveyor_angle / actual_spacing) + 1)

	while group.get_child_count() > needed_count:
		var child := group.get_child(group.get_child_count() - 1)
		group.remove_child(child)
		child.queue_free()

	while group.get_child_count() < needed_count:
		var axis := Node3D.new()
		axis.name = "RollerAxis%d" % (group.get_child_count() + 1)
		var roller := ROLLER_CORNER_SCENE.instantiate() as RollerCorner
		axis.add_child(roller)
		group.add_child(axis)
		if roller_material:
			roller.set_override_material(roller_material)

	for i in range(group.get_child_count()):
		var axis := group.get_child(i)
		var angle_deg := actual_offset + i * actual_spacing
		var angle_rad := deg_to_rad(angle_deg)
		axis.transform = Transform3D(Basis(Vector3.UP, -angle_rad), Vector3.ZERO)
		var roller := axis.get_child(0) as RollerCorner
		if roller:
			roller.position = Vector3(0, -0.08, center_r)
			roller.length = conveyor_width


func set_current_scale() -> void:
	var new_scale: int
	if conveyor_width < 1.45:
		new_scale = Scales.LOW
	elif conveyor_width < 3.2:
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


func _takeover_roller_material() -> StandardMaterial3D:
	if rollers_low.get_child_count() == 0 or rollers_low.get_child(0).get_child_count() == 0:
		return null
	var dup_material: StandardMaterial3D = rollers_low.get_child(0).get_child(0).get_material().duplicate()
	for roller_group in [rollers_low, rollers_mid, rollers_high]:
		if not roller_group:
			continue
		for roller_axis in roller_group.get_children():
			var roller := roller_axis.get_child(0) as RollerCorner
			roller.set_override_material(dup_material)
	return dup_material


# --- End axis management ---

func _update_end_positions() -> void:
	if not ends:
		return
	var center_r: float = inner_radius + conveyor_width / 2.0
	for end_axis in ends.get_children():
		var roller := end_axis.get_child(0) as RollerCorner
		if roller:
			roller.position = Vector3(0, -0.08, center_r)
			roller.length = conveyor_width
			if roller_material:
				roller.set_override_material(roller_material)


func _update_end_axis_angle() -> void:
	if ends:
		var end_axis2 := ends.get_node_or_null("EndAxis2")
		if end_axis2:
			end_axis2.rotation_degrees.y = -conveyor_angle


func _create_end_collision_shapes() -> void:
	if not ends:
		return

	_end_static_bodies.clear()
	var center_r: float = inner_radius + conveyor_width / 2.0

	for end_axis in ends.get_children():
		var roller := end_axis.get_child(0) as RollerCorner
		if not roller:
			continue

		var static_body := end_axis.get_node_or_null("StaticBody3D") as StaticBody3D
		if not static_body:
			static_body = StaticBody3D.new()
			static_body.name = "StaticBody3D"
			end_axis.add_child(static_body)

		var collision_shape := static_body.get_node_or_null("CollisionShape3D") as CollisionShape3D
		if not collision_shape:
			collision_shape = CollisionShape3D.new()
			collision_shape.name = "CollisionShape3D"
			static_body.add_child(collision_shape)

		var box_shape := BoxShape3D.new()
		box_shape.size = Vector3(0.125, 0.25, conveyor_width)

		# Y must align with main collision surface (top at y=0 in local space).
		var box_y: float = -box_shape.size.y / 2.0
		if end_axis.name == "EndAxis2":
			collision_shape.position = Vector3(-0.06, box_y, center_r)
		else:
			collision_shape.position = Vector3(0.06, box_y, center_r)

		collision_shape.shape = box_shape
		_end_static_bodies.append(static_body)


# --- Speed ---

func _recalculate_speeds() -> void:
	var direction := -1.0 if reverse else 1.0
	var effective_speed := speed * direction
	var outer_radius: float = inner_radius + conveyor_width
	var reference_radius: float = outer_radius - reference_distance
	_angular_speed = 0.0 if absf(reference_radius) < 1e-6 else effective_speed / reference_radius


# --- Side guards and assembly ---

func _update_side_guards() -> void:
	var parent_node := get_parent()
	if parent_node:
		var side_guards := parent_node.get_node_or_null("SideGuardsCBC")
		if side_guards and side_guards.has_method("update_for_curved_conveyor"):
			side_guards.update_for_curved_conveyor(inner_radius, conveyor_width, size, conveyor_angle)


func _update_assembly_components() -> void:
	var parent_node := get_parent()
	if not parent_node:
		return

	if parent_node.has_method("update_attachments_for_curved_conveyor"):
		parent_node.update_attachments_for_curved_conveyor(inner_radius, conveyor_width, size, conveyor_angle)
	else:
		var legs_assembly := parent_node.get_node_or_null("ConveyorLegsAssembly")
		if not legs_assembly:
			legs_assembly = parent_node.get_node_or_null("%ConveyorLegsAssembly")
		if legs_assembly and legs_assembly.has_method("update_for_curved_conveyor"):
			legs_assembly.update_for_curved_conveyor(inner_radius, conveyor_width, size, conveyor_angle)

	set_current_scale()


# --- Simulation callbacks ---

func _on_simulation_started() -> void:
	running = true
	if enable_comms:
		_speed_tag.register(speed_tag_group_name, speed_tag_name)
		_running_tag.register(running_tag_group_name, running_tag_name)


func _on_simulation_ended() -> void:
	running = false
	if _sb:
		_sb.constant_angular_velocity = Vector3.ZERO
	for static_body in _end_static_bodies:
		static_body.constant_linear_velocity = Vector3.ZERO
	if roller_material:
		roller_material.uv1_offset = Vector3.ZERO


func _tag_group_initialized(tag_group_name_param: String) -> void:
	_speed_tag.on_group_initialized(tag_group_name_param)
	_running_tag.on_group_initialized(tag_group_name_param)


func _tag_group_polled(tag_group_name_param: String) -> void:
	if not enable_comms:
		return
	if _speed_tag.matches_group(tag_group_name_param):
		speed = _speed_tag.read_float32()
