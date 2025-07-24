@tool
class_name CurvedRollerConveyor
extends ResizableNode3D

const CURVE_BASE_INNER_RADIUS = 0.25
const CURVE_BASE_OUTER_RADIUS = 1.25
const BASE_CONVEYOR_WIDTH = CURVE_BASE_OUTER_RADIUS - CURVE_BASE_INNER_RADIUS
const BASE_ROLLER_LENGTH = 2.0
const BASE_END_LENGTH = 2.0
const BASE_MODEL_SIZE = Vector3(2, 0.5, 2)
const ROLLER_INNER_END_RADIUS = 0.044587
const ROLLER_OUTER_END_RADIUS = 0.12

enum Scales {LOW, MID, HIGH}

const SIZE_DEFAULT: Vector3 = Vector3(1.524, 0.5, 1.524)

@export var speed: float = 0.0:
	set(value):
		speed = value
		_recalculate_speeds()
		if _register_speed_tag_ok and _speed_tag_group_init:
			OIPComms.write_float32(speed_tag_group_name, speed_tag_name, value)
		if _register_running_tag_ok and _running_tag_group_init:
			OIPComms.write_bit(running_tag_group_name, running_tag_name, value != 0.0)

@export var reference_distance: float = SIZE_DEFAULT.x/2

@export_range(10.0, 90.0, 1.0, 'degrees') var conveyor_angle: float = 90.0:
	set(value):
		if conveyor_angle == value:
			return
		conveyor_angle = value
		_mesh_regeneration_needed = true
		_update_mesh()
		_update_end_axis_angle()
		_update_side_guards()
		_update_assembly_components()


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

var current_scale = Scales.MID
var run: bool = true
var running: bool = false

# Track when mesh regeneration is needed to avoid unnecessary recalculations
var _mesh_regeneration_needed: bool = true
var _last_conveyor_angle: float = 90.0
var _last_size: Vector3 = Vector3.ZERO

var mesh_instance: MeshInstance3D
var metal_material: Material
var rollers_low: Node3D
var rollers_mid: Node3D
var rollers_high: Node3D
var roller_material: StandardMaterial3D
var ends: Node3D
var prev_scale_x: float
const BASE_INNER_RADIUS: float = 0.25
const BASE_OUTER_RADIUS: float = 1.25

var shader_material: ShaderMaterial = null
var inner_shader_material: ShaderMaterial = null
var outer_mesh: MeshInstance3D = null
var inner_mesh: MeshInstance3D = null
var _angular_speed: float = 0.0
var _linear_speed: float = 0.0
var _sb: StaticBody3D = null

func _init() -> void:
	pass
	
var outer_radius: float:
	get:
		return size.x * CURVE_BASE_OUTER_RADIUS

var inner_radius: float:
	get:
		return size.x * CURVE_BASE_INNER_RADIUS

var conveyor_width: float:
	get:
		return outer_radius - inner_radius

var center_radius: float:
	get:
		return (outer_radius + inner_radius) / 2.0

func get_enable_comms() -> bool:
	return enable_comms

func set_enable_comms(value: bool) -> void:
	enable_comms = value
	notify_property_list_changed()

func get_speed() -> float:
	return speed

func set_speed(value: float) -> void:
	if value == speed:
		return
	speed = value
	_recalculate_speeds()

func get_reference_distance() -> float:
	return reference_distance

func set_reference_distance(value: float) -> void:
	reference_distance = value
	_recalculate_speeds()

# Computed properties
func get_angular_speed_around_curve() -> float:
	var reference_radius = outer_radius - reference_distance
	return 0.0 if reference_radius == 0.0 else speed / reference_radius

func get_roller_angular_speed() -> float:
	if size.x == 0.0:
		return 0.0
	var reference_point_along_roller = BASE_ROLLER_LENGTH - reference_distance
	var roller_radius_at_reference_point = ROLLER_INNER_END_RADIUS + reference_point_along_roller * (ROLLER_OUTER_END_RADIUS - ROLLER_INNER_END_RADIUS) / BASE_ROLLER_LENGTH
	return 0.0 if roller_radius_at_reference_point == 0.0 else speed / roller_radius_at_reference_point

func _ready() -> void:
	mesh_instance = get_node_or_null("MeshInstance3D")
	if mesh_instance:
		mesh_instance.mesh = mesh_instance.mesh.duplicate()
		metal_material = mesh_instance.mesh.surface_get_material(0).duplicate()
		mesh_instance.mesh.surface_set_material(0, metal_material)

	rollers_low = get_node_or_null("RollersLow")
	rollers_mid = get_node_or_null("RollersMid")
	rollers_high = get_node_or_null("RollersHigh")
	
	if rollers_low:
		roller_material = takeover_roller_material()

	ends = get_node_or_null("Ends")

	# Initialize StaticBody3D
	_sb = get_node_or_null("SimpleConveyorShape") as StaticBody3D
	if not _sb:
		_sb = StaticBody3D.new()
		_sb.name = "SimpleConveyorShape"
		add_child(_sb)
		_sb.owner = get_tree().edited_scene_root if Engine.is_editor_hint() else self

	# Ensure collision shape exists and is unique to this instance
	var collision_shape = _sb.get_node_or_null("CollisionShape3D") as CollisionShape3D
	if not collision_shape:
		collision_shape = CollisionShape3D.new()
		collision_shape.name = "CollisionShape3D"
		_sb.add_child(collision_shape)
		collision_shape.owner = get_tree().edited_scene_root if Engine.is_editor_hint() else self
	
	if collision_shape.shape:
		collision_shape.shape = collision_shape.shape.duplicate()

	_on_size_changed()
	_recalculate_speeds()
	set_notify_transform(true)

	outer_mesh = find_child('InnerRollerConveyor') as MeshInstance3D
	if not outer_mesh:
		outer_mesh = MeshInstance3D.new()
		outer_mesh.name = 'InnerRollerConveyor'
		add_child(outer_mesh)
		outer_mesh.owner = get_tree().edited_scene_root if Engine.is_editor_hint() else self

	inner_mesh = find_child('OuterRollerConveyor') as MeshInstance3D
	if not inner_mesh:
		inner_mesh = MeshInstance3D.new()
		inner_mesh.name = 'OuterRollerConveyor'
		add_child(inner_mesh)
		inner_mesh.owner = get_tree().edited_scene_root if Engine.is_editor_hint() else self

	_setup_materials()
	_mesh_regeneration_needed = true
	_update_mesh()

