@tool
class_name Trailer
extends Node3D

@export_group("Dimensions")
@export_range(4.0, 20.0, 0.1) var length: float = 12.0:
	set(value):
		length = value
		_rebuild()
@export_range(2.0, 4.0, 0.1) var width: float = 2.6:
	set(value):
		width = value
		_rebuild()
@export_range(2.0, 4.0, 0.1) var height: float = 2.8:
	set(value):
		height = value
		_rebuild()
@export_range(0.02, 0.2, 0.01) var wall_thickness: float = 0.08:
	set(value):
		wall_thickness = value
		_rebuild()

@export_group("Hole Cutter")
## Cuts a hole through building walls at the rear opening using a global shader.
@export var cut_wall_hole: bool = true:
	set(value):
		cut_wall_hole = value
		_update_hole_params()
## Extra depth (m) the hole reaches into the wall, in case the wall is thick.
@export_range(0.0, 4.0, 0.1) var hole_depth: float = 1.5:
	set(value):
		hole_depth = value
		_update_hole_params()
## Extra margin (m) around the opening when cutting the hole.
@export_range(0.0, 1.0, 0.05) var hole_margin: float = 0.1:
	set(value):
		hole_margin = value
		_update_hole_params()

@export_group("Appearance")
@export var body_color: Color = Color(0.85, 0.85, 0.88):
	set(value):
		body_color = value
		_update_colors()
@export var interior_color: Color = Color(0.55, 0.4, 0.28):
	set(value):
		interior_color = value
		_update_colors()

var _body: Node3D
var _static_body: StaticBody3D
var _body_mat: StandardMaterial3D
var _interior_mat: StandardMaterial3D


func _enter_tree() -> void:
	set_notify_transform(true)


func _ready() -> void:
	_body = $Body
	_static_body = $StaticBody3D
	_body_mat = StandardMaterial3D.new()
	_body_mat.roughness = 0.6
	_body_mat.metallic = 0.3
	_interior_mat = StandardMaterial3D.new()
	_interior_mat.roughness = 0.9
	_update_colors()
	_rebuild()
	_update_hole_params()


func _exit_tree() -> void:
	if not has_meta("is_preview"):
		_clear_hole_params()


func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSFORM_CHANGED:
		_update_hole_params()


func _rebuild() -> void:
	if not is_node_ready():
		return
	_build_body()
	_build_collisions()
	_update_hole_params()


func _update_colors() -> void:
	if _body_mat:
		_body_mat.albedo_color = body_color
	if _interior_mat:
		_interior_mat.albedo_color = interior_color


func _build_body() -> void:
	for child in _body.get_children():
		child.queue_free()

	var t := wall_thickness
	_add_wall(_body, "Floor", Vector3(length, t, width), Vector3(0, t * 0.5, 0), _interior_mat)
	_add_wall(_body, "Ceiling", Vector3(length, t, width), Vector3(0, height - t * 0.5, 0), _body_mat)
	_add_wall(_body, "LeftWall", Vector3(length, height, t),
			Vector3(0, height * 0.5, -width * 0.5 + t * 0.5), _body_mat)
	_add_wall(_body, "RightWall", Vector3(length, height, t),
			Vector3(0, height * 0.5, width * 0.5 - t * 0.5), _body_mat)
	# Front wall (-X, tractor end). Rear (+X) is open.
	_add_wall(_body, "FrontWall", Vector3(t, height, width),
			Vector3(-length * 0.5 + t * 0.5, height * 0.5, 0), _body_mat)

	_add_wheels()


func _add_wall(parent: Node3D, nm: String, size: Vector3, pos: Vector3, mat: Material) -> void:
	var mi := MeshInstance3D.new()
	mi.name = nm
	var m := BoxMesh.new()
	m.size = size
	mi.mesh = m
	mi.position = pos
	mi.material_override = mat
	parent.add_child(mi)


func _add_wheels() -> void:
	var axle_offsets := [length * 0.5 - 1.2, length * 0.5 - 2.4]
	var side_z := width * 0.5 + 0.15
	var wheel_mat := StandardMaterial3D.new()
	wheel_mat.albedo_color = Color(0.08, 0.08, 0.09)
	wheel_mat.roughness = 0.9
	for ax in axle_offsets:
		for z in [-side_z, side_z]:
			var mi := MeshInstance3D.new()
			mi.name = "Wheel"
			var cyl := CylinderMesh.new()
			cyl.top_radius = 0.45
			cyl.bottom_radius = 0.45
			cyl.height = 0.28
			mi.mesh = cyl
			mi.rotation_degrees = Vector3(90, 0, 0)
			mi.position = Vector3(ax, -0.45, z)
			mi.material_override = wheel_mat
			_body.add_child(mi)


func _build_collisions() -> void:
	for child in _static_body.get_children():
		child.queue_free()

	var t := wall_thickness
	_add_collision("Floor", Vector3(length, t, width), Vector3(0, t * 0.5, 0))
	_add_collision("Ceiling", Vector3(length, t, width), Vector3(0, height - t * 0.5, 0))
	_add_collision("LeftWall", Vector3(length, height, t),
			Vector3(0, height * 0.5, -width * 0.5 + t * 0.5))
	_add_collision("RightWall", Vector3(length, height, t),
			Vector3(0, height * 0.5, width * 0.5 - t * 0.5))
	_add_collision("FrontWall", Vector3(t, height, width),
			Vector3(-length * 0.5 + t * 0.5, height * 0.5, 0))


func _add_collision(nm: String, size: Vector3, pos: Vector3) -> void:
	var cs := CollisionShape3D.new()
	cs.name = nm
	var shape := BoxShape3D.new()
	shape.size = size
	cs.shape = shape
	cs.position = pos
	_static_body.add_child(cs)


func _update_hole_params() -> void:
	if not is_node_ready():
		return
	if has_meta("is_preview"):
		return
	if not cut_wall_hole:
		_clear_hole_params()
		return
	# Rear opening sits at +X end of trailer in local space.
	var rear_local := Vector3(length * 0.5, height * 0.5, 0.0)
	var center_world := global_transform * rear_local
	var half := Vector3(hole_depth * 0.5, height * 0.5 + hole_margin, width * 0.5 + hole_margin)
	var basis_abs := Basis(
		global_transform.basis.x.abs(),
		global_transform.basis.y.abs(),
		global_transform.basis.z.abs()
	)
	var world_half := basis_abs * half
	RenderingServer.global_shader_parameter_set("trailer_hole_center", center_world)
	RenderingServer.global_shader_parameter_set("trailer_hole_half_extents", world_half)
	RenderingServer.global_shader_parameter_set("trailer_hole_active", 1.0)


func _clear_hole_params() -> void:
	RenderingServer.global_shader_parameter_set("trailer_hole_active", 0.0)


func use() -> void:
	cut_wall_hole = not cut_wall_hole


func _get_custom_preview_node() -> Node3D:
	var preview_scene := load("res://parts/Trailer.tscn") as PackedScene
	var preview_node := preview_scene.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED) as Node3D
	preview_node.set_meta("is_preview", true)
	_disable_collisions_recursive(preview_node)
	return preview_node


func _disable_collisions_recursive(node: Node) -> void:
	if node is CollisionShape3D:
		node.disabled = true
	if node is CollisionObject3D:
		node.collision_layer = 0
		node.collision_mask = 0
	for child in node.get_children():
		_disable_collisions_recursive(child)
