@tool
class_name CurvedSideGuards
extends Node3D

# Base dimensions
const BASE_INNER_RADIUS: float = 0.25
const BASE_OUTER_RADIUS: float = 1.25
const BASE_HEIGHT: float = 0.149
const MIDDLE_THICKNESS: float = 0.02

@export_range(10.0, 90.0, 1.0, 'degrees') var guard_angle: float = 90.0:
	set(value):
		if abs(guard_angle - value) < 0.001:
			return  # No significant change
		guard_angle = value
		_update_mesh()

@export var size: Vector3 = Vector3(1.56, 4.0, 1.0):
	set(value):
		if size.is_equal_approx(value):
			return  # No significant change
		size = value
		_update_mesh()

var shader_material: ShaderMaterial = null
var inner_shader_material: ShaderMaterial = null
var _prev_scale_x: float = 1.0
var outer_mesh: MeshInstance3D = null
var inner_mesh: MeshInstance3D = null

var _current_inner_radius: float = 0.25
var _current_conveyor_width: float = 1.0

func _init() -> void:
	set_notify_local_transform(true)

func _ready() -> void:
	if _current_inner_radius == 0.25 and _current_conveyor_width == 1.0:
		var diameter = size.x - 0.036
		var outer_radius = diameter / 2.0
		_current_conveyor_width = 1.0  # Use default conveyor width
		_current_inner_radius = outer_radius - _current_conveyor_width
	
	outer_mesh = find_child('OuterSideGuard') as MeshInstance3D
	if not outer_mesh:
		outer_mesh = MeshInstance3D.new()
		outer_mesh.name = 'OuterSideGuard'
		add_child(outer_mesh)
		outer_mesh.owner = get_tree().edited_scene_root if Engine.is_editor_hint() else self
	
	inner_mesh = find_child('InnerSideGuard') as MeshInstance3D
	if not inner_mesh:
		inner_mesh = MeshInstance3D.new()
		inner_mesh.name = 'InnerSideGuard'
		add_child(inner_mesh)
		inner_mesh.owner = get_tree().edited_scene_root if Engine.is_editor_hint() else self
	
	_setup_materials()
	_ensure_unique_collision_shapes()
	_ensure_unique_mesh_resources()
	
	_prev_scale_x = size.x
	
	_update_mesh()

func _setup_materials() -> void:
	shader_material = ShaderMaterial.new()
	shader_material.shader = load('res://assets/3DModels/Shaders/SideGuardShaderCBC.tres') as Shader
	shader_material.set_shader_parameter('Color', Color('#56a7c8'))
	
	inner_shader_material = ShaderMaterial.new()
	inner_shader_material.shader = load('res://assets/3DModels/Shaders/SideGuardShaderCBC.tres') as Shader
	inner_shader_material.set_shader_parameter('Color', Color('#56a7c8'))
	
	_update_material_scale()

func _ensure_unique_collision_shapes() -> void:
	if outer_mesh:
		var static_body = outer_mesh.get_node_or_null("StaticBody3D") as StaticBody3D
		if static_body:
			var collision_shape = static_body.get_node_or_null("CollisionShape3D") as CollisionShape3D
			if collision_shape and collision_shape.shape:
				collision_shape.shape = collision_shape.shape.duplicate()
	
	if inner_mesh:
		var static_body = inner_mesh.get_node_or_null("StaticBody3D") as StaticBody3D
		if static_body:
			var collision_shape = static_body.get_node_or_null("CollisionShape3D") as CollisionShape3D
			if collision_shape and collision_shape.shape:
				collision_shape.shape = collision_shape.shape.duplicate()

func _ensure_unique_mesh_resources() -> void:
	if outer_mesh and outer_mesh.mesh:
		outer_mesh.mesh = outer_mesh.mesh.duplicate()
	if inner_mesh and inner_mesh.mesh:
		inner_mesh.mesh = inner_mesh.mesh.duplicate()

func _update_mesh() -> void:
	if not is_inside_tree() or not outer_mesh or not inner_mesh:
		return
	_create_outer_guard_mesh()
	_create_inner_guard_mesh()
	
	_update_material_scale()
	_setup_collision_shape(outer_mesh, false)
	_setup_collision_shape(inner_mesh, true)
	_update_guard_end_pieces()
	