func _enter_tree() -> void:
	super._enter_tree()
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
	super._exit_tree()

func _process(delta: float) -> void:
	if running:
		var uv_speed = speed / (2.0 * PI)
		var uv_offset = roller_material.uv1_offset
		if !SimulationEvents.simulation_paused:
			uv_offset.x = fmod(fmod(uv_offset.x, 1.0) + uv_speed * delta, 1.0)
		roller_material.uv1_offset = uv_offset

func _physics_process(delta: float) -> void:
	if SimulationEvents.simulation_running and _sb:
		var local_up = _sb.global_transform.basis.y.normalized()
		var velocity = -local_up * _angular_speed
		_sb.constant_angular_velocity = velocity

		var angle_radians = deg_to_rad(conveyor_angle)
		for static_body in _end_static_bodies:
			var velocity_dir: Vector3
			if static_body.get_parent().name == "EndAxis2":
				# Transform the local direction by the conveyor's global transform
				var local_dir = Vector3(cos(angle_radians), 0, -sin(angle_radians)).normalized()
				velocity_dir = global_transform.basis * local_dir
			else:
				# Transform the local direction by the conveyor's global transform
				var local_dir = Vector3(-1, 0, 0)
				velocity_dir = global_transform.basis * local_dir
			static_body.constant_linear_velocity = velocity_dir * speed
	else:
		if _sb:
			_sb.constant_angular_velocity = Vector3.ZERO
		for static_body in _end_static_bodies:
			static_body.constant_linear_velocity = Vector3.ZERO

func _on_size_changed() -> void:
	var mesh_node := get_node_or_null("MeshInstance3D")
	if mesh_node:
		mesh_node.scale = size / BASE_MODEL_SIZE

	if ends != null:
		for end_axis in ends.get_children():
			var end := end_axis.get_child(0) as MeshInstance3D
			if end:
				end.position = Vector3(0, 0, center_radius)
				end.scale = Vector3(0.5, 1, conveyor_width / BASE_END_LENGTH)

	for roller_group in [rollers_low, rollers_mid, rollers_high]:
		if roller_group:
			for roller_axis in roller_group.get_children():
				var roller := roller_axis.get_child(0) as RollerCorner
				if roller:
					roller.position = Vector3(0, 0, center_radius)
					roller.length = conveyor_width

	set_current_scale()
	_recalculate_speeds()
	
	if _last_size != size:
		_mesh_regeneration_needed = true
	
	_update_side_guards()
	_update_assembly_components()
	
	_update_mesh()

func _get_constrained_size(new_size: Vector3) -> Vector3:
	return Vector3(new_size.x, 0.5, new_size.x)

func set_current_scale() -> void:
	var new_scale
	if size.x < 1.45:
		new_scale = Scales.LOW
	elif size.x >= 1.45 and size.x < 3.2:
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
	var dup_material = rollers_low.get_child(0).get_child(0).get_material().duplicate()
	for roller_group in [rollers_low, rollers_mid, rollers_high]:
		if not roller_group:
			continue
		for roller_axis in roller_group.get_children():
			var roller := roller_axis.get_child(0) as RollerCorner
			roller.set_override_material(dup_material)
	return dup_material

func _recalculate_speeds() -> void:
	var reference_radius: float = size.x * BASE_OUTER_RADIUS - reference_distance
	_angular_speed = 0.0 if reference_radius == 0.0 else speed / reference_radius

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

func _setup_materials() -> void:
	shader_material = ShaderMaterial.new()
	shader_material.shader = load('res://assets/3DModels/Shaders/MetalShader.tres') as Shader
	shader_material.set_shader_parameter('Color', Color('#56a7c8'))

	inner_shader_material = ShaderMaterial.new()
	inner_shader_material.shader = load('res://assets/3DModels/Shaders/MetalShader.tres') as Shader
	inner_shader_material.set_shader_parameter('Color', Color('#56a7c8'))

	_update_material_scale()

func _update_material_scale() -> void:
	if shader_material and inner_shader_material:
		var angle_portion: float = conveyor_angle / 360.0
		var avg_radius: float = size.x * BASE_OUTER_RADIUS
		var length: float = 2.0 * PI * avg_radius * angle_portion
		var scale: float = length / (PI * 1.0)

		shader_material.set_shader_parameter('Scale', size.x * 2)
		shader_material.set_shader_parameter('Scale2', size.y * 8)
		shader_material.set_shader_parameter('EdgeScale', scale * 1.2)

		inner_shader_material.set_shader_parameter('Scale', size.x * 2)
		inner_shader_material.set_shader_parameter('Scale2', size.y * 8)
		inner_shader_material.set_shader_parameter('EdgeScale', scale * 1.2)

var _end_static_bodies: Array[StaticBody3D] = []

