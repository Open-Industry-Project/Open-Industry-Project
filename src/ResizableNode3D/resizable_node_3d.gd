class_name ResizableNode3D
extends EnhancedNode3D

signal size_changed

## Minimum allowed value for the size property.
## The size property will be automatically constrained accordingly.
var SIZE_MIN = Vector3(0.01, 0.01, 0.01)
## Default value for the size property.
var SIZE_DEFAULT = Vector3.ONE
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var size: Vector3 = Vector3.ONE:
	set(value):
		var clamped_size: Vector3 = SIZE_MIN.max(value)
		var constrained_size = _get_constrained_size(clamped_size)
		var has_changed = size != constrained_size
		if has_changed:
			size = constrained_size
			_on_size_changed()
			emit_signal("size_changed")


func _on_instantiated() -> void:
	_on_size_changed()


## Override this to constrain size dimensions relative to each other.
static func _get_constrained_size(new_size: Vector3) -> Vector3:
	return new_size


## Override this to reconfigure nodes when a new value is assigned to the size property.
func _on_size_changed() -> void:
	pass


## Convert existing scale into size.
## Avoids doing anything if size has already been set to a non-default value.
func migrate_scale_to_size():
	if scale == Vector3.ONE:
		return  # scale already reset; nothing to do
	if size != SIZE_DEFAULT:
		return  # size isn't default; assume migration has already happened despite the unexpected scale.
	var scale_original = scale
	scale = Vector3.ONE
	size = scale_original
