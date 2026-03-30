@tool
class_name CurvedBeltConveyor
extends Node3D

signal size_changed

const BASE_INNER_RADIUS: float = 0.5
const BASE_CONVEYOR_WIDTH: float = 1.524
const SIZE_DEFAULT: Vector3 = Vector3(1.524, 0.5, 1.524)

const BELT_SHADER: Shader = preload("res://src/Conveyor/belt_surface_shader.gdshader")
const MESH_SCALE_FACTOR := 2.0

## Radius of the inner curve edge in meters.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var inner_radius: float = BASE_INNER_RADIUS:
	set(value):
		inner_radius = max(0.1, value)
		_mesh_regeneration_needed = true
		_update_calculated_size()
		_update_all_components()

## Width of the conveyor belt in meters.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var conveyor_width: float = BASE_CONVEYOR_WIDTH:
	set(value):
		conveyor_width = max(0.1, value)
		_mesh_regeneration_needed = true
		_update_calculated_size()
		_update_all_components()

## Height of the belt frame in meters.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var belt_height: float = 0.5:
	set(value):
		belt_height = max(0.1, value)
		_mesh_regeneration_needed = true
		_update_calculated_size()
		_update_all_components()

## Calculated automatically from radius and width - not directly editable
var size: Vector3:
	get:
		return _calculated_size
	set(_value):
		pass

var _calculated_size: Vector3 = SIZE_DEFAULT

func _update_calculated_size() -> void:
	var outer_radius = inner_radius + conveyor_width
	var diameter = outer_radius * 2.0
	var old_size = _calculated_size
	_calculated_size = Vector3(diameter, belt_height, diameter)

	if old_size != _calculated_size:
		size_changed.emit()

## The color tint applied to the belt surface.
@export var belt_color: Color = Color(1, 1, 1, 1):
	set(value):
		belt_color = value
		if _belt_material:
			(_belt_material as ShaderMaterial).set_shader_parameter("ColorMix", belt_color)

## The texture style of the belt (standard or alternate pattern).
@export var belt_texture: BeltConveyor.ConvTexture = BeltConveyor.ConvTexture.STANDARD:
	set(value):
		belt_texture = value
		if _belt_material:
			(_belt_material as ShaderMaterial).set_shader_parameter("use_alternate_texture", belt_texture == BeltConveyor.ConvTexture.ALTERNATE)

## Angle of the curved section in degrees (5-180).
@export_range(5.0, 180.0, 1.0, "degrees") var conveyor_angle: float = 90.0:
	set(value):
		if conveyor_angle == value:
			return
		conveyor_angle = value
		_mesh_regeneration_needed = true
		_update_all_components()

## When true, reverses the belt direction.
@export var reverse_belt: bool = false:
	set(value):
		reverse_belt = value
		_recalculate_speeds()
		_update_belt_material_scale()

## Linear speed at the reference distance in meters per second.
@export_custom(PROPERTY_HINT_NONE, "suffix:m/s") var speed: float = 2:
	set(value):
		if value == speed:
			return
		speed = value
		_recalculate_speeds()
		_update_belt_material_scale()
		if _running_tag.is_ready():
			_running_tag.write_bit(value != 0.0)

## Distance from outer edge where speed value applies (for angular speed calc).
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var reference_distance: float = SIZE_DEFAULT.x/2:
	set(value):
		reference_distance = value
		_recalculate_speeds()

## The physics material applied to the belt surface for friction control.
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
		if _end_body1:
			_end_body1.physics_material_override = value
		if _end_body2:
			_end_body2.physics_material_override = value

var _belt_material: Material
var _metal_material: Material
var _frame_mesh_instance: MeshInstance3D
var _shadow_plate: MeshInstance3D
var _belt_position: float = 0.0
var _angular_speed: float = 0.0
var _linear_speed: float = 0.0

@onready var _sb: StaticBody3D = get_node("StaticBody3D")
@onready var curved_mesh: MeshInstance3D = $MeshInstance3D
var _end_body1: StaticBody3D
var _end_body2: StaticBody3D

