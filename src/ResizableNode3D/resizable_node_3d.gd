class_name ResizableNode3D
extends Node3D

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


func _notification(what: int):
	# Custom notification number.
	# This would be better implemented in the engine.
	const NOTIFICATION_OWNER_SCENE_INSTANTIATED = 9999
	match what:
		NOTIFICATION_SCENE_INSTANTIATED:
			_on_scene_instantiated()
			# Walk the tree to send NOTIFICATION_OWNER_SCENE_INSTANTIATED
			var nodes_remaining: Array[Node] = get_children(true)
			while nodes_remaining:
				var descendent = nodes_remaining.pop_front()
				nodes_remaining.append_array(descendent.get_children(true))
				if descendent.owner == self:
					descendent.notification(NOTIFICATION_OWNER_SCENE_INSTANTIATED)
		NOTIFICATION_OWNER_SCENE_INSTANTIATED:
			_on_owner_scene_instantiated()


func _on_scene_instantiated() -> void:
	_on_instantiated()


func _on_owner_scene_instantiated() -> void:
	_on_instantiated()


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
