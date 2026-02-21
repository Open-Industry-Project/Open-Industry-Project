@tool
class_name PathFollowingSideGuards
extends Node3D

# Base dimensions for guard profile
const BASE_HEIGHT: float = 0.149
const MIDDLE_THICKNESS: float = 0.02
const GUARD_OFFSET: float = 0.09 # Offset from belt edge to prevent Z-fighting
const LIP_WIDTH: float = 0.05
const WALL_THICKNESS: float = 0.02
const TOP_LIP_HEIGHT: float = 0.02

## The conveyor this side guards assembly is attached to.
@export var conveyor: Node3D:
	set(value):
		if conveyor == value:
			return
		if conveyor:
			if conveyor.is_connected("size_changed", _on_conveyor_size_changed):
				conveyor.disconnect("size_changed", _on_conveyor_size_changed)
			if conveyor.has_signal("path_segments_changed") and conveyor.is_connected("path_segments_changed", _on_path_segments_changed):
				conveyor.disconnect("path_segments_changed", _on_path_segments_changed)
		conveyor = value
		if conveyor:
			if not conveyor.is_connected("size_changed", _on_conveyor_size_changed):
				conveyor.connect("size_changed", _on_conveyor_size_changed)
			if conveyor.has_signal("path_segments_changed") and not conveyor.is_connected("path_segments_changed", _on_path_segments_changed):
				conveyor.connect("path_segments_changed", _on_path_segments_changed)
		_update_mesh()

## Overall dimensions of the guard (X=unused, Y=height multiplier, Z=unused).
@export var size: Vector3 = Vector3(1.0, 4.0, 1.0):
	set(value):
		if size.is_equal_approx(value):
			return
		size = value
		_update_mesh()

## Show inner side guard end caps (at start of path).
@export var show_inner_end_l: bool = true:
	set(value):
		show_inner_end_l = value
		_update_end_pieces()

## Show outer side guard end caps (at start of path).
@export var show_outer_end_l: bool = true:
	set(value):
		show_outer_end_l = value
		_update_end_pieces()

## Show inner side guard end caps (at end of path).
@export var show_inner_end_r: bool = true:
	set(value):
		show_inner_end_r = value
		_update_end_pieces()

## Show outer side guard end caps (at end of path).
@export var show_outer_end_r: bool = true:
	set(value):
		show_outer_end_r = value
		_update_end_pieces()

@export_group("Wall Visibility")
## Enable/disable the left (outer) wall entirely.
@export var left_wall_enabled: bool = true:
	set(value):
		left_wall_enabled = value
		_update_wall_visibility()

## Enable/disable the right (inner) wall entirely.
@export var right_wall_enabled: bool = true:
	set(value):
		right_wall_enabled = value
		_update_wall_visibility()

const SIDE_GUARD_SHADER: Shader = preload("res://assets/3DModels/Shaders/SideGuardShaderCBC.tres")

var _mesh_update_pending: bool = false
var _outer_guard: MeshInstance3D
var _inner_guard: MeshInstance3D


func _ready() -> void:
	_outer_guard = get_node_or_null("OuterSideGuard")
	_inner_guard = get_node_or_null("InnerSideGuard")

	if not conveyor:
		_try_find_conveyor()

	_update_mesh()


func _try_find_conveyor() -> void:
	if not is_inside_tree():
		return

	var parent = get_parent()
	if parent:
		var conv = parent.get_node_or_null("PathFollowingConveyor")
		if conv:
			conveyor = conv
			return
		if parent.has_method("get") and "path_to_follow" in parent:
			conveyor = parent


func _get_path_3d() -> Path3D:
	if not conveyor:
		return null
	if "path_to_follow" in conveyor:
		return conveyor.path_to_follow
	return null


func _get_path_segments() -> int:
	if conveyor and "path_segments" in conveyor:
		return conveyor.path_segments
	return 20 # Default


func _get_conveyor_width() -> float:
	if conveyor and "conveyor_width" in conveyor:
		return conveyor.conveyor_width
	return 1.524 # Default


func _on_conveyor_size_changed() -> void:
	_update_mesh()


func _on_path_segments_changed() -> void:
	_update_mesh()


func _notification(what: int) -> void:
	if what == NOTIFICATION_PARENTED and not conveyor:
		_try_find_conveyor()


