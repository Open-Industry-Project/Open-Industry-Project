@tool
class_name SideGuard
extends MeshInstance3D

const END_CAP_EXTENT: float = 0.25
const CHAMFER_DEPTH: float = 0.02
const CHAMFER_TAPER: float = 0.1

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
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var length: float = 1.0:
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
			_update_collision_shape()

var _metal_material: ShaderMaterial = null

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
	_setup_collision()


func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		length = scale.x


func get_metal_material() -> ShaderMaterial:
	if _metal_material:
		return _metal_material

	_metal_material = mesh.surface_get_material(0).duplicate() as ShaderMaterial
	set_surface_override_material(0, _metal_material)
	return _metal_material


var _collision_half_y: float = 0.301
var _collision_half_z: float = 0.035

func _setup_collision() -> void:
	var collision := get_node_or_null("StaticBody3D/CollisionShape3D") as CollisionShape3D
	if collision and collision.shape is BoxShape3D:
		var box := collision.shape as BoxShape3D
		_collision_half_y = box.size.y / 2.0
		_collision_half_z = box.size.z / 2.0

	_update_collision_shape()


func _update_collision_shape() -> void:
	var collision := get_node_or_null("StaticBody3D/CollisionShape3D") as CollisionShape3D
	if not collision or length == 0.0:
		return

	var half_x := (1.0 + 2.0 * END_CAP_EXTENT / length) / 2.0
	var inner_half_x := half_x - CHAMFER_DEPTH
	var narrow_z := _collision_half_z * CHAMFER_TAPER

	var points := PackedVector3Array()
	for x_sign in [-1.0, 1.0]:
		for y_sign in [-1.0, 1.0]:
			for z_sign in [-1.0, 1.0]:
				points.append(Vector3(
					x_sign * inner_half_x,
					y_sign * _collision_half_y,
					z_sign * _collision_half_z))
				points.append(Vector3(
					x_sign * half_x,
					y_sign * _collision_half_y,
					z_sign * narrow_z))

	var shape := ConvexPolygonShape3D.new()
	shape.points = points
	collision.shape = shape
