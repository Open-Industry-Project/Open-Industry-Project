@tool
class_name PathFollowingConveyor
extends Node3D

signal size_changed
signal path_segments_changed

## Belt texture options for visual appearance.
enum ConvTexture {
	## Typical industrial belt texture.
	STANDARD,
	## Modern pattern with flow direction indicators.
	ALTERNATE
}

const BASE_CONVEYOR_WIDTH: float = 1.524
const SIZE_DEFAULT: Vector3 = Vector3(1.524, 0.5, 1.524)

## The Path3D node that defines the conveyor's path.
@export var path_to_follow: Path3D:
	set(value):
		if path_to_follow and path_to_follow.curve:
			if path_to_follow.curve.changed.is_connected(_on_path_changed):
				path_to_follow.curve.changed.disconnect(_on_path_changed)
		path_to_follow = value
		if path_to_follow and path_to_follow.curve:
			if not path_to_follow.curve.changed.is_connected(_on_path_changed):
				path_to_follow.curve.changed.connect(_on_path_changed)
		_mesh_regeneration_needed = true
		if is_inside_tree():
			_update_all_components()

## Width of the conveyor belt in meters.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var conveyor_width: float = BASE_CONVEYOR_WIDTH:
	set(value):
		conveyor_width = max(0.1, value)
		_mesh_regeneration_needed = true
		_update_calculated_size()
		if is_inside_tree():
			_update_all_components()

## Height of the belt frame in meters.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var belt_height: float = 0.5:
	set(value):
		belt_height = max(0.1, value)
		_mesh_regeneration_needed = true
		_update_calculated_size()
		if is_inside_tree():
			_update_all_components()

## The color tint applied to the belt surface.
@export var belt_color: Color = Color(1, 1, 1, 1):
	set(value):
		belt_color = value
		if _belt_material:
			_belt_material.set_shader_parameter("ColorMix", belt_color)
		_set_belt_material_on_ends()

## The texture style of the belt (standard or alternate pattern).
@export var belt_texture: ConvTexture = ConvTexture.STANDARD:
	set(value):
		belt_texture = value
		if _belt_material:
			_belt_material.set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)
		_set_belt_material_on_ends()

## Maximum tilt angle from horizontal in degrees.
@export_range(0.0, 45.0, 1.0, "degrees") var max_tilt_angle: float = 0.0:
	set(value):
		max_tilt_angle = clamp(value, 0.0, 45.0)
		_mesh_regeneration_needed = true
		if is_inside_tree():
			_update_all_components()

## Number of segments used to approximate the path curve.
@export_range(5, 100) var path_segments: int = 20:
	set(value):
		if path_segments != value:
			path_segments = clamp(int(value), 5, 100)
			_mesh_regeneration_needed = true
			if is_inside_tree():
				_update_all_components()
				path_segments_changed.emit()

## Linear speed of the belt in meters per second.
@export_custom(PROPERTY_HINT_NONE, "suffix:m/s") var speed: float = 2.0:
	set(value):
		if value == speed:
			return
		speed = value
		_update_belt_material_scale()
		_update_belt_ends_speed()
		if _register_running_tag_ok and _running_tag_group_init:
			OIPComms.write_bit(running_tag_group_name, running_tag_name, value != 0.0)

## The physics material applied to the belt surface for friction control.
@export var belt_physics_material: PhysicsMaterial:
	get:
		if _sb:
			return _sb.physics_material_override
		return null
	set(value):
		if _sb:
			_sb.physics_material_override = value
		if _conveyor_end1:
			var sb1 = _conveyor_end1.get_node_or_null("StaticBody3D") as StaticBody3D
			if sb1:
				sb1.physics_material_override = value
		if _conveyor_end2:
			var sb2 = _conveyor_end2.get_node_or_null("StaticBody3D") as StaticBody3D
			if sb2:
				sb2.physics_material_override = value

var size: Vector3:
	get:
		return _calculated_size
	set(_value):
		pass

var _calculated_size: Vector3 = SIZE_DEFAULT
var _belt_material: ShaderMaterial
var _metal_material: ShaderMaterial
var _belt_position: float = 0.0
var _mesh_regeneration_needed: bool = true
var _start_tangent: Vector3 = Vector3.FORWARD
var _end_tangent: Vector3 = Vector3.FORWARD

@onready var _sb: StaticBody3D = $StaticBody3D
@onready var _a3d: Area3D = $AffectArea3D

@onready var _collision_shape_start : CollisionShape3D = $AffectArea3D/CollisionShape3D_Start
@onready var _collision_shape_end : CollisionShape3D = $AffectArea3D/CollisionShape3D_End

@onready var _mesh_instance: MeshInstance3D = $MeshInstance3D
@onready var _conveyor_end1: Node = get_node_or_null("BeltConveyorEnd")
@onready var _conveyor_end2: Node = get_node_or_null("BeltConveyorEnd2")

var _register_speed_tag_ok: bool = false
var _register_running_tag_ok: bool = false
var _speed_tag_group_init: bool = false
var _running_tag_group_init: bool = false
var _speed_tag_group_original: String
var _running_tag_group_original: String

@export_category("Communications")
## Enable communication with external PLC/control systems.
@export var enable_comms: bool = false
@export var speed_tag_group_name: String
## The tag group for reading speed values from external systems.
@export_custom(0, "tag_group_enum") var speed_tag_groups:
	set(value):
		speed_tag_group_name = value
		speed_tag_groups = value
## The tag name for the speed value in the selected tag group.
@export var speed_tag_name: String = ""
@export var running_tag_group_name: String
## The tag group for the running state signal.
@export_custom(0, "tag_group_enum") var running_tag_groups:
	set(value):
		running_tag_group_name = value
		running_tag_groups = value
## The tag name for the running state in the selected tag group.
@export var running_tag_name: String = ""


func _validate_property(property: Dictionary) -> void:
	if property.name == "enable_comms":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE
	elif property.name == "speed_tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "speed_tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "speed_tag_name":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE
	elif property.name == "running_tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "running_tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "running_tag_name":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE


func _property_can_revert(property: StringName) -> bool:
	return property == "speed_tag_groups" or property == "running_tag_groups"


