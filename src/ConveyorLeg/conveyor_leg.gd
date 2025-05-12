@tool
class_name ConveyorLeg
extends Node3D

@export_range(-60, 60, 0.1) var grabs_rotation: float = 0.0:
	set(value):
		grabs_rotation = value
		on_grabs_updated()

var grab1: MeshInstance3D
var grab2: MeshInstance3D
var top: MeshInstance3D
var legs_sides_mesh1: MeshInstance3D
var legs_sides_mesh2: MeshInstance3D
var legs_sides_material: ShaderMaterial
var legs_bars: LegBars
var ends: Node3D
var prev_scale: Vector3

func _init() -> void:
	set_notify_local_transform(true)

func setup_references() -> void:
	if legs_sides_mesh1 == null:
		legs_sides_mesh1 = get_node("Sides/LegsSide1") as MeshInstance3D
	if legs_sides_mesh2 == null:
		legs_sides_mesh2 = get_node("Sides/LegsSide2") as MeshInstance3D
	if legs_sides_material == null and legs_sides_mesh1:
		legs_sides_material = legs_sides_mesh1.mesh.surface_get_material(0) as ShaderMaterial
		legs_sides_mesh1.mesh.surface_set_material(0, legs_sides_material)
	if legs_bars == null:
		legs_bars = get_node("LegsBars") as LegBars
	if ends == null:
		ends = get_node("Ends") as Node3D
	if grab1 == null:
		grab1 = get_node("Ends/LegsTop1/LegsGrab1") as MeshInstance3D
	if grab2 == null:
		grab2 = get_node("Ends/LegsTop2/LegsGrab2") as MeshInstance3D

func constrain_scale() -> Vector3:
	var node_scale_y: float = max(1.0, scale.y)
	var node_scale_z: float = scale.z
	return Vector3(1, node_scale_y, node_scale_z)

func on_scale_changed() -> void:
	if scale == prev_scale:
		return
	
	setup_references()
	if legs_sides_material:
		legs_sides_material.set_shader_parameter("Scale", scale.y)
	if legs_bars and legs_bars.parent_scale != scale:
		legs_bars.parent_scale = scale
	for end in ends.get_children():
		if end is Node3D:
			end.scale = Vector3(1 / scale.x, 1 / scale.y, 1 / scale.z)
	if legs_sides_mesh1:
		legs_sides_mesh1.scale = Vector3(1 / scale.x, 1, 1 / scale.z)
	if legs_sides_mesh2:
		legs_sides_mesh2.scale = Vector3(1 / scale.x, 1, 1 / scale.z)
	prev_scale = scale

func on_grabs_updated() -> void:
	setup_references()
	if grab1:
		grab1.rotation_degrees = Vector3(0, 0, grabs_rotation)
	if grab2:
		grab2.rotation_degrees = Vector3(0, 0, -grabs_rotation)
	if grab1:
		grab1.scale = Vector3.ONE
	if grab2:
		grab2.scale = Vector3.ONE

func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		var constrained_scale: Vector3 = constrain_scale()
		if constrained_scale != scale:
			scale = constrained_scale
		on_scale_changed()
