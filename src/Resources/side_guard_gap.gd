@tool
extends Resource
class_name SideGuardGap

enum SideGuardGapSide {
	Left,
	Right,
	Both
}

@export_custom(PROPERTY_HINT_NONE, "suffix:m") var position: float = 0.0:
	set(value):
		var has_changed = position != value
		position = value
		if has_changed:
			emit_changed()
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var width: float = 1.0:
	set(value):
		var has_changed = width != value
		width = value
		if has_changed:
			emit_changed()
@export var side: SideGuardGapSide = SideGuardGapSide.Left:
	set(value):
		var has_changed = side != value
		side = value
		if has_changed:
			emit_changed()

func _init(pos: float = 0.0, w: float = 1.0) -> void:
	position = pos
	width = w

func _emit_changed() -> void:
	notify_property_list_changed()
