@tool
class_name SpiralConveyor
extends Node3D

signal size_changed

const METAL_SHADER: Shader = preload("res://assets/3DModels/Shaders/MetalShader.tres")
const METAL_SHADER_CORNER: Shader = preload("res://assets/3DModels/Shaders/MetalShaderCorner.tres")

## Radius of the central drum in meters.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var inner_radius: float = 0.3:
	set(value):
		inner_radius = maxf(0.1, value)
		_request_rebuild()

## Width of the slat chain surface in meters.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var conveyor_width: float = 0.6:
	set(value):
		conveyor_width = maxf(0.1, value)
		_request_rebuild()

## Vertical rise per full 360-degree turn in meters.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var pitch: float = 0.5:
	set(value):
		pitch = maxf(0.05, value)
		_request_rebuild()

## Number of helical turns (fractional).
@export_range(0.25, 5.0, 0.25) var turns: float = 1.5:
	set(value):
		turns = clampf(value, 0.25, 5.0)
		_request_rebuild()

## When true, reverses the conveyor direction.
@export var reverse: bool = false:
	set(value):
		reverse = value
		_recalculate_speed()

## Linear speed at the conveyor surface in meters per second.
@export_custom(PROPERTY_HINT_NONE, "suffix:m/s") var speed: float = 2.0:
	set(value):
		if value == speed:
			return
		speed = value
		_recalculate_speed()
		if _running_tag.is_ready():
			_running_tag.write_bit(value != 0.0)

## Color tint of the slat chain surface.
@export var slat_color: Color = Color(0.7, 0.7, 0.75, 1.0):
	set(value):
		slat_color = value
		if _surface_material:
			_surface_material.set_shader_parameter("Color", slat_color)

## Color of the central drum.
@export var drum_color: Color = Color(0.45, 0.45, 0.5, 1.0):
	set(value):
		drum_color = value
		if _drum_material:
			_drum_material.set_shader_parameter("Color", drum_color)

## Color of the side rails.
@export var rail_color: Color = Color(0.5, 0.5, 0.55, 1.0):
	set(value):
		rail_color = value
		if _rail_material:
			_rail_material.set_shader_parameter("Color", rail_color)


var size: Vector3:
	get:
		return _calculated_size
	set(_value):
		pass

var _calculated_size: Vector3 = Vector3(1.8, 1.0, 1.8)

var total_height: float:
	get:
		return pitch * turns

var avg_radius: float:
	get:
		return inner_radius + conveyor_width / 2.0


var _surface_material: ShaderMaterial
var _rail_material: ShaderMaterial
var _drum_material: ShaderMaterial
var _angular_speed: float = 0.0
var _rebuild_needed: bool = true

var _surface_mesh: MeshInstance3D
var _drum_mesh: MeshInstance3D
var _inner_rail_mesh: MeshInstance3D
var _outer_rail_mesh: MeshInstance3D
var _sb: StaticBody3D

var _speed_tag := OIPCommsTag.new()
var _running_tag := OIPCommsTag.new()

@export_category("Communications")
## Enable communication with external PLC/control systems.
@export var enable_comms := false
@export var speed_tag_group_name: String
## The tag group for reading speed values from external systems.
@export_custom(0, "tag_group_enum") var speed_tag_groups:
	set(value):
		speed_tag_group_name = value
		speed_tag_groups = value
## The tag name for the speed value in the selected tag group.[br]Datatype: [code]REAL[/code] (32-bit float)[br][br]Format varies by protocol:[br][b]EIP:[/b] CIP tag names[br][b]Modbus:[/b] prefix+number (e.g. [code]hr0[/code])[br][b]OPC UA:[/b] full NodeId (e.g. [code]ns=2;s=MyVariable[/code] or [code]ns=2;i=12345[/code]).
@export var speed_tag_name := ""
@export var running_tag_group_name: String
## The tag group for the running state signal.
@export_custom(0, "tag_group_enum") var running_tag_groups:
	set(value):
		running_tag_group_name = value
		running_tag_groups = value