func _update_guard_end_pieces() -> void:
	var outer_radius = _current_inner_radius + _current_conveyor_width
	var avg_radius = (_current_inner_radius + outer_radius) / 2.0
	
	var base_offset = -0.99
	var width_response = (_current_conveyor_width) * 0.493
	
	# Get parent to check if it's a roller conveyor
	var parent = get_parent()
	var is_roller = "CONVEYOR_CLASS_NAME" in parent and parent.CONVEYOR_CLASS_NAME == "CurvedRollerConveyor"
	
	var end1_x: float = 0.25
	var end1_z: float = avg_radius + base_offset + width_response
	if is_roller:
		end1_x -= 0.12  
	var end1_scale_x: float
	if is_roller:
		end1_scale_x = 0.6 + (_current_conveyor_width - 1.0) * 0.01
	else:
		end1_scale_x = 1.07 + (_current_conveyor_width - 1.0) * 0.01

	var inner_end1_x: float = 0.25
	var inner_end1_z: float = _current_inner_radius + 0.01 - base_offset
	if is_roller:
		inner_end1_x -= 0.12
	var inner_end1_scale_x: float
	if is_roller:
		inner_end1_scale_x = 0.6 + (_current_conveyor_width - 1.0) * 0.01
	else:
		inner_end1_scale_x = 1.07 + (_current_conveyor_width - 1.0) * 0.01

	var outer_end1 = get_node_or_null("OuterSideGuardEnd")
	var inner_end1 = get_node_or_null("InnerSideGuardEnd")
	
	if outer_end1:
		outer_end1.scale = Vector3(end1_scale_x, size.y / 4.0, 1.0)
		outer_end1.position = Vector3(end1_x, -0.004, end1_z)
	
	if inner_end1:
		inner_end1.scale = Vector3(inner_end1_scale_x, size.y / 4.0, 1.0)
		inner_end1.position = Vector3(inner_end1_x, -0.004, inner_end1_z)

	var radians = deg_to_rad(guard_angle)
	
	var end2_x: float = -sin(radians) * (avg_radius + base_offset + width_response)
	var end2_z: float = cos(radians) * (avg_radius + base_offset + width_response)
	
	var curve_offset = -0.25
	var outward_offset_x = cos(radians) * curve_offset
	var outward_offset_z = sin(radians) * curve_offset
	
	end2_x += outward_offset_x
	end2_z += outward_offset_z
	if is_roller:
		end2_z += 0.12
	var end2_scale_x: float
	if is_roller:
		end2_scale_x = 0.6 + (_current_conveyor_width - 1.0) * 0.01
	else:
		end2_scale_x = 1.07 + (_current_conveyor_width - 1.0) * 0.01

	var inner_end2_x: float = -sin(radians) * (_current_inner_radius + 0.01 - base_offset)
	var inner_end2_z: float = cos(radians) * (_current_inner_radius + 0.01 - base_offset)
	
	inner_end2_x += outward_offset_x
	inner_end2_z += outward_offset_z
	if is_roller:
		inner_end2_z += 0.12
	var inner_end2_scale_x: float
	if is_roller:
		inner_end2_scale_x = 0.6 + (_current_conveyor_width - 1.0) * 0.01
	else:
		inner_end2_scale_x = 1.07 + (_current_conveyor_width - 1.0) * 0.01

	var outer_end2 = get_node_or_null("OuterSideGuardEnd2")
	var inner_end2 = get_node_or_null("InnerSideGuardEnd2")
	
	if outer_end2:
		outer_end2.rotation.y = -radians + deg_to_rad(180.0)
		outer_end2.scale = Vector3(end2_scale_x, size.y / 4.0, 1.0)
		outer_end2.position = Vector3(end2_x, -0.004, end2_z)
	
	if inner_end2:
		inner_end2.rotation.y = -radians
		inner_end2.scale = Vector3(inner_end2_scale_x, size.y / 4.0, 1.0)
		inner_end2.position = Vector3(inner_end2_x, -0.004, inner_end2_z)
	
