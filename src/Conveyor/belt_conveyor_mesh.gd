@tool
class_name BeltConveyorMesh
extends RefCounted

## Generates the complete belt conveyor surface as one seamless mesh.
##
## Coordinate system (conveyor local space):
## - Y=0 is the belt top surface
## - Y=-height is the bottom
## - X=0 is the conveyor center
## - Z=0 is the center width
##
## The belt loop (side view):
##       flat top (Y=0)
##   ╭──────────────────╮
##   │ back arc   front │
##   │           arc    │
##   ╰──────────────────╯
##       flat bottom (Y=-height)

const SEGMENTS: int = 16


## Build the belt surface mesh.
## UV.x = normalized position along belt loop (0-1). UV.y = across width (0-1).
## Side walls can be added individually as surface 1.
## [param flat_left]/[param flat_right] make the wall a flat rectangle (for outermost
## frame edges); otherwise the wall follows the belt loop contour.
static func create_belt(length: float, height: float, width: float,
		close_left: bool = false, close_right: bool = false,
		flat_left: bool = false, flat_right: bool = false) -> ArrayMesh:
	var mesh := ArrayMesh.new()
	var verts := PackedVector3Array()
	var norms := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()

	var radius: float = height / 2.0
	var middle_length: float = length - 2.0 * radius
	var half_middle: float = middle_length / 2.0
	var half_width: float = width / 2.0
	var total_belt: float = 2.0 * PI * radius + 2.0 * middle_length

	# Cumulative belt distance for UV.x normalization.
	var dist: float = 0.0

	# --- Back arc (center at X=-half_middle, Y=-radius) ---
	# Sweeps from bottom (angle=PI) to top (angle=0).
	var back_cx: float = -half_middle
	var back_cy: float = -radius
	for i in range(SEGMENTS + 1):
		var t: float = float(i) / SEGMENTS
		var angle: float = PI * (1.0 - t)
		var x: float = back_cx - sin(angle) * radius
		var y: float = back_cy + cos(angle) * radius
		_add_pair(verts, norms, uvs, x, y, half_width, -sin(angle), cos(angle), (dist + t * PI * radius) / total_belt)
	_add_strip(indices, 0, SEGMENTS)
	dist += PI * radius

	# --- Flat top (Y=0, from X=-half_middle to X=+half_middle) ---
	var flat_top_base: int = verts.size()
	_add_pair(verts, norms, uvs, -half_middle, 0, half_width, 0, 1, dist / total_belt)
	_add_pair(verts, norms, uvs, half_middle, 0, half_width, 0, 1, (dist + middle_length) / total_belt)
	_add_strip(indices, flat_top_base, 1)
	dist += middle_length

	# --- Front arc (center at X=+half_middle, Y=-radius) ---
	# Sweeps from top (angle=0) to bottom (angle=PI).
	var front_cx: float = half_middle
	var front_cy: float = -radius
	var front_base: int = verts.size()
	for i in range(SEGMENTS + 1):
		var t: float = float(i) / SEGMENTS
		var angle: float = PI * t
		var x: float = front_cx + sin(angle) * radius
		var y: float = front_cy + cos(angle) * radius
		_add_pair(verts, norms, uvs, x, y, half_width, sin(angle), cos(angle), (dist + t * PI * radius) / total_belt)
	_add_strip(indices, front_base, SEGMENTS)
	dist += PI * radius

	# --- Flat bottom (Y=-height, from X=+half_middle to X=-half_middle) ---
	var bot_base: int = verts.size()
	_add_pair(verts, norms, uvs, half_middle, -height, half_width, 0, -1, dist / total_belt)
	_add_pair(verts, norms, uvs, -half_middle, -height, half_width, 0, -1, (dist + middle_length) / total_belt)
	_add_strip(indices, bot_base, 1)

	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_NORMAL] = norms
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)

	# Side walls as a separate surface (surface 1) for frame material.
	if close_left or close_right:
		var side_verts := PackedVector3Array()
		var side_norms := PackedVector3Array()
		var side_uvs := PackedVector2Array()
		var side_indices := PackedInt32Array()

		# Belt loop outline (racetrack) for contour walls.
		var outline: Array[Vector2] = []
		for i in range(SEGMENTS + 1):
			var t: float = float(i) / SEGMENTS
			var angle: float = PI * (1.0 - t)
			outline.append(Vector2(back_cx - sin(angle) * radius, back_cy + cos(angle) * radius))
		outline.append(Vector2(half_middle, 0))
		for i in range(SEGMENTS + 1):
			var t: float = float(i) / SEGMENTS
			var angle: float = PI * t
			outline.append(Vector2(front_cx + sin(angle) * radius, front_cy + cos(angle) * radius))
		outline.append(Vector2(-half_middle, -height))

		var side_signs: Array[float] = []
		var side_flats: Array[bool] = []
		if close_left:
			side_signs.append(-1.0)
			side_flats.append(flat_left)
		if close_right:
			side_signs.append(1.0)
			side_flats.append(flat_right)
		for side_idx in range(side_signs.size()):
			var side_sign: float = side_signs[side_idx]
			var is_flat: bool = side_flats[side_idx]
			# Offset flat walls outward to sit inside the frame rail and avoid z-fighting.
			var z_offset: float = ConveyorFrameMesh.WALL_THICKNESS / 2.0 if is_flat else 0.0
			var z: float = half_width * side_sign + z_offset * side_sign
			var n := Vector3(0, 0, side_sign)

			if is_flat:
				# Flat rectangle from top (Y=0) to bottom (Y=-height).
				var hl: float = length / 2.0
				var sb: int = side_verts.size()
				side_verts.append(Vector3(-hl, 0, z))
				side_verts.append(Vector3(hl, 0, z))
				side_verts.append(Vector3(hl, -height, z))
				side_verts.append(Vector3(-hl, -height, z))
				side_norms.append_array([n, n, n, n])
				side_uvs.append_array([
					Vector2(0, 0), Vector2(length, 0),
					Vector2(length, height), Vector2(0, height),
				])
				if side_sign > 0:
					side_indices.append_array([sb, sb + 1, sb + 2, sb, sb + 2, sb + 3])
				else:
					side_indices.append_array([sb, sb + 2, sb + 1, sb, sb + 3, sb + 2])
			else:
				# Contour wall following the belt loop profile.
				var center := Vector2(0, -radius)
				var fan_base: int = side_verts.size()
				side_verts.append(Vector3(center.x, center.y, z))
				side_norms.append(n)
				side_uvs.append(Vector2(0.5, 0.5))
				for p: Vector2 in outline:
					side_verts.append(Vector3(p.x, p.y, z))
					side_norms.append(n)
					side_uvs.append(Vector2(p.x, p.y))
				var point_count: int = outline.size()
				for i in range(point_count):
					var a: int = fan_base
					var b: int = fan_base + 1 + i
					var c: int = fan_base + 1 + (i + 1) % point_count
					if side_sign > 0:
						side_indices.append_array([a, b, c])
					else:
						side_indices.append_array([a, c, b])

		var side_arrays := []
		side_arrays.resize(Mesh.ARRAY_MAX)
		side_arrays[Mesh.ARRAY_VERTEX] = side_verts
		side_arrays[Mesh.ARRAY_NORMAL] = side_norms
		side_arrays[Mesh.ARRAY_TEX_UV] = side_uvs
		side_arrays[Mesh.ARRAY_INDEX] = side_indices
		mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, side_arrays)

	return mesh


## Add a pair of vertices at ±half_width for a triangle strip row.
static func _add_pair(
	verts: PackedVector3Array, norms: PackedVector3Array, uvs: PackedVector2Array,
	x: float, y: float, half_width: float,
	nx: float, ny: float, u: float,
) -> void:
	verts.append(Vector3(x, y, -half_width))
	norms.append(Vector3(nx, ny, 0))
	uvs.append(Vector2(u, 0))

	verts.append(Vector3(x, y, half_width))
	norms.append(Vector3(nx, ny, 0))
	uvs.append(Vector2(u, 1))


## Add triangle indices for a strip of quads.
static func _add_strip(indices: PackedInt32Array, base: int, count: int) -> void:
	for i in range(count):
		var b: int = base + i * 2
		indices.append_array([b, b + 2, b + 1, b + 1, b + 2, b + 3])
