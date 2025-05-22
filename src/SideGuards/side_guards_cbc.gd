@tool
class_name SideGuardsCBC
extends Node3D

# Base dimensions
const BASE_INNER_RADIUS: float = 0.25
const BASE_OUTER_RADIUS: float = 1.25
const BASE_HEIGHT: float = 0.149
const MIDDLE_THICKNESS: float = 0.02
@export_range(5.0, 85.0, 1.0, "degrees") var guard_angle: float = 85.0:
	set(value):
		guard_angle = value
		update_mesh()

@export var size: Vector3 = Vector3(1.0, 1.0, 1.0):
	set(value):
		size = value
		update_mesh()

var shader_material: ShaderMaterial = null
var inner_shader_material: ShaderMaterial = null
var _prev_scale_x: float = 1.0
var mesh_instance: MeshInstance3D = null
var inner_mesh_instance: MeshInstance3D = null

func _init() -> void:
	set_notify_local_transform(true)

func _ready() -> void:
	# Create or get the MeshInstance3D child for outer guard
	mesh_instance = find_child("OuterSideGuard") as MeshInstance3D
	if not mesh_instance:
		mesh_instance = MeshInstance3D.new()
		mesh_instance.name = "OuterSideGuard"
		add_child(mesh_instance)
		mesh_instance.owner = get_tree().edited_scene_root if Engine.is_editor_hint() else self
	
	# Create or get the MeshInstance3D child for inner guard
	inner_mesh_instance = find_child("InnerSideGuard") as MeshInstance3D
	if not inner_mesh_instance:
		inner_mesh_instance = MeshInstance3D.new()
		inner_mesh_instance.name = "InnerSideGuard"
		add_child(inner_mesh_instance)
		inner_mesh_instance.owner = get_tree().edited_scene_root if Engine.is_editor_hint() else self
	
	# Create materials
	_setup_materials()
	_prev_scale_x = size.x
	update_mesh()

func _setup_materials() -> void:
	# Outer guard material (unchanged)
	shader_material = ShaderMaterial.new()
	shader_material.shader = load("res://assets/3DModels/Shaders/SideGuardShaderCBC.tres") as Shader
	shader_material.set_shader_parameter("Color", Color("#56a7c8"))
	
	# Inner guard material - make it more visible by using a brighter color
	inner_shader_material = ShaderMaterial.new()
	inner_shader_material.shader = load("res://assets/3DModels/Shaders/SideGuardShaderCBC.tres") as Shader
	inner_shader_material.set_shader_parameter("Color", Color("#56a7c8"))  # Same color as outer
	# Make inner material more visible by adjusting parameters
	inner_shader_material.set_shader_parameter("EdgeScale", 1.0)
	inner_shader_material.set_shader_parameter("Scale", 1.0)
	inner_shader_material.set_shader_parameter("Scale2", 1.0)
	
	# Calculate the material scale parameters for both guards
	_update_material_scale()
func update_mesh() -> void:
	if not is_inside_tree() or not mesh_instance or not inner_mesh_instance:
		return
	create_straight_guard_mesh()
	# Create the outer guard mesh
	create_outer_guard_mesh()
	
	# Create the inner guard mesh
	create_inner_guard_mesh()
	
	# Update material scale parameters
	_update_material_scale()
	
	# Update collision shapes
	_setup_collision_shape(mesh_instance, false)
	_setup_collision_shape(inner_mesh_instance, true)
func create_straight_guard_mesh() -> void:
	var mesh := ArrayMesh.new()
	
	# Calculate dimensions based on size
	var length: float = 1 * size.x
	var height: float = BASE_HEIGHT * size.y
	var thickness: float = MIDDLE_THICKNESS
	
	# Create arrays for vertices and indices
	var vertices := PackedVector3Array()
	var normals := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()
	
	# UV scaling for texture mapping
	var uv_scale_length: float = length / 2.0
	var uv_scale_height: float = height * 5.0
	
	# Define the 8 corners of the simple box
	# Front face corners
	var front_top_right := Vector3(length/2, height, thickness/2)
	var front_bottom_right := Vector3(length/2, 0, thickness/2)
	var front_top_left := Vector3(-length/2, height, thickness/2)
	var front_bottom_left := Vector3(-length/2, 0, thickness/2)
	
	# Back face corners
	var back_top_right := Vector3(length/2, height, -thickness/2)
	var back_bottom_right := Vector3(length/2, 0, -thickness/2)
	var back_top_left := Vector3(-length/2, height, -thickness/2)
	var back_bottom_left := Vector3(-length/2, 0, -thickness/2)
	
	# Calculate normals - perfectly aligned with axes for clean geometry
	var front_normal := Vector3(0, 0, 1)
	var back_normal := Vector3(0, 0, -1)
	var right_normal := Vector3(1, 0, 0)
	var left_normal := Vector3(-1, 0, 0)
	var up_normal := Vector3(0, 1, 0)
	var down_normal := Vector3(0, -1, 0)
	
	# Front face - perfectly flat rectangle
	vertices.append_array([front_top_left, front_bottom_left, front_bottom_right, front_top_right])
	normals.append_array([front_normal, front_normal, front_normal, front_normal])
	uvs.append_array([
		Vector2(0, 0), 
		Vector2(0, 1), 
		Vector2(1, 1), 
		Vector2(1, 0)
	])
	
	# Back face - perfectly flat rectangle
	vertices.append_array([back_top_right, back_bottom_right, back_bottom_left, back_top_left])
	normals.append_array([back_normal, back_normal, back_normal, back_normal])
	uvs.append_array([
		Vector2(0, 0), 
		Vector2(0, 1), 
		Vector2(1, 1), 
		Vector2(1, 0)
	])
	
	# Right face - perfectly flat rectangle
	vertices.append_array([front_top_right, front_bottom_right, back_bottom_right, back_top_right])
	normals.append_array([right_normal, right_normal, right_normal, right_normal])
	uvs.append_array([
		Vector2(0, 0), 
		Vector2(0, 1), 
		Vector2(1, 1), 
		Vector2(1, 0)
	])
	
	# Left face - perfectly flat rectangle
	vertices.append_array([back_top_left, back_bottom_left, front_bottom_left, front_top_left])
	normals.append_array([left_normal, left_normal, left_normal, left_normal])
	uvs.append_array([
		Vector2(0, 0), 
		Vector2(0, 1), 
		Vector2(1, 1), 
		Vector2(1, 0)
	])
	
	# Top face - perfectly flat rectangle
	vertices.append_array([front_top_left, front_top_right, back_top_right, back_top_left])
	normals.append_array([up_normal, up_normal, up_normal, up_normal])
	uvs.append_array([
		Vector2(0, 0), 
		Vector2(1, 0), 
		Vector2(1, 1), 
		Vector2(0, 1)
	])
	
	# Bottom face - perfectly flat rectangle
	vertices.append_array([front_bottom_left, back_bottom_left, back_bottom_right, front_bottom_right])
	normals.append_array([down_normal, down_normal, down_normal, down_normal])
	uvs.append_array([
		Vector2(0, 0), 
		Vector2(0, 1), 
		Vector2(1, 1), 
		Vector2(1, 0)
	])
	
	# Create triangles for all 6 faces with perfect indices
	# Each face has 2 triangles (6 indices)
	for i in range(6):
		var base_idx = i * 4
		
		# First triangle
		indices.append(base_idx)     # Top-left
		indices.append(base_idx + 1) # Bottom-left
		indices.append(base_idx + 2) # Bottom-right
		
		# Second triangle
		indices.append(base_idx)     # Top-left
		indices.append(base_idx + 2) # Bottom-right
		indices.append(base_idx + 3) # Top-right
	
	# Create the mesh with all surfaces
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices
	
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	mesh.surface_set_material(0, shader_material)
	
	mesh_instance.mesh = mesh
	_setup_collision_shape(mesh_instance, true)
