class_name ResizableNode3D
extends EnhancedNode3D

signal size_changed

## Minimum allowed value for the size property.
## The size property will be automatically constrained accordingly.
var size_min = Vector3(0.01, 0.01, 0.01)
## Default value for the size property.
var size_default = Vector3.ONE

var original_size := Vector3.ZERO
var transform_in_progress := false
var _scale_notification_cooldown := false

func _init() -> void:
	set_meta("hijack_scale", true)
	set_notify_transform(true)

func _notification(what: int) -> void:
	match what:
		NOTIFICATION_TRANSFORM_CHANGED:
			if scale != Vector3.ONE and not transform_in_progress:
				# Reset scale back to Vector3.ONE
				scale = Vector3.ONE
				
				# Show toast notification (with cooldown to prevent spam)
				if not _scale_notification_cooldown:
					_scale_notification_cooldown = true
					EditorInterface.get_editor_toaster().push_toast(
						"Please use the 'size' property instead of scale.",
						EditorToaster.SEVERITY_WARNING
					)
					# Reset cooldown after a delay
					get_tree().create_timer(1.0).timeout.connect(func(): 
						_scale_notification_cooldown = false
					)

@export_custom(PROPERTY_HINT_NONE, "suffix:m") var size := Vector3.ZERO:
	set(value):
		if value == Vector3.ZERO:
			# Treat zero as a null value.
			if size == Vector3.ZERO:
				size = _get_initial_size()
				return
			value = _get_default_size()
		var clamped_size: Vector3 = size_min.max(value)
		var constrained_size = _get_constrained_size(clamped_size)
		var has_changed = size != constrained_size
		size = constrained_size
		if has_changed and _instance_ready:
			_on_size_changed()
			size_changed.emit()

## Override this to constrain size dimensions relative to each other.
static func _get_constrained_size(new_size: Vector3) -> Vector3:
	return new_size

func _on_instantiated() -> void:
	if size == Vector3.ZERO:
		# Trigger _get_initial_size .
		size = Vector3.ZERO
	else:
		_on_size_changed()
		size_changed.emit()

func _enter_tree() -> void:
	EditorInterface.transform_requested.connect(_transform_requested)
	EditorInterface.transform_commited.connect(_transform_commited)

func _exit_tree() -> void:
	if EditorInterface.transform_requested.is_connected(_transform_requested):
		EditorInterface.transform_requested.disconnect(_transform_requested)
	if EditorInterface.transform_commited.is_connected(_transform_commited):
		EditorInterface.transform_commited.disconnect(_transform_commited)

func _transform_requested(data) -> void:
	if not EditorInterface.get_selection().get_selected_nodes().has(self):
		return
	
	if data.has("motion"):
		var motion = Vector3(data["motion"][0], data["motion"][1], data["motion"][2])
		
		if not transform_in_progress:
			original_size = size
			transform_in_progress = true
		
		var new_size = original_size + motion
		new_size = _get_constrained_size(new_size)	
		size = new_size

func _transform_commited() -> void:
	if transform_in_progress:
		if size != original_size: 
			var undo_redo = EditorInterface.get_editor_undo_redo()
			undo_redo.create_action("Scale", UndoRedo.MERGE_ALL)
			undo_redo.add_do_property(self, "size", size)
			undo_redo.add_undo_property(self, "size", original_size)
			undo_redo.commit_action()
		
		transform_in_progress = false

## Override this to provide an initial size value if the scene file hasn't specified one.
## Change events won't be emitted, so the scene should be pre-configured to match the returned size value,
## or this function should evaluate the scene to describe its current size instead.
func _get_initial_size() -> Vector3:
	return size_default


## Override this to specify a size to assign when the size property is reset.
## Change events will be emitted as usual.
func _get_default_size() -> Vector3:
	return size_default


## Override this to reconfigure nodes when a new value is assigned to the size property.
func _on_size_changed() -> void:
	pass


## Convert existing scale into size.
## Avoids doing anything if size has already been set to a non-default value.
func migrate_scale_to_size() -> void:
	if scale == Vector3.ONE:
		return  # scale already reset; nothing to do
	if size != size_default:
		return  # size isn't default; assume migration has already happened despite the unexpected scale.
	var scale_original = scale
	scale = Vector3.ONE
	size = scale_original
