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

@export_group("Snapping")
@export var auto_snap_to_door: bool = true
@export_range(0.5, 10.0, 0.1) var snap_distance: float = 3.0

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
var _snapping: bool = false


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


func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSFORM_CHANGED:
		if Engine.is_editor_hint() and auto_snap_to_door \
				and not _snapping and not has_meta("is_preview"):
			_try_snap()


func _rebuild() -> void:
	if not is_node_ready():
		return
	_build_body()
	_build_collisions()


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
	for ax: float in axle_offsets:
		for z: float in [-side_z, side_z]:
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


func use() -> void:
	snap_to_nearest_door()


func snap_to_nearest_door() -> void:
	var door := _find_best_snap_door()
	if door == null:
		return
	var target := _snap_transform_for_door(door)
	_snapping = true
	global_transform = target
	_snapping = false


func _try_snap() -> void:
	var door := _find_best_snap_door()
	if door == null:
		return
	var target := _snap_transform_for_door(door)
	if target.origin.distance_to(global_transform.origin) < 0.001 \
			and target.basis.is_equal_approx(global_transform.basis):
		return
	_snapping = true
	global_transform = target
	_snapping = false


func _snap_transform_for_door(door: TrailerDoor) -> Transform3D:
	var anchor := door.dock_anchor()
	var outward := door.dock_outward_axis()
	# Project outward to horizontal plane so the trailer stays upright even if the door is tilted.
	var horiz := Vector3(outward.x, 0.0, outward.z)
	if horiz.length_squared() < 0.0001:
		horiz = Vector3.FORWARD
	else:
		horiz = horiz.normalized()
	# Trailer's +X is its rear; rear faces the door, so trailer.basis.x = -horiz.
	var x_axis := -horiz
	var z_axis := x_axis.cross(Vector3.UP).normalized()
	var snap_basis := Basis(x_axis, Vector3.UP, z_axis)
	var origin := anchor + horiz * (length * 0.5)
	return Transform3D(snap_basis, origin)


func _find_best_snap_door() -> TrailerDoor:
	var tree := get_tree()
	if tree == null:
		return null
	var root: Node = tree.edited_scene_root if Engine.is_editor_hint() else tree.current_scene
	if root == null:
		return null
	var best: TrailerDoor = null
	var best_dist := snap_distance
	var search_stack: Array[Node] = [root]
	while not search_stack.is_empty():
		var node: Node = search_stack.pop_back()
		if node is TrailerDoor:
			var target := _snap_transform_for_door(node)
			var d := target.origin.distance_to(global_transform.origin)
			if d < best_dist:
				best_dist = d
				best = node
		for child in node.get_children():
			search_stack.push_back(child)
	return best


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
