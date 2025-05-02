@tool
extends Node3D
class_name AbstractRollerContainer

signal roller_added(roller: Roller)
signal roller_removed(roller: Roller)

signal roller_rotation_changed(rotation: Vector3)

var _roller_skew_angle_degrees: float = 0.0

# Virtual method to be overridden
func _get_rollers() -> Array[Roller]:
	return []

func setup_existing_rollers() -> void:
	for roller in _get_rollers():
		emit_signal("roller_added", roller)

func set_roller_skew_angle(angle_degrees: float) -> void:
	_roller_skew_angle_degrees = angle_degrees
	emit_signal("roller_rotation_changed", _get_rotation_from_skew_angle(angle_degrees))

func set_width(width: float) -> void:
	for roller in _get_rollers():
		roller.set_length(width)

func set_length(_length: float) -> void:
	pass

func on_owner_scale_changed(scale: Vector3) -> void:
	rescale_inverse(scale)

func rescale_inverse(parent_scale: Vector3) -> void:
	scale = Vector3(1.0 / parent_scale.x, 1.0 / parent_scale.y, 1.0 / parent_scale.z)

func _get_rotation_from_skew_angle(angle_degrees: float) -> Vector3:
	return Vector3(0, angle_degrees, 0)
