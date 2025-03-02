@tool
extends Node

signal simulation_started
signal simulation_set_paused(paused)
signal simulation_ended
signal use

func _input(event: InputEvent) -> void:
	var editor_settings := EditorInterface.get_editor_settings()
	if editor_settings.is_shortcut("Open Industry Project/Use", event) and event.is_pressed():
		var selection = EditorInterface.get_selection()
		for node in selection.get_selected_nodes():
			if(node.has_method("Use")):
				node.call("Use")

func _enter_tree() -> void:
	var editor_settings := EditorInterface.get_editor_settings()
	
	if not editor_settings.get_shortcut("Open Industry Project/Use"):
		var alert_shortcut := Shortcut.new()
		var key_stroke := InputEventKey.new()
		key_stroke.keycode = KEY_C
		alert_shortcut.events.append(key_stroke)
		editor_settings.add_shortcut("Open Industry Project/Use", alert_shortcut)
		
func _ready() -> void:
	if is_instance_valid(owner):
		await owner.ready
	
		EditorInterface.set_main_screen_editor("3D")
		EditorInterface.open_scene_from_path("res://Main/Main.tscn")