func _create_end_collision_shapes() -> void:
	if not ends:
		return

	# Clear previous static bodies
	_end_static_bodies.clear()

	for end_axis in ends.get_children():
		var end_mesh = end_axis.get_child(0) as MeshInstance3D
		if not end_mesh:
			continue

		var static_body = end_axis.get_node_or_null("StaticBody3D") as StaticBody3D
		if not static_body:
			static_body = StaticBody3D.new()
			static_body.name = "StaticBody3D"
			end_axis.add_child(static_body)
			static_body.owner = get_tree().edited_scene_root if Engine.is_editor_hint() else self

		var collision_shape = static_body.get_node_or_null("CollisionShape3D") as CollisionShape3D
		if not collision_shape:
			collision_shape = CollisionShape3D.new()
			collision_shape.name = "CollisionShape3D"
			static_body.add_child(collision_shape)
			collision_shape.owner = get_tree().edited_scene_root if Engine.is_editor_hint() else self

		var box_shape = BoxShape3D.new()
		var end_scale = end_mesh.scale
		box_shape.size = Vector3(
			0.125,
			end_scale.y * 0.25,
			end_scale.z * BASE_END_LENGTH
		)

		if end_axis.name == "EndAxis2":
			collision_shape.position = Vector3(-0.06, 0.165, end_mesh.position.z)
		else:
			collision_shape.position = Vector3(0.06,0.165, end_mesh.position.z)

		collision_shape.shape = box_shape
		_end_static_bodies.append(static_body)

func _update_mesh() -> void:
	if not is_inside_tree() or not outer_mesh or not inner_mesh:
		return

	if _mesh_regeneration_needed:
		_update_material_scale()
		_create_conveyor_collision_shape()
		_create_outer_mesh()
		_create_inner_mesh()
		_create_end_collision_shapes()
		_mesh_regeneration_needed = false
		_last_conveyor_angle = conveyor_angle
		_last_size = size

	var angle_proportion = conveyor_angle / 90.0

	if rollers_low:
		var visible_low_count = roundi(5 * angle_proportion)
		for i in range(5):
			var roller_axis = rollers_low.get_node_or_null("RollerAxis" + str(i + 1))
			if roller_axis:
				roller_axis.visible = i < visible_low_count

	if rollers_mid:
		var visible_mid_count = roundi(10 * angle_proportion)
		for i in range(10):
			var roller_axis = rollers_mid.get_node_or_null("RollerAxis" + str(i + 1))
			if roller_axis:
				roller_axis.visible = i < visible_mid_count

	if rollers_high:
		var visible_high_count = roundi(9 * angle_proportion)
		for i in range(9):
			var roller_axis = rollers_high.get_node_or_null("RollerAxis" + str(i + 1))
			if roller_axis:
				roller_axis.visible = i < visible_high_count

	_update_end_axis_angle()

func _update_end_axis_angle() -> void:
	if ends:
		var end_axis2 = ends.get_node_or_null("EndAxis2")
		if end_axis2:
			end_axis2.rotation_degrees.y = -conveyor_angle

func _create_conveyor_collision_shape() -> void:
	var collision_shape: CollisionShape3D = _sb.get_node_or_null("CollisionShape3D") as CollisionShape3D
	if not collision_shape:
		return

	var segments: int = int(conveyor_angle / 3.0)
	var angle_radians: float = deg_to_rad(conveyor_angle)
	var radius_inner: float = BASE_INNER_RADIUS * size.x
	var radius_outer: float = BASE_OUTER_RADIUS * size.x
	const DEFAULT_HEIGHT_RATIO: float = 0.50
	var height: float = DEFAULT_HEIGHT_RATIO * size.y
	var scale_factor: float = 1.0

	var surfaces = _create_surfaces()
	var all_vertices = _create_vertices(segments, angle_radians, radius_inner, radius_outer, height, scale_factor)
	_build_top_and_bottom_surfaces(surfaces, all_vertices)
	_create_surface_triangles(surfaces, segments)

	var all_verts: PackedVector3Array = PackedVector3Array()
	var all_indices: PackedInt32Array = PackedInt32Array()

	for surface_name in ["top", "bottom"]:
		var surface = surfaces[surface_name]
		var base_index = all_verts.size()
		all_verts.append_array(surface.vertices)
		for i in surface.indices:
			all_indices.append(base_index + i)

	var triangle_verts: PackedVector3Array = PackedVector3Array()
	for i in range(0, all_indices.size(), 3):
		if i + 2 >= all_indices.size():
			break
		triangle_verts.append_array([
			all_verts[all_indices[i]],
			all_verts[all_indices[i + 1]],
			all_verts[all_indices[i + 2]]
		])

	var shape: ConcavePolygonShape3D = collision_shape.shape
	shape.data = triangle_verts
	collision_shape.scale = Vector3.ONE

func _create_surfaces() -> Dictionary:
	var surfaces = {
		"top": {
			"vertices": PackedVector3Array(),
			"normals": PackedVector3Array(),
			"uvs": PackedVector2Array(),
			"indices": PackedInt32Array(),
		},
		"bottom": {
			"vertices": PackedVector3Array(),
			"normals": PackedVector3Array(),
			"uvs": PackedVector2Array(),
			"indices": PackedInt32Array(),
		}
	}
	return surfaces

func _create_vertices(segments: int, angle_radians: float, radius_inner: float, radius_outer: float, height: float, scale_factor: float) -> Array:
	var all_vertices = []
	for i in range(segments + 1):
		var t = float(i) / segments
		var angle: float = t * angle_radians
		var sin_a: float = sin(angle)
		var cos_a: float = cos(angle)

		var inner_top = Vector3(-sin_a * radius_inner, 0, cos_a * radius_inner) * scale_factor
		var outer_top = Vector3(-sin_a * radius_outer, 0, cos_a * radius_outer) * scale_factor
		var inner_bottom = Vector3(-sin_a * radius_inner, -height, cos_a * radius_inner) * scale_factor
		var outer_bottom = Vector3(-sin_a * radius_outer, -height, cos_a * radius_outer) * scale_factor

		all_vertices.append({
			"inner_top": inner_top,
			"outer_top": outer_top,
			"inner_bottom": inner_bottom,
			"outer_bottom": outer_bottom,
			"t": t
		})
	return all_vertices