func _update_mesh() -> void:
	if not is_inside_tree():
		_mesh_update_pending = true
		return

	if _mesh_update_pending:
		_mesh_update_pending = false

	var path := _get_path_3d()
	if not path or not path.curve or path.curve.point_count < 2:
		return

	_ensure_guard_nodes()

	var segments := _get_path_segments()
	var conveyor_width := _get_conveyor_width()
	var guard_height := BASE_HEIGHT * size.y

	var path_data := _sample_path(path, segments)

	var outer_offset := conveyor_width / 2.0 + GUARD_OFFSET
	var outer_mesh := _build_guard_mesh(path_data, outer_offset, guard_height, false)
	if _outer_guard:
		_outer_guard.mesh = outer_mesh
		_update_collision_shape(_outer_guard, outer_mesh)

	var inner_offset := - (conveyor_width / 2.0 + GUARD_OFFSET)
	var inner_mesh := _build_guard_mesh(path_data, inner_offset, guard_height, true)
	if _inner_guard:
		_inner_guard.mesh = inner_mesh
		_update_collision_shape(_inner_guard, inner_mesh)

	_update_end_pieces()


func _ensure_guard_nodes() -> void:
	if not _outer_guard:
		_outer_guard = get_node_or_null("OuterSideGuard")
	if not _inner_guard:
		_inner_guard = get_node_or_null("InnerSideGuard")


func _sample_path(path: Path3D, segments: int) -> Array[Dictionary]:
	var curve := path.curve
	var curve_length := curve.get_baked_length()
	var result: Array[Dictionary] = []

	var belt_height_offset := 0.0
	if conveyor and "belt_height" in conveyor:
		belt_height_offset = conveyor.belt_height / 2.0

	for i in range(segments + 1):
		var t := float(i) / float(segments)
		var d := t * curve_length

		var pos_local := curve.sample_baked(d)
		var pos_global := path.to_global(pos_local)
		var pos_assembly := to_local(pos_global)

		pos_assembly.y += belt_height_offset

		var epsilon := 0.01
		var next_d := minf(d + epsilon, curve_length)
		var prev_d := maxf(d - epsilon, 0.0)

		var next_pos_local := curve.sample_baked(next_d)
		var prev_pos_local := curve.sample_baked(prev_d)
		var next_pos_global := path.to_global(next_pos_local)
		var prev_pos_global := path.to_global(prev_pos_local)
		var next_pos_assembly := to_local(next_pos_global)
		var prev_pos_assembly := to_local(prev_pos_global)

		var tangent := (next_pos_assembly - prev_pos_assembly).normalized()
		if tangent.length_squared() < 0.001:
			tangent = Vector3.FORWARD

		var up := Vector3.UP
		var right := tangent.cross(up).normalized()
		if right.length_squared() < 0.001:
			right = Vector3.RIGHT
		up = right.cross(tangent).normalized()

		result.append({
			"position": pos_assembly,
			"tangent": tangent,
			"right": right,
			"up": up,
			"t": t
		})

	return result


