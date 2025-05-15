@tool
class_name CurvedBeltConveyor
extends ResizableNode3D

enum ConvTexture {
	STANDARD,
	ALTERNATE
}

const BASE_INNER_RADIUS: float = 0.25
const BASE_OUTER_RADIUS: float = 1.25
const BASE_CONVEYOR_WIDTH: float = BASE_OUTER_RADIUS - BASE_INNER_RADIUS

# Default size for the conveyor
const SIZE_DEFAULT: Vector3 = Vector3(1.524, 0.5, 1.524)

@export var belt_color: Color = Color(1, 1, 1, 1):
	set(value):
		belt_color = value
		if _belt_material:
			(_belt_material as ShaderMaterial).set_shader_parameter("ColorMix", belt_color)
		set_belt_material_shader_params_on_ends()

@export var belt_texture = ConvTexture.STANDARD:
	set(value):
		belt_texture = value
		if _belt_material:
			(_belt_material as ShaderMaterial).set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)
		set_belt_material_shader_params_on_ends()

@export_range(5.0, 90.0, 1.0, "degrees") var conveyor_angle: float = 90.0:
	set(value):
		if conveyor_angle == value:
			return
		conveyor_angle = value
		update_visible_meshes()

@export var speed: float = 2:
	set(value):
		if value == speed:
			return
		speed = value
		_recalculate_speeds()
		_update_belt_material_scale()
		if _register_speed_tag_ok and _speed_tag_group_init:
			OIPComms.write_float32(speed_tag_group_name, speed_tag_name, value)
		if _register_running_tag_ok and _running_tag_group_init:
			OIPComms.write_bit(running_tag_group_name, running_tag_name, value > 0.0)

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

var _sb: StaticBody3D
var mesh: MeshInstance3D
var _belt_material: Material
var _metal_material: Material
var belt_position: float = 0.0
var origin: Vector3
var _angular_speed: float = 0.0
var _linear_speed: float = 0.0
var _prev_scale_x: float = 1.0
var curved_mesh: MeshInstance3D

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

func set_belt_material_shader_params_on_ends() -> void:
	var ce1 = get_conveyor_end1()
	var ce2 = get_conveyor_end2()
	
	if ce1 and ce1 is BeltConveyorEnd:
		var mesh_instance = ce1.get_node_or_null("MeshInstance3D")
		if mesh_instance and mesh_instance is MeshInstance3D:
			var material = mesh_instance.get_surface_override_material(0)
			if material and material is ShaderMaterial:
				material.set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)
				material.set_shader_parameter("ColorMix", belt_color)
	
	if ce2 and ce2 is BeltConveyorEnd:
		var mesh_instance = ce2.get_node_or_null("MeshInstance3D")
		if mesh_instance and mesh_instance is MeshInstance3D:
			var material = mesh_instance.get_surface_override_material(0)
			if material and material is ShaderMaterial:
				material.set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)
				material.set_shader_parameter("ColorMix", belt_color)

func _init() -> void:
	set_notify_local_transform(true)
	# SIZE_DEFAULT already initialized at class level

func _ready() -> void:
	_sb = get_node("StaticBody3D") as StaticBody3D
	origin = _sb.position

	var ce1 = get_conveyor_end1()
	var ce2 = get_conveyor_end2()
	
	# Update BlackTextureOn parameter on conveyor ends
	if ce1 and ce1 is BeltConveyorEnd:
		var mesh_instance = ce1.get_node_or_null("MeshInstance3D")
		if mesh_instance and mesh_instance is MeshInstance3D:
			var material = mesh_instance.get_surface_override_material(0)
			if material and material is ShaderMaterial:
				material.set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)
	
	if ce2 and ce2 is BeltConveyorEnd:
		var mesh_instance = ce2.get_node_or_null("MeshInstance3D")
		if mesh_instance and mesh_instance is MeshInstance3D:
			var material = mesh_instance.get_surface_override_material(0)
			if material and material is ShaderMaterial:
				material.set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)
	
	if _belt_material:
		(_belt_material as ShaderMaterial).set_shader_parameter("ColorMix", belt_color)
	
	# Update ColorMix parameter on conveyor ends
	if ce1 and ce1 is BeltConveyorEnd:
		var mesh_instance = ce1.get_node_or_null("MeshInstance3D")
		if mesh_instance and mesh_instance is MeshInstance3D:
			var material = mesh_instance.get_surface_override_material(0)
			if material and material is ShaderMaterial:
				material.set_shader_parameter("ColorMix", belt_color)
	
	if ce2 and ce2 is BeltConveyorEnd:
		var mesh_instance = ce2.get_node_or_null("MeshInstance3D")
		if mesh_instance and mesh_instance is MeshInstance3D:
			var material = mesh_instance.get_surface_override_material(0)
			if material and material is ShaderMaterial:
				material.set_shader_parameter("ColorMix", belt_color)
	
	_recalculate_speeds()
	if ce1:
		ce1.size = Vector3(size.y, size.y, size.x)
		ce1.speed = _linear_speed
	if ce2:
		ce2.size = Vector3(size.y, size.y, size.x)
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
	update_visible_meshes()
	_update_belt_material_scale()

