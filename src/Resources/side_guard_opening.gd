@tool
extends Resource
class_name SideGuardOpening


@export_custom(PROPERTY_HINT_NONE, "suffix:m") var position: float = 0.0:
	set(value):
		var has_changed = position != value
		position = value
		if has_changed:
			emit_changed()
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var size: float = 1.0:
	set(value):
		var has_changed = size != value
		size = value
		if has_changed:
			emit_changed()

func _init(p: float = 0.0, s: float = 1.0) -> void:
	position = p
	size = s
