@tool
class_name SideGuard
extends MeshInstance3D

## Show the left end cap of the side guard.
@export var left_end: bool = false:
	set(value):
		left_end = value
		if l_end:
			l_end.visible = value

## Show the right end cap of the side guard.
@export var right_end: bool = false:
	set(value):
		right_end = value
		if r_end:
			r_end.visible = value

## Length of the side guard in meters.
@export var length: float = 1.0:
	set(value):
		length = value
		if length != 0:
			if scale.x != length:
				scale = Vector3(length, scale.y, scale.z)
			if get_metal_material():
				get_metal_material().set_shader_parameter("Scale", length)
			if l_end:
				l_end.scale = Vector3(1 / length, 1, 1)
			if r_end:
				r_end.scale = Vector3(1 / length, 1, 1)

var _metal_material: ShaderMaterial = null
var prev_scale: Vector3

@onready var _l_end: Node3D = get_node("Ends/SideGuardEndL")
@onready var _r_end: Node3D = get_node("Ends/SideGuardEndR")

var l_end: Node3D:
	get:
		return _l_end

var r_end: Node3D:
	get:
		return _r_end


func _enter_tree() -> void:
	set_notify_local_transform(true)


func _ready() -> void:
	get_metal_material()


func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		length = scale.x


func get_metal_material() -> ShaderMaterial:
	if _metal_material:
		return _metal_material
		
	var mesh_instance := self
	_metal_material = mesh_instance.mesh.surface_get_material(0).duplicate() as ShaderMaterial
	mesh_instance.set_surface_override_material(0, _metal_material)
	return _metal_material