func _property_get_revert(property: StringName) -> Variant:
	if property == "speed_tag_groups":
		return _speed_tag_group_original
	elif property == "running_tag_groups":
		return _running_tag_group_original
	return null


func _ready() -> void:
	if _sb:
		var collision_shape = _sb.get_node_or_null("CollisionShape3D") as CollisionShape3D
		if collision_shape and collision_shape.shape:
			collision_shape.shape = collision_shape.shape.duplicate()

	if _mesh_instance and _mesh_instance.mesh:
		_mesh_instance.mesh = _mesh_instance.mesh.duplicate()

	path_to_follow.curve = path_to_follow.curve.duplicate()

	_set_belt_material_on_ends()
	_mesh_regeneration_needed = true
	_update_all_components()


func _enter_tree() -> void:
	_speed_tag_group_original = speed_tag_group_name
	_running_tag_group_original = running_tag_group_name

	if speed_tag_group_name.is_empty() and OIPComms.get_tag_groups().size() > 0:
		speed_tag_group_name = OIPComms.get_tag_groups()[0]
	if running_tag_group_name.is_empty() and OIPComms.get_tag_groups().size() > 0:
		running_tag_group_name = OIPComms.get_tag_groups()[0]

	speed_tag_groups = speed_tag_group_name
	running_tag_groups = running_tag_group_name

	SimulationEvents.simulation_started.connect(_on_simulation_started)
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)
	OIPComms.tag_group_initialized.connect(_tag_group_initialized)
	OIPComms.tag_group_polled.connect(_tag_group_polled)
	OIPComms.enable_comms_changed.connect(notify_property_list_changed)

	if path_to_follow and path_to_follow.curve:
		if not path_to_follow.curve.changed.is_connected(_on_path_changed):
			path_to_follow.curve.changed.connect(_on_path_changed)


func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)
	OIPComms.tag_group_initialized.disconnect(_tag_group_initialized)
	OIPComms.tag_group_polled.disconnect(_tag_group_polled)
	OIPComms.enable_comms_changed.disconnect(notify_property_list_changed)

	if path_to_follow and path_to_follow.curve:
		if path_to_follow.curve.changed.is_connected(_on_path_changed):
			path_to_follow.curve.changed.disconnect(_on_path_changed)


func _physics_process(delta: float) -> void:
	if SimulationEvents.simulation_running:
		if not SimulationEvents.simulation_paused:
			_belt_position += speed * delta
		if speed != 0.0 and _belt_material:
			_belt_material.set_shader_parameter("BeltPosition", _belt_position * sign(speed))
		if _belt_position >= 1.0:
			_belt_position = 0.0

		_update_belt_velocity()


func _update_belt_velocity() -> void:
	## Updates the linear velocity on conveyor end StaticBodies.
	## Uses stored tangents from path sampling to push objects along
	## the correct direction at each end of the conveyor.
	if not _sb or not path_to_follow or not path_to_follow.curve:
		return

	var path_length: float = _get_path_length()
	if path_length <= 0.0:
		return

	var curve = path_to_follow.curve
	var mid_offset: float = path_length * 0.5
	var next_offset: float = min(mid_offset + 0.01, path_length)
	var prev_offset: float = max(mid_offset - 0.01, 0.0)
	var next_pos: Vector3 = curve.sample_baked(next_offset)
	var prev_pos: Vector3 = curve.sample_baked(prev_offset)
	var tangent: Vector3 = (next_pos - prev_pos).normalized()
	if tangent.length_squared() < 0.001:
		tangent = Vector3.FORWARD

	if _conveyor_end1:
		var sb1 = _conveyor_end1.get_node_or_null("StaticBody3D") as StaticBody3D
		if sb1:
			sb1.constant_linear_velocity = _start_tangent * speed
	if _conveyor_end2:
		var sb2 = _conveyor_end2.get_node_or_null("StaticBody3D") as StaticBody3D
		if sb2:
			sb2.constant_linear_velocity = _end_tangent * speed


# =============================================================================
# PATH SAMPLING
# =============================================================================

func _get_path_length() -> float:
	if not path_to_follow or not path_to_follow.curve:
		return 1.0
	return path_to_follow.curve.get_baked_length()

func _create_vertices(segments: int) -> Array:
	## Samples the path curve to generate vertex data for mesh generation.
	## Returns array of dictionaries with inner/outer top/bottom positions, plus
	## tangent, normal, and tilt data for each segment point.
	## Compensates for MeshInstance3D scale [0.5, 1, 0.5] by using 2x multiplier on X/Z.
	var all_vertices: Array = []
	if not path_to_follow or not path_to_follow.curve:
		return all_vertices

	var curve: Curve3D = path_to_follow.curve
	var path_length: float = curve.get_baked_length()
	if path_length <= 0.0:
		return all_vertices

	const SCALE_FACTOR: float = 2.0
	var half_width: float = conveyor_width / 2.0
	var height: float = belt_height

	for i in range(segments + 1):
		var t: float = float(i) / float(segments)
		var offset: float = t * path_length
		var pos: Vector3 = curve.sample_baked(offset)

		var tangent: Vector3
		if i == 0:
			var next_pos: Vector3 = curve.sample_baked(min(offset + 0.01, path_length))
			tangent = (next_pos - pos).normalized()
		elif i == segments:
			var prev_pos: Vector3 = curve.sample_baked(max(offset - 0.01, 0.0))
			tangent = (pos - prev_pos).normalized()
		else:
			var prev_pos: Vector3 = curve.sample_baked(offset - 0.01)
			var next_pos: Vector3 = curve.sample_baked(offset + 0.01)
			tangent = (next_pos - prev_pos).normalized()

		if tangent.length_squared() < 0.001:
			tangent = Vector3.FORWARD

		var max_tilt_rad: float = deg_to_rad(max_tilt_angle)
		var clamped_tilt: float = clamp(asin(clamp(tangent.y, -1.0, 1.0)), -max_tilt_rad, max_tilt_rad)

		var h_tangent: Vector3 = Vector3(tangent.x, 0.0, tangent.z).normalized()
		if h_tangent.length_squared() < 0.001:
			h_tangent = Vector3.FORWARD

		var right: Vector3 = h_tangent.cross(Vector3.UP).normalized()
		if right.length_squared() < 0.001:
			right = Vector3.RIGHT

		var up: Vector3 = Vector3.UP.rotated(right, clamped_tilt)

		var half_height: float = height / 2.0
		var scaled_pos: Vector3 = Vector3(pos.x * SCALE_FACTOR, pos.y, pos.z * SCALE_FACTOR)
		var scaled_right: Vector3 = right * SCALE_FACTOR

		var inner_top: Vector3 = scaled_pos + (-scaled_right * half_width) + (up * half_height)
		var outer_top: Vector3 = scaled_pos + (scaled_right * half_width) + (up * half_height)
		var inner_bottom: Vector3 = scaled_pos + (-scaled_right * half_width) - (up * half_height)
		var outer_bottom: Vector3 = scaled_pos + (scaled_right * half_width) - (up * half_height)

		all_vertices.append({
			"inner_top": inner_top,
			"outer_top": outer_top,
			"inner_bottom": inner_bottom,
			"outer_bottom": outer_bottom,
			"t": t,
			"right": right,
			"tangent": h_tangent,
			"up": up,
			"tilt": clamped_tilt
		})

	return all_vertices