func _create_outer_guard_mesh() -> void:
	var mesh := ArrayMesh.new()
	

	var radius_outer: float = _current_inner_radius + _current_conveyor_width + 0.08
	var height: float = BASE_HEIGHT * size.y
	var thickness: float = MIDDLE_THICKNESS
	
	# Lip dimensions
	var lip_height: float = 0.005 * size.y
	var lip_outward: float = 0.05
	var lip_inward: float = 0.05
	
	var segments: int = int(guard_angle / 9.0)
	var angle_radians: float = deg_to_rad(guard_angle)
	
	var vertices := PackedVector3Array()
	var normals := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()
	
	var current_index: int = 0
	
	# Calculate UV scaling
	var arc_length: float = radius_outer * angle_radians
	var uv_scale_length: float = arc_length / 2.0
	
	# Generate vertices and normals
	for i in range(segments + 1):
		var t: float = float(i) / segments
		var angle: float = t * angle_radians
		var sin_a: float = sin(angle)
		var cos_a: float = cos(angle)
		
		# Outer wall vertices
		var outer_top := Vector3(-sin_a * radius_outer, height, cos_a * radius_outer)
		var outer_bottom := Vector3(-sin_a * radius_outer, 0, cos_a * radius_outer)
		
		# Middle section vertices
		var middle_top := Vector3(
			-sin_a * (radius_outer - thickness),
			height,
			cos_a * (radius_outer - thickness)
		)
		var middle_bottom := Vector3(
			-sin_a * (radius_outer - thickness),
			0,
			cos_a * (radius_outer - thickness)
		)
		
		# Top lip vertices (forms the "r" shape)
		var top_lip_top := Vector3(
			-sin_a * (radius_outer + lip_outward),
			height,
			cos_a * (radius_outer + lip_outward)
		)
		var top_lip_middle_outer := Vector3(
			-sin_a * (radius_outer + lip_outward),
			height - lip_height,
			cos_a * (radius_outer + lip_outward)
		)
		var top_lip_middle_inner := Vector3(
			-sin_a * radius_outer,
			height - lip_height,
			cos_a * radius_outer
		)
		
		# Bottom lip vertices (forms the "Z" shape)
		var bottom_lip_bottom := Vector3(
			-sin_a * (radius_outer - thickness - lip_inward - 0.02),
			0,
			cos_a * (radius_outer - thickness - lip_inward - 0.02)
		)
		var bottom_lip_middle_inner := Vector3(
			-sin_a * (radius_outer - thickness - lip_inward - 0.02),
			lip_height,
			cos_a * (radius_outer - thickness - lip_inward - 0.02)
		)
		var bottom_lip_middle_outer := Vector3(
			-sin_a * (radius_outer - thickness),
			lip_height,
			cos_a * (radius_outer - thickness)
		)
		
		# Calculate normals
		var center := Vector3.ZERO
		var outer_normal := (outer_top - center).normalized()
		outer_normal.y = 0
		outer_normal = outer_normal.normalized()
		
		var inner_normal := (center - middle_top).normalized()
		inner_normal.y = 0
		inner_normal = inner_normal.normalized()
		
		var uv_arc_pos: float = t * uv_scale_length
		
		# Outer wall
		vertices.append_array([outer_top, outer_bottom])
		normals.append_array([outer_normal, outer_normal])
		uvs.append_array([Vector2(uv_arc_pos, 0.6), Vector2(uv_arc_pos, 0.8)])
		
		# Inner wall
		vertices.append_array([middle_top, middle_bottom])
		normals.append_array([inner_normal, inner_normal])
		uvs.append_array([Vector2(uv_arc_pos, 0.2), Vector2(uv_arc_pos, 0.4)])
		
		# Top surface
		vertices.append_array([outer_top, middle_top])
		normals.append_array([Vector3.UP, Vector3.UP])
		uvs.append_array([Vector2(0.8, uv_arc_pos), Vector2(1.0, uv_arc_pos)])
		
		# Bottom surface
		vertices.append_array([outer_bottom, middle_bottom])
		normals.append_array([Vector3.DOWN, Vector3.DOWN])
		uvs.append_array([Vector2(0.0, uv_arc_pos), Vector2(0.2, uv_arc_pos)])
		
		# Top lip: outer vertical face
		vertices.append_array([top_lip_top, top_lip_middle_outer])
		normals.append_array([outer_normal, outer_normal])
		uvs.append_array([Vector2(uv_arc_pos, 0.8), Vector2(uv_arc_pos, 1.0)])
		
		# Top lip: bottom flat face
		vertices.append_array([top_lip_middle_outer, top_lip_middle_inner])
		normals.append_array([Vector3.DOWN, Vector3.DOWN])
		uvs.append_array([Vector2(0.4, uv_arc_pos), Vector2(0.6, uv_arc_pos)])
		
		# Top lip: inner vertical face
		var combined_normal := (Vector3.UP * 0.2 + inner_normal * 0.8).normalized()
		vertices.append_array([outer_top, top_lip_top])
		normals.append_array([Vector3.UP, Vector3.UP])
		uvs.append_array([Vector2(uv_arc_pos, 0.4), Vector2(uv_arc_pos, 0.6)])
		
		# Bottom lip: outer vertical face
		vertices.append_array([bottom_lip_middle_outer, bottom_lip_middle_inner])
		normals.append_array([inner_normal, inner_normal])
		uvs.append_array([Vector2(uv_arc_pos, 0.0), Vector2(uv_arc_pos, 0.2)])
		
		# Bottom lip: top flat face
		vertices.append_array([bottom_lip_middle_inner, bottom_lip_bottom])
		normals.append_array([Vector3.DOWN, Vector3.DOWN])
		uvs.append_array([Vector2(0.2, uv_arc_pos), Vector2(0.4, uv_arc_pos)])
		
		# Bottom lip: inner vertical face
		vertices.append_array([bottom_lip_bottom, middle_bottom])
		normals.append_array([Vector3.DOWN, Vector3.DOWN])
		uvs.append_array([Vector2(uv_arc_pos + 0.1, 0.0), Vector2(uv_arc_pos + 0.1, 0.2)])
	
	# Generate indices
	for i in range(segments):
		var outer_base: int = i * 20
		indices.append_array([
			outer_base, outer_base + 1, outer_base + 21,
			outer_base, outer_base + 21, outer_base + 20,
			outer_base + 1, outer_base, outer_base + 21,
			outer_base + 21, outer_base, outer_base + 20
		])
		
		var inner_base: int = i * 20 + 2
		indices.append_array([
			inner_base, inner_base + 21, inner_base + 1,
			inner_base, inner_base + 20, inner_base + 21,
			inner_base + 21, inner_base, inner_base + 1,
			inner_base + 20, inner_base, inner_base + 21
		])
		
		var top_base: int = i * 20 + 4
		indices.append_array([
			top_base, top_base + 20, top_base + 21,
			top_base, top_base + 21, top_base + 1,
			top_base + 20, top_base, top_base + 21,
			top_base + 21, top_base, top_base + 1
		])
		
		var bottom_base: int = i * 20 + 6
		indices.append_array([
			bottom_base, bottom_base + 21, bottom_base + 20,
			bottom_base, bottom_base + 1, bottom_base + 21,
			bottom_base + 21, bottom_base, bottom_base + 20,
			bottom_base + 1, bottom_base, bottom_base + 21
		])
		
		var top_lip_outer_base: int = i * 20 + 8
		indices.append_array([
			top_lip_outer_base, top_lip_outer_base + 1, top_lip_outer_base + 21,
			top_lip_outer_base, top_lip_outer_base + 21, top_lip_outer_base + 20,
			top_lip_outer_base + 1, top_lip_outer_base, top_lip_outer_base + 21,
			top_lip_outer_base + 21, top_lip_outer_base, top_lip_outer_base + 20
		])
		
		var top_lip_bottom_base: int = i * 20 + 10
		indices.append_array([
			top_lip_bottom_base, top_lip_bottom_base + 21, top_lip_bottom_base + 20,
			top_lip_bottom_base, top_lip_bottom_base + 1, top_lip_bottom_base + 21,
			top_lip_bottom_base + 21, top_lip_bottom_base, top_lip_bottom_base + 20,
			top_lip_bottom_base + 1, top_lip_bottom_base, top_lip_bottom_base + 21
		])
		
		var top_lip_inner_base: int = i * 20 + 12
		indices.append_array([
			top_lip_inner_base, top_lip_inner_base + 1, top_lip_inner_base + 21,
			top_lip_inner_base, top_lip_inner_base + 21, top_lip_inner_base + 20,
			top_lip_inner_base + 1, top_lip_inner_base, top_lip_inner_base + 21,
			top_lip_inner_base + 21, top_lip_inner_base, top_lip_inner_base + 20
		])
		
		var bottom_lip_outer_base: int = i * 20 + 14
		indices.append_array([
			bottom_lip_outer_base, bottom_lip_outer_base + 21, bottom_lip_outer_base + 1,
			bottom_lip_outer_base, bottom_lip_outer_base + 20, bottom_lip_outer_base + 21,
			bottom_lip_outer_base + 21, bottom_lip_outer_base, bottom_lip_outer_base + 1,
			bottom_lip_outer_base + 20, bottom_lip_outer_base, bottom_lip_outer_base + 21
		])
		
		var bottom_lip_top_base: int = i * 20 + 16
		indices.append_array([
			bottom_lip_top_base, bottom_lip_top_base + 20, bottom_lip_top_base + 21,
			bottom_lip_top_base, bottom_lip_top_base + 21, bottom_lip_top_base + 1,
			bottom_lip_top_base + 20, bottom_lip_top_base, bottom_lip_top_base + 21,
			bottom_lip_top_base + 21, bottom_lip_top_base, bottom_lip_top_base + 1
		])
		
		var bottom_lip_inner_base: int = i * 20 + 18
		indices.append_array([
			bottom_lip_inner_base, bottom_lip_inner_base + 1, bottom_lip_inner_base + 21,
			bottom_lip_inner_base, bottom_lip_inner_base + 21, bottom_lip_inner_base + 20,
			bottom_lip_inner_base + 1, bottom_lip_inner_base, bottom_lip_inner_base + 21,
			bottom_lip_inner_base + 21, bottom_lip_inner_base, bottom_lip_inner_base + 20
		])
	
	# Add end caps for main body
	if segments > 0:
		vertices.append_array([vertices[0], vertices[2], vertices[1], vertices[3]])
		var left_normal := Vector3(-1, 0, 0)
		normals.append_array([left_normal, left_normal, left_normal, left_normal])
		uvs.append_array([
			Vector2(0.8, 0.2), Vector2(1.0, 0.2),
			Vector2(0.8, 0.4), Vector2(1.0, 0.4)
		])
		
		var left_base: int = vertices.size() - 4
		indices.append_array([
			left_base, left_base + 1, left_base + 3,
			left_base, left_base + 3, left_base + 2,
			left_base + 1, left_base, left_base + 3,
			left_base + 3, left_base, left_base + 2
		])
		
		var last: int = segments * 20
		vertices.append_array([vertices[last], vertices[last + 2], vertices[last + 1], vertices[last + 3]])
		var right_normal := Vector3(1, 0, 0)
		normals.append_array([right_normal, right_normal, right_normal, right_normal])
		uvs.append_array([
			Vector2(0.8, 0.6), Vector2(1.0, 0.6),
			Vector2(0.8, 0.8), Vector2(1.0, 0.8)
		])
		
		var right_base: int = vertices.size() - 4
		indices.append_array([
			right_base, right_base + 3, right_base + 1,
			right_base, right_base + 2, right_base + 3,
			right_base + 3, right_base, right_base + 1,
			right_base + 2, right_base, right_base + 3
		])
	
	# Add end caps for top lip
	if segments > 0:
		vertices.append_array([vertices[8], vertices[9], vertices[11], vertices[0]])
		var left_normal := Vector3(-1, 0, 0)
		normals.append_array([left_normal, left_normal, left_normal, left_normal])
		uvs.append_array([
			Vector2(0.0, 0.8), Vector2(0.0, 1.0),
			Vector2(0.2, 1.0), Vector2(0.2, 0.8)
		])
		
		var lip_left_base: int = vertices.size() - 4
		indices.append_array([
			lip_left_base, lip_left_base + 1, lip_left_base + 2,
			lip_left_base, lip_left_base + 2, lip_left_base + 3,
			lip_left_base + 1, lip_left_base, lip_left_base + 2,
			lip_left_base + 2, lip_left_base, lip_left_base + 3
		])
		
		var last_lip: int = segments * 20
		vertices.append_array([vertices[last_lip + 8], vertices[last_lip + 9], vertices[last_lip + 11], vertices[last_lip]])
		var right_normal := Vector3(1, 0, 0)
		normals.append_array([right_normal, right_normal, right_normal, right_normal])
		uvs.append_array([
			Vector2(0.4, 0.8), Vector2(0.4, 1.0),
			Vector2(0.6, 1.0), Vector2(0.6, 0.8)
		])
		
		var lip_right_base: int = vertices.size() - 4
		indices.append_array([
			lip_right_base, lip_right_base + 2, lip_right_base + 1,
			lip_right_base, lip_right_base + 3, lip_right_base + 2,
			lip_right_base + 2, lip_right_base, lip_right_base + 1,
			lip_right_base + 3, lip_right_base, lip_right_base + 2
		])
		
		# Add end caps for bottom lip
		vertices.append_array([vertices[14], vertices[15], vertices[17], vertices[3]])
		normals.append_array([left_normal, left_normal, left_normal, left_normal])
		uvs.append_array([
			Vector2(0.0, 0.0), Vector2(0.0, 0.2),
			Vector2(0.2, 0.2), Vector2(0.2, 0.0)
		])
		
		var bottom_lip_left_base: int = vertices.size() - 4
		indices.append_array([
			bottom_lip_left_base, bottom_lip_left_base + 1, bottom_lip_left_base + 2,
			bottom_lip_left_base, bottom_lip_left_base + 2, bottom_lip_left_base + 3,
			bottom_lip_left_base + 1, bottom_lip_left_base, bottom_lip_left_base + 2,
			bottom_lip_left_base + 2, bottom_lip_left_base, bottom_lip_left_base + 3
		])
		
		vertices.append_array([vertices[last_lip + 14], vertices[last_lip + 15], vertices[last_lip + 17], vertices[last_lip + 3]])
		normals.append_array([right_normal, right_normal, right_normal, right_normal])
		uvs.append_array([
			Vector2(0.4, 0.0), Vector2(0.4, 0.2),
			Vector2(0.6, 0.2), Vector2(0.6, 0.0)
		])
		
		var bottom_lip_right_base: int = vertices.size() - 4
		indices.append_array([
			bottom_lip_right_base, bottom_lip_right_base + 2, bottom_lip_right_base + 1,
			bottom_lip_right_base, bottom_lip_right_base + 3, bottom_lip_right_base + 2,
			bottom_lip_right_base + 2, bottom_lip_right_base, bottom_lip_right_base + 1,
			bottom_lip_right_base + 3, bottom_lip_right_base, bottom_lip_right_base + 2
		])
	
	# Create mesh surface
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices
	
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	mesh.surface_set_material(0, shader_material)
	
	outer_mesh.mesh = mesh