func _build_top_and_bottom_surfaces(surfaces: Dictionary, all_vertices: Array) -> void:
	for i in range(len(all_vertices)):
		var vertex_data = all_vertices[i]
		surfaces.top.vertices.append_array([vertex_data.inner_top, vertex_data.outer_top])
		surfaces.top.normals.append_array([Vector3.UP, Vector3.UP])
		surfaces.top.uvs.append_array([Vector2(1, 1-vertex_data.t), Vector2(0, 1-vertex_data.t)])

		surfaces.bottom.vertices.append_array([vertex_data.inner_bottom, vertex_data.outer_bottom])
		surfaces.bottom.normals.append_array([Vector3.DOWN, Vector3.DOWN])
		surfaces.bottom.uvs.append_array([Vector2(0, vertex_data.t), Vector2(1, vertex_data.t)])

func _create_surface_triangles(surfaces: Dictionary, segments: int) -> void:
	for i in range(segments):
		var idx = i * 2
		_add_double_sided_triangle(surfaces.top.indices, idx, idx + 1, idx + 3)
		_add_double_sided_triangle(surfaces.top.indices, idx, idx + 3, idx + 2)

		_add_double_sided_triangle(surfaces.bottom.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.bottom.indices, idx, idx + 3, idx + 1)

func _add_double_sided_triangle(array_indices: PackedInt32Array, a: int, b: int, c: int) -> void:
	array_indices.append_array([a, b, c, c, b, a])