# =============================================================================
# MESH GENERATION
# =============================================================================

func _create_conveyor_mesh() -> void:
	## Generates the complete conveyor mesh from path sampling data.
	## Creates top/bottom belt surfaces, side walls with metal texture,
	## and belt edge strips using the curved_belt_conveyor mesh pattern.
	var segments: int = path_segments
	var all_vertices: Array = _create_vertices(segments)
	if all_vertices.size() < 2:
		return

	var mesh_instance: ArrayMesh = ArrayMesh.new()
	_setup_materials()

	var surfaces: Dictionary = _create_surfaces()
	var edges: Dictionary = _create_belt_edges()

	_build_belt_surfaces(surfaces, edges, all_vertices, segments)
	_build_belt_edges(edges, segments)
	_add_belt_edges_to_surfaces(surfaces, edges)
	_add_surfaces_to_mesh(surfaces, mesh_instance)

	_mesh_instance.mesh = mesh_instance


func _setup_materials() -> void:
	_belt_material = ShaderMaterial.new()
	_belt_material.shader = load("res://assets/3DModels/Shaders/BeltShader.tres") as Shader
	_belt_material.set_shader_parameter("ColorMix", belt_color)
	_belt_material.set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)
	_update_belt_material_scale()

	var path_length: float = _get_path_length()
	var base_radius: float = clamp(round((belt_height - 0.01) * 100.0) / 100.0, 0.01, 0.25)
	var base_belt_length: float = PI * base_radius
	var belt_scale: float = path_length / base_belt_length if path_length > 0.0 else 1.0
	_belt_material.set_shader_parameter("EdgeScale", belt_scale * 1.2)

	_metal_material = ShaderMaterial.new()
	_metal_material.shader = load("res://assets/3DModels/Shaders/MetalShader.tres") as Shader
	_metal_material.set_shader_parameter("Color", Color("#56a7c8"))
	_update_metal_material_scale()


func _create_surfaces() -> Dictionary:
	return {
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
		},
		"sides": {
			"vertices": PackedVector3Array(),
			"normals": PackedVector3Array(),
			"uvs": PackedVector2Array(),
			"indices": PackedInt32Array(),
			"vertex_count": 0
		},
		"belt_edges": {
			"vertices": PackedVector3Array(),
			"normals": PackedVector3Array(),
			"uvs": PackedVector2Array(),
			"indices": PackedInt32Array(),
			"vertex_count": 0
		}
	}


func _create_belt_edges() -> Dictionary:
	return {
		"top_inner": {
			"vertices": PackedVector3Array(),
			"normals": PackedVector3Array(),
			"uvs": PackedVector2Array(),
			"indices": PackedInt32Array(),
		},
		"top_outer": {
			"vertices": PackedVector3Array(),
			"normals": PackedVector3Array(),
			"uvs": PackedVector2Array(),
			"indices": PackedInt32Array(),
		},
		"bottom_inner": {
			"vertices": PackedVector3Array(),
			"normals": PackedVector3Array(),
			"uvs": PackedVector2Array(),
			"indices": PackedInt32Array(),
		},
		"bottom_outer": {
			"vertices": PackedVector3Array(),
			"normals": PackedVector3Array(),
			"uvs": PackedVector2Array(),
			"indices": PackedInt32Array(),
		}
	}


func _build_belt_surfaces(surfaces: Dictionary, edges: Dictionary, all_vertices: Array, segments: int) -> void:
	_build_top_and_bottom_surfaces(surfaces, all_vertices)
	_create_surface_triangles(surfaces, segments)
	_create_inner_walls(surfaces, edges, all_vertices, segments)
	_create_outer_walls(surfaces, edges, all_vertices, segments)


func _build_top_and_bottom_surfaces(surfaces: Dictionary, all_vertices: Array) -> void:
	for i in range(len(all_vertices)):
		var vertex_data: Dictionary = all_vertices[i]
		surfaces.top.vertices.append_array([vertex_data.inner_top, vertex_data.outer_top])
		surfaces.top.normals.append_array([Vector3.UP, Vector3.UP])
		surfaces.top.uvs.append_array([Vector2(1, 1 - vertex_data.t), Vector2(0, 1 - vertex_data.t)])

	for i in range(len(all_vertices)):
		var vertex_data: Dictionary = all_vertices[i]
		surfaces.bottom.vertices.append_array([vertex_data.inner_bottom, vertex_data.outer_bottom])
		surfaces.bottom.normals.append_array([Vector3.DOWN, Vector3.DOWN])
		surfaces.bottom.uvs.append_array([Vector2(0, vertex_data.t), Vector2(1, vertex_data.t)])


func _create_surface_triangles(surfaces: Dictionary, segments: int) -> void:
	for i in range(segments):
		var idx: int = i * 2
		_add_double_sided_triangle(surfaces.top.indices, idx, idx + 1, idx + 3)
		_add_double_sided_triangle(surfaces.top.indices, idx, idx + 3, idx + 2)
		_add_double_sided_triangle(surfaces.bottom.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.bottom.indices, idx, idx + 3, idx + 1)