func _create_inner_guard_mesh() -> void:
	var mesh := ArrayMesh.new()
	

	# Inner guard should be at the inner radius of the conveyor
	var radius_outer: float = _current_inner_radius - 0.06  # Slightly inside the inner edge
	var height: float = BASE_HEIGHT * size.y
	var thickness: float = MIDDLE_THICKNESS
	
	var lip_height: float = 0.005 * size.y
	var lip_outward: float = 0.05
	var lip_inward: float = 0.05
	
	var segments: int = int(guard_angle / 9.0)
	var angle_radians: float = deg_to_rad(guard_angle)
	
	var vertices := PackedVector3Array()
	var normals := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()
	
	# Calculate UV scaling
	var arc_length: float = radius_outer * angle_radians
	var uv_scale_length: float = arc_length / 2.0
	
	# Generate vertices and normals with flipped Z orientation
	for i in range(segments + 1):
		var t: float = float(i) / segments
		var angle: float = t * angle_radians
		var sin_a: float = sin(angle)
		var cos_a: float = cos(angle)
		
		# Outer wall vertices
		var outer_top := Vector3(-sin_a * radius_outer, height, cos_a * radius_outer)
		var outer_bottom := Vector3(-sin_a * radius_outer, 0, cos_a * radius_outer)
		
		# Middle section vertices
		var middle_top := Vector3(
			-sin_a * (radius_outer - thickness),
			height,
			cos_a * (radius_outer - thickness)
		)
		var middle_bottom := Vector3(
			-sin_a * (radius_outer - thickness),
			0,
			cos_a * (radius_outer - thickness)
		)
		
		# Bottom lip on outer wall
		var bottom_lip_bottom := Vector3(
			-sin_a * (radius_outer + lip_outward + 0.02),
			0,
			cos_a * (radius_outer + lip_outward + 0.02)
		)
		var bottom_lip_middle_outer := Vector3(
			-sin_a * (radius_outer + lip_outward + 0.02),
			lip_height,
			cos_a * (radius_outer + lip_outward + 0.02)
		)
		var bottom_lip_middle_inner := Vector3(
			-sin_a * radius_outer,
			lip_height,
			cos_a * radius_outer
		)
		
		# Top lip on inner wall
		var top_lip_top := Vector3(
			-sin_a * (radius_outer - thickness - lip_inward),
			height,
			cos_a * (radius_outer - thickness - lip_inward)
		)
		var top_lip_middle_inner := Vector3(
			-sin_a * (radius_outer - thickness - lip_inward),
			height - lip_height,
			cos_a * (radius_outer - thickness - lip_inward)
		)
		var top_lip_middle_outer := Vector3(
			-sin_a * (radius_outer - thickness),
			height - lip_height,
			cos_a * (radius_outer - thickness)
		)
		
		# Calculate normals
		var center := Vector3.ZERO
		var outer_normal := (outer_top - center).normalized()
		outer_normal.y = 0
		outer_normal = outer_normal.normalized()
		
		var inner_normal := (center - middle_top).normalized()
		inner_normal.y = 0
		inner_normal = inner_normal.normalized()
		
		var uv_arc_pos: float = t * uv_scale_length
		
		# Outer wall
		vertices.append_array([outer_top, outer_bottom])
		normals.append_array([outer_normal, outer_normal])
		uvs.append_array([Vector2(uv_arc_pos, 0.4), Vector2(uv_arc_pos, 0.6)])
		
		# Inner wall
		vertices.append_array([middle_top, middle_bottom])
		normals.append_array([inner_normal, inner_normal])
		uvs.append_array([Vector2(uv_arc_pos, 0.2), Vector2(uv_arc_pos, 0.4)])
		
		# Top surface
		vertices.append_array([outer_top, middle_top])
		normals.append_array([Vector3.UP, Vector3.UP])
		uvs.append_array([Vector2(0.8, uv_arc_pos), Vector2(1.0, uv_arc_pos)])
		
		# Bottom surface
		vertices.append_array([outer_bottom, middle_bottom])
		normals.append_array([Vector3.DOWN, Vector3.DOWN])
		uvs.append_array([Vector2(0.0, uv_arc_pos), Vector2(0.2, uv_arc_pos)])
		
		# Bottom lip: outer vertical face
		vertices.append_array([bottom_lip_bottom, bottom_lip_middle_outer])
		normals.append_array([outer_normal, outer_normal])
		uvs.append_array([Vector2(uv_arc_pos, 0.8), Vector2(uv_arc_pos, 1.0)])
		
		# Bottom lip: top flat face
		vertices.append_array([bottom_lip_middle_outer, bottom_lip_middle_inner])
		normals.append_array([Vector3.UP, Vector3.UP])
		uvs.append_array([Vector2(0.4, uv_arc_pos), Vector2(0.6, uv_arc_pos)])
		
		# Bottom lip: inner vertical face
		vertices.append_array([outer_bottom, bottom_lip_bottom])
		normals.append_array([Vector3.DOWN, Vector3.DOWN])
		uvs.append_array([Vector2(uv_arc_pos, 0.4), Vector2(uv_arc_pos, 0.6)])
		
		# Top lip: outer vertical face
		vertices.append_array([top_lip_middle_outer, top_lip_middle_inner])
		normals.append_array([Vector3.DOWN, Vector3.DOWN])
		uvs.append_array([Vector2(uv_arc_pos, 0.0), Vector2(uv_arc_pos, 0.2)])
		
		# Top lip: bottom flat face
		vertices.append_array([top_lip_middle_inner, top_lip_top])
		normals.append_array([Vector3.DOWN, Vector3.DOWN])
		uvs.append_array([Vector2(0.2, uv_arc_pos), Vector2(0.4, uv_arc_pos)])
		
		# Top lip: inner vertical face
		vertices.append_array([top_lip_top, middle_top])
		normals.append_array([Vector3.UP, Vector3.UP])
		uvs.append_array([Vector2(uv_arc_pos + 0.1, 0.0), Vector2(uv_arc_pos + 0.1, 0.2)])
	
	# Generate indices
	for i in range(segments):
		var outer_base: int = i * 20
		indices.append_array([
			outer_base, outer_base + 1, outer_base + 21,
			outer_base, outer_base + 21, outer_base + 20,
			outer_base + 1, outer_base, outer_base + 21,
			outer_base + 21, outer_base, outer_base + 20
		])
		
		var inner_base: int = i * 20 + 2
		indices.append_array([
			inner_base, inner_base + 21, inner_base + 1,
			inner_base, inner_base + 20, inner_base + 21,
			inner_base + 21, inner_base, inner_base + 1,
			inner_base + 20, inner_base, inner_base + 21
		])
		
		var top_base: int = i * 20 + 4
		indices.append_array([
			top_base, top_base + 20, top_base + 21,
			top_base, top_base + 21, top_base + 1,
			top_base + 20, top_base, top_base + 21,
			top_base + 21, top_base, top_base + 1
		])
		
		var bottom_base: int = i * 20 + 6
		indices.append_array([
			bottom_base, bottom_base + 21, bottom_base + 20,
			bottom_base, bottom_base + 1, bottom_base + 21,
			bottom_base + 21, bottom_base, bottom_base + 20,
			bottom_base + 1, bottom_base, bottom_base + 21
		])
		
		var bottom_lip_outer_base: int = i * 20 + 8
		indices.append_array([
			bottom_lip_outer_base, bottom_lip_outer_base + 1, bottom_lip_outer_base + 21,
			bottom_lip_outer_base, bottom_lip_outer_base + 21, bottom_lip_outer_base + 20,
			bottom_lip_outer_base + 1, bottom_lip_outer_base, bottom_lip_outer_base + 21,
			bottom_lip_outer_base + 21, bottom_lip_outer_base, bottom_lip_outer_base + 20
		])
		
		var bottom_lip_top_base: int = i * 20 + 10
		indices.append_array([
			bottom_lip_top_base, bottom_lip_top_base + 20, bottom_lip_top_base + 21,
			bottom_lip_top_base, bottom_lip_top_base + 21, bottom_lip_top_base + 1,
			bottom_lip_top_base + 20, bottom_lip_top_base, bottom_lip_top_base + 21,
			bottom_lip_top_base + 21, bottom_lip_top_base, bottom_lip_top_base + 1
		])
		
		var bottom_lip_inner_base: int = i * 20 + 12
		indices.append_array([
			bottom_lip_inner_base, bottom_lip_inner_base + 1, bottom_lip_inner_base + 21,
			bottom_lip_inner_base, bottom_lip_inner_base + 21, bottom_lip_inner_base + 20,
			bottom_lip_inner_base + 1, bottom_lip_inner_base, bottom_lip_inner_base + 21,
			bottom_lip_inner_base + 21, bottom_lip_inner_base, bottom_lip_inner_base + 20
		])
		
		var top_lip_outer_base: int = i * 20 + 14
		indices.append_array([
			top_lip_outer_base, top_lip_outer_base + 21, top_lip_outer_base + 1,
			top_lip_outer_base, top_lip_outer_base + 20, top_lip_outer_base + 21,
			top_lip_outer_base + 21, top_lip_outer_base, top_lip_outer_base + 1,
			top_lip_outer_base + 20, top_lip_outer_base, top_lip_outer_base + 21
		])
		
		var top_lip_bottom_base: int = i * 20 + 16
		indices.append_array([
			top_lip_bottom_base, top_lip_bottom_base + 20, top_lip_bottom_base + 21,
			top_lip_bottom_base, top_lip_bottom_base + 21, top_lip_bottom_base + 1,
			top_lip_bottom_base + 20, top_lip_bottom_base, top_lip_bottom_base + 21,
			top_lip_bottom_base + 21, top_lip_bottom_base, top_lip_bottom_base + 1
		])
		
		var top_lip_inner_base: int = i * 20 + 18
		indices.append_array([
			top_lip_inner_base, top_lip_inner_base + 1, top_lip_inner_base + 21,
			top_lip_inner_base, top_lip_inner_base + 21, top_lip_inner_base + 20,
			top_lip_inner_base + 1, top_lip_inner_base, top_lip_inner_base + 21,
			top_lip_inner_base + 21, top_lip_inner_base, top_lip_inner_base + 20
		])
	
	# Add end caps for main body
	if segments > 0:
		vertices.append_array([vertices[0], vertices[2], vertices[1], vertices[3]])
		var left_normal := Vector3(-1, 0, 0)
		normals.append_array([left_normal, left_normal, left_normal, left_normal])
		uvs.append_array([
			Vector2(0.8, 0.2), Vector2(1.0, 0.2),
			Vector2(0.8, 0.4), Vector2(1.0, 0.4)
		])
		
		var left_base: int = vertices.size() - 4
		indices.append_array([
			left_base, left_base + 1, left_base + 3,
			left_base, left_base + 3, left_base + 2,
			left_base + 1, left_base, left_base + 3,
			left_base + 3, left_base, left_base + 2
		])
		
		var last: int = segments * 20
		vertices.append_array([vertices[last], vertices[last + 2], vertices[last + 1], vertices[last + 3]])
		var right_normal := Vector3(1, 0, 0)
		normals.append_array([right_normal, right_normal, right_normal, right_normal])
		uvs.append_array([
			Vector2(0.8, 0.6), Vector2(1.0, 0.6),
			Vector2(0.8, 0.8), Vector2(1.0, 0.8)
		])
		
		var right_base: int = vertices.size() - 4
		indices.append_array([
			right_base, right_base + 3, right_base + 1,
			right_base, right_base + 2, right_base + 3,
			right_base + 3, right_base, right_base + 1,
			right_base + 2, right_base, right_base + 3
		])
	
	# Add end caps for bottom lip
	if segments > 0:
		vertices.append_array([vertices[8], vertices[9], vertices[11], vertices[1]])
		var left_normal := Vector3(-1, 0, 0)
		normals.append_array([left_normal, left_normal, left_normal, left_normal])
		uvs.append_array([
			Vector2(0.0, 0.8), Vector2(0.0, 1.0),
			Vector2(0.2, 1.0), Vector2(0.2, 0.8)
		])
		
		var lip_left_base: int = vertices.size() - 4
		indices.append_array([
			lip_left_base, lip_left_base + 1, lip_left_base + 2,
			lip_left_base, lip_left_base + 2, lip_left_base + 3,
			lip_left_base + 1, lip_left_base, lip_left_base + 2,
			lip_left_base + 2, lip_left_base, lip_left_base + 3
		])
		
		var last_lip: int = segments * 20
		vertices.append_array([vertices[last_lip + 8], vertices[last_lip + 9], vertices[last_lip + 11], vertices[last_lip + 1]])
		var right_normal := Vector3(1, 0, 0)
		normals.append_array([right_normal, right_normal, right_normal, right_normal])
		uvs.append_array([
			Vector2(0.4, 0.8), Vector2(0.4, 1.0),
			Vector2(0.6, 1.0), Vector2(0.6, 0.8)
		])
		
		var lip_right_base: int = vertices.size() - 4
		indices.append_array([
			lip_right_base, lip_right_base + 2, lip_right_base + 1,
			lip_right_base, lip_right_base + 3, lip_right_base + 2,
			lip_right_base + 2, lip_right_base, lip_right_base + 1,
			lip_right_base + 3, lip_right_base, lip_right_base + 2
		])
		
		# Add end caps for top lip
		vertices.append_array([vertices[14], vertices[15], vertices[17], vertices[2]])
		normals.append_array([left_normal, left_normal, left_normal, left_normal])
		uvs.append_array([
			Vector2(0.0, 0.0), Vector2(0.0, 0.2),
			Vector2(0.2, 0.2), Vector2(0.2, 0.0)
		])
		
		var top_lip_left_base: int = vertices.size() - 4
		indices.append_array([
			top_lip_left_base, top_lip_left_base + 1, top_lip_left_base + 2,
			top_lip_left_base, top_lip_left_base + 2, top_lip_left_base + 3,
			top_lip_left_base + 1, top_lip_left_base, top_lip_left_base + 2,
			top_lip_left_base + 2, top_lip_left_base, top_lip_left_base + 3
		])
		
		vertices.append_array([vertices[last_lip + 14], vertices[last_lip + 15], vertices[last_lip + 17], vertices[last_lip + 2]])
		normals.append_array([right_normal, right_normal, right_normal, right_normal])
		uvs.append_array([
			Vector2(0.4, 0.0), Vector2(0.4, 0.2),
			Vector2(0.6, 0.2), Vector2(0.6, 0.0)
		])
		
		var top_lip_right_base: int = vertices.size() - 4
		indices.append_array([
			top_lip_right_base, top_lip_right_base + 2, top_lip_right_base + 1,
			top_lip_right_base, top_lip_right_base + 3, top_lip_right_base + 2,
			top_lip_right_base + 2, top_lip_right_base, top_lip_right_base + 1,
			top_lip_right_base + 3, top_lip_right_base, top_lip_right_base + 2
		])
	
	# Create mesh surface
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices
	
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	mesh.surface_set_material(0, inner_shader_material)
	
	inner_mesh.mesh = mesh