func _create_inner_mesh() -> void:
	var mesh := ArrayMesh.new()

	var base_scale: float = 0.22
	var progressive_factor: float = base_scale * pow(1.18, 0.05)
	var inner_scale_x: float = size.x * progressive_factor
	var radius_outer: float = BASE_OUTER_RADIUS * inner_scale_x
	var height: float = size.y + 0.0105

	var top_lip_height: float = 0.4 * size.y
	var bottom_lip_height: float = 0.02 * size.y
	var lip_inward: float = 0.049 * size.x / 0.97
	var diagonal_depth: float = -0.003
	var diagonal_height: float = top_lip_height * 0.03

	var segments: int = int(conveyor_angle / 9.0)
	var angle_radians: float = deg_to_rad(conveyor_angle)

	var vertices := PackedVector3Array()
	var normals := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()

	var arc_length: float = radius_outer * angle_radians
	var uv_scale_length: float = arc_length / 2.0

	for i in range(segments + 1):
		var t: float = float(i) / segments
		var angle: float = t * angle_radians
		var sin_a: float = sin(angle)
		var cos_a: float = cos(angle)

		var outer_top := Vector3(-sin_a * radius_outer, height, cos_a * radius_outer )
		var outer_bottom := Vector3(-sin_a * radius_outer, 0, cos_a * radius_outer)
		var middle_top := Vector3(-sin_a * (radius_outer), height, cos_a * (radius_outer))
		var middle_bottom := Vector3(-sin_a * (radius_outer), 0, cos_a * (radius_outer))
		var top_lip_top := Vector3(-sin_a * (radius_outer - lip_inward), height, cos_a * (radius_outer - lip_inward))
		var top_diagonal_start := Vector3(-sin_a * (radius_outer - lip_inward + diagonal_depth), height - diagonal_height, cos_a * (radius_outer - lip_inward + diagonal_depth))
		var vertical_top := Vector3(-sin_a * (radius_outer - lip_inward + diagonal_depth - 0.01), height - diagonal_height, cos_a * (radius_outer - lip_inward + diagonal_depth - 0.01))
		var vertical_bottom := Vector3(-sin_a * (radius_outer - lip_inward + diagonal_depth - 0.01), height - top_lip_height + diagonal_height + 0.0145, cos_a * (radius_outer - lip_inward + diagonal_depth - 0.01))
		var bottom_diagonal_end := Vector3(-sin_a * (radius_outer - lip_inward + 0.007), height - top_lip_height, cos_a * (radius_outer - lip_inward + 0.007))
		var top_lip_middle_outer := Vector3(-sin_a * (radius_outer - lip_inward * 0.1), height - top_lip_height, cos_a * (radius_outer - lip_inward * 0.1))
		var bottom_lip_bottom := Vector3(-sin_a * (radius_outer - lip_inward * 1.08), 0, cos_a * (radius_outer - lip_inward * 1.08))
		var bottom_lip_middle_inner := Vector3(-sin_a * (radius_outer - lip_inward * 1.08), bottom_lip_height, cos_a * (radius_outer - lip_inward * 1.08))
		var bottom_lip_middle_outer := Vector3(-sin_a * (radius_outer - lip_inward * 0.1), bottom_lip_height, cos_a * (radius_outer - lip_inward * 0.1))
		var center := Vector3.ZERO
		var outer_normal := (outer_top - center).normalized()
		outer_normal.y = 0
		outer_normal = outer_normal.normalized()

		var inner_normal := (center - middle_top).normalized()
		inner_normal.y = 0
		inner_normal = inner_normal.normalized()

		var top_diagonal_dir := (top_diagonal_start - top_lip_top).normalized()
		var top_diagonal_normal := Vector3(top_diagonal_dir.z, 0, -top_diagonal_dir.x).normalized()
		var bottom_diagonal_dir := (bottom_diagonal_end - vertical_bottom).normalized()
		var bottom_diagonal_normal := Vector3(bottom_diagonal_dir.z, 0, -bottom_diagonal_dir.x).normalized()

		var uv_arc_pos: float = t * uv_scale_length

		vertices.append_array([outer_top, outer_bottom, top_lip_middle_outer, bottom_lip_middle_outer, outer_top, top_lip_top, outer_bottom, bottom_lip_bottom, top_lip_top, top_diagonal_start, top_diagonal_start, vertical_top, vertical_top, vertical_bottom, vertical_bottom, bottom_diagonal_end, bottom_diagonal_end, top_lip_middle_outer, bottom_lip_middle_outer, bottom_lip_middle_inner, bottom_lip_middle_inner, bottom_lip_bottom, bottom_lip_bottom, middle_bottom])
		normals.append_array([outer_normal, outer_normal, inner_normal, inner_normal, Vector3.UP, Vector3.UP, Vector3.DOWN, Vector3.DOWN, Vector3.UP, Vector3.UP, top_diagonal_normal, top_diagonal_normal, inner_normal, inner_normal, bottom_diagonal_normal, bottom_diagonal_normal, Vector3.DOWN, Vector3.DOWN, Vector3.UP, Vector3.UP, Vector3.UP, Vector3.UP, inner_normal, inner_normal])
		uvs.append_array([Vector2(uv_arc_pos, 0.6), Vector2(uv_arc_pos, 0.8), Vector2(uv_arc_pos, 0.2), Vector2(uv_arc_pos, 0.4), Vector2(0.8, uv_arc_pos), Vector2(1.0, uv_arc_pos), Vector2(0.0, uv_arc_pos), Vector2(0.2, uv_arc_pos), Vector2(uv_arc_pos, 0.05), Vector2(uv_arc_pos, 0.1), Vector2(uv_arc_pos, 0.1), Vector2(uv_arc_pos, 0.15), Vector2(uv_arc_pos, 0.15), Vector2(uv_arc_pos, 0.18), Vector2(uv_arc_pos, 0.18), Vector2(uv_arc_pos, 0.2), Vector2(uv_arc_pos, 0.2), Vector2(uv_arc_pos, 0.25), Vector2(uv_arc_pos, 0.08), Vector2(uv_arc_pos, 0.1), Vector2(0.0, uv_arc_pos), Vector2(0.2, uv_arc_pos), Vector2(uv_arc_pos + 0.1, 0.4), Vector2(uv_arc_pos + 0.1, 0.5)])

	for i in range(segments):
		var base: int = i * 24
		indices.append_array([
			base, base + 1, base + 25, base, base + 25, base + 24,
			base + 2, base + 27, base + 3, base + 2, base + 26, base + 27,
			base + 4, base + 28, base + 29, base + 4, base + 29, base + 5,
			base + 6, base + 31, base + 30, base + 6, base + 7, base + 31,
			base + 8, base + 32, base + 33, base + 8, base + 33, base + 9,
			base + 10, base + 34, base + 35, base + 10, base + 35, base + 11,
			base + 12, base + 36, base + 37, base + 12, base + 37, base + 13,
			base + 14, base + 38, base + 39, base + 14, base + 39, base + 15,
			base + 16, base + 40, base + 41, base + 16, base + 41, base + 17,
			base + 18, base + 43, base + 19, base + 18, base + 42, base + 43,
			base + 20, base + 44, base + 45, base + 20, base + 45, base + 21,
			base + 22, base + 23, base + 47, base + 22, base + 47, base + 46
		])

	if segments > 0:
		vertices.append_array([vertices[0], vertices[2], vertices[1], vertices[3]])
		var left_normal := Vector3(-1, 0, 0)
		normals.append_array([left_normal, left_normal, left_normal, left_normal])
		uvs.append_array([Vector2(0.8, 0.2), Vector2(1.0, 0.2), Vector2(0.8, 0.4), Vector2(1.0, 0.4)])
		var left_base: int = vertices.size() - 4
		indices.append_array([left_base, left_base + 1, left_base + 3, left_base, left_base + 3, left_base + 2])

		var last: int = segments * 24
		vertices.append_array([vertices[last], vertices[last + 2], vertices[last + 1], vertices[last + 3]])
		var right_normal := Vector3(1, 0, 0)
		normals.append_array([right_normal, right_normal, right_normal, right_normal])
		uvs.append_array([Vector2(0.8, 0.6), Vector2(1.0, 0.6), Vector2(0.8, 0.8), Vector2(1.0, 0.8)])
		var right_base: int = vertices.size() - 4
		indices.append_array([right_base, right_base + 3, right_base + 1, right_base, right_base + 2, right_base + 3])

		var left_top_lip_verts = [vertices[4], vertices[5], vertices[8], vertices[9], vertices[10], vertices[11], vertices[12], vertices[13], vertices[14], vertices[15], vertices[16], vertices[17]]
		vertices.append_array(left_top_lip_verts)
		for j in range(12): normals.append(left_normal)
		uvs.append_array([Vector2(0.0, 0.9), Vector2(0.0, 1.0), Vector2(0.1, 0.9), Vector2(0.1, 1.0), Vector2(0.2, 0.8), Vector2(0.2, 0.9), Vector2(0.3, 0.7), Vector2(0.3, 0.8), Vector2(0.4, 0.6), Vector2(0.4, 0.7), Vector2(0.5, 0.5), Vector2(0.5, 0.6)])
		var top_lip_left_base: int = vertices.size() - 12
		indices.append_array([top_lip_left_base, top_lip_left_base + 2, top_lip_left_base + 1, top_lip_left_base + 2, top_lip_left_base + 4, top_lip_left_base + 3, top_lip_left_base + 4, top_lip_left_base + 6, top_lip_left_base + 5, top_lip_left_base + 6, top_lip_left_base + 8, top_lip_left_base + 7, top_lip_left_base + 8, top_lip_left_base + 10, top_lip_left_base + 9, top_lip_left_base + 10, top_lip_left_base + 11, top_lip_left_base + 1])

		var last_lip: int = segments * 24
		var right_top_lip_verts = [vertices[last_lip + 4], vertices[last_lip + 5], vertices[last_lip + 8], vertices[last_lip + 9], vertices[last_lip + 10], vertices[last_lip + 11], vertices[last_lip + 12], vertices[last_lip + 13], vertices[last_lip + 14], vertices[last_lip + 15], vertices[last_lip + 16], vertices[last_lip + 17]]
		vertices.append_array(right_top_lip_verts)
		for j in range(12): normals.append(right_normal)
		uvs.append_array([Vector2(0.6, 0.9), Vector2(0.6, 1.0), Vector2(0.7, 0.9), Vector2(0.7, 1.0), Vector2(0.8, 0.8), Vector2(0.8, 0.9), Vector2(0.9, 0.7), Vector2(0.9, 0.8), Vector2(1.0, 0.6), Vector2(1.0, 0.7), Vector2(0.9, 0.5), Vector2(0.9, 0.6)])
		var top_lip_right_base: int = vertices.size() - 12
		indices.append_array([top_lip_right_base, top_lip_right_base + 2, top_lip_right_base + 1, top_lip_right_base + 2, top_lip_right_base + 4, top_lip_right_base + 3, top_lip_right_base + 4, top_lip_right_base + 6, top_lip_right_base + 5, top_lip_right_base + 6, top_lip_right_base + 8, top_lip_right_base + 7, top_lip_right_base + 8, top_lip_right_base + 10, top_lip_right_base + 9, top_lip_right_base + 10, top_lip_right_base + 11, top_lip_right_base + 1])

		vertices.append_array([vertices[18], vertices[19], vertices[21], vertices[6]])
		normals.append_array([left_normal, left_normal, left_normal, left_normal])
		uvs.append_array([Vector2(0.0, 0.0), Vector2(0.0, 0.2), Vector2(0.2, 0.2), Vector2(0.2, 0.0)])
		var bottom_lip_left_base: int = vertices.size() - 4
		indices.append_array([bottom_lip_left_base, bottom_lip_left_base + 1, bottom_lip_left_base + 2, bottom_lip_left_base, bottom_lip_left_base + 2, bottom_lip_left_base + 3])

		vertices.append_array([vertices[last_lip + 18], vertices[last_lip + 19], vertices[last_lip + 21], vertices[last_lip + 6]])
		normals.append_array([right_normal, right_normal, right_normal, right_normal])
		uvs.append_array([Vector2(0.4, 0.0), Vector2(0.4, 0.2), Vector2(0.6, 0.2), Vector2(0.6, 0.0)])
		var bottom_lip_right_base: int = vertices.size() - 4
		indices.append_array([bottom_lip_right_base, bottom_lip_right_base + 1, bottom_lip_right_base + 2, bottom_lip_right_base, bottom_lip_right_base + 3, bottom_lip_right_base + 2])

	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices

	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	mesh.surface_set_material(0, shader_material)
	outer_mesh.mesh = mesh