func update_visible_meshes() -> void:
	if not is_inside_tree():
		return
		
	_position_conveyor_ends()
	_create_conveyor_mesh()
	_setup_collision_shape()

func _position_conveyor_ends() -> void:
	var ce1 = get_conveyor_end1()
	var ce2 = get_conveyor_end2()
	assert(ce1 != null)
	assert(ce2 != null)
	
	var radians: = deg_to_rad(conveyor_angle)
	
	# Position ends with y offset to keep top surface at y=0
	ce1.position = Vector3(-sin(radians) * size.x * 0.75, -size.y/2.0, cos(radians) * size.x * 0.75)
	ce1.rotation.y = -radians
	ce2.position = Vector3(0, -size.y/2.0, size.x * BASE_OUTER_RADIUS * 0.6)
	ce2.rotation.y = 0

func _create_conveyor_mesh() -> void:
	var segments := conveyor_angle / 3.0
	
	var angle_radians: float = deg_to_rad(conveyor_angle)
	var radius_inner: float = BASE_INNER_RADIUS * size.x
	var radius_outer: float = BASE_OUTER_RADIUS * size.x
	const DEFAULT_HEIGHT_RATIO: float = 0.50
	var height = DEFAULT_HEIGHT_RATIO * size.y 
	var scale_factor := 2.0

	var mesh_instance: = ArrayMesh.new()

	_setup_materials()
	
	var surfaces = _create_surfaces()
	var edges = _create_belt_edges()
	var all_vertices = _create_vertices(segments, angle_radians, radius_inner, radius_outer, height, scale_factor)
	
	_build_belt_surfaces(surfaces, edges, all_vertices, segments)
	_build_belt_edges(edges, segments)
	
	_add_surfaces_to_mesh(surfaces, mesh_instance)
	
	# Assign mesh to MeshInstance3D
	curved_mesh = $StaticBody3D/MeshInstance3D
	curved_mesh.mesh = mesh_instance

func _setup_materials() -> void:
	_belt_material = ShaderMaterial.new()
	_belt_material.shader = load("res://assets/3DModels/Shaders/BeltShader.tres") as Shader
	_belt_material.set_shader_parameter("ColorMix", belt_color)
	_belt_material.set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)
	_update_belt_material_scale()
	
	# Add an edge scale parameter for belt edges
	var avg_radius: float = size.x * (BASE_OUTER_RADIUS + BASE_INNER_RADIUS) / 2.0
	var angle_portion = conveyor_angle / 360.0
	var belt_length: float = 2.0 * PI * avg_radius * angle_portion
	var belt_scale: float = belt_length / (PI * 1.0)  # Base belt length is PI * 1.0
	_belt_material.set_shader_parameter("EdgeScale", belt_scale * 1.2)
	
	_metal_material = ShaderMaterial.new()  
	_metal_material.shader = load("res://assets/3DModels/Shaders/MetalShaderCorner.tres") as Shader  
	_metal_material.set_shader_parameter("Color", Color("#56a7c8"))
	_update_metal_material_scale()

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
		},
		"sides": {
			"vertices": PackedVector3Array(),
			"normals": PackedVector3Array(),
			"uvs": PackedVector2Array(),
			"indices": PackedInt32Array(),
			"vertex_count": 0
		}
	}
	return surfaces

