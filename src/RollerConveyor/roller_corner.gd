@tool
class_name RollerCorner
extends Node3D

const MODEL_BASE_LENGTH := 2.0
const MODEL_BASE_SHAPE_POINTS: PackedVector3Array = preload("res://src/RollerConveyor/roller_corner.shape").points

@export var length: float = MODEL_BASE_LENGTH:
	set(value):
		length = value
		if _collision_shape:
			_update_shape_length()
		if _mesh_instance:
			_update_mesh_length()

var angular_speed: float = 0.0
var uv_speed: float = 0.0

@onready var _mesh_instance: MeshInstance3D = $MeshInstance3D
@onready var _static_body: StaticBody3D = $StaticBody3D
@onready var _collision_shape: CollisionShape3D = $StaticBody3D/CollisionShape3D

var _prev_global_basis: Basis = Basis.IDENTITY


func _init() -> void:
	set_notify_transform(true)


func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSFORM_CHANGED and is_inside_tree():
		if _prev_global_basis == global_basis:
			return
		_prev_global_basis = global_basis
		_try_update_speed()


func _enter_tree() -> void:
	call_deferred("_try_update_speed")


func _ready() -> void:
	_update_shape_length()
	_update_mesh_length()


func _update_shape_length() -> void:
	var shape: Shape3D = _collision_shape.shape
	var points: PackedVector3Array = MODEL_BASE_SHAPE_POINTS.duplicate()
	for idx in range(points.size()):
		points[idx] *= Vector3(1.0, 1.0, length / MODEL_BASE_LENGTH)
	shape.points = points


func _update_mesh_length() -> void:
	_mesh_instance.scale.z = length / MODEL_BASE_LENGTH


func _try_update_speed() -> void:
	if not is_inside_tree():
		return
	var local_front: Vector3 = global_transform.basis.z.normalized()
	_static_body.constant_angular_velocity = local_front * angular_speed


func set_speed(new_speed: float) -> void:
	angular_speed = new_speed
	uv_speed = angular_speed / (2.0 * PI)
	_try_update_speed()


func get_material() -> Material:
	return _mesh_instance.mesh.surface_get_material(0)


func set_override_material(material: Material) -> void:
	_mesh_instance.set_surface_override_material(0, material)
