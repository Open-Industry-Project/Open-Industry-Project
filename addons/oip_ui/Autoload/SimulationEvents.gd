@tool
extends Node

signal simulation_started
signal simulation_set_paused(paused)
signal simulation_ended

var simulation_running: bool = false
var simulation_paused: bool = false
var selected_nodes: Array[Node]


func _enter_tree() -> void:
	if not Engine.is_editor_hint():
		return

	EditorInterface.get_selection().selection_changed.connect(_on_selection_changed)

	var editor_settings := EditorInterface.get_editor_settings()

	var use_shortcut := Shortcut.new()
	var key_stroke := InputEventKey.new()
	key_stroke.keycode = KEY_C
	use_shortcut.events.append(key_stroke)
	editor_settings.add_shortcut("Open Industry Project/Use", use_shortcut)

	var snap_shortcut := Shortcut.new()
	var snap_key_stroke := InputEventKey.new()
	snap_key_stroke.keycode = KEY_C
	snap_key_stroke.ctrl_pressed = true
	snap_key_stroke.shift_pressed = true
	snap_shortcut.events.append(snap_key_stroke)
	editor_settings.add_shortcut("Open Industry Project/Snap Conveyor", snap_shortcut)


func _ready() -> void:
	if is_instance_valid(owner):
		await owner.ready

	EditorInterface.set_main_screen_editor("3D")
	var run_main: String = ProjectSettings.get_setting("application/run/main_scene", "")
	if run_main.begins_with("uid://"):
		run_main = ResourceUID.get_id_path(ResourceUID.text_to_id(run_main))
	if not run_main.is_empty() and ResourceLoader.exists(run_main):
		EditorInterface.open_scene_from_path(run_main)

	get_tree().paused = false


func _process(delta: float) -> void:
	_select_nodes()


func _input(event: InputEvent) -> void:
	if not Engine.is_editor_hint():
		return

	var editor_settings := EditorInterface.get_editor_settings()
	
	# Handle Use shortcut
	if editor_settings.is_shortcut("Open Industry Project/Use", event) and event.is_pressed() and not event.is_echo():
		var selection := EditorInterface.get_selection()
		for node: Node in selection.get_selected_nodes():
			if(node.has_method("use")):
				node.call("use")
	
	# Handle Snap Conveyor shortcut
	if editor_settings.is_shortcut("Open Industry Project/Snap Conveyor", event) and event.is_pressed() and not event.is_echo():
		ConveyorSnapping.snap_selected_conveyors()


func start_simulation() -> void:
	simulation_paused = false
	simulation_set_paused.emit(false)
	simulation_started.emit()
	_play_scene_animation_players()
	if EditorInterface.has_method("set_simulation_started"):
		EditorInterface.call("set_simulation_started", true)


func stop_simulation() -> void:
	simulation_paused = false
	simulation_set_paused.emit(false)
	_reset_scene_animation_players()
	simulation_ended.emit()
	if EditorInterface.has_method("set_simulation_started"):
		EditorInterface.call("set_simulation_started", false)


func toggle_pause_simulation(pressed: bool = !simulation_paused) -> void:
	simulation_paused = pressed
	simulation_set_paused.emit(pressed)
	if simulation_paused:
		get_tree().edited_scene_root.process_mode = Node.PROCESS_MODE_DISABLED
	else:
		get_tree().edited_scene_root.process_mode = Node.PROCESS_MODE_INHERIT


func _on_selection_changed() -> void:
	selected_nodes = EditorInterface.get_selection().get_selected_nodes()
	_select_nodes()


func _select_nodes() -> void:
	if selected_nodes.size() > 0:
		for node: Node in selected_nodes:
			if(!node):
				return

			if node.has_method("selected"):
				node.call("selected")


func _play_scene_animation_players() -> void:
	var root := get_tree().edited_scene_root
	if not root:
		return
	for ap in root.find_children("*", "AnimationPlayer", true):
		var player := ap as AnimationPlayer
		if player.autoplay:
			player.play(player.autoplay)
		else:
			var list := player.get_animation_list()
			if list.size() > 0:
				player.play(list[0])


func _reset_scene_animation_players() -> void:
	var root := get_tree().edited_scene_root
	if not root:
		return
	for ap in root.find_children("*", "AnimationPlayer", true):
		var player := ap as AnimationPlayer
		player.stop()
		player.seek(0.0, true)