func _create_belt_edges() -> Dictionary:
	var edges = {
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
	return edges

func _create_vertices(segments: int, angle_radians: float, radius_inner: float, radius_outer: float, height: float, scale_factor: float) -> Array:
	var all_vertices = []
	for i in range(segments + 1):
		var t = float(i) / segments
		var angle: float = t * angle_radians
		var sin_a: float = sin(angle)
		var cos_a: float = cos(angle)
		
		# Modify vertical positioning to keep top surface at y=0
		var inner_top = Vector3(-sin_a * radius_inner, 0 + 0.125, cos_a * radius_inner) * scale_factor
		var outer_top = Vector3(-sin_a * radius_outer, 0+ 0.125, cos_a * radius_outer) * scale_factor
		var inner_bottom = Vector3(-sin_a * radius_inner, -height+ 0.125, cos_a * radius_inner) * scale_factor
		var outer_bottom = Vector3(-sin_a * radius_outer, -height+ 0.125, cos_a * radius_outer) * scale_factor
		
		all_vertices.append({
			"inner_top": inner_top,
			"outer_top": outer_top,
			"inner_bottom": inner_bottom,
			"outer_bottom": outer_bottom,
			"t": t
		})
	return all_vertices

func _build_belt_surfaces(surfaces: Dictionary, edges: Dictionary, all_vertices: Array, segments: int) -> void:
	_build_top_and_bottom_surfaces(surfaces, all_vertices)
	_create_surface_triangles(surfaces, segments)
	_create_inner_walls(surfaces, edges, all_vertices, segments)
	_create_outer_walls(surfaces, edges, all_vertices, segments)
	_build_belt_edges(edges, segments)
	_add_belt_edges_to_surfaces(surfaces, edges)

func _build_top_and_bottom_surfaces(surfaces: Dictionary, all_vertices: Array) -> void:
	# Create top surface
	for i in range(len(all_vertices)):
		var vertex_data = all_vertices[i]
		surfaces.top.vertices.append_array([vertex_data.inner_top, vertex_data.outer_top])
		surfaces.top.normals.append_array([Vector3.UP, Vector3.UP])
		surfaces.top.uvs.append_array([Vector2(1, 1-vertex_data.t), Vector2(0, 1-vertex_data.t)])
		
	# Get the same UV mapping style for edges as for the main belt
	var texture_scale_u = 1.0
	var texture_scale_v = 2.0
	var texture_offset_v = 0.0
		
	# Store these for edge UV mapping
	surfaces.uvs_info = {
		"scale_u": texture_scale_u,
		"scale_v": texture_scale_v,
		"offset_v": texture_offset_v
	}

	# Create bottom surface
	for i in range(len(all_vertices)):
		var vertex_data = all_vertices[i]
		surfaces.bottom.vertices.append_array([vertex_data.inner_bottom, vertex_data.outer_bottom])
		surfaces.bottom.normals.append_array([Vector3.DOWN, Vector3.DOWN])
		surfaces.bottom.uvs.append_array([Vector2(0, vertex_data.t), Vector2(1, vertex_data.t)])

func _create_surface_triangles(surfaces: Dictionary, segments: int) -> void:
	# Create triangles for top and bottom
	for i in range(segments):
		var idx = i * 2
		_add_double_sided_triangle(surfaces.top.indices, idx, idx + 1, idx + 3)
		_add_double_sided_triangle(surfaces.top.indices, idx, idx + 3, idx + 2)
		
		_add_double_sided_triangle(surfaces.bottom.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.bottom.indices, idx, idx + 3, idx + 1)

func _create_inner_walls(surfaces: Dictionary, edges: Dictionary, all_vertices: Array, segments: int) -> void:
	# Calculate inset factor for wall geometry
	var inset_factor: float = 0.038 * (size.x / SIZE_DEFAULT.x - 1)
	inset_factor = max(inset_factor, 0.0)
	
	var middle_vertices = []
	var top_metal_lip_vertices = []
	var bottom_metal_lip_vertices = []
	var top_metal_to_flat_vertices = []
	var bottom_flat_to_metal_vertices = []
	var top_flat_vertices = []
	var bottom_flat_vertices = []

	for i in range(len(all_vertices)):
		var vertex_data = all_vertices[i]
		var normal: Vector3 = (vertex_data.inner_top - Vector3(0, 0, 0)).normalized()
		normal.y = 0
		normal = -normal.normalized()

		var top_y: float = vertex_data.inner_top.y
		var bottom_y: float = vertex_data.inner_bottom.y
		var lip_height: float = (top_y - bottom_y) * 0.16
		var half_lip_height: float = lip_height / 2
		var horizontal_dir: Vector3 = (vertex_data.outer_top - vertex_data.inner_top).normalized()

		# Top vertices
		var inner_top: Vector3 = vertex_data.inner_top 
		var inner_top_belt_lip: Vector3 = Vector3(vertex_data.inner_top.x, top_y - half_lip_height, vertex_data.inner_top.z)
		var inner_top_metal_lip: Vector3 = Vector3(vertex_data.inner_top.x, top_y - lip_height, vertex_data.inner_top.z)

		# Diagonal and flat sections for top
		var diagonal_height_top_total: float = (top_y - bottom_y) * 0.04
		var inner_top_diagonal: Vector3 = Vector3(vertex_data.inner_top.x, top_y - lip_height - diagonal_height_top_total, vertex_data.inner_top.z)
		var diagonal_offset: Vector3 = horizontal_dir * (0.03 + inset_factor)
		var inner_top_diagonal_offset: Vector3 = inner_top_diagonal + diagonal_offset
		var flat_offset: Vector3 = horizontal_dir * (0.047 + inset_factor)
		var inner_top_flat: Vector3 = inner_top_diagonal_offset + flat_offset

		# Bottom vertices
		var inner_bottom: Vector3 = vertex_data.inner_bottom
		var inner_bottom_belt_lip: Vector3 = Vector3(vertex_data.inner_bottom.x, bottom_y + half_lip_height, vertex_data.inner_bottom.z)
		var inner_bottom_metal_lip: Vector3 = Vector3(vertex_data.inner_bottom.x, bottom_y + lip_height, vertex_data.inner_bottom.z)

		# Diagonal and flat sections for bottom
		var diagonal_height_bottom_total: float = (top_y - bottom_y) * 0.04
		var inner_bottom_diagonal: Vector3 = Vector3(vertex_data.inner_bottom.x, bottom_y + lip_height + diagonal_height_bottom_total, vertex_data.inner_bottom.z)
		var diagonal_offset_bottom: Vector3 = horizontal_dir * (0.03 + inset_factor)
		var inner_bottom_diagonal_offset: Vector3 = inner_bottom_diagonal + diagonal_offset_bottom
		var flat_offset_bottom: Vector3 = horizontal_dir * (0.047 + inset_factor)
		var inner_bottom_inner: Vector3 = inner_bottom_diagonal_offset + flat_offset_bottom

		var top_flat_normal: Vector3 = Vector3(normal.x * 0.8, -0.8, normal.z * 0.8).normalized()
		var bottom_flat_normal: Vector3 = Vector3(normal.x * 0.8, 0.8, normal.z * 0.8).normalized()
		var top_diag_normal: Vector3 = Vector3(normal.x * 0.8, -0.8, normal.z * 0.8).normalized()
		var bottom_diag_normal: Vector3 = Vector3(normal.x * 0.8, 0.8, normal.z * 0.8).normalized()

		# Store vertices with calculated normals
		middle_vertices.append([inner_top_flat, inner_bottom_inner, normal, Vector2(vertex_data.t, 0), Vector2(vertex_data.t, 1.0)])
		top_metal_lip_vertices.append([inner_top_belt_lip, inner_top_metal_lip, normal, Vector2(vertex_data.t, 0.8), Vector2(vertex_data.t, 1.0)])
		bottom_metal_lip_vertices.append([inner_bottom_metal_lip, inner_bottom_belt_lip, normal, Vector2(vertex_data.t, 0.0), Vector2(vertex_data.t, 0.2)])
		top_metal_to_flat_vertices.append([inner_top_metal_lip, inner_top_diagonal_offset, top_diag_normal, Vector2(vertex_data.t, 0.6), Vector2(vertex_data.t, 0.8)])
		bottom_flat_to_metal_vertices.append([inner_bottom_diagonal_offset, inner_bottom_metal_lip, bottom_diag_normal, Vector2(vertex_data.t, 0.2), Vector2(vertex_data.t, 0.4)])
		top_flat_vertices.append([inner_top_diagonal_offset, inner_top_flat, top_flat_normal, Vector2(vertex_data.t, 0.35), Vector2(vertex_data.t, 0.4)])
		bottom_flat_vertices.append([inner_bottom_inner, inner_bottom_diagonal_offset, bottom_flat_normal, Vector2(vertex_data.t, 0.6), Vector2(vertex_data.t, 0.65)])
		
		var scale_factor = 0.5

		edges.top_inner.vertices.append_array([inner_top, inner_top_belt_lip])
		edges.top_inner.normals.append_array([normal, normal])
		edges.top_inner.uvs.append_array([Vector2(0, 1 - vertex_data.t * scale_factor), Vector2(0.05, 1 - vertex_data.t * scale_factor)])
		edges.bottom_inner.vertices.append_array([inner_bottom_belt_lip, inner_bottom])
		edges.bottom_inner.normals.append_array([normal, normal])
		edges.bottom_inner.uvs.append_array([Vector2(0.95, vertex_data.t * scale_factor), Vector2(1, vertex_data.t * scale_factor)])
		
	_build_inner_wall_sections(surfaces, middle_vertices, top_metal_lip_vertices, bottom_metal_lip_vertices, 
							top_metal_to_flat_vertices, bottom_flat_to_metal_vertices, top_flat_vertices, 
							bottom_flat_vertices, segments)

func _build_inner_wall_sections(surfaces: Dictionary, middle_vertices: Array, top_metal_lip_vertices: Array,
							  bottom_metal_lip_vertices: Array, top_metal_to_flat_vertices: Array,
							  bottom_flat_to_metal_vertices: Array, top_flat_vertices: Array,
							  bottom_flat_vertices: Array, segments: int) -> void:
	# Prepare sides surface
	surfaces.sides.vertices.clear()
	surfaces.sides.normals.clear()
	surfaces.sides.uvs.clear()
	surfaces.sides.indices.clear()

	# 1. Build middle section
	for data in middle_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx = i * 2
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	# 2. Add top metal lip section
	var top_lip_start_idx = surfaces.sides.vertices.size()
	for data in top_metal_lip_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx = top_lip_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	# 3. Add bottom metal lip section
	var bottom_lip_start_idx = surfaces.sides.vertices.size()
	for data in bottom_metal_lip_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx = bottom_lip_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	# 4. Add top transition from metal lip to diagonal
	var top_metal_to_flat_start_idx = surfaces.sides.vertices.size()
	for data in top_metal_to_flat_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx = top_metal_to_flat_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	# 5. Add top flat sections
	var top_flat_start_idx = surfaces.sides.vertices.size()
	for data in top_flat_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx = top_flat_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	# 6. Add bottom flat sections
	var bottom_flat_start_idx = surfaces.sides.vertices.size()
	for data in bottom_flat_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx = bottom_flat_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	# 7. Add bottom transition from diagonal to metal lip
	var bottom_flat_to_metal_start_idx = surfaces.sides.vertices.size()
	for data in bottom_flat_to_metal_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx = bottom_flat_to_metal_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	surfaces.sides.vertex_count = surfaces.sides.vertices.size()

func _add_double_sided_triangle(array_indices: PackedInt32Array, a: int, b: int, c: int) -> void:
	array_indices.append_array([a, b, c, c, b, a])

func _add_surfaces_to_mesh(surfaces: Dictionary, mesh_instance: ArrayMesh) -> void:
	for pair in [["top", 0], ["bottom", 1], ["sides", 2]]:
		var surface_name: String = pair[0]
		var surface_index: int = pair[1]
		var surface: Dictionary = surfaces[surface_name]

		# Skip empty surfaces
		if surface.vertices.size() == 0:
			continue

		var arrays: Array = []
		arrays.resize(Mesh.ARRAY_MAX)
		arrays[Mesh.ARRAY_VERTEX] = surface.vertices
		arrays[Mesh.ARRAY_NORMAL] = surface.normals
		arrays[Mesh.ARRAY_TEX_UV] = surface.uvs
		arrays[Mesh.ARRAY_INDEX] = surface.indices
		mesh_instance.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)

		# Apply appropriate material based on surface
		var material_to_use = _belt_material
		if surface_name == "sides":
			material_to_use = _metal_material
		mesh_instance.surface_set_material(surface_index, material_to_use)