var _mesh_regeneration_needed: bool = true
var _last_size: Vector3 = Vector3.ZERO

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


func _init() -> void:
	set_notify_local_transform(true)
	_update_calculated_size()


func _ready() -> void:
	var collision_shape = _sb.get_node_or_null("CollisionShape3D") as CollisionShape3D
	if collision_shape and collision_shape.shape:
		collision_shape.shape = collision_shape.shape.duplicate()

	var main_mesh_instance = get_node_or_null("MeshInstance3D") as MeshInstance3D
	if main_mesh_instance and main_mesh_instance.mesh:
		main_mesh_instance.mesh = main_mesh_instance.mesh.duplicate()

	# Create inline end collision bodies.
	_end_body1 = _create_end_body("EndBody1")
	_end_body2 = _create_end_body("EndBody2")
	add_child(_end_body1)
	add_child(_end_body2)

	_frame_mesh_instance = MeshInstance3D.new()
	_frame_mesh_instance.name = "FrameMesh"
	add_child(_frame_mesh_instance)

	_shadow_plate = MeshInstance3D.new()
	_shadow_plate.name = "ShadowPlate"
	_shadow_plate.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_SHADOWS_ONLY
	add_child(_shadow_plate)

	_recalculate_speeds()
	_update_belt_ends()

	_mesh_regeneration_needed = true
	update_visible_meshes()
	_update_belt_material_scale()

func _update_all_components() -> void:
	if not is_inside_tree():
		return

	update_visible_meshes()
	_recalculate_speeds()
	_update_side_guards()
	_update_assembly_components()


## Create a StaticBody3D with a CylinderShape3D for one belt end roller.
func _create_end_body(body_name: String) -> StaticBody3D:
	var body := StaticBody3D.new()
	body.name = body_name
	body.collision_layer = 2
	body.collision_mask = 0
	body.axis_lock_linear_x = true
	body.axis_lock_linear_y = true
	body.axis_lock_linear_z = true
	body.axis_lock_angular_x = true
	body.axis_lock_angular_y = true
	body.physics_material_override = _sb.physics_material_override
	var col := CollisionShape3D.new()
	col.name = "CollisionShape3D"
	var cylinder := CylinderShape3D.new()
	cylinder.radius = belt_height / 2.0
	cylinder.height = conveyor_width
	col.shape = cylinder
	# Rotate cylinder to align axis with the radial direction (Z).
	col.rotation.x = PI / 2.0
	body.add_child(col)
	return body


## Update belt end collision positions, sizes, and angular velocities.
func _update_belt_ends() -> void:
	if not _end_body1 or not _end_body2:
		return

	var radians := deg_to_rad(conveyor_angle)
	var avg_radius := inner_radius + conveyor_width / 2.0
	var roller_radius := belt_height / 2.0

	# Position at arc endpoints.
	_end_body1.position = Vector3(-sin(radians) * avg_radius, -size.y / 2.0, cos(radians) * avg_radius)
	_end_body1.rotation.y = -radians
	_end_body2.position = Vector3(0, -size.y / 2.0, avg_radius)
	_end_body2.rotation.y = 0

	# Update collision shape.
	for body in [_end_body1, _end_body2]:
		var col := body.get_node("CollisionShape3D") as CollisionShape3D
		if col and col.shape is CylinderShape3D:
			var cyl := col.shape as CylinderShape3D
			cyl.radius = roller_radius
			cyl.height = conveyor_width

	# Set angular velocity for belt physics.
	for body in [_end_body1, _end_body2]:
		if not body:
			continue
		if EditorInterface.is_simulation_running() and _linear_speed != 0:
			var local_front: Vector3 = body.global_transform.basis.z.normalized()
			var vel: Vector3 = local_front * _linear_speed / roller_radius
			body.constant_angular_velocity = vel
		else:
			body.constant_angular_velocity = Vector3.ZERO


