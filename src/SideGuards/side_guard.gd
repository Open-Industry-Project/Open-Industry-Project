@tool
class_name SideGuard
extends MeshInstance3D

@export var left_end: bool = false:
	set(value):
		left_end = value
		if l_end:
			l_end.visible = value


@export var right_end: bool = false:
	set(value):
		right_end = value
		if r_end:
			r_end.visible = value


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
var _l_end: Node3D = null
var _r_end: Node3D = null

var l_end: Node3D:
	get:
		if _l_end and is_instance_valid(_l_end):
			return _l_end
		_l_end = get_node("Ends/SideGuardEndL") as Node3D
		return _l_end

var r_end: Node3D:
	get:
		if _r_end and is_instance_valid(_r_end):
			return _r_end
		_r_end = get_node("Ends/SideGuardEndR") as Node3D
		return _r_end


func _enter_tree() -> void:
	length = scale.x
	set_notify_local_transform(true)


func _ready() -> void:
	get_metal_material()


func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		length = scale.x


func get_metal_material() -> ShaderMaterial:
	if _metal_material:
		return _metal_material
		
	var mesh_instance = self
	mesh_instance.mesh = mesh_instance.mesh.duplicate()
	_metal_material = mesh_instance.mesh.surface_get_material(0).duplicate() as ShaderMaterial
	mesh_instance.mesh.surface_set_material(0, _metal_material)
	return _metal_material
