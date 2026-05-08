@tool
class_name ConveyorFrameMesh
extends RefCounted

## L-profile frame rail mesh (wall + outward flange at top). Z=0 is the wall outer face;
## +Z toward belt center, -Z outward to the flange.

const WALL_THICKNESS: float = 0.01
const FLANGE_WIDTH: float = 0.02
const FLANGE_THICKNESS: float = 0.005

static var _metal_texture: Texture2D = preload("res://assets/3DModels/Textures/Metal.png")
static var _shared_material: ShaderMaterial


## Disable a cap when a bend rail abuts the end (avoids z-fighting).
static func create(length: float, height: float,
		cap_front: bool = true, cap_back: bool = true) -> ArrayMesh:
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

	var profile := [
		Vector2(0.0, 0.0),
		Vector2(0.0, wt),
		Vector2(h, wt),
		Vector2(h + ft, wt),
		Vector2(h + ft, -fw),
		Vector2(h, -fw),
		Vector2(h, 0.0),
	]

	var edge_normals := [
		Vector3(0, -1, 0),
		Vector3(0, 0, 1),
		Vector3(0, 0, 1),
		Vector3(0, 1, 0),
		Vector3(0, 0, -1),
		Vector3(0, -1, 0),
		Vector3(0, 0, -1),
	]

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

	if cap_front:
		_add_cap(verts, norms, uvs, indices, profile, half_l, Vector3(1, 0, 0))
	if cap_back:
		_add_cap(verts, norms, uvs, indices, profile, -half_l, Vector3(-1, 0, 0))

	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_NORMAL] = norms
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices

	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh


## Curved frame plates (inner + outer walls) following an arc.
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


## Close the inner/outer gap at each end of a curved frame arc.
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

	for end_data: Array in [[0.0, -1.0], [angle_radians, 1.0]]:
		var ea: float = end_data[0]
		var ts: float = end_data[1]
		var sa_e: float = sin(ea)
		var ca_e: float = cos(ea)
		var tang := Vector3(-ca_e, 0, -sa_e) * ts
		var rad := Vector3(-sa_e, 0, ca_e)
		var max_tang_xz := tang * tangent_extent

		for side_sign: float in [-1.0, 1.0]:
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