func _update_side_guards() -> void:
	var parent_node = get_parent()
	if parent_node:
		var side_guards = parent_node.get_node_or_null("SideGuardsCBC")
		if side_guards and side_guards.has_method("update_for_curved_conveyor"):
			side_guards.update_for_curved_conveyor(inner_radius, conveyor_width, size, conveyor_angle)


func _update_assembly_components() -> void:
	var parent_node = get_parent()
	if not parent_node:
		return

	if parent_node.has_method("update_attachments_for_curved_conveyor"):
		parent_node.update_attachments_for_curved_conveyor(inner_radius, conveyor_width, size, conveyor_angle)
	else:
		var legs_assembly = parent_node.get_node_or_null("ConveyorLegsAssembly")
		if not legs_assembly:
			legs_assembly = parent_node.get_node_or_null("%ConveyorLegsAssembly")

		if legs_assembly and legs_assembly.has_method("update_for_curved_conveyor"):
			legs_assembly.update_for_curved_conveyor(inner_radius, conveyor_width, size, conveyor_angle)


func update_visible_meshes() -> void:
	if not is_inside_tree():
		return

	if _mesh_regeneration_needed:
		_create_conveyor_mesh()
		_setup_collision_shape()
		_mesh_regeneration_needed = false
		_last_size = size


func _create_conveyor_mesh() -> void:
	var angle_radians: float = deg_to_rad(conveyor_angle)
	var radius_inner: float = inner_radius
	var radius_outer: float = inner_radius + conveyor_width

	var arc_segments := maxi(1, int(conveyor_angle / 3.0))
	const DEFAULT_HEIGHT_RATIO: float = 0.50
	var height: float = DEFAULT_HEIGHT_RATIO * belt_height

	var belt_mesh := ArrayMesh.new()

	_setup_materials()

	# Build belt as a single continuous loop (matching straight belt approach).
	_build_belt_loop(belt_mesh, angle_radians, radius_inner, radius_outer,
			height, arc_segments, MESH_SCALE_FACTOR)

	curved_mesh.mesh = belt_mesh
	curved_mesh.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	var base_scale := 1.0 / MESH_SCALE_FACTOR
	curved_mesh.scale = Vector3(base_scale, 1.0, base_scale)

	# Frame rails on a separate mesh so they cast shadows (matching curved roller pattern).
	if _frame_mesh_instance:
		var frame_mesh := ArrayMesh.new()
		_add_curved_frame_surface(frame_mesh, angle_radians, radius_inner, radius_outer,
				height, arc_segments, MESH_SCALE_FACTOR)
		_frame_mesh_instance.mesh = frame_mesh
		_frame_mesh_instance.scale = Vector3(base_scale, 1.0, base_scale)

	if _shadow_plate:
		_shadow_plate.mesh = ConveyorFrameMesh.create_arc_shadow_mesh(angle_radians, radius_inner, radius_outer, arc_segments)
		_shadow_plate.position.y = -height


static var _belt_texture_res: Texture2D = preload("res://assets/3DModels/Textures/4K-fabric_39-diffuse.jpg")
static var _belt_texture_alt: Texture2D = preload("res://assets/3DModels/Textures/ConvBox_Conv_text__arrows_1024.png")

func _setup_materials() -> void:
	if not _belt_material:
		_belt_material = ShaderMaterial.new()
		_belt_material.shader = BELT_SHADER
		_belt_material.set_shader_parameter("belt_texture", _belt_texture_res)
		_belt_material.set_shader_parameter("belt_texture_alt", _belt_texture_alt)
	_belt_material.set_shader_parameter("ColorMix", belt_color)
	_belt_material.set_shader_parameter("use_alternate_texture", belt_texture == BeltConveyor.ConvTexture.ALTERNATE)
	_update_belt_material_scale()

	if not _metal_material:
		_metal_material = ConveyorFrameMesh.create_material()