## Build guard mesh from path samples
func _build_guard_mesh(path_data: Array[Dictionary], lateral_offset: float, height: float, flip_normals: bool) -> ArrayMesh:
	var vertices := PackedVector3Array()
	var normals := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()

	var num_samples := path_data.size()
	if num_samples < 2:
		return ArrayMesh.new()

	var profile_count := 6

	var path := _get_path_3d()
	var total_uv_length := 1.0
	if path and path.curve:
		total_uv_length = path.curve.get_baked_length()

	for i in range(num_samples):
		var sample: Dictionary = path_data[i]
		var pos: Vector3 = sample["position"]
		var right: Vector3 = sample["right"]
		var up: Vector3 = sample["up"]
		var t: float = sample["t"]

		var base_pos := pos + right * lateral_offset

		var inward := -right if lateral_offset > 0 else right

		var p0 := base_pos
		var p1 := base_pos + inward * LIP_WIDTH
		var p2 := base_pos + inward * LIP_WIDTH + up * 0.02
		var p3 := base_pos + inward * LIP_WIDTH + up * (height - TOP_LIP_HEIGHT)
		var p4 := base_pos + inward * LIP_WIDTH + up * height
		var p5 := base_pos + up * height

		vertices.append_array([p0, p1, p2, p3, p4, p5])

		var outward := right if lateral_offset > 0 else -right
		var n_bottom := -up
		var n_inner := outward
		var n_top := up

		if flip_normals:
			n_inner = - n_inner

		normals.append_array([
			n_bottom,
			n_bottom,
			n_inner,
			n_inner,
			n_top,
			n_top
		])

		# UVs (u = along path, v = around profile)
		var u := t * total_uv_length
		uvs.append_array([
			Vector2(u, 0.0),
			Vector2(u, 0.1),
			Vector2(u, 0.2),
			Vector2(u, 0.8),
			Vector2(u, 0.9),
			Vector2(u, 1.0)
		])

	for i in range(num_samples - 1):
		var base := i * profile_count
		var next_base := (i + 1) * profile_count

		for j in range(profile_count - 1):
			var a := base + j
			var b := base + j + 1
			var c := next_base + j + 1
			var d := next_base + j

			if flip_normals:
				indices.append_array([a, c, b, a, d, c])
			else:
				indices.append_array([a, b, c, a, c, d])

			if flip_normals:
				indices.append_array([a, b, c, a, c, d])
			else:
				indices.append_array([a, c, b, a, d, c])

	_add_end_cap(vertices, normals, uvs, indices, path_data[0], lateral_offset, height, true, flip_normals)
	_add_end_cap(vertices, normals, uvs, indices, path_data[num_samples - 1], lateral_offset, height, false, flip_normals)

	var mesh := ArrayMesh.new()
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices

	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)

	var material := ShaderMaterial.new()
	material.shader = SIDE_GUARD_SHADER
	material.set_shader_parameter("Scale", 4.048)
	material.set_shader_parameter("Metallic", 0.94)
	material.set_shader_parameter("Roughness", 0.5)
	material.set_shader_parameter("Specular", 0.5)
	mesh.surface_set_material(0, material)

	return mesh


## Add end cap geometry
func _add_end_cap(vertices: PackedVector3Array, normals: PackedVector3Array, uvs: PackedVector2Array,
				  indices: PackedInt32Array, sample: Dictionary, lateral_offset: float, height: float,
				  is_start: bool, flip_normals: bool) -> void:
	var pos: Vector3 = sample["position"]
	var tangent: Vector3 = sample["tangent"]
	var right: Vector3 = sample["right"]
	var up: Vector3 = sample["up"]

	var base_pos := pos + right * lateral_offset
	var inward := -right if lateral_offset > 0 else right

	# Profile positions
	var p0 := base_pos
	var p1 := base_pos + inward * LIP_WIDTH
	var p2 := base_pos + inward * LIP_WIDTH + up * 0.02
	var p3 := base_pos + inward * LIP_WIDTH + up * (height - TOP_LIP_HEIGHT)
	var p4 := base_pos + inward * LIP_WIDTH + up * height
	var p5 := base_pos + up * height

	var cap_normal := -tangent if is_start else tangent
	if flip_normals:
		cap_normal = - cap_normal

	var base_idx := vertices.size()

	# Add cap vertices
	vertices.append_array([p0, p1, p2, p3, p4, p5])
	normals.append_array([cap_normal, cap_normal, cap_normal, cap_normal, cap_normal, cap_normal])
	uvs.append_array([
		Vector2(0.0, 0.0), Vector2(0.1, 0.0), Vector2(0.1, 0.1),
		Vector2(0.1, 0.9), Vector2(0.1, 1.0), Vector2(0.0, 1.0)
	])

	# Create triangles for cap (fan from center) - DOUBLE SIDED
	# Front face
	if is_start != flip_normals:
		indices.append_array([base_idx, base_idx + 1, base_idx + 2])
		indices.append_array([base_idx, base_idx + 2, base_idx + 3])
		indices.append_array([base_idx, base_idx + 3, base_idx + 4])
		indices.append_array([base_idx, base_idx + 4, base_idx + 5])
	else:
		indices.append_array([base_idx, base_idx + 2, base_idx + 1])
		indices.append_array([base_idx, base_idx + 3, base_idx + 2])
		indices.append_array([base_idx, base_idx + 4, base_idx + 3])
		indices.append_array([base_idx, base_idx + 5, base_idx + 4])
	# Back face (reversed winding)
	if is_start != flip_normals:
		indices.append_array([base_idx, base_idx + 2, base_idx + 1])
		indices.append_array([base_idx, base_idx + 3, base_idx + 2])
		indices.append_array([base_idx, base_idx + 4, base_idx + 3])
		indices.append_array([base_idx, base_idx + 5, base_idx + 4])
	else:
		indices.append_array([base_idx, base_idx + 1, base_idx + 2])
		indices.append_array([base_idx, base_idx + 2, base_idx + 3])
		indices.append_array([base_idx, base_idx + 3, base_idx + 4])
		indices.append_array([base_idx, base_idx + 4, base_idx + 5])


