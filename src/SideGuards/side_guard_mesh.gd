@tool
class_name SideGuardMesh
extends RefCounted

## Generates a procedural flat wall sideguard mesh.
##
## Origin is at the bottom center of the wall's outer face.
## Y=0 is the bottom (mounting surface), Y=WALL_HEIGHT is the top.
## Z=0 is the outer face, Z=WALL_THICKNESS is the inner face.

const WALL_HEIGHT: float = 0.30
const WALL_THICKNESS: float = 0.005
const COLLISION_THICKNESS: float = 0.05

static var _metal_texture: Texture2D = preload("res://assets/3DModels/Textures/Metal.png")


## Create a flat wall sideguard mesh.
## [param length] Length along the conveyor X axis.
## [param cap_front] If false, suppresses the front (+X) end cap.
static func create(length: float, cap_front: bool = true) -> ArrayMesh:
	var mesh := ArrayMesh.new()
	var verts := PackedVector3Array()
	var norms := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()

	var half_l := length / 2.0
	var wt := WALL_THICKNESS
	var wh := WALL_HEIGHT

	# Simple flat wall profile.
	# Starts slightly below Y=0 to overlap with the frame flange top surface.
	var y_bottom: float = -ConveyorFrameMesh.FLANGE_THICKNESS

	var profile := [
		Vector2(y_bottom, 0.0),  # 0: bottom-outer
		Vector2(y_bottom, wt),   # 1: bottom-inner
		Vector2(wh, wt),         # 2: top-inner
		Vector2(wh, 0.0),        # 3: top-outer
	]

	# Edge normals. Skip the bottom face (0->1) to avoid z-fighting with frame flange.
	var edge_normals := [
		Vector3.ZERO,        # bottom (0->1) — SKIPPED
		Vector3(0, 0, 1),    # inner wall (1->2)
		Vector3(0, 1, 0),    # top (2->3)
		Vector3(0, 0, -1),   # outer wall (3->0)
	]

	# Extrude profile along X, skipping the bottom face.
	for i in range(profile.size()):
		if edge_normals[i] == Vector3.ZERO:
			continue
		var j := (i + 1) % profile.size()
		var p0: Vector2 = profile[i]
		var p1: Vector2 = profile[j]
		var n: Vector3 = edge_normals[i]

		var v0 := Vector3(half_l, p0.x, p0.y)
		var v1 := Vector3(half_l, p1.x, p1.y)
		var v2 := Vector3(-half_l, p1.x, p1.y)
		var v3 := Vector3(-half_l, p0.x, p0.y)

		var edge_len: float = p0.distance_to(p1)

		var base := verts.size()
		verts.append_array([v0, v1, v2, v3])
		norms.append_array([n, n, n, n])
		uvs.append_array([
			Vector2(0, 0),
			Vector2(0, edge_len),
			Vector2(length, edge_len),
			Vector2(length, 0),
		])
		indices.append_array([
			base, base + 1, base + 2,
			base, base + 2, base + 3,
		])

	# Front cap (+X)
	if cap_front:
		_add_cap(verts, norms, uvs, indices, profile, half_l, Vector3(1, 0, 0))
	# Back cap (-X)
	_add_cap(verts, norms, uvs, indices, profile, -half_l, Vector3(-1, 0, 0))

	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_NORMAL] = norms
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices

	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh


## Create a sideguard ShaderMaterial (uses MetalShaderSideGuard for sensor beam cutouts).
static func create_material() -> ShaderMaterial:
	var mat := ShaderMaterial.new()
	mat.shader = load("res://assets/3DModels/Shaders/MetalShaderSideGuard.tres")
	mat.set_shader_parameter("metal_texture", _metal_texture)
	mat.set_shader_parameter("Metallic", 0.94)
	mat.set_shader_parameter("Roughness", 0.5)
	mat.set_shader_parameter("Specular", 0.5)
	return mat


static func _add_cap(
	verts: PackedVector3Array,
	norms: PackedVector3Array,
	uvs: PackedVector2Array,
	indices: PackedInt32Array,
	profile: Array,
	x: float,
	normal: Vector3,
) -> void:
	var base := verts.size()
	for p: Vector2 in profile:
		verts.append(Vector3(x, p.x, p.y))
		norms.append(normal)
		uvs.append(Vector2(p.y, p.x))

	# Convex quad — simple two-triangle fan.
	if normal.x > 0:
		indices.append_array([base, base + 2, base + 1, base, base + 3, base + 2])
	else:
		indices.append_array([base, base + 1, base + 2, base, base + 2, base + 3])
	return