## Build the belt as a single continuous loop: back roller → top along arc →
## front roller → bottom along arc (reversed). One surface, continuous UVs,
## smooth normals at the rollers — matching how the straight belt is built.
func _build_belt_loop(mesh_instance: ArrayMesh, angle_radians: float,
		r_inner: float, r_outer: float, height: float,
		arc_segments: int, sf: float) -> void:
	const ROLLER_SEGS: int = 12

	var y_radius: float = height / 2.0
	var center_y: float = -y_radius
	var fixed_roller_r: float = height / 2.0
	var tangent_r: float = fixed_roller_r * 2.0  # XZ needs 2x to compensate mesh scale.
	var hw: float = (r_outer - r_inner) / 2.0
	var avg_r: float = (r_inner + r_outer) / 2.0

	# Total belt loop distance for UV normalization.
	var belt_arc: float = avg_r * angle_radians
	var roller_arc: float = y_radius * PI
	var total_belt: float = roller_arc + belt_arc + roller_arc + belt_arc

	var verts := PackedVector3Array()
	var norms := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()
	var dist: float = 0.0

	# Helper: add one row of vertices (inner + outer) at the given position.
	var _add_row := func(pos_inner: Vector3, pos_outer: Vector3, normal: Vector3, belt_dist: float) -> void:
		var u: float = belt_dist / total_belt
		verts.append(pos_inner)
		norms.append(normal)
		uvs.append(Vector2(u, 1))
		verts.append(pos_outer)
		norms.append(normal)
		uvs.append(Vector2(u, 0))

	# --- 1. Back roller at arc start (angle=0). Sweeps bottom→top. ---
	# At angle=0: belt travel direction is -X, so the back roller extends in +X.
	# Tangent here is negated travel direction (points backward into roller).
	var start_tangent := Vector3(-1, 0, 0)
	var start_radial := Vector3(0, 0, 1)    # Radial at angle 0 = +Z.
	var start_center_xz := Vector3(0, 0, avg_r)
	for i in range(ROLLER_SEGS + 1):
		var t: float = float(i) / ROLLER_SEGS
		var cyl_angle: float = PI * (1.0 - t)  # PI (bottom) → 0 (top).
		var y_off: float = center_y + cos(cyl_angle) * y_radius
		var tang_off: float = -sin(cyl_angle) * tangent_r
		var xz_ps: Vector3 = start_center_xz + start_tangent * tang_off
		var norm := (start_tangent * (-sin(cyl_angle)) + Vector3(0, cos(cyl_angle), 0)).normalized()
		var inner_xz: Vector3 = (xz_ps - start_radial * hw) * sf
		var outer_xz: Vector3 = (xz_ps + start_radial * hw) * sf
		_add_row.call(
			Vector3(inner_xz.x, y_off * sf, inner_xz.z),
			Vector3(outer_xz.x, y_off * sf, outer_xz.z),
			norm, dist + t * roller_arc)
	dist += roller_arc

	# --- 2. Flat top surface along the arc. ---
	for ai in range(arc_segments + 1):
		var arc_t: float = float(ai) / arc_segments
		var angle: float = arc_t * angle_radians
		var sin_a: float = sin(angle)
		var cos_a: float = cos(angle)
		var inner_pos := Vector3(-sin_a * r_inner, 0.0, cos_a * r_inner) * sf
		var outer_pos := Vector3(-sin_a * r_outer, 0.0, cos_a * r_outer) * sf
		_add_row.call(inner_pos, outer_pos, Vector3.UP, dist + arc_t * belt_arc)
	dist += belt_arc

	# --- 3. Front roller at arc end. Sweeps top→bottom. ---
	var end_sin: float = sin(angle_radians)
	var end_cos: float = cos(angle_radians)
	var end_tangent := Vector3(-end_cos, 0, -end_sin)
	var end_radial := Vector3(-end_sin, 0, end_cos)
	var end_center_xz := Vector3(-end_sin * avg_r, 0, end_cos * avg_r)
	for i in range(ROLLER_SEGS + 1):
		var t: float = float(i) / ROLLER_SEGS
		var cyl_angle: float = PI * t  # 0 (top) → PI (bottom).
		var y_off: float = center_y + cos(cyl_angle) * y_radius
		var tang_off: float = sin(cyl_angle) * tangent_r
		var xz_ps: Vector3 = end_center_xz + end_tangent * tang_off
		var norm := (end_tangent * sin(cyl_angle) + Vector3(0, cos(cyl_angle), 0)).normalized()
		var inner_xz: Vector3 = (xz_ps - end_radial * hw) * sf
		var outer_xz: Vector3 = (xz_ps + end_radial * hw) * sf
		_add_row.call(
			Vector3(inner_xz.x, y_off * sf, inner_xz.z),
			Vector3(outer_xz.x, y_off * sf, outer_xz.z),
			norm, dist + t * roller_arc)
	dist += roller_arc

	# --- 4. Flat bottom surface along the arc (reversed direction). ---
	var y_bottom: float = -height * sf
	for ai in range(arc_segments + 1):
		var arc_t: float = float(ai) / arc_segments
		var angle: float = (1.0 - arc_t) * angle_radians  # Reversed direction.
		var sin_a: float = sin(angle)
		var cos_a: float = cos(angle)
		var inner_pos := Vector3(-sin_a * r_inner * sf, y_bottom, cos_a * r_inner * sf)
		var outer_pos := Vector3(-sin_a * r_outer * sf, y_bottom, cos_a * r_outer * sf)
		_add_row.call(inner_pos, outer_pos, Vector3.DOWN, dist + arc_t * belt_arc)
	dist += belt_arc

	# Connect all adjacent rows with triangle strips.
	var row_count: int = verts.size() / 2
	for i in range(row_count - 1):
		var idx: int = i * 2
		_add_triangle(indices, idx, idx + 2, idx + 1)
		_add_triangle(indices, idx + 1, idx + 2, idx + 3)

	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_NORMAL] = norms
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices
	mesh_instance.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	mesh_instance.surface_set_material(mesh_instance.get_surface_count() - 1, _belt_material)