## The tag name for the running state in the selected tag group.[br]Datatype: [code]BOOL[/code][br][br]Format varies by protocol:[br][b]EIP:[/b] CIP tag names[br][b]Modbus:[/b] prefix+number (e.g. [code]co0[/code])[br][b]OPC UA:[/b] full NodeId (e.g. [code]ns=2;s=MyVariable[/code] or [code]ns=2;i=12345[/code]).
@export var running_tag_name := ""


func _validate_property(property: Dictionary) -> void:
	if OIPCommsSetup.validate_tag_property(property, "speed_tag_group_name", "speed_tag_groups", "speed_tag_name"):
		return
	OIPCommsSetup.validate_tag_property(property, "running_tag_group_name", "running_tag_groups", "running_tag_name")


func _ready() -> void:
	_ensure_nodes()
	_setup_materials()
	_rebuild_needed = true
	_rebuild()
	_recalculate_speed()


func _enter_tree() -> void:
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)
	OIPCommsSetup.connect_comms(self, _tag_group_initialized, _tag_group_polled)


func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)
	OIPCommsSetup.disconnect_comms(self, _tag_group_initialized, _tag_group_polled)


func _physics_process(_delta: float) -> void:
	if not _sb:
		return
	if SimulationEvents.simulation_running:
		var local_up := _sb.global_transform.basis.y.normalized()
		var dir := -1.0 if reverse else 1.0
		_sb.constant_angular_velocity = -local_up * _angular_speed * dir
	else:
		_sb.constant_angular_velocity = Vector3.ZERO


func _request_rebuild() -> void:
	_rebuild_needed = true
	if is_inside_tree():
		_rebuild()


func _rebuild() -> void:
	if not _rebuild_needed or not is_inside_tree():
		return
	_ensure_nodes()
	_setup_materials()
	_generate_surface_mesh()
	_generate_drum_mesh()
	_generate_rail_mesh(_inner_rail_mesh, true)
	_generate_rail_mesh(_outer_rail_mesh, false)
	_generate_collision_shape()
	_rebuild_needed = false
	_update_size()


func _update_size() -> void:
	var outer_r := inner_radius + conveyor_width
	var diameter := outer_r * 2.0
	var old_size := _calculated_size
	_calculated_size = Vector3(diameter, total_height + pitch * 0.5, diameter)
	if old_size != _calculated_size:
		size_changed.emit()


func _recalculate_speed() -> void:
	_angular_speed = 0.0 if avg_radius < 0.001 else speed / avg_radius


#region Node Setup

func _ensure_nodes() -> void:
	_sb = get_node_or_null("StaticBody3D") as StaticBody3D
	if not _sb:
		_sb = StaticBody3D.new()
		_sb.name = "StaticBody3D"
		add_child(_sb)
		_set_owner(_sb)

	var coll := _sb.get_node_or_null("CollisionShape3D") as CollisionShape3D
	if not coll:
		coll = CollisionShape3D.new()
		coll.name = "CollisionShape3D"
		_sb.add_child(coll)
		_set_owner(coll)
	elif coll.shape:
		coll.shape = coll.shape.duplicate()

	_surface_mesh = _ensure_mesh_instance("SurfaceMesh")
	_drum_mesh = _ensure_mesh_instance("DrumMesh")
	_inner_rail_mesh = _ensure_mesh_instance("InnerRailMesh")
	_outer_rail_mesh = _ensure_mesh_instance("OuterRailMesh")


func _ensure_mesh_instance(node_name: String) -> MeshInstance3D:
	var node := get_node_or_null(node_name) as MeshInstance3D
	if not node:
		node = MeshInstance3D.new()
		node.name = node_name
		add_child(node)
		_set_owner(node)
	return node


func _set_owner(node: Node) -> void:
	if Engine.is_editor_hint() and is_inside_tree():
		node.owner = get_tree().edited_scene_root
	else:
		node.owner = self

#endregion


#region Materials