func create_outer_guard_mesh() -> void:
	var mesh := ArrayMesh.new()
	
	# Calculate dimensions based on size
	var radius_outer: float = BASE_OUTER_RADIUS * size.x + 0.033
	var height: float = BASE_HEIGHT * size.y
	var thickness: float = MIDDLE_THICKNESS
	
	# Lip dimensions scaled by size
	var lip_height: float = 0.005 * size.y
	var lip_outward: float = 0.05
	var lip_inward: float = 0.05
	
	# Reduce segments to 1/9 of the angle for better performance (10 segments at 90°)
	var segments := int(guard_angle / 9.0)
	var angle_radians: float = deg_to_rad(guard_angle)
	
	# Create arrays for the single surface
	var vertices := PackedVector3Array()
	var normals := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()
	
	# Track current vertex index
	var current_idx := 0
	
	# Calculate UV scaling based on the arc length
	var arc_length: float = radius_outer * angle_radians
	var uv_scale_length: float = arc_length / 2.0
	var uv_scale_height: float = height * 5.0
	
	# Generate all vertices first
	for i in range(segments + 1):
		var t = float(i) / segments
		var angle: float = t * angle_radians
		var sin_a: float = sin(angle)
		var cos_a: float = cos(angle)
		
		# Main outer vertices
		var outer_top = Vector3(-sin_a * radius_outer, height, cos_a * radius_outer)
		var outer_bottom = Vector3(-sin_a * radius_outer, 0, cos_a * radius_outer)
		
		# Middle section vertices (offset by thickness)
		var middle_top = Vector3(
			-sin_a * (radius_outer - thickness),
			height,
			cos_a * (radius_outer - thickness))
		var middle_bottom = Vector3(
			-sin_a * (radius_outer - thickness),
			0,
			cos_a * (radius_outer - thickness))
		
		# Top lip vertices (forms the "r" shape)
		var top_lip_top = Vector3(
			-sin_a * (radius_outer + lip_outward),
			height,  # Slightly below top
			cos_a * (radius_outer + lip_outward))

		var top_lip_middle_outer = Vector3(
			-sin_a * (radius_outer + lip_outward),
			height - lip_height,
			cos_a * (radius_outer + lip_outward))

		var top_lip_middle_inner = Vector3(
			-sin_a * radius_outer,
			height - lip_height,
			cos_a * radius_outer)
			
		# Bottom lip vertices (forms the "Z" shape at bottom, extending from inner wall)
		var bottom_lip_bottom = Vector3(
			-sin_a * (radius_outer - thickness - lip_inward - 0.02),
			0,  
			cos_a * (radius_outer - thickness - lip_inward - 0.02))

		var bottom_lip_middle_inner = Vector3(
			-sin_a * (radius_outer - thickness - lip_inward - 0.02),
			lip_height,
			cos_a * (radius_outer - thickness - lip_inward - 0.02))

		var bottom_lip_middle_outer = Vector3(
			-sin_a * (radius_outer - thickness),
			lip_height,
			cos_a * (radius_outer - thickness))
		# Calculate better normals - use the direction from center for radial normals
		var center = Vector3(0, 0, 0)
		
		# Calculate curved UV mapping - use arc length for better texture distribution
		var uv_arc_pos = t * uv_scale_length
		
		# Outer wall - normal pointing outward
		var outer_normal = (outer_top - center).normalized()
		outer_normal.y = 0  # Make sure normal is parallel to ground
		outer_normal = outer_normal.normalized()
		vertices.append_array([outer_top, outer_bottom])
		normals.append_array([outer_normal, outer_normal])
		# Map UVs with proper vertical scaling for the outer wall
		uvs.append_array([Vector2(uv_arc_pos, 0.6), Vector2(uv_arc_pos, 0.8)])
		
		# Inner wall - normal pointing inward
		var inner_normal = (center - middle_top).normalized()
		inner_normal.y = 0  # Make sure normal is parallel to ground
		inner_normal = inner_normal.normalized()
		vertices.append_array([middle_top, middle_bottom])
		normals.append_array([inner_normal, inner_normal])
		# Map UVs with proper vertical scaling for the inner wall
		uvs.append_array([Vector2(uv_arc_pos, 0.2), Vector2(uv_arc_pos, 0.4)])
		
		# Top surface
		vertices.append_array([outer_top, middle_top])
		normals.append_array([Vector3.UP, Vector3.UP])
		# Map UVs for top surface with proper distribution
		uvs.append_array([Vector2(0.8, uv_arc_pos), Vector2(1.0, uv_arc_pos)])
		
		# Bottom surface
		vertices.append_array([outer_bottom, middle_bottom])
		normals.append_array([Vector3.DOWN, Vector3.DOWN])
		# Map UVs for bottom surface with proper distribution
		uvs.append_array([Vector2(0.0, uv_arc_pos), Vector2(0.2, uv_arc_pos)])
		
		# TOP LIP:
		# 1. Top lip outer vertical face (lip top to middle outer)
		# Use normal pointing outward from center
		vertices.append_array([top_lip_top, top_lip_middle_outer])
		normals.append_array([outer_normal, outer_normal])
		# Map UVs with proper vertical scaling for the lip outer wall
		uvs.append_array([Vector2(uv_arc_pos, 0.8), Vector2(uv_arc_pos, 1.0)])

		# 2. Top lip bottom flat face (middle outer to middle inner)
		vertices.append_array([top_lip_middle_outer, top_lip_middle_inner])
		normals.append_array([Vector3.DOWN, Vector3.DOWN])
		# Map UVs for lip bottom with proper distribution
		uvs.append_array([Vector2(0.4, uv_arc_pos), Vector2(0.6, uv_arc_pos)])

		# 3. Top lip inner vertical face (middle inner to outer top)
		# Create a weighted normal that blends between vertical and inward
		var combined_normal = (Vector3.UP * 0.2 + inner_normal * 0.8).normalized()
		vertices.append_array([outer_top, top_lip_top])
		normals.append_array([Vector3.UP, Vector3.UP])
		# Map UVs with proper vertical scaling for the lip inner wall
		uvs.append_array([Vector2(uv_arc_pos, 0.4), Vector2(uv_arc_pos, 0.6)])
		
		# BOTTOM LIP:
		# 1. Bottom lip outer vertical face (inner wall bottom to middle outer)
		vertices.append_array([bottom_lip_middle_outer, bottom_lip_middle_inner])
		normals.append_array([inner_normal, inner_normal])
		# Map UVs with proper vertical scaling for the bottom lip outer wall
		uvs.append_array([Vector2(uv_arc_pos, 0.0), Vector2(uv_arc_pos, 0.2)])

		# 2. Bottom lip top flat face (middle outer to middle inner)
		vertices.append_array([bottom_lip_middle_inner, bottom_lip_bottom])
		normals.append_array([Vector3.UP, Vector3.UP])
		# Map UVs for bottom lip top with proper distribution
		uvs.append_array([Vector2(0.2, uv_arc_pos), Vector2(0.4, uv_arc_pos)])

		vertices.append_array([bottom_lip_bottom, middle_bottom])
		normals.append_array([Vector3.DOWN, Vector3.DOWN])
		# Map UVs with proper vertical scaling for the bottom lip inner wall
		uvs.append_array([Vector2(uv_arc_pos + 0.1, 0.0), Vector2(uv_arc_pos + 0.1, 0.2)])
					
	# Generate indices for all parts
	for i in range(segments):
		# Outer wall
		var outer_base = i * 20  # Updated from 14 to 20 for 6 new vertices per segment
		indices.append_array([
			outer_base, outer_base + 1, outer_base + 21,
			outer_base, outer_base + 21, outer_base + 20,
			# Back faces
			outer_base + 1, outer_base, outer_base + 21,
			outer_base + 21, outer_base, outer_base + 20
		])
		
		# Inner wall
		var inner_base = i * 20 + 2
		indices.append_array([
			inner_base, inner_base + 21, inner_base + 1,
			inner_base, inner_base + 20, inner_base + 21,
			# Back faces
			inner_base + 21, inner_base, inner_base + 1,
			inner_base + 20, inner_base, inner_base + 21
		])
		
		# Top surface
		var top_base = i * 20 + 4
		indices.append_array([
			top_base, top_base + 20, top_base + 21,
			top_base, top_base + 21, top_base + 1,
			# Back faces
			top_base + 20, top_base, top_base + 21,
			top_base + 21, top_base, top_base + 1
		])
		
		# Bottom surface
		var bottom_base = i * 20 + 6
		indices.append_array([
			bottom_base, bottom_base + 21, bottom_base + 20,
			bottom_base, bottom_base + 1, bottom_base + 21,
			# Back faces
			bottom_base + 21, bottom_base, bottom_base + 20,
			bottom_base + 1, bottom_base, bottom_base + 21
		])
		
		# TOP LIP:
		# Top lip outer vertical
		var top_lip_outer_base = i * 20 + 8
		indices.append_array([
			top_lip_outer_base, top_lip_outer_base + 1, top_lip_outer_base + 21,
			top_lip_outer_base, top_lip_outer_base + 21, top_lip_outer_base + 20,
			# Back faces
			top_lip_outer_base + 1, top_lip_outer_base, top_lip_outer_base + 21,
			top_lip_outer_base + 21, top_lip_outer_base, top_lip_outer_base + 20
		])
		
		# Top lip bottom flat
		var top_lip_bottom_base = i * 20 + 10
		indices.append_array([
			top_lip_bottom_base, top_lip_bottom_base + 21, top_lip_bottom_base + 20,
			top_lip_bottom_base, top_lip_bottom_base + 1, top_lip_bottom_base + 21,
			# Back faces
			top_lip_bottom_base + 21, top_lip_bottom_base, top_lip_bottom_base + 20,
			top_lip_bottom_base + 1, top_lip_bottom_base, top_lip_bottom_base + 21
		])
		
		# Top lip inner vertical
		var top_lip_inner_base = i * 20 + 12
		indices.append_array([
			top_lip_inner_base, top_lip_inner_base + 1, top_lip_inner_base + 21,
			top_lip_inner_base, top_lip_inner_base + 21, top_lip_inner_base + 20,
			# Back faces
			top_lip_inner_base + 1, top_lip_inner_base, top_lip_inner_base + 21,
			top_lip_inner_base + 21, top_lip_inner_base, top_lip_inner_base + 20
		])
		
		# BOTTOM LIP:
		# Bottom lip outer vertical (inner wall to middle outer)
		var bottom_lip_outer_base = i * 20 + 14
		indices.append_array([
			bottom_lip_outer_base, bottom_lip_outer_base + 21, bottom_lip_outer_base + 1,
			bottom_lip_outer_base, bottom_lip_outer_base + 20, bottom_lip_outer_base + 21,
			# Back faces
			bottom_lip_outer_base + 21, bottom_lip_outer_base, bottom_lip_outer_base + 1,
			bottom_lip_outer_base + 20, bottom_lip_outer_base, bottom_lip_outer_base + 21
		])
		
		# Bottom lip top flat (middle outer to middle inner)
		var bottom_lip_top_base = i * 20 + 16
		indices.append_array([
			bottom_lip_top_base, bottom_lip_top_base + 20, bottom_lip_top_base + 21,
			bottom_lip_top_base, bottom_lip_top_base + 21, bottom_lip_top_base + 1,
			# Back faces
			bottom_lip_top_base + 20, bottom_lip_top_base, bottom_lip_top_base + 21,
			bottom_lip_top_base + 21, bottom_lip_top_base, bottom_lip_top_base + 1
		])
		
		# Bottom lip inner vertical (middle inner to bottom)
		var bottom_lip_inner_base = i * 20 + 18
		indices.append_array([
			bottom_lip_inner_base, bottom_lip_inner_base + 1, bottom_lip_inner_base + 21,
			bottom_lip_inner_base, bottom_lip_inner_base + 21, bottom_lip_inner_base + 20,
			# Back faces
			bottom_lip_inner_base + 1, bottom_lip_inner_base, bottom_lip_inner_base + 21,
			bottom_lip_inner_base + 21, bottom_lip_inner_base, bottom_lip_inner_base + 20
		])
	
	# Add end caps for the main body with improved UVs
	if segments > 0:
		# Left side
		vertices.append_array([
			vertices[0], vertices[2],  # outer_top, middle_top
			vertices[1], vertices[3]   # outer_bottom, middle_bottom
		])
		
		# For left end cap, normal points left (negative X)
		var left_normal = Vector3(-1, 0, 0) 
		normals.append_array([left_normal, left_normal, left_normal, left_normal])
		
		# Scale-aware UVs for end cap - use consistent mapping with the rest of the mesh
		uvs.append_array([
			Vector2(0.8, 0.2), Vector2(1.0, 0.2),
			Vector2(0.8, 0.4), Vector2(1.0, 0.4)
		])
		
		var left_base = vertices.size() - 4
		indices.append_array([
			left_base, left_base + 1, left_base + 3,
			left_base, left_base + 3, left_base + 2,
			# Back faces
			left_base + 1, left_base, left_base + 3,
			left_base + 3, left_base, left_base + 2
		])
		
		# Right side
		var last = segments * 20
		vertices.append_array([
			vertices[last], vertices[last + 2],  # outer_top, middle_top
			vertices[last + 1], vertices[last + 3]   # outer_bottom, middle_bottom
		])
		
		# For right end cap, normal points right (positive X)
		var right_normal = Vector3(1, 0, 0)
		normals.append_array([right_normal, right_normal, right_normal, right_normal])
		
		# Scale-aware UVs for end cap - use consistent mapping with the rest of the mesh
		uvs.append_array([
			Vector2(0.8, 0.6), Vector2(1.0, 0.6),
			Vector2(0.8, 0.8), Vector2(1.0, 0.8)
		])
		
		var right_base = vertices.size() - 4
		indices.append_array([
			right_base, right_base + 3, right_base + 1,
			right_base, right_base + 2, right_base + 3,
			# Back faces
			right_base + 3, right_base, right_base + 1,
			right_base + 2, right_base, right_base + 3
		])
	
	# Add end caps specifically for the TOP lip with improved UVs
	if segments > 0:
		# Left top lip end cap
		vertices.append_array([
			vertices[8],  # lip_top left
			vertices[9],  # lip_middle_outer left
			vertices[11], # lip_middle_inner left
			vertices[0]   # outer_top left (connects to lip)
		])
		
		# For the left cap, normal points to the left (negative X direction)
		var left_normal = Vector3(-1, 0, 0)
		normals.append_array([
			left_normal, left_normal, 
			left_normal, left_normal
		])
		
		# Scale-aware UVs for lip end caps - consistent with the rest of the mesh
		uvs.append_array([
			Vector2(0.0, 0.8), Vector2(0.0, 1.0),
			Vector2(0.2, 1.0), Vector2(0.2, 0.8)
		])
		
		var lip_left_base = vertices.size() - 4
		indices.append_array([
			lip_left_base, lip_left_base + 1, lip_left_base + 2,
			lip_left_base, lip_left_base + 2, lip_left_base + 3,
			# Back faces
			lip_left_base + 1, lip_left_base, lip_left_base + 2,
			lip_left_base + 2, lip_left_base, lip_left_base + 3
		])
		
		# Right top lip end cap
		var last_lip = segments * 20
		vertices.append_array([
			vertices[last_lip + 8],  # top_lip_top right
			vertices[last_lip + 9],  # top_lip_middle_outer right
			vertices[last_lip + 11], # top_lip_middle_inner right
			vertices[last_lip]       # outer_top right (connects to lip)
		])
		
		# For the right cap, normal points to the right (positive X direction) 
		var right_normal = Vector3(1, 0, 0)
		normals.append_array([
			right_normal, right_normal, 
			right_normal, right_normal
		])
		
		# Scale-aware UVs for lip end caps - consistent with the rest of the mesh
		uvs.append_array([
			Vector2(0.4, 0.8), Vector2(0.4, 1.0),
			Vector2(0.6, 1.0), Vector2(0.6, 0.8)
		])
		
		var lip_right_base = vertices.size() - 4
		indices.append_array([
			lip_right_base, lip_right_base + 2, lip_right_base + 1,
			lip_right_base, lip_right_base + 3, lip_right_base + 2,
			# Back faces
			lip_right_base + 2, lip_right_base, lip_right_base + 1,
			lip_right_base + 3, lip_right_base, lip_right_base + 2
		])
		
		# Add end caps specifically for the BOTTOM lip with improved UVs
		# Left bottom lip end cap
		vertices.append_array([
			vertices[14],  # bottom_middle left
			vertices[15],  # bottom_lip_middle_outer left
			vertices[17], # bottom_lip_bottom left
			vertices[3]   # middle_bottom left (connects to bottom lip)
		])
		
		# For the left cap, normal points to the left (negative X direction)
		left_normal = Vector3(-1, 0, 0)
		normals.append_array([
			left_normal, left_normal, 
			left_normal, left_normal
		])
		
		# Scale-aware UVs for bottom lip end caps
		uvs.append_array([
			Vector2(0.0, 0.0), Vector2(0.0, 0.2),
			Vector2(0.2, 0.2), Vector2(0.2, 0.0)
		])
		
		var bottom_lip_left_base = vertices.size() - 4
		indices.append_array([
			bottom_lip_left_base, bottom_lip_left_base + 1, bottom_lip_left_base + 2,
			bottom_lip_left_base, bottom_lip_left_base + 2, bottom_lip_left_base + 3,
			# Back faces
			bottom_lip_left_base + 1, bottom_lip_left_base, bottom_lip_left_base + 2,
			bottom_lip_left_base + 2, bottom_lip_left_base, bottom_lip_left_base + 3
		])
		
		# Right bottom lip end cap
		vertices.append_array([
			vertices[last_lip + 14],  # bottom_middle right
			vertices[last_lip + 15],  # bottom_lip_middle_outer right
			vertices[last_lip + 17], # bottom_lip_bottom right
			vertices[last_lip + 3]   # middle_bottom right (connects to bottom lip)
		])
		
		# For the right cap, normal points to the right (positive X direction) 
		right_normal = Vector3(1, 0, 0)
		normals.append_array([
			right_normal, right_normal, 
			right_normal, right_normal
		])
		
		# Scale-aware UVs for bottom lip end caps
		uvs.append_array([
			Vector2(0.4, 0.0), Vector2(0.4, 0.2),
			Vector2(0.6, 0.2), Vector2(0.6, 0.0)
		])
		
		var bottom_lip_right_base = vertices.size() - 4
		indices.append_array([
			bottom_lip_right_base, bottom_lip_right_base + 2, bottom_lip_right_base + 1,
			bottom_lip_right_base, bottom_lip_right_base + 3, bottom_lip_right_base + 2,
			# Back faces
			bottom_lip_right_base + 2, bottom_lip_right_base, bottom_lip_right_base + 1,
			bottom_lip_right_base + 3, bottom_lip_right_base, bottom_lip_right_base + 2
		])
	
	# Create the single surface
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices
	
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	mesh.surface_set_material(0, shader_material)
	
	mesh_instance.mesh = mesh
	_setup_collision_shape(mesh_instance, false)