## Continuous L-profile rail extruded along the entire path (runs + arcs).
## `side_sign` -1 = left (-Z), +1 = right. Overhangs typically `height/2` to cover end pulleys.
static func create_along_path(path: BeltPath, height: float, width: float,
		side_sign: float,
		head_overhang: float = 0.0, tail_overhang: float = 0.0,
		arc_segments: int = 8) -> ArrayMesh:
	var mesh := ArrayMesh.new()
	if path == null or path.runs.is_empty() or height <= 0.0 or width <= 0.0:
		return mesh

	var wt: float = WALL_THICKNESS
	var fw: float = FLANGE_WIDTH
	var ft: float = FLANGE_THICKNESS
	var h: float = height
	var half_w: float = width * 0.5

	var profile: Array = [
		Vector2(0.0, 0.0),
		Vector2(0.0, wt),
		Vector2(h, wt),
		Vector2(h + ft, wt),
		Vector2(h + ft, -fw),
		Vector2(h, -fw),
		Vector2(h, 0.0),
	]
	var edge_normals_2d: Array = [
		Vector2(-1, 0),
		Vector2(0, 1),
		Vector2(0, 1),
		Vector2(1, 0),
		Vector2(0, -1),
		Vector2(-1, 0),
		Vector2(0, -1),
	]

	var samples_pos := PackedVector3Array()
	var samples_tan := PackedVector3Array()
	var samples_norm := PackedVector3Array()
	var samples_s := PackedFloat32Array()
	var cross_axis := Vector3(0, 0, 1)

	var first_xf: Transform3D = path.start_transform()
	var s_acc: float = 0.0
	if tail_overhang > 0.0:
		samples_pos.append(first_xf.origin - first_xf.basis.x * tail_overhang)
		samples_tan.append(first_xf.basis.x)
		samples_norm.append(first_xf.basis.y)
		samples_s.append(0.0)
		s_acc = tail_overhang
	samples_pos.append(first_xf.origin)
	samples_tan.append(first_xf.basis.x)
	samples_norm.append(first_xf.basis.y)
	samples_s.append(s_acc)
	for i in range(path.runs.size()):
		var run: BeltPath.Run = path.runs[i]
		var run_len: float = maxf(0.0, run.effective_length)
		s_acc += run_len
		samples_pos.append(run.start_xform * Vector3(run_len, 0, 0))
		samples_tan.append(run.start_xform.basis.x)
		samples_norm.append(run.start_xform.basis.y)
		samples_s.append(s_acc)
		if i < path.joints.size():
			var jt: BeltPath.Joint = path.joints[i]
			# Skip collinear joints — signf(0) would zero the normal and collapse the strip.
			if absf(jt.turning_angle) < 1.0e-4:
				continue
			var sign_turn: float = signf(jt.turning_angle)
			for k in range(1, arc_segments + 1):
				var t: float = float(k) / arc_segments
				var theta: float = t * jt.turning_angle
				var rot := Basis(cross_axis, theta)
				var arc_top: Vector3 = jt.center + rot * (jt.tangent_point_in - jt.center)
				var arc_tan: Vector3 = (rot * jt.tangent_in).normalized()
				var arc_norm: Vector3 = (sign_turn * (jt.center - arc_top) / maxf(jt.radius, 1.0e-9)).normalized()
				samples_pos.append(arc_top)
				samples_tan.append(arc_tan)
				samples_norm.append(arc_norm)
				samples_s.append(jt.s_at_arc_start + t * jt.arc_length)
			s_acc = jt.s_at_arc_start + jt.arc_length
	if head_overhang > 0.0:
		var last_xf: Transform3D = path.end_transform()
		samples_pos.append(last_xf.origin + last_xf.basis.x * head_overhang)
		samples_tan.append(last_xf.basis.x)
		samples_norm.append(last_xf.basis.y)
		samples_s.append(s_acc + head_overhang)

	var sample_count: int = samples_pos.size()
	if sample_count < 2:
		return mesh

	var verts := PackedVector3Array()
	var norms := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()
	var reverse_winding: bool = side_sign > 0.0

	for s_idx in range(sample_count - 1):
		var sa_idx: int = s_idx + 1
		var sb_idx: int = s_idx
		var sa_pos: Vector3 = samples_pos[sa_idx]
		var sb_pos: Vector3 = samples_pos[sb_idx]
		var sa_norm: Vector3 = samples_norm[sa_idx]
		var sb_norm: Vector3 = samples_norm[sb_idx]
		var u_a: float = samples_s[sa_idx]
		var u_b: float = samples_s[sb_idx]
		for i in range(profile.size()):
			var j: int = (i + 1) % profile.size()
			var p_i: Vector2 = profile[i]
			var p_j: Vector2 = profile[j]
			var v0: Vector3 = _path_frame_vertex(sa_pos, sa_norm, p_i, h, half_w, wt, side_sign, cross_axis)
			var v1: Vector3 = _path_frame_vertex(sa_pos, sa_norm, p_j, h, half_w, wt, side_sign, cross_axis)
			var v2: Vector3 = _path_frame_vertex(sb_pos, sb_norm, p_j, h, half_w, wt, side_sign, cross_axis)
			var v3: Vector3 = _path_frame_vertex(sb_pos, sb_norm, p_i, h, half_w, wt, side_sign, cross_axis)
			var en: Vector2 = edge_normals_2d[i]
			var n_a: Vector3 = (sa_norm * en.x + cross_axis * (-side_sign * en.y)).normalized()
			var n_b: Vector3 = (sb_norm * en.x + cross_axis * (-side_sign * en.y)).normalized()
			var edge_len: float = p_i.distance_to(p_j)
			var base: int = verts.size()
			verts.append_array([v0, v1, v2, v3])
			norms.append_array([n_a, n_a, n_b, n_b])
			uvs.append_array([
				Vector2(0, u_a),
				Vector2(edge_len, u_a),
				Vector2(edge_len, u_b),
				Vector2(0, u_b),
			])
			if reverse_winding:
				indices.append_array([
					base, base + 2, base + 1,
					base, base + 3, base + 2,
				])
			else:
				indices.append_array([
					base, base + 1, base + 2,
					base, base + 2, base + 3,
				])

	_add_path_frame_cap(verts, norms, uvs, indices, profile,
			samples_pos[0], samples_norm[0], samples_tan[0],
			h, half_w, wt, side_sign, cross_axis, false)
	_add_path_frame_cap(verts, norms, uvs, indices, profile,
			samples_pos[sample_count - 1], samples_norm[sample_count - 1], samples_tan[sample_count - 1],
			h, half_w, wt, side_sign, cross_axis, true)

	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_NORMAL] = norms
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh


static func _path_frame_vertex(top: Vector3, normal: Vector3, p: Vector2,
		h: float, half_w: float, wt: float, side_sign: float, cross_axis: Vector3) -> Vector3:
	return top + normal * (p.x - h) + cross_axis * (side_sign * (half_w + wt - p.y))


static func _add_path_frame_cap(verts: PackedVector3Array, norms: PackedVector3Array,
		uvs: PackedVector2Array, indices: PackedInt32Array, profile: Array,
		top: Vector3, normal: Vector3, tangent: Vector3,
		h: float, half_w: float, wt: float, side_sign: float, cross_axis: Vector3,
		is_end_cap: bool) -> void:
	var sign_dir: float = 1.0 if is_end_cap else -1.0
	var cap_normal: Vector3 = tangent * sign_dir
	var base: int = verts.size()
	for p: Vector2 in profile:
		verts.append(top + normal * (p.x - h) + cross_axis * (side_sign * (half_w + wt - p.y)))
		norms.append(cap_normal)
		uvs.append(Vector2(p.y, p.x))
	var use_front_winding: bool = (side_sign < 0.0) == is_end_cap
	var tris: Array
	if use_front_winding:
		tris = [0, 2, 1, 0, 6, 2, 6, 3, 2, 6, 4, 3, 6, 5, 4]
	else:
		tris = [0, 1, 2, 0, 2, 6, 6, 2, 3, 6, 3, 4, 6, 4, 5]
	for idx: int in tris:
		indices.append(base + idx)