func _setup_materials() -> void:
	if not _surface_material:
		_surface_material = ShaderMaterial.new()
		_surface_material.shader = METAL_SHADER_CORNER
	_surface_material.set_shader_parameter("Color", slat_color)
	_surface_material.set_shader_parameter("Scale", 1.0)
	_surface_material.set_shader_parameter("Scale2", 1.0)

	if not _rail_material:
		_rail_material = ShaderMaterial.new()
		_rail_material.shader = METAL_SHADER
	_rail_material.set_shader_parameter("Color", rail_color)
	_rail_material.set_shader_parameter("Scale", 1.0)

	if not _drum_material:
		_drum_material = ShaderMaterial.new()
		_drum_material.shader = METAL_SHADER
	_drum_material.set_shader_parameter("Color", drum_color)
	_drum_material.set_shader_parameter("Scale", 1.0)

#endregion


#region Spiral Surface Mesh

func _generate_surface_mesh() -> void:
	if not _surface_mesh:
		return

	var mesh := ArrayMesh.new()
	var total_angle := turns * TAU
	var segments := maxi(12, int(turns * 120))
	var r_inner := inner_radius
	var r_outer := inner_radius + conveyor_width
	var slab_thickness := 0.02

	var top_verts := PackedVector3Array()
	var top_normals := PackedVector3Array()
	var top_uvs := PackedVector2Array()
	var bot_verts := PackedVector3Array()
	var bot_normals := PackedVector3Array()
	var bot_uvs := PackedVector2Array()

	var slope := pitch / (TAU * avg_radius)

	for i in range(segments + 1):
		var t := float(i) / segments
		var a := t * total_angle
		var y := t * total_height
		var sa := sin(a)
		var ca := cos(a)

		var tangent := Vector3(-ca, slope, -sa).normalized()
		var radial_out := Vector3(-sa, 0, ca)
		var normal := radial_out.cross(tangent).normalized()

		var v_inner := Vector3(-sa * r_inner, y, ca * r_inner)
		var v_outer := Vector3(-sa * r_outer, y, ca * r_outer)

		top_verts.append(v_inner)
		top_verts.append(v_outer)
		top_normals.append(normal)
		top_normals.append(normal)
		top_uvs.append(Vector2(0, t * turns * 4.0))
		top_uvs.append(Vector2(1, t * turns * 4.0))

		bot_verts.append(Vector3(-sa * r_inner, y - slab_thickness, ca * r_inner))
		bot_verts.append(Vector3(-sa * r_outer, y - slab_thickness, ca * r_outer))
		bot_normals.append(-normal)
		bot_normals.append(-normal)
		bot_uvs.append(Vector2(0, t))
		bot_uvs.append(Vector2(1, t))

	var top_idx := PackedInt32Array()
	var bot_idx := PackedInt32Array()
	for i in range(segments):
		var vi := i * 2
		top_idx.append_array([vi, vi + 1, vi + 3, vi, vi + 3, vi + 2])
		bot_idx.append_array([vi, vi + 3, vi + 1, vi, vi + 2, vi + 3])

	_add_surface(mesh, top_verts, top_normals, top_uvs, top_idx, _surface_material)
	_add_surface(mesh, bot_verts, bot_normals, bot_uvs, bot_idx, _surface_material)

	_add_edge_wall(mesh, top_verts, bot_verts, segments, true)
	_add_edge_wall(mesh, top_verts, bot_verts, segments, false)

	_surface_mesh.mesh = mesh

#endregion


#region Edge Walls

func _add_edge_wall(mesh: ArrayMesh, top_v: PackedVector3Array, bot_v: PackedVector3Array, segments: int, is_inner: bool) -> void:
	var verts := PackedVector3Array()
	var normals := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()
	var offset := 0 if is_inner else 1

	for i in range(segments + 1):
		var idx := i * 2 + offset
		var tv: Vector3 = top_v[idx]
		var bv: Vector3 = bot_v[idx]
		var t := float(i) / segments
		var n := Vector3(tv.x, 0, tv.z).normalized()
		if is_inner:
			n = -n

		verts.append(tv)
		verts.append(bv)
		normals.append(n)
		normals.append(n)
		uvs.append(Vector2(t, 0))
		uvs.append(Vector2(t, 1))

	for i in range(segments):
		var vi := i * 2
		if is_inner:
			indices.append_array([vi, vi + 2, vi + 1, vi + 1, vi + 2, vi + 3])
		else:
			indices.append_array([vi, vi + 1, vi + 2, vi + 2, vi + 1, vi + 3])

	_add_surface(mesh, verts, normals, uvs, indices, _surface_material)