func create_inner_guard_mesh() -> void:
	var mesh := ArrayMesh.new()
	
	# Calculate dimensions based on size - inner guard is half the size in X
	var inner_scale_x = size.x * 0.165
	 # Half the X size for inner guard
	var radius_outer: float = BASE_OUTER_RADIUS * inner_scale_x
	var height: float = BASE_HEIGHT * size.y
	var thickness: float = MIDDLE_THICKNESS
	
	# Lip dimensions scaled by size
	var lip_height: float = 0.005 * size.y
	var lip_outward: float = 0.05
	var lip_inward: float = 0.05
	
	# Reduce segments to 1/3 of the angle for better performance
	var segments := int(guard_angle / 9.0)
	var angle_radians: float = deg_to_rad(guard_angle)
	
	# Create arrays for the single surface
	var vertices := PackedVector3Array()
	var normals := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()
	
	# Calculate UV scaling based on the arc length
	var arc_length: float = radius_outer * angle_radians
	var uv_scale_length: float = arc_length / 2.0
	var uv_scale_height: float = height * 5.0
	
	# Generate all vertices first - FLIPPED Z ORIENTATION
	for i in range(segments + 1):
		var t = float(i) / segments
		var angle: float = t * angle_radians
		var sin_a: float = sin(angle)
		var cos_a: float = cos(angle)
		
		# Main outer vertices
		var outer_top = Vector3(-sin_a * radius_outer, height, cos_a * radius_outer)
		var outer_bottom = Vector3(-sin_a * radius_outer, 0, cos_a * radius_outer)
		
		# Middle section vertices (offset by thickness)
		var middle_top = Vector3(
			-sin_a * (radius_outer - thickness),
			height,
			cos_a * (radius_outer - thickness))
		var middle_bottom = Vector3(
			-sin_a * (radius_outer - thickness),
			0,
			cos_a * (radius_outer - thickness))
		
		# FLIPPED: Bottom lip on the outer wall (was top lip)
		var bottom_lip_bottom = Vector3(
			-sin_a * (radius_outer + lip_outward + 0.02),
			0,  # Now at bottom
			cos_a * (radius_outer + lip_outward + 0.02))

		var bottom_lip_middle_outer = Vector3(
			-sin_a * (radius_outer + lip_outward+ 0.02),
			lip_height,  # Just above bottom
			cos_a * (radius_outer + lip_outward+ 0.02))

		var bottom_lip_middle_inner = Vector3(
			-sin_a * radius_outer,
			lip_height,
			cos_a * radius_outer)
			
		# FLIPPED: Top lip on the inner wall (was bottom lip)
		var top_lip_top = Vector3(
			-sin_a * (radius_outer - thickness - lip_inward),
			height,  
			cos_a * (radius_outer - thickness - lip_inward))

		var top_lip_middle_inner = Vector3(
			-sin_a * (radius_outer - thickness - lip_inward),
			height - lip_height,
			cos_a * (radius_outer - thickness - lip_inward))

		var top_lip_middle_outer = Vector3(
			-sin_a * (radius_outer - thickness),
			height - lip_height,
			cos_a * (radius_outer - thickness))

		# Calculate better normals - use the direction from center for radial normals
		var center = Vector3(0, 0, 0)
		
		# Calculate curved UV mapping - use arc length for better texture distribution
		var uv_arc_pos = t * uv_scale_length
		
		# Outer wall - normal pointing outward
		var outer_normal = (outer_top - center).normalized()
		outer_normal.y = 0  # Make sure normal is parallel to ground
		outer_normal = outer_normal.normalized()
		vertices.append_array([outer_top, outer_bottom])
		normals.append_array([outer_normal, outer_normal])
		# Map UVs with proper vertical scaling for the outer wall
		uvs.append_array([Vector2(uv_arc_pos, 0.6), Vector2(uv_arc_pos, 0.8)])
		
		# Inner wall - normal pointing inward
		var inner_normal = (center - middle_top).normalized()
		inner_normal.y = 0  # Make sure normal is parallel to ground
		inner_normal = inner_normal.normalized()
		vertices.append_array([middle_top, middle_bottom])
		normals.append_array([inner_normal, inner_normal])
		# Map UVs with proper vertical scaling for the inner wall
		uvs.append_array([Vector2(uv_arc_pos, 0.2), Vector2(uv_arc_pos, 0.4)])
		
		# Top surface
		vertices.append_array([outer_top, middle_top])
		normals.append_array([Vector3.UP, Vector3.UP])
		# Map UVs for top surface with proper distribution
		uvs.append_array([Vector2(0.8, uv_arc_pos), Vector2(1.0, uv_arc_pos)])
		
		# Bottom surface
		vertices.append_array([outer_bottom, middle_bottom])
		normals.append_array([Vector3.DOWN, Vector3.DOWN])
		# Map UVs for bottom surface with proper distribution
		uvs.append_array([Vector2(0.0, uv_arc_pos), Vector2(0.2, uv_arc_pos)])
		
		# FLIPPED: BOTTOM LIP (on outer wall):
		# 1. Bottom lip outer vertical face (lip bottom to middle outer)
		vertices.append_array([bottom_lip_bottom, bottom_lip_middle_outer])
		normals.append_array([outer_normal, outer_normal])
		# Map UVs with proper vertical scaling for the bottom lip outer wall
		uvs.append_array([Vector2(uv_arc_pos, 0.8), Vector2(uv_arc_pos, 1.0)])

		# 2. Bottom lip top flat face (middle outer to middle inner)
		vertices.append_array([bottom_lip_middle_outer, bottom_lip_middle_inner])
		normals.append_array([Vector3.UP, Vector3.UP])
		# Map UVs for bottom lip top with proper distribution
		uvs.append_array([Vector2(0.4, uv_arc_pos), Vector2(0.6, uv_arc_pos)])

		# 3. Bottom lip inner vertical face (middle inner to outer bottom)
		vertices.append_array([outer_bottom, bottom_lip_bottom])
		normals.append_array([Vector3.DOWN, Vector3.DOWN])
		# Map UVs with proper vertical scaling for the bottom lip inner wall
		uvs.append_array([Vector2(uv_arc_pos, 0.4), Vector2(uv_arc_pos, 0.6)])
		
		# FLIPPED: TOP LIP (on inner wall):
		# 1. Top lip outer vertical face (inner wall top to middle outer)
		vertices.append_array([top_lip_middle_outer, top_lip_middle_inner])
		normals.append_array([inner_normal, inner_normal])
		# Map UVs with proper vertical scaling for the top lip outer wall
		uvs.append_array([Vector2(uv_arc_pos, 0.0), Vector2(uv_arc_pos, 0.2)])

		# 2. Top lip bottom flat face (middle outer to middle inner)
		vertices.append_array([top_lip_middle_inner, top_lip_top])
		normals.append_array([Vector3.UP, Vector3.UP])
		# Map UVs for top lip bottom with proper distribution
		uvs.append_array([Vector2(0.2, uv_arc_pos), Vector2(0.4, uv_arc_pos)])

		vertices.append_array([top_lip_top, middle_top])
		normals.append_array([Vector3.UP, Vector3.UP])
		# Map UVs with proper vertical scaling for the top lip inner wall
		uvs.append_array([Vector2(uv_arc_pos + 0.1, 0.0), Vector2(uv_arc_pos + 0.1, 0.2)])
		
	# Generate indices for all parts
	for i in range(segments):
		# Outer wall
		var outer_base = i * 20  # 20 vertices per segment
		indices.append_array([
			outer_base, outer_base + 1, outer_base + 21,
			outer_base, outer_base + 21, outer_base + 20,
			# Back faces
			outer_base + 1, outer_base, outer_base + 21,
			outer_base + 21, outer_base, outer_base + 20
		])
		
		# Inner wall
		var inner_base = i * 20 + 2
		indices.append_array([
			inner_base, inner_base + 21, inner_base + 1,
			inner_base, inner_base + 20, inner_base + 21,
			# Back faces
			inner_base + 21, inner_base, inner_base + 1,
			inner_base + 20, inner_base, inner_base + 21
		])
		
		# Top surface
		var top_base = i * 20 + 4
		indices.append_array([
			top_base, top_base + 20, top_base + 21,
			top_base, top_base + 21, top_base + 1,
			# Back faces
			top_base + 20, top_base, top_base + 21,
			top_base + 21, top_base, top_base + 1
		])
		
		# Bottom surface
		var bottom_base = i * 20 + 6
		indices.append_array([
			bottom_base, bottom_base + 21, bottom_base + 20,
			bottom_base, bottom_base + 1, bottom_base + 21,
			# Back faces
			bottom_base + 21, bottom_base, bottom_base + 20,
			bottom_base + 1, bottom_base, bottom_base + 21
		])
		
		# FLIPPED: BOTTOM LIP (on outer wall):
		# Bottom lip outer vertical
		var bottom_lip_outer_base = i * 20 + 8
		indices.append_array([
			bottom_lip_outer_base, bottom_lip_outer_base + 1, bottom_lip_outer_base + 21,
			bottom_lip_outer_base, bottom_lip_outer_base + 21, bottom_lip_outer_base + 20,
			# Back faces
			bottom_lip_outer_base + 1, bottom_lip_outer_base, bottom_lip_outer_base + 21,
			bottom_lip_outer_base + 21, bottom_lip_outer_base, bottom_lip_outer_base + 20
		])
		
		# Bottom lip top flat
		var bottom_lip_top_base = i * 20 + 10
		indices.append_array([
			bottom_lip_top_base, bottom_lip_top_base + 20, bottom_lip_top_base + 21,
			bottom_lip_top_base, bottom_lip_top_base + 21, bottom_lip_top_base + 1,
			# Back faces
			bottom_lip_top_base + 20, bottom_lip_top_base, bottom_lip_top_base + 21,
			bottom_lip_top_base + 21, bottom_lip_top_base, bottom_lip_top_base + 1
		])
		
		# Bottom lip inner vertical
		var bottom_lip_inner_base = i * 20 + 12
		indices.append_array([
			bottom_lip_inner_base, bottom_lip_inner_base + 1, bottom_lip_inner_base + 21,
			bottom_lip_inner_base, bottom_lip_inner_base + 21, bottom_lip_inner_base + 20,
			# Back faces
			bottom_lip_inner_base + 1, bottom_lip_inner_base, bottom_lip_inner_base + 21,
			bottom_lip_inner_base + 21, bottom_lip_inner_base, bottom_lip_inner_base + 20
		])
		
		# FLIPPED: TOP LIP (on inner wall):
		# Top lip outer vertical
		var top_lip_outer_base = i * 20 + 14
		indices.append_array([
			top_lip_outer_base, top_lip_outer_base + 21, top_lip_outer_base + 1,
			top_lip_outer_base, top_lip_outer_base + 20, top_lip_outer_base + 21,
			# Back faces
			top_lip_outer_base + 21, top_lip_outer_base, top_lip_outer_base + 1,
			top_lip_outer_base + 20, top_lip_outer_base, top_lip_outer_base + 21
		])
		
		# Top lip bottom flat
		var top_lip_bottom_base = i * 20 + 16
		indices.append_array([
			top_lip_bottom_base, top_lip_bottom_base + 20, top_lip_bottom_base + 21,
			top_lip_bottom_base, top_lip_bottom_base + 21, top_lip_bottom_base + 1,
			# Back faces
			top_lip_bottom_base + 20, top_lip_bottom_base, top_lip_bottom_base + 21,
			top_lip_bottom_base + 21, top_lip_bottom_base, top_lip_bottom_base + 1
		])
		
		# Top lip inner vertical
		var top_lip_inner_base = i * 20 + 18
		indices.append_array([
			top_lip_inner_base, top_lip_inner_base + 1, top_lip_inner_base + 21,
			top_lip_inner_base, top_lip_inner_base + 21, top_lip_inner_base + 20,
			# Back faces
			top_lip_inner_base + 1, top_lip_inner_base, top_lip_inner_base + 21,
			top_lip_inner_base + 21, top_lip_inner_base, top_lip_inner_base + 20
		])
	
	# Add end caps for the main body with improved UVs
	if segments > 0:
		# Left side
		vertices.append_array([
			vertices[0], vertices[2],  # outer_top, middle_top
			vertices[1], vertices[3]   # outer_bottom, middle_bottom
		])
		
		# For left end cap, normal points left (negative X)
		var left_normal = Vector3(-1, 0, 0)
		normals.append_array([left_normal, left_normal, left_normal, left_normal])
		
		# Scale-aware UVs for end cap - use consistent mapping with the rest of the mesh
		uvs.append_array([
			Vector2(0.8, 0.2), Vector2(1.0, 0.2),
			Vector2(0.8, 0.4), Vector2(1.0, 0.4)
		])
		
		var left_base = vertices.size() - 4
		indices.append_array([
			left_base, left_base + 1, left_base + 3,
			left_base, left_base + 3, left_base + 2,
			# Back faces
			left_base + 1, left_base, left_base + 3,
			left_base + 3, left_base, left_base + 2
		])
		
		# Right side
		var last = segments * 20
		vertices.append_array([
			vertices[last], vertices[last + 2],  # outer_top, middle_top
			vertices[last + 1], vertices[last + 3]   # outer_bottom, middle_bottom
		])
		
		# For right end cap, normal points right (positive X)
		var right_normal = Vector3(1, 0, 0)
		normals.append_array([right_normal, right_normal, right_normal, right_normal])
		
		# Scale-aware UVs for end cap - use consistent mapping with the rest of the mesh
		uvs.append_array([
			Vector2(0.8, 0.6), Vector2(1.0, 0.6),
			Vector2(0.8, 0.8), Vector2(1.0, 0.8)
		])
		
		var right_base = vertices.size() - 4
		indices.append_array([
			right_base, right_base + 3, right_base + 1,
			right_base, right_base + 2, right_base + 3,
			# Back faces
			right_base + 3, right_base, right_base + 1,
			right_base + 2, right_base, right_base + 3
		])
	
	# FLIPPED: Add end caps specifically for the BOTTOM lip with improved UVs
	if segments > 0:
		# Left bottom lip end cap
		vertices.append_array([
			vertices[8],  # lip_bottom left
			vertices[9],  # lip_middle_outer left
			vertices[11], # lip_middle_inner left
			vertices[1]   # outer_bottom left (connects to lip)
		])
		
		# For the left cap, normal points to the left (negative X direction)
		var left_normal = Vector3(-1, 0, 0)
		normals.append_array([
			left_normal, left_normal, 
			left_normal, left_normal
		])
		
		# Scale-aware UVs for lip end caps - consistent with the rest of the mesh
		uvs.append_array([
			Vector2(0.0, 0.8), Vector2(0.0, 1.0),
			Vector2(0.2, 1.0), Vector2(0.2, 0.8)
		])
		
		var lip_left_base = vertices.size() - 4
		indices.append_array([
			lip_left_base, lip_left_base + 1, lip_left_base + 2,
			lip_left_base, lip_left_base + 2, lip_left_base + 3,
			# Back faces
			lip_left_base + 1, lip_left_base, lip_left_base + 2,
			lip_left_base + 2, lip_left_base, lip_left_base + 3
		])
		
		# Right bottom lip end cap
		var last_lip = segments * 20
		vertices.append_array([
			vertices[last_lip + 8],  # bottom_lip_bottom right
			vertices[last_lip + 9],  # bottom_lip_middle_outer right
			vertices[last_lip + 11], # bottom_lip_middle_inner right
			vertices[last_lip + 1]   # outer_bottom right (connects to lip)
		])
		
		# For the right cap, normal points to the right (positive X direction) 
		var right_normal = Vector3(1, 0, 0)
		normals.append_array([
			right_normal, right_normal, 
			right_normal, right_normal
		])
		
		# Scale-aware UVs for lip end caps - consistent with the rest of the mesh
		uvs.append_array([
			Vector2(0.4, 0.8), Vector2(0.4, 1.0),
			Vector2(0.6, 1.0), Vector2(0.6, 0.8)
		])
		
		var lip_right_base = vertices.size() - 4
		indices.append_array([
			lip_right_base, lip_right_base + 2, lip_right_base + 1,
			lip_right_base, lip_right_base + 3, lip_right_base + 2,
			# Back faces
			lip_right_base + 2, lip_right_base, lip_right_base + 1,
			lip_right_base + 3, lip_right_base, lip_right_base + 2
		])
		
		# FLIPPED: Add end caps specifically for the TOP lip with improved UVs
		# Left top lip end cap
		vertices.append_array([
			vertices[14],  # top_middle left
			vertices[15],  # top_lip_middle_outer left
			vertices[17], # top_lip_top left
			vertices[2]   # middle_top left (connects to top lip)
		])
		
		# For the left cap, normal points to the left (negative X direction)
		left_normal = Vector3(-1, 0, 0)
		normals.append_array([
			left_normal, left_normal, 
			left_normal, left_normal
		])
		
		# Scale-aware UVs for top lip end caps
		uvs.append_array([
			Vector2(0.0, 0.0), Vector2(0.0, 0.2),
			Vector2(0.2, 0.2), Vector2(0.2, 0.0)
		])
		
		var top_lip_left_base = vertices.size() - 4
		indices.append_array([
			top_lip_left_base, top_lip_left_base + 1, top_lip_left_base + 2,
			top_lip_left_base, top_lip_left_base + 2, top_lip_left_base + 3,
			# Back faces
			top_lip_left_base + 1, top_lip_left_base, top_lip_left_base + 2,
			top_lip_left_base + 2, top_lip_left_base, top_lip_left_base + 3
		])
		
		# Right top lip end cap
		vertices.append_array([
			vertices[last_lip + 14],  # top_middle right
			vertices[last_lip + 15],  # top_lip_middle_outer right
			vertices[last_lip + 17], # top_lip_top right
			vertices[last_lip + 2]   # middle_top right (connects to top lip)
		])
		
		# For the right cap, normal points to the right (positive X direction) 
		right_normal = Vector3(1, 0, 0)
		normals.append_array([
			right_normal, right_normal, 
			right_normal, right_normal
		])
		
		# Scale-aware UVs for top lip end caps
		uvs.append_array([
			Vector2(0.4, 0.0), Vector2(0.4, 0.2),
			Vector2(0.6, 0.2), Vector2(0.6, 0.0)
		])
		
		var top_lip_right_base = vertices.size() - 4
		indices.append_array([
			top_lip_right_base, top_lip_right_base + 2, top_lip_right_base + 1,
			top_lip_right_base, top_lip_right_base + 3, top_lip_right_base + 2,
			# Back faces
			top_lip_right_base + 2, top_lip_right_base, top_lip_right_base + 1,
			top_lip_right_base + 3, top_lip_right_base, top_lip_right_base + 2
		])
	
	# Create the single surface
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices
	
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	mesh.surface_set_material(0, inner_shader_material)
	
	inner_mesh_instance.mesh = mesh
	_setup_collision_shape(inner_mesh_instance, true)
