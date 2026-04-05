@tool
class_name CurvedSideGuards
extends Node3D

## Generates curved sideguard walls matching the straight sideguard profile.
## Inner guard follows the inner radius, outer guard follows the outer radius.

## Angle of the curved guard section in degrees.
@export_range(10.0, 180.0, 1.0, 'degrees') var guard_angle: float = 90.0:
	set(value):
		if abs(guard_angle - value) < 0.001:
			return
		guard_angle = value
		_update_mesh()

## Overall dimensions of the guard (X=diameter, Y=height multiplier, Z=unused).
@export var size: Vector3 = Vector3(1.56, 4.0, 1.0):
	set(value):
		if size.is_equal_approx(value):
			return
		size = value
		_update_mesh()

var _current_inner_radius: float = 0.25
var _current_conveyor_width: float = 1.0
var _current_belt_height: float = CurvedBeltConveyor.SIZE_DEFAULT.y

var outer_mesh: MeshInstance3D = null
var inner_mesh: MeshInstance3D = null

static var _shared_material: ShaderMaterial
static var _metal_texture: Texture2D = preload("res://assets/3DModels/Textures/Metal.png")


func _init() -> void:
	set_notify_local_transform(true)


func _ready() -> void:
	outer_mesh = find_child('OuterSideGuard') as MeshInstance3D
	if not outer_mesh:
		outer_mesh = MeshInstance3D.new()
		outer_mesh.name = 'OuterSideGuard'
		add_child(outer_mesh)

	inner_mesh = find_child('InnerSideGuard') as MeshInstance3D
	if not inner_mesh:
		inner_mesh = MeshInstance3D.new()
		inner_mesh.name = 'InnerSideGuard'
		add_child(inner_mesh)

	_ensure_material()
	_ensure_collision_shapes()
	_update_mesh()


func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		_update_mesh()


func _exit_tree() -> void:
	if outer_mesh:
		SensorBeamCache.unregister_instance(outer_mesh)
	if inner_mesh:
		SensorBeamCache.unregister_instance(inner_mesh)


func _ensure_material() -> void:
	if _shared_material:
		return
	_shared_material = ShaderMaterial.new()
	_shared_material.shader = load("res://assets/3DModels/Shaders/MetalShaderSideGuard.tres")
	_shared_material.set_shader_parameter("metal_texture", _metal_texture)
	_shared_material.set_shader_parameter("color_tint", Color(1.6, 1.6, 1.6))
	_shared_material.set_shader_parameter("Metallic", 0.94)
	_shared_material.set_shader_parameter("Roughness", 0.5)
	_shared_material.set_shader_parameter("Specular", 0.5)


func _ensure_collision_shapes() -> void:
	for mesh_node in [outer_mesh, inner_mesh]:
		if not mesh_node:
			continue
		var body := mesh_node.get_node_or_null("StaticBody3D") as StaticBody3D
		if not body:
			body = StaticBody3D.new()
			body.name = "StaticBody3D"
			body.collision_mask = 8
			var physics_mat := PhysicsMaterial.new()
			physics_mat.friction = 0.0
			body.physics_material_override = physics_mat
			var col := CollisionShape3D.new()
			col.name = "CollisionShape3D"
			col.shape = BoxShape3D.new()
			body.add_child(col)
			mesh_node.add_child(body)
		else:
			var col := body.get_node_or_null("CollisionShape3D") as CollisionShape3D
			if col and col.shape:
				col.shape = col.shape.duplicate()


func _update_mesh() -> void:
	if not is_inside_tree() or not outer_mesh or not inner_mesh:
		return

	var angle_rad: float = deg_to_rad(guard_angle)
	var inner_r: float = _current_inner_radius
	var outer_r: float = inner_r + _current_conveyor_width
	var wall_h: float = SideGuardMesh.WALL_HEIGHT
	var wall_t: float = SideGuardMesh.WALL_THICKNESS
	var frame_wt: float = ConveyorFrameMesh.WALL_THICKNESS

	var outer_r_frame: float = outer_r + frame_wt
	var inner_r_frame: float = inner_r - frame_wt

	# Sideguards follow the exact frame contour: curved arc + straight tangent extensions.
	# Tangent must match the belt roller extent: DEFAULT_HEIGHT_RATIO * belt_height.
	var roller_tangent: float = 0.5 * _current_belt_height
	var segments: int = maxi(4, int(guard_angle / 5.0))

	outer_mesh.mesh = _create_contour_wall(outer_r_frame, wall_h, wall_t, angle_rad, segments, 1.0, roller_tangent)
	outer_mesh.position.y = 0
	outer_mesh.rotation.y = 0
	outer_mesh.set_surface_override_material(0, _shared_material)
	outer_mesh.set_instance_shader_parameter("Scale", 1.0)
	_update_collision(outer_mesh, outer_r_frame, wall_h, angle_rad)
	SensorBeamCache.register_instance(outer_mesh)

	inner_mesh.mesh = _create_contour_wall(inner_r_frame, wall_h, wall_t, angle_rad, segments, -1.0, roller_tangent)
	inner_mesh.position.y = 0
	inner_mesh.rotation.y = 0
	inner_mesh.set_surface_override_material(0, _shared_material)
	inner_mesh.set_instance_shader_parameter("Scale", 1.0)
	_update_collision(inner_mesh, inner_r_frame, wall_h, angle_rad)
	SensorBeamCache.register_instance(inner_mesh)