func _setup_collision_shape() -> void:
	# Create collision shape
	var collision_shape: CollisionShape3D = $StaticBody3D.get_node_or_null("CollisionShape3D") as CollisionShape3D
	assert(collision_shape != null, "CollisionShape3D node is missing!")

	# Combine all surfaces for collision
	var all_verts: PackedVector3Array = PackedVector3Array()
	var all_indices: PackedInt32Array = PackedInt32Array()

	var mesh_instance = curved_mesh.mesh
	for surface_idx in range(mesh_instance.get_surface_count()):
		var surface = mesh_instance.surface_get_arrays(surface_idx)
		var base_index = all_verts.size()
		all_verts.append_array(surface[Mesh.ARRAY_VERTEX])
		
		for i in surface[Mesh.ARRAY_INDEX]:
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

	var scaled_verts = PackedVector3Array()
	for vert in triangle_verts:
		scaled_verts.append(Vector3(vert.x * 0.5, vert.y * 1.0, vert.z * 0.5))

	var shape: ConcavePolygonShape3D = ConcavePolygonShape3D.new()
	shape.data = scaled_verts
	collision_shape.shape = shape
	collision_shape.scale = Vector3.ONE

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
		# Ensure uniform scale on X and Z axes
		if scale != Vector3(scale.x, 1, scale.x):
			scale = Vector3(scale.x, 1, scale.x)
		set_notify_local_transform(true)