## Add curved frame plates (inner + outer vertical walls) as a separate mesh surface.
func _add_curved_frame_surface(mesh_instance: ArrayMesh, angle_radians: float,
		r_inner: float, r_outer: float, height: float, segments: int, sf: float) -> void:
	var y_top: float = 0.0
	var y_bottom: float = -height * sf

	# Curved frame plates (inner + outer walls).
	var frame_mesh := ConveyorFrameMesh.create_curved(
			r_inner, r_outer, y_top, y_bottom, angle_radians, segments, sf)
	frame_mesh.surface_set_material(0, _metal_material)

	# Copy frame surface into the combined mesh.
	var frame_arrays := frame_mesh.surface_get_arrays(0)
	mesh_instance.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, frame_arrays)
	mesh_instance.surface_set_material(mesh_instance.get_surface_count() - 1, _metal_material)

	# End side walls (close the inner/outer gaps at each arc endpoint).
	var fixed_roller_r: float = height / 2.0
	var tangent_r: float = fixed_roller_r * 2.0
	ConveyorFrameMesh.add_curved_end_walls(mesh_instance,
			r_inner, r_outer, y_top, y_bottom, angle_radians,
			tangent_r, sf, _metal_material)


static func _add_triangle(array_indices: PackedInt32Array, a: int, b: int, c: int) -> void:
	array_indices.append_array([a, b, c])


func _setup_collision_shape() -> void:
	var collision_shape: CollisionShape3D = $StaticBody3D.get_node_or_null("CollisionShape3D") as CollisionShape3D
	assert(collision_shape != null, "CollisionShape3D node is missing!")

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

	var inv_sf := 1.0 / MESH_SCALE_FACTOR
	var scaled_verts = PackedVector3Array()
	for vert in triangle_verts:
		scaled_verts.append(Vector3(vert.x * inv_sf, vert.y, vert.z * inv_sf))

	var shape: ConcavePolygonShape3D = collision_shape.shape
	shape.backface_collision = true
	shape.data = scaled_verts
	collision_shape.position = Vector3.ZERO
	collision_shape.scale = Vector3.ONE
	_sb.position = Vector3.ZERO