func _update_collision_shape(guard: MeshInstance3D, mesh: ArrayMesh) -> void:
	if not guard:
		return

	var static_body := guard.get_node_or_null("StaticBody3D")
	if not static_body:
		return

	var collision_shape := static_body.get_node_or_null("CollisionShape3D") as CollisionShape3D
	if not collision_shape:
		return

	var shape := ConcavePolygonShape3D.new()
	var faces := mesh.get_faces()
	if faces.size() > 0:
		shape.set_faces(faces)
		collision_shape.shape = shape


## Updates the position and orientation of end pieces based on path geometry.
func _update_end_pieces() -> void:
	var path := _get_path_3d()
	if not path or not path.curve or path.curve.point_count < 2:
		return

	var curve := path.curve
	var curve_length := curve.get_baked_length()
	var conveyor_width := _get_conveyor_width()
	var guard_offset := conveyor_width / 2.0 + GUARD_OFFSET

	var height_scale := size.y / 3.0

	var belt_height_offset := 0.0
	if conveyor and "belt_height" in conveyor:
		belt_height_offset = conveyor.belt_height / 2.0

	var start_pos_local := curve.sample_baked(0.0)
	var start_pos_global := path.to_global(start_pos_local)
	var start_pos := to_local(start_pos_global)
	start_pos.y += belt_height_offset

	var start_next_local := curve.sample_baked(0.1)
	var start_next_global := path.to_global(start_next_local)
	var start_next := to_local(start_next_global)
	var start_tangent := (start_next - start_pos).normalized()
	if start_tangent.length_squared() < 0.001:
		start_tangent = Vector3.FORWARD

	var end_pos_local := curve.sample_baked(curve_length)
	var end_pos_global := path.to_global(end_pos_local)
	var end_pos := to_local(end_pos_global)
	end_pos.y += belt_height_offset

	var end_prev_local := curve.sample_baked(curve_length - 0.1)
	var end_prev_global := path.to_global(end_prev_local)
	var end_prev := to_local(end_prev_global)
	var end_tangent := (end_pos - end_prev).normalized()
	if end_tangent.length_squared() < 0.001:
		end_tangent = Vector3.FORWARD

	var start_right := start_tangent.cross(Vector3.UP).normalized()
	if start_right.length_squared() < 0.001:
		start_right = Vector3.RIGHT
	var end_right := end_tangent.cross(Vector3.UP).normalized()
	if end_right.length_squared() < 0.001:
		end_right = Vector3.RIGHT

	var inner_end1 := get_node_or_null("InnerSideGuardEnd")
	var outer_end1 := get_node_or_null("OuterSideGuardEnd")
	var inner_end2 := get_node_or_null("InnerSideGuardEnd2")
	var outer_end2 := get_node_or_null("OuterSideGuardEnd2")

	var y_offset := -0.204
	var scale_factor := 1.07 + (conveyor_width - 1.0) * 0.01

	const MESH_Z_OFFSET: float = 1.07

	if outer_end1:
		outer_end1.visible = show_outer_end_l and left_wall_enabled
		if show_outer_end_l and left_wall_enabled:
			var rotation_y := atan2(start_tangent.x, start_tangent.z) + PI / 2.0

			var rot_basis := Basis(Vector3.UP, rotation_y)
			var local_offset := Vector3(0.02, 0.03, -MESH_Z_OFFSET)
			var world_offset := rot_basis * local_offset

			var desired_mesh_pos := start_pos + start_right * (guard_offset - 0.05)
			desired_mesh_pos.y += y_offset

			var node_pos := desired_mesh_pos - world_offset

			outer_end1.position = node_pos
			outer_end1.rotation = Vector3(0, rotation_y, 0)
			outer_end1.scale = Vector3(scale_factor, height_scale, 1.0)

	if inner_end1:
		inner_end1.visible = show_inner_end_l and right_wall_enabled
		if show_inner_end_l and right_wall_enabled:
			var rotation_y := atan2(start_tangent.x, start_tangent.z) + PI / 2.0 + PI

			var rot_basis := Basis(Vector3.UP, rotation_y)
			var local_offset := Vector3(-0.0025, 0, -MESH_Z_OFFSET - 0.05)
			var world_offset := rot_basis * local_offset

			var desired_mesh_pos := start_pos - start_right * guard_offset
			desired_mesh_pos.y += y_offset

			var node_pos := desired_mesh_pos - world_offset

			inner_end1.position = node_pos
			inner_end1.rotation = Vector3(0, rotation_y, 0)
			inner_end1.scale = Vector3(scale_factor, height_scale, 1.0)

	if inner_end2:
		inner_end2.visible = show_inner_end_r and right_wall_enabled
		if show_inner_end_r and right_wall_enabled:
			var rotation_y := atan2(end_tangent.x, end_tangent.z) + PI / 2.0 + PI

			var rot_basis := Basis(Vector3.UP, rotation_y)
			var local_offset := Vector3(0.15, .35, -MESH_Z_OFFSET - .05)
			var world_offset := rot_basis * local_offset

			var desired_mesh_pos := end_pos - end_right * guard_offset + end_tangent * 0.35
			desired_mesh_pos.y += y_offset

			var node_pos := desired_mesh_pos - world_offset

			inner_end2.position = node_pos
			inner_end2.rotation = Vector3(0, rotation_y, 0)
			inner_end2.scale = Vector3(scale_factor, height_scale, 1.0)

	if outer_end2:
		outer_end2.visible = show_outer_end_r and left_wall_enabled
		if show_outer_end_r and left_wall_enabled:
			var rotation_y := atan2(end_tangent.x, end_tangent.z) + PI / 2.0

			var rot_basis := Basis(Vector3.UP, rotation_y)
			var local_offset := Vector3(0, 0, -MESH_Z_OFFSET)
			var world_offset := rot_basis * local_offset

			var desired_mesh_pos := end_pos + end_right * (guard_offset - 0.05)
			desired_mesh_pos.y += y_offset

			var node_pos := desired_mesh_pos - world_offset

			outer_end2.position = node_pos
			outer_end2.rotation = Vector3(0, rotation_y, 0)
			outer_end2.scale = Vector3(scale_factor, height_scale, 1.0)


