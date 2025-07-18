@tool
class_name RollerCorner
extends Node3D

const MODEL_BASE_LENGTH: float = 2.0
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
var _prev_global_basis: Basis = Basis.IDENTITY

@onready var _mesh_instance: MeshInstance3D = $MeshInstance3D
@onready var _static_body: StaticBody3D = $StaticBody3D
@onready var _collision_shape: CollisionShape3D = $StaticBody3D/CollisionShape3D


func _init() -> void:
	set_notify_transform(true)


func _ready() -> void:
	_update_shape_length()
	_update_mesh_length()


func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSFORM_CHANGED and is_inside_tree():
		if _prev_global_basis == global_basis:
			return
		_prev_global_basis = global_basis


func get_material() -> Material:
	return _mesh_instance.mesh.surface_get_material(0)


func set_override_material(material: Material) -> void:
	_mesh_instance.set_surface_override_material(0, material)


func _update_shape_length() -> void:
	var shape: Shape3D = _collision_shape.shape
	var points: PackedVector3Array = MODEL_BASE_SHAPE_POINTS.duplicate()
	for idx in range(points.size()):
		points[idx] *= Vector3(1.0, 1.0, length / MODEL_BASE_LENGTH)
	shape.points = points


func _update_mesh_length() -> void:
	_mesh_instance.scale.z = length / MODEL_BASE_LENGTH