## Create a curved flat wall mesh following an arc.
## [param radius] The radius of the arc to follow.
## [param wall_height] Height of the wall above Y=0.
## [param wall_thickness] Thickness of the wall.
## [param angle_rad] Arc angle in radians.
## [param segments] Number of segments along the arc.
## Create a wall that follows the frame contour: straight extension + curved arc + straight extension.
## [param tangent_ext] Linear distance of the straight extensions at each end.
static func _create_contour_wall(radius: float, wall_height: float, wall_thickness: float,
		angle_rad: float, segments: int, direction: float, tangent_ext: float) -> ArrayMesh:
	# Build a point list: straight start + arc + straight end.
	# Each point is (position_xz: Vector3, normal_radial: Vector3, arc_distance: float).
	var points: Array = []
	var total_dist: float = 0.0

	# Start straight extension (before angle=0, along tangent away from arc).
	# Arc tangent at angle=0 is (-1, 0, 0). Away from arc = (+1, 0, 0).
	var start_pos := Vector3(0, 0, radius)
	var start_away := Vector3(1, 0, 0)
	var start_normal := Vector3(0, 0, 1) * direction

	# Extension point (furthest from arc).
	var ext_pos := start_pos + start_away * tangent_ext
	points.append({"pos": ext_pos, "normal": start_normal, "dist": total_dist})
	total_dist += tangent_ext

	# Arc start.
	points.append({"pos": start_pos, "normal": start_normal, "dist": total_dist})

	# Arc points.
	for i in range(1, segments):
		var t: float = float(i) / segments
		var angle: float = t * angle_rad
		var sa: float = sin(angle)
		var ca: float = cos(angle)
		total_dist += (angle_rad / segments) * radius
		var radial := Vector3(-sa, 0, ca) * direction
		points.append({"pos": Vector3(-sa * radius, 0, ca * radius), "normal": radial, "dist": total_dist})

	# Arc end.
	var end_sa: float = sin(angle_rad)
	var end_ca: float = cos(angle_rad)
	total_dist += (angle_rad / segments) * radius
	var end_normal := Vector3(-end_sa, 0, end_ca) * direction
	var end_pos := Vector3(-end_sa * radius, 0, end_ca * radius)
	points.append({"pos": end_pos, "normal": end_normal, "dist": total_dist})

	# End straight extension (after angle=angle_rad, along tangent).
	var end_tangent := Vector3(-end_ca, 0, -end_sa)
	var end_ext_pos := end_pos + end_tangent * tangent_ext
	total_dist += tangent_ext
	points.append({"pos": end_ext_pos, "normal": end_normal, "dist": total_dist})

	# Now build the mesh from the point list.
	var mesh := ArrayMesh.new()
	var verts := PackedVector3Array()
	var norms := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()
	var y_bottom: float = -ConveyorFrameMesh.FLANGE_THICKNESS

	var r_outer: float = radius + wall_thickness / 2.0 * direction
	var r_inner: float = radius - wall_thickness / 2.0 * direction

	for point in points:
		var p: Vector3 = point["pos"]
		var n: Vector3 = point["normal"]
		var d: float = point["dist"]
		var p_outer: Vector3 = p * (r_outer / radius) if radius > 0 else p
		var p_inner: Vector3 = p * (r_inner / radius) if radius > 0 else p

		# Outer face.
		verts.append(Vector3(p_outer.x, wall_height, p_outer.z))
		norms.append(n)
		uvs.append(Vector2(d, 0))
		verts.append(Vector3(p_outer.x, y_bottom, p_outer.z))
		norms.append(n)
		uvs.append(Vector2(d, wall_height))

	var outer_count: int = points.size()
	for i in range(outer_count - 1):
		var base: int = i * 2
		indices.append_array([base, base + 1, base + 2, base + 1, base + 3, base + 2])

	# Inner face.
	var inner_base_idx: int = verts.size()
	for point in points:
		var p: Vector3 = point["pos"]
		var n: Vector3 = point["normal"]
		var d: float = point["dist"]

		var p_inner: Vector3 = p * (r_inner / radius) if radius > 0 else p

		verts.append(Vector3(p_inner.x, wall_height, p_inner.z))
		norms.append(-n)
		uvs.append(Vector2(d, 0))
		verts.append(Vector3(p_inner.x, y_bottom, p_inner.z))
		norms.append(-n)
		uvs.append(Vector2(d, wall_height))

	for i in range(outer_count - 1):
		var base: int = inner_base_idx + i * 2
		indices.append_array([base, base + 2, base + 1, base + 1, base + 2, base + 3])

	# Top face.
	var top_base_idx: int = verts.size()
	for point in points:
		var p: Vector3 = point["pos"]
		var d: float = point["dist"]
		var p_outer: Vector3 = p * (r_outer / radius) if radius > 0 else p
		var p_inner: Vector3 = p * (r_inner / radius) if radius > 0 else p

		verts.append(Vector3(p_inner.x, wall_height, p_inner.z))
		norms.append(Vector3.UP)
		uvs.append(Vector2(d, 0))
		verts.append(Vector3(p_outer.x, wall_height, p_outer.z))
		norms.append(Vector3.UP)
		uvs.append(Vector2(d, wall_thickness))

	for i in range(outer_count - 1):
		var base: int = top_base_idx + i * 2
		indices.append_array([base, base + 2, base + 1, base + 1, base + 2, base + 3])

	# End caps.
	for end_i in [0, outer_count - 1]:
		var p: Vector3 = points[end_i]["pos"]
		var p_outer: Vector3 = p * (r_outer / radius) if radius > 0 else p
		var p_inner: Vector3 = p * (r_inner / radius) if radius > 0 else p
		var cap_normal: Vector3
		if end_i == 0:
			cap_normal = (points[0]["pos"] - points[1]["pos"]).normalized()
		else:
			cap_normal = (points[outer_count - 1]["pos"] - points[outer_count - 2]["pos"]).normalized()
		cap_normal.y = 0
		cap_normal = cap_normal.normalized()

		var cb: int = verts.size()
		verts.append(Vector3(p_inner.x, wall_height, p_inner.z))
		verts.append(Vector3(p_inner.x, y_bottom, p_inner.z))
		verts.append(Vector3(p_outer.x, wall_height, p_outer.z))
		verts.append(Vector3(p_outer.x, y_bottom, p_outer.z))
		for _j in range(4):
			norms.append(cap_normal)
			uvs.append(Vector2(0, 0))
		indices.append_array([
			cb, cb + 2, cb + 1, cb + 1, cb + 2, cb + 3,
		])

	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_NORMAL] = norms
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh


func _update_collision(mesh_node: MeshInstance3D, radius: float, wall_height: float, angle_rad: float) -> void:
	var body := mesh_node.get_node_or_null("StaticBody3D") as StaticBody3D
	if not body:
		return
	var col := body.get_node_or_null("CollisionShape3D") as CollisionShape3D
	if not col:
		return

	# Generate a thicker wall mesh for collision to prevent tunneling.
	# Centered on the visual wall — extends equally inward and outward.
	var segments: int = maxi(4, int(guard_angle / 5.0))
	var roller_tangent: float = 0.5 * _current_belt_height
	var direction: float = 1.0 if radius > _current_inner_radius else -1.0
	var collision_mesh: ArrayMesh = _create_contour_wall(
		radius, wall_height, SideGuardMesh.COLLISION_THICKNESS, angle_rad, segments, direction, roller_tangent)

	if not collision_mesh or collision_mesh.get_surface_count() == 0:
		return

	var arrays: Array = collision_mesh.surface_get_arrays(0)
	var mesh_verts: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
	var mesh_indices: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]

	var tri_verts := PackedVector3Array()
	for i in range(0, mesh_indices.size(), 3):
		if i + 2 >= mesh_indices.size():
			break
		tri_verts.append(mesh_verts[mesh_indices[i]])
		tri_verts.append(mesh_verts[mesh_indices[i + 1]])
		tri_verts.append(mesh_verts[mesh_indices[i + 2]])

	var shape := ConcavePolygonShape3D.new()
	shape.data = tri_verts
	col.shape = shape
	col.position = Vector3.ZERO
	col.rotation = Vector3.ZERO


func update_for_curved_conveyor(inner_radius: float, conveyor_width: float, conveyor_size: Vector3, conveyor_angle: float) -> void:
	if not is_inside_tree():
		return

	# Position guard at conveyor top surface regardless of scene transform.
	position = Vector3(position.x, 0, position.z)

	var tolerance = 0.0001
	if abs(_current_inner_radius - inner_radius) < tolerance and \
	   abs(_current_conveyor_width - conveyor_width) < tolerance and \
	   abs(_current_belt_height - conveyor_size.y) < tolerance and \
	   abs(guard_angle - conveyor_angle) < tolerance:
		return

	_current_inner_radius = inner_radius
	_current_conveyor_width = conveyor_width
	_current_belt_height = conveyor_size.y
	guard_angle = conveyor_angle

	var outer_radius = inner_radius + conveyor_width
	size = Vector3(outer_radius * 2.0, size.y, size.z)

	_update_mesh()
