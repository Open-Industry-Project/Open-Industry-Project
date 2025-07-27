@tool
class_name ConveyorLeg
extends Node3D

@export_range(-60, 60, 0.1) var grabs_rotation: float = 0.0:
	set(value):
		grabs_rotation = value
		on_grabs_updated()

var top: MeshInstance3D
var legs_sides_material: ShaderMaterial
var prev_scale: Vector3

@onready var grab1: MeshInstance3D = get_node("Ends/LegsTop1/LegsGrab1")
@onready var grab2: MeshInstance3D = get_node("Ends/LegsTop2/LegsGrab2")
@onready var legs_sides_mesh1: MeshInstance3D = get_node("Sides/LegsSide1")
@onready var legs_sides_mesh2: MeshInstance3D = get_node("Sides/LegsSide2")
@onready var legs_bars: LegBars = get_node("LegsBars")
@onready var ends: Node3D = get_node("Ends")

func _init() -> void:
	set_notify_local_transform(true)

func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		var constrained_scale: Vector3 = constrain_scale()
		if constrained_scale != scale:
			scale = constrained_scale
		on_scale_changed()

func setup_references() -> void:
	# Node references are now handled by @onready variables
	if legs_sides_material == null and legs_sides_mesh1:
		legs_sides_material = legs_sides_mesh1.mesh.surface_get_material(0) as ShaderMaterial
		legs_sides_mesh1.mesh.surface_set_material(0, legs_sides_material)

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
	if ends:
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
