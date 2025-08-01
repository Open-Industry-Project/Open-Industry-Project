@tool
@abstract
class_name ResizableNode3D
extends Node3D

signal size_changed

@export_custom(PROPERTY_HINT_NONE, "suffix:m") var size: Vector3 = Vector3.ZERO:
	set(value):
		if value == Vector3.ZERO:
			if size == Vector3.ZERO:
				size = size_default
				return
			value = size_default
		var clamped_size: Vector3 = size_min.max(value)
		var constrained_size := _get_constrained_size(clamped_size)
		var has_changed := size != constrained_size
		size = constrained_size
		if has_changed:
			update_gizmos()
			_on_size_changed()
			size_changed.emit()

var size_min: Vector3 = Vector3(0.01, 0.01, 0.01)
var size_default: Vector3 = Vector3.ONE
var original_size: Vector3 = Vector3.ZERO
var transform_in_progress: bool = false
var _scale_notification_cooldown: bool = false

func _init() -> void:
	set_meta("hijack_scale", true)
	set_notify_transform(true)

func _notification(what: int) -> void:
	match what:
		NOTIFICATION_TRANSFORM_CHANGED:
			if not scale.is_equal_approx(Vector3.ONE) and not transform_in_progress:
				scale = Vector3.ONE

				if not _scale_notification_cooldown:
					_scale_notification_cooldown = true
					EditorInterface.get_editor_toaster().push_toast(
						"Please use the 'size' property instead of scale.",
						EditorToaster.SEVERITY_WARNING
					)
					get_tree().create_timer(1.0).timeout.connect(func():
						_scale_notification_cooldown = false
					)

func _enter_tree() -> void:
	if not EditorInterface.transform_requested.is_connected(_transform_requested):
		EditorInterface.transform_requested.connect(_transform_requested)
	if not EditorInterface.transform_commited.is_connected(_transform_commited):
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
		var motion := Vector3(data["motion"][0], data["motion"][1], data["motion"][2])

		if not transform_in_progress:
			original_size = size
			transform_in_progress = true

		var new_size := original_size + motion
		new_size = _get_constrained_size(new_size)
		size = new_size

func _transform_commited() -> void:
	if transform_in_progress:
		if size != original_size:
			var undo_redo := EditorInterface.get_editor_undo_redo()
			undo_redo.create_action("Scale", UndoRedo.MERGE_ALL)
			undo_redo.add_do_property(self, "size", size)
			undo_redo.add_undo_property(self, "size", original_size)
			undo_redo.commit_action()

		transform_in_progress = false

func _on_size_changed() -> void:
	pass

func _get_constrained_size(new_size: Vector3) -> Vector3:
	return new_size

func _on_instantiated() -> void:
	if size == Vector3.ZERO:
		size = Vector3.ZERO
	else:
		_on_size_changed()
		size_changed.emit()