func _enter_tree() -> void:

	speed_tag_group_name = OIPCommsSetup.default_tag_group(speed_tag_group_name)
	running_tag_group_name = OIPCommsSetup.default_tag_group(running_tag_group_name)
	EditorInterface.simulation_started.connect(_on_simulation_started)
	EditorInterface.simulation_stopped.connect(_on_simulation_ended)
	OIPCommsSetup.connect_comms(self, _tag_group_initialized, _tag_group_polled)


func _exit_tree() -> void:
	EditorInterface.simulation_started.disconnect(_on_simulation_started)
	EditorInterface.simulation_stopped.disconnect(_on_simulation_ended)
	OIPCommsSetup.disconnect_comms(self, _tag_group_initialized, _tag_group_polled)


func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		set_notify_local_transform(false)
		# Ensure uniform scale on X and Z axes
		if scale != Vector3(scale.x, 1, scale.x):
			scale = Vector3(scale.x, 1, scale.x)
		set_notify_local_transform(true)

func _recalculate_speeds() -> void:
	var direction := -1.0 if reverse_belt else 1.0
	var effective_speed := speed * direction
	var outer_radius_val: float = inner_radius + conveyor_width
	var reference_radius: float = outer_radius_val - reference_distance
	_angular_speed = 0.0 if absf(reference_radius) < 1e-6 else effective_speed / reference_radius

	var center_radius: float = (inner_radius + outer_radius_val) / 2.0
	_linear_speed = _angular_speed * center_radius

	_update_belt_ends()

func _physics_process(delta: float) -> void:
	if EditorInterface.is_simulation_running():
		var local_up = _sb.global_transform.basis.y.normalized()
		var velocity = -local_up * _angular_speed
		_sb.constant_angular_velocity = velocity
		if not EditorInterface.is_simulation_paused():
			_belt_position = fmod(_belt_position + _linear_speed * delta, 1.0)
		if _linear_speed != 0:
			(_belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", _belt_position)


func _update_belt_material_scale() -> void:
	if _belt_material:
		# Scale based on total belt loop length so chevron size matches straight conveyors.
		# UV now spans the full loop (roller + arc + roller + arc), not just one arc.
		var avg_r: float = inner_radius + conveyor_width / 2.0
		var belt_arc: float = avg_r * deg_to_rad(conveyor_angle)
		const DEFAULT_HEIGHT_RATIO: float = 0.50
		var y_radius: float = (DEFAULT_HEIGHT_RATIO * belt_height) / 2.0
		var roller_arc: float = y_radius * PI
		var total_belt: float = roller_arc + belt_arc + roller_arc + belt_arc
		var scale_value: float = max(1.0, total_belt)
		(_belt_material as ShaderMaterial).set_shader_parameter("Scale", scale_value)


func _on_simulation_started() -> void:
	_update_belt_ends()

	if enable_comms:
		_speed_tag.register(speed_tag_group_name, speed_tag_name)
		_running_tag.register(running_tag_group_name, running_tag_name)


func _on_simulation_ended() -> void:
	_belt_position = 0.0
	if _belt_material and _belt_material is ShaderMaterial:
		(_belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", _belt_position)

	if _sb:
		_sb.constant_angular_velocity = Vector3.ZERO
	for body in [_end_body1, _end_body2]:
		if body:
			body.constant_angular_velocity = Vector3.ZERO


func _tag_group_initialized(tag_group_name_param: String) -> void:
	_speed_tag.on_group_initialized(tag_group_name_param)
	_running_tag.on_group_initialized(tag_group_name_param)


func _tag_group_polled(tag_group_name_param: String) -> void:
	if not enable_comms:
		return

	if _speed_tag.matches_group(tag_group_name_param):
		speed = _speed_tag.read_float32()