func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		on_scale_changed()

func on_scale_changed() -> void:
	if size.x != _prev_scale_x:
		_prev_scale_x = size.x
		_update_material_scale()
		update_mesh()  # Only update mesh when scale changes significantly

func _update_material_scale() -> void:
	if shader_material and inner_shader_material:
		# Calculate the material scale parameters
		var angle_portion = guard_angle / 360.0
		var avg_radius: float = size.x * BASE_OUTER_RADIUS
		var guard_length: float = 2.0 * PI * avg_radius * angle_portion
		var guard_scale: float = guard_length / (PI * 1.0)  # Base length normalization
		
		# Update shader parameters for outer guard
		shader_material.set_shader_parameter("Scale", size.x)
		shader_material.set_shader_parameter("Scale2", size.y)
		shader_material.set_shader_parameter("EdgeScale", guard_scale * 1.2)
		
		# Update shader parameters for inner guard - use same scale as outer but adjust for smaller size
		inner_shader_material.set_shader_parameter("Scale", size.x)
		inner_shader_material.set_shader_parameter("Scale2", size.y)
		inner_shader_material.set_shader_parameter("EdgeScale", guard_scale * 1.2)
func _setup_collision_shape(mesh_instance_node: MeshInstance3D, is_inner: bool = false) -> void:
	# Create or get StaticBody3D
	var static_body: StaticBody3D = mesh_instance_node.get_node_or_null("StaticBody3D") as StaticBody3D
	if not static_body:
		static_body = StaticBody3D.new()
		static_body.name = "StaticBody3D"
		mesh_instance_node.add_child(static_body)
		static_body.owner = get_tree().edited_scene_root if Engine.is_editor_hint() else self
	
	# Create or get CollisionShape3D
	var collision_shape: CollisionShape3D = static_body.get_node_or_null("CollisionShape3D") as CollisionShape3D
	if not collision_shape:
		collision_shape = CollisionShape3D.new()
		collision_shape.name = "CollisionShape3D"
		static_body.add_child(collision_shape)
		collision_shape.owner = get_tree().edited_scene_root if Engine.is_editor_hint() else self
	
	# Get mesh data
	var mesh: ArrayMesh = mesh_instance_node.mesh
	if not mesh:
		return
	
	# Combine all surfaces for collision
	var all_verts: PackedVector3Array = PackedVector3Array()
	var all_indices: PackedInt32Array = PackedInt32Array()
	
	for surface_idx in range(mesh.get_surface_count()):
		var surface = mesh.surface_get_arrays(surface_idx)
		var base_index = all_verts.size()
		all_verts.append_array(surface[Mesh.ARRAY_VERTEX])
		
		for i in surface[Mesh.ARRAY_INDEX]:
			all_indices.append(base_index + i)
	
	# Create triangle vertices
	var triangle_verts: PackedVector3Array = PackedVector3Array()
	for i in range(0, all_indices.size(), 3):
		if i + 2 >= all_indices.size():
			break
		triangle_verts.append_array([
			all_verts[all_indices[i]],
			all_verts[all_indices[i + 1]],
			all_verts[all_indices[i + 2]]
		])
	
	# Scale vertices if needed (inner guard is smaller)
	var scaled_verts = PackedVector3Array()
	for vert in triangle_verts:
		scaled_verts.append(Vector3(vert.x * 1.0, vert.y * 1.0, vert.z * 1.0))
	
	# Create and assign shape
	var shape: ConcavePolygonShape3D = ConcavePolygonShape3D.new()
	shape.data = scaled_verts
	collision_shape.shape = shape