func _create_outer_mesh() -> void:
	var mesh := ArrayMesh.new()

	var progressive_factor: float = pow(0.957, 0.5)
	var inner_scale_x: float = size.x * progressive_factor
	var radius_inner: float = BASE_OUTER_RADIUS * inner_scale_x + 0.005
	var height: float = size.y + 0.0105
	var thickness: float = 0.005

	var top_lip_height: float = 0.4 * size.y
	var bottom_lip_height: float = 0.02 * size.y
	var lip_outward: float = 0.047 * size.x / 0.90
	var diagonal_depth: float = 0.003
	var diagonal_height: float = top_lip_height * 0.03

	var segments: int = int(conveyor_angle / 9.0)
	var angle_radians: float = deg_to_rad(conveyor_angle)

	var vertices := PackedVector3Array()
	var normals := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()

	var arc_length: float = radius_inner * angle_radians
	var uv_scale_length: float = arc_length / 2.0

	var default_size_x: float = 0.97
	var size_scale: float = size.x / default_size_x
	var outward_adjustment: float = lip_outward * 0.015 * (size_scale - 1.0)

	for i in range(segments + 1):
		var t: float = float(i) / segments
		var angle: float = t * angle_radians
		var sin_a: float = sin(angle)
		var cos_a: float = cos(angle)

		var inner_top := Vector3(-sin_a * radius_inner + 0.006, height, cos_a * radius_inner - 0.006)
		var inner_bottom := Vector3(-sin_a * radius_inner, 0, cos_a * radius_inner)
		var middle_top := Vector3(-sin_a * (radius_inner), height, cos_a * (radius_inner))
		var middle_bottom := Vector3(-sin_a * (radius_inner), 0, cos_a * (radius_inner))
		var top_lip_top := Vector3(-sin_a * (radius_inner + lip_outward - 0.01), height, cos_a * (radius_inner + lip_outward - 0.01))
		var top_diagonal_start := Vector3(-sin_a * (radius_inner + lip_outward + diagonal_depth - 0.01), height - diagonal_height, cos_a * (radius_inner + lip_outward + diagonal_depth - 0.01))
		var vertical_top := Vector3(-sin_a * (radius_inner + lip_outward + diagonal_depth - 0.01), height - diagonal_height, cos_a * (radius_inner + lip_outward + diagonal_depth - 0.01))
		var vertical_bottom := Vector3(-sin_a * (radius_inner + lip_outward + diagonal_depth - 0.01), height - top_lip_height + diagonal_height + 0.0145, cos_a * (radius_inner + lip_outward + diagonal_depth - 0.01))
		var bottom_diagonal_end := Vector3(-sin_a * (radius_inner + lip_outward - 0.017), height - top_lip_height, cos_a * (radius_inner + lip_outward - 0.017))
		var top_lip_middle_outer := Vector3(-sin_a * (radius_inner + outward_adjustment), height - top_lip_height, cos_a * (radius_inner + outward_adjustment))
		var bottom_lip_bottom := Vector3(-sin_a * (radius_inner + lip_outward - 0.002), 0, cos_a * (radius_inner + lip_outward - 0.002))
		var bottom_lip_middle_inner := Vector3(-sin_a * (radius_inner + lip_outward - 0.002), bottom_lip_height, cos_a * (radius_inner + lip_outward - 0.002))
		var bottom_lip_middle_outer := Vector3(-sin_a * (radius_inner + outward_adjustment), bottom_lip_height, cos_a * (radius_inner + outward_adjustment))

		var center := Vector3.ZERO
		var inner_normal := (center - middle_top).normalized()
		inner_normal.y = 0
		inner_normal = inner_normal.normalized()

		var outer_normal := (inner_top - center).normalized()
		outer_normal.y = 0
		outer_normal = outer_normal.normalized()

		var top_diagonal_dir := (top_diagonal_start - top_lip_top).normalized()
		var top_diagonal_normal := Vector3(-top_diagonal_dir.z, 0, top_diagonal_dir.x).normalized()
		var bottom_diagonal_dir := (bottom_diagonal_end - vertical_bottom).normalized()
		var bottom_diagonal_normal := Vector3(-bottom_diagonal_dir.z, 0, bottom_diagonal_dir.x).normalized()

		var uv_arc_pos: float = t * uv_scale_length

		vertices.append_array([inner_top, inner_bottom, top_lip_middle_outer, bottom_lip_middle_outer, inner_top, top_lip_top, inner_bottom, bottom_lip_bottom, top_lip_top, top_diagonal_start, top_diagonal_start, vertical_top, vertical_top, vertical_bottom, vertical_bottom, bottom_diagonal_end, bottom_diagonal_end, top_lip_middle_outer, bottom_lip_middle_outer, bottom_lip_middle_inner, bottom_lip_middle_inner, bottom_lip_bottom, bottom_lip_bottom, middle_bottom])
		normals.append_array([inner_normal, inner_normal, outer_normal, outer_normal, Vector3.UP, Vector3.UP, Vector3.DOWN, Vector3.DOWN, Vector3.UP, Vector3.UP, top_diagonal_normal, top_diagonal_normal, outer_normal, outer_normal, bottom_diagonal_normal, bottom_diagonal_normal, Vector3.DOWN, Vector3.DOWN, Vector3.UP, Vector3.UP, Vector3.UP, Vector3.UP, outer_normal, outer_normal])
		uvs.append_array([Vector2(uv_arc_pos, 0.6), Vector2(uv_arc_pos, 0.8), Vector2(uv_arc_pos, 0.2), Vector2(uv_arc_pos, 0.4), Vector2(0.8, uv_arc_pos), Vector2(1.0, uv_arc_pos), Vector2(0.0, uv_arc_pos), Vector2(0.2, uv_arc_pos), Vector2(uv_arc_pos, 0.05), Vector2(uv_arc_pos, 0.1), Vector2(uv_arc_pos, 0.1), Vector2(uv_arc_pos, 0.15), Vector2(uv_arc_pos, 0.15), Vector2(uv_arc_pos, 0.18), Vector2(uv_arc_pos, 0.18), Vector2(uv_arc_pos, 0.2), Vector2(uv_arc_pos, 0.2), Vector2(uv_arc_pos, 0.25), Vector2(uv_arc_pos, 0.08), Vector2(uv_arc_pos, 0.1), Vector2(0.0, uv_arc_pos), Vector2(0.2, uv_arc_pos), Vector2(uv_arc_pos + 0.1, 0.4), Vector2(uv_arc_pos + 0.1, 0.5)])

	for i in range(segments):
		var base: int = i * 24

		indices.append_array([
			base, base + 25, base + 1, base, base + 24, base + 25,
			base + 2, base + 3, base + 27, base + 2, base + 27, base + 26,
			base + 4, base + 29, base + 28, base + 4, base + 5, base + 29,
			base + 6, base + 30, base + 31, base + 6, base + 31, base + 7,
			base + 8, base + 33, base + 32, base + 8, base + 9, base + 33,
			base + 10, base + 35, base + 34, base + 10, base + 11, base + 35,
			base + 12, base + 37, base + 36, base + 12, base + 13, base + 37,
			base + 14, base + 39, base + 38, base + 14, base + 15, base + 39,
			base + 16, base + 41, base + 40, base + 16, base + 17, base + 41,
			base + 18, base + 19, base + 43, base + 18, base + 43, base + 42,
			base + 20, base + 45, base + 44, base + 20, base + 21, base + 45,
			base + 22, base + 47, base + 23, base + 22, base + 46, base + 47
		])

	if segments > 0:
		vertices.append_array([vertices[0], vertices[2], vertices[1], vertices[3]])
		var left_normal := Vector3(1, 0, 0)
		normals.append_array([left_normal, left_normal, left_normal, left_normal])
		uvs.append_array([Vector2(0.8, 0.2), Vector2(1.0, 0.2), Vector2(0.8, 0.4), Vector2(1.0, 0.4)])
		var left_base: int = vertices.size() - 4
		indices.append_array([left_base, left_base + 3, left_base + 1, left_base, left_base + 2, left_base + 3])

		var last: int = segments * 24
		vertices.append_array([vertices[last], vertices[last + 2], vertices[last + 1], vertices[last + 3]])
		var right_normal := Vector3(-1, 0, 0)
		normals.append_array([right_normal, right_normal, right_normal, right_normal])
		uvs.append_array([Vector2(0.8, 0.6), Vector2(1.0, 0.6), Vector2(0.8, 0.8), Vector2(1.0, 0.8)])
		var right_base: int = vertices.size() - 4
		indices.append_array([right_base, right_base + 1, right_base + 3, right_base, right_base + 3, right_base + 2])

		var left_top_lip_verts = [vertices[4], vertices[5], vertices[8], vertices[9], vertices[10], vertices[11], vertices[12], vertices[13], vertices[14], vertices[15], vertices[16], vertices[17]]
		vertices.append_array(left_top_lip_verts)
		for j in range(12): normals.append(left_normal)
		uvs.append_array([Vector2(0.0, 0.9), Vector2(0.0, 1.0), Vector2(0.1, 0.9), Vector2(0.1, 1.0), Vector2(0.2, 0.8), Vector2(0.2, 0.9), Vector2(0.3, 0.7), Vector2(0.3, 0.8), Vector2(0.4, 0.6), Vector2(0.4, 0.7), Vector2(0.5, 0.5), Vector2(0.5, 0.6)])
		var top_lip_left_base: int = vertices.size() - 12
		indices.append_array([top_lip_left_base, top_lip_left_base + 2, top_lip_left_base + 1, top_lip_left_base + 2, top_lip_left_base + 4, top_lip_left_base + 3, top_lip_left_base + 4, top_lip_left_base + 6, top_lip_left_base + 5, top_lip_left_base + 6, top_lip_left_base + 8, top_lip_left_base + 7, top_lip_left_base + 8, top_lip_left_base + 10, top_lip_left_base + 9, top_lip_left_base + 10, top_lip_left_base + 11, top_lip_left_base + 1])

		var last_lip: int = segments * 24
		var right_top_lip_verts = [vertices[last_lip + 4], vertices[last_lip + 5], vertices[last_lip + 8], vertices[last_lip + 9], vertices[last_lip + 10], vertices[last_lip + 11], vertices[last_lip + 12], vertices[last_lip + 13], vertices[last_lip + 14], vertices[last_lip + 15], vertices[last_lip + 16], vertices[last_lip + 17]]
		vertices.append_array(right_top_lip_verts)
		for j in range(12): normals.append(right_normal)
		uvs.append_array([Vector2(0.6, 0.9), Vector2(0.6, 1.0), Vector2(0.7, 0.9), Vector2(0.7, 1.0), Vector2(0.8, 0.8), Vector2(0.8, 0.9), Vector2(0.9, 0.7), Vector2(0.9, 0.8), Vector2(1.0, 0.6), Vector2(1.0, 0.7), Vector2(0.9, 0.5), Vector2(0.9, 0.6)])
		var top_lip_right_base: int = vertices.size() - 12
		indices.append_array([top_lip_right_base, top_lip_right_base + 2, top_lip_right_base + 1, top_lip_right_base + 2, top_lip_right_base + 4, top_lip_right_base + 3, top_lip_right_base + 4, top_lip_right_base + 6, top_lip_right_base + 5, top_lip_right_base + 6, top_lip_right_base + 8, top_lip_right_base + 7, top_lip_right_base + 8, top_lip_right_base + 10, top_lip_right_base + 9, top_lip_right_base + 10, top_lip_right_base + 1, top_lip_right_base + 11])

		vertices.append_array([vertices[18], vertices[19], vertices[21], vertices[6]])
		normals.append_array([left_normal, left_normal, left_normal, left_normal])
		uvs.append_array([Vector2(0.0, 0.0), Vector2(0.0, 0.2), Vector2(0.2, 0.2), Vector2(0.2, 0.0)])
		var bottom_lip_left_base: int = vertices.size() - 4
		indices.append_array([bottom_lip_left_base, bottom_lip_left_base + 1, bottom_lip_left_base + 2, bottom_lip_left_base, bottom_lip_left_base + 2, bottom_lip_left_base + 3])

		vertices.append_array([vertices[last_lip + 18], vertices[last_lip + 19], vertices[last_lip + 21], vertices[last_lip + 6]])
		normals.append_array([right_normal, right_normal, right_normal, right_normal])
		uvs.append_array([Vector2(0.4, 0.0), Vector2(0.4, 0.2), Vector2(0.6, 0.2), Vector2(0.6, 0.0)])
		var bottom_lip_right_base: int = vertices.size() - 4
		indices.append_array([bottom_lip_right_base, bottom_lip_right_base + 1, bottom_lip_right_base + 2, bottom_lip_right_base, bottom_lip_right_base + 3, bottom_lip_right_base + 2])

	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices

	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	mesh.surface_set_material(0, shader_material)
	inner_mesh.mesh = mesh

func _update_side_guards() -> void:
	var parent_node = get_parent()
	if parent_node:
		var side_guards = parent_node.get_node_or_null("SideGuardsCBC")
		if not side_guards:
			side_guards = parent_node.get_node_or_null("SideGuardsAssembly") 
		if not side_guards:
			side_guards = parent_node.get_node_or_null("%SideGuardsAssembly")
		
		if side_guards and side_guards.has_method("update_for_curved_conveyor"):
			side_guards.update_for_curved_conveyor(inner_radius, conveyor_width, size, conveyor_angle)

func _update_assembly_components() -> void:
	var parent_node = get_parent()
	if not parent_node:
		return
	
	if parent_node.has_method("update_attachments_for_curved_conveyor"):
		parent_node.update_attachments_for_curved_conveyor(inner_radius, conveyor_width, size, conveyor_angle)
	else:
		var legs_assembly = parent_node.get_node_or_null("ConveyorLegsAssembly")
		if not legs_assembly:
			legs_assembly = parent_node.get_node_or_null("%ConveyorLegsAssembly")
		
		if legs_assembly and legs_assembly.has_method("update_for_curved_conveyor"):
			legs_assembly.update_for_curved_conveyor(inner_radius, conveyor_width, size, conveyor_angle)
