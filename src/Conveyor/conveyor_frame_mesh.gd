@tool
class_name ConveyorFrameMesh
extends RefCounted

## Generates a frame rail mesh with an outward flange at the top for sideguard mounting.
##
## Profile (viewed from +X end, left rail):
##
##          ┌──────────┐  flange top (Y = height + FLANGE_THICKNESS)
##          │  flange  │
##   ┌──────┘          │  Y = height (wall top)
##   │ wall            │
##   │                 │
##   └─────────────────┘  Y = 0 (bottom)
##   Z: -FLANGE_WIDTH  0  WALL_THICKNESS
##
## Z=0 is the wall outer face. Z>0 extends toward belt center.
## Z<0 extends outward (flange).

const WALL_THICKNESS: float = 0.01
const FLANGE_WIDTH: float = 0.02
const FLANGE_THICKNESS: float = 0.005

static var _metal_texture: Texture2D = preload("res://assets/3DModels/Textures/Metal.png")
static var _shared_material: ShaderMaterial


## Create a frame rail mesh with outward flange.
## [param length] Length along conveyor X axis.
## [param height] Height of the wall (flange sits on top of this).
static func create(length: float, height: float) -> ArrayMesh:
	var mesh := ArrayMesh.new()
	var verts := PackedVector3Array()
	var norms := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()

	var half_l := length / 2.0
	var wt := WALL_THICKNESS
	var fw := FLANGE_WIDTH
	var ft := FLANGE_THICKNESS
	var h := height

	# Profile vertices (Y, Z) — flat wall with outward flange at top only.
	var profile := [
		Vector2(0.0, 0.0),          # 0: bottom-outer
		Vector2(0.0, wt),           # 1: bottom-inner
		Vector2(h, wt),             # 2: wall top inner
		Vector2(h + ft, wt),        # 3: flange top inner
		Vector2(h + ft, -fw),       # 4: flange top outer
		Vector2(h, -fw),            # 5: flange bottom outer
		Vector2(h, 0.0),            # 6: wall top outer
	]

	var edge_normals := [
		Vector3(0, -1, 0),   # bottom (0->1)
		Vector3(0, 0, 1),    # inner wall (1->2)
		Vector3(0, 0, 1),    # inner flange (2->3)
		Vector3(0, 1, 0),    # flange top (3->4)
		Vector3(0, 0, -1),   # flange outer edge (4->5)
		Vector3(0, -1, 0),   # flange underside (5->6)
		Vector3(0, 0, -1),   # outer wall (6->0)
	]

	# Extrude each edge along X.
	for i in range(profile.size()):
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


## Create curved frame plates (inner + outer walls) following an arc.
## [param r_inner] Inner radius of the conveyor.
## [param r_outer] Outer radius of the conveyor.
## [param y_top] Y coordinate of the wall top edge.
## [param y_bottom] Y coordinate of the wall bottom edge.
## [param angle_radians] Arc angle in radians.
## [param segments] Number of arc segments.
## [param scale_factor] XZ scale factor (1.0 for no scaling).
static func create_curved(r_inner: float, r_outer: float, y_top: float, y_bottom: float,
		angle_radians: float, segments: int, scale_factor: float = 1.0) -> ArrayMesh:
	var mesh := ArrayMesh.new()
	var verts := PackedVector3Array()
	var norms := PackedVector3Array()
	var uvs_arr := PackedVector2Array()
	var indices := PackedInt32Array()

	var wt: float = WALL_THICKNESS
	var height: float = absf(y_top - y_bottom)
	var sf: float = scale_factor
	var r_inner_frame: float = r_inner - wt
	var r_outer_frame: float = r_outer + wt

	# Inner wall (faces inward, normal = -radial)
	for i in range(segments + 1):
		var t: float = float(i) / segments
		var angle: float = t * angle_radians
		var sin_a: float = sin(angle)
		var cos_a: float = cos(angle)
		var radial := Vector3(-sin_a, 0, cos_a)

		verts.append(Vector3(-sin_a * r_inner_frame * sf, y_top, cos_a * r_inner_frame * sf))
		norms.append(-radial)
		uvs_arr.append(Vector2(t * r_inner_frame * angle_radians, 0))

		verts.append(Vector3(-sin_a * r_inner_frame * sf, y_bottom, cos_a * r_inner_frame * sf))
		norms.append(-radial)
		uvs_arr.append(Vector2(t * r_inner_frame * angle_radians, height))

	for i in range(segments):
		var idx: int = i * 2
		indices.append_array([idx, idx + 2, idx + 1, idx + 1, idx + 2, idx + 3])

	# Outer wall (faces outward, normal = +radial)
	var outer_base: int = verts.size()
	for i in range(segments + 1):
		var t: float = float(i) / segments
		var angle: float = t * angle_radians
		var sin_a: float = sin(angle)
		var cos_a: float = cos(angle)
		var radial := Vector3(-sin_a, 0, cos_a)

		verts.append(Vector3(-sin_a * r_outer_frame * sf, y_top, cos_a * r_outer_frame * sf))
		norms.append(radial)
		uvs_arr.append(Vector2(t * r_outer_frame * angle_radians, 0))

		verts.append(Vector3(-sin_a * r_outer_frame * sf, y_bottom, cos_a * r_outer_frame * sf))
		norms.append(radial)
		uvs_arr.append(Vector2(t * r_outer_frame * angle_radians, height))

	for i in range(segments):
		var idx: int = outer_base + i * 2
		indices.append_array([idx, idx + 1, idx + 2, idx + 1, idx + 3, idx + 2])

	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_NORMAL] = norms
	arrays[Mesh.ARRAY_TEX_UV] = uvs_arr
	arrays[Mesh.ARRAY_INDEX] = indices
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh


## Add flat side walls at the endpoints of a curved frame arc.
## These close off the inner/outer gap at each end of the arc (where rollers or belt ends sit).
## [param mesh] The ArrayMesh to add the side wall surface to.
## [param r_inner] Inner conveyor radius.
## [param r_outer] Outer conveyor radius.
## [param y_top] Y coordinate of the wall top.
## [param y_bottom] Y coordinate of the wall bottom.
## [param angle_radians] Arc angle in radians.
## [param tangent_extent] How far the side wall extends along the tangent direction.
## [param scale_factor] XZ scale factor.
## [param material] Material to apply to the surface.
static func add_curved_end_walls(mesh: ArrayMesh, r_inner: float, r_outer: float,
		y_top: float, y_bottom: float, angle_radians: float,
		tangent_extent: float, scale_factor: float, material: Material) -> void:
	var wt: float = WALL_THICKNESS
	var sf: float = scale_factor
	var r_inner_frame: float = r_inner - wt
	var r_outer_frame: float = r_outer + wt
	var wall_h_uv: float = absf(y_top - y_bottom)

	var verts := PackedVector3Array()
	var norms := PackedVector3Array()
	var uvs_arr := PackedVector2Array()
	var indices := PackedInt32Array()

	for end_data in [[0.0, -1.0], [angle_radians, 1.0]]:
		var ea: float = end_data[0]
		var ts: float = end_data[1]
		var sa_e: float = sin(ea)
		var ca_e: float = cos(ea)
		var tang := Vector3(-ca_e, 0, -sa_e) * ts
		var rad := Vector3(-sa_e, 0, ca_e)
		var max_tang_xz := tang * tangent_extent

		for side_sign in [-1.0, 1.0]:
			var side_normal: Vector3 = rad * side_sign
			var r_edge: float = r_outer_frame if side_sign > 0 else r_inner_frame
			var edge_xz := Vector3(-sa_e * r_edge, 0, ca_e * r_edge)
			var arc_xz: Vector3 = edge_xz * sf
			var ext_xz: Vector3 = (edge_xz + max_tang_xz) * sf

			var wall_w: float = tangent_extent * sf * 0.5
			var sb: int = verts.size()
			verts.append(Vector3(arc_xz.x, y_top, arc_xz.z))
			verts.append(Vector3(arc_xz.x, y_bottom, arc_xz.z))
			verts.append(Vector3(ext_xz.x, y_top, ext_xz.z))
			verts.append(Vector3(ext_xz.x, y_bottom, ext_xz.z))
			norms.append(side_normal); uvs_arr.append(Vector2(0, 0))
			norms.append(side_normal); uvs_arr.append(Vector2(0, wall_h_uv))
			norms.append(side_normal); uvs_arr.append(Vector2(wall_w, 0))
			norms.append(side_normal); uvs_arr.append(Vector2(wall_w, wall_h_uv))
			indices.append_array([
				sb, sb + 2, sb + 1, sb + 1, sb + 2, sb + 3,
			])

	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_NORMAL] = norms
	arrays[Mesh.ARRAY_TEX_UV] = uvs_arr
	arrays[Mesh.ARRAY_INDEX] = indices
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	mesh.surface_set_material(mesh.get_surface_count() - 1, material)


## Create a metal ShaderMaterial for frame meshes.
static func create_material() -> ShaderMaterial:
	if _shared_material:
		return _shared_material
	_shared_material = ShaderMaterial.new()
	_shared_material.shader = preload("res://src/Conveyor/conveyor_frame_shader.gdshader")
	_shared_material.set_shader_parameter("metal_texture", _metal_texture)
	return _shared_material


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

	# Concave L-shape: manual triangulation.
	# Wall quad (0,1,2,6) + Flange (6,2,3,4,5)
	var tris: Array[int]
	if normal.x > 0:
		tris = [
			0, 2, 1,  0, 6, 2,  # wall
			6, 3, 2,  6, 4, 3,  # flange inner
			6, 5, 4,             # flange outer triangle
		]
	else:
		tris = [
			0, 1, 2,  0, 2, 6,  # wall
			6, 2, 3,  6, 3, 4,  # flange inner
			6, 4, 5,             # flange outer triangle
		]
	for idx: int in tris:
		indices.append(base + idx)


## Create a flat arc mesh used as a shadow-only plate beneath curved conveyors.
## [param angle_radians] Arc sweep angle.
## [param r_inner] Inner radius.
## [param r_outer] Outer radius.
## [param segments] Number of arc segments.
static func create_arc_shadow_mesh(angle_radians: float, r_inner: float, r_outer: float, segments: int) -> ArrayMesh:
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)

	for i in range(segments):
		var t0: float = float(i) / segments * angle_radians
		var t1: float = float(i + 1) / segments * angle_radians

		var inner0 := Vector3(-sin(t0) * r_inner, 0, cos(t0) * r_inner)
		var inner1 := Vector3(-sin(t1) * r_inner, 0, cos(t1) * r_inner)
		var outer0 := Vector3(-sin(t0) * r_outer, 0, cos(t0) * r_outer)
		var outer1 := Vector3(-sin(t1) * r_outer, 0, cos(t1) * r_outer)

		st.add_vertex(inner0); st.add_vertex(outer0); st.add_vertex(outer1)
		st.add_vertex(inner0); st.add_vertex(outer1); st.add_vertex(inner1)

	st.generate_normals()
	return st.commit()