#endregion


#region Drum Mesh

func _generate_drum_mesh() -> void:
	if not _drum_mesh:
		return

	var mesh := ArrayMesh.new()
	var r := maxf(0.01, inner_radius - 0.01)
	var h := total_height + pitch * 0.25
	var y_base := -pitch * 0.125
	var segs := 24

	var verts := PackedVector3Array()
	var normals := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()

	for i in range(segs + 1):
		var t := float(i) / segs
		var a := t * TAU
		var sa := sin(a)
		var ca := cos(a)
		var n := Vector3(-sa, 0, ca)

		verts.append(Vector3(-sa * r, y_base, ca * r))
		verts.append(Vector3(-sa * r, y_base + h, ca * r))
		normals.append(n)
		normals.append(n)
		uvs.append(Vector2(t * 4.0, 0))
		uvs.append(Vector2(t * 4.0, h))

	for i in range(segs):
		var vi := i * 2
		indices.append_array([vi, vi + 1, vi + 2, vi + 2, vi + 1, vi + 3])

	_add_surface(mesh, verts, normals, uvs, indices, _drum_material)

	# Top cap
	var cap_verts := PackedVector3Array()
	var cap_normals := PackedVector3Array()
	var cap_uvs := PackedVector2Array()
	var cap_indices := PackedInt32Array()

	cap_verts.append(Vector3(0, y_base + h, 0))
	cap_normals.append(Vector3.UP)
	cap_uvs.append(Vector2(0.5, 0.5))

	for i in range(segs + 1):
		var t := float(i) / segs
		var a := t * TAU
		cap_verts.append(Vector3(-sin(a) * r, y_base + h, cos(a) * r))
		cap_normals.append(Vector3.UP)
		cap_uvs.append(Vector2(0.5 + cos(a) * 0.5, 0.5 + sin(a) * 0.5))

	for i in range(segs):
		cap_indices.append_array([0, i + 1, i + 2])

	_add_surface(mesh, cap_verts, cap_normals, cap_uvs, cap_indices, _drum_material)

	_drum_mesh.mesh = mesh

#endregion


#region Side Rails

func _generate_rail_mesh(mesh_node: MeshInstance3D, is_inner: bool) -> void:
	if not mesh_node:
		return

	var mesh := ArrayMesh.new()
	var total_angle := turns * TAU
	var segments := maxi(12, int(turns * 120))
	var rail_h := 0.12
	var rail_t := 0.015
	var r_base := inner_radius + 0.005 if is_inner else inner_radius + conveyor_width - 0.005

	var verts := PackedVector3Array()
	var normals := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()

	for i in range(segments + 1):
		var t := float(i) / segments
		var a := t * total_angle
		var y := t * total_height
		var sa := sin(a)
		var ca := cos(a)

		var r0 := r_base - rail_t if is_inner else r_base
		var r1 := r_base if is_inner else r_base + rail_t

		verts.append(Vector3(-sa * r0, y, ca * r0))
		verts.append(Vector3(-sa * r0, y + rail_h, ca * r0))
		verts.append(Vector3(-sa * r1, y, ca * r1))
		verts.append(Vector3(-sa * r1, y + rail_h, ca * r1))

		var n_in := Vector3(sa, 0, -ca) if is_inner else Vector3(-sa, 0, ca)
		var n_out := -n_in
		normals.append(n_in)
		normals.append(n_in)
		normals.append(n_out)
		normals.append(n_out)

		var u := t * turns * 4.0
		uvs.append(Vector2(u, 0))
		uvs.append(Vector2(u, 1))
		uvs.append(Vector2(u, 0))
		uvs.append(Vector2(u, 1))

	for i in range(segments):
		var vi := i * 4
		# Inner face
		indices.append_array([vi, vi + 4, vi + 1, vi + 1, vi + 4, vi + 5])
		# Outer face
		indices.append_array([vi + 2, vi + 3, vi + 6, vi + 3, vi + 7, vi + 6])
		# Top face
		indices.append_array([vi + 1, vi + 5, vi + 3, vi + 3, vi + 5, vi + 7])

	_add_surface(mesh, verts, normals, uvs, indices, _rail_material)
	mesh_node.mesh = mesh