func _create_inner_walls(surfaces: Dictionary, edges: Dictionary, all_vertices: Array, segments: int) -> void:
	var total_inset_percent: float = 0.03
	var diagonal_percent: float = 0.012
	var flat_percent: float = 0.018

	var middle_vertices: Array = []
	var top_metal_lip_vertices: Array = []
	var bottom_metal_lip_vertices: Array = []
	var top_metal_to_flat_vertices: Array = []
	var bottom_flat_to_metal_vertices: Array = []
	var top_flat_vertices: Array = []
	var bottom_flat_vertices: Array = []

	for i in range(len(all_vertices)):
		var vertex_data: Dictionary = all_vertices[i]
		var horizontal_dir: Vector3 = (vertex_data.outer_top - vertex_data.inner_top).normalized()
		var normal: Vector3 = -horizontal_dir
		normal.y = 0
		normal = normal.normalized()

		var top_y: float = vertex_data.inner_top.y
		var bottom_y: float = vertex_data.inner_bottom.y
		var lip_height: float = (top_y - bottom_y) * 0.16
		var half_lip_height: float = lip_height / 2
		var wall_width: float = (vertex_data.outer_top - vertex_data.inner_top).length()
		var diagonal_offset_amount: float = wall_width * diagonal_percent
		var flat_offset_amount: float = wall_width * flat_percent

		var inner_top: Vector3 = vertex_data.inner_top
		var inner_top_belt_lip: Vector3 = Vector3(vertex_data.inner_top.x, top_y - half_lip_height, vertex_data.inner_top.z)
		var inner_top_metal_lip: Vector3 = Vector3(vertex_data.inner_top.x, top_y - lip_height, vertex_data.inner_top.z)

		var diagonal_height_top_total: float = (top_y - bottom_y) * 0.04
		var inner_top_diagonal: Vector3 = Vector3(vertex_data.inner_top.x, top_y - lip_height - diagonal_height_top_total, vertex_data.inner_top.z)
		var diagonal_offset: Vector3 = horizontal_dir * diagonal_offset_amount
		var inner_top_diagonal_offset: Vector3 = inner_top_diagonal + diagonal_offset
		var flat_offset: Vector3 = horizontal_dir * flat_offset_amount
		var inner_top_flat: Vector3 = inner_top_diagonal_offset + flat_offset

		var inner_bottom: Vector3 = vertex_data.inner_bottom
		var inner_bottom_belt_lip: Vector3 = Vector3(vertex_data.inner_bottom.x, bottom_y + half_lip_height, vertex_data.inner_bottom.z)
		var inner_bottom_metal_lip: Vector3 = Vector3(vertex_data.inner_bottom.x, bottom_y + lip_height, vertex_data.inner_bottom.z)

		var diagonal_height_bottom_total: float = (top_y - bottom_y) * 0.04
		var inner_bottom_diagonal: Vector3 = Vector3(vertex_data.inner_bottom.x, bottom_y + lip_height + diagonal_height_bottom_total, vertex_data.inner_bottom.z)
		var diagonal_offset_bottom: Vector3 = horizontal_dir * diagonal_offset_amount
		var inner_bottom_diagonal_offset: Vector3 = inner_bottom_diagonal + diagonal_offset_bottom
		var flat_offset_bottom: Vector3 = horizontal_dir * flat_offset_amount
		var inner_bottom_inner: Vector3 = inner_bottom_diagonal_offset + flat_offset_bottom

		var top_flat_normal: Vector3 = Vector3(normal.x * 0.8, -0.8, normal.z * 0.8).normalized()
		var bottom_flat_normal: Vector3 = Vector3(normal.x * 0.8, 0.8, normal.z * 0.8).normalized()
		var top_diag_normal: Vector3 = Vector3(normal.x * 0.8, -0.8, normal.z * 0.8).normalized()
		var bottom_diag_normal: Vector3 = Vector3(normal.x * 0.8, 0.8, normal.z * 0.8).normalized()

		middle_vertices.append([inner_top_flat, inner_bottom_inner, normal, Vector2(vertex_data.t, 0), Vector2(vertex_data.t, 1.0)])
		top_metal_lip_vertices.append([inner_top_belt_lip, inner_top_metal_lip, normal, Vector2(vertex_data.t, 0.8), Vector2(vertex_data.t, 1.0)])
		bottom_metal_lip_vertices.append([inner_bottom_metal_lip, inner_bottom_belt_lip, normal, Vector2(vertex_data.t, 0.0), Vector2(vertex_data.t, 0.2)])
		top_metal_to_flat_vertices.append([inner_top_metal_lip, inner_top_diagonal_offset, top_diag_normal, Vector2(vertex_data.t, 0.6), Vector2(vertex_data.t, 0.8)])
		bottom_flat_to_metal_vertices.append([inner_bottom_diagonal_offset, inner_bottom_metal_lip, bottom_diag_normal, Vector2(vertex_data.t, 0.2), Vector2(vertex_data.t, 0.4)])
		top_flat_vertices.append([inner_top_diagonal_offset, inner_top_flat, top_flat_normal, Vector2(vertex_data.t, 0.35), Vector2(vertex_data.t, 0.4)])
		bottom_flat_vertices.append([inner_bottom_inner, inner_bottom_diagonal_offset, bottom_flat_normal, Vector2(vertex_data.t, 0.6), Vector2(vertex_data.t, 0.65)])

		var scale_factor: float = 0.5
		edges.top_inner.vertices.append_array([inner_top, inner_top_belt_lip])
		edges.top_inner.normals.append_array([normal, normal])
		edges.top_inner.uvs.append_array([Vector2(0, 1 - vertex_data.t * scale_factor), Vector2(0.05, 1 - vertex_data.t * scale_factor)])
		edges.bottom_inner.vertices.append_array([inner_bottom_belt_lip, inner_bottom])
		edges.bottom_inner.normals.append_array([normal, normal])
		edges.bottom_inner.uvs.append_array([Vector2(0.95, vertex_data.t * scale_factor), Vector2(1, vertex_data.t * scale_factor)])

	_build_inner_wall_sections(surfaces, middle_vertices, top_metal_lip_vertices, bottom_metal_lip_vertices,
								top_metal_to_flat_vertices, bottom_flat_to_metal_vertices, top_flat_vertices,
								bottom_flat_vertices, segments)


