@tool
class_name RollerCorner
extends Node3D

var angular_speed: float = 0.0
var uv_speed: float = 0.0

@onready var _mesh_instance: MeshInstance3D = $MeshInstance3D

var _prev_global_basis: Basis = Basis.IDENTITY

func _init() -> void:
	set_notify_transform(true)

func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSFORM_CHANGED and is_inside_tree():
		if _prev_global_basis == global_basis:
			return
		_prev_global_basis = global_basis

func set_speed(new_speed: float) -> void:
	angular_speed = new_speed
	uv_speed = angular_speed / (2.0 * PI)

func get_material() -> Material:
	return _mesh_instance.mesh.surface_get_material(0)

func set_override_material(material: Material) -> void:
	_mesh_instance.set_surface_override_material(0, material)