func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		_on_scale_changed()

func _on_scale_changed() -> void:
	if size.x != _prev_scale_x:
		_prev_scale_x = size.x
		_update_material_scale()
		_update_mesh()

func _update_material_scale() -> void:
	if shader_material and inner_shader_material:
		var angle_portion: float = guard_angle / 360.0
		# Use stored radius parameters directly
		var avg_radius: float = _current_inner_radius + (_current_conveyor_width / 2.0)
		var guard_length: float = 2.0 * PI * avg_radius * angle_portion
		var guard_scale: float = guard_length / (PI * 1.0)
		
	
		shader_material.set_shader_parameter('Scale', size.x)
		shader_material.set_shader_parameter('Scale2', size.y)
		shader_material.set_shader_parameter('EdgeScale', guard_scale * 1.2)
		
	
		inner_shader_material.set_shader_parameter('Scale', size.x)
		inner_shader_material.set_shader_parameter('Scale2', size.y)
		inner_shader_material.set_shader_parameter('EdgeScale', guard_scale * 1.2)

func _setup_collision_shape(mesh_instance: MeshInstance3D, is_inner: bool) -> void:
	var static_body: StaticBody3D = mesh_instance.get_node_or_null('StaticBody3D') as StaticBody3D
	if not static_body:
		static_body = StaticBody3D.new()
		static_body.name = 'StaticBody3D'
		mesh_instance.add_child(static_body)
		static_body.owner = get_tree().edited_scene_root if Engine.is_editor_hint() else self
	
	var collision_shape: CollisionShape3D = static_body.get_node_or_null('CollisionShape3D') as CollisionShape3D
	if not collision_shape:
		collision_shape = CollisionShape3D.new()
		collision_shape.name = 'CollisionShape3D'
		static_body.add_child(collision_shape)
		collision_shape.owner = get_tree().edited_scene_root if Engine.is_editor_hint() else self
	
	var mesh: ArrayMesh = mesh_instance.mesh
	if not mesh:
		return
	
	var all_vertices := PackedVector3Array()
	var all_indices := PackedInt32Array()
	
	for surface_index in range(mesh.get_surface_count()):
		var surface := mesh.surface_get_arrays(surface_index)
		var base_index: int = all_vertices.size()
		all_vertices.append_array(surface[Mesh.ARRAY_VERTEX])
		
		for i in surface[Mesh.ARRAY_INDEX]:
			all_indices.append(base_index + i)
	

	var triangle_vertices := PackedVector3Array()
	for i in range(0, all_indices.size(), 3):
		if i + 2 >= all_indices.size():
			break
		triangle_vertices.append_array([
			all_vertices[all_indices[i]],
			all_vertices[all_indices[i + 1]],
			all_vertices[all_indices[i + 2]]
		])
	

	var scaled_vertices := PackedVector3Array()
	for vertex in triangle_vertices:
		scaled_vertices.append(Vector3(vertex.x * 1.0, vertex.y * 1.0, vertex.z * 1.0))
	
	# Reuse existing collision shape if possible, otherwise create new one
	var shape: ConcavePolygonShape3D
	if collision_shape.shape != null and collision_shape.shape is ConcavePolygonShape3D:
		shape = collision_shape.shape as ConcavePolygonShape3D
	else:
		shape = ConcavePolygonShape3D.new()
		collision_shape.shape = shape
	
	shape.data = scaled_vertices


func update_for_curved_conveyor(inner_radius: float, conveyor_width: float, conveyor_size: Vector3, conveyor_angle: float) -> void:
	if not is_inside_tree():
		return
	
	var tolerance = 0.0001
	if abs(_current_inner_radius - inner_radius) < tolerance and \
	   abs(_current_conveyor_width - conveyor_width) < tolerance and \
	   abs(guard_angle - conveyor_angle) < tolerance:
		return
	
	_current_inner_radius = inner_radius
	_current_conveyor_width = conveyor_width
	
	guard_angle = conveyor_angle
	
	# Calculate new size based on absolute conveyor parameters (for compatibility)
	var outer_radius = inner_radius + conveyor_width
	var new_size_x = outer_radius * 2.0 
	
	# Keep Y and Z dimensions, only update X
	size = Vector3(new_size_x, size.y, size.z)
	
	# Explicitly update mesh and guard end pieces with new radius parameters
	_update_mesh()