func _create_outer_walls(surfaces: Dictionary, edges: Dictionary, all_vertices: Array, segments: int) -> void:
	var diagonal_percent: float = 0.012
	var flat_percent: float = 0.018

	var outer_middle_vertices: Array = []
	var outer_top_metal_lip_vertices: Array = []
	var outer_bottom_metal_lip_vertices: Array = []
	var outer_top_metal_to_flat_vertices: Array = []
	var outer_bottom_flat_to_metal_vertices: Array = []
	var outer_top_flat_vertices: Array = []
	var outer_bottom_flat_vertices: Array = []

	for i in range(len(all_vertices)):
		var vertex_data: Dictionary = all_vertices[i]
		var horizontal_dir: Vector3 = (vertex_data.inner_top - vertex_data.outer_top).normalized()
		var normal: Vector3 = -horizontal_dir
		normal.y = 0
		normal = normal.normalized()

		var top_y: float = vertex_data.outer_top.y
		var bottom_y: float = vertex_data.outer_bottom.y
		var lip_height: float = (top_y - bottom_y) * 0.16
		var half_lip_height: float = lip_height / 2
		var wall_width: float = (vertex_data.outer_top - vertex_data.inner_top).length()
		var diagonal_offset_amount: float = wall_width * diagonal_percent
		var flat_offset_amount: float = wall_width * flat_percent

		var outer_top: Vector3 = vertex_data.outer_top
		var outer_top_belt_lip: Vector3 = Vector3(vertex_data.outer_top.x, top_y - half_lip_height, vertex_data.outer_top.z)
		var outer_top_metal_lip: Vector3 = Vector3(vertex_data.outer_top.x, top_y - lip_height, vertex_data.outer_top.z)

		var diagonal_height_top_total: float = (top_y - bottom_y) * 0.04
		var outer_top_diagonal: Vector3 = Vector3(vertex_data.outer_top.x, top_y - lip_height - diagonal_height_top_total, vertex_data.outer_top.z)
		var diagonal_offset: Vector3 = horizontal_dir * diagonal_offset_amount
		var outer_top_diagonal_offset: Vector3 = outer_top_diagonal + diagonal_offset
		var flat_offset: Vector3 = horizontal_dir * flat_offset_amount
		var outer_top_flat: Vector3 = outer_top_diagonal_offset + flat_offset

		var outer_bottom: Vector3 = vertex_data.outer_bottom
		var outer_bottom_belt_lip: Vector3 = Vector3(vertex_data.outer_bottom.x, bottom_y + half_lip_height, vertex_data.outer_bottom.z)
		var outer_bottom_metal_lip: Vector3 = Vector3(vertex_data.outer_bottom.x, bottom_y + lip_height, vertex_data.outer_bottom.z)

		var diagonal_height_bottom_total: float = (top_y - bottom_y) * 0.04
		var outer_bottom_diagonal: Vector3 = Vector3(vertex_data.outer_bottom.x, bottom_y + lip_height + diagonal_height_bottom_total, vertex_data.outer_bottom.z)
		var diagonal_offset_bottom: Vector3 = horizontal_dir * diagonal_offset_amount
		var outer_bottom_diagonal_offset: Vector3 = outer_bottom_diagonal + diagonal_offset_bottom
		var flat_offset_bottom: Vector3 = horizontal_dir * flat_offset_amount
		var outer_bottom_flat: Vector3 = outer_bottom_diagonal_offset + flat_offset_bottom
		var outer_bottom_inner: Vector3 = outer_bottom_flat

		var top_flat_normal: Vector3 = Vector3(normal.x * 0.8, -0.6, normal.z * 0.8).normalized()
		var bottom_flat_normal: Vector3 = Vector3(normal.x * 0.8, 0.6, normal.z * 0.8).normalized()
		var top_diag_normal: Vector3 = Vector3(normal.x * 0.8, -0.6, normal.z * 0.8).normalized()
		var bottom_diag_normal: Vector3 = Vector3(normal.x * 0.8, 0.6, normal.z * 0.8).normalized()

		outer_middle_vertices.append([outer_top_flat, outer_bottom_inner, normal, Vector2(vertex_data.t, 0), Vector2(vertex_data.t, 1)])
		outer_top_metal_lip_vertices.append([outer_top_belt_lip, outer_top_metal_lip, normal, Vector2(vertex_data.t, 0.8), Vector2(vertex_data.t, 1.0)])
		outer_bottom_metal_lip_vertices.append([outer_bottom_metal_lip, outer_bottom_belt_lip, normal, Vector2(vertex_data.t, 0.0), Vector2(vertex_data.t, 0.2)])
		outer_top_metal_to_flat_vertices.append([outer_top_metal_lip, outer_top_diagonal_offset, top_diag_normal, Vector2(vertex_data.t, 0.6), Vector2(vertex_data.t, 0.8)])
		outer_bottom_flat_to_metal_vertices.append([outer_bottom_diagonal_offset, outer_bottom_metal_lip, bottom_diag_normal, Vector2(vertex_data.t, 0.2), Vector2(vertex_data.t, 0.4)])
		outer_top_flat_vertices.append([outer_top_diagonal_offset, outer_top_flat, top_flat_normal, Vector2(vertex_data.t, 0.35), Vector2(vertex_data.t, 0.4)])
		outer_bottom_flat_vertices.append([outer_bottom_inner, outer_bottom_diagonal_offset, bottom_flat_normal, Vector2(vertex_data.t, 0.6), Vector2(vertex_data.t, 0.65)])

		var scale_factor: float = 0.5
		edges.top_outer.vertices.append_array([outer_top, outer_top_belt_lip])
		edges.top_outer.normals.append_array([normal, normal])
		edges.top_outer.uvs.append_array([Vector2(1, 1 - vertex_data.t * scale_factor), Vector2(0.95, 1 - vertex_data.t * scale_factor)])
		edges.bottom_outer.vertices.append_array([outer_bottom_belt_lip, outer_bottom])
		edges.bottom_outer.normals.append_array([normal, normal])
		edges.bottom_outer.uvs.append_array([Vector2(0.05, vertex_data.t * scale_factor), Vector2(0, vertex_data.t * scale_factor)])

	_build_outer_wall_sections(surfaces, outer_middle_vertices, outer_top_metal_lip_vertices,
								outer_bottom_metal_lip_vertices, outer_top_metal_to_flat_vertices,
								outer_bottom_flat_to_metal_vertices, outer_top_flat_vertices,
								outer_bottom_flat_vertices, segments)