#endregion


#region Collision

func _generate_collision_shape() -> void:
	if not _sb:
		return
	var coll := _sb.get_node_or_null("CollisionShape3D") as CollisionShape3D
	if not coll:
		return

	var total_angle := turns * TAU
	var segments := maxi(16, int(turns * 180))
	var r_in := inner_radius
	var r_out := inner_radius + conveyor_width
	var thickness := 0.05
	var faces := PackedVector3Array()

	for i in range(segments):
		var t0 := float(i) / segments
		var t1 := float(i + 1) / segments
		var a0 := t0 * total_angle
		var a1 := t1 * total_angle
		var y0 := t0 * total_height
		var y1 := t1 * total_height
		var s0 := sin(a0)
		var c0 := cos(a0)
		var s1 := sin(a1)
		var c1 := cos(a1)

		var v0i_t := Vector3(-s0 * r_in, y0, c0 * r_in)
		var v0o_t := Vector3(-s0 * r_out, y0, c0 * r_out)
		var v1i_t := Vector3(-s1 * r_in, y1, c1 * r_in)
		var v1o_t := Vector3(-s1 * r_out, y1, c1 * r_out)
		var v0i_b := Vector3(-s0 * r_in, y0 - thickness, c0 * r_in)
		var v0o_b := Vector3(-s0 * r_out, y0 - thickness, c0 * r_out)
		var v1i_b := Vector3(-s1 * r_in, y1 - thickness, c1 * r_in)
		var v1o_b := Vector3(-s1 * r_out, y1 - thickness, c1 * r_out)

		# Top face
		faces.append_array([v0i_t, v0o_t, v1o_t, v0i_t, v1o_t, v1i_t])
		# Bottom face (reversed winding)
		faces.append_array([v0i_b, v1o_b, v0o_b, v0i_b, v1i_b, v1o_b])
		# Inner wall
		faces.append_array([v0i_t, v1i_t, v1i_b, v0i_t, v1i_b, v0i_b])
		# Outer wall
		faces.append_array([v0o_t, v0o_b, v1o_b, v0o_t, v1o_b, v1o_t])

	var shape := ConcavePolygonShape3D.new()
	shape.set_faces(faces)
	coll.shape = shape

#endregion


#region Simulation Events

func _on_simulation_started() -> void:
	if enable_comms:
		_speed_tag.register(speed_tag_group_name, speed_tag_name)
		_running_tag.register(running_tag_group_name, running_tag_name)


func _on_simulation_ended() -> void:
	if _sb:
		_sb.constant_angular_velocity = Vector3.ZERO


func _tag_group_initialized(tag_group_name_param: String) -> void:
	_speed_tag.on_group_initialized(tag_group_name_param)
	_running_tag.on_group_initialized(tag_group_name_param)


func _tag_group_polled(tag_group_name_param: String) -> void:
	if not enable_comms:
		return
	if _speed_tag.matches_group(tag_group_name_param):
		speed = _speed_tag.read_float32()

#endregion


#region Helpers

func _add_surface(mesh: ArrayMesh, verts: PackedVector3Array, norms: PackedVector3Array, uv: PackedVector2Array, idx: PackedInt32Array, material: Material) -> void:
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_NORMAL] = norms
	arrays[Mesh.ARRAY_TEX_UV] = uv
	arrays[Mesh.ARRAY_INDEX] = idx
	var surface_idx := mesh.get_surface_count()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	mesh.surface_set_material(surface_idx, material)

#endregion