func _recalculate_speeds() -> void:
	var reference_radius: float = size.x * BASE_OUTER_RADIUS - reference_distance
	_angular_speed = 0.0 if reference_radius == 0.0 else speed / reference_radius
	_linear_speed = _angular_speed * (size.x * (BASE_OUTER_RADIUS + BASE_INNER_RADIUS) / 2.0)
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
			belt_position += _linear_speed * delta
		if _linear_speed != 0:
			# Set the belt position for animation
			(_belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", belt_position * sign(_linear_speed))
		if belt_position >= 1.0:
			belt_position = 0.0

func _update_belt_material_scale() -> void:
	if _belt_material:
			(_belt_material as ShaderMaterial).set_shader_parameter("Scale", size.x  * sign(speed))

func _update_metal_material_scale() -> void:
	if _metal_material:
		(_metal_material as ShaderMaterial).set_shader_parameter("Scale", size.x)
		(_metal_material as ShaderMaterial).set_shader_parameter("Scale2", 1.0)

func _on_simulation_started() -> void:
	if enable_comms:
		_register_speed_tag_ok = OIPComms.register_tag(speed_tag_group_name, speed_tag_name, 1)
		_register_running_tag_ok = OIPComms.register_tag(running_tag_group_name, running_tag_name, 1)

func _on_simulation_ended() -> void:
	belt_position = 0.0
	if _belt_material and _belt_material is ShaderMaterial:
		(_belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", belt_position)
	
	if _sb:
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

func _on_size_changed() -> void:
	if not is_inside_tree():
		return
		
	_recalculate_speeds()
	size.z = size.x
	var ce1 = get_conveyor_end1()
	var ce2 = get_conveyor_end2()
	if ce1:
		ce1.size = Vector3(size.y, size.y, size.x)
	if ce2:
		ce2.size = Vector3(size.y, size.y, size.x)
	
	update_visible_meshes()
	_update_belt_material_scale()
	_update_metal_material_scale()

func _build_belt_edges(edges: Dictionary, segments: int) -> void:
	for edge_name in edges.keys():

		# Then create triangles
		for i in range(segments):
			var idx = i * 2
			if idx + 3 < edges[edge_name].vertices.size():
				_add_double_sided_triangle(edges[edge_name].indices, idx, idx + 1, idx + 3)
				_add_double_sided_triangle(edges[edge_name].indices, idx, idx + 3, idx + 2)

func _add_belt_edges_to_surfaces(surfaces: Dictionary, edges: Dictionary) -> void:
	# Add all belt edges to the appropriate surfaces
	for edge_name in edges.keys():
		var edge = edges[edge_name]
		if edge.vertices.size() == 0:
			continue
			
		var target_surface = surfaces.top if edge_name.begins_with("top") else surfaces.bottom
		var start_idx = target_surface.vertices.size()
		
		target_surface.vertices.append_array(edge.vertices)
		target_surface.normals.append_array(edge.normals)
		target_surface.uvs.append_array(edge.uvs)
		
		for i in range(0, edge.indices.size(), 3):
			if i + 2 < edge.indices.size():
				target_surface.indices.append_array([
					start_idx + edge.indices[i],
					start_idx + edge.indices[i + 1],
					start_idx + edge.indices[i + 2]
				])

	surfaces.sides.vertex_count = surfaces.sides.vertices.size()

func _create_outer_walls(surfaces: Dictionary, edges: Dictionary, all_vertices: Array, segments: int) -> void:
	var inset_factor: float = 0.04 * (size.x / SIZE_DEFAULT.x - 1)
	inset_factor = max(inset_factor, 0.0)
	
	var outer_middle_vertices = []
	var outer_top_metal_lip_vertices = []
	var outer_bottom_metal_lip_vertices = []
	var outer_top_metal_to_flat_vertices = []
	var outer_bottom_flat_to_metal_vertices = [] 
	var outer_top_flat_vertices = []
	var outer_bottom_flat_vertices = []
	
	for i in range(len(all_vertices)):
		var vertex_data = all_vertices[i]
		var normal: Vector3 = (vertex_data.outer_top - Vector3(0, 0, 0)).normalized()
		normal.y = 0
		normal = normal.normalized()

		var top_y: float = vertex_data.outer_top.y
		var bottom_y: float = vertex_data.outer_bottom.y
		var lip_height: float = (top_y - bottom_y) * 0.16
		var half_lip_height: float = lip_height / 2
		var horizontal_dir: Vector3 = (vertex_data.inner_top - vertex_data.outer_top).normalized()

		# Top vertices
		var outer_top: Vector3 = vertex_data.outer_top
		var outer_top_belt_lip: Vector3 = Vector3(vertex_data.outer_top.x, top_y - half_lip_height, vertex_data.outer_top.z)
		var outer_top_metal_lip: Vector3 = Vector3(vertex_data.outer_top.x, top_y - lip_height, vertex_data.outer_top.z)

		# Diagonal and flat sections
		var diagonal_height_top_total: float = (top_y - bottom_y) * 0.04
		var outer_top_diagonal: Vector3 = Vector3(vertex_data.outer_top.x, top_y - lip_height - diagonal_height_top_total, vertex_data.outer_top.z)
		var diagonal_offset: Vector3 = horizontal_dir * (0.03 + inset_factor)
		var outer_top_diagonal_offset: Vector3 = outer_top_diagonal + diagonal_offset
		var flat_offset: Vector3 = horizontal_dir * (0.047 + inset_factor)
		var outer_top_flat: Vector3 = outer_top_diagonal_offset + flat_offset

		# Bottom vertices
		var outer_bottom: Vector3 = vertex_data.outer_bottom
		var outer_bottom_belt_lip: Vector3 = Vector3(vertex_data.outer_bottom.x, bottom_y + half_lip_height, vertex_data.outer_bottom.z)
		var outer_bottom_metal_lip: Vector3 = Vector3(vertex_data.outer_bottom.x, bottom_y + lip_height, vertex_data.outer_bottom.z)

		var diagonal_height_bottom_total: float = (top_y - bottom_y) * 0.04
		var outer_bottom_diagonal: Vector3 = Vector3(vertex_data.outer_bottom.x, bottom_y + lip_height + diagonal_height_bottom_total, vertex_data.outer_bottom.z)
		var diagonal_offset_bottom: Vector3 = horizontal_dir * (0.03 + inset_factor)
		var outer_bottom_diagonal_offset: Vector3 = outer_bottom_diagonal + diagonal_offset_bottom
		var flat_offset_bottom: Vector3 = horizontal_dir * (0.047 + inset_factor)
		var outer_bottom_flat: Vector3 = outer_bottom_diagonal_offset + flat_offset_bottom
		var outer_bottom_inner: Vector3 = outer_bottom_flat

		var top_flat_normal: Vector3 = Vector3(normal.x * 0.8, -0.6, normal.z * 0.8).normalized()
		var bottom_flat_normal: Vector3 = Vector3(normal.x * 0.8, 0.6, normal.z * 0.8).normalized()
		var top_diag_normal: Vector3 = Vector3(normal.x * 0.8, -0.6, normal.z * 0.8).normalized()
		var bottom_diag_normal: Vector3 = Vector3(normal.x * 0.8, 0.6, normal.z * 0.8).normalized()

		# Store vertices for each section with updated normals
		outer_middle_vertices.append([outer_top_flat, outer_bottom_inner, normal, Vector2(vertex_data.t * size.x, 0), Vector2(vertex_data.t * size.x, 1)])
		outer_top_metal_lip_vertices.append([outer_top_belt_lip, outer_top_metal_lip, normal, Vector2(vertex_data.t * size.x, 0.8), Vector2(vertex_data.t * size.x, 1.0)])
		outer_bottom_metal_lip_vertices.append([outer_bottom_metal_lip, outer_bottom_belt_lip, normal, Vector2(vertex_data.t * size.x, 0.0), Vector2(vertex_data.t * size.x, 0.2)])
		outer_top_metal_to_flat_vertices.append([outer_top_metal_lip, outer_top_diagonal_offset, top_diag_normal, Vector2(vertex_data.t * size.x, 0.6), Vector2(vertex_data.t * size.x, 0.8)])
		outer_bottom_flat_to_metal_vertices.append([outer_bottom_diagonal_offset, outer_bottom_metal_lip, bottom_diag_normal, Vector2(vertex_data.t * size.x, 0.2), Vector2(vertex_data.t * size.x, 0.4)])
		outer_top_flat_vertices.append([outer_top_diagonal_offset, outer_top_flat, top_flat_normal, Vector2(vertex_data.t, 0.35), Vector2(vertex_data.t, 0.4)])
		outer_bottom_flat_vertices.append([outer_bottom_inner, outer_bottom_diagonal_offset, bottom_flat_normal, Vector2(vertex_data.t, 0.6), Vector2(vertex_data.t, 0.65)])
		
		var scale_factor = 0.5
		# Belt edges
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

func _build_outer_wall_sections(surfaces: Dictionary, outer_middle_vertices: Array, outer_top_metal_lip_vertices: Array,
							   outer_bottom_metal_lip_vertices: Array, outer_top_metal_to_flat_vertices: Array,
							   outer_bottom_flat_to_metal_vertices: Array, outer_top_flat_vertices: Array,
							   outer_bottom_flat_vertices: Array, segments: int) -> void:
	# 1. Outer middle section
	var outer_middle_start_idx = surfaces.sides.vertices.size()
	for data in outer_middle_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx = outer_middle_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	# 2. Outer top metal lip section
	var outer_top_lip_start_idx = surfaces.sides.vertices.size()
	for data in outer_top_metal_lip_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx = outer_top_lip_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	# 3. Outer bottom metal lip section
	var outer_bottom_lip_start_idx = surfaces.sides.vertices.size()
	for data in outer_bottom_metal_lip_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]]) 
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx = outer_bottom_lip_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	# 4. Add outer top transition from metal lip to diagonal
	var outer_top_metal_to_flat_start_idx = surfaces.sides.vertices.size()
	for data in outer_top_metal_to_flat_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx = outer_top_metal_to_flat_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	# 5. Outer top flat sections
	var outer_top_flat_start_idx = surfaces.sides.vertices.size()
	for data in outer_top_flat_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx = outer_top_flat_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	# 6. Outer bottom flat sections
	var outer_bottom_flat_start_idx = surfaces.sides.vertices.size()
	for data in outer_bottom_flat_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx = outer_bottom_flat_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	# 7. Add outer bottom transition from diagonal to metal lip
	var outer_bottom_flat_to_metal_start_idx = surfaces.sides.vertices.size()
	for data in outer_bottom_flat_to_metal_vertices:
		surfaces.sides.vertices.append_array([data[0], data[1]])
		surfaces.sides.normals.append_array([data[2], data[2]])
		surfaces.sides.uvs.append_array([data[3], data[4]])

	for i in range(segments):
		var idx = outer_bottom_flat_to_metal_start_idx + (i * 2)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 2, idx + 3)
		_add_double_sided_triangle(surfaces.sides.indices, idx, idx + 3, idx + 1)

	surfaces.sides.vertex_count = surfaces.sides.vertices.size()