func _build_inner_wall_sections(surfaces: Dictionary, middle_vertices: Array, top_metal_lip_vertices: Array,
								bottom_metal_lip_vertices: Array, top_metal_to_flat_vertices: Array,
								bottom_flat_to_metal_vertices: Array, top_flat_vertices: Array,
								bottom_flat_vertices: Array, segments: int) -> void:
	surfaces.sides.vertices.clear()
	surfaces.sides.normals.clear()
	surfaces.sides.uvs.clear()
	surfaces.sides.indices.clear()

	for data in middle_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx: int = i * 2
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	var top_lip_start_idx: int = surfaces.sides.vertices.size()
	for data in top_metal_lip_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx: int = top_lip_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	var bottom_lip_start_idx: int = surfaces.sides.vertices.size()
	for data in bottom_metal_lip_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx: int = bottom_lip_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	var top_metal_to_flat_start_idx: int = surfaces.sides.vertices.size()
	for data in top_metal_to_flat_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx: int = top_metal_to_flat_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	var top_flat_start_idx: int = surfaces.sides.vertices.size()
	for data in top_flat_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx: int = top_flat_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	var bottom_flat_start_idx: int = surfaces.sides.vertices.size()
	for data in bottom_flat_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx: int = bottom_flat_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	var bottom_flat_to_metal_start_idx: int = surfaces.sides.vertices.size()
	for data in bottom_flat_to_metal_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx: int = bottom_flat_to_metal_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	surfaces.sides.vertex_count = surfaces.sides.vertices.size()


func _build_outer_wall_sections(surfaces: Dictionary, outer_middle_vertices: Array, outer_top_metal_lip_vertices: Array,
								outer_bottom_metal_lip_vertices: Array, outer_top_metal_to_flat_vertices: Array,
								outer_bottom_flat_to_metal_vertices: Array, outer_top_flat_vertices: Array,
								outer_bottom_flat_vertices: Array, segments: int) -> void:
	var outer_middle_start_idx: int = surfaces.sides.vertices.size()
	for data in outer_middle_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx: int = outer_middle_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	var outer_top_lip_start_idx: int = surfaces.sides.vertices.size()
	for data in outer_top_metal_lip_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx: int = outer_top_lip_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	var outer_bottom_lip_start_idx: int = surfaces.sides.vertices.size()
	for data in outer_bottom_metal_lip_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx: int = outer_bottom_lip_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	var outer_top_metal_to_flat_start_idx: int = surfaces.sides.vertices.size()
	for data in outer_top_metal_to_flat_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx: int = outer_top_metal_to_flat_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	var outer_top_flat_start_idx: int = surfaces.sides.vertices.size()
	for data in outer_top_flat_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx: int = outer_top_flat_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	var outer_bottom_flat_start_idx: int = surfaces.sides.vertices.size()
	for data in outer_bottom_flat_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx: int = outer_bottom_flat_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	var outer_bottom_flat_to_metal_start_idx: int = surfaces.sides.vertices.size()
	for data in outer_bottom_flat_to_metal_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx: int = outer_bottom_flat_to_metal_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	surfaces.sides.vertex_count = surfaces.sides.vertices.size()


func _build_belt_edges(edges: Dictionary, segments: int) -> void:
	for edge_name in edges.keys():
		for i in range(segments):
			var idx: int = i * 2
			if idx + 3 < edges[edge_name].vertices.size():
				_add_double_sided_triangle(edges[edge_name].indices, idx, idx + 1, idx + 3)
				_add_double_sided_triangle(edges[edge_name].indices, idx, idx + 3, idx + 2)


func _add_belt_edges_to_surfaces(surfaces: Dictionary, edges: Dictionary) -> void:
	for edge_name in edges.keys():
		var edge: Dictionary = edges[edge_name]
		if edge.vertices.size() == 0:
			continue

		var start_idx: int = surfaces.belt_edges.vertices.size()
		surfaces.belt_edges.vertices.append_array(edge.vertices)
		surfaces.belt_edges.normals.append_array(edge.normals)
		surfaces.belt_edges.uvs.append_array(edge.uvs)

		for i in range(0, edge.indices.size(), 3):
			if i + 2 < edge.indices.size():
				surfaces.belt_edges.indices.append_array([
					start_idx + edge.indices[i],
					start_idx + edge.indices[i + 1],
					start_idx + edge.indices[i + 2]
				])

	surfaces.belt_edges.vertex_count = surfaces.belt_edges.vertices.size()


func _add_double_sided_triangle(array_indices: PackedInt32Array, a: int, b: int, c: int) -> void:
	array_indices.append_array([a, b, c, c, b, a])


func _add_surfaces_to_mesh(surfaces: Dictionary, mesh_instance: ArrayMesh) -> void:
	for pair in [["top", 0], ["bottom", 1], ["sides", 2], ["belt_edges", 3]]:
		var surface_name: String = pair[0]
		var surface_index: int = pair[1]
		var surface: Dictionary = surfaces[surface_name]

		if surface.vertices.size() == 0:
			continue

		var arrays: Array = []
		arrays.resize(Mesh.ARRAY_MAX)
		arrays[Mesh.ARRAY_VERTEX] = surface.vertices
		arrays[Mesh.ARRAY_NORMAL] = surface.normals
		arrays[Mesh.ARRAY_TEX_UV] = surface.uvs
		arrays[Mesh.ARRAY_INDEX] = surface.indices
		mesh_instance.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)

		var material_to_use: Material = _belt_material
		if surface_name == "sides":
			material_to_use = _metal_material
		mesh_instance.surface_set_material(surface_index, material_to_use)