func _enter_tree() -> void:
	if _mesh_update_pending:
		_update_mesh()


## Update wall visibility and collision state based on left_wall_enabled and right_wall_enabled.
func _update_wall_visibility() -> void:
	if _outer_guard:
		_outer_guard.visible = left_wall_enabled
		var outer_static_body := _outer_guard.get_node_or_null("StaticBody3D") as StaticBody3D
		if outer_static_body:
			var outer_collision := outer_static_body.get_node_or_null("CollisionShape3D") as CollisionShape3D
			if outer_collision:
				outer_collision.disabled = not left_wall_enabled

	if _inner_guard:
		_inner_guard.visible = right_wall_enabled
		var inner_static_body := _inner_guard.get_node_or_null("StaticBody3D") as StaticBody3D
		if inner_static_body:
			var inner_collision := inner_static_body.get_node_or_null("CollisionShape3D") as CollisionShape3D
			if inner_collision:
				inner_collision.disabled = not right_wall_enabled

	_update_end_pieces()


## Called when path or conveyor changes
func update_for_path_conveyor() -> void:
	_update_mesh()

func _init():
	_update_mesh()

func _get_configuration_warnings() -> PackedStringArray:
	var warnings := PackedStringArray()
	if not conveyor:
		warnings.append("No conveyor assigned. Assign a PathFollowingConveyor or place this node as a sibling.")
	elif not _get_path_3d():
		warnings.append("Conveyor has no path_to_follow assigned.")
	return warnings
