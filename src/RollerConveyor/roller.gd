@tool
class_name Roller
extends Node3D

const RADIUS: float = 0.12
const BASE_LENGTH: float = 2.0
const BASE_CYLINDER_LENGTH: float = 0.935097 * 2.0

var _speed: float = 0.0
var _global_front: Vector3 = Vector3.ZERO
var _static_body: StaticBody3D
var _collision_shape: CollisionShape3D
var _left_end_mesh: MeshInstance3D
var _right_end_mesh: MeshInstance3D
var _cylinder_mesh: MeshInstance3D

func _enter_tree() -> void:
	set_notify_transform(true)
	_update_global_front()
	_update_physics()

func _exit_tree() -> void:
	set_notify_transform(false)

func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSFORM_CHANGED:
		_update_global_front()

func set_speed(new_speed: float) -> void:
	_speed = new_speed
	_update_physics()

func set_length(length: float) -> void:
	_ensure_node_references_initialized()
	_left_end_mesh.position = Vector3(0, 0, -length / BASE_LENGTH)
	_right_end_mesh.position = Vector3(0, 0, length / BASE_LENGTH)

	var cylinder_margins: float = BASE_LENGTH - BASE_CYLINDER_LENGTH
	var new_cylinder_length: float = length - cylinder_margins
	_cylinder_mesh.scale = Vector3(1, 1, new_cylinder_length / BASE_CYLINDER_LENGTH)

	if _collision_shape and _collision_shape.shape is CylinderShape3D:
		var cylinder_shape = _collision_shape.shape as CylinderShape3D
		cylinder_shape.height = new_cylinder_length

func set_roller_override_material(material: Material) -> void:
	_ensure_node_references_initialized()
	_left_end_mesh.set_surface_override_material(0, material)
	_right_end_mesh.set_surface_override_material(0, material)
	_cylinder_mesh.set_surface_override_material(0, material)

func _update_global_front() -> void:
	if not is_inside_tree():
		return
	var new_global_front: Vector3 = global_basis.z.normalized()
	if _global_front != new_global_front:
		_global_front = new_global_front
		_update_physics()

func _ensure_node_references_initialized() -> void:
	if _static_body == null:
		_static_body = get_node("StaticBody3D") as StaticBody3D
	if _collision_shape == null:
		_collision_shape = get_node("StaticBody3D/CollisionShape3D") as CollisionShape3D
	if _left_end_mesh == null:
		_left_end_mesh = get_node("RollerMeshes/RollerEndL") as MeshInstance3D
	if _right_end_mesh == null:
		_right_end_mesh = get_node("RollerMeshes/RollerEndR") as MeshInstance3D
	if _cylinder_mesh == null:
		_cylinder_mesh = get_node("RollerMeshes/RollerLength") as MeshInstance3D

func _update_physics() -> void:
	_ensure_node_references_initialized()
	_static_body.constant_angular_velocity = -_global_front * _speed / RADIUS
