@tool
class_name MultiPlaneSegment
extends Resource

## The length of this conveyor segment in meters.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var length: float = 2.0:
	set(value):
		var has_changed := length != value
		length = maxf(0.5, value)  # Minimum length of 0.5m
		if has_changed:
			emit_changed()

## The incline angle of this segment (positive = upward, negative = downward).
@export_range(-45, 45, 0.1, "radians_as_degrees") var angle: float = 0.0:
	set(value):
		var has_changed := angle != value
		angle = clampf(value, deg_to_rad(-45), deg_to_rad(45))
		if has_changed:
			emit_changed()


func _init(l: float = 2.0, a: float = 0.0) -> void:
	length = l
	angle = a
