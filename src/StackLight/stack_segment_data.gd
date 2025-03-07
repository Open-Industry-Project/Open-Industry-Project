@tool
class_name StackSegmentData
extends Resource

signal active_changed(value)
signal color_changed(value)

@export var active: bool = false:
	set(value):
		active = value
		emit_signal("active_changed", active)


@export var segment_color: Color = Color(0.0, 1.0, 0.0, 0.5):
	set(value):
		segment_color = value
		emit_signal("color_changed", segment_color)
