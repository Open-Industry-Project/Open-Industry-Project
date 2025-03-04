@tool
extends Node

signal simulation_started
signal simulation_set_paused(paused)
signal simulation_ended
signal use
var simulation_running = false
var selected_nodes : Array[Node]

func _on_selection_changed() -> void:
	selected_nodes = EditorInterface.get_selection().get_selected_nodes()
	_select_nodes()

func _select_nodes() -> void:
	if selected_nodes.size() > 0:
		for node: Node in selected_nodes:
			if(!node):
				return
				
			if node.has_method("Select"):
				node.call("Select")
			
	
func _process(delta: float) -> void:
	_select_nodes()

func _input(event: InputEvent) -> void:
	var editor_settings := EditorInterface.get_editor_settings()
	if editor_settings.is_shortcut("Open Industry Project/Use", event) and event.is_pressed():
		var selection = EditorInterface.get_selection()
		for node : Node in selection.get_selected_nodes():
			if(node.has_method("Use")):
				node.call("Use")

func _enter_tree() -> void:
	if not Engine.is_editor_hint():
		return
		
	EditorInterface.get_selection().selection_changed.connect(_on_selection_changed)
	
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
