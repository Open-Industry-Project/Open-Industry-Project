@tool
class_name ConveyorLeg
extends Node3D

@export_range(-60, 60, 0.1, "degrees") var grabs_rotation: float = 0.0:
	set(value):
		grabs_rotation = value
		on_grabs_updated()

var legs_sides_material: ShaderMaterial
var prev_scale: Vector3


func _init() -> void:
	set_notify_local_transform(true)


func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		var constrained_scale: Vector3 = constrain_scale()
		if constrained_scale != scale:
			scale = constrained_scale
		on_scale_changed()


# Resolve nodes lazily — @onready races with drag-from-FileSystem preview's first scale assign.
func _ensure_material() -> void:
	if legs_sides_material != null:
		return
	var side1: MeshInstance3D = get_node_or_null("Sides/LegsSide1") as MeshInstance3D
	if side1 == null or side1.mesh == null:
		return
	var base_mat: ShaderMaterial = side1.mesh.surface_get_material(0) as ShaderMaterial
	if base_mat == null:
		return
	legs_sides_material = base_mat.duplicate() as ShaderMaterial
	side1.set_surface_override_material(0, legs_sides_material)
	var side2: MeshInstance3D = get_node_or_null("Sides/LegsSide2") as MeshInstance3D
	if side2:
		side2.set_surface_override_material(0, legs_sides_material)


func constrain_scale() -> Vector3:
	var node_scale_y: float = max(1.0, scale.y)
	var node_scale_z: float = scale.z
	return Vector3(1, node_scale_y, node_scale_z)


func on_scale_changed() -> void:
	if scale == prev_scale:
		return

	_ensure_material()
	if legs_sides_material:
		legs_sides_material.set_shader_parameter("Scale", scale.y)
	var legs_bars: LegBars = get_node_or_null("LegsBars") as LegBars
	if legs_bars and legs_bars.parent_scale != scale:
		legs_bars.parent_scale = scale
	var ends: Node3D = get_node_or_null("Ends") as Node3D
	if ends:
		var ends_inv := Vector3(1.0 / scale.x, 1.0 / scale.y, 1.0 / scale.z)
		for end in ends.get_children():
			if end is Node3D:
				(end as Node3D).scale = ends_inv
	var sides_inv := Vector3(1.0 / scale.x, 1.0, 1.0 / scale.z)
	var side1: Node3D = get_node_or_null("Sides/LegsSide1") as Node3D
	if side1:
		side1.scale = sides_inv
	var side2: Node3D = get_node_or_null("Sides/LegsSide2") as Node3D
	if side2:
		side2.scale = sides_inv
	prev_scale = scale


func on_grabs_updated() -> void:
	var grab1: MeshInstance3D = get_node_or_null("Ends/LegsTop1/LegsGrab1") as MeshInstance3D
	if grab1:
		grab1.rotation_degrees = Vector3(0, 0, grabs_rotation)
		grab1.scale = Vector3.ONE
	var grab2: MeshInstance3D = get_node_or_null("Ends/LegsTop2/LegsGrab2") as MeshInstance3D
	if grab2:
		grab2.rotation_degrees = Vector3(0, 0, -grabs_rotation)
		grab2.scale = Vector3.ONE
