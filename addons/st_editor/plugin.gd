@tool
extends EditorPlugin


const DockScript := preload("res://addons/st_editor/st_editor_dock.gd")

var _dock: VBoxContainer = null


func _enter_tree() -> void:
	_dock = DockScript.new()
	add_control_to_dock(DOCK_SLOT_RIGHT_BL, _dock)
	scene_changed.connect(_on_scene_changed)
	_on_scene_changed(EditorInterface.get_edited_scene_root())


func _exit_tree() -> void:
	if scene_changed.is_connected(_on_scene_changed):
		scene_changed.disconnect(_on_scene_changed)
	if _dock != null:
		remove_control_from_docks(_dock)
		_dock.queue_free()
		_dock = null


func _on_scene_changed(scene_root: Node) -> void:
	if _dock != null:
		_dock.call("set_scene_root", scene_root)