# =============================================================================
# COLLISION
# =============================================================================

func _setup_collision_shape() -> void:
	## Updates collision shape to match the generated mesh geometry.
	## Extracts triangle data from all mesh surfaces to populate the
	## ConcavePolygonShape3D for accurate physics collision.
	if not _sb:
		return

	var collision_shape: CollisionShape3D = _sb.get_node_or_null("CollisionShape3D") as CollisionShape3D
	if not collision_shape or not _mesh_instance or not _mesh_instance.mesh:
		return

	var mesh: ArrayMesh = _mesh_instance.mesh as ArrayMesh
	if not mesh:
		return

	var all_verts: PackedVector3Array = PackedVector3Array()
	var all_indices: PackedInt32Array = PackedInt32Array()

	for surface_idx in range(mesh.get_surface_count()):
		var arrays: Array = mesh.surface_get_arrays(surface_idx)
		var base_index: int = all_verts.size()
		all_verts.append_array(arrays[Mesh.ARRAY_VERTEX])
		for idx in arrays[Mesh.ARRAY_INDEX]:
			all_indices.append(base_index + idx)

	var triangle_verts: PackedVector3Array = PackedVector3Array()
	for i in range(0, all_indices.size(), 3):
		if i + 2 >= all_indices.size():
			break
		triangle_verts.append(all_verts[all_indices[i]])
		triangle_verts.append(all_verts[all_indices[i + 1]])
		triangle_verts.append(all_verts[all_indices[i + 2]])

	if collision_shape.shape is ConcavePolygonShape3D:
		collision_shape.shape.data = triangle_verts
		collision_shape.scale = Vector3(0.5, 1.0, 0.5)

	if _a3d is Area3D:
		_a3d.position = Vector3(0, 0.1, 0)
		var shape_node = _a3d.get_node_or_null("CollisionShape3D")
		shape_node.shape = collision_shape.shape
		shape_node.scale = collision_shape.scale
		_setup_end_collision_shapes()

		_collision_shape_start.shape = _conveyor_end1.get_node_or_null("StaticBody3D/CollisionShape3D").shape
		_collision_shape_start.global_transform = _conveyor_end1.get_node_or_null("StaticBody3D/CollisionShape3D").global_transform
		_collision_shape_end.shape = _conveyor_end2.get_node_or_null("StaticBody3D/CollisionShape3D").shape
		_collision_shape_end.global_transform = _conveyor_end2.get_node_or_null("StaticBody3D/CollisionShape3D").global_transform

		_collision_shape_start.global_position += Vector3(0, 0.1, 0)
		_collision_shape_end.global_position += Vector3(0, 0.1, 0)


func _setup_end_collision_shapes() -> void:
	## Creates/updates cylinder collision shapes at the BeltConveyorEnd positions
	## to extend the AffectArea3D coverage for smooth box entry and exit.
	if not _a3d or not _conveyor_end1 or not _conveyor_end2:
		return

	var cylinder_radius: float = belt_height / 2.0
	var cylinder_height: float = conveyor_width

	var start_h_tangent: Vector3 = Vector3(_start_tangent.x, 0.0, _start_tangent.z).normalized()
	var end_h_tangent: Vector3 = Vector3(_end_tangent.x, 0.0, _end_tangent.z).normalized()
	if start_h_tangent.length_squared() < 0.001:
		start_h_tangent = Vector3.FORWARD
	if end_h_tangent.length_squared() < 0.001:
		end_h_tangent = Vector3.FORWARD

	var start_tilt: float = asin(clamp(_start_tangent.y, -1.0, 1.0))
	var end_tilt: float = asin(clamp(_end_tangent.y, -1.0, 1.0))
	var max_tilt_rad: float = deg_to_rad(max_tilt_angle)
	start_tilt = clamp(start_tilt, -max_tilt_rad, max_tilt_rad)
	end_tilt = clamp(end_tilt, -max_tilt_rad, max_tilt_rad)

	var end1_collision: CollisionShape3D = _a3d.get_node_or_null("EndCollision1") as CollisionShape3D
	if not end1_collision:
		end1_collision = CollisionShape3D.new()
		end1_collision.name = "EndCollision1"
		var cylinder1 = CylinderShape3D.new()
		end1_collision.shape = cylinder1
		_a3d.add_child(end1_collision)

	var cylinder1: CylinderShape3D = end1_collision.shape as CylinderShape3D
	if cylinder1:
		cylinder1.radius = cylinder_radius
		cylinder1.height = cylinder_height

	end1_collision.position = _conveyor_end1.position - _a3d.position
	var start_angle_y: float = atan2(start_h_tangent.x, start_h_tangent.z)
	end1_collision.rotation = Vector3(-start_tilt, start_angle_y, PI / 2.0)

	var end2_collision: CollisionShape3D = _a3d.get_node_or_null("EndCollision2") as CollisionShape3D
	if not end2_collision:
		end2_collision = CollisionShape3D.new()
		end2_collision.name = "EndCollision2"
		var cylinder2 = CylinderShape3D.new()
		end2_collision.shape = cylinder2
		_a3d.add_child(end2_collision)

	var cylinder2: CylinderShape3D = end2_collision.shape as CylinderShape3D
	if cylinder2:
		cylinder2.radius = cylinder_radius
		cylinder2.height = cylinder_height

	end2_collision.position = _conveyor_end2.position - _a3d.position
	var end_angle_y: float = atan2(end_h_tangent.x, end_h_tangent.z)
	end2_collision.rotation = Vector3(end_tilt, end_angle_y, PI / 2.0)


# =============================================================================
# CONVEYOR ENDS
# =============================================================================