## L-profile rail extruded along a vertical bend arc. `side_sign` -1 = left, +1 = right.
static func create_bend_rail(joint: BeltPath.Joint, height: float, width: float,
		side_sign: float, segments: int = 8) -> ArrayMesh:
	var mesh := ArrayMesh.new()
	if joint == null:
		return mesh
	var radius: float = joint.radius
	var turning_angle: float = joint.turning_angle
	if radius <= 0.0 or absf(turning_angle) <= 1.0e-4 or segments < 1:
		return mesh

	var wt: float = WALL_THICKNESS
	var fw: float = FLANGE_WIDTH
	var ft: float = FLANGE_THICKNESS
	var h: float = height
	var half_w: float = width * 0.5

	var profile: Array = [
		Vector2(0.0, 0.0),
		Vector2(0.0, wt),
		Vector2(h, wt),
		Vector2(h + ft, wt),
		Vector2(h + ft, -fw),
		Vector2(h, -fw),
		Vector2(h, 0.0),
	]
	var edge_normals_2d: Array = [
		Vector2(-1, 0),
		Vector2(0, 1),
		Vector2(0, 1),
		Vector2(1, 0),
		Vector2(0, -1),
		Vector2(-1, 0),
		Vector2(0, -1),
	]

	var verts := PackedVector3Array()
	var norms := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()

	var sign_turn: float = signf(turning_angle)
	var cross_axis := Vector3(0, 0, 1)
	var arc_len: float = radius * absf(turning_angle)
	var sample_count: int = segments + 1

	# Wall-extrusion direction lerps between endpoint normals so tight bends
	# with h > r don't wrap the wall through the bend center.
	var sample_top := PackedVector3Array()
	var sample_normal := PackedVector3Array()
	sample_top.resize(sample_count)
	sample_normal.resize(sample_count)
	var n_start: Vector3 = (sign_turn * (joint.center - joint.tangent_point_in) / maxf(radius, 1.0e-9)).normalized()
	var n_end: Vector3 = (sign_turn * (joint.center - joint.tangent_point_out) / maxf(radius, 1.0e-9)).normalized()
	for k in range(sample_count):
		var t: float = float(k) / segments
		var theta: float = t * turning_angle
		var rot := Basis(cross_axis, theta)
		var top_pos: Vector3 = joint.center + rot * (joint.tangent_point_in - joint.center)
		sample_top[k] = top_pos
		sample_normal[k] = n_start.lerp(n_end, t).normalized()

	var reverse_winding: bool = side_sign > 0.0

	for s in range(segments):
		var sa: int = s + 1
		var sb: int = s
		var u_a: float = (float(sa) / segments) * arc_len
		var u_b: float = (float(sb) / segments) * arc_len
		for i in range(profile.size()):
			var j: int = (i + 1) % profile.size()
			var p_i: Vector2 = profile[i]
			var p_j: Vector2 = profile[j]
			var v0: Vector3 = _bend_vertex(sample_top[sa], sample_normal[sa], p_i, h, half_w, wt, side_sign, cross_axis)
			var v1: Vector3 = _bend_vertex(sample_top[sa], sample_normal[sa], p_j, h, half_w, wt, side_sign, cross_axis)
			var v2: Vector3 = _bend_vertex(sample_top[sb], sample_normal[sb], p_j, h, half_w, wt, side_sign, cross_axis)
			var v3: Vector3 = _bend_vertex(sample_top[sb], sample_normal[sb], p_i, h, half_w, wt, side_sign, cross_axis)
			var en: Vector2 = edge_normals_2d[i]
			var n_a: Vector3 = (sample_normal[sa] * en.x + cross_axis * (-side_sign * en.y)).normalized()
			var n_b: Vector3 = (sample_normal[sb] * en.x + cross_axis * (-side_sign * en.y)).normalized()
			var edge_len: float = p_i.distance_to(p_j)
			var base: int = verts.size()
			verts.append_array([v0, v1, v2, v3])
			norms.append_array([n_a, n_a, n_b, n_b])
			uvs.append_array([
				Vector2(0, u_a),
				Vector2(edge_len, u_a),
				Vector2(edge_len, u_b),
				Vector2(0, u_b),
			])
			if reverse_winding:
				indices.append_array([
					base, base + 2, base + 1,
					base, base + 3, base + 2,
				])
			else:
				indices.append_array([
					base, base + 1, base + 2,
					base, base + 2, base + 3,
				])

	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_NORMAL] = norms
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh


static func _bend_vertex(top: Vector3, normal: Vector3, p: Vector2,
		h: float, half_w: float, wt: float, side_sign: float, cross_axis: Vector3) -> Vector3:
	return top + normal * (p.x - h) + cross_axis * (side_sign * (half_w + wt - p.y))


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

	# Concave L: manual triangulation (wall quad + flange).
	var tris: Array[int]
	if normal.x > 0:
		tris = [
			0, 2, 1,  0, 6, 2,
			6, 3, 2,  6, 4, 3,
			6, 5, 4,
		]
	else:
		tris = [
			0, 1, 2,  0, 2, 6,
			6, 2, 3,  6, 3, 4,
			6, 4, 5,
		]
	for idx: int in tris:
		indices.append(base + idx)


## Flat arc shadow-only plate beneath curved conveyors.
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
