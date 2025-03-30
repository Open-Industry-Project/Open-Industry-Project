@tool
extends EditorPlugin

const DOCK = preload("res://addons/oip_comms/controls/dock.tscn")

var _dock: _OIPCommsDock
var bottom_panel_button: Button

func _enter_tree() -> void:
	_dock = DOCK.instantiate()
	bottom_panel_button = add_control_to_bottom_panel(_dock, "Comms")
	
	_dock.save_changes.connect(save_changes)
	
	scene_saved.connect(_scene_saved)

func _exit_tree() -> void:
	remove_control_from_bottom_panel(_dock)
	
	_dock.free()

func _scene_saved(filepath: String) -> void:
	_dock.save_all()

func save_changes(value: bool) -> void:
	if value:
		bottom_panel_button.text = "Comms(*)"
	else:
		bottom_panel_button.text = "Comms"
