@tool
class_name TrailerDoor
extends Node3D

@export_group("Dimensions")
@export_range(1.5, 5.0, 0.1) var width: float = 2.6:
	set(value):
		width = value
		_rebuild()
@export_range(1.5, 5.0, 0.1) var height: float = 2.8:
	set(value):
		height = value
		_rebuild()
@export_range(0.02, 0.2, 0.01) var wall_thickness: float = 0.08:
	set(value):
		wall_thickness = value
		_rebuild()

@export_group("Door")
@export var open: bool = true:
	set(value):
		open = value
		_animate_door()
@export_range(0.1, 3.0, 0.1) var animation_time: float = 1.5

@export_group("Hole Cutter")
@export var cut_hole: bool = true:
	set(value):
		cut_hole = value
		_update_hole_params()
@export_range(0.0, 4.0, 0.1) var hole_depth: float = 1.5:
	set(value):
		hole_depth = value
		_update_hole_params()
@export_range(0.0, 1.0, 0.05) var hole_margin: float = 0.1:
	set(value):
		hole_margin = value
		_update_hole_params()

@export_group("Snapping")
@export_range(0.0, 0.5, 0.01) var dock_gap: float = 0.05

var _frame: Node3D
var _panels: Node3D
var _door_tween: Tween


func _enter_tree() -> void:
	set_notify_transform(true)


func _ready() -> void:
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
	if _door_tween and _door_tween.is_valid():
		_door_tween.kill()
	for child in get_children():
		child.queue_free()
	_frame = null
	_panels = null
	_build()
	_update_hole_params()


func _build() -> void:
	var door_mat := StandardMaterial3D.new()
	door_mat.albedo_color = Color(0.72, 0.72, 0.76)
	door_mat.metallic = 0.75
	door_mat.roughness = 0.38

	var hardware_mat := StandardMaterial3D.new()
	hardware_mat.albedo_color = Color(0.12, 0.12, 0.13)
	hardware_mat.metallic = 0.9
	hardware_mat.roughness = 0.3

	_build_frame(hardware_mat)
	_build_panels(door_mat, hardware_mat)


func _build_frame(hardware_mat: Material) -> void:
	_frame = Node3D.new()
	_frame.name = "Frame"
	add_child(_frame)

	var t := wall_thickness
	var door_w := width - 0.04
	for side: int in [-1, 1]:
		var guide := MeshInstance3D.new()
		guide.name = "Guide" + ("L" if side < 0 else "R")
		var gm := BoxMesh.new()
		gm.size = Vector3(t * 0.8, height, 0.04)
		guide.mesh = gm
		guide.material_override = hardware_mat
		guide.position = Vector3(0, height * 0.5, side * (door_w * 0.5 + 0.02))
		_frame.add_child(guide)


func _build_panels(door_mat: Material, hardware_mat: Material) -> void:
	_panels = Node3D.new()
	_panels.name = "Panels"
	_panels.position = _panels_target_position()
	add_child(_panels)

	var t := wall_thickness
	var door_w := width - 0.04
	var panel_count: int = max(6, int(round(height / 0.25)))
	var panel_h := height / panel_count
	var rib_depth := 0.025
	var rib_h := panel_h * 0.12

	var backing := MeshInstance3D.new()
	backing.name = "Backing"
	var bm := BoxMesh.new()
	bm.size = Vector3(t * 0.6, height, door_w)
	backing.mesh = bm
	backing.material_override = door_mat
	backing.position = Vector3(-t * 0.2, 0, 0)
	_panels.add_child(backing)

	for i in panel_count:
		var y_center := -height * 0.5 + panel_h * (i + 0.5)
		var panel := MeshInstance3D.new()
		panel.name = "Panel%d" % i
		var pm := BoxMesh.new()
		pm.size = Vector3(t * 0.5, panel_h - rib_h, door_w)
		panel.mesh = pm
		panel.material_override = door_mat
		panel.position = Vector3(t * 0.15, y_center + rib_h * 0.5, 0)
		_panels.add_child(panel)

		var rib := MeshInstance3D.new()
		rib.name = "Rib%d" % i
		var rm := BoxMesh.new()
		rm.size = Vector3(rib_depth + t * 0.5, rib_h, door_w)
		rib.mesh = rm
		rib.material_override = door_mat
		rib.position = Vector3(t * 0.15 + rib_depth * 0.5, y_center - (panel_h - rib_h) * 0.5, 0)
		_panels.add_child(rib)

	var handle := MeshInstance3D.new()
	handle.name = "Handle"
	var hm := BoxMesh.new()
	hm.size = Vector3(0.05, 0.05, door_w * 0.55)
	handle.mesh = hm
	handle.material_override = hardware_mat
	handle.position = Vector3(t * 0.5 + 0.04, -height * 0.15, 0)
	_panels.add_child(handle)

	for side: int in [-1, 1]:
		var bracket := MeshInstance3D.new()
		bracket.name = "HandleBracket" + ("L" if side < 0 else "R")
		var brm := BoxMesh.new()
		brm.size = Vector3(0.06, 0.08, 0.04)
		bracket.mesh = brm
		bracket.material_override = hardware_mat
		bracket.position = Vector3(t * 0.35, -height * 0.15, side * door_w * 0.28)
		_panels.add_child(bracket)

	var lock := MeshInstance3D.new()
	lock.name = "Lock"
	var lm := BoxMesh.new()
	lm.size = Vector3(0.05, 0.14, 0.1)
	lock.mesh = lm
	lock.material_override = hardware_mat
	lock.position = Vector3(t * 0.5 + 0.025, -height * 0.22, 0)
	_panels.add_child(lock)

	var keyhole := MeshInstance3D.new()
	keyhole.name = "Keyhole"
	var km := CylinderMesh.new()
	km.top_radius = 0.015
	km.bottom_radius = 0.015
	km.height = 0.02
	keyhole.mesh = km
	keyhole.material_override = hardware_mat
	keyhole.rotation_degrees = Vector3(0, 0, 90)
	keyhole.position = Vector3(t * 0.5 + 0.08, -height * 0.22, 0)
	_panels.add_child(keyhole)


func _panels_target_position() -> Vector3:
	var y_closed := height * 0.5
	var y_open := height * 1.5 + hole_margin
	return Vector3(0, y_open if open else y_closed, 0)


func _animate_door() -> void:
	if not is_node_ready():
		return
	if _panels == null or not is_instance_valid(_panels):
		return
	if _door_tween and _door_tween.is_valid():
		_door_tween.kill()
	_door_tween = create_tween()
	_door_tween.tween_property(_panels, "position", _panels_target_position(), animation_time)


func _update_hole_params() -> void:
	if not is_node_ready():
		return
	if has_meta("is_preview"):
		return
	if not cut_hole:
		_clear_hole_params()
		return
	var half := Vector3(hole_depth * 0.5, height * 0.5 + hole_margin, width * 0.5 + hole_margin)
	var center_local := Vector3(0, height * 0.5, 0)
	var center_world := global_transform * center_local
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
	open = not open


func dock_anchor() -> Vector3:
	return global_transform * Vector3(wall_thickness * 0.5 + dock_gap, 0, 0)


func dock_outward_axis() -> Vector3:
	return global_transform.basis.x.normalized()


func _get_custom_preview_node() -> Node3D:
	var preview_scene := load("res://src/TrailerDoor/TrailerDoor.tscn") as PackedScene
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