func _position_conveyor_ends() -> void:
	## Positions and orients the BeltConveyorEnd nodes at path start/end.
	## Calculates tangents for proper orientation and stores them for
	## velocity calculations. End1 faces inward (start), End2 faces outward (end).
	if not path_to_follow or not path_to_follow.curve:
		return
	if not _conveyor_end1 or not _conveyor_end2:
		return

	var curve: Curve3D = path_to_follow.curve
	var path_length: float = curve.get_baked_length()
	if path_length <= 0.0:
		return

	var start_pos: Vector3 = curve.sample_baked(0.0)
	var end_pos: Vector3 = curve.sample_baked(path_length)

	var start_tangent: Vector3 = (curve.sample_baked(min(0.01, path_length)) - start_pos).normalized()
	var end_tangent: Vector3 = (end_pos - curve.sample_baked(max(path_length - 0.01, 0.0))).normalized()

	if start_tangent.length_squared() < 0.001:
		start_tangent = Vector3.FORWARD
	if end_tangent.length_squared() < 0.001:
		end_tangent = Vector3.FORWARD

	_start_tangent = start_tangent
	_end_tangent = end_tangent

	_conveyor_end1.position = start_pos
	_conveyor_end2.position = end_pos

	var start_h_tangent: Vector3 = Vector3(start_tangent.x, 0.0, start_tangent.z).normalized()
	var end_h_tangent: Vector3 = Vector3(end_tangent.x, 0.0, end_tangent.z).normalized()
	if start_h_tangent.length_squared() < 0.001:
		start_h_tangent = Vector3.FORWARD
	if end_h_tangent.length_squared() < 0.001:
		end_h_tangent = Vector3.FORWARD

	var start_angle_y: float = atan2(-start_h_tangent.z, start_h_tangent.x) + PI
	var end_angle_y: float = atan2(-end_h_tangent.z, end_h_tangent.x)

	_conveyor_end1.rotation = Vector3(0, start_angle_y, 0)
	_conveyor_end2.rotation = Vector3(0, end_angle_y, 0)


func _update_belt_ends_size() -> void:
	var end_size: Vector3 = Vector3(belt_height, belt_height, conveyor_width)
	if _conveyor_end1:
		_conveyor_end1.size = end_size
	if _conveyor_end2:
		_conveyor_end2.size = end_size


func _update_belt_ends_speed() -> void:
	if _conveyor_end1:
		_conveyor_end1.speed = speed
		var sb1 = _conveyor_end1.get_node_or_null("StaticBody3D") as StaticBody3D
		if sb1 and SimulationEvents.simulation_running:
			sb1.constant_linear_velocity = _start_tangent * speed
	if _conveyor_end2:
		_conveyor_end2.speed = -speed
		var sb2 = _conveyor_end2.get_node_or_null("StaticBody3D") as StaticBody3D
		if sb2 and SimulationEvents.simulation_running:
			sb2.constant_linear_velocity = _end_tangent * speed


# =============================================================================
# MATERIALS
# =============================================================================

func _update_belt_material_scale() -> void:
	if not _belt_material:
		return
	var path_length: float = _get_path_length()
	var base_radius: float = clamp(round((belt_height - 0.01) * 100.0) / 100.0, 0.01, 0.25)
	var base_belt_length: float = PI * base_radius
	var belt_scale: float = path_length / base_belt_length if path_length > 0.0 else 1.0
	_belt_material.set_shader_parameter("Scale", belt_scale * sign(speed) if speed != 0.0 else belt_scale)


func _update_metal_material_scale() -> void:
	if not _metal_material:
		return
	var path_length: float = _get_path_length()
	_metal_material.set_shader_parameter("Scale", path_length)
	_metal_material.set_shader_parameter("Scale2", 1.0)


func _set_belt_material_on_ends() -> void:
	for ce in [_conveyor_end1, _conveyor_end2]:
		if ce and ce is BeltConveyorEnd:
			var mesh_inst: MeshInstance3D = ce.get_node_or_null("MeshInstance3D") as MeshInstance3D
			if mesh_inst:
				var mat: ShaderMaterial = mesh_inst.get_surface_override_material(0) as ShaderMaterial
				if mat:
					mat.set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)
					mat.set_shader_parameter("ColorMix", belt_color)


# =============================================================================
# UPDATE METHODS
# =============================================================================

func _update_calculated_size() -> void:
	var path_length: float = _get_path_length()
	var old_size: Vector3 = _calculated_size
	_calculated_size = Vector3(path_length, belt_height, conveyor_width)
	if old_size != _calculated_size:
		size_changed.emit()


func _update_all_components() -> void:
	if not is_inside_tree():
		return

	if _mesh_regeneration_needed:
		_create_conveyor_mesh()
		_setup_collision_shape()
		_position_conveyor_ends()
		_mesh_regeneration_needed = false

	_update_belt_ends_size()
	_update_belt_ends_speed()
	_update_calculated_size()


func _on_path_changed() -> void:
	_mesh_regeneration_needed = true
	if is_inside_tree():
		_update_all_components()


# =============================================================================
# SIMULATION EVENTS
# =============================================================================

func _on_simulation_started() -> void:
	_update_belt_ends_speed()
	if enable_comms:
		_register_speed_tag_ok = OIPComms.register_tag(speed_tag_group_name, speed_tag_name, 1)
		_register_running_tag_ok = OIPComms.register_tag(running_tag_group_name, running_tag_name, 1)


func _on_simulation_ended() -> void:
	_belt_position = 0.0
	if _belt_material:
		_belt_material.set_shader_parameter("BeltPosition", _belt_position)

	if _sb:
		for child in _sb.get_children():
			if child is Node3D:
				child.position = Vector3.ZERO
				child.rotation = Vector3.ZERO

	if _conveyor_end1:
		var sb1 = _conveyor_end1.get_node_or_null("StaticBody3D") as StaticBody3D
		if sb1:
			sb1.constant_linear_velocity = Vector3.ZERO
	if _conveyor_end2:
		var sb2 = _conveyor_end2.get_node_or_null("StaticBody3D") as StaticBody3D
		if sb2:
			sb2.constant_linear_velocity = Vector3.ZERO


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


# =============================================================================
# PUBLIC API
# =============================================================================

func get_conveyor_end1() -> Node:
	return _conveyor_end1


func get_conveyor_end2() -> Node:
	return _conveyor_end2
